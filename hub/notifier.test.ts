/**
 * Tests for the manual-review notification (notifier.ts).
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

const { saveNotificationSettings } = await import("./db.ts");
const { _impl, detectSlackMcp, manualReviewMessage, sendManualReviewNotification } = await import("./notifier.ts");

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
	const calls = { detect: 0, send: [] as { username: string; message: string; serverUrl: string }[] };
	_impl.detect = () => {
		calls.detect++;
		return overrides.detect ? overrides.detect() : null;
	};
	_impl.send = async (endpoint, username, message) => {
		calls.send.push({ username, message, serverUrl: endpoint.serverUrl });
		if (overrides.send) await overrides.send(endpoint, username, message);
	};
	return calls;
}

const endpoint = { serverName: "plugin:slack:slack", serverUrl: "https://mcp.slack.com/mcp", accessToken: "tok-123" };

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
	const calls = stubImpl(t, { detect: () => endpoint });

	const result = await sendManualReviewNotification(notice);

	assert.deepEqual(result, { sent: false, reason: "notifications-disabled" });
	assert.equal(calls.send.length, 0);
	// The master switch is decided first: a disabled hub never even asks whether
	// Slack is available.
	assert.equal(calls.detect, 0);
});

test("case 2: enabled with no Slack username sends nothing", async (t) => {
	saveNotificationSettings({ enabled: true, channels: { slack: { username: "" } } });
	const calls = stubImpl(t, { detect: () => endpoint });

	const result = await sendManualReviewNotification(notice);

	assert.deepEqual(result, { sent: false, reason: "no-slack-username" });
	assert.equal(calls.send.length, 0);
	assert.equal(calls.detect, 0);
});

test("case 2: a whitespace-only username counts as none", async (t) => {
	// saveNotificationSettings trims on the way in, so this is stored as "" — the
	// point is that "   " can never reach the send as a Slack handle.
	saveNotificationSettings({ enabled: true, channels: { slack: { username: "   " } } });
	const calls = stubImpl(t, { detect: () => endpoint });

	const result = await sendManualReviewNotification(notice);

	assert.deepEqual(result, { sent: false, reason: "no-slack-username" });
	assert.equal(calls.send.length, 0);
});

test("case 3: with a username but no confirmed Slack MCP, nothing is sent", async (t) => {
	saveNotificationSettings({ enabled: true, channels: { slack: { username: "ada" } } });
	const calls = stubImpl(t); // detect answers null

	const result = await sendManualReviewNotification(notice);

	assert.deepEqual(result, { sent: false, reason: "mcp-unavailable" });
	assert.equal(calls.detect, 1);
	assert.equal(calls.send.length, 0);
});

test("case 4: fully configured, the message is sent once to the configured user", async (t) => {
	saveNotificationSettings({ enabled: true, channels: { slack: { username: "@ada" } } });
	const calls = stubImpl(t, { detect: () => endpoint });

	const result = await sendManualReviewNotification(notice);

	assert.deepEqual(result, { sent: true });
	assert.equal(calls.send.length, 1);
	assert.equal(calls.send[0].username, "@ada");
	assert.equal(calls.send[0].serverUrl, endpoint.serverUrl);
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
		detect: () => endpoint,
		send: async () => {
			throw new Error("slack said no");
		},
	});

	const result = await sendManualReviewNotification(notice);

	assert.deepEqual(result, { sent: false, reason: "send-failed" });
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

	assert.deepEqual(result, { sent: false, reason: "send-failed" });
});

test("even a settings read that blows up cannot throw into the engine", async (t) => {
	saveNotificationSettings({ enabled: true, channels: { slack: { username: "ada" } } });
	const calls = stubImpl(t, { detect: () => endpoint });

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

	assert.deepEqual(result, { sent: false, reason: "send-failed" });
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

	assert.deepEqual(await sendManualReviewNotification(notice), { sent: false, reason: "mcp-unavailable" });
});
