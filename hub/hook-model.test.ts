/**
 * The workflow's chosen model lives on the AWB hook (hooks.json) as `model`.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-hook-model-"));
process.env.TARGET_HOME = tmpHome;
process.env.AWB_HOME = tmpHome;

const { createAwbHook, hookRuntime } = await import("./awb.ts");

function storedHook(name: string): Record<string, unknown> {
	const json = JSON.parse(fs.readFileSync(path.join(tmpHome, "hooks.json"), "utf8")) as {
		hooks: Record<string, Record<string, unknown>>;
	};
	return json.hooks[name]!;
}

test("createAwbHook writes model onto the hook and hookRuntime reads it back", () => {
	const { hookUrl } = createAwbHook("with-model", path.join(tmpHome, "w1"), "go", { model: "sonnet" });
	assert.equal(storedHook("with-model").model, "sonnet");
	assert.equal(hookRuntime(hookUrl).model, "sonnet");
});

test("createAwbHook omits the model key when unset and hookRuntime reports null", () => {
	const { hookUrl } = createAwbHook("no-model", path.join(tmpHome, "w2"), "go");
	assert.equal("model" in storedHook("no-model"), false);
	assert.equal(hookRuntime(hookUrl).model, null);
	const { hookUrl: emptyUrl } = createAwbHook("empty-model", path.join(tmpHome, "w3"), "go", { model: "" });
	assert.equal("model" in storedHook("empty-model"), false);
	assert.equal(hookRuntime(emptyUrl).model, null);
});
