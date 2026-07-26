/**
 * Best-effort notifications. Two so far, both about a moment the user would
 * otherwise only discover by having the UI open:
 *
 *  - "a step is waiting for your manual review" — sent the moment a gated step
 *    enters the `waiting` hold;
 *  - "your workflow finished" — sent the moment a workflow becomes `completed`,
 *    carrying the result it ended on.
 *
 * The engine calls them and then carries on regardless of what they answer.
 * Delivery is strictly advisory: the hold (and the completion) is the feature,
 * the message is a courtesy, so nothing here may ever throw into the engine
 * path. Every failure mode is a `{ sent: false, reason }`, never an exception.
 *
 * Both go through the SAME decision (`deliver` below), so "notifications are
 * off", "no username", "no Slack MCP", "sent" and "the send blew up" mean
 * exactly the same thing whichever notification is being attempted — there is
 * one policy here, not one per message.
 *
 * ## How the hub reaches Slack
 *
 * The hub is a plain Node process. It has no MCP client of its own and it is
 * not the Claude agent, so it cannot call `mcp__plugin_slack_slack__*` tools —
 * those only exist inside a harness session. What it CAN do is talk to the same
 * server those tools proxy: the Slack MCP is an HTTP MCP server
 * (`https://mcp.slack.com/mcp`), and Claude Code stores the OAuth token from
 * the `/mcp` login in `~/.claude/.credentials.json` under `mcpOAuth`. So the
 * hub speaks MCP JSON-RPC to that URL directly, with that token.
 *
 * ## Why that token is also the availability check
 *
 * Detection has to be honest: if we cannot confirm the Slack MCP is there and
 * logged in, that is case 3 ("mcp-unavailable") and we send nothing — never an
 * invented success. A stored, unexpired `mcpOAuth` entry for the Slack server is
 * exactly that confirmation, because it is only ever written by a completed
 * OAuth login against that server. No entry (plugin not installed, never logged
 * in), an expired one, or an unreadable credentials file all mean "cannot
 * confirm" and are treated as unavailable.
 *
 * Both halves — detection and delivery — sit behind `_impl` so the five
 * notification cases are testable without a network or a real Slack workspace
 * (same indirection idiom as terminal.ts's `_impl.spawn`).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getNotificationSettings } from "./db.ts";

/** Why nothing was sent. Each value maps 1:1 to a case the feature has to handle. */
export type NotificationSkipReason =
	/** The master switch in Settings is off — the user wants no notifications at all. */
	| "notifications-disabled"
	/** Notifications are on but no Slack username is configured, so there's nobody to message. */
	| "no-slack-username"
	/** The Slack MCP could not be confirmed as configured AND logged in. */
	| "mcp-unavailable"
	/** It was attempted and the send itself failed (network, auth, unknown user…). */
	| "send-failed";

export type NotificationResult = { sent: true } | { sent: false; reason: NotificationSkipReason };

/** A confirmed, logged-in Slack MCP server the hub can call. */
export interface SlackMcpEndpoint {
	/** The credential's own server name, e.g. `plugin:slack:slack` — kept for logs. */
	serverName: string;
	serverUrl: string;
	accessToken: string;
}

/** What the human is being asked to look at. Everything the message needs, and nothing from the DB layer. */
export interface ManualReviewNotice {
	workflowName: string;
	/** 1-based, matching what the UI shows next to the step. */
	stepNumber: number;
	stepDescription: string;
	/** What they must review / why they were pulled in. */
	reason: string;
}

/**
 * What a finished workflow is reporting. Same "nothing from the DB layer"
 * rule as `ManualReviewNotice`: the engine reads the steps and hands over the
 * few strings the message needs, already truncated — this module composes text
 * and talks to Slack, it does not know what a `Step` is.
 */
export interface WorkflowCompletedNotice {
	workflowName: string;
	/** How many steps the run finished — every one of them is `done`, or the workflow would not be `completed`. */
	stepCount: number;
	/** The last step's description, so the result below has something to be the result OF. Empty when the workflow had no steps at all. */
	lastStepDescription: string;
	/** The workflow's outcome: the last step's result, truncated by the caller to something a chat window can hold. */
	result: string;
}

const MCP_PROTOCOL_VERSION = "2025-06-18";
const MCP_TIMEOUT_MS = 10_000;

/** Claude Code's config directory — `CLAUDE_CONFIG_DIR` when set (which is also what lets tests point this at a throwaway dir). */
function claudeConfigDir(): string {
	return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
}

/**
 * The Slack MCP entry in Claude Code's credential store, or null when it can't
 * be confirmed. Conservative on purpose (see the module comment): a missing or
 * malformed file, no Slack entry, a blank token or an expired one all answer
 * null rather than "probably fine".
 */
export function detectSlackMcp(): SlackMcpEndpoint | null {
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(fs.readFileSync(path.join(claudeConfigDir(), ".credentials.json"), "utf8")) as Record<
			string,
			unknown
		>;
	} catch {
		// No credential store at all (or unreadable) — cannot confirm anything.
		return null;
	}
	const entries = (parsed.mcpOAuth ?? {}) as Record<string, unknown>;
	for (const [key, value] of Object.entries(entries)) {
		const entry = (value ?? {}) as Record<string, unknown>;
		const serverName = typeof entry.serverName === "string" ? entry.serverName : key;
		// The key/server name is `plugin:slack:slack|<hash>` for the official
		// plugin, or just the server name for a hand-configured one. Matching on
		// the "slack" token in either keeps both working without matching, say, a
		// server merely mentioning slack in its URL.
		if (!/(^|[:|])slack([:|]|$)/.test(serverName) && !/(^|[:|])slack([:|]|$)/.test(key)) continue;
		const serverUrl = typeof entry.serverUrl === "string" ? entry.serverUrl : "";
		const accessToken = typeof entry.accessToken === "string" ? entry.accessToken : "";
		if (!serverUrl || !accessToken) continue;
		// A token past its expiry is not a login we can use. `expiresAt` is epoch
		// ms; an entry without one is accepted (nothing says it's stale).
		const expiresAt = typeof entry.expiresAt === "number" ? entry.expiresAt : null;
		if (expiresAt !== null && expiresAt <= Date.now()) continue;
		return { serverName, serverUrl, accessToken };
	}
	return null;
}

/**
 * One JSON-RPC round trip to an HTTP MCP server. The transport answers either
 * `application/json` or a one-event SSE stream depending on the server, so both
 * are parsed here. A JSON-RPC `error` (or an HTTP failure) throws — every caller
 * is already inside the try/catch that turns it into `send-failed`.
 */
async function mcpRequest(
	endpoint: SlackMcpEndpoint,
	method: string,
	params: Record<string, unknown>,
	sessionId: string | null,
): Promise<{ result: unknown; sessionId: string | null }> {
	const res = await fetch(endpoint.serverUrl, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			authorization: `Bearer ${endpoint.accessToken}`,
			"mcp-protocol-version": MCP_PROTOCOL_VERSION,
			...(sessionId ? { "mcp-session-id": sessionId } : {}),
		},
		body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
		signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`${method} answered ${res.status}`);
	const nextSessionId = res.headers.get("mcp-session-id") ?? sessionId;
	const text = await res.text();
	// SSE framing: the JSON-RPC response is the payload of the last `data:` line.
	const payload = text.includes("data:")
		? (text
				.split(/\r?\n/)
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice("data:".length).trim())
				.at(-1) ?? "")
		: text;
	const body = JSON.parse(payload) as { result?: unknown; error?: { message?: string } };
	if (body.error) throw new Error(body.error.message ?? "mcp error");
	return { result: body.result, sessionId: nextSessionId };
}

/** Fire-and-forget JSON-RPC notification (no id, no response body to parse). */
async function mcpNotify(endpoint: SlackMcpEndpoint, method: string, sessionId: string | null): Promise<void> {
	await fetch(endpoint.serverUrl, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			authorization: `Bearer ${endpoint.accessToken}`,
			"mcp-protocol-version": MCP_PROTOCOL_VERSION,
			...(sessionId ? { "mcp-session-id": sessionId } : {}),
		},
		body: JSON.stringify({ jsonrpc: "2.0", method, params: {} }),
		signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
	});
}

/** Slack user id shape (`U…`/`W…`), so a username that already IS an id skips the lookup. */
const SLACK_USER_ID = /^[UW][A-Z0-9]{6,}$/;

/**
 * Sends the message as a Slack DM through the MCP server: `initialize`, then
 * `slack_search_users` to turn the configured handle into the user id that
 * `slack_send_message` wants as its `channel_id` (the tool DMs a user by using
 * their id as the channel), then the send itself. A handle that is already a
 * user id skips the lookup. Throws on any failure — the caller reports
 * `send-failed` and the workflow stays exactly as it was.
 */
async function sendSlackDirectMessage(endpoint: SlackMcpEndpoint, username: string, message: string): Promise<void> {
	const handshake = await mcpRequest(
		endpoint,
		"initialize",
		{
			protocolVersion: MCP_PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: "target-hub", version: "0.1.0" },
		},
		null,
	);
	const sessionId = handshake.sessionId;
	await mcpNotify(endpoint, "notifications/initialized", sessionId);

	const handle = username.replace(/^@/, "").trim();
	let userId = handle;
	if (!SLACK_USER_ID.test(handle)) {
		const found = await mcpRequest(
			endpoint,
			"tools/call",
			{ name: "slack_search_users", arguments: { query: handle, limit: 1 } },
			sessionId,
		);
		// The tool answers free-form content blocks, so the id is read out of the
		// serialised result rather than a guaranteed field.
		const match = /\b[UW][A-Z0-9]{6,}\b/.exec(JSON.stringify(found.result ?? ""));
		if (!match) throw new Error(`no Slack user matched '${username}'`);
		userId = match[0];
	}

	await mcpRequest(
		endpoint,
		"tools/call",
		{ name: "slack_send_message", arguments: { channel_id: userId, message } },
		sessionId,
	);
}

/**
 * Indirection so the notification cases can be tested without a network, a
 * Slack workspace or a logged-in MCP (see terminal.ts's `_impl.spawn` for the
 * same idea). Tests swap `detect` to force "unavailable" and `send` to record
 * the message or to throw.
 */
export const _impl = {
	detect: detectSlackMcp,
	send: sendSlackDirectMessage,
};

/**
 * The message the human receives. It has to answer, on its own and without the
 * UI open: WHICH workflow, WHICH step, and WHY they were pulled in — a
 * notification that only says "something needs review" costs more time than it
 * saves.
 */
export function manualReviewMessage(notice: ManualReviewNotice): string {
	return [
		`:eyes: *Manual review needed* — workflow *${notice.workflowName}* is paused.`,
		"",
		`*Step ${notice.stepNumber}:* ${notice.stepDescription}`,
		`*Why:* ${notice.reason}`,
		"",
		"The step and the workflow stay in `waiting` until you press *Continue* on that step in The Target Project.",
	].join("\n");
}

/**
 * The message a finished workflow sends. It has to answer, on its own and
 * without the UI open: WHICH workflow finished and WHAT it ended up producing —
 * "workflow done" with no result is a notification that only tells you to go
 * and look, which is the thing this is meant to save.
 *
 * The result is the last step's, already truncated by the caller: a step can
 * answer with pages of text, and a chat message that has to be scrolled is
 * worse than one that says "here's the gist, open the workflow for the rest".
 */
export function workflowCompletedMessage(notice: WorkflowCompletedNotice): string {
	const lines = [
		`:white_check_mark: *Workflow finished* — *${notice.workflowName}* is completed.`,
		"",
		`*Steps:* all ${notice.stepCount} done`,
	];
	// A workflow can legitimately complete with no steps at all (start a draft
	// that has none), and then there is no "last step" to name — say nothing
	// rather than print an empty label.
	if (notice.lastStepDescription !== "") {
		lines.push(`*Last step (${notice.stepCount}):* ${notice.lastStepDescription}`);
	}
	lines.push("", "*Result:*", notice.result === "" ? "_(the last step reported no result)_" : notice.result);
	return lines.join("\n");
}

/**
 * The ONE place the five notification outcomes are decided, shared by every
 * notification the hub sends, in the order they're decided:
 *
 * 1. notifications off        → `notifications-disabled`, nothing sent
 * 2. no Slack username        → `no-slack-username`, nothing sent
 * 3. Slack MCP unconfirmed    → `mcp-unavailable`, nothing sent
 * 4. sent                     → `{ sent: true }`
 * 5. the send threw           → `send-failed`, swallowed here
 *
 * The message is a thunk, not a string, so nothing is composed for a hub that
 * has notifications switched off — and so each notification owns its own
 * wording while sharing this policy exactly.
 *
 * Whatever the engine did before calling this is already done and stays done in
 * every one of the five: this never throws and never touches state.
 */
async function deliver(buildMessage: () => string): Promise<NotificationResult> {
	try {
		const settings = getNotificationSettings();
		if (!settings.enabled) return { sent: false, reason: "notifications-disabled" };
		const username = settings.channels.slack.username.trim();
		if (username === "") return { sent: false, reason: "no-slack-username" };
		const endpoint = _impl.detect();
		if (!endpoint) return { sent: false, reason: "mcp-unavailable" };
		await _impl.send(endpoint, username, buildMessage());
		return { sent: true };
	} catch {
		// Case 5, plus anything unexpected above it (an unreadable settings row,
		// a detector that blew up): the notification is advisory, so it fails
		// silently rather than taking the workflow with it.
		return { sent: false, reason: "send-failed" };
	}
}

/** Attempts to tell the user a step is waiting for them. See `deliver` for the five outcomes; the step is already `waiting` and stays that way in all of them. */
export function sendManualReviewNotification(notice: ManualReviewNotice): Promise<NotificationResult> {
	return deliver(() => manualReviewMessage(notice));
}

/**
 * Attempts to tell the user a workflow has finished, naming it and quoting the
 * result it ended on. See `deliver` for the five outcomes — identical to the
 * manual-review notification's, deliberately: the user configured ONE Slack
 * destination and one master switch, so both messages have to obey them the
 * same way.
 *
 * The workflow is already `completed` and stays `completed` whatever this
 * answers; the engine only logs the outcome.
 */
export function sendWorkflowCompletedNotification(notice: WorkflowCompletedNotice): Promise<NotificationResult> {
	return deliver(() => workflowCompletedMessage(notice));
}
