/**
 * Tests for the workflow canvas — the second way of looking at a workflow's
 * steps, added beside the list.
 *
 * The list can only say "these are the steps, in this order". It cannot show
 * that step 3 has to satisfy a judge and step 4 doesn't, that a reject loops
 * BACKWARDS into the step it rejected rather than forwards, or — while a run is
 * in flight — where in the workflow the agent actually is. The canvas draws all
 * three: a card per step, arrows for what runs after what, and a circle on every
 * judged step that spins while its verdict is being decided.
 *
 * What's covered here:
 *
 *  1. **The graph** (`layoutWorkflow` in hub/ui/src/lib/canvasLayout.ts) — one
 *     node per step, the context step pinned first and out of the numbering, a
 *     judge circle only where there are acceptance criteria, and a retry loop
 *     only where there's a retry budget to spend.
 *  2. **The geometry** — one column of cards top to bottom, each judge beside
 *     its own card, nothing overlapping, and every arrow routed between the two
 *     boxes it claims to join.
 *  3. **The live states** — what the canvas shows while a workflow is RUNNING,
 *     which is the whole reason it isn't a static diagram: the in-flight card,
 *     the arrow feeding it, and the circle that reads `judging` instead of
 *     `running` while the judge has it.
 *  4. **The seams** the unit tests can't see: that the view is rendered behind
 *     the List/Canvas toggle, that it is READ-ONLY (the point of the split — a
 *     workflow is edited in the list and nowhere else), and that a click on a
 *     card can find its row in the list.
 *
 * Pure functions and source reads — no DOM, and no TARGET_HOME needed, since
 * nothing here touches the hub's storage.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const {
	CANVAS_PADDING,
	CARD_HEIGHT,
	CARD_WIDTH,
	COLUMN_GAP,
	JUDGE_SIZE,
	edgePath,
	focusNodeId,
	layoutWorkflow,
} = await import("./ui/src/lib/canvasLayout.ts");

type CanvasStep = Parameters<typeof layoutWorkflow>[0][number];
type CanvasNode = ReturnType<typeof layoutWorkflow>["nodes"][number];
type CanvasEdge = ReturnType<typeof layoutWorkflow>["edges"][number];

const uiDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui/src");
const read = (rel: string): string => fs.readFileSync(path.join(uiDir, rel), "utf8");

let seq = 0;

/** A task step with everything the canvas reads, overridable field by field. */
function step(over: Partial<CanvasStep> = {}): CanvasStep {
	const orderIndex = over.orderIndex ?? seq;
	return {
		id: `s${++seq}`,
		kind: "task",
		orderIndex,
		description: `step ${orderIndex + 1}`,
		status: "pending",
		phase: "exec",
		acceptanceCriteria: null,
		manualReview: false,
		useSubagent: true,
		maxRetries: 0,
		retryCount: 0,
		selected: false,
		...over,
	};
}

/** The hub-owned context step, which is pinned above the numbering. */
function contextStep(over: Partial<CanvasStep> = {}): CanvasStep {
	return step({ kind: "context", orderIndex: -1, description: "conversation context", ...over });
}

const byId = (nodes: readonly CanvasNode[], id: string): CanvasNode => {
	const found = nodes.find((n) => n.id === id);
	assert.ok(found, `no node ${id}`);
	return found;
};

const edgeBetween = (edges: readonly CanvasEdge[], from: string, to: string): CanvasEdge => {
	const found = edges.find((e) => e.from === from && e.to === to);
	assert.ok(found, `no edge ${from} -> ${to}`);
	return found;
};

// ---------------------------------------------------------------------------
// 1. The graph
// ---------------------------------------------------------------------------

test("every step becomes one card, in the order it was given", () => {
	const steps = [step({ orderIndex: 0 }), step({ orderIndex: 1 }), step({ orderIndex: 2 })];
	const { nodes } = layoutWorkflow(steps);

	const cards = nodes.filter((n) => n.kind === "step");
	assert.deepEqual(
		cards.map((n) => n.id),
		steps.map((s) => s.id),
	);
	// The number on the card is the step's own, so the canvas and the list can
	// never disagree about which step is "3".
	assert.deepEqual(
		cards.map((n) => n.label),
		["1", "2", "3"],
	);
});

test("the context step is pinned first, kept out of the numbering, and never selectable", () => {
	const ctx = contextStep();
	const { nodes } = layoutWorkflow([ctx, step({ orderIndex: 0, selected: true })]);

	const first = nodes[0];
	assert.equal(first.id, ctx.id);
	assert.equal(first.kind, "context");
	assert.equal(first.label, "ctx", "the context step is not step 0 — it has no number");
	// It is always dispatched, so a tick on it would promise something the
	// selection doesn't decide.
	assert.equal(first.selected, false);
	assert.equal(nodes.find((n) => n.kind === "step")?.label, "1");
	assert.equal(nodes.find((n) => n.kind === "step")?.selected, true);
});

test("a judge circle appears only where there are acceptance criteria", () => {
	const judged = step({ orderIndex: 0, acceptanceCriteria: "the file exists" });
	const plain = step({ orderIndex: 1 });
	// Whitespace is not a criterion — it produces no judge on the server either.
	const blank = step({ orderIndex: 2, acceptanceCriteria: "   " });
	const { nodes } = layoutWorkflow([judged, plain, blank]);

	const judges = nodes.filter((n) => n.kind === "judge");
	assert.equal(judges.length, 1);
	assert.equal(judges[0].id, `${judged.id}:judge`);
	// The circle carries the id of the step it belongs to, which is what makes it
	// clickable through to that step's row.
	assert.equal(judges[0].stepId, judged.id);
	assert.equal(judges[0].description, "the file exists", "the criteria are the circle's tooltip");
});

test("the retry loop is drawn only when there is a retry budget to spend", () => {
	const noBudget = step({ orderIndex: 0, acceptanceCriteria: "ok", maxRetries: 0 });
	const budget = step({ orderIndex: 1, acceptanceCriteria: "ok", maxRetries: 2 });
	const { edges } = layoutWorkflow([noBudget, budget]);

	const retries = edges.filter((e) => e.kind === "retry");
	assert.equal(retries.length, 1, "with maxRetries 0 a reject fails the step outright — there is no loop");
	assert.equal(retries[0].from, `${budget.id}:judge`);
	assert.equal(retries[0].to, budget.id, "a reject goes BACKWARDS, into the step it rejected");
});

test("the spine joins consecutive cards and skips the judges hanging off them", () => {
	const ctx = contextStep();
	const a = step({ orderIndex: 0, acceptanceCriteria: "ok" });
	const b = step({ orderIndex: 1 });
	const { edges } = layoutWorkflow([ctx, a, b]);

	const flow = edges.filter((e) => e.kind === "flow");
	assert.deepEqual(
		flow.map((e) => [e.from, e.to]),
		[
			[ctx.id, a.id],
			[a.id, b.id],
		],
		"the run goes ctx → 1 → 2; the judge is a branch off step 1, not a stop on the way to step 2",
	);
});

test("an empty workflow lays out to an empty graph rather than crashing", () => {
	const graph = layoutWorkflow([]);
	assert.deepEqual(graph.nodes, []);
	assert.deepEqual(graph.edges, []);
	assert.equal(focusNodeId(graph.nodes), null);
});

// ---------------------------------------------------------------------------
// 2. The geometry
// ---------------------------------------------------------------------------

test("cards stack in one column, top to bottom, without overlapping", () => {
	const steps = [step({ orderIndex: 0 }), step({ orderIndex: 1 }), step({ orderIndex: 2 })];
	const { nodes, height } = layoutWorkflow(steps);
	const cards = nodes.filter((n) => n.kind !== "judge");

	for (const card of cards) {
		assert.equal(card.x, CANVAS_PADDING, "one column: every card shares a left edge");
		assert.equal(card.width, CARD_WIDTH);
	}
	for (let i = 1; i < cards.length; i++) {
		const above = cards[i - 1];
		assert.ok(
			cards[i].y > above.y + above.height,
			`card ${i + 1} must start below card ${i}, leaving room for the arrow between them`,
		);
	}
	// The stage is tall enough for the last card plus its padding.
	const last = cards[cards.length - 1];
	assert.equal(height, last.y + last.height + CANVAS_PADDING);
});

test("a judge circle sits beside its own card, vertically centred on it", () => {
	const judged = step({ orderIndex: 0, acceptanceCriteria: "ok" });
	const { nodes, width } = layoutWorkflow([judged]);
	const card = byId(nodes, judged.id);
	const judge = byId(nodes, `${judged.id}:judge`);

	assert.equal(judge.width, JUDGE_SIZE);
	assert.equal(judge.height, JUDGE_SIZE, "round: the one thing on the canvas that isn't a step");
	assert.equal(judge.x, card.x + card.width + COLUMN_GAP, "clear of the card, to its right");
	assert.equal(judge.y + judge.height / 2, card.y + card.height / 2, "level with the middle of its card");
	// The stage is wide enough for the branch, not just the spine.
	assert.equal(width, judge.x + JUDGE_SIZE + CANVAS_PADDING);
});

test("every arrow is routed between the two boxes it joins", () => {
	const a = step({ orderIndex: 0, acceptanceCriteria: "ok", maxRetries: 1 });
	const b = step({ orderIndex: 1 });
	const { nodes, edges } = layoutWorkflow([a, b]);
	const cardA = byId(nodes, a.id);
	const cardB = byId(nodes, b.id);
	const judge = byId(nodes, `${a.id}:judge`);

	const spine = edgeBetween(edges, a.id, b.id);
	assert.deepEqual(spine.points, [
		{ x: cardA.x + CARD_WIDTH / 2, y: cardA.y + cardA.height },
		{ x: cardB.x + CARD_WIDTH / 2, y: cardB.y },
	]);

	const toJudge = edgeBetween(edges, a.id, `${a.id}:judge`);
	assert.deepEqual(toJudge.points, [
		{ x: cardA.x + CARD_WIDTH, y: cardA.y + CARD_HEIGHT / 2 },
		{ x: judge.x, y: cardA.y + CARD_HEIGHT / 2 },
	]);

	// The loop drops below the circle and comes back up into the card, rather
	// than cutting straight across it.
	const retry = edgeBetween(edges, `${a.id}:judge`, a.id);
	assert.ok(retry.points.length > 2, "the retry loop is routed around the card, not through it");
	assert.equal(retry.points[0].y, judge.y + JUDGE_SIZE, "it leaves the circle at the bottom");
	const end = retry.points[retry.points.length - 1];
	assert.equal(end.y, cardA.y + cardA.height, "and arrives at the bottom of the step it re-runs");
	assert.ok(end.x > cardA.x && end.x < cardA.x + CARD_WIDTH, "inside the card's width");
	assert.notEqual(end.x, cardA.x + CARD_WIDTH / 2, "clear of the spine arrow, which uses the centre");
});

test("edgePath turns a polyline into an SVG path, one move and the rest lines", () => {
	const { edges } = layoutWorkflow([step({ orderIndex: 0 }), step({ orderIndex: 1 })]);
	const d = edgePath(edges[0]);

	assert.match(d, /^M\d+ \d+ L\d+ \d+$/);
});

// ---------------------------------------------------------------------------
// 3. What it shows while the workflow RUNS
// ---------------------------------------------------------------------------

test("a running step's card is running, and the arrow into it is active", () => {
	const done = step({ orderIndex: 0, status: "done" });
	const live = step({ orderIndex: 1, status: "running" });
	const later = step({ orderIndex: 2 });
	const { nodes, edges } = layoutWorkflow([done, live, later]);

	assert.equal(byId(nodes, done.id).state, "done");
	assert.equal(byId(nodes, live.id).state, "running");
	assert.equal(byId(nodes, later.id).state, "pending");

	assert.equal(edgeBetween(edges, done.id, live.id).state, "active", "the run is travelling this arrow now");
	assert.equal(edgeBetween(edges, live.id, later.id).state, "pending", "nothing has reached step 3 yet");
});

test("an arrow out of a finished step reads done even before the next one starts", () => {
	// "Done" is a fact about the arrow, not the step it points at: the run really
	// did get this far.
	const { nodes, edges } = layoutWorkflow([step({ orderIndex: 0, status: "done" }), step({ orderIndex: 1 })]);
	const [from, to] = nodes;

	assert.equal(edgeBetween(edges, from.id, to.id).state, "done");
});

test("a queued step lights its arrow too — accepted by the broker is already in flight", () => {
	const first = step({ orderIndex: 0, status: "done" });
	const queued = step({ orderIndex: 1, status: "queued" });
	const { nodes, edges } = layoutWorkflow([first, queued]);

	assert.equal(byId(nodes, queued.id).state, "queued");
	assert.equal(edgeBetween(edges, first.id, queued.id).state, "active");
});

test("the circle reads judging while the judge has the step, and the card does too", () => {
	const judging = step({ orderIndex: 0, status: "running", phase: "judge", acceptanceCriteria: "ok" });
	const { nodes, edges } = layoutWorkflow([judging]);

	// The work is finished; what's happening is the verdict — the same
	// distinction the step list makes in words, made here in the circle.
	assert.equal(byId(nodes, judging.id).state, "judging");
	assert.equal(byId(nodes, `${judging.id}:judge`).state, "judging");
	assert.equal(edgeBetween(edges, judging.id, `${judging.id}:judge`).state, "active");
});

test("a judged step that passed shows a settled circle; one that failed shows a failed circle", () => {
	const passed = step({ orderIndex: 0, status: "done", acceptanceCriteria: "ok" });
	const rejected = step({ orderIndex: 1, status: "failed", acceptanceCriteria: "ok" });
	const { nodes } = layoutWorkflow([passed, rejected]);

	assert.equal(byId(nodes, `${passed.id}:judge`).state, "done");
	assert.equal(byId(nodes, `${rejected.id}:judge`).state, "failed");
});

test("a step held for review has already cleared its judge — the circle is done, the card is waiting", () => {
	const held = step({ orderIndex: 0, status: "waiting", acceptanceCriteria: "ok", manualReview: true });
	const { nodes } = layoutWorkflow([held]);

	assert.equal(byId(nodes, held.id).state, "waiting", "what's still to decide is the human's, not the judge's");
	assert.equal(byId(nodes, held.id).manualReview, true, "the gate is on the card, before it ever holds");
	assert.equal(byId(nodes, `${held.id}:judge`).state, "done");
});

test("the retry count rides on the judge, and the loop reads done once it has really looped", () => {
	const retried = step({
		orderIndex: 0,
		status: "running",
		acceptanceCriteria: "ok",
		maxRetries: 3,
		retryCount: 1,
	});
	const { nodes, edges } = layoutWorkflow([retried]);

	assert.deepEqual(byId(nodes, `${retried.id}:judge`).retries, { count: 1, max: 3 });
	assert.equal(
		edgeBetween(edges, `${retried.id}:judge`, retried.id).state,
		"active",
		"a rejected step that is running again is travelling the loop right now",
	);
});

test("a retry loop that has never fired is pending, not done", () => {
	const fresh = step({ orderIndex: 0, acceptanceCriteria: "ok", maxRetries: 2, retryCount: 0 });
	const { edges } = layoutWorkflow([fresh]);

	assert.equal(edgeBetween(edges, `${fresh.id}:judge`, fresh.id).state, "pending");
});

test("an unknown status draws as pending instead of as an unstyled card", () => {
	const { nodes } = layoutWorkflow([step({ orderIndex: 0, status: "something-new" })]);
	assert.equal(nodes[0].state, "pending");
});

test("the viewport follows the run: in flight first, then the hold, then the next unrun step", () => {
	const run = layoutWorkflow([
		step({ orderIndex: 0, status: "done" }),
		step({ orderIndex: 1, status: "waiting" }),
		step({ orderIndex: 2, status: "running" }),
		step({ orderIndex: 3 }),
	]);
	assert.equal(focusNodeId(run.nodes), run.nodes[2].id, "a running step wins over one holding for review");

	const held = layoutWorkflow([step({ orderIndex: 0, status: "done" }), step({ orderIndex: 1, status: "waiting" })]);
	assert.equal(focusNodeId(held.nodes), held.nodes[1].id, "with nothing in flight, the step needing a human");

	// A draft opens at its beginning rather than wherever the scroll last was.
	const draft = layoutWorkflow([step({ orderIndex: 0 }), step({ orderIndex: 1 })]);
	assert.equal(focusNodeId(draft.nodes), draft.nodes[0].id);

	// Nothing left to watch: a finished workflow doesn't yank the viewport.
	const finished = layoutWorkflow([step({ orderIndex: 0, status: "done" })]);
	assert.equal(focusNodeId(finished.nodes), null);
});

test("the judge circle is never what the viewport follows — the step is", () => {
	const judging = step({ orderIndex: 0, status: "running", phase: "judge", acceptanceCriteria: "ok" });
	const { nodes } = layoutWorkflow([judging]);

	assert.equal(focusNodeId(nodes), judging.id);
});

// ---------------------------------------------------------------------------
// 4. The seams
// ---------------------------------------------------------------------------

test("WorkflowDetail renders the canvas behind a List/Canvas toggle, in place of the list", () => {
	const source = read("views/WorkflowDetail.tsx");

	assert.match(source, /import \{ WorkflowCanvas \} from "\.\/WorkflowCanvas\.tsx"/);
	assert.match(source, /data-steps-view=\{mode\}/, "the toggle needs a stable hook for its two halves");
	assert.match(source, /stepsView === "canvas" \? \(\s*<WorkflowCanvas steps=\{steps\} onOpenStep=\{openStepInList\} \/>/);
	// The canvas gets `steps`, not `taskSteps`: the context step is part of the
	// picture (it runs before step 1), it is just not part of the numbering.
	assert.match(source, /<WorkflowCanvas steps=\{steps\}/);
	// "Select all" is a list control — there are no checkboxes on the canvas.
	assert.match(source, /taskSteps\.length > 0 && stepsView === "list" &&/);
});

test("the canvas is read-only: it is handed no way to change anything", () => {
	const source = read("views/WorkflowCanvas.tsx");

	for (const forbidden of ["onSave", "onRemove", "onSetStatus", "onAbort", "onContinue", "onMove", "onToggleSelected"]) {
		assert.ok(!source.includes(forbidden), `the canvas must not take ${forbidden} — a workflow is edited in the list`);
	}
	// The one thing a card does is take you to where editing happens.
	assert.match(source, /onOpenStep: \(stepId: string\) => void/);
	assert.match(source, /onClick=\{\(\) => onOpen\(node\.stepId\)\}/);
});

test("a card and its judge are real buttons, labelled for a screen reader", () => {
	const source = read("views/WorkflowCanvas.tsx");

	// Not <div onClick>: reachable by keyboard, and it says what pressing it does.
	assert.match(source, /aria-label=\{`\$\{isContext \? "Conversation context" : `Step \$\{node\.label\}`\}/);
	assert.match(source, /aria-label=\{`Judge — \$\{label\}\. Opens this step in the list\.`\}/);
	assert.match(source, /data-canvas-node=\{node\.id\}/, "the viewport scrolls to a node by this hook");
});

test("clicking a card lands on that step's row in the list", () => {
	// The canvas can't edit, so its click has to hand over to the thing that can —
	// which means the row must be findable in the DOM.
	assert.match(read("views/StepItem.tsx"), /data-step-id=\{step\.id\}/);
	assert.match(read("views/WorkflowDetail.tsx"), /\[data-step-id="\$\{CSS\.escape\(stepId\)\}"\]/);
	assert.match(read("views/WorkflowDetail.tsx"), /setStepsView\("list"\)/);
});

test("the canvas is styled from the same status hues the badges use", () => {
	const css = read("views/WorkflowCanvas.module.css");

	// A card in a given state wears the colour its pill wears in the list, so the
	// two views never have to be reconciled by eye.
	assert.match(css, /\.state_running[\s\S]{0,120}--info-500/);
	assert.match(css, /\.state_waiting[\s\S]{0,120}--attention-500/);
	assert.match(css, /\.state_done[\s\S]{0,120}--success-500/);
	assert.match(css, /\.state_failed[\s\S]{0,120}--danger-500/);
	// The circle is a circle.
	assert.match(css, /\.judge \{[\s\S]{0,400}border-radius: 50%/);
	// And it spins only while it is actually deciding.
	assert.match(css, /\.judgeState_judging \.judgeRing[\s\S]{0,200}animation: spin/);
});
