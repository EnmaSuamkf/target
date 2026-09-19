import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "device-link-v1.json"), "utf8")) as {
	contractVersion: string;
	initiatePath: string;
	pollPath: string;
	consumePath: string;
	protectedPaths: string[];
	deviceAuthorizationScheme: string;
	linkAuthorizationScheme: string;
	signaturePrefix: string;
	publicKeyAlgorithm: string;
};
const client = fs.readFileSync(path.join(here, "device-link-client.ts"), "utf8");
const auth = fs.readFileSync(path.join(here, "device-auth.ts"), "utf8");

test("target-server device-link/v1 fixture matches the hub wire integration", () => {
	assert.equal(fixture.contractVersion, "device-link/v1");
	assert.equal(fixture.publicKeyAlgorithm, "ed25519");
	assert.match(client, new RegExp(fixture.initiatePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.match(client, /\/api\/device-links\/requests\/\$\{encodeURIComponent\(pending\.requestId\)\}\/poll/);
	assert.match(client, /\/api\/device-links\/requests\/\$\{encodeURIComponent\(pending\.requestId\)\}\/consume/);
	assert.match(auth, new RegExp(fixture.deviceAuthorizationScheme.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.match(client, new RegExp(fixture.linkAuthorizationScheme.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.match(auth, new RegExp(fixture.signaturePrefix));
	const sync = fs.readFileSync(path.join(here, "sync.ts"), "utf8");
	const reporter = fs.readFileSync(path.join(here, "reporter.ts"), "utf8");
	assert.ok(fixture.protectedPaths.includes("/ingest"));
	assert.match(reporter, /deviceHeaders\("POST", new URL\(config\.url\)\.pathname, body\)/);
	for (const protectedPath of fixture.protectedPaths.filter((value) => value.startsWith("/api/sync/") && !value.includes(":commandId"))) {
		assert.ok(sync.includes(protectedPath));
	}
	assert.match(sync, /\/api\/sync\/commands\/\$\{command\.id\}\/ack/);
});
