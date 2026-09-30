/**
 * The scheduler: fires each schedule series' armed instance when its
 * `next_run_at` comes due (D1–D12). One tick every 30s plus one at boot — the
 * same function both times, because a laptop that was suspended never restarts
 * the hub: the first tick after it wakes is just a tick with a large gap, and
 * has to reach the same conclusions a fresh boot would.
 *
 * Per due armed instance, in order:
 *
 *  1. CLAIM it atomically (`claimScheduledFire`): armed → fired in one
 *     conditional UPDATE, so two processes on one DB — or two overlapping
 *     ticks — never fire the same run twice.
 *  2. MISSED (D8): a run later than the 10-minute grace window does not run
 *     late. A recurring series moves to its next future occurrence (creating
 *     no workflows) and records a notice listing what was missed; a `once`
 *     becomes `missed` and waits for the operator (Run now / Reschedule /
 *     Dismiss). When the hub comes back within the grace window of the LATEST
 *     occurrence, that one still runs and only the earlier ones are missed.
 *  3. OVERLAP (D9): while another instance of the series is still running,
 *     waiting or paused, the due run is skipped and the series re-armed.
 *  4. PERMISSIONS (D10): on a linked hub the owner must hold
 *     `client.workflows.execute`; see `decideFireGate`.
 *  5. FIRE: for a recurring series, the next instance is cloned FIRST (D3) —
 *     so a run that fails or hangs can never end the series — then the
 *     previous-run block is attached and the run started with every task step
 *     named explicitly (an empty selection runs nothing). A clone failure
 *     marks the series `broken` with a critical notice, but the current run
 *     still starts (D12).
 */
import type { HubConfig } from "./config.ts";
import {
	claimMissedRun,
	claimScheduledFire,
	getWorkflow,
	listArmedInstances,
	listSeriesInstances,
	listSteps,
	recordNotice,
	setWorkflowName,
	updateWorkflowSchedule,
	type Workflow,
	type WorkflowStatus,
} from "./db.ts";
import { ownerSnapshotState, resolvePermissionMode } from "./owner-permissions.ts";
import type { Logger } from "./runner.ts";
import { formatInZone, nextOccurrence, occurrencesBetween } from "./schedule.ts";
import {
	attachPreviousRun,
	cancelSchedule,
	cloneScheduledInstance,
	restartWorkflow,
	ScheduleServerManagedError,
	setSchedule,
	startWorkflow,
	WorkflowError,
	type ScheduleActor,
	type SetScheduleInput,
} from "./workflow.ts";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** How often the daemon ticks (D7). */
export const SCHEDULER_TICK_MS = 30_000;
/** How late a run may still fire (D8). */
export const MISSED_GRACE_MS = 10 * MINUTE_MS;
/** How long after boot a linked hub waits for its first live heartbeat (D10). */
export const PERMISSION_BOOT_WAIT_MS = 5 * MINUTE_MS;
/** How old a cached owner snapshot may be and still authorise a run (D10). */
export const OWNER_SNAPSHOT_MAX_AGE_MS = 7 * DAY_MS;
/** What the owner must hold for a scheduled run to fire (D10). */
export const FIRE_PERMISSION = "client.workflows.execute";

/** Instances in these statuses are "the previous run is still going" (D9). */
const BUSY_STATUSES: readonly WorkflowStatus[] = ["running", "waiting", "paused"];

// --- permission gate (D10) -------------------------------------------------

/**
 * What the scheduler knows about the owner's permissions at fire time.
 * `unavailable` covers every "no fresh snapshot right now" case: not heard
 * from the server yet since boot (`liveSinceBoot` false), or heard but the
 * heartbeats have lapsed.
 */
export type FirePermissionState =
	| { kind: "unrestricted" }
	| { kind: "enforced"; permissions: readonly string[] }
	| {
			kind: "unavailable";
			liveSinceBoot: boolean;
			lastSnapshot: { permissions: readonly string[]; receivedAt: string } | null;
	  };

export type FireGate = { decision: "allow" } | { decision: "wait" } | { decision: "skip"; reason: "forbidden" | "stale" };

/**
 * The fire-time permission rule (D10). Unlinked hubs always fire. A live
 * snapshot decides on its own. Without one, a hub that booted less than five
 * minutes ago and hasn't heard from the server yet WAITS (the run stays armed
 * and is retried next tick) — right after boot every linked hub reads as
 * read-only until its first heartbeat, and skipping then would drop every run
 * due around a restart. After that, the last known snapshot is trusted only if
 * it is under seven days old: a hub that has been cut off from its server for
 * longer must not keep acting on a role that may have been revoked since.
 */
export function decideFireGate(state: FirePermissionState, nowMs: number, bootAtMs: number): FireGate {
	if (state.kind === "unrestricted") return { decision: "allow" };
	if (state.kind === "enforced") {
		return state.permissions.includes(FIRE_PERMISSION) ? { decision: "allow" } : { decision: "skip", reason: "forbidden" };
	}
	if (!state.liveSinceBoot && nowMs - bootAtMs < PERMISSION_BOOT_WAIT_MS) return { decision: "wait" };
	const snapshot = state.lastSnapshot;
	const receivedMs = snapshot ? Date.parse(snapshot.receivedAt) : Number.NaN;
	if (!snapshot || !Number.isFinite(receivedMs) || nowMs - receivedMs >= OWNER_SNAPSHOT_MAX_AGE_MS) {
		return { decision: "skip", reason: "stale" };
	}
	return snapshot.permissions.includes(FIRE_PERMISSION) ? { decision: "allow" } : { decision: "skip", reason: "forbidden" };
}

/** The live answer, from owner-permissions.ts. */
export function currentFirePermissionState(): FirePermissionState {
	const mode = resolvePermissionMode();
	if (mode.mode === "unrestricted") return { kind: "unrestricted" };
	if (mode.mode === "enforced") return { kind: "enforced", permissions: [...mode.permissions] };
	const { live, snapshot } = ownerSnapshotState();
	return {
		kind: "unavailable",
		liveSinceBoot: live,
		lastSnapshot: snapshot ? { permissions: snapshot.permissions, receivedAt: snapshot.receivedAt } : null,
	};
}

// --- the tick ----------------------------------------------------------------

/** When this process started; the D10 boot wait counts from here. */
let processBootAt = Date.now();

/**
 * Due runs held back by the D10 boot wait, keyed by `<id>@<next_run_at>`, with
 * when they were first held. Lateness is measured from that moment, so waiting
 * for the first heartbeat can never be what pushes a run past the grace
 * window. In memory on purpose: the wait itself only exists within one process.
 */
const deferredSince = new Map<string, number>();

export interface SchedulerTickOptions {
	cfg: HubConfig;
	log: Logger;
	now?: Date;
	/** Overrides the process boot time (tests). */
	bootAt?: number;
	/** Overrides the owner-permission source (tests). */
	permissionState?: () => FirePermissionState;
	/** Overrides how the next instance is created (tests inject a failure). */
	clone?: (armedId: string, nextRunAt: Date) => Workflow;
}

export interface SchedulerTickResult {
	/** Instances whose run was started (or attempted) this tick. */
	fired: string[];
	/** Next instances created by those fires — never more than one per fire. */
	created: string[];
	/** Instances whose due run(s) were missed. */
	missed: string[];
	/** Instances whose due run was skipped (busy/forbidden/stale). */
	skipped: string[];
	/** Instances held back by the D10 boot wait. */
	deferred: string[];
}

export async function runSchedulerTick(options: SchedulerTickOptions): Promise<SchedulerTickResult> {
	const now = options.now ?? new Date();
	const nowMs = now.getTime();
	const result: SchedulerTickResult = { fired: [], created: [], missed: [], skipped: [], deferred: [] };
	// Decided lazily, once per tick: most ticks have nothing due, and resolving
	// permissions reads the device link from disk.
	let gate: FireGate | null = null;
	const fireGate = (): FireGate =>
		(gate ??= decideFireGate(
			(options.permissionState ?? currentFirePermissionState)(),
			nowMs,
			options.bootAt ?? processBootAt,
		));
	for (const armed of listArmedInstances()) {
		const dueMs = armed.nextRunAt ? Date.parse(armed.nextRunAt) : Number.NaN;
		if (!Number.isFinite(dueMs) || dueMs > nowMs) continue;
		try {
			await processDue(armed, dueMs, now, fireGate, options, result);
		} catch (err) {
			// One broken series must not stop the others from firing.
			options.log(`scheduler: ${armed.id} (${armed.name}) failed: ${String(err)}`, "warning");
		}
	}
	return result;
}

async function processDue(
	armed: Workflow,
	dueMs: number,
	now: Date,
	fireGate: () => FireGate,
	options: SchedulerTickOptions,
	result: SchedulerTickResult,
): Promise<void> {
	const { log } = options;
	const spec = armed.schedule;
	const tz = armed.scheduleTimezone;
	const nextRunAt = armed.nextRunAt;
	if (!spec || !tz || !nextRunAt) return;
	const nowMs = now.getTime();
	const recurring = spec.kind !== "once";
	const key = `${armed.id}@${nextRunAt}`;
	const seenMs = Math.min(nowMs, deferredSince.get(key) ?? nowMs);

	// Every occurrence from the stored one up to now. The latest is the only
	// candidate to run: anything before it is missed however the rest goes.
	const due = recurring
		? occurrencesBetween(spec, tz, new Date(dueMs), new Date(nowMs + 1))
		: [new Date(dueMs)];
	if (due.length === 0) due.push(new Date(dueMs));
	const latest = due[due.length - 1];
	const runOccurrence = seenMs - latest.getTime() <= MISSED_GRACE_MS ? latest : null;
	const missed = runOccurrence ? due.slice(0, -1) : due;

	if (runOccurrence && fireGate().decision === "wait") {
		if (!deferredSince.has(key)) deferredSince.set(key, nowMs);
		result.deferred.push(armed.id);
		return;
	}
	if (!claimScheduledFire(armed.id, nextRunAt)) return;
	deferredSince.delete(key);

	if (missed.length > 0) {
		const next = recurring ? nextOccurrence(spec, tz, now) : null;
		recordNotice({
			workflowId: armed.id,
			seriesId: armed.seriesId,
			kind: "missed",
			reason: "offline",
			detail: {
				occurrences: missed.map((d) => d.toISOString()),
				count: missed.length,
				nextRunAt: runOccurrence ? runOccurrence.toISOString() : (next?.toISOString() ?? null),
				message: missedMessage(missed, runOccurrence ?? next, tz, recurring),
			},
			now,
		});
		result.missed.push(armed.id);
		log(`scheduler: ${armed.name}: ${missed.length} run(s) missed`, "warning");
		if (!runOccurrence) {
			if (recurring && next) rearm(armed, next);
			else updateWorkflowSchedule(armed.id, { scheduleState: "missed", nextRunAt: null });
			return;
		}
	}
	if (!runOccurrence) return; // unreachable: nothing missed means the latest is in grace

	const busy = listSeriesInstances(armed.seriesId ?? "").find(
		(w) => w.id !== armed.id && BUSY_STATUSES.includes(w.status),
	);
	if (busy) {
		skip(armed, runOccurrence, now, "busy", { busyInstanceId: busy.id }, result, log);
		return;
	}
	const decision = fireGate();
	if (decision.decision === "skip") {
		skip(armed, runOccurrence, now, decision.reason, {}, result, log);
		return;
	}

	// FIRE. The instance now records the occurrence it runs for.
	updateWorkflowSchedule(armed.id, { scheduledFor: runOccurrence.toISOString(), nextRunAt: null });
	renameForOccurrence(armed, runOccurrence);
	if (recurring) {
		const next = nextOccurrence(spec, tz, now);
		if (next) {
			try {
				const created = (options.clone ?? cloneScheduledInstance)(armed.id, next);
				result.created.push(created.id);
			} catch (err) {
				updateWorkflowSchedule(armed.id, { scheduleState: "broken" });
				recordNotice({
					workflowId: armed.id,
					seriesId: armed.seriesId,
					kind: "broken",
					reason: "clone_failed",
					detail: {
						critical: true,
						error: String(err),
						message: `The schedule "${armed.seriesName ?? armed.name}" is broken: its next run could not be created (${String(err)}). This run still started; reschedule it once the cause is fixed.`,
					},
					now,
				});
				log(`scheduler: ${armed.name}: next instance could not be created — series broken: ${String(err)}`, "error");
			}
		}
	}
	result.fired.push(armed.id);
	await launchInstance(armed.id, options.cfg, log, now);
}

/** Re-arms an instance at a later occurrence, renaming it to match. */
function rearm(armed: Workflow, next: Date): void {
	updateWorkflowSchedule(armed.id, {
		scheduleState: "armed",
		nextRunAt: next.toISOString(),
		scheduledFor: next.toISOString(),
	});
	renameForOccurrence(armed, next);
}

/**
 * Skips a due run (D9/D10) with a notice. A recurring series re-arms at its
 * next occurrence; a `once` has no next occurrence, so it becomes `missed` —
 * which is exactly the state that offers Run now / Reschedule / Dismiss.
 */
function skip(
	armed: Workflow,
	occurrence: Date,
	now: Date,
	reason: "busy" | "forbidden" | "stale",
	extra: Record<string, unknown>,
	result: SchedulerTickResult,
	log: Logger,
): void {
	const tz = armed.scheduleTimezone ?? "UTC";
	const next = armed.schedule && armed.schedule.kind !== "once" ? nextOccurrence(armed.schedule, tz, now) : null;
	if (next) rearm(armed, next);
	else updateWorkflowSchedule(armed.id, { scheduleState: "missed", nextRunAt: null });
	const why =
		reason === "busy"
			? "the previous run was still in progress"
			: reason === "forbidden"
				? `the device owner lacks ${FIRE_PERMISSION}`
				: "the hub could not confirm the owner's permissions (no recent contact with the server)";
	recordNotice({
		workflowId: armed.id,
		seriesId: armed.seriesId,
		kind: "skipped",
		reason,
		detail: {
			...extra,
			occurrence: occurrence.toISOString(),
			nextRunAt: next?.toISOString() ?? null,
			message: `The run scheduled for ${formatInZone(occurrence, tz)} was skipped because ${why}${
				next ? `; next: ${formatInZone(next, tz)}` : ""
			}.`,
		},
		now,
	});
	result.skipped.push(armed.id);
	log(`scheduler: ${armed.name}: run skipped (${reason})`, "warning");
}

/**
 * Instances cloned by the scheduler are named "<series> · <occurrence>", so
 * when one moves to another occurrence its name moves with it. The series'
 * FIRST instance keeps the name the operator gave it.
 */
function renameForOccurrence(instance: Workflow, occurrence: Date): void {
	if (!instance.previousInstanceId || !instance.seriesName || !instance.scheduleTimezone) return;
	const name = `${instance.seriesName} · ${formatInZone(occurrence, instance.scheduleTimezone)}`;
	if (name !== instance.name) setWorkflowName(instance.id, name);
}

function missedMessage(missed: Date[], next: Date | null, tz: string, recurring: boolean): string {
	const shown = missed.slice(0, 5).map((d) => formatInZone(d, tz));
	const list = missed.length > shown.length ? `${shown.join(", ")}, …` : shown.join(", ");
	if (!recurring) return `The run scheduled for ${list} was missed because the hub was offline.`;
	const count = missed.length === 1 ? "1 run" : `${missed.length} runs`;
	return `${count} missed (${list}) because the hub was offline${next ? `; next: ${formatInZone(next, tz)}` : ""}.`;
}

/**
 * Starts a claimed instance: attaches the previous-run block (from the series'
 * most recent fired instance), then starts every task step BY ID. Restart
 * semantics when any step has already run (an existing completed workflow
 * turned into a series, D3) — `startWorkflow` refuses those. An instance with
 * no task steps is never started with an empty selection (which would run
 * nothing and read as a run): it gets a `failed` notice instead.
 */
async function launchInstance(instanceId: string, cfg: HubConfig, log: Logger, now: Date): Promise<void> {
	const instance = getWorkflow(instanceId);
	if (!instance) return;
	if (instance.seriesId) {
		const instances = listSeriesInstances(instance.seriesId);
		const index = instances.findIndex((w) => w.id === instanceId);
		const previous = instances
			.slice(0, Math.max(index, 0))
			.reverse()
			.find((w) => w.scheduleState === "fired" || w.scheduleState === "broken");
		if (previous && previous.id !== instance.previousInstanceId) {
			updateWorkflowSchedule(instanceId, { previousInstanceId: previous.id }, { touch: false });
		}
	}
	attachPreviousRun(instanceId);
	const steps = listSteps(instanceId);
	const taskIds = steps.filter((s) => s.kind === "task").map((s) => s.id);
	if (taskIds.length === 0) {
		recordNotice({
			workflowId: instanceId,
			seriesId: instance.seriesId,
			kind: "failed",
			reason: "no_steps",
			detail: { message: `The scheduled run "${instance.name}" has no steps to run.` },
			now,
		});
		log(`scheduler: ${instance.name}: no task steps — nothing started`, "warning");
		return;
	}
	const needsRestart =
		instance.status === "completed" || instance.status === "failed" || steps.some((s) => s.status !== "pending");
	try {
		if (needsRestart) await restartWorkflow(instanceId, cfg, log, taskIds);
		else await startWorkflow(instanceId, cfg, log, taskIds);
		log(`scheduler: started ${instance.name}`);
	} catch (err) {
		recordNotice({
			workflowId: instanceId,
			seriesId: instance.seriesId,
			kind: "failed",
			reason: "start_failed",
			detail: { error: String(err), message: `The scheduled run "${instance.name}" could not start: ${String(err)}` },
			now,
		});
		log(`scheduler: ${instance.name} could not start: ${String(err)}`, "error");
	}
}

// --- a missed `once`: the operator's three choices (D8) ----------------------

/**
 * Thrown by Run now / Reschedule / Dismiss on anything but a missed `once` —
 * and by a second Run now that lost the claim. A `WorkflowError` subclass so
 * the HTTP layer can map it to 409 `not_missed` by type.
 */
export class ScheduleNotMissedError extends WorkflowError {
	constructor(message = "this scheduled run was not missed") {
		super(message);
		this.name = "ScheduleNotMissedError";
	}
}

function requireMissed(workflowId: string): Workflow {
	const workflow = getWorkflow(workflowId);
	if (!workflow) throw new WorkflowError("unknown workflow");
	if (workflow.scheduleState !== "missed") throw new ScheduleNotMissedError();
	return workflow;
}

/**
 * "Run now" — the ONLY manual run of a scheduled instance (D2/D8). Claimed like
 * a scheduler fire, so a double click can't start it twice. Server-managed
 * series refuse it unless the server asks.
 */
export async function runMissedNow(
	workflowId: string,
	cfg: HubConfig,
	log: Logger,
	options: ScheduleActor & { now?: Date } = {},
): Promise<Workflow> {
	const workflow = requireMissed(workflowId);
	// Same refusal as every other local edit of a server-managed series (D15).
	if (workflow.managedBy === "server" && options.actor !== "server") throw new ScheduleServerManagedError();
	if (!claimMissedRun(workflowId)) throw new ScheduleNotMissedError("this scheduled run was already started");
	await launchInstance(workflowId, cfg, log, options.now ?? new Date());
	const updated = getWorkflow(workflowId);
	if (!updated) throw new WorkflowError("workflow disappeared");
	return updated;
}

/** "Reschedule" — re-arms the missed instance within its series. */
export function rescheduleMissed(
	workflowId: string,
	input: SetScheduleInput,
	options: ScheduleActor & { now?: Date } = {},
): Workflow {
	requireMissed(workflowId);
	return setSchedule(workflowId, input, options);
}

/** "Dismiss" — the missed instance goes back to being a normal workflow. */
export function dismissMissed(workflowId: string, options: ScheduleActor = {}): Workflow {
	requireMissed(workflowId);
	return cancelSchedule(workflowId, options);
}

// --- daemon wiring -----------------------------------------------------------

/**
 * Starts the scheduler: one tick right away (boot) and one every 30s. The
 * timer is `unref`'d so it never keeps the process alive, a tick that throws
 * is logged and never takes the daemon down, and a tick still running when the
 * next is due is not overlapped (the claim would make that safe anyway; this
 * just avoids the wasted work).
 */
export function startScheduler(
	cfg: HubConfig,
	log: Logger,
	deps: {
		tick?: (options: SchedulerTickOptions) => Promise<unknown>;
		setIntervalFn?: (fn: () => void, ms: number) => { unref(): unknown };
	} = {},
): { unref(): unknown } {
	processBootAt = Date.now();
	const tick = deps.tick ?? runSchedulerTick;
	let running = false;
	const run = (): void => {
		if (running) return;
		running = true;
		let pending: Promise<unknown>;
		try {
			pending = tick({ cfg, log });
		} catch (err) {
			pending = Promise.reject(err);
		}
		void pending
			.catch((err) => log(`scheduler tick failed: ${String(err)}`, "warning"))
			.finally(() => {
				running = false;
			});
	};
	run();
	const schedule = deps.setIntervalFn ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
	const timer = schedule(run, SCHEDULER_TICK_MS);
	timer.unref();
	return timer;
}
