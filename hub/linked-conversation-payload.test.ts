import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "target-linked-conversation-"));
process.env.HOME = home;
process.env.TARGET_HOME = path.join(home, ".target");
process.env.AWB_HOME = path.join(home, ".awb");

const { claudeProjectDir } = await import("./transcript.ts");
const { conversationSnapshotPayload } = await import("./workflow.ts");

test("full linked conversation payload contains every prose turn but no transcript machinery", () => {
	const workdir = path.join(home, "project");
	const sessionId = "linked-full";
	const file = path.join(claudeProjectDir(workdir), `${sessionId}.jsonl`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(
		file,
		[
			JSON.stringify({ type: "user", cwd: workdir, message: { role: "user", content: "FIRST HUMAN MESSAGE" } }),
			JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "FIRST ASSISTANT REPLY" }] } }),
			JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE THINKING" }] } }),
			JSON.stringify({ type: "user", message: { role: "user", content: "LAST HUMAN MESSAGE" } }),
		].join("\n"),
	);

	const payload = conversationSnapshotPayload(workdir, sessionId, "full", 3);
	assert.equal(payload.mode, "full");
	assert.equal(payload.turns, 3);
	assert.match(String(payload.text), /FIRST HUMAN MESSAGE/);
	assert.match(String(payload.text), /FIRST ASSISTANT REPLY/);
	assert.match(String(payload.text), /LAST HUMAN MESSAGE/);
	assert.doesNotMatch(String(payload.text), /PRIVATE THINKING/);
	assert.deepEqual(conversationSnapshotPayload(workdir, sessionId, "digest", 3), { turns: 3, mode: "digest" });
});
