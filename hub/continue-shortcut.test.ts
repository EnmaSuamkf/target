/**
 * Tests for the Continue shortcut (Alt/Shift+C): the keystroke that presses the
 * Continue button of a step held at its manual-review gate.
 *
 * The feature is deliberately built as "click the button that is already
 * there" (see hub/ui/src/lib/continueShortcut.ts), so it is verified in three
 * layers, each covering what the one below it can't:
 *
 *  1. **The press.** `pressContinueButton` clicks the first ENABLED
 *     `[data-continue-step]` button and reports whether it found one — so with
 *     no step waiting (no button) or a continue already in flight (a disabled
 *     one) the combo is inert rather than firing a request the server refuses.
 *  2. **What the press does.** A real workflow with a real manual-review step,
 *     run until it holds at `waiting`, then pressed through a stub button whose
 *     click does exactly what the UI's onClick does (POST
 *     /api/workflows/:id/steps/:stepId/continue against the real hub server).
 *     The gate releases, the step goes `done`, the next step is dispatched.
 *  3. **The wiring.** Layers 1 and 2 both press a *stub* button, because there
 *     is no DOM in this suite — so on its own they'd still pass if the real
 *     button silently lost the `data-continue-step` attribute the shortcut
 *     looks for. The last two tests read StepItem.tsx and the hook and pin that
 *     seam down: the button labelled "Continue" must carry the attribute
 *     `CONTINUE_BUTTON_SELECTOR` selects on, and the hook must actually call
 *     the helper.
 *
 * Same throwaway-TARGET_HOME + fake-awb-hook convention as manual-review.test.ts.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-continue-shortcut-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;
process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, "claude");

const { getStep, getWorkflow, insertStep, insertWorkflow } = await import("./db.ts");
const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");
const { onStepResult, startWorkflow } = await import("./workflow.ts");
const { CONTINUE_BUTTON_SELECTOR, isTypingTarget, pressContinueButton } = await import(
	"./ui/src/lib/continueShortcut.ts"
);

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

/**
 * A workflow whose first step is flagged for manual review — the situation the
 * shortcut exists for — with a plain second step behind the gate so "the run
 * carried on" is observable.
 */
function makeGatedWorkflow(hookUrl: string) {
	const id = `wf-${++seq}`;
	const workflow = insertWorkflow({
		id,
		name: `continue shortcut ${id}`,
		agentName: `agent-${id}`,
		hookUrl,
		secret: "s3cret",
		mdPath: path.join(tmpHome, `${id}.md`),
		conversationContext: null,
	});
	const gated = insertStep(id, "the step a human has to sign off", { manualReview: true });
	const next = insertStep(id, "what runs once they do", {});
	return { workflow, gated, next };
}

/** The stub the shortcut clicks, standing in for StepItem's Continue button. */
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
		querySelectorAll: (selector: string): StubButton[] => (selector === CONTINUE_BUTTON_SELECTOR ? buttons : []),
	};
}

/** What App.tsx's handleContinueStep does, minus the toast and the refresh. */
function continueRequest(workflowId: string, stepId: string): Promise<Response> {
	return fetch(`${baseUrl}/api/workflows/${workflowId}/steps/${stepId}/continue`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}` },
	});
}

// --- the whole path: a workflow, a manual review, and the keystroke ------

test("the shortcut presses a held step's Continue button, releasing the gate and resuming the run", async (t) => {
	const url = await hook(t);
	const { workflow, gated, next } = makeGatedWorkflow(url);

	// Run it until the gate holds — this is the state the operator finds.
	await startWorkflow(workflow.id, cfg, silent, [gated.id, next.id]);
	await onStepResult(gated.id, { ok: true, result: "the work", sessionId: "sess-1" }, cfg, silent);
	assert.equal(getStep(gated.id)?.status, "waiting", "the step is held at its manual-review gate");
	assert.equal(getWorkflow(workflow.id)?.status, "waiting");
	assert.equal(getStep(next.id)?.status, "pending", "nothing moves while it waits");

	// The button the UI renders while the gate holds, wired to the same request
	// its onClick makes. Clicking is synchronous, so the requests it starts are
	// collected and awaited after the press.
	const requests: Promise<Response>[] = [];
	const button = stubButton({ onClick: () => requests.push(continueRequest(workflow.id, gated.id)) });

	// The keystroke.
	const pressed = pressContinueButton(stubRoot([button]));

	assert.equal(pressed, true, "the shortcut found a Continue button to press");
	assert.equal(button.clicks, 1, "it was a real click on that button, once");
	assert.equal(requests.length, 1, "the click started exactly one continue request");
	const [res] = await Promise.all(requests);
	assert.equal(res?.status, 200);

	// The gate released, exactly as if the button had been clicked with a mouse.
	assert.equal(getStep(gated.id)?.status, "done");
	assert.equal(getStep(gated.id)?.result, "the work", "approving keeps the work it approved");
	assert.equal(getStep(next.id)?.status, "queued", "the step behind the gate was dispatched");
	assert.equal(getWorkflow(workflow.id)?.status, "running");
});

test("with nothing waiting there is no button, so the shortcut does nothing at all", async (t) => {
	const url = await hook(t);
	const { workflow, gated, next } = makeGatedWorkflow(url);

	// A run in flight, no gate reached: StepItem renders no Continue button.
	await startWorkflow(workflow.id, cfg, silent, [gated.id, next.id]);
	const before = getStep(gated.id)?.status;

	assert.equal(pressContinueButton(stubRoot([])), false);

	// No request was made, so nothing about the workflow changed.
	assert.equal(getStep(gated.id)?.status, before);
	assert.equal(getStep(next.id)?.status, "pending");
	assert.notEqual(getWorkflow(workflow.id)?.status, "waiting");
});

test("a disabled Continue button — a continue already in flight — is not pressed", () => {
	const button = stubButton({ disabled: true, onClick: () => assert.fail("a disabled button must not be clicked") });
	assert.equal(pressContinueButton(stubRoot([button])), false);
	assert.equal(button.clicks, 0);
});

test("with a disabled and an enabled button on screen, the enabled one is pressed", () => {
	const disabled = stubButton({ disabled: true });
	const enabled = stubButton();
	assert.equal(pressContinueButton(stubRoot([disabled, enabled])), true);
	assert.equal(disabled.clicks, 0);
	assert.equal(enabled.clicks, 1);
});

test("only the first enabled button is pressed — one keystroke is one click", () => {
	const first = stubButton();
	const second = stubButton();
	pressContinueButton(stubRoot([first, second]));
	assert.equal(first.clicks, 1);
	assert.equal(second.clicks, 0);
});

// --- the typing guard ---------------------------------------------------

test("keystrokes aimed at a text field are typing, not the shortcut", () => {
	// Shift+C is how a capital C is typed: approving a held step because someone
	// wrote "Continue" into a description is the failure this prevents.
	assert.equal(isTypingTarget({ tagName: "INPUT" }), true);
	assert.equal(isTypingTarget({ tagName: "TEXTAREA" }), true);
	assert.equal(isTypingTarget({ tagName: "SELECT" }), true);
	assert.equal(isTypingTarget({ tagName: "DIV", isContentEditable: true }), true);
	// Lowercase too — tagName is uppercase in HTML documents, but not in XML ones.
	assert.equal(isTypingTarget({ tagName: "input" }), true);
});

test("keystrokes anywhere else are the shortcut", () => {
	assert.equal(isTypingTarget({ tagName: "BODY" }), false);
	assert.equal(isTypingTarget({ tagName: "BUTTON" }), false);
	assert.equal(isTypingTarget({ tagName: "DIV", isContentEditable: false }), false);
	assert.equal(isTypingTarget(null), false);
	assert.equal(isTypingTarget(undefined), false);
});

// --- the seam: the REAL button carries what the shortcut selects on ------
//
// Everything above presses a stub, so on its own it would stay green if the
// real button lost the attribute and the shortcut quietly stopped finding
// anything. There is no DOM here to render StepItem into (no jsdom, and it
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

test("the real Continue button in StepItem carries the attribute the shortcut selects on", () => {
	const source = fs.readFileSync(path.join(UI_DIR, "views", "StepItem.tsx"), "utf8");

	// The attribute name comes from the selector, so renaming both together stays
	// green and dropping it from the button goes red.
	const attribute = CONTINUE_BUTTON_SELECTOR.replace(/^\[|\]$/g, "");
	assert.match(attribute, /^data-[a-z-]+$/, "the selector is a plain data-attribute selector");

	const labelled = jsxButtons(source).filter((button) => button.body.trim() === "Continue");
	assert.equal(labelled.length, 1, "StepItem renders exactly one button labelled Continue");
	assert.ok(
		labelled[0]?.attributes.includes(attribute),
		`the Continue button must carry ${attribute}, or Alt/Shift+C will find nothing to click`,
	);
	// And it must be the button that releases the gate, not some other Continue.
	assert.match(labelled[0]?.attributes ?? "", /onContinue\(step\.id\)/);
});

test("the shortcuts hook presses that button rather than calling the API itself", () => {
	const source = fs.readFileSync(path.join(UI_DIR, "hooks", "useKeyboardShortcuts.ts"), "utf8");

	assert.match(source, /from "\.\.\/lib\/continueShortcut\.ts"/, "the hook imports the shortcut helper");
	assert.match(source, /pressContinueButton\(/, "the hook presses the button");
	assert.match(source, /case "continueStep"/, "continueStep is a resolvable action");
	assert.match(source, /isTypingTarget\(/, "the typing guard is applied");
	// Clicking the button is the whole design: the hook must not shortcut past it
	// into the API, which would skip the button's own handler and busy-state.
	assert.doesNotMatch(source, /fetch\(|api\.continueStep/, "the hook never calls the continue API directly");
});
