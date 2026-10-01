/**
 * Tests for the manual-review notification (notifier.ts), and — at the end —
 * the schedule notices (D11): the messages themselves, and the scheduler
 * sending them for missed, skipped, broken and failed scheduled runs while a
 * failed NON-scheduled workflow still sends nothing.
 *
 * Two halves, both offline:
 *
 *  - `sendManualReviewNotification`, driven through the `_impl` seam, must land
 *    on exactly one of its five outcomes and must NEVER throw — the engine calls
 *    it right after a step has entered `waiting`, and an exception there would
 *    take the workflow down over a message.
 *  - `detectSlackMcp`, driven against a throwaway `CLAUDE_CONFIG_DIR`, must be
 *    conservative: it answers an endpoint only for a credential that really is a
 *    logged-in, unexpired Slack MCP, and null for everything else. Anything
 *    looser would produce case 4 ("attempt the send") for a Slack that isn't
 *    there.
 *
 * Nothing here touches the network, a real Slack workspace, or the operator's
 * real ~/.claude: `_impl.send` is always a local stub, and the credential store
 * is a file this suite writes itself.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-notifier-"));
process.env.TARGET_HOME = tmpHome;
// Isolate awb too (defensive — keep test hooks out of the real broker).
process.env.AWB_HOME = tmpHome;
// The credential store detectSlackMcp reads. Set before anything imports the
// notifier so no test can fall back to the operator's real ~/.claude.
const configDir = path.join(tmpHome, "claude");
process.env.CLAUDE_CONFIG_DIR = configDir;
fs.mkdirSync(configDir, { recursive: true });
// The client-token transport reads the environment, and the machine running the
// suite may well have a real Slack session exported (that is the whole point of
// accepting the SLACK_MCP_* names). Clear every accepted name so "no transport"
// tests are testing the code and not the developer's shell.
for (const suffix of ["XOXC", "XOXD"]) {
	for (const prefix of ["TARGET_SLACK_", "SLACK_MCP_", "SLACK_"]) delete process.env[`${prefix}${suffix}_TOKEN`];
}

const { open, saveNotificationSettings, saveSlackDeliverySettings } = await import("./db.ts");
const {
	_impl,
	detectSlackClientTokens,
	detectSlackMcp,
	manualReviewMessage,
	resolveSlackTransports,
	sendManualReviewNotification,
	sendTestNotification,
} = await import("./notifier.ts");
type SlackTransport = Awaited<ReturnType<typeof resolveSlackTransports>>[number];

const notice = {
	workflowName: "release 1.4",
	stepNumber: 3,
	stepDescription: "cut the release branch",
	reason: "this step has Manual review enabled, so its result needs your approval",
};

/** Swaps `_impl` for the duration of one test and records what `send` was given. */
function stubImpl(
	t: { after: (fn: () => void) => void },
	overrides: { detect?: typeof _impl.detect; send?: typeof _impl.send } = {},
) {
	const originalDetect = _impl.detect;
	const originalSend = _impl.send;
	t.after(() => {
		_impl.detect = originalDetect;
		_impl.send = originalSend;
	});
	const calls = { detect: 0, send: [] as { username: string; message: string; transport: SlackTransport }[] };
	_impl.detect = () => {
		calls.detect++;
		return overrides.detect ? overrides.detect() : [];
	};
	_impl.send = async (transport, username, message) => {
		calls.send.push({ username, message, transport });
		if (overrides.send) await overrides.send(transport, username, message);
	};
	return calls;
}

const endpoint = { serverName: "plugin:slack:slack", serverUrl: "https://mcp.slack.com/mcp", accessToken: "tok-123" };
const clientTokens = { xoxc: "xoxc-abc", xoxd: "xoxd-def" };

/** Writes the credential store detectSlackMcp reads (or removes it entirely). */
function writeCredentials(contents: unknown | null): void {
	const file = path.join(configDir, ".credentials.json");
	if (contents === null) {
		fs.rmSync(file, { force: true });
		return;
	}
	fs.writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents));
}

// --- the five notification cases ---------------------------------------

test("case 1: with notifications disabled nothing is sent and nothing is even looked up", async (t) => {
	saveNotificationSettings({ enabled: false, channels: { slack: { username: "ada" } } });
	const calls = stubImpl(t, { detect: () => [endpoint] });

	const result = await sendManualReviewNotification(notice);

	assert.deepEqual(result, { sent: false, reason: "notifications-disabled" });
	assert.equal(calls.send.length, 0);
	// The master switch is decided first: a disabled hub never even asks whether
	// Slack is available.
	assert.equal(calls.detect, 0);
});

test("case 2: enabled with no Slack username sends nothing", async (t) => {
	saveNotificationSettings({ enabled: true, channels: { slack: { username: "" } } });
	const calls = stubImpl(t, { detect: () => [endpoint] });

	const result = await sendManualReviewNotification(notice);

	assert.deepEqual(result, { sent: false, reason: "no-slack-username" });
	assert.equal(calls.send.length, 0);
	assert.equal(calls.detect, 0);
});

test("case 2: a whitespace-only username counts as none", async (t) => {
	// saveNotificationSettings trims on the way in, so this is stored as "" — the
	// point is that "   " can never reach the send as a Slack handle.
	saveNotificationSettings({ enabled: true, channels: { slack: { username: "   " } } });
	const calls = stubImpl(t, { detect: () => [endpoint] });

	const result = await sendManualReviewNotification(notice);

	assert.deepEqual(result, { sent: false, reason: "no-slack-username" });
	assert.equal(calls.send.length, 0);
});

test("case 3: with a username but no way to reach Slack at all, nothing is sent", async (t) => {
	saveNotificationSettings({ enabled: true, channels: { slack: { username: "ada" } } });
	const calls = stubImpl(t); // detect answers no transports

	const result = await sendManualReviewNotification(notice);

	assert.deepEqual(result, { sent: false, reason: "no-transport" });
	assert.equal(calls.detect, 1);
	assert.equal(calls.send.length, 0);
});

test("case 4: fully configured, the message is sent once to the configured user", async (t) => {
	saveNotificationSettings({ enabled: true, channels: { slack: { username: "@ada" } } });
	const calls = stubImpl(t, { detect: () => [endpoint] });

	const result = await sendManualReviewNotification(notice);

	assert.deepEqual(result, { sent: true });
	assert.equal(calls.send.length, 1);
	assert.equal(calls.send[0].username, "@ada");
	assert.deepEqual(calls.send[0].transport, endpoint);
	// The message has to stand on its own: which workflow, which step, why.
	const message = calls.send[0].message;
	assert.match(message, /release 1\.4/);
	assert.match(message, /Step 3:/);
	assert.match(message, /cut the release branch/);
	assert.match(message, /needs your approval/);
});

test("case 5: a send that throws is swallowed and reported, never rethrown", async (t) => {
	saveNotificationSettings({ enabled: true, channels: { slack: { username: "ada" } } });
	const calls = stubImpl(t, {
		detect: () => [endpoint],
		send: async () => {
			throw new Error("slack said no");
		},
	});

	const result = await sendManualReviewNotification(notice);

	// The `detail` is Slack's own words, carried so a log line can say WHY.
	assert.deepEqual(result, { sent: false, reason: "send-failed", detail: "slack said no" });
	assert.equal(calls.send.length, 1); // it really was attempted
});

test("a detector that throws is treated as a failure, not as an exception", async (t) => {
	saveNotificationSettings({ enabled: true, channels: { slack: { username: "ada" } } });
	stubImpl(t, {
		detect: () => {
			throw new Error("unreadable credentials");
		},
	});

	const result = await sendManualReviewNotification(notice);

	assert.deepEqual(result, { sent: false, reason: "send-failed", detail: "unreadable credentials" });
});

test("even a settings read that blows up cannot throw into the engine", async (t) => {
	saveNotificationSettings({ enabled: true, channels: { slack: { username: "ada" } } });
	const calls = stubImpl(t, { detect: () => [endpoint] });

	// Pull the settings table out from under it — the harshest version of "the
	// preferences could not be read". A second connection to the same file, so
	// db.ts's own handle sees the change.
	const raw = new DatabaseSync(path.join(tmpHome, "target.db"));
	raw.exec("DROP TABLE settings;");
	t.after(() => {
		raw.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);");
		raw.close();
	});

	const result = await sendManualReviewNotification(notice);

	assert.equal(result.sent, false);
	assert.equal(result.sent === false && result.reason, "send-failed");
	assert.equal(calls.send.length, 0);
});

test("manualReviewMessage names the workflow, the step and the reason", () => {
	const message = manualReviewMessage(notice);
	assert.match(message, /Manual review needed/);
	assert.match(message, /release 1\.4/);
	assert.match(message, /\*Step 3:\* cut the release branch/);
	assert.match(message, /needs your approval/);
	// It has to say what unblocks it, since the recipient may not have the UI open.
	assert.match(message, /Continue/);
});

// --- more than one transport -------------------------------------------
//
// The order (client tokens first) and the fallthrough are the whole point of
// `detect` answering a LIST, so both are pinned here rather than left to the
// integration suites.

test("the first transport that succeeds is the only one used", async (t) => {
	saveNotificationSettings({ enabled: true, channels: { slack: { username: "ada" } } });
	const calls = stubImpl(t, { detect: () => [clientTokens, endpoint] });

	assert.deepEqual(await sendManualReviewNotification(notice), { sent: true });
	assert.equal(calls.send.length, 1);
	assert.deepEqual(calls.send[0].transport, clientTokens);
});

test("a transport that fails falls through to the next one", async (t) => {
	saveNotificationSettings({ enabled: true, channels: { slack: { username: "ada" } } });
	// The realistic version of this: an `xoxd` cookie that expired overnight,
	// with the Slack MCP still logged in behind it.
	const calls = stubImpl(t, {
		detect: () => [clientTokens, endpoint],
		send: async (transport) => {
			if ("xoxc" in transport) throw new Error("chat.postMessage: invalid_auth");
		},
	});

	assert.deepEqual(await sendManualReviewNotification(notice), { sent: true });
	assert.equal(calls.send.length, 2);
	assert.deepEqual(calls.send[1].transport, endpoint);
	// Both attempts carry the SAME text — a fallthrough re-sends, it never recomposes.
	assert.equal(calls.send[0].message, calls.send[1].message);
});

test("only when every transport fails is the notification lost, and the first failure is what's reported", async (t) => {
	saveNotificationSettings({ enabled: true, channels: { slack: { username: "ada" } } });
	const calls = stubImpl(t, {
		detect: () => [clientTokens, endpoint],
		send: async (transport) => {
			throw new Error("xoxc" in transport ? "chat.postMessage: invalid_auth" : "mcp is down");
		},
	});

	const result = await sendManualReviewNotification(notice);

	// The first failure, not the last: it comes from the transport the operator
	// deliberately configured, so it's the one worth acting on.
	assert.deepEqual(result, { sent: false, reason: "send-failed", detail: "chat.postMessage: invalid_auth" });
	assert.equal(calls.send.length, 2);
});

// --- detectSlackClientTokens --------------------------------------------

/** Sets (or clears) one accepted client-token variable for the duration of a test. */
function withEnv(t: { after: (fn: () => void) => void }, vars: Record<string, string | undefined>): void {
	const original = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
	t.after(() => {
		for (const [k, v] of original) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});
	for (const [k, v] of Object.entries(vars)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
}

test("no client tokens in the environment means no client transport", () => {
	assert.equal(detectSlackClientTokens(), null);
});

test("half a pair is not a transport", (t) => {
	// Slack rejects either one alone, so accepting a lone xoxc would only produce
	// a guaranteed-failing send.
	withEnv(t, { TARGET_SLACK_XOXC_TOKEN: "xoxc-abc" });
	assert.equal(detectSlackClientTokens(), null);
});

test("a complete pair is a transport", (t) => {
	withEnv(t, { TARGET_SLACK_XOXC_TOKEN: "xoxc-abc", TARGET_SLACK_XOXD_TOKEN: "xoxd-def" });
	assert.deepEqual(detectSlackClientTokens(), { xoxc: "xoxc-abc", xoxd: "xoxd-def" });
});

test("the names a third-party Slack MCP already uses are accepted", (t) => {
	// So the secret lives in one place instead of two copies that drift apart.
	withEnv(t, { SLACK_MCP_XOXC_TOKEN: "xoxc-mcp", SLACK_MCP_XOXD_TOKEN: "xoxd-mcp" });
	assert.deepEqual(detectSlackClientTokens(), { xoxc: "xoxc-mcp", xoxd: "xoxd-mcp" });
});

test("the TARGET_-prefixed names win over the others", (t) => {
	withEnv(t, {
		TARGET_SLACK_XOXC_TOKEN: "xoxc-target",
		TARGET_SLACK_XOXD_TOKEN: "xoxd-target",
		SLACK_XOXC_TOKEN: "xoxc-bare",
		SLACK_XOXD_TOKEN: "xoxd-bare",
	});
	assert.deepEqual(detectSlackClientTokens(), { xoxc: "xoxc-target", xoxd: "xoxd-target" });
});

test("a blank variable counts as unset, so it can't shadow a name set further down", (t) => {
	withEnv(t, {
		TARGET_SLACK_XOXC_TOKEN: "   ",
		TARGET_SLACK_XOXD_TOKEN: "",
		SLACK_XOXC_TOKEN: "xoxc-bare",
		SLACK_XOXD_TOKEN: "xoxd-bare",
	});
	assert.deepEqual(detectSlackClientTokens(), { xoxc: "xoxc-bare", xoxd: "xoxd-bare" });
});


/** Clears stored Slack delivery Settings so env-fallback tests stay isolated. */
function clearSlackDeliverySettings(): void {
	open().prepare("DELETE FROM settings WHERE key = ?").run("slack_delivery");
}

test("Settings-stored tokens win over the environment after the first save", (t) => {
	clearSlackDeliverySettings();
	t.after(clearSlackDeliverySettings);
	withEnv(t, {
		TARGET_SLACK_XOXC_TOKEN: "xoxc-env",
		TARGET_SLACK_XOXD_TOKEN: "xoxd-env",
	});
	saveSlackDeliverySettings({ xoxcToken: "xoxc-settings", xoxdToken: "xoxd-settings" });
	assert.deepEqual(detectSlackClientTokens(), { xoxc: "xoxc-settings", xoxd: "xoxd-settings" });
});

test("without a Settings save, the existing env chain still supplies tokens", (t) => {
	clearSlackDeliverySettings();
	t.after(clearSlackDeliverySettings);
	withEnv(t, {
		TARGET_SLACK_XOXC_TOKEN: "xoxc-env-only",
		TARGET_SLACK_XOXD_TOKEN: "xoxd-env-only",
	});
	assert.deepEqual(detectSlackClientTokens(), { xoxc: "xoxc-env-only", xoxd: "xoxd-env-only" });
});

test("an incomplete Settings pair does not fall through to env (both halves required)", (t) => {
	clearSlackDeliverySettings();
	t.after(clearSlackDeliverySettings);
	withEnv(t, {
		TARGET_SLACK_XOXC_TOKEN: "xoxc-env",
		TARGET_SLACK_XOXD_TOKEN: "xoxd-env",
	});
	// Write a saved row with only one half — empty on purpose, so Settings "won"
	// and must not leak back to `.env` for the missing half.
	open()
		.prepare(
			`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		)
		.run(
			"slack_delivery",
			JSON.stringify({ xoxcToken: "xoxc-only", xoxdToken: "" }),
			new Date().toISOString(),
		);
	assert.equal(detectSlackClientTokens(), null);
});

test("notifier source does not interpolate client token values into log strings", () => {
	// Guardrail: HTTP Authorization/Cookie headers may carry tokens, but log /
	// detail template strings must not. Scan the module text for dangerous
	// interpolations of the token fields into messages.
	const src = fs.readFileSync(new URL("./notifier.ts", import.meta.url), "utf8");
	assert.equal(/\blog\([^)]*xox[cd]/.test(src), false);
	assert.equal(/detail:[^\n]*\$\{[^}]*xox[cd]/.test(src), false);
	assert.equal(/\bconsole\.\w+\([^)]*xox[cd]/.test(src), false);
	// Failure `detail` is Slack's own error code / Error.message — never our secrets.
	assert.match(src, /authorization: `Bearer \$\{tokens\.xoxc\}`/);
	assert.match(src, /cookie: `d=\$\{tokens\.xoxd\}`/);
});



// --- resolveSlackTransports ---------------------------------------------

test("with nothing configured there are no transports at all", () => {
	writeCredentials(null);
	assert.deepEqual(resolveSlackTransports(), []);
});

test("client tokens come before the MCP login", (t) => {
	writeCredentials({
		mcpOAuth: { "plugin:slack:slack|abc": { serverUrl: "https://mcp.slack.com/mcp", accessToken: "tok" } },
	});
	withEnv(t, { TARGET_SLACK_XOXC_TOKEN: "xoxc-abc", TARGET_SLACK_XOXD_TOKEN: "xoxd-def" });

	// Explicit configuration outranks an ambient `/mcp` login that may be months old.
	assert.deepEqual(resolveSlackTransports(), [
		{ xoxc: "xoxc-abc", xoxd: "xoxd-def" },
		{ serverName: "plugin:slack:slack|abc", serverUrl: "https://mcp.slack.com/mcp", accessToken: "tok" },
	]);
});

// --- detectSlackMcp -----------------------------------------------------

test("no credentials file at all means the Slack MCP cannot be confirmed", () => {
	writeCredentials(null);
	assert.equal(detectSlackMcp(), null);
});

test("an unreadable/malformed credentials file means unavailable, not a crash", () => {
	writeCredentials("{ this is not json");
	assert.equal(detectSlackMcp(), null);
});

test("a credentials file with no mcpOAuth section means unavailable", () => {
	writeCredentials({ claudeAiOauth: { accessToken: "irrelevant" } });
	assert.equal(detectSlackMcp(), null);
});

test("a credential store with no Slack server means unavailable", () => {
	writeCredentials({
		mcpOAuth: {
			"plugin:github:github|abc": { serverUrl: "https://mcp.github.com/mcp", accessToken: "tok" },
			// A name that merely CONTAINS "slack" is not the Slack MCP.
			"notslackish|def": { serverUrl: "https://example.com/mcp", accessToken: "tok" },
		},
	});
	assert.equal(detectSlackMcp(), null);
});

test("a Slack entry without an access token is not a login we can use", () => {
	writeCredentials({ mcpOAuth: { "plugin:slack:slack|abc": { serverUrl: "https://mcp.slack.com/mcp" } } });
	assert.equal(detectSlackMcp(), null);
});

test("a Slack entry without a server URL is not something we can call", () => {
	writeCredentials({ mcpOAuth: { "plugin:slack:slack|abc": { accessToken: "tok" } } });
	assert.equal(detectSlackMcp(), null);
});

test("an expired Slack token is not a login we can use", () => {
	writeCredentials({
		mcpOAuth: {
			"plugin:slack:slack|abc": {
				serverUrl: "https://mcp.slack.com/mcp",
				accessToken: "tok",
				expiresAt: Date.now() - 60_000,
			},
		},
	});
	assert.equal(detectSlackMcp(), null);
});

test("the official plugin's key shape resolves to the endpoint", () => {
	writeCredentials({
		mcpOAuth: {
			"plugin:slack:slack|9f8e7d": {
				serverUrl: "https://mcp.slack.com/mcp",
				accessToken: "tok-plugin",
				expiresAt: Date.now() + 3_600_000,
			},
		},
	});
	assert.deepEqual(detectSlackMcp(), {
		// No `serverName` in the entry, so the key stands in for it (logs only).
		serverName: "plugin:slack:slack|9f8e7d",
		serverUrl: "https://mcp.slack.com/mcp",
		accessToken: "tok-plugin",
	});
});

test("a hand-configured server named just `slack` resolves too", () => {
	writeCredentials({
		mcpOAuth: {
			slack: { serverName: "slack", serverUrl: "https://mcp.slack.com/mcp", accessToken: "tok-manual" },
		},
	});
	// No `expiresAt` at all: nothing says it's stale, so it's accepted.
	assert.deepEqual(detectSlackMcp(), {
		serverName: "slack",
		serverUrl: "https://mcp.slack.com/mcp",
		accessToken: "tok-manual",
	});
});

test("a usable Slack entry is found even alongside other servers", () => {
	writeCredentials({
		mcpOAuth: {
			"plugin:github:github|abc": { serverUrl: "https://mcp.github.com/mcp", accessToken: "gh" },
			"plugin:slack:slack|abc": {
				serverUrl: "https://mcp.slack.com/mcp",
				accessToken: "tok",
				expiresAt: Date.now() + 3_600_000,
			},
		},
	});
	assert.equal(detectSlackMcp()?.accessToken, "tok");
});

test("the real detector is what sendManualReviewNotification uses by default", async () => {
	// Belt and braces on the seam itself: with the credential store empty, the
	// unstubbed path reports case 3 rather than attempting anything.
	saveNotificationSettings({ enabled: true, channels: { slack: { username: "ada" } } });
	writeCredentials(null);

	assert.deepEqual(await sendManualReviewNotification(notice), { sent: false, reason: "no-transport" });
});

// --- sendTestNotification (Settings → Test connection) --------------------

test("sendTestNotification: missing username → no-slack-username", async (t) => {
	saveNotificationSettings({ enabled: true, channels: { slack: { username: "" } } });
	const calls = stubImpl(t, { detect: () => [clientTokens] });

	assert.deepEqual(await sendTestNotification(), { sent: false, reason: "no-slack-username" });
	assert.deepEqual(await sendTestNotification({ username: "   " }), {
		sent: false,
		reason: "no-slack-username",
	});
	assert.equal(calls.detect, 0);
	assert.equal(calls.send.length, 0);
});

test("sendTestNotification: no transport → no-transport", async (t) => {
	saveNotificationSettings({ enabled: true, channels: { slack: { username: "ada" } } });
	const calls = stubImpl(t);

	assert.deepEqual(await sendTestNotification(), { sent: false, reason: "no-transport" });
	assert.equal(calls.detect, 1);
	assert.equal(calls.send.length, 0);
});

test("sendTestNotification: mocked send success → sent:true", async (t) => {
	saveNotificationSettings({ enabled: true, channels: { slack: { username: "ada" } } });
	const calls = stubImpl(t, { detect: () => [clientTokens] });

	assert.deepEqual(await sendTestNotification({ username: "ada-draft" }), { sent: true });
	assert.equal(calls.send.length, 1);
	assert.equal(calls.send[0]!.username, "ada-draft");
	assert.match(calls.send[0]!.message, /Slack connection test succeeded/);
});

test("sendTestNotification: send throw → send-failed with detail", async (t) => {
	saveNotificationSettings({ enabled: true, channels: { slack: { username: "ada" } } });
	const calls = stubImpl(t, {
		detect: () => [clientTokens],
		send: async () => {
			throw new Error("chat.postMessage: invalid_auth");
		},
	});

	assert.deepEqual(await sendTestNotification({ username: "ada" }), {
		sent: false,
		reason: "send-failed",
		detail: "chat.postMessage: invalid_auth",
	});
	assert.equal(calls.send.length, 1);
});

test("sendTestNotification: enabled=false still sends when transports work", async (t) => {
	// Real notifications refuse this; Test connection must not — the operator asked.
	saveNotificationSettings({ enabled: false, channels: { slack: { username: "ada" } } });
	const calls = stubImpl(t, { detect: () => [clientTokens] });

	assert.deepEqual(await sendTestNotification(), { sent: true });
	assert.equal(calls.send.length, 1);
	assert.equal(calls.send[0]!.username, "ada");
});

// --- schedule notices (D11) ------------------------------------------------------

const http = await import("node:http");
const { completeStep, getWorkflow, insertStep, insertWorkflow, listNotices, listSteps, setWorkflowStatus } =
	await import("./db.ts");
const { loadConfig } = await import("./config.ts");
const { setSchedule } = await import("./workflow.ts");
const { runSchedulerTick } = await import("./scheduler.ts");
const { scheduleNoticeMessage, sendScheduleNoticeNotification } = await import("./notifier.ts");

const scheduleNotice = {
	kind: "missed" as const,
	seriesName: "Nightly audit",
	workflowName: "Nightly audit · 2026-09-30 09:00",
	reason: "offline",
	occurrences: ["2026-09-28 09:00", "2026-09-29 09:00"],
	nextRun: "2026-10-01 09:00",
	recurring: true,
	detail: "",
};

test("missed message names the series, every missed run, why, and the next run", () => {
	const message = scheduleNoticeMessage(scheduleNotice);
	assert.match(message, /Scheduled run missed/);
	assert.match(message, /\*Nightly audit\*/);
	assert.match(message, /Missed \(2 runs\):\* 2026-09-28 09:00, 2026-09-29 09:00/);
	assert.match(message, /Why:\* the hub was offline/);
	assert.match(message, /Next run:\* 2026-10-01 09:00/);
});

test("a missed once says it waits for Run now / Reschedule / Dismiss", () => {
	const message = scheduleNoticeMessage({
		...scheduleNotice,
		occurrences: ["2026-09-30 09:00"],
		nextRun: null,
		recurring: false,
	});
	assert.match(message, /Missed \(1 run\):\* 2026-09-30 09:00/);
	assert.match(message, /Run now\*, \*Reschedule\* or \*Dismiss/);
});

test("skipped message spells out each skip reason", () => {
	const reasons = {
		busy: /previous run was still in progress/,
		forbidden: /client\.workflows\.execute/,
		stale: /could not confirm the owner's permissions/,
	};
	for (const [reason, pattern] of Object.entries(reasons)) {
		const message = scheduleNoticeMessage({ ...scheduleNotice, kind: "skipped", reason, occurrences: ["2026-09-30 09:00"] });
		assert.match(message, /Scheduled run skipped/, reason);
		assert.match(message, /\*Nightly audit\*/, reason);
		assert.match(message, /Run:\* 2026-09-30 09:00/, reason);
		assert.match(message, pattern, reason);
		assert.match(message, /Next run:\* 2026-10-01 09:00/, reason);
	}
});

test("broken message says no further runs will happen until rescheduled — and names no next run", () => {
	const message = scheduleNoticeMessage({
		...scheduleNotice,
		kind: "broken",
		reason: "clone_failed",
		occurrences: ["2026-09-30 09:00"],
		detail: "disk full",
	});
	assert.match(message, /Schedule broken/);
	assert.match(message, /\*Nightly audit\*/);
	assert.match(message, /next run could not be created/);
	assert.match(message, /Detail:\* disk full/);
	assert.match(message, /No further runs will happen until the schedule is rescheduled/);
	assert.doesNotMatch(message, /Next run:/);
});

test("failed-run message names the run, its series, the failed step and the next run", () => {
	const message = scheduleNoticeMessage({
		...scheduleNotice,
		kind: "failed",
		reason: "run_failed",
		occurrences: ["2026-09-30 09:00"],
		detail: "step 2 (deploy): exit 1",
	});
	assert.match(message, /Scheduled run failed/);
	assert.match(message, /\*Nightly audit · 2026-09-30 09:00\* \(schedule \*Nightly audit\*\)/);
	assert.match(message, /Why:\* a step failed/);
	assert.match(message, /Detail:\* step 2 \(deploy\): exit 1/);
	assert.match(message, /Next run:\* 2026-10-01 09:00/);
});

test("schedule notices obey the same opt-in as every other notification", async (t) => {
	saveNotificationSettings({ enabled: false, channels: { slack: { username: "ada" } } });
	const calls = stubImpl(t, { detect: () => [endpoint] });
	assert.deepEqual(await sendScheduleNoticeNotification(scheduleNotice), {
		sent: false,
		reason: "notifications-disabled",
	});
	assert.equal(calls.send.length, 0);

	saveNotificationSettings({ enabled: true, channels: { slack: { username: "ada" } } });
	assert.deepEqual(await sendScheduleNoticeNotification(scheduleNotice), { sent: true });
	assert.equal(calls.send.length, 1);
	assert.equal(calls.send[0]!.username, "ada");
});

// The scheduler end of it. Fired runs are started for real against a fake awb
// hook that accepts every dispatch and never calls back, so they sit `running`.

const hook = http.createServer((req, res) => {
	req.resume();
	req.on("end", () => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
	});
});
await new Promise<void>((resolve) => hook.listen(0, "127.0.0.1", resolve));
const hookAddress = hook.address();
if (!hookAddress || typeof hookAddress === "string") throw new Error("fake hook did not bind");
const hookBase = `http://127.0.0.1:${hookAddress.port}/hook`;
test.after(() => hook.close());

const cfg = loadConfig();
const ARMED_AT = new Date("2026-09-30T08:00:00.000Z");
const DUE = new Date("2026-09-30T09:00:00.000Z");
const MIN = 60_000;
let schedSeq = 0;

/** A plain workflow on the fake hook with two task steps. */
function plainWorkflow(name: string): string {
	schedSeq += 1;
	const id = `wf-notify-${schedSeq}`;
	insertWorkflow({
		id,
		name,
		agentName: `notify-agent-${schedSeq}`,
		hookUrl: `${hookBase}/${id}`,
		secret: "s",
		mdPath: path.join(tmpHome, `${id}.md`),
	});
	insertStep(id, "collect");
	insertStep(id, "deploy");
	return id;
}

/** An armed daily 09:00 UTC series; every earlier armed instance is disarmed so a tick is about this one only. */
function armedSeries(name: string) {
	open()
		.prepare("UPDATE workflows SET schedule_state = 'cancelled', next_run_at = NULL WHERE schedule_state = 'armed'")
		.run();
	return setSchedule(plainWorkflow(name), { spec: { kind: "daily", time: "09:00" }, timezone: "UTC" }, { now: ARMED_AT });
}

/** Sets up Slack and records every message sent; returns them. */
function captureSlack(t: { after: (fn: () => void) => void }) {
	saveNotificationSettings({ enabled: true, channels: { slack: { username: "ada" } } });
	return stubImpl(t, { detect: () => [endpoint] });
}

/** Notices are sent fire-and-forget; give the stubbed send a moment to run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const tick = (now: Date, extra: Partial<Parameters<typeof runSchedulerTick>[0]> = {}) =>
	runSchedulerTick({ cfg, log: () => {}, now, permissionState: () => ({ kind: "unrestricted" }), ...extra });

test("scheduler: runs missed while the hub was offline are sent to Slack", async (t) => {
	const calls = captureSlack(t);
	const wf = armedSeries("Missed audit");
	await tick(new Date(DUE.getTime() + 2 * 24 * 60 * MIN + 30 * MIN));
	await settle();
	assert.equal(calls.send.length, 1);
	const message = calls.send[0]!.message;
	assert.match(message, /Scheduled run missed/);
	assert.match(message, /\*Missed audit\*/);
	assert.match(message, /Missed \(3 runs\):\* 2026-09-30 09:00, 2026-10-01 09:00, 2026-10-02 09:00/);
	assert.match(message, /the hub was offline/);
	assert.match(message, /Next run:\* 2026-10-03 09:00/);
	assert.equal(listNotices({ seriesId: wf.seriesId! }).length, 1, "the notice is recorded as well");
});

test("scheduler: a skipped run is sent to Slack with its reason", async (t) => {
	const calls = captureSlack(t);
	armedSeries("Forbidden audit");
	await tick(DUE, { permissionState: () => ({ kind: "enforced", permissions: [] }) });
	await settle();
	assert.equal(calls.send.length, 1);
	const message = calls.send[0]!.message;
	assert.match(message, /Scheduled run skipped/);
	assert.match(message, /\*Forbidden audit\*/);
	assert.match(message, /Run:\* 2026-09-30 09:00/);
	assert.match(message, /client\.workflows\.execute/);
	assert.match(message, /Next run:\* 2026-10-01 09:00/);
});

test("scheduler: a broken series is sent to Slack saying no further runs will happen", async (t) => {
	const calls = captureSlack(t);
	const wf = armedSeries("Broken audit");
	await tick(DUE, {
		clone: () => {
			throw new Error("disk full");
		},
	});
	await settle();
	assert.equal(getWorkflow(wf.id)!.status, "running", "the current run still started");
	assert.equal(calls.send.length, 1);
	const message = calls.send[0]!.message;
	assert.match(message, /Schedule broken/);
	assert.match(message, /\*Broken audit\*/);
	assert.match(message, /Run:\* 2026-09-30 09:00/);
	assert.match(message, /disk full/);
	assert.match(message, /No further runs will happen until the schedule is rescheduled/);
});

test("scheduler: a fired scheduled run that ends failed is sent to Slack once, and again after a restart fails it", async (t) => {
	const calls = captureSlack(t);
	const wf = armedSeries("Failing audit");
	await tick(DUE);
	await settle();
	assert.equal(calls.send.length, 0, "an on-time fire sends nothing");
	const step = listSteps(wf.id).filter((s) => s.kind === "task")[0]!;
	completeStep(step.id, { ok: false, error: "exit 1" });
	setWorkflowStatus(wf.id, "failed");

	await tick(new Date(DUE.getTime() + MIN));
	await settle();
	assert.equal(calls.send.length, 1);
	const message = calls.send[0]!.message;
	assert.match(message, /Scheduled run failed/);
	assert.match(message, /\*Failing audit\*/);
	assert.match(message, /Run:\* 2026-09-30 09:00/);
	assert.match(message, /step 1 \(collect\): exit 1/);
	assert.match(message, /Next run:\* 2026-10-01 09:00/, "the series carries on with its next instance");
	const failedNotices = listNotices({ seriesId: wf.seriesId! }).filter((n) => n.kind === "failed");
	assert.equal(failedNotices.length, 1);
	assert.equal(failedNotices[0]!.reason, "run_failed");

	await tick(new Date(DUE.getTime() + 2 * MIN));
	await settle();
	assert.equal(calls.send.length, 1, "the same failure is announced once");

	// Leaving `failed` (a restart) re-arms the announcement; failing again is a new failure.
	setWorkflowStatus(wf.id, "running");
	setWorkflowStatus(wf.id, "failed");
	await tick(new Date(DUE.getTime() + 3 * MIN));
	await settle();
	assert.equal(calls.send.length, 2);
});

test("scheduler: a failed NON-scheduled workflow still sends nothing", async (t) => {
	const calls = captureSlack(t);
	const id = plainWorkflow("Interactive run");
	const step = listSteps(id).filter((s) => s.kind === "task")[0]!;
	completeStep(step.id, { ok: false, error: "exit 1" });
	setWorkflowStatus(id, "failed");

	await tick(new Date(DUE.getTime() + 10 * MIN));
	await settle();
	assert.equal(calls.send.length, 0);
	assert.equal(
		listNotices({ includeAcknowledged: true }).filter((n) => n.workflowId === id).length,
		0,
		"and records no notice",
	);
});
