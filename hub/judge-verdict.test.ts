/**
 * Tests for `parseJudgeVerdict`, which pulls the judge's closing
 * `{"ok": bool, "reason": string}` out of its free-form answer.
 *
 * The case that motivated the rewrite: a judge for an API step narrated its
 * verification with response shapes in it (`{id, name, code}`,
 * `{ items: [] }`) and put another one inside its reason
 * (`featuredProducts {id,name,code}`). Its final line was a perfectly valid
 * `{"ok": true, ...}`, yet the old regex scan (flat `{...}` blocks, then one
 * greedy `{...}` from the first brace) never produced that line as a
 * candidate, and the step failed with "judge verdict unparseable" although it
 * had PASSED. The reply below is that judge's answer, trimmed but with every
 * brace kept where it was.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { parseJudgeVerdict } from "./judge-verdict.ts";

const REAL_REPLY = [
	"I checked the artifacts directly: the diff, the route order, the handler and query code, and a fresh test and lint run.",
	"",
	"- **Featured endpoint:** `GET /shop/products/featured` (`shop/index.js:230`) is registered before `/products/:slug` (`:276`).",
	"- **`featuredProducts`:** `GET` and `PUT /config/shop` return `{id, name, code}` in saved order and skip missing or deleted products.",
	"- **Lint:** `npm run lint` exits 0.",
	"",
	'One thing outside the criterion: the step text said "no list / unknown list → `{ items: [] }`". The criterion does not cover this, so it does not change the verdict.',
	"",
	'{"ok": true, "reason": "Verified in the real repo: /products/featured is registered at shop/index.js:230. GET/PUT /config/shop return featuredProducts {id,name,code} in order. npm run lint exits 0."}',
].join("\n");

test("finds the closing verdict when the narration and the reason both contain braces", () => {
	const verdict = parseJudgeVerdict(REAL_REPLY);
	assert.ok(verdict, "the verdict on the last line must parse");
	assert.equal(verdict.ok, true);
	assert.match(verdict.reason, /featuredProducts \{id,name,code\} in order/);
});

test("a rejection with braces in its reason keeps ok: false and the full reason", () => {
	const reply = [
		"The handler returns `{ items }` but the criterion asks for `{ items: [], total }`.",
		"",
		'{"ok": false, "reason": "GET /shop/products/featured returns {items} without {total}; add total to the payload."}',
	].join("\n");
	assert.deepEqual(parseJudgeVerdict(reply), {
		ok: false,
		reason: "GET /shop/products/featured returns {items} without {total}; add total to the payload.",
	});
});

test("pure JSON, a fenced verdict and the verdict-string shape still parse", () => {
	assert.deepEqual(parseJudgeVerdict('{"ok": true, "reason": "fine"}'), { ok: true, reason: "fine" });
	assert.deepEqual(parseJudgeVerdict('Checked.\n\n```json\n{"ok": false, "reason": "no tests"}\n```\n'), {
		ok: false,
		reason: "no tests",
	});
	assert.deepEqual(parseJudgeVerdict('Done.\n{"verdict": "pass", "reason": "ok"}'), { ok: true, reason: "ok" });
	assert.deepEqual(parseJudgeVerdict('Done.\n{"verdict": "fail"}'), { ok: false, reason: "" });
});

test("a verdict that is not on the last line is still found, and the latest one wins", () => {
	const reply = [
		'The prompt\'s example was {"ok": true, "reason": "example"}.',
		'{"ok": false, "reason": "tests fail"}',
		"(That is my verdict.)",
	].join("\n");
	assert.deepEqual(parseJudgeVerdict(reply), { ok: false, reason: "tests fail" });
});

test("a brace or escaped quote inside the reason string does not end the object early", () => {
	const reply = 'Verified.\n{"ok": true, "reason": "returns \\"}\\" and {a: {b}} as documented"} trailing words';
	assert.deepEqual(parseJudgeVerdict(reply), { ok: true, reason: 'returns "}" and {a: {b}} as documented' });
});

test("returns null when there is no verdict to find", () => {
	assert.equal(parseJudgeVerdict(undefined), null);
	assert.equal(parseJudgeVerdict(""), null);
	assert.equal(parseJudgeVerdict("Looks good to me."), null);
	assert.equal(parseJudgeVerdict("Returns `{id, name, code}` and `{ items: [] }`."), null);
	assert.equal(parseJudgeVerdict('{"reason": "no ok field"}'), null);
	assert.equal(parseJudgeVerdict('{"ok": "yes", "reason": "ok is not a boolean"}'), null);
	assert.equal(parseJudgeVerdict('Cut off: {"ok": true, "reason": "unterminated'), null);
});
