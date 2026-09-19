import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "target-device-auth-"));
process.env.TARGET_HOME = path.join(home, ".target");
const { beginDeviceLink, activateDeviceCredential, getDeviceCredential, getDeviceLinkStatus } = await import("./device-link.ts");
const { deviceHeaders, handleDeviceAuthResponse, remoteAuth } = await import("./device-auth.ts");

test("shared headers sign exact device-authenticated request body", () => {
	const started = beginDeviceLink({ origin: "https://server.example", deviceName: "Signer" });
	activateDeviceCredential({
		deviceId: "dev_signer",
		deviceSecret: "device-secret",
		scopes: ["ingest:write", "sync:write"],
		credentialVersion: 1,
	});
	const body = '{"batch_id":"b1"}';
	const headers = deviceHeaders("POST", "/ingest", body)!;
	const credential = getDeviceCredential()!;
	const canonical = [
		"target-device-v1",
		"POST",
		"/ingest",
		crypto.createHash("sha256").update(body).digest("hex"),
		headers["x-target-date"],
		headers["x-target-nonce"],
		credential.deviceId,
	].join("\n");
	const publicKey = crypto.createPublicKey(credential.privateKeyPem);
	assert.ok(crypto.verify(null, Buffer.from(canonical), publicKey, Buffer.from(headers["x-target-signature"], "base64url")));
	assert.equal(headers.authorization, "Target-Device v1 dev_signer.device-secret");
	assert.equal(remoteAuth().kind, "device");
	assert.ok(started.idempotencyKey.length >= 40);
});

test("explicit revocation stops only remote transport and requires relinking", () => {
	assert.equal(handleDeviceAuthResponse(401, "device_revoked"), true);
	assert.equal(getDeviceLinkStatus().state, "relink_required");
	assert.equal(remoteAuth().kind, "blocked");
	assert.equal(handleDeviceAuthResponse(500), false);
});
