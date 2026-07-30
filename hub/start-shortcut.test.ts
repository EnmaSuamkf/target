/**
 * Tests for the Start shortcut (Alt/Shift+S): the keystroke that presses the
 * open workflow's run button.
 *
 * Like the Continue shortcut it is built as "click the button that is already
 * there" (see hub/ui/src/lib/startShortcut.ts, and shortcutButtons.ts for the
 * press both shortcuts share), so it is verified in three layers, each covering
 * what the one below it can't:
 *
 *  1. **The press.** `pressStartButton` clicks the first ENABLED
 *     `[data-start-workflow]` button and reports whether it found one — so with
 *     no workflow open (no button), or nothing selected / a run already going /
 *     a step held for review (a disabled one), the combo is inert rather than
 *     firing a request the server would refuse.
 *  2. **What the press does.** A real workflow with real steps, pressed through
 *     a stub button whose click does exactly what the UI's onClick does (POST
 *     /api/workflows/:id/start with the selected step ids, against the real hub
 *     server). The workflow goes `running` and the first selected step is
 *     dispatched.
 *  3. **The wiring.** Layers 1 and 2 both press a *stub* button, because there
 *     is no DOM in this suite — so on their own they'd still pass if the real
 *     button silently lost the `data-start-workflow` attribute the shortcut
 *     looks for. The last tests read WorkflowDetail.tsx and the hook and pin
 *     that seam down: the run button must carry the attribute
 *     `START_BUTTON_SELECTOR` selects on, and the hook must actually call the
 *     helper (with the typing guard, before `preventDefault`).
 *
 * Same throwaway-TARGET_HOME + fake-awb-hook convention as continue-shortcut.test.ts.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-start-shortcut-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;
process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, "claude");

const { getStep, getWorkflow, insertStep, insertWorkflow } = await import("./db.ts");
const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");
const { onStepResult, startWorkflow } = await import("./workflow.ts");
const { START_BUTTON_SELECTOR, pressStartButton } = await import("./ui/src/lib/startShortcut.ts");
const { isTypingTarget } = await import("./ui/src/lib/shortcutButtons.ts");

const cfg = loadConfig();
const silent = () => {};
let seq = 0;

const server = createServer(cfg, silent);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("server did not bind a port");
const baseUrl = `http://127.0.0.1:${address.port}`;

test.after(() => {
	server.close();
});

/** A fake awb hook that swallows dispatches (answers ok, never calls back). */
function startFakeHook(): Promise<{ server: http.Server; url: string }> {
	const hookServer = http.createServer((req, res) => {
		req.on("data", () => {});
		req.on("end", () => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		});
	});
	return new Promise((resolve) => {
		hookServer.listen(0, "127.0.0.1", () => {
			const addr = hookServer.address();
			if (!addr || typeof addr === "string") throw new Error("fake hook did not bind");
			resolve({ server: hookServer, url: `http://127.0.0.1:${addr.port}/hook/agent` });
		});
	});
}

async function hook(t: { after: (fn: () => void) => void }): Promise<string> {
	const { server: hookServer, url } = await startFakeHook();
	t.after(() => hookServer.close());
	return url;
}

/** A draft workflow with two steps — what the operator is looking at. */
function makeWorkflow(hookUrl: string, options: { manualReview?: boolean } = {}) {
	const id = `wf-${++seq}`;
	const workflow = insertWorkflow({
		id,
		name: `start shortcut ${id}`,
		agentName: `agent-${id}`,
		hookUrl,
		secret: "s3cret",
		mdPath: path.join(tmpHome, `${id}.md`),
		conversationContext: null,
	});
	const first = insertStep(id, "the first thing to do", options.manualReview ? { manualReview: true } : {});
	const second = insertStep(id, "and then this", {});
	return { workflow, first, second };
}

/** The stub the shortcut clicks, standing in for WorkflowDetail's Start button. */
interface StubButton {
	disabled: boolean;
	clicks: number;
	click: () => void;
}

function stubButton(options: { disabled?: boolean; onClick?: () => void } = {}): StubButton {
	const button: StubButton = {
		disabled: options.disabled ?? false,
		clicks: 0,
		click: () => {
			button.clicks += 1;
			options.onClick?.();
		},
	};
	return button;
}

/** A document holding those buttons, answering only the shortcut's selector. */
function stubRoot(buttons: StubButton[]) {
	return {
		querySelectorAll: (selector: string): StubButton[] => (selector === START_BUTTON_SELECTOR ? buttons : []),
	};
}

/** What App.tsx's handleStart does for a draft workflow, minus toast and refresh. */
function startRequest(workflowId: string, stepIds: string[]): Promise<Response> {
	return fetch(`${baseUrl}/api/workflows/${workflowId}/start`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}` },
		body: JSON.stringify({ stepIds }),
	});
}

// --- the whole path: a workflow, a keystroke, a run ----------------------

test("the shortcut presses the workflow's Start button, and the run actually starts", async (t) => {
	const url = await hook(t);
	const { workflow, first, second } = makeWorkflow(url);

	// The state the operator finds: a draft that has never run.
	assert.equal(getWorkflow(workflow.id)?.status, "draft");
	assert.equal(getStep(first.id)?.status, "pending");

	// The button the UI renders, wired to the same request its onClick makes.
	// Clicking is synchronous, so the requests it starts are collected and
	// awaited after the press.
	const requests: Promise<Response>[] = [];
	const button = stubButton({ onClick: () => requests.push(startRequest(workflow.id, [first.id, second.id])) });

	// The keystroke.
	const pressed = pressStartButton(stubRoot([button]));

	assert.equal(pressed, true, "the shortcut found a Start button to press");
	assert.equal(button.clicks, 1, "it was a real click on that button, once");
	assert.equal(requests.length, 1, "the click started exactly one start request");
	const [res] = await Promise.all(requests);
	assert.equal(res?.status, 200);

	// The run began, exactly as if the button had been clicked with a mouse: the
	// first selected step was dispatched (the fake hook never calls back, so it
	// stays `queued`) and the second waits its turn.
	assert.equal(getWorkflow(workflow.id)?.status, "running");
	assert.equal(getStep(first.id)?.status, "queued", "the first step was dispatched to the agent");
	assert.equal(getStep(second.id)?.status, "pending", "the engine is sequential — the second waits");
});

test("with no workflow open there is no button, so the shortcut does nothing at all", async (t) => {
	const url = await hook(t);
	const { workflow, first, second } = makeWorkflow(url);

	assert.equal(pressStartButton(stubRoot([])), false);

	// No request was made, so nothing about the workflow changed.
	assert.equal(getWorkflow(workflow.id)?.status, "draft");
	assert.equal(getStep(first.id)?.status, "pending");
	assert.equal(getStep(second.id)?.status, "pending");
});

test("a disabled Start button — nothing selected, already running, held for review — is not pressed", () => {
	const button = stubButton({ disabled: true, onClick: () => assert.fail("a disabled button must not be clicked") });
	assert.equal(pressStartButton(stubRoot([button])), false);
	assert.equal(button.clicks, 0);
});

test("with a disabled and an enabled button on screen, the enabled one is pressed", () => {
	const disabled = stubButton({ disabled: true });
	const enabled = stubButton();
	assert.equal(pressStartButton(stubRoot([disabled, enabled])), true);
	assert.equal(disabled.clicks, 0);
	assert.equal(enabled.clicks, 1);
});

test("only the first enabled button is pressed — one keystroke is one run", () => {
	const first = stubButton();
	const second = stubButton();
	pressStartButton(stubRoot([first, second]));
	assert.equal(first.clicks, 1);
	assert.equal(second.clicks, 0);
});

test("the Continue and Start shortcuts select on different attributes", async () => {
	const { CONTINUE_BUTTON_SELECTOR } = await import("./ui/src/lib/continueShortcut.ts");
	assert.notEqual(START_BUTTON_SELECTOR, CONTINUE_BUTTON_SELECTOR);
	// A Start press must not find a Continue button, and the stub root proves the
	// selector is what's asked for rather than "whatever buttons exist".
	const button = stubButton();
	assert.equal(
		pressStartButton({
			querySelectorAll: (selector: string) => (selector === CONTINUE_BUTTON_SELECTOR ? [button] : []),
		}),
		false,
	);
	assert.equal(button.clicks, 0);
});

// --- why the button is disabled where it is ------------------------------

test("the server refuses a Start on a workflow held for review — which is why that button is disabled", async (t) => {
	const url = await hook(t);
	const { workflow, first, second } = makeWorkflow(url, { manualReview: true });

	await startWorkflow(workflow.id, cfg, silent, [first.id, second.id]);
	await onStepResult(first.id, { ok: true, result: "the work", sessionId: "sess-1" }, cfg, silent);
	assert.equal(getWorkflow(workflow.id)?.status, "waiting");

	// The UI never sends this (startActionFor returns null, so the button is
	// disabled and the shortcut skips it), but if it ever did, the engine says no
	// rather than flipping a held workflow back to running.
	const res = await startRequest(workflow.id, [first.id, second.id]);
	assert.equal(res.status, 400);
	assert.equal(getWorkflow(workflow.id)?.status, "waiting", "the hold is untouched");
});

// --- the typing guard ---------------------------------------------------

test("keystrokes aimed at a text field are typing, not the shortcut", () => {
	// Shift+S is how a capital S is typed: starting a run because someone wrote
	// "Start" into a step description is the failure this prevents.
	assert.equal(isTypingTarget({ tagName: "INPUT" }), true);
	assert.equal(isTypingTarget({ tagName: "TEXTAREA" }), true);
	assert.equal(isTypingTarget({ tagName: "SELECT" }), true);
	assert.equal(isTypingTarget({ tagName: "DIV", isContentEditable: true }), true);
	assert.equal(isTypingTarget({ tagName: "BUTTON" }), false);
	assert.equal(isTypingTarget(null), false);
});

// --- the seam: the REAL button carries what the shortcut selects on ------
//
// Everything above presses a stub, so on its own it would stay green if the
// real button lost the attribute and the shortcut quietly stopped finding
// anything. There is no DOM here to render WorkflowDetail into (no jsdom, and it
// imports CSS Modules), so the source is read instead: crude, but it fails
// exactly when the wiring breaks, which is the point.

const UI_DIR = path.join(import.meta.dirname, "ui", "src");

/**
 * Splits JSX source into `<button …>body</button>` pairs. Written by hand
 * rather than with a regex because a JSX attribute can contain `>` inside an
 * expression (`onClick={() => …}`), which is exactly the button of interest.
 */
function jsxButtons(source: string): { attributes: string; body: string }[] {
	const buttons: { attributes: string; body: string }[] = [];
	let from = 0;
	for (;;) {
		const open = source.indexOf("<button", from);
		if (open === -1) return buttons;
		let i = open + "<button".length;
		let depth = 0;
		for (; i < source.length; i++) {
			const ch = source[i];
			if (ch === "{") depth++;
			else if (ch === "}") depth--;
			else if (ch === '"') {
				const end = source.indexOf('"', i + 1);
				if (end === -1) break;
				i = end;
			} else if (ch === ">" && depth === 0) break;
		}
		const close = source.indexOf("</button>", i);
		buttons.push({
			attributes: source.slice(open, i),
			body: close === -1 ? "" : source.slice(i + 1, close),
		});
		from = close === -1 ? i : close + 1;
	}
}

test("the real Start button in WorkflowDetail carries the attribute the shortcut selects on", () => {
	const source = fs.readFileSync(path.join(UI_DIR, "views", "WorkflowDetail.tsx"), "utf8");

	// The attribute name comes from the selector, so renaming both together stays
	// green and dropping it from the button goes red.
	const attribute = START_BUTTON_SELECTOR.replace(/^\[|\]$/g, "");
	assert.match(attribute, /^data-[a-z-]+$/, "the selector is a plain data-attribute selector");

	// The run control is identified by what it does, not by its label: the same
	// button reads Start / Resume / Start over depending on the status, and the
	// shortcut is bound to all three (see lib/startShortcut.ts).
	const runControls = jsxButtons(source).filter((button) => button.attributes.includes("onClick={() => onStart("));
	assert.equal(runControls.length, 1, "WorkflowDetail renders exactly one run control");
	const [start] = runControls;
	assert.ok(
		start?.attributes.includes(attribute),
		`the Start button must carry ${attribute}, or Alt/Shift+S will find nothing to click`,
	);
	// It is the button the operator reads as Start, and the label is the computed
	// one rather than a literal — pinning both keeps "press what you see" true.
	assert.match(start?.body ?? "", /\{startLabel\}/);
	assert.match(source, /if \(startAction === "resume"\) return "Resume";/);
	// And its disabled state is what makes the shortcut inert when starting is
	// impossible: no action for this status, a mutation in flight, nothing picked.
	assert.match(start?.attributes ?? "", /disabled=\{!startAction \|\| busy \|\| selectedCount === 0\}/);
});

test("the shortcuts hook presses that button rather than calling the API itself", () => {
	const source = fs.readFileSync(path.join(UI_DIR, "hooks", "useKeyboardShortcuts.ts"), "utf8");

	assert.match(source, /from "\.\.\/lib\/startShortcut\.ts"/, "the hook imports the shortcut helper");
	assert.match(source, /pressStartButton\(/, "the hook presses the button");
	assert.match(source, /case "startWorkflow"/, "startWorkflow is a resolvable action");
	// Clicking the button is the whole design: the hook must not shortcut past it
	// into the API, which would skip the button's own handler, its choice of
	// start/resume/restart, and its busy-state.
	assert.doesNotMatch(source, /fetch\(|api\.runWorkflowAction/, "the hook never calls the start API directly");
});

test("the hook skips the Start shortcut in a text field, before it swallows the keystroke", () => {
	const source = fs.readFileSync(path.join(UI_DIR, "hooks", "useKeyboardShortcuts.ts"), "utf8");

	// The guard must name startWorkflow…
	const guard = source.indexOf('action === "startWorkflow"');
	assert.ok(guard !== -1, "the typing guard covers startWorkflow");
	assert.match(source.slice(guard, guard + 200), /isTypingTarget\(/, "…and it is the typing check");
	// …and run BEFORE preventDefault, so a capital S still types.
	const prevent = source.indexOf("ev.preventDefault()");
	assert.ok(prevent !== -1);
	assert.ok(guard < prevent, "the typing check must precede preventDefault, or the S is swallowed");
});

test("the Start shortcut is bound in the hub's defaults and configurable in Settings", async () => {
	const { defaultShortcutSettings } = await import("./db.ts");
	assert.equal(defaultShortcutSettings().bindings.startWorkflow.key, "s");

	// Settings has to offer the action, or the key could never be rebound.
	const settings = fs.readFileSync(path.join(UI_DIR, "views", "SettingsView.tsx"), "utf8");
	assert.match(settings, /startWorkflow: "/, "SHORTCUT_LABELS names the action");
	assert.match(settings, /"startWorkflow",/, "SHORTCUT_ORDER renders a field for it");
	assert.match(settings, /startWorkflow: \{ key: normalized\.startWorkflow \}/, "the Save sends it");
});
