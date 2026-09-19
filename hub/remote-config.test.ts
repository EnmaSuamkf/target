import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "target-remote-config-"));
process.env.TARGET_HOME = path.join(home, ".target");
process.env.AWB_HOME = path.join(home, ".awb");
process.env.TARGET_REPORT_URL = "https://legacy.example/ingest";
process.env.TARGET_REPORT_TOKEN = "legacy-report-token";
process.env.TARGET_REPORT_ENABLED = "true";
process.env.TARGET_SYNC_URL = "https://legacy.example";
process.env.TARGET_SYNC_TOKEN = "legacy-sync-token";
process.env.TARGET_SYNC_ENABLED = "true";

const { beginDeviceLink, activateDeviceCredential, deleteDeviceLink, setDeviceLinkRemoteState } = await import("./device-link.ts");
const { remoteAuth } = await import("./device-auth.ts");
const { loadEffectiveReportConfig, loadEffectiveSyncConfig } = await import("./remote-config.ts");
const { emit, emitHeartbeat, flush } = await import("./reporter.ts");
const { loadConfig } = await import("./config.ts");
const { runSyncTick } = await import("./sync.ts");
const { createWorkflow, renameWorkflow } = await import("./workflow.ts");
const { open, saveReportSettings, saveSyncSettings } = await import("./db.ts");
const linkedWithoutEnvFixture = JSON.parse(
	fs.readFileSync(new URL("./fixtures/linked-remote-without-env.json", import.meta.url), "utf8"),
) as {
	environment: Record<string, string>;
	origin: string;
	scopes: Array<"ingest:write" | "sync:write">;
	expected: { ingestPath: string; syncPaths: string[]; authorizationScheme: string };
};

function link(scopes: Array<"ingest:write" | "sync:write">): void {
	deleteDeviceLink();
	beginDeviceLink({ origin: "https://linked.example", deviceName: "Scope test", requestedScopes: scopes });
	activateDeviceCredential({
		deviceId: "dev_scoped",
		deviceSecret: "device-secret",
		scopes,
		credentialVersion: 1,
	});
}

test("active link derives remote services from its origin and scopes before legacy configuration", () => {
	deleteDeviceLink();
	assert.equal(loadEffectiveReportConfig().url, "https://legacy.example/ingest");
	assert.equal(loadEffectiveSyncConfig().url, "https://legacy.example");

	link(["ingest:write", "sync:write"]);
	const report = loadEffectiveReportConfig();
	const sync = loadEffectiveSyncConfig();
	assert.deepEqual(
		{ enabled: report.enabled, url: report.url, token: report.token },
		{ enabled: true, url: "https://linked.example/ingest", token: "" },
	);
	assert.equal(report.includeConversations, "full", "a linked ingest scope fixes consented reporting to full");
	assert.deepEqual(
		{ enabled: sync.enabled, url: sync.url, token: sync.token },
		{ enabled: true, url: "https://linked.example", token: "" },
	);
	assert.equal(JSON.stringify({ report, sync }).includes("device-secret"), false);
	assert.equal(JSON.stringify({ report, sync }).includes("legacy-report-token"), false);
	assert.equal(JSON.stringify({ report, sync }).includes("legacy-sync-token"), false);
});

test("linked scopes override previously saved legacy off and privacy preferences", () => {
	link(["ingest:write", "sync:write"]);
	saveReportSettings({
		enabled: false,
		url: "https://legacy.example/ingest",
		token: "legacy-report-token",
		intervalMs: 30_000,
		includeConversations: "off",
	});
	saveSyncSettings({ enabled: false });
	const report = loadEffectiveReportConfig();
	assert.equal(report.enabled, true);
	assert.equal(report.includeConversations, "full");
	assert.equal(loadEffectiveSyncConfig().enabled, true);
});

test("missing scopes and revoked links stop only the corresponding remote service", () => {
	link(["ingest:write"]);
	assert.equal(loadEffectiveReportConfig().enabled, true);
	assert.equal(loadEffectiveSyncConfig().enabled, false);
	assert.equal(remoteAuth("sync:write").kind, "blocked");

	link(["sync:write"]);
	assert.equal(loadEffectiveReportConfig().enabled, false);
	assert.equal(loadEffectiveSyncConfig().enabled, true);
	assert.equal(remoteAuth("ingest:write").kind, "blocked");

	setDeviceLinkRemoteState("relink_required");
	assert.equal(loadEffectiveReportConfig().enabled, false);
	assert.equal(loadEffectiveSyncConfig().enabled, false);

	deleteDeviceLink();
	assert.equal(loadEffectiveReportConfig().url, "https://legacy.example/ingest");
	assert.equal(loadEffectiveSyncConfig().url, "https://legacy.example");
});

test("a newly linked hub sends Activity and sync traffic with no remote environment variables", async () => {
	for (const key of Object.keys(linkedWithoutEnvFixture.environment)) delete process.env[key];
	link(linkedWithoutEnvFixture.scopes);

	emit("workflow.created", { data: { source: "linked" } });
	let ingestUrl = "";
	let ingestAuth = "";
	await flush({
		fetchImpl: async (url, init) => {
			ingestUrl = String(url);
			ingestAuth = new Headers(init.headers).get("authorization") ?? "";
			return new Response("", { status: 200 });
		},
	});
	assert.equal(ingestUrl, `${linkedWithoutEnvFixture.origin}${linkedWithoutEnvFixture.expected.ingestPath}`);
	assert.match(ingestAuth, new RegExp(`^${linkedWithoutEnvFixture.expected.authorizationScheme} dev_scoped\\.`));

	const paths: string[] = [];
	await runSyncTick({
		hubConfig: loadConfig(),
		fetchImpl: async (url) => {
			paths.push(new URL(String(url)).pathname);
			if (String(url).endsWith("/register")) return new Response(JSON.stringify({ client_id: "dev_scoped" }), { status: 201 });
			if (String(url).endsWith("/commands")) return new Response(JSON.stringify({ commands: [] }), { status: 200 });
			return new Response("{}", { status: 200 });
		},
	});
	assert.deepEqual(paths, linkedWithoutEnvFixture.expected.syncPaths);
});

test("effective linked ingest delivers pre-link, local workflow, and heartbeat events as the Sync device", async () => {
	deleteDeviceLink();
	open().prepare("DELETE FROM report_events").run();
	for (const key of Object.keys(linkedWithoutEnvFixture.environment)) delete process.env[key];

	// This event represents a durable queue entry made before device linking.
	// It is intentionally sent later under the device identity, never under a
	// second identity derived from the old local report configuration.
	emit("workflow.created", { data: { before_link: true } }, {
		enabled: true,
		url: "https://old-report.example/ingest",
		token: "old-token",
		intervalMs: 1_000,
		includeConversations: "digest",
		instanceId: "legacy-uuid",
	});
	saveReportSettings({ enabled: false, url: "", token: "", intervalMs: 1_000, includeConversations: "off" });
	link(["ingest:write", "sync:write"]);

	const effective = loadEffectiveReportConfig();
	assert.deepEqual(
		{ enabled: effective.enabled, url: effective.url, token: effective.token },
		{ enabled: true, url: "https://linked.example/ingest", token: "" },
	);

	const syncClients = new Map<string, { owner_user_id: string }>();
	await runSyncTick({
		hubConfig: loadConfig(),
		fetchImpl: async (url, init) => {
			if (new URL(String(url)).pathname === "/api/sync/register") {
				const id = (new Headers(init.headers).get("authorization") ?? "").match(/^Target-Device v1 ([^.]+)/)?.[1] ?? "";
				syncClients.set(id, { owner_user_id: "user_owner" });
				return new Response(JSON.stringify({ client_id: id }), { status: 201 });
			}
			if (String(url).endsWith("/commands")) return new Response(JSON.stringify({ commands: [] }), { status: 200 });
			return new Response("{}", { status: 200 });
		},
	});

	const workflow = createWorkflow("reported after linked");
	renameWorkflow(workflow.id, "reported after linked renamed");
	emitHeartbeat({ workflowsTotal: 1, uptimeMs: 10 });

	const events = new Map<string, { device_id: string; owner_user_id: string; kind: string }>();
	await flush({
		fetchImpl: async (url, init) => {
			assert.equal(String(url), "https://linked.example/ingest");
			const deviceId = (new Headers(init.headers).get("authorization") ?? "").match(/^Target-Device v1 ([^.]+)/)?.[1] ?? "";
			const batch = JSON.parse(String(init.body)) as { instance_id: string; events: Array<{ id: string; kind: string }> };
			assert.equal(batch.instance_id, deviceId);
			const client = syncClients.get(deviceId);
			assert.ok(client, "ingest device is the registered Sync client");
			for (const event of batch.events) {
				if (!events.has(event.id)) events.set(event.id, { device_id: deviceId, owner_user_id: client.owner_user_id, kind: event.kind });
			}
			return new Response(JSON.stringify({ accepted: batch.events.map((event) => event.id) }), { status: 200 });
		},
	});
	assert.ok([...events.values()].some((event) => event.kind === "heartbeat"));
	assert.ok([...events.values()].some((event) => event.kind === "workflow.created"));
	assert.ok([...events.values()].some((event) => event.kind === "workflow.updated"));
	assert.ok([...events.values()].every((event) => event.device_id === "dev_scoped" && event.owner_user_id === "user_owner"));
});
