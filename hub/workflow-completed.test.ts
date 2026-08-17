/**
 * Tests for the "your workflow finished" notification: when a workflow's last
 * step lands and the workflow becomes `completed`, the user gets one Slack DM
 * naming the workflow and quoting the result it ended on.
 *
 * What's worth pinning down, and why:
 *
 *  - it obeys the SAME five-case policy as the manual-review notification
 *    (disabled / no username / no Slack MCP / sent / send failed), because both
 *    are configured by the one master switch and the one Slack handle;
 *  - the message stands on its own — the workflow's name AND its result — since
 *    a notification that only says "done" makes you go and look anyway;
 *  - and, the point of the whole exercise: it fires EXACTLY ONCE per
 *    completion. A workflow stays `completed` forever while the UI polls the
 *    hub every ~2s through read paths that run `expireStale` →
 *    `healSettledStatuses` → `reconcileStatus`, so the naive version of this
 *    feature DMs the user every two seconds until they close the tab. Several
 *    tests below hammer those read paths on purpose;
 *  - a run that ends `failed` sends nothing — that was never asked for;
 *  - and a completion that is genuinely NEW (restart, then finish again) does
 *    notify again, so "once" means once per completion, not once ever.
 *
 * Same throwaway-TARGET_HOME + fake-awb-hook convention as manual-review.test.ts,
 * with `CLAUDE_CONFIG_DIR` pointed at the same throwaway dir so the notifier's
 * Slack detection can never see the operator's real credentials. `_impl` is
 * always stubbed, so nothing here touches the network or a real workspace.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-workflow-completed-"));
process.env.TARGET_HOME = tmpHome;
// Isolate awb too (defensive — keep test hooks out of the real broker).
process.env.AWB_HOME = tmpHome;
process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, "claude");

// Never let a developer's real Slack session become a transport in tests: with
// these exported, an unstubbed path would attempt an actual DM.
for (const suffix of ["XOXC", "XOXD"]) {
	for (const prefix of ["TARGET_SLACK_", "SLACK_MCP_", "SLACK_"]) delete process.env[`${prefix}${suffix}_TOKEN`];
}

/**
 * Seeds the DB file with a `workflows` table as it looked at launch — before
 * `conversation_context`, `context_injected`, `status_before_review` and the
 * `completion_notified` marker this feature adds existed. Importing db.ts below
 * therefore runs the real `addWorkflowColumn` upgrade path, and every test in
 * this file runs against that migrated database: the migration isn't a special
 * case here, it's the setup.
 */
const legacyDbFile = path.join(tmpHome, "target.db");
{
	fs.mkdirSync(path.dirname(legacyDbFile), { recursive: true });
	const legacy = new DatabaseSync(legacyDbFile);
	legacy.exec(`
		CREATE TABLE workflows (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			agent_name TEXT NOT NULL UNIQUE,
			hook_url TEXT NOT NULL,
			secret TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'draft',
			last_session_id TEXT,
			md_path TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
	`);
	// A workflow written by that older hub, which has never heard of the marker.
	const now = new Date().toISOString();
	legacy
		.prepare(
			"INSERT INTO workflows (id, name, agent_name, hook_url, secret, status, md_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		)
		.run("legacy-wf", "a workflow from before the notice existed", "legacy-agent", "http://127.0.0.1:1/hook", "s", "completed", path.join(tmpHome, "legacy.md"), now, now);
	legacy.close();
}

const {
	claimWorkflowCompletionNotice,
	completeStep,
	getStep,
	getWorkflow,
	insertStep,
	insertWorkflow,
	markStepRunning,
	saveNotificationSettings,
	setStepSelection,
	setWorkflowStatus,
} = await import("./db.ts");
const { loadConfig } = await import("./config.ts");
const { _impl: notifierImpl, sendWorkflowCompletedNotification, workflowCompletedMessage } = await import(
	"./notifier.ts"
);
const { continueStep, expireStale, onStepResult, restartWorkflow, runStep, startWorkflow } = await import(
	"./workflow.ts"
);

const cfg = loadConfig();
const silent = () => {};
let seq = 0;

const endpoint = { serverName: "plugin:slack:slack", serverUrl: "https://mcp.slack.com/mcp", accessToken: "tok-123" };

/**
 * Lets the fire-and-forget notification on the `reconcileStatus` path settle.
 * That call site is synchronous (it sits on read paths, which must not wait on
 * a Slack round trip), so its promise is only resolved on a later turn — one
 * `setImmediate` is enough, and it costs nothing on the awaited paths.
 */
function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Swaps the notifier's `_impl` seam for the duration of one test and returns
 * the list of messages `send` was handed. Notifications are turned fully on
 * (and back off afterwards) so the default is "a send would be attempted" —
 * every test that expects silence is then proving the silence, not inheriting
 * it from a disabled hub.
 */
function captureSends(
	t: { after: (fn: () => void) => void },
	overrides: { detect?: typeof notifierImpl.detect; send?: typeof notifierImpl.send } = {},
) {
	const originalDetect = notifierImpl.detect;
	const originalSend = notifierImpl.send;
	saveNotificationSettings({ enabled: true, channels: { slack: { username: "@ada" } } });
	t.after(() => {
		notifierImpl.detect = originalDetect;
		notifierImpl.send = originalSend;
		saveNotificationSettings({ enabled: false, channels: { slack: { username: "" } } });
	});
	const sent: { username: string; message: string }[] = [];
	notifierImpl.detect = overrides.detect ?? (() => [endpoint]);
	notifierImpl.send = async (ep, username, message) => {
		sent.push({ username, message });
		if (overrides.send) await overrides.send(ep, username, message);
	};
	return sent;
}

/** A fake awb hook that swallows dispatches (answers ok, never calls back). */
function startFakeHook() {
	const server = http.createServer((req, res) => {
		req.on("data", () => {});
		req.on("end", () => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		});
	});
	return new Promise<{ server: http.Server; url: string }>((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (!addr || typeof addr === "string") throw new Error("fake hook did not bind");
			resolve({ server, url: `http://127.0.0.1:${addr.port}/hook/agent` });
		});
	});
}

/** A running fake hook, closed when the test ends. */
async function hook(t: { after: (fn: () => void) => void }): Promise<string> {
	const { server, url } = await startFakeHook();
	t.after(() => server.close());
	return url;
}

/** A workflow with `count` plain steps. */
function makeWorkflow(hookUrl: string, count: number) {
	const id = `wf-${++seq}`;
	const workflow = insertWorkflow({
		id,
		name: `test ${id}`,
		agentName: `agent-${id}`,
		hookUrl,
		secret: "s3cret",
		mdPath: path.join(tmpHome, `${id}.md`),
		conversationContext: null,
	});
	const steps = Array.from({ length: count }, (_, i) => insertStep(id, `step ${i + 1}`));
	return { workflow, steps };
}

/** One gated step, for the Continue path. */
function makeGatedWorkflow(hookUrl: string, gatedIndexes: number[], count: number) {
	const id = `wf-${++seq}`;
	const workflow = insertWorkflow({
		id,
		name: `test ${id}`,
		agentName: `agent-${id}`,
		hookUrl,
		secret: "s3cret",
		mdPath: path.join(tmpHome, `${id}.md`),
		conversationContext: null,
	});
	const steps = Array.from({ length: count }, (_, i) =>
		insertStep(id, `step ${i + 1}`, { manualReview: gatedIndexes.includes(i) }),
	);
	return { workflow, steps };
}

/**
 * What the UI does every ~2 seconds with a workflow open: the read path runs
 * the stale sweep (which runs the read-path heal, which runs `reconcileStatus`)
 * and then reads the workflow back.
 */
async function poll(workflowId: string, times = 5): Promise<void> {
	for (let i = 0; i < times; i++) {
		expireStale(cfg, silent);
		getWorkflow(workflowId);
		await flush();
	}
}

const notice = {
	workflowName: "release 1.4",
	stepCount: 3,
	lastStepDescription: "cut the release branch",
	result: "tagged v1.4 and pushed the branch",
};

// --- the migration ------------------------------------------------------

test("completion_notified is added to a DB created without it, and old workflows read normally", () => {
	const legacy = getWorkflow("legacy-wf");
	assert.ok(legacy, "the pre-migration workflow is still readable");
	assert.equal(legacy?.status, "completed");
	assert.equal(legacy?.contextInjected, false);
	// The marker defaults to 0, so a workflow that completed before this feature
	// existed is still claimable — it just has nothing to claim it until it is
	// restarted and finishes again.
	assert.equal(claimWorkflowCompletionNotice("legacy-wf"), true);
});

// --- the claim: the once-only primitive ---------------------------------

test("the completion claim is won exactly once, and re-armed by leaving completed", () => {
	const { workflow } = makeWorkflow("http://127.0.0.1:1/hook", 1);

	assert.equal(claimWorkflowCompletionNotice(workflow.id), true);
	// Every subsequent attempt — i.e. every poll — loses.
	assert.equal(claimWorkflowCompletionNotice(workflow.id), false);
	assert.equal(claimWorkflowCompletionNotice(workflow.id), false);

	// Writing `completed` again (a status re-write on an already-finished
	// workflow) must NOT re-arm it, or a heal would hand out a second message.
	setWorkflowStatus(workflow.id, "completed");
	assert.equal(claimWorkflowCompletionNotice(workflow.id), false);

	// Leaving `completed` does re-arm it: whatever finishes next is a new run.
	setWorkflowStatus(workflow.id, "running");
	assert.equal(claimWorkflowCompletionNotice(workflow.id), true);
	assert.equal(claimWorkflowCompletionNotice(workflow.id), false);
});

// --- the five notification cases ----------------------------------------

test("case 1: with notifications disabled nothing is sent and nothing is even looked up", async (t) => {
	const originalDetect = notifierImpl.detect;
	const originalSend = notifierImpl.send;
	t.after(() => {
		notifierImpl.detect = originalDetect;
		notifierImpl.send = originalSend;
	});
	saveNotificationSettings({ enabled: false, channels: { slack: { username: "ada" } } });
	let detects = 0;
	const sent: string[] = [];
	notifierImpl.detect = () => {
		detects++;
		return [endpoint];
	};
	notifierImpl.send = async (_e, _u, message) => {
		sent.push(message);
	};

	const result = await sendWorkflowCompletedNotification(notice);

	assert.deepEqual(result, { sent: false, reason: "notifications-disabled" });
	assert.equal(sent.length, 0);
	// The master switch is decided first: a disabled hub never even asks whether
	// Slack is available.
	assert.equal(detects, 0);
});

test("case 2: enabled with no Slack username sends nothing", async (t) => {
	const sent = captureSends(t);
	saveNotificationSettings({ enabled: true, channels: { slack: { username: "" } } });

	const result = await sendWorkflowCompletedNotification(notice);

	assert.deepEqual(result, { sent: false, reason: "no-slack-username" });
	assert.equal(sent.length, 0);
});

test("case 3: with a username but no way to reach Slack at all, nothing is sent", async (t) => {
	const sent = captureSends(t, { detect: () => [] });

	const result = await sendWorkflowCompletedNotification(notice);

	assert.deepEqual(result, { sent: false, reason: "no-transport" });
	assert.equal(sent.length, 0);
});

test("case 4: fully configured, the message is sent once to the configured user", async (t) => {
	const sent = captureSends(t);

	const result = await sendWorkflowCompletedNotification(notice);

	assert.deepEqual(result, { sent: true });
	assert.equal(sent.length, 1);
	assert.equal(sent[0].username, "@ada");
});

test("case 5: a send that throws is swallowed and reported, never rethrown", async (t) => {
	const sent = captureSends(t, {
		send: async () => {
			throw new Error("slack said no");
		},
	});

	const result = await sendWorkflowCompletedNotification(notice);

	assert.deepEqual(result, { sent: false, reason: "send-failed", detail: "slack said no" });
	assert.equal(sent.length, 1); // it really was attempted
});

test("a detector that throws is treated as a failure, not as an exception", async (t) => {
	captureSends(t, {
		detect: () => {
			throw new Error("unreadable credentials");
		},
	});

	assert.deepEqual(await sendWorkflowCompletedNotification(notice), {
		sent: false,
		reason: "send-failed",
		detail: "unreadable credentials",
	});
});

// --- the message --------------------------------------------------------

test("workflowCompletedMessage names the workflow and carries the result", () => {
	const message = workflowCompletedMessage(notice);
	assert.match(message, /Workflow finished/);
	assert.match(message, /release 1\.4/);
	assert.match(message, /all 3 done/);
	assert.match(message, /cut the release branch/);
	// The whole reason the message exists: you should not have to open the UI.
	assert.match(message, /tagged v1\.4 and pushed the branch/);
});

test("workflowCompletedMessage says so rather than showing a blank when there is no result", () => {
	const message = workflowCompletedMessage({ ...notice, result: "" });
	assert.match(message, /the last step reported no result/);
});

test("workflowCompletedMessage omits the last-step line for a workflow that had no steps", () => {
	const message = workflowCompletedMessage({ workflowName: "empty", stepCount: 0, lastStepDescription: "", result: "" });
	assert.match(message, /\*empty\* is completed/);
	assert.doesNotMatch(message, /Last step/);
});

// --- the engine: firing exactly once ------------------------------------

test("finishing the last step sends one notification naming the workflow and its result", async (t) => {
	const url = await hook(t);
	const sent = captureSends(t);
	const { workflow, steps } = makeWorkflow(url, 2);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id, steps[1].id]);
	await onStepResult(steps[0].id, { ok: true, result: "the first bit" }, cfg, silent);
	assert.equal(sent.length, 0, "a mid-run step is not a finished workflow");

	await onStepResult(steps[1].id, { ok: true, result: "shipped the thing" }, cfg, silent);
	await flush();

	assert.equal(getWorkflow(workflow.id)?.status, "completed");
	assert.equal(sent.length, 1);
	assert.match(sent[0].message, new RegExp(workflow.name));
	assert.match(sent[0].message, /shipped the thing/); // the LAST step's result
	assert.match(sent[0].message, /all 2 done/);
});

test("the notification is NOT repeated by the UI's polling — the hazard this feature had to avoid", async (t) => {
	const url = await hook(t);
	const sent = captureSends(t);
	const { workflow, steps } = makeWorkflow(url, 1);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id]);
	await onStepResult(steps[0].id, { ok: true, result: "done and dusted" }, cfg, silent);
	await flush();
	assert.equal(sent.length, 1);

	// Twenty polls ≈ 40 seconds of an open UI tab. Each one runs `expireStale` →
	// `healSettledStatuses` → `reconcileStatus` over a workflow that is, and
	// stays, `completed`.
	await poll(workflow.id, 20);

	assert.equal(sent.length, 1, "a completed workflow announces itself once, not once per poll");
	assert.equal(getWorkflow(workflow.id)?.status, "completed");
});

test("a run that ends failed sends nothing, however often it is polled", async (t) => {
	const url = await hook(t);
	const sent = captureSends(t);
	const { workflow, steps } = makeWorkflow(url, 2);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id, steps[1].id]);
	await onStepResult(steps[0].id, { ok: false, error: "boom" }, cfg, silent);
	await flush();

	assert.equal(getWorkflow(workflow.id)?.status, "failed");
	await poll(workflow.id, 5);

	assert.equal(sent.length, 0, "'finished' was asked for; 'failed' was not");
});

test("a workflow that completes with an old failed step left over is failed, and silent", async (t) => {
	const url = await hook(t);
	const sent = captureSends(t);
	const { workflow, steps } = makeWorkflow(url, 2);

	// Step 1 failed on an earlier attempt and was left outside the re-run
	// selection; step 2 is the one the engine is now finishing. `advance()`
	// therefore reaches the end of the run and settles `failed`, not `completed`
	// — the branch right next to the one that notifies.
	completeStep(steps[0].id, { ok: false, error: "boom" });
	setStepSelection(workflow.id, [steps[1].id]);
	setWorkflowStatus(workflow.id, "running");
	markStepRunning(steps[1].id);
	await onStepResult(steps[1].id, { ok: true, result: "the second bit" }, cfg, silent);
	await flush();

	assert.equal(getWorkflow(workflow.id)?.status, "failed");
	assert.equal(sent.length, 0);
});

test("completing via continueStep releasing the last gated step notifies exactly once", async (t) => {
	const url = await hook(t);
	const sent = captureSends(t);
	const { workflow, steps } = makeGatedWorkflow(url, [1], 2);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id, steps[1].id]);
	await onStepResult(steps[0].id, { ok: true, result: "one" }, cfg, silent);
	await onStepResult(steps[1].id, { ok: true, result: "the reviewed work" }, cfg, silent);
	await flush();
	// It's held at its gate: the manual-review notification went out, and the
	// workflow has emphatically NOT finished.
	assert.equal(getWorkflow(workflow.id)?.status, "waiting");
	assert.equal(sent.length, 1);
	assert.match(sent[0].message, /Manual review needed/);

	await continueStep(workflow.id, steps[1].id, cfg, silent);
	await flush();

	assert.equal(getWorkflow(workflow.id)?.status, "completed");
	assert.equal(sent.length, 2);
	assert.match(sent[1].message, /Workflow finished/);
	assert.match(sent[1].message, /the reviewed work/); // the result survived the hold

	await poll(workflow.id, 5);
	assert.equal(sent.length, 2);
});

test("a ▶ run that settles the last outstanding step notifies once, and only once", async (t) => {
	const url = await hook(t);
	const sent = captureSends(t);
	const { workflow, steps } = makeWorkflow(url, 1);

	// An on-demand run stays outside the sequential engine, so it completes the
	// workflow through `settleManual` → `reconcileStatus` — the OTHER path to
	// `completed`, and the one that sits on read paths.
	await runStep(workflow.id, steps[0].id, cfg, silent);
	await onStepResult(steps[0].id, { ok: true, result: "ran it by hand" }, cfg, silent);
	await flush();

	assert.equal(getWorkflow(workflow.id)?.status, "completed");
	assert.equal(sent.length, 1);
	assert.match(sent[0].message, /Workflow finished/);
	assert.match(sent[0].message, /ran it by hand/);

	await poll(workflow.id, 10);
	assert.equal(sent.length, 1);
});

test("the read-path heal completing a stale `running` workflow notifies once, not once per poll", async (t) => {
	const url = await hook(t);
	const sent = captureSends(t);
	const { workflow, steps } = makeWorkflow(url, 1);

	// A stale row of exactly the kind `healSettledStatuses` exists to fix: the
	// badge says `running` (a hub killed mid-run, or a status written out of
	// band) while every step is actually done. `reconcileStatus` settles it to
	// `completed` on the next read — a genuine completion transition, so it is
	// announced, once.
	completeStep(steps[0].id, { ok: true, result: "the work" });
	setWorkflowStatus(workflow.id, "running");

	await poll(workflow.id, 20);

	assert.equal(getWorkflow(workflow.id)?.status, "completed");
	assert.equal(sent.length, 1, "the heal is a read path — it must not DM on every poll");
	assert.match(sent[0].message, /Workflow finished/);
	assert.match(sent[0].message, /the work/);
});

test("restarting a completed workflow and completing it again notifies again", async (t) => {
	const url = await hook(t);
	const sent = captureSends(t);
	const { workflow, steps } = makeWorkflow(url, 1);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id]);
	await onStepResult(steps[0].id, { ok: true, result: "first time round" }, cfg, silent);
	await flush();
	assert.equal(sent.length, 1);
	await poll(workflow.id, 3);
	assert.equal(sent.length, 1);

	// A restart is a new run, so its completion is a new event.
	await restartWorkflow(workflow.id, cfg, silent, [steps[0].id]);
	await flush();
	assert.equal(sent.length, 1, "restarting is not finishing");

	await onStepResult(steps[0].id, { ok: true, result: "second time round" }, cfg, silent);
	await flush();

	assert.equal(getWorkflow(workflow.id)?.status, "completed");
	assert.equal(sent.length, 2);
	assert.match(sent[1].message, /second time round/);

	await poll(workflow.id, 5);
	assert.equal(sent.length, 2);
});

test("adding a step to a completed workflow re-arms it: finishing again notifies again", async (t) => {
	const url = await hook(t);
	const sent = captureSends(t);
	const { workflow, steps } = makeWorkflow(url, 1);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id]);
	await onStepResult(steps[0].id, { ok: true, result: "one" }, cfg, silent);
	await flush();
	assert.equal(sent.length, 1);

	// "+ step" on a terminal workflow pushes it back to `draft` (see addStep),
	// which is exactly the "left `completed`" transition that re-arms the notice.
	const extra = insertStep(workflow.id, "step 2");
	setWorkflowStatus(workflow.id, "draft");
	await startWorkflow(workflow.id, cfg, silent, [extra.id]);
	await onStepResult(extra.id, { ok: true, result: "two" }, cfg, silent);
	await flush();

	assert.equal(getWorkflow(workflow.id)?.status, "completed");
	assert.equal(sent.length, 2);
	assert.match(sent[1].message, /two/);
});

// --- the notification is advisory ---------------------------------------

test("a send that fails leaves the workflow completed regardless", async (t) => {
	const url = await hook(t);
	const sent = captureSends(t, {
		send: async () => {
			throw new Error("slack is down");
		},
	});
	const { workflow, steps } = makeWorkflow(url, 1);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id]);
	// The failed send must not escape into the callback path.
	await onStepResult(steps[0].id, { ok: true, result: "the work" }, cfg, silent);
	await flush();

	assert.equal(getWorkflow(workflow.id)?.status, "completed");
	assert.equal(getStep(steps[0].id)?.status, "done");
	assert.equal(sent.length, 1, "it really was attempted");

	// And it is NOT retried on the next poll: a lost message costs the message,
	// not a DM every two seconds once Slack comes back.
	await poll(workflow.id, 5);
	assert.equal(sent.length, 1);
});

test("a completion with notifications switched off still completes, silently", async (t) => {
	const url = await hook(t);
	const sent = captureSends(t);
	saveNotificationSettings({ enabled: false, channels: { slack: { username: "@ada" } } });
	const { workflow, steps } = makeWorkflow(url, 1);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id]);
	await onStepResult(steps[0].id, { ok: true, result: "the work" }, cfg, silent);
	await flush();

	assert.equal(getWorkflow(workflow.id)?.status, "completed");
	assert.equal(sent.length, 0);
});

// --- the result is trimmed for a chat window ----------------------------

test("a huge result is truncated in the message instead of pasting an essay into Slack", async (t) => {
	const url = await hook(t);
	const sent = captureSends(t);
	const { workflow, steps } = makeWorkflow(url, 1);
	const essay = "x".repeat(5_000);

	await startWorkflow(workflow.id, cfg, silent, [steps[0].id]);
	await onStepResult(steps[0].id, { ok: true, result: essay }, cfg, silent);
	await flush();

	assert.equal(sent.length, 1);
	assert.ok(sent[0].message.length < 1_000, `message was ${sent[0].message.length} chars`);
	assert.match(sent[0].message, /…/); // and it says it was cut, rather than pretending
	// The step's own record keeps the whole thing — only the DM is abridged.
	assert.equal(getStep(steps[0].id)?.result, essay);
});
