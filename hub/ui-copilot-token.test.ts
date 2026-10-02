/**
 * The Copilot-in-Docker token UI: the pure rules (ui/src/lib/copilotToken.ts)
 * that decide what the panel says and when the create dialog may submit, plus
 * source-level guarantees that no UI file keeps, logs or renders a token.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import {
	GH_LOGIN_POLL_MS,
	GH_LOGIN_TIMEOUT_MS,
	asCopilotTokenRequired,
	describeTokenStatus,
	ghLoginFailureMessage,
	ghLoginPollOutcome,
	needsCopilotToken,
	tokenInfoLine,
	tokenSubmitBlock,
} from "./ui/src/lib/copilotToken.ts";

const DUMMY = "gho_dummyDummyDummyDummyDummyDummy1234";

type Status = Parameters<typeof describeTokenStatus>[0];
const status = (over: Partial<Status> = {}): Status => ({
	available: false,
	source: null,
	envName: null,
	tokenType: null,
	usable: false,
	warning: null,
	ghInstalled: true,
	ghLoggedIn: false,
	storedInSettings: false,
	...over,
});

const src = (rel: string) => fs.readFileSync(new URL(`./ui/src/${rel}`, import.meta.url), "utf8");

test("panel text: token not found", () => {
	const view = describeTokenStatus(status());
	assert.equal(view.tone, "missing");
	assert.equal(view.headline, "Copilot token: not found");
	assert.equal(view.warning, null);
	assert.equal(view.error, null);
});

test("panel text: found via each source, with the gh and unknown-type warnings", () => {
	const env = describeTokenStatus(status({ available: true, usable: true, source: "env", envName: "COPILOT_GITHUB_TOKEN", tokenType: "oauth" }));
	assert.equal(env.headline, "Copilot token: found (environment variable COPILOT_GITHUB_TOKEN)");
	assert.equal(env.tone, "ok");

	const saved = describeTokenStatus(status({ available: true, usable: true, source: "settings", tokenType: "fine-grained", storedInSettings: true }));
	assert.equal(saved.headline, "Copilot token: found (saved in Settings)");

	const gh = describeTokenStatus(
		status({ available: true, usable: true, source: "gh", tokenType: "oauth", warning: "gh tokens carry broader scopes (repo, workflow...); a fine-grained token with only the Copilot Requests permission is safer" }),
	);
	assert.equal(gh.headline, "Copilot token: found (GitHub CLI login)");
	assert.equal(gh.tone, "warn");
	assert.match(gh.warning ?? "", /broader scopes/);

	const unknown = describeTokenStatus(status({ available: true, usable: true, source: "env", envName: "GH_TOKEN", tokenType: "unknown", warning: "Unrecognised token format" }));
	assert.equal(unknown.tone, "warn");
	assert.equal(unknown.warning, "Unrecognised token format");
});

test("panel text: a classic ghp_ token is an error, not a success", () => {
	const view = describeTokenStatus(status({ available: true, usable: false, source: "env", envName: "GH_TOKEN", tokenType: "classic" }));
	assert.equal(view.tone, "error");
	assert.match(view.headline, /not usable/);
	assert.match(view.error ?? "", /not supported/);
});

test("the create dialog's submit waits for a usable token, only for copilot + docker", () => {
	assert.equal(needsCopilotToken("copilot", "docker"), true);
	assert.equal(needsCopilotToken("copilot", "host"), false);
	assert.equal(needsCopilotToken("claude", "docker"), false);

	assert.match(tokenSubmitBlock("copilot", "docker", status()) ?? "", /needs a GitHub token/);
	assert.match(tokenSubmitBlock("copilot", "docker", status({ available: true, tokenType: "classic" })) ?? "", /not supported/);
	assert.equal(tokenSubmitBlock("copilot", "docker", status({ available: true, usable: true, source: "env" })), null);
	assert.equal(tokenSubmitBlock("copilot", "host", status()), null);
	assert.equal(tokenSubmitBlock("claude", "docker", status()), null);
	// Unreadable / still-loading status never blocks: the server's 400 is the backstop.
	assert.equal(tokenSubmitBlock("copilot", "docker", null), null);

	assert.equal(tokenInfoLine(status()), null);
	assert.match(tokenInfoLine(status({ available: true, usable: true, source: "gh" })) ?? "", /found \(GitHub CLI login\)/);
});

test("the structured 400 is recognised by its error code, not by message text", () => {
	const payload = { error: "copilot_token_required", message: "needs a token", actions: ["gh-login", "paste-token"], status: status() };
	const err = Object.assign(new Error("copilot_token_required"), { status: 400, payload });
	const parsed = asCopilotTokenRequired(err);
	assert.equal(parsed?.error, "copilot_token_required");
	assert.equal(parsed?.message, "needs a token");
	assert.deepEqual(parsed?.actions, ["gh-login", "paste-token"]);
	assert.equal(asCopilotTokenRequired(Object.assign(new Error("x"), { status: 400, payload: { error: "other" } })), null);
	assert.equal(asCopilotTokenRequired(new Error("plain")), null);
	assert.equal(asCopilotTokenRequired(null), null);
});

test("gh login: failure messages and the poll loop", () => {
	assert.match(ghLoginFailureMessage({ status: 400, message: "gh_not_installed", payload: { message: "GitHub CLI (gh) is not installed. Install it from https://cli.github.com" } }), /not installed/);
	assert.match(ghLoginFailureMessage({ status: 409, message: "no terminal emulator found" }), /No terminal could be opened/);
	assert.match(ghLoginFailureMessage({ status: 501, message: "x" }), /No terminal could be opened/);
	assert.match(ghLoginFailureMessage({ status: 500, message: "boom" }), /boom/);

	assert.equal(GH_LOGIN_POLL_MS, 2000);
	assert.equal(GH_LOGIN_TIMEOUT_MS, 180_000);
	assert.equal(ghLoginPollOutcome(status(), 2000), "keep-waiting");
	assert.equal(ghLoginPollOutcome(null, 10_000), "keep-waiting");
	assert.equal(ghLoginPollOutcome(status({ available: true, usable: true }), 4000), "found");
	assert.equal(ghLoginPollOutcome(status(), GH_LOGIN_TIMEOUT_MS), "timeout");
});

test("no status text the UI builds can contain a token", () => {
	for (const s of [status({ available: true, usable: true, source: "env", envName: "COPILOT_GITHUB_TOKEN" }), status({ available: true, source: "gh", usable: true }), status()]) {
		assert.equal(JSON.stringify(describeTokenStatus(s)).includes(DUMMY), false);
	}
});

test("create dialog wiring: panel only for copilot+docker, submit gate, structured-error branch, clone shares it", () => {
	const modal = src("views/CreateWorkflowModal.tsx");
	assert.ok(modal.includes("needsCopilotToken(runner, sandbox) &&"), "panel gated on copilot + docker");
	assert.ok(modal.includes("tokenBlock === null &&"), "submit gated on the token rule");
	assert.ok(modal.includes("setTokenNotice(refused.message)"), "the server message opens the panel");
	assert.equal(modal.match(/const refused = await on(Create|Clone)\(input\)/g)?.length, 2, "create and clone both branch on it");
	const app = src("App.tsx");
	assert.ok(app.includes("asCopilotTokenRequired(err)") && app.includes("new HandledError"), "App hands the structured 400 to the dialog without a toast");
	assert.ok(app.includes("if (!(err instanceof HandledError)) reportError"));
});

test("Settings has a 'Copilot in Docker' card using the same panel", () => {
	const settings = src("views/SettingsView.tsx");
	assert.ok(settings.includes("Copilot in Docker"));
	assert.ok(settings.includes("<CopilotTokenPanel"));
	assert.match(settings, /file mode 600/);
});

test("the panel offers the four actions and a password field for pasting", () => {
	const panel = src("components/CopilotTokenPanel.tsx");
	for (const label of ["Sign in with GitHub CLI", "Paste a token", "Check again", "Remove saved token", "Stop waiting"]) {
		assert.ok(panel.includes(label), label);
	}
	assert.ok(panel.includes('type="password"'));
	assert.ok(panel.includes("GH_LOGIN_POLL_MS"));
});

test("audit: the new UI files never store, log or echo a token", () => {
	const noComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
	// Files that exist only for this feature: no persistence, no logging at all.
	for (const f of ["components/CopilotTokenPanel.tsx", "components/CopilotTokenPanel.module.css", "lib/copilotToken.ts"]) {
		const code = noComments(src(f));
		assert.equal(/localStorage|sessionStorage|document\.cookie|indexedDB/.test(code), false, `${f} must not persist anything`);
		assert.equal(/console\./.test(code), false, `${f} must not log`);
	}
	// The client functions added for it: no console, no token in a URL.
	const client = src("api/client.ts");
	const added = noComments(client.slice(client.indexOf("// --- Copilot token"), client.indexOf("Sends a one-shot Slack connection-test")));
	assert.equal(/console\./.test(added), false);
	assert.equal(/\?token=|token=\$\{|\$\{token\}/.test(added.replace(/body: json\(\{ token \}\)/, "")), false, "the token travels only in the PUT body");
	assert.ok(added.includes("body: json({ token })"));

	const panel = noComments(src("components/CopilotTokenPanel.tsx"));
	// The pasted value is cleared whether the PUT worked or not...
	assert.ok(/finally \{[^}]*setPasted\(""\)/.test(panel));
	// ...and is only ever the input's value or the argument of the save call: never rendered as text.
	assert.equal(/>\s*\{pasted\}\s*</.test(panel), false);
	for (const m of panel.matchAll(/\bpasted\b/g)) {
		const around = panel.slice(Math.max(0, m.index! - 22), m.index! + 16);
		assert.ok(/\[pasted, setPasted\]|value=\{pasted\}|pasted\.trim\(\)|setPasted\(|const \[pasted/.test(around), `unexpected use of pasted: ${around}`);
	}
	// The status is rendered only through describeTokenStatus' strings.
	assert.ok(panel.includes("describeTokenStatus(status)") && panel.includes("{view.headline}"));
});
