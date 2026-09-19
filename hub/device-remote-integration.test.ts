import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "target-device-remote-"));
process.env.TARGET_HOME = path.join(home, ".target");
process.env.AWB_HOME = path.join(home, ".awb");
const { beginDeviceLink, activateDeviceCredential, getDeviceCredential, getDeviceLinkStatus } = await import("./device-link.ts");
const { emit, emitHeartbeat, flush } = await import("./reporter.ts");
const { open, pendingReportCount } = await import("./db.ts");
const { listWorkflows } = await import("./db.ts");
const { loadConfig } = await import("./config.ts");
const { runSyncTick } = await import("./sync.ts");

function link(): void {
	beginDeviceLink({ origin: "https://server.example", deviceName: "Integration hub" });
	activateDeviceCredential({
		deviceId: "dev_integration",
		deviceSecret: "secret",
		scopes: ["ingest:write", "sync:write"],
		credentialVersion: 1,
	});
}

function clearReportQueue(): void {
	open().prepare("DELETE FROM report_events").run();
}

const LINKED_REPORT_CONFIG = {
	enabled: true,
	url: "https://server.example/ingest",
	token: "",
	intervalMs: 1_000,
	includeConversations: "full" as const,
	instanceId: null,
};

test("reporting uses signed device headers, preserves idempotent queue on revocation", async () => {
	link();
	emit("workflow.created", { data: { ok: true } }, {
		enabled: true, url: "https://server.example/ingest", token: "legacy-must-not-send", intervalMs: 1_000, includeConversations: "off", instanceId: null,
	});
	let headers: Headers | undefined;
	await flush({
		config: { enabled: true, url: "https://server.example/ingest", token: "legacy-must-not-send", intervalMs: 1_000, includeConversations: "off", instanceId: null },
		fetchImpl: async (_url, init) => {
			headers = new Headers(init.headers);
			return new Response(JSON.stringify({ error: "device_revoked" }), { status: 401 });
		},
	});
	assert.match(headers!.get("authorization") ?? "", /^Target-Device v1 dev_integration\./);
	assert.ok(headers!.get("x-target-signature"));
	assert.equal(headers!.get("authorization")?.includes("legacy-must-not-send"), false);
	assert.equal(getDeviceLinkStatus().state, "relink_required");
	assert.equal(pendingReportCount(), 1, "local queue survives revocation");
});

test("sync registers a device client, then receives and applies remote work without a Bearer token", async () => {
	// Fresh active identity after the prior test's revoked state.
	link();
	const seen: Headers[] = [];
	let registration: { capabilities?: { commands?: string[]; runners?: unknown[] } } | null = null;
	const clients = new Map<string, { capabilities: unknown; heartbeats: number }>();
	await runSyncTick({
		hubConfig: loadConfig(),
		config: { enabled: true, url: "https://server.example", token: "legacy-must-not-send", intervalMs: 5_000 },
		fetchImpl: async (url, init) => {
			const pathname = new URL(String(url)).pathname;
			seen.push(new Headers(init.headers));
			if (pathname === "/api/sync/register") {
				const payload = JSON.parse(String(init.body)) as { capabilities?: { commands?: string[]; runners?: unknown[] } };
				registration = payload;
				const deviceId = (new Headers(init.headers).get("authorization") ?? "").match(/^Target-Device v1 ([^.]+)/)?.[1] ?? "";
				const client = clients.get(deviceId) ?? { capabilities: null, heartbeats: 0 };
				client.capabilities = payload.capabilities ?? null;
				clients.set(deviceId, client);
				return new Response(JSON.stringify({ client_id: deviceId }), { status: 201 });
			}
			if (pathname === "/api/sync/heartbeat") {
				clients.get("dev_integration")!.heartbeats += 1;
				return new Response("{}", { status: 200 });
			}
			if (pathname === "/api/sync/commands") return new Response(JSON.stringify({ commands: [{
				id: "cmd_device_create", type: "workflow.create", remote_id: "rw_device", sequence: 1, status: "pending",
				payload: { name: "Created by linked device", agent: "claude", sandbox: "host" },
			}] }), { status: 200 });
			return new Response(JSON.stringify({ accepted: [] }), { status: 200 });
		},
	});
	assert.ok(seen.length >= 4);
	for (const headers of seen) {
		assert.match(headers.get("authorization") ?? "", /^Target-Device v1 dev_integration\./);
		assert.ok(headers.get("x-target-signature"));
		assert.equal(headers.get("authorization")?.includes("legacy-must-not-send"), false);
	}
	assert.equal(listWorkflows().some((workflow) => workflow.remoteId === "rw_device"), true);
	const registered = registration as { capabilities?: { commands?: string[]; runners?: unknown[] } } | null;
	assert.ok(registered?.capabilities?.commands?.includes("workflow.create"));
	assert.ok(Array.isArray(registered?.capabilities?.runners));
	assert.deepEqual([...clients.keys()], ["dev_integration"]);
	assert.equal(clients.get("dev_integration")!.heartbeats, 1);

	// target-server upserts by device_id: another tick updates the same row
	// instead of creating a duplicate client.
	await runSyncTick({
		hubConfig: loadConfig(),
		config: { enabled: true, url: "https://server.example", token: "", intervalMs: 5_000 },
		fetchImpl: async (url, init) => {
			const pathname = new URL(String(url)).pathname;
			if (pathname === "/api/sync/register") {
				const deviceId = (new Headers(init.headers).get("authorization") ?? "").match(/^Target-Device v1 ([^.]+)/)?.[1] ?? "";
				const client = clients.get(deviceId) ?? { capabilities: null, heartbeats: 0 };
				clients.set(deviceId, client);
				return new Response(JSON.stringify({ client_id: deviceId }), { status: 200 });
			}
			if (pathname === "/api/sync/heartbeat") { clients.get("dev_integration")!.heartbeats += 1; return new Response("{}", { status: 200 }); }
			if (pathname === "/api/sync/commands") return new Response(JSON.stringify({ commands: [] }), { status: 200 });
			return new Response(JSON.stringify({ accepted: [] }), { status: 200 });
		},
	});
	assert.equal(clients.size, 1);
	assert.equal(clients.get("dev_integration")!.heartbeats, 2);
});

test("explicit device revocation 401 requires relinking and does not fall back to legacy sync", async () => {
	link();
	let requests = 0;
	await assert.rejects(
		runSyncTick({
			hubConfig: loadConfig(),
			config: { enabled: true, url: "https://server.example", token: "legacy-must-not-send", intervalMs: 5_000 },
			fetchImpl: async () => {
				requests += 1;
				return new Response(JSON.stringify({ error: "device_revoked" }), { status: 401 });
			},
		}),
		/sync register failed \(401\)/,
	);
	assert.equal(requests, 1);
	assert.equal(getDeviceLinkStatus().state, "relink_required");
});

test("explicit invalid device secret 403 requires relinking and does not retry with legacy credentials", async () => {
	link();
	let requests = 0;
	await assert.rejects(
		runSyncTick({
			hubConfig: loadConfig(),
			config: { enabled: true, url: "https://server.example", token: "legacy-must-not-send", intervalMs: 5_000 },
			fetchImpl: async () => {
				requests += 1;
				return new Response(JSON.stringify({ error: "invalid_device_secret" }), { status: 403 });
			},
		}),
		/sync register failed \(403\)/,
	);
	assert.equal(requests, 1);
	assert.equal(getDeviceLinkStatus().state, "relink_required");
});

test("ambiguous 401 and 403 registration failures preserve identity and retry", async () => {
	for (const status of [401, 403]) {
		link();
		await assert.rejects(
			runSyncTick({
				hubConfig: loadConfig(),
				config: { enabled: true, url: "https://server.example", token: "", intervalMs: 5_000 },
				fetchImpl: async () => new Response(JSON.stringify({ error: "signature_validation_failed" }), { status }),
			}),
			new RegExp(`sync register failed \\(${status}\\)`),
		);
		assert.equal(getDeviceLinkStatus().state, "temporarily_disconnected");
		assert.equal(getDeviceLinkStatus().reason, "sync_registration_failed");
	}

	await runSyncTick({
		hubConfig: loadConfig(),
		config: { enabled: true, url: "https://server.example", token: "", intervalMs: 5_000 },
		fetchImpl: async (url) => {
			if (String(url).endsWith("/register")) return new Response(JSON.stringify({ client_id: "dev_integration" }), { status: 200 });
			if (String(url).endsWith("/commands")) return new Response(JSON.stringify({ commands: [] }), { status: 200 });
			return new Response("{}", { status: 200 });
		},
	});
	assert.equal(getDeviceLinkStatus().state, "connected");
});

test("registration timeout and 5xx preserve the linked identity for retry", async () => {
	for (const failure of [
		async () => { throw new Error("timeout"); },
		async () => new Response("", { status: 503 }),
	]) {
		link();
		await assert.rejects(
			runSyncTick({
				hubConfig: loadConfig(),
				config: { enabled: true, url: "https://server.example", token: "", intervalMs: 5_000 },
				fetchImpl: failure,
			}),
		);
		assert.equal(getDeviceLinkStatus().state, "temporarily_disconnected");
	}
});

test("persisted temporarily disconnected identity registers the same client after a daemon restart", async () => {
	link();
	await assert.rejects(
		runSyncTick({
			hubConfig: loadConfig(),
			config: { enabled: true, url: "https://server.example", token: "", intervalMs: 5_000 },
			fetchImpl: async () => { throw new Error("timeout"); },
		}),
	);
	const identityPath = path.join(String(process.env.TARGET_HOME), "device-link.json");
	const persisted = fs.readFileSync(identityPath, "utf8");
	assert.match(persisted, /"deviceId":"dev_integration"/);
	assert.equal(getDeviceLinkStatus().state, "temporarily_disconnected", "state read after restart comes from disk");

	const clients = new Set<string>();
	await runSyncTick({
		hubConfig: loadConfig(),
		config: { enabled: true, url: "https://server.example", token: "", intervalMs: 5_000 },
		fetchImpl: async (url, init) => {
			const pathname = new URL(String(url)).pathname;
			if (pathname === "/api/sync/register") {
				const id = (new Headers(init.headers).get("authorization") ?? "").match(/^Target-Device v1 ([^.]+)/)?.[1] ?? "";
				clients.add(id);
				return new Response(JSON.stringify({ client_id: id }), { status: 200 });
			}
			if (pathname === "/api/sync/commands") return new Response(JSON.stringify({ commands: [] }), { status: 200 });
			return new Response("{}", { status: 200 });
		},
	});
	assert.deepEqual([...clients], ["dev_integration"]);
	assert.equal(getDeviceLinkStatus().state, "connected");
});

test("linked ingest attributes heartbeat and workflow activity to its device and retries idempotently", async () => {
	clearReportQueue();
	link();
	emitHeartbeat({ workflowsTotal: 1, uptimeMs: 10 }, LINKED_REPORT_CONFIG);
	emit("workflow.updated", { workflowId: "local-or-remote-workflow", data: { source: "remote" } }, LINKED_REPORT_CONFIG);

	const events = new Map<string, { device_id: string; owner_user_id: string; kind: string }>();
	const clientActivity = new Map<string, string[]>();
	let calls = 0;
	const serverIngest = async (_url: string, init: RequestInit): Promise<Response> => {
		calls++;
		const authorization = new Headers(init.headers).get("authorization") ?? "";
		const deviceId = authorization.match(/^Target-Device v1 ([^.]+)/)?.[1];
		assert.equal(deviceId, "dev_integration");
		const batch = JSON.parse(String(init.body)) as {
			instance_id: string;
			events: Array<{ id: string; kind: string }>;
		};
		// target-server's device-auth ingest contract: identity must agree.
		if (batch.instance_id !== deviceId) {
			return new Response(JSON.stringify({ error: "device_identity_mismatch" }), { status: 403 });
		}
		for (const event of batch.events) {
			// Model target-server's unique event id and owner/device attribution.
			if (!events.has(event.id)) events.set(event.id, { device_id: deviceId!, owner_user_id: "user_owner", kind: event.kind });
		}
		clientActivity.set(deviceId!, [...events.values()].filter((event) => event.device_id === deviceId).map((event) => event.kind));
		if (calls === 1) throw new Error("response lost after server persisted events");
		return new Response(JSON.stringify({ accepted: batch.events.map((event) => event.id) }), { status: 200 });
	};

	const first = await flush({ config: LINKED_REPORT_CONFIG, fetchImpl: serverIngest, now: () => 0 });
	assert.equal(first.retried, 2);
	const second = await flush({ config: LINKED_REPORT_CONFIG, fetchImpl: serverIngest, now: () => Number.MAX_SAFE_INTEGER });
	assert.equal(second.delivered, 2);
	assert.equal(events.size, 2, "retry does not duplicate target-server events");
	assert.deepEqual([...events.values()].map((event) => event.device_id), ["dev_integration", "dev_integration"]);
	assert.deepEqual([...events.values()].map((event) => event.owner_user_id), ["user_owner", "user_owner"]);
	assert.deepEqual(clientActivity.get("dev_integration")?.sort(), ["heartbeat", "workflow.updated"]);
});

test("device identity mismatch preserves the local credential and reports a sanitized integration error", async () => {
	clearReportQueue();
	link();
	emit("workflow.created", { data: {} }, LINKED_REPORT_CONFIG);
	const logs: string[] = [];
	const result = await flush({
		config: LINKED_REPORT_CONFIG,
		fetchImpl: async () => new Response(JSON.stringify({ error: "device_identity_mismatch" }), { status: 403 }),
		log: (message) => logs.push(message),
	});
	assert.equal(result.retried, 1);
	assert.equal(getDeviceLinkStatus().state, "connected");
	assert.equal(getDeviceCredential()?.deviceId, "dev_integration");
	assert.match(logs.join("\n"), /device identity mismatch at \/ingest/);
	assert.doesNotMatch(logs.join("\n"), /secret|Target-Device|signature/i);
});
