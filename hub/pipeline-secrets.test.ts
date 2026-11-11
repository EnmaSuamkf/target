/**
 * Tests for pipeline-secrets.ts: names, values, what list returns, and the
 * resolve step a run depends on. Own throwaway TARGET_HOME, set before db.ts is
 * imported.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-pipeline-secrets-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const { redactSecrets } = await import("./redact.ts");
const { deleteSecret, listSecrets, PipelineSecretError, resolveSecrets, secretIsSet, setSecret } = await import(
	"./pipeline-secrets.ts"
);

// Long enough to be registered by the redactor (it ignores shorter values).
const VALUE = "super-secret-value-123456";

function codeOf(fn: () => unknown): string {
	try {
		fn();
	} catch (err) {
		if (err instanceof PipelineSecretError) return err.code;
		throw err;
	}
	throw new Error("expected a PipelineSecretError");
}

test("setSecret stores a value; the name is listed as set", () => {
	const info = setSecret("API_TOKEN", VALUE);
	assert.equal(info.name, "API_TOKEN");
	assert.equal(info.isSet, true);
	assert.equal(secretIsSet("API_TOKEN"), true);
	assert.equal(secretIsSet("NOT_SET"), false);
});

test("secrets are never listed: list returns names and timestamps, not values", () => {
	setSecret("LISTED_NAME", VALUE);
	const listed = listSecrets();
	const serialized = JSON.stringify(listed);
	assert.ok(listed.some((s) => s.name === "LISTED_NAME"));
	assert.ok(!serialized.includes(VALUE), "the value is not in the list payload");
	for (const entry of listed) {
		assert.deepEqual(Object.keys(entry).sort(), ["isSet", "name", "updatedAt"], "no value-carrying key");
	}
});

test("secret names are validated: upper-case, digits and underscore, not starting with a digit", () => {
	for (const bad of ["lower", "1LEADING_DIGIT", "HAS-DASH", "HAS SPACE", "", "a.b"]) {
		assert.equal(codeOf(() => setSecret(bad, VALUE)), "invalid_name", JSON.stringify(bad));
	}
	for (const good of ["TOKEN", "_PRIVATE", "API_KEY_2"]) {
		assert.equal(setSecret(good, VALUE).name, good);
	}
});

test("an empty value is refused", () => {
	assert.equal(codeOf(() => setSecret("EMPTY_ONE", "")), "empty_value");
});

test("setSecret replaces an existing value", () => {
	setSecret("REPLACED", VALUE);
	setSecret("REPLACED", "another-value-abcdef");
	const resolved = resolveSecrets(["REPLACED"]);
	assert.equal(resolved.REPLACED, "another-value-abcdef");
});

test("resolveSecrets returns the values and registers them, so their echoes are masked", () => {
	setSecret("RESOLVED_TOKEN", "resolved-value-zyx987");
	const resolved = resolveSecrets(["RESOLVED_TOKEN"]);
	assert.equal(resolved.RESOLVED_TOKEN, "resolved-value-zyx987");
	assert.equal(redactSecrets("the log said resolved-value-zyx987 here"), "the log said *** here");
});

test("resolveSecrets refuses a missing name with the message the executor reports", () => {
	let caught: unknown = null;
	try {
		resolveSecrets(["NEVER_SET_ANYWHERE"]);
	} catch (err) {
		caught = err;
	}
	assert.ok(caught instanceof PipelineSecretError);
	assert.equal(caught.code, "missing_secret");
	assert.equal(caught.message, "missing secret: NEVER_SET_ANYWHERE");
});

test("resolveSecrets with no names returns an empty map", () => {
	assert.deepEqual(resolveSecrets([]), {});
});

test("deleteSecret removes the value and the name", () => {
	setSecret("GOING_AWAY", VALUE);
	assert.equal(deleteSecret("GOING_AWAY"), true);
	assert.equal(secretIsSet("GOING_AWAY"), false);
	assert.equal(deleteSecret("GOING_AWAY"), false);
	assert.equal(codeOf(() => resolveSecrets(["GOING_AWAY"])), "missing_secret");
});
