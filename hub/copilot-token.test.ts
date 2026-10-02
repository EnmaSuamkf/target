/**
 * Token resolver (copilot-token.ts) and its API routes:
 * GET /api/copilot/token-status, PUT/DELETE /api/settings/copilot-token,
 * POST /api/copilot/gh-login.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-copilot-token-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const { _impl } = await import("./awb.ts");
const { _impl: terminalImpl } = await import("./terminal.ts");
const { clearCopilotToken, getCopilotToken, saveCopilotToken } = await import("./db.ts");
const { classifyToken, copilotTokenStatus, ghAuthToken, resolveCopilotToken } = await import("./copilot-token.ts");
const { loadConfig } = await import("./config.ts");
const { createServer } = await import("./server.ts");

const ENV_TOKEN = "gho_dummyDummyDummyDummyEnvToken0001";
const ENV_GH_TOKEN = "gho_dummyDummyDummyDummyGhTokenEnv02";
const ENV_GITHUB_TOKEN = "gho_dummyDummyDummyDummyGithubEnv03";
const SETTINGS_TOKEN = "gho_dummyDummyDummyDummyDummyDummy1234";
const GH_TOKEN = "gho_dummyDummyDummyDummyFromGhCli05";
const CLASSIC = "ghp_dummyDummyDummyDummyClassic000006";
const ALL_DUMMIES = [ENV_TOKEN, ENV_GH_TOKEN, ENV_GITHUB_TOKEN, SETTINGS_TOKEN, GH_TOKEN, CLASSIC];

const ENV_NAMES = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;

const cfg = loadConfig();
const server = createServer(cfg, () => {});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("server did not bind a port");
const baseUrl = `http://127.0.0.1:${address.port}`;

test.after(() => {
	server.close();
});

const realSpawnSync = _impl.spawnSync;
const realSpawn = terminalImpl.spawn;
const realPlatform = terminalImpl.platform;

interface GhFake {
	/** `gh auth token` stdout; undefined = logged out (exit 1). */
	token?: string;
	installed?: boolean;
	/** Binary paths tried, in order. */
	calls: string[];
}

/** Swaps `_impl.spawnSync` for a fake gh; restored by the returned function. */
function fakeGh(opts: { token?: string; installed?: boolean; onlyAt?: string; timeout?: boolean }): GhFake & { restore: () => void } {
	const state: GhFake = { token: opts.token, installed: opts.installed ?? true, calls: [] };
	_impl.spawnSync = ((bin: string, args: string[]) => {
		state.calls.push(`${bin} ${args.join(" ")}`);
		if (!state.installed || (opts.onlyAt && bin !== opts.onlyAt)) return { status: null, error: new Error("ENOENT") };
		if (opts.timeout) return { status: null, error: new Error("ETIMEDOUT") };
		if (args[0] === "--version") return { status: 0, stdout: "gh version 2.0.0\n" };
		if (args[0] === "auth" && args[1] === "token") {
			return state.token === undefined ? { status: 1, stdout: "" } : { status: 0, stdout: `${state.token}\n` };
		}
		if (args[0] === "auth" && args[1] === "status") return { status: state.token === undefined ? 1 : 0, stdout: "" };
		return { status: 1, stdout: "" };
	}) as unknown as typeof _impl.spawnSync;
	return { ...state, calls: state.calls, restore: () => void (_impl.spawnSync = realSpawnSync) };
}

/** Runs `fn` with a clean token environment and no stored token. */
async function clean(fn: () => Promise<void> | void): Promise<void> {
	const prev: Record<string, string | undefined> = {};
	for (const name of ENV_NAMES) {
		prev[name] = process.env[name];
		delete process.env[name];
	}
	clearCopilotToken();
	try {
		await fn();
	} finally {
		for (const name of ENV_NAMES) {
			if (prev[name] === undefined) delete process.env[name];
			else process.env[name] = prev[name];
		}
		clearCopilotToken();
		_impl.spawnSync = realSpawnSync;
		terminalImpl.spawn = realSpawn;
		terminalImpl.platform = realPlatform;
	}
}

function admin() {
	return { "content-type": "application/json", authorization: `Bearer ${cfg.adminToken}` };
}

function assertNoSecret(text: string): void {
	for (const dummy of ALL_DUMMIES) assert.equal(text.includes(dummy), false, `response leaked ${dummy.slice(0, 8)}…`);
}

test("classifyToken recognises the supported and unsupported prefixes", () => {
	assert.equal(classifyToken("gho_abc"), "oauth");
	assert.equal(classifyToken("github_pat_abc"), "fine-grained");
	assert.equal(classifyToken("ghp_abc"), "classic");
	assert.equal(classifyToken("whatever"), "unknown");
});

test("source order: env (COPILOT_GITHUB_TOKEN > GH_TOKEN > GITHUB_TOKEN) > settings > gh", () =>
	clean(() => {
		const gh = fakeGh({ token: GH_TOKEN });
		assert.deepEqual(resolveCopilotToken(), { token: GH_TOKEN, source: "gh" });

		saveCopilotToken(SETTINGS_TOKEN);
		assert.deepEqual(resolveCopilotToken(), { token: SETTINGS_TOKEN, source: "settings" });

		process.env.GITHUB_TOKEN = ENV_GITHUB_TOKEN;
		assert.deepEqual(resolveCopilotToken(), { token: ENV_GITHUB_TOKEN, source: "env", envName: "GITHUB_TOKEN" });

		process.env.GH_TOKEN = ENV_GH_TOKEN;
		assert.equal(resolveCopilotToken()?.envName, "GH_TOKEN");

		process.env.COPILOT_GITHUB_TOKEN = `  ${ENV_TOKEN}\n`;
		assert.deepEqual(resolveCopilotToken(), { token: ENV_TOKEN, source: "env", envName: "COPILOT_GITHUB_TOKEN" });

		// A blank variable is skipped, not treated as a hit.
		process.env.COPILOT_GITHUB_TOKEN = "   ";
		assert.equal(resolveCopilotToken()?.envName, "GH_TOKEN");
		gh.restore();
	}));

test("resolveCopilotToken is null when no source has a token", () =>
	clean(() => {
		const gh = fakeGh({ token: undefined });
		assert.equal(resolveCopilotToken(), null);
		const status = copilotTokenStatus();
		assert.equal(status.available, false);
		assert.equal(status.usable, false);
		assert.equal(status.ghInstalled, true);
		assert.equal(status.ghLoggedIn, false);
		gh.restore();
	}));

test("ghAuthToken falls back to the well-known install paths and returns null on failure", () =>
	clean(() => {
		const viaUsrBin = fakeGh({ token: GH_TOKEN, onlyAt: "/usr/bin/gh" });
		assert.equal(ghAuthToken(), GH_TOKEN);
		viaUsrBin.restore();

		const missing = fakeGh({ installed: false });
		assert.equal(ghAuthToken(), null);
		assert.equal(copilotTokenStatus().ghInstalled, false);
		missing.restore();

		const slow = fakeGh({ token: GH_TOKEN, timeout: true });
		assert.equal(ghAuthToken(), null);
		slow.restore();

		// The stub from test-setup answers status 0 with no stdout: that is not a token.
		assert.equal(ghAuthToken(), null);
	}));

test("ghAuthToken asks for github.com with a 5 s timeout", () =>
	clean(() => {
		let seen: { bin: string; args: string[]; timeout?: number } | undefined;
		_impl.spawnSync = ((bin: string, args: string[], options: { timeout?: number }) => {
			seen = { bin, args, timeout: options.timeout };
			return { status: 0, stdout: `${GH_TOKEN}\n` };
		}) as unknown as typeof _impl.spawnSync;
		assert.equal(ghAuthToken(), GH_TOKEN);
		assert.deepEqual(seen, { bin: "gh", args: ["auth", "token", "--hostname", "github.com"], timeout: 5000 });
	}));

test("status carries only non-secret facts and warns for gh / classic / unknown tokens", () =>
	clean(() => {
		const gh = fakeGh({ token: GH_TOKEN });
		let status = copilotTokenStatus();
		assert.equal(status.source, "gh");
		assert.equal(status.tokenType, "oauth");
		assert.equal(status.usable, true);
		assert.match(status.warning ?? "", /broader scopes/);
		assert.equal(status.ghLoggedIn, true);
		assert.equal(status.storedInSettings, false);

		process.env.COPILOT_GITHUB_TOKEN = CLASSIC;
		status = copilotTokenStatus();
		assert.equal(status.tokenType, "classic");
		assert.equal(status.usable, false);
		assert.match(status.warning ?? "", /not supported/);

		process.env.COPILOT_GITHUB_TOKEN = "somethingElse";
		status = copilotTokenStatus();
		assert.equal(status.tokenType, "unknown");
		assert.ok(status.warning);

		process.env.COPILOT_GITHUB_TOKEN = ENV_TOKEN;
		status = copilotTokenStatus();
		assert.equal(status.warning, null);
		assert.equal(status.envName, "COPILOT_GITHUB_TOKEN");
		assertNoSecret(JSON.stringify(status));
		gh.restore();
	}));

test("routes require an admin token", async () => {
	for (const [method, route] of [
		["GET", "/api/copilot/token-status"],
		["PUT", "/api/settings/copilot-token"],
		["DELETE", "/api/settings/copilot-token"],
		["POST", "/api/copilot/gh-login"],
	] as const) {
		const res = await fetch(`${baseUrl}${route}`, {
			method,
			headers: { "content-type": "application/json" },
			body: method === "PUT" ? JSON.stringify({ token: SETTINGS_TOKEN }) : undefined,
		});
		assert.equal(res.status, 401, `${method} ${route}`);
	}
	assert.equal(getCopilotToken(), "");
});

test("PUT stores the token, DELETE clears it, and no response contains it", () =>
	clean(async () => {
		const gh = fakeGh({ token: undefined });
		const put = await fetch(`${baseUrl}/api/settings/copilot-token`, {
			method: "PUT",
			headers: admin(),
			body: JSON.stringify({ token: `  ${SETTINGS_TOKEN}  ` }),
		});
		assert.equal(put.status, 200);
		const putText = await put.text();
		assertNoSecret(putText);
		assert.equal(JSON.parse(putText).status.source, "settings");
		assert.equal(getCopilotToken(), SETTINGS_TOKEN);

		const get = await fetch(`${baseUrl}/api/copilot/token-status`, { headers: admin() });
		assert.equal(get.status, 200);
		const getText = await get.text();
		assertNoSecret(getText);
		assert.equal(JSON.parse(getText).status.storedInSettings, true);

		const del = await fetch(`${baseUrl}/api/settings/copilot-token`, { method: "DELETE", headers: admin() });
		assert.equal(del.status, 200);
		const delText = await del.text();
		assertNoSecret(delText);
		assert.equal(JSON.parse(delText).status.storedInSettings, false);
		assert.equal(getCopilotToken(), "");
		gh.restore();
	}));

test("PUT rejects classic ghp_, empty and whitespace-bearing tokens with 400", () =>
	clean(async () => {
		const put = (token: unknown) =>
			fetch(`${baseUrl}/api/settings/copilot-token`, { method: "PUT", headers: admin(), body: JSON.stringify({ token }) });

		const classic = await put(CLASSIC);
		assert.equal(classic.status, 400);
		const classicText = await classic.text();
		assertNoSecret(classicText);
		assert.match(classicText, /not supported/);

		assert.equal((await put("   ")).status, 400);
		assert.equal((await put(undefined)).status, 400);
		const spaced = await put("gho_abc def");
		assert.equal(spaced.status, 400);
		assertNoSecret(await spaced.text());
		assert.equal((await put("gho_abc\ndef")).status, 400);
		assert.equal(getCopilotToken(), "");
	}));

test("the stored token is not returned by any settings read route", () =>
	clean(async () => {
		saveCopilotToken(SETTINGS_TOKEN);
		for (const route of [
			"/api/settings/notifications",
			"/api/settings/notifications/slack-credentials",
			"/api/settings/shortcuts",
			"/api/settings/report",
			"/api/settings/sync",
			"/api/settings/docker-mounts",
			"/api/settings/docker-friendly",
			"/api/settings/archive",
			"/api/settings/ui",
		]) {
			const res = await fetch(`${baseUrl}${route}`, { headers: admin() });
			assertNoSecret(await res.text());
		}
	}));

test("gh-login opens a terminal with the constant command; 400 without gh; 409 without a terminal", () =>
	clean(async () => {
		const post = () => fetch(`${baseUrl}/api/copilot/gh-login`, { method: "POST", headers: admin(), body: JSON.stringify({ command: "rm -rf /", hostname: "evil.example" }) });

		const missing = fakeGh({ installed: false });
		const noGh = await post();
		assert.equal(noGh.status, 400);
		assert.match(JSON.stringify(await noGh.json()), /cli\.github\.com/);
		missing.restore();

		const spawned: string[][] = [];
		const fakeChild = () => {
			const handlers: Record<string, (...a: unknown[]) => void> = {};
			setImmediate(() => handlers.spawn?.());
			return { once: (ev: string, fn: (...a: unknown[]) => void) => void (handlers[ev] = fn), unref: () => {} };
		};
		const gh = fakeGh({ token: undefined });
		terminalImpl.platform = () => "linux";
		terminalImpl.spawn = ((bin: string, args: string[]) => {
			spawned.push([bin, ...args]);
			return fakeChild();
		}) as unknown as typeof terminalImpl.spawn;
		const ok = await post();
		assert.equal(ok.status, 202);
		assert.deepEqual(await ok.json(), { opened: true });
		assert.equal(spawned.length, 1);
		const shellCmd = spawned[0]!.at(-1)!;
		assert.ok(shellCmd.includes("gh auth login --web --hostname github.com"));
		assert.equal(shellCmd.includes("evil.example"), false);
		assert.equal(shellCmd.includes("rm -rf"), false);

		terminalImpl.spawn = (() => {
			const handlers: Record<string, (...a: unknown[]) => void> = {};
			setImmediate(() => handlers.error?.(new Error("ENOENT")));
			return { once: (ev: string, fn: (...a: unknown[]) => void) => void (handlers[ev] = fn), unref: () => {} };
		}) as unknown as typeof terminalImpl.spawn;
		const none = await post();
		assert.equal(none.status, 409);
		assert.match(JSON.stringify(await none.json()), /no terminal emulator/);
		gh.restore();
	}));
