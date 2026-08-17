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
 * off", "no username", "no way to reach Slack", "sent" and "the send blew up" mean
 * exactly the same thing whichever notification is being attempted — there is
 * one policy here, not one per message.
 *
 * ## How the hub reaches Slack
 *
 * The hub is a plain Node process. It has no MCP client of its own and it is
 * not the Claude agent, so it cannot call `mcp__plugin_slack_slack__*` tools —
 * those only exist inside a harness session. Sending is therefore done here, in
 * Node, over plain HTTP, by one of two transports:
 *
 *  1. **Client tokens** (`xoxc` + the `d` cookie, `xoxd`) read from the
 *     environment. This is the same credential pair the Slack web client uses,
 *     so the hub calls `https://slack.com/api/chat.postMessage` directly — no
 *     MCP anywhere in the path. It exists because creating a Slack app (and
 *     getting an `xoxb-` bot token) needs workspace permissions plenty of
 *     operators simply do not have.
 *  2. **The Slack MCP over OAuth.** The official plugin is an HTTP MCP server
 *     (`https://mcp.slack.com/mcp`) and Claude Code stores the token from the
 *     `/mcp` login in `~/.claude/.credentials.json` under `mcpOAuth`, so the hub
 *     speaks MCP JSON-RPC to that URL with that token.
 *
 * ## Why client tokens come first
 *
 * They are EXPLICIT configuration: someone put two variables in `.env` naming
 * exactly how they want notifications delivered. The `mcpOAuth` entry is
 * ambient — it may be left over from a `/mcp` login done months ago for
 * something else entirely. Explicit configuration outranks discovery. It is
 * also the shorter path (one request against four: handshake, initialized,
 * user lookup, send).
 *
 * Order is a preference, not a commitment: `deliver` tries each transport in
 * turn and the first one that gets the message out wins. So an `xoxd` cookie
 * that has gone stale — they die when you log out of the browser, and Slack
 * rotates them on its own — falls through to the MCP instead of losing the
 * notification.
 *
 * ## Why detection is also the availability check
 *
 * Detection has to be honest: with no transport we can confirm, that is case 3
 * ("no-transport") and we send nothing — never an invented success. For client
 * tokens the confirmation is both variables being present (they are useless
 * apart: the `xoxc` goes in the `Authorization` header and the `xoxd` in the
 * `Cookie`, and Slack rejects either one alone). For the MCP it is a stored,
 * unexpired `mcpOAuth` entry, which is only ever written by a completed OAuth
 * login against that server. No entry, an expired one, or an unreadable
 * credentials file all mean "cannot confirm".
 *
 * Note what detection deliberately does NOT do: reach the network to prove a
 * credential still works. It stays synchronous and pure, and a credential that
 * is present but dead surfaces where it actually fails — as `send-failed`,
 * carrying Slack's own error code (`invalid_auth` and friends) in `detail` so
 * the log says "go and get fresh tokens" instead of a shrug.
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
	/** No way to reach Slack could be confirmed: no client tokens in the environment AND no logged-in Slack MCP. */
	| "no-transport"
	/** Every configured transport was attempted and every one of them failed (network, auth, unknown user…). */
	| "send-failed";

export type NotificationResult =
	| { sent: true }
	| {
			sent: false;
			reason: NotificationSkipReason;
			/**
			 * Why, in the words of whatever refused — Slack's own error code
			 * (`invalid_auth`, `channel_not_found`…) for a failed send. Only ever
			 * set alongside `send-failed`, and only for the caller's log: a
			 * notification that silently stops arriving is the failure mode this
			 * feature is worst at, and "send-failed" alone does not tell an operator
			 * that their `xoxd` cookie expired.
			 */
			detail?: string;
	  };

/** A confirmed, logged-in Slack MCP server the hub can call. */
export interface SlackMcpEndpoint {
	/** The credential's own server name, e.g. `plugin:slack:slack` — kept for logs. */
	serverName: string;
	serverUrl: string;
	accessToken: string;
}

/**
 * A Slack web-client session: the `xoxc-` token and the `xoxd-` value of the
 * `d` cookie. Only ever useful as a pair, which is why detection insists on
 * both.
 */
export interface SlackClientTokens {
	xoxc: string;
	/** Exactly as the browser stores it — see `detectSlackClientTokens` on why it is not decoded. */
	xoxd: string;
}

/**
 * A confirmed way to deliver a DM. Discriminated structurally (`"xoxc" in t`)
 * rather than with a tag, so a transport is just the credential it needs and
 * nothing else.
 */
export type SlackTransport = SlackClientTokens | SlackMcpEndpoint;

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
/** Ceiling on any single outbound request, MCP or Slack Web API alike. A notification may never hold a caller up. */
const SLACK_TIMEOUT_MS = 10_000;

/** Slack's Web API, which the `xoxc`/`xoxd` pair authenticates against directly. */
const SLACK_API_BASE = "https://slack.com/api";

/**
 * Where the client tokens are read from, in order, first non-empty wins.
 *
 * Three names because three conventions meet here: this repo prefixes its own
 * variables with `TARGET_` (see `.env.example`), the widely used third-party
 * Slack MCP servers read `SLACK_MCP_*`, and `SLACK_*` is the obvious short
 * form. Accepting all three means an operator who already runs such an MCP puts
 * the tokens in ONE place instead of keeping two copies of a secret that will
 * drift apart the day it rotates.
 */
const XOXC_ENV_VARS = ["TARGET_SLACK_XOXC_TOKEN", "SLACK_MCP_XOXC_TOKEN", "SLACK_XOXC_TOKEN"] as const;
const XOXD_ENV_VARS = ["TARGET_SLACK_XOXD_TOKEN", "SLACK_MCP_XOXD_TOKEN", "SLACK_XOXD_TOKEN"] as const;

/** Slack user id shape (`U…`/`W…`), so a username that already IS an id skips the lookup. Shared by both transports. */
const SLACK_USER_ID = /^[UW][A-Z0-9]{6,}$/;

/** First non-empty value among `names`, trimmed; empty string when none is set. */
function firstEnv(names: readonly string[]): string {
	for (const name of names) {
		const value = (process.env[name] ?? "").trim();
		if (value !== "") return value;
	}
	return "";
}

/** Claude Code's config directory — `CLAUDE_CONFIG_DIR` when set (which is also what lets tests point this at a throwaway dir). */
function claudeConfigDir(): string {
	return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
}

/**
 * The Slack web-client tokens from the environment, or null when the pair is
 * incomplete. `.env` is already loaded by config.ts (`process.loadEnvFile`), so
 * "the environment" covers both a real export and the repo's `.env`.
 *
 * The `xoxd` value is used EXACTLY as given, not decoded. What the browser
 * stores in the `d` cookie is already percent-encoded, and that stored form is
 * what Slack expects back in the `Cookie` header — decoding it here (or
 * re-encoding an already-encoded value) is how this breaks. So: paste what
 * DevTools shows, and the hub passes it through untouched.
 *
 * Both halves are required. They authenticate different parts of the same
 * request — `xoxc` the `Authorization` header, `xoxd` the `Cookie` — and Slack
 * refuses either one on its own, so half a pair is not a transport.
 */
export function detectSlackClientTokens(): SlackClientTokens | null {
	const xoxc = firstEnv(XOXC_ENV_VARS);
	const xoxd = firstEnv(XOXD_ENV_VARS);
	if (xoxc === "" || xoxd === "") return null;
	return { xoxc, xoxd };
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
 * Every way this hub can currently reach Slack, best first: explicitly
 * configured client tokens, then an ambient Slack MCP login (see the module
 * comment on why that order). Empty means case 3 — there is nowhere to send.
 *
 * A LIST rather than a single winner because a credential can be present and
 * dead, which no amount of offline detection can tell: `deliver` walks these in
 * order so a stale `xoxd` falls through to the MCP instead of costing the
 * notification.
 */
export function resolveSlackTransports(): SlackTransport[] {
	const transports: SlackTransport[] = [];
	const clientTokens = detectSlackClientTokens();
	if (clientTokens) transports.push(clientTokens);
	const mcp = detectSlackMcp();
	if (mcp) transports.push(mcp);
	return transports;
}

/**
 * One call to Slack's Web API as the web client makes it: the `xoxc` as a
 * bearer token and the `xoxd` as the `d` cookie.
 *
 * Two things here are not optional. Requests go out **form-encoded**, because
 * client tokens are unreliable against the JSON variants of these endpoints.
 * And the answer is judged on the body's `ok` field, NOT on the HTTP status:
 * Slack replies `200 OK` to a rejected call and puts the truth in
 * `{"ok":false,"error":"invalid_auth"}`, so a status-only check (which is all
 * `mcpRequest` needs for JSON-RPC) would read every failure as a success here.
 * That error string is what surfaces as the caller's `detail`.
 */
async function slackApi(
	tokens: SlackClientTokens,
	method: string,
	params: Record<string, string>,
): Promise<Record<string, unknown>> {
	const res = await fetch(`${SLACK_API_BASE}/${method}`, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded; charset=utf-8",
			authorization: `Bearer ${tokens.xoxc}`,
			cookie: `d=${tokens.xoxd}`,
		},
		body: new URLSearchParams(params).toString(),
		signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`${method} answered ${res.status}`);
	const body = (await res.json()) as Record<string, unknown>;
	if (body.ok !== true) throw new Error(`${method}: ${typeof body.error === "string" ? body.error : "unknown error"}`);
	return body;
}

/**
 * The user id to DM, from whatever the operator typed in Settings.
 *
 * Three shapes, deliberately, and no directory scan: a `U…`/`W…` id is used as
 * it stands, anything containing an `@` is looked up as an email, and a bare
 * handle is resolved only when it is the token owner's own — `auth.test` says
 * who that is in one request. That last case is the overwhelmingly common one,
 * because these tokens ARE a person's session and the notification is that
 * person telling themselves something.
 *
 * What is NOT attempted is walking `users.list` to match a handle. It is
 * paginated over the whole workspace, so on anything but a small team it is
 * both slow and likely to miss — and failing *loudly* here is worth more, since
 * the error text names the two formats that always work and `deliver` will try
 * the MCP transport next anyway (it resolves handles properly).
 */
async function resolveClientUserId(tokens: SlackClientTokens, handle: string): Promise<string> {
	if (SLACK_USER_ID.test(handle)) return handle;
	if (handle.includes("@")) {
		const found = await slackApi(tokens, "users.lookupByEmail", { email: handle });
		const user = (found.user ?? {}) as Record<string, unknown>;
		if (typeof user.id !== "string") throw new Error(`no Slack user for email '${handle}'`);
		return user.id;
	}
	const self = await slackApi(tokens, "auth.test", {});
	if (typeof self.user === "string" && typeof self.user_id === "string" && self.user.toLowerCase() === handle.toLowerCase()) {
		return self.user_id;
	}
	throw new Error(`cannot resolve Slack handle '${handle}' from client tokens — use a user id (U…) or an email`);
}

/**
 * Sends the DM with client tokens: resolve the recipient, then
 * `chat.postMessage` with their user id as the channel (posting to a user id is
 * how the API opens/uses a DM). Throws on any failure, like every other send
 * here — `deliver` decides what that means.
 */
async function sendSlackClientMessage(
	tokens: SlackClientTokens,
	username: string,
	message: string,
): Promise<void> {
	const handle = username.replace(/^@/, "").trim();
	const channel = await resolveClientUserId(tokens, handle);
	// `text` and `channel` — the Web API's names. The MCP tool calls the same two
	// things `message` and `channel_id`, which is exactly the kind of per-server
	// contract that made a Node-side transport worth having.
	await slackApi(tokens, "chat.postMessage", { channel, text: message });
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
		signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
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
		signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
	});
}

/**
 * Sends the message as a Slack DM through the MCP server: `initialize`, then
 * `slack_search_users` to turn the configured handle into the user id that
 * `slack_send_message` wants as its `channel_id` (the tool DMs a user by using
 * their id as the channel), then the send itself. A handle that is already a
 * user id skips the lookup. Throws on any failure — the caller reports
 * `send-failed` and the workflow stays exactly as it was.
 */
async function sendSlackMcpMessage(endpoint: SlackMcpEndpoint, username: string, message: string): Promise<void> {
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

/** Routes a message to whichever transport was resolved. The one place the two know about each other. */
function sendSlackMessage(transport: SlackTransport, username: string, message: string): Promise<void> {
	return "xoxc" in transport
		? sendSlackClientMessage(transport, username, message)
		: sendSlackMcpMessage(transport, username, message);
}

/**
 * Indirection so the notification cases can be tested without a network, a
 * Slack workspace or a logged-in MCP (see terminal.ts's `_impl.spawn` for the
 * same idea). Tests swap `detect` to force "no transport" (or to pin which one
 * is used) and `send` to record the message or to throw.
 */
export const _impl = {
	detect: resolveSlackTransports,
	send: sendSlackMessage,
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
 * 3. no transport confirmed   → `no-transport`, nothing sent
 * 4. sent                     → `{ sent: true }`
 * 5. every transport failed   → `send-failed`, swallowed here
 *
 * Case 5 is "every", not "the": the transports come back ordered (client tokens
 * before an MCP login) and are tried in turn, because whether a credential still
 * works cannot be known offline. The first send that gets through wins; only
 * when all of them have thrown is the notification lost, and then the FIRST
 * failure's message is reported as `detail` — it is the one from the transport
 * the operator actually configured, and therefore the one worth acting on.
 *
 * The message is a thunk, not a string, so nothing is composed for a hub that
 * has notifications switched off — and so each notification owns its own
 * wording while sharing this policy exactly. It is built once and reused across
 * transports: a retry must deliver the same text, not recompose it.
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
		const transports = _impl.detect();
		if (transports.length === 0) return { sent: false, reason: "no-transport" };
		const message = buildMessage();
		let firstFailure = "";
		for (const transport of transports) {
			try {
				await _impl.send(transport, username, message);
				return { sent: true };
			} catch (err) {
				if (firstFailure === "") firstFailure = err instanceof Error ? err.message : String(err);
			}
		}
		return { sent: false, reason: "send-failed", detail: firstFailure };
	} catch (err) {
		// Anything unexpected ABOVE the loop (an unreadable settings row, a
		// detector that blew up): the notification is advisory, so it fails
		// silently rather than taking the workflow with it.
		return { sent: false, reason: "send-failed", detail: err instanceof Error ? err.message : String(err) };
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
