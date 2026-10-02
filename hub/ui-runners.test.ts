/**
 * The UI's runner list must stay in step with the hub's: a runner the server
 * accepts but the create form can't offer (or whose image hint is wrong) is
 * unreachable from the page. The UI can't import hub/awb.ts, so this compares
 * the two sources.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { DEFAULT_SANDBOX_IMAGES, PUBLISHABLE_RUNNERS, RUNNER_BINARIES } from "./awb.ts";

const types = fs.readFileSync(new URL("./ui/src/api/types.ts", import.meta.url), "utf8");
const modal = fs.readFileSync(new URL("./ui/src/views/CreateWorkflowModal.tsx", import.meta.url), "utf8");

test("the UI RUNNERS tuple lists exactly the hub's publishable runners", () => {
	const m = types.match(/export const RUNNERS = \[([^\]]*)\] as const/);
	assert.ok(m);
	const ui = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
	assert.deepEqual(ui, [...PUBLISHABLE_RUNNERS]);
});

test("the create form offers copilot with its image, Dockerfile and binary", () => {
	assert.match(modal, /value: "copilot",\s*label: "GitHub Copilot"/);
	assert.ok(modal.includes(`copilot: "${DEFAULT_SANDBOX_IMAGES.copilot}"`));
	assert.ok(modal.includes('copilot: "Dockerfile.copilot"'));
	assert.ok(modal.includes(`copilot: "${RUNNER_BINARIES.copilot}"`));
	assert.match(modal, /`copilot`/, "the no-agent message names copilot");
});

test("the image hint reads from the DOCKERFILES/BINARIES maps, not a runner ternary", () => {
	assert.ok(modal.includes("DOCKERFILES[runner]") && modal.includes("BINARIES[runner]"));
	assert.ok(!/runner === "cursor" \?/.test(modal));
});
