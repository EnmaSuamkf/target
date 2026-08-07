/**
 * The geometry behind the workflow canvas — where every card, judge circle and
 * arrow goes, and what state each of them is in.
 *
 * The step list answers "what is in this workflow" one row at a time; it does
 * not answer "what runs after what, and what has to pass before it does". A
 * workflow IS a graph — steps in sequence, a judge hanging off the ones with
 * acceptance criteria, a retry loop back into the step the judge rejected — and
 * a stack of cards can only imply that with its ordering. The canvas draws it.
 *
 * The canvas is a READ of the workflow, never an edit of it: nothing here
 * produces a mutation, and every node carries the id of the step it stands for
 * so a click can send the operator to that step's row, which is where editing
 * lives. That split is deliberate — one place to change a workflow, one place
 * to see its shape.
 *
 * Layout is a vertical spine with side branches:
 *
 *     ┌──────────────┐
 *     │  ctx         │        the conversation context, when there is one
 *     └──────┬───────┘
 *     ┌──────▼───────┐        ╭───────╮
 *     │  1  step     │───────▶│ judge │   ─┐  a step with acceptance criteria
 *     └──────┬───────┘        ╰───────╯    │  is judged before the run moves on
 *            │  ◀─────────────────────────┘   (dashed = the retry it can force)
 *     ┌──────▼───────┐
 *     │  2  step     │
 *     └──────────────┘
 *
 * Vertical, not horizontal, for two reasons: it is the order the steps already
 * read in, and it is the axis a phone has room on — a horizontal chain of six
 * cards is a scroll bar, a vertical one is a page.
 *
 * Edges are routed here rather than in the component so the whole picture is one
 * pure function over plain data: the SVG only has to draw the points it is
 * handed, and the hub's node:test suite can assert the shape without a DOM (see
 * hub/canvas-view.test.ts).
 */

/** All the canvas needs of a step. Structurally satisfied by `Step` from api/types.ts. */
export interface CanvasStep {
	id: string;
	/** "context" for the hub-owned context step, "task" for everything else. */
	kind?: string;
	orderIndex: number;
	description: string;
	status: string;
	/** Which job a `running` step is on — "judge" is what turns the circle on. */
	phase?: string;
	acceptanceCriteria?: string | null;
	manualReview?: boolean;
	useSubagent?: boolean;
	maxRetries?: number;
	retryCount?: number;
	selected?: boolean;
}

export type CanvasNodeKind = "context" | "step" | "judge";

/**
 * What a node is doing, in one vocabulary shared by cards and circles so the
 * stylesheet has a single set of state classes.
 *
 * `judging` is the distinction the step list already makes in words ("judging"
 * instead of "running") and the canvas makes in shape: the work is done and the
 * circle is deciding whether it counts.
 */
export type CanvasNodeState = "pending" | "queued" | "running" | "judging" | "waiting" | "done" | "failed";

/** How far along the flow an arrow is: already travelled, being travelled, or not yet. */
export type CanvasEdgeState = "done" | "active" | "pending";

/**
 * What an arrow MEANS, which is also how it's drawn:
 * - `flow` — the spine: this step runs after that one (solid).
 * - `judge` — into the circle: this step's result is checked (solid, short).
 * - `retry` — out of the circle and back into the step (dashed): a reject
 *   re-runs it, and it only exists when the step has a retry budget to spend.
 */
export type CanvasEdgeKind = "flow" | "judge" | "retry";

export interface CanvasPoint {
	x: number;
	y: number;
}

export interface CanvasNode {
	/** Unique within the graph: the step id for a card, `<stepId>:judge` for a circle. */
	id: string;
	/** The step this node stands for — what a click on it navigates to. */
	stepId: string;
	kind: CanvasNodeKind;
	state: CanvasNodeState;
	/** The number on the card ("1", "2", …) or "ctx". Empty for a judge circle. */
	label: string;
	/** The step's description, shown in the card and as the circle's tooltip. */
	description: string;
	x: number;
	y: number;
	width: number;
	height: number;
	/** Ticked for the next run. Always false for the context step and judge circles. */
	selected: boolean;
	/** The step stops here for a human sign-off. */
	manualReview: boolean;
	/** The step runs inline in the conversation instead of being delegated. */
	inline: boolean;
	/** Retry budget of the judged step, or null when it has none to spend. */
	retries: { count: number; max: number } | null;
}

export interface CanvasEdge {
	id: string;
	from: string;
	to: string;
	kind: CanvasEdgeKind;
	state: CanvasEdgeState;
	/** Already-routed polyline, in the same coordinate space as the nodes. */
	points: CanvasPoint[];
}

export interface CanvasGraph {
	nodes: CanvasNode[];
	edges: CanvasEdge[];
	/** Size of the whole drawing, padding included — the stage's width/height. */
	width: number;
	height: number;
}

/** Breathing room around the drawing, so an arrowhead never sits on the edge. */
export const CANVAS_PADDING = 28;
export const CARD_WIDTH = 264;
/**
 * Tall enough for the worst case the card actually renders: three clamped lines
 * of description AND the flags row under them (selected / manual review /
 * inline). Cards are one fixed size rather than measured, because a graph whose
 * boxes move as their text reflows is a graph that jumps under the operator on
 * every poll.
 */
export const CARD_HEIGHT = 132;
/** The context card carries no metadata row, so it is shorter than a task card. */
export const CONTEXT_CARD_HEIGHT = 76;
export const JUDGE_SIZE = 72;
/** Horizontal gap between a card and its judge circle. */
export const COLUMN_GAP = 64;
/** Vertical gap between one card and the next — where the spine arrow lives. */
export const ROW_GAP = 62;
/** How far below a card the retry loop runs before turning back up into it. */
const RETRY_DROP = 26;

/** A step in flight, in either of its two senses. */
const IN_FLIGHT = new Set(["running", "queued"]);

const CARD_STATES = new Set<string>(["pending", "queued", "running", "waiting", "done", "failed"]);

/** The card's own state: the step's status, except that judging is its own word. */
function cardState(step: CanvasStep): CanvasNodeState {
	if (step.status === "running" && step.phase === "judge") return "judging";
	// A status this UI doesn't know (an older or newer hub) draws as pending
	// rather than as an unstyled card with no state class at all.
	return CARD_STATES.has(step.status) ? (step.status as CanvasNodeState) : "pending";
}

/**
 * The circle's state. `waiting` counts as passed on purpose: a step held at its
 * manual-review gate has already cleared its judge — the thing still to decide
 * is the human's, not the judge's.
 */
function judgeState(step: CanvasStep): CanvasNodeState {
	if (step.status === "running") return step.phase === "judge" ? "judging" : "pending";
	if (step.status === "done" || step.status === "waiting") return "done";
	if (step.status === "failed") return "failed";
	return "pending";
}

/** Whether a node's state means "there is a job on this right now". */
function isLive(state: CanvasNodeState): boolean {
	return state === "running" || state === "queued" || state === "judging" || state === "waiting";
}

function hasJudge(step: CanvasStep): boolean {
	return (step.acceptanceCriteria ?? "").trim() !== "";
}

/**
 * Builds the whole picture from a workflow's steps, in the order they are given
 * (which is already display order — the caller does not have to sort).
 *
 * The context step is pinned at the top and kept out of the numbering, exactly
 * as the step list pins it above the `<ol>`: it runs before step 1, but it is
 * not step 0.
 */
export function layoutWorkflow(steps: readonly CanvasStep[]): CanvasGraph {
	const contextStep = steps.find((s) => s.kind === "context") ?? null;
	const taskSteps = steps.filter((s) => s.kind !== "context");

	const nodes: CanvasNode[] = [];
	const edges: CanvasEdge[] = [];
	const x = CANVAS_PADDING;
	let y = CANVAS_PADDING;

	if (contextStep) {
		nodes.push({
			id: contextStep.id,
			stepId: contextStep.id,
			kind: "context",
			state: cardState(contextStep),
			label: "ctx",
			description: contextStep.description,
			x,
			y,
			width: CARD_WIDTH,
			height: CONTEXT_CARD_HEIGHT,
			// The context step is never part of the run selection — it is always
			// dispatched — so a tick on it would be a promise the engine doesn't keep.
			selected: false,
			manualReview: false,
			inline: false,
			retries: null,
		});
		y += CONTEXT_CARD_HEIGHT + ROW_GAP;
	}

	for (const step of taskSteps) {
		const state = cardState(step);
		const max = step.maxRetries ?? 0;
		nodes.push({
			id: step.id,
			stepId: step.id,
			kind: "step",
			state,
			label: String(step.orderIndex + 1),
			description: step.description,
			x,
			y,
			width: CARD_WIDTH,
			height: CARD_HEIGHT,
			selected: step.selected === true,
			manualReview: step.manualReview === true,
			inline: step.useSubagent === false,
			retries: max > 0 ? { count: step.retryCount ?? 0, max } : null,
		});

		if (hasJudge(step)) {
			const jState = judgeState(step);
			const judgeX = x + CARD_WIDTH + COLUMN_GAP;
			const judgeY = y + (CARD_HEIGHT - JUDGE_SIZE) / 2;
			nodes.push({
				id: `${step.id}:judge`,
				stepId: step.id,
				kind: "judge",
				state: jState,
				label: "",
				description: (step.acceptanceCriteria ?? "").trim(),
				x: judgeX,
				y: judgeY,
				width: JUDGE_SIZE,
				height: JUDGE_SIZE,
				selected: false,
				manualReview: false,
				inline: false,
				retries: max > 0 ? { count: step.retryCount ?? 0, max } : null,
			});

			const midY = y + CARD_HEIGHT / 2;
			edges.push({
				id: `${step.id}:to-judge`,
				from: step.id,
				to: `${step.id}:judge`,
				kind: "judge",
				state: jState === "judging" ? "active" : jState === "done" || jState === "failed" ? "done" : "pending",
				points: [
					{ x: x + CARD_WIDTH, y: midY },
					{ x: judgeX, y: midY },
				],
			});

			// The loop back into the step, drawn only when there is a retry budget
			// to spend: with `maxRetries` at 0 a reject fails the step outright, and
			// an arrow promising a re-run that can't happen would be a lie.
			if (max > 0) {
				const dropY = y + CARD_HEIGHT + RETRY_DROP;
				const reentryX = x + CARD_WIDTH * 0.78;
				const retried = (step.retryCount ?? 0) > 0;
				edges.push({
					id: `${step.id}:retry`,
					from: `${step.id}:judge`,
					to: step.id,
					kind: "retry",
					state: retried && IN_FLIGHT.has(step.status) ? "active" : retried ? "done" : "pending",
					points: [
						{ x: judgeX + JUDGE_SIZE / 2, y: judgeY + JUDGE_SIZE },
						{ x: judgeX + JUDGE_SIZE / 2, y: dropY },
						{ x: reentryX, y: dropY },
						{ x: reentryX, y: y + CARD_HEIGHT },
					],
				});
			}
		}

		y += CARD_HEIGHT + ROW_GAP;
	}

	// The spine, added once every card's box is known so each arrow can be routed
	// from the bottom of one to the top of the next.
	const spine = nodes.filter((n) => n.kind !== "judge");
	for (let i = 0; i < spine.length - 1; i++) {
		const from = spine[i];
		const to = spine[i + 1];
		if (!from || !to) continue;
		const cx = from.x + from.width / 2;
		edges.push({
			id: `${from.id}->${to.id}`,
			from: from.id,
			to: to.id,
			kind: "flow",
			// "Done" is about the arrow, not the step it points at: what the line
			// says is "the run got this far", and it did as soon as its source
			// finished. The target lights it up only while it is actually in flight.
			state: isLive(to.state) ? "active" : from.state === "done" ? "done" : "pending",
			points: [
				{ x: cx, y: from.y + from.height },
				{ x: cx, y: to.y },
			],
		});
	}

	const width = nodes.reduce((max, n) => Math.max(max, n.x + n.width), 0) + CANVAS_PADDING;
	const height = nodes.reduce((max, n) => Math.max(max, n.y + n.height), 0) + CANVAS_PADDING;

	return { nodes, edges, width, height };
}

/**
 * Which node the viewport should keep in sight — what the operator opened the
 * canvas to watch.
 *
 * A running step wins over a queued one, and both over a step holding for
 * review, because that is the order of "something is happening here". With
 * nothing in flight it falls back to the first step that hasn't run, so a draft
 * workflow opens at its beginning rather than wherever the scroll last was.
 * Null only when there is nothing to look at.
 */
export function focusNodeId(nodes: readonly CanvasNode[]): string | null {
	const cards = nodes.filter((n) => n.kind !== "judge");
	const byState = (...states: CanvasNodeState[]): CanvasNode | undefined =>
		cards.find((n) => states.includes(n.state));
	const node =
		byState("running", "judging") ?? byState("queued") ?? byState("waiting") ?? byState("pending") ?? null;
	return node?.id ?? null;
}

/** An edge's polyline as an SVG `d`, which is all the component does with the points. */
export function edgePath(edge: CanvasEdge): string {
	return edge.points
		.map((p, i) => `${i === 0 ? "M" : "L"}${Math.round(p.x)} ${Math.round(p.y)}`)
		.join(" ");
}
