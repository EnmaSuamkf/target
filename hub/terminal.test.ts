/**
 * Unit tests for terminal.ts's openResumeTerminal — the server-side spawn
 * that backs the UI's "Open conversation" button. Real terminal emulators
 * aren't installed on a CI box (and we don't want to pop windows during
 * `node --test` anyway), so every test swaps `_impl.spawn` for a fake and
 * restores it afterwards.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { _impl, NoTerminalEmulatorError, openResumeTerminal } from "./terminal.ts";

type SpawnCall = { bin: string; args: string[] };
type FakeSpawn = (bin: string, args: string[]) => { once(event: string, cb: (err?: unknown) => void): void; unref(): void };

function installFakeSpawn(fn: FakeSpawn): typeof _impl.spawn {
	return fn as unknown as typeof _impl.spawn;
}

/** A fake ChildProcess whose "spawn" listener fires synchronously with no error. */
function fakeChild() {
	return {
		once(event: string, cb: (err?: unknown) => void) {
			if (event === "spawn") cb();
		},
		unref() {},
	};
}

/** A fake ChildProcess that reports ENOENT — as if the binary weren't on PATH. */
function missingChild() {
	return {
		once(event: string, cb: (err?: unknown) => void) {
			if (event === "error") cb(Object.assign(new Error("not found"), { code: "ENOENT" }));
		},
		unref() {},
	};
}

test("openResumeTerminal launches the first candidate emulator, cd'd into workdir, running the resume command", async (t) => {
	const calls: SpawnCall[] = [];
	const original = _impl.spawn;
	t.after(() => {
		_impl.spawn = original;
	});
	_impl.spawn = installFakeSpawn((bin, args) => {
		calls.push({ bin, args });
		return fakeChild();
	});

	await openResumeTerminal("/home/user/project", "claude --resume 'sess-123'");

	assert.equal(calls.length, 1);
	assert.equal(calls[0].bin, "x-terminal-emulator");
	assert.deepEqual(calls[0].args.slice(0, 2), ["-e", "bash"]);
	assert.equal(calls[0].args[2], "-c");
	assert.equal(calls[0].args[3], "cd '/home/user/project' && claude --resume 'sess-123'; exec bash");
});

test("openResumeTerminal single-quote-escapes a workdir containing an embedded quote", async (t) => {
	const calls: SpawnCall[] = [];
	const original = _impl.spawn;
	t.after(() => {
		_impl.spawn = original;
	});
	_impl.spawn = installFakeSpawn((bin, args) => {
		calls.push({ bin, args });
		return fakeChild();
	});

	await openResumeTerminal("/home/user/O'Brien's project", "claude --resume 'sess-1'");

	assert.equal(calls[0].args[3], "cd '/home/user/O'\\''Brien'\\''s project' && claude --resume 'sess-1'; exec bash");
});

test("openResumeTerminal falls back to the next candidate when an earlier one is missing (ENOENT)", async (t) => {
	const attempted: string[] = [];
	const original = _impl.spawn;
	t.after(() => {
		_impl.spawn = original;
	});
	_impl.spawn = installFakeSpawn((bin) => {
		attempted.push(bin);
		return bin === "konsole" ? fakeChild() : missingChild();
	});

	await openResumeTerminal("/wd", "claude --resume 'sess-1'");

	assert.deepEqual(attempted, ["x-terminal-emulator", "gnome-terminal", "konsole"]);
});

test("openResumeTerminal throws NoTerminalEmulatorError when every candidate is missing", async (t) => {
	const original = _impl.spawn;
	t.after(() => {
		_impl.spawn = original;
	});
	_impl.spawn = installFakeSpawn(() => missingChild());

	await assert.rejects(() => openResumeTerminal("/wd", "claude --resume 'sess-1'"), NoTerminalEmulatorError);
});
