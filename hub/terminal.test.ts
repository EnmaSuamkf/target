/**
 * Unit tests for terminal.ts's openResumeTerminal — the server-side spawn
 * that backs the UI's "Open conversation" button. Real terminal emulators
 * aren't installed on a CI box (and we don't want to pop windows during
 * `node --test` anyway), so every test swaps `_impl.spawn` for a fake and
 * restores it afterwards.
 *
 * The launch is planned per OS, and the tests have to cover all three
 * regardless of which one they run on, so `_impl.platform` is faked too —
 * as is `_impl.writeScript`, since the macOS and Windows plans write a script
 * to disk and the tests want to assert on its *contents*, not create files.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { _impl, NoTerminalEmulatorError, openResumeTerminal } from "./terminal.ts";

type SpawnCall = { bin: string; args: string[] };
type FakeSpawn = (bin: string, args: string[]) => { once(event: string, cb: (err?: unknown) => void): void; unref(): void };
type WrittenScript = { contents: string; ext: string };

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

/** A fake ChildProcess that spawns fine and then exits with `code` — for `open`-style launchers. */
function exitingChild(code: number) {
	return {
		once(event: string, cb: (arg?: unknown) => void) {
			if (event === "exit") cb(code);
		},
		unref() {},
	};
}

/**
 * Pins the platform, records every spawn, and records every script written,
 * restoring all three fakes when the test ends.
 */
function harness(t: { after(fn: () => void): void }, platform: NodeJS.Platform, spawnFn: FakeSpawn) {
	const calls: SpawnCall[] = [];
	const scripts: WrittenScript[] = [];
	const original = { spawn: _impl.spawn, platform: _impl.platform, writeScript: _impl.writeScript };
	t.after(() => {
		_impl.spawn = original.spawn;
		_impl.platform = original.platform;
		_impl.writeScript = original.writeScript;
	});
	_impl.platform = () => platform;
	_impl.writeScript = async (contents: string, ext: string) => {
		scripts.push({ contents, ext });
		return `/tmp/target-resume-test${ext}`;
	};
	_impl.spawn = installFakeSpawn((bin, args) => {
		calls.push({ bin, args });
		return spawnFn(bin, args);
	});
	return { calls, scripts };
}

test("openResumeTerminal launches the first candidate emulator, cd'd into workdir, running the resume command", async (t) => {
	const { calls } = harness(t, "linux", () => fakeChild());

	await openResumeTerminal("/home/user/project", "claude --resume 'sess-123'");

	assert.equal(calls.length, 1);
	assert.equal(calls[0].bin, "x-terminal-emulator");
	assert.deepEqual(calls[0].args.slice(0, 2), ["-e", "bash"]);
	assert.equal(calls[0].args[2], "-c");
	assert.equal(calls[0].args[3], "cd '/home/user/project' && claude --resume 'sess-123'; exec bash");
});

test("openResumeTerminal single-quote-escapes a workdir containing an embedded quote", async (t) => {
	const { calls } = harness(t, "linux", () => fakeChild());

	await openResumeTerminal("/home/user/O'Brien's project", "claude --resume 'sess-1'");

	assert.equal(calls[0].args[3], "cd '/home/user/O'\\''Brien'\\''s project' && claude --resume 'sess-1'; exec bash");
});

test("openResumeTerminal falls back to the next candidate when an earlier one is missing (ENOENT)", async (t) => {
	const { calls } = harness(t, "linux", (bin) => (bin === "konsole" ? fakeChild() : missingChild()));

	await openResumeTerminal("/wd", "claude --resume 'sess-1'");

	assert.deepEqual(
		calls.map((c) => c.bin),
		["x-terminal-emulator", "gnome-terminal", "konsole"],
	);
});

test("openResumeTerminal throws NoTerminalEmulatorError when every candidate is missing", async (t) => {
	harness(t, "linux", () => missingChild());

	await assert.rejects(() => openResumeTerminal("/wd", "claude --resume 'sess-1'"), NoTerminalEmulatorError);
});

test("openResumeTerminal writes no script on linux — the command goes straight to the emulator's argv", async (t) => {
	const { scripts } = harness(t, "linux", () => fakeChild());

	await openResumeTerminal("/wd", "claude --resume 'sess-1'");

	assert.deepEqual(scripts, []);
});

test("openResumeTerminal on macOS opens Terminal.app on an executable .command script", async (t) => {
	const { calls, scripts } = harness(t, "darwin", () => exitingChild(0));

	await openResumeTerminal("/Users/u/project", "claude --resume 'sess-123'");

	assert.equal(scripts.length, 1);
	assert.equal(scripts[0].ext, ".command");
	assert.equal(
		scripts[0].contents,
		`#!/bin/bash\ncd '/Users/u/project' && claude --resume 'sess-123'\nexec "\${SHELL:-/bin/bash}"\n`,
	);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].bin, "open");
	assert.deepEqual(calls[0].args, ["-a", "Terminal", "/tmp/target-resume-test.command"]);
});

test("openResumeTerminal on macOS quote-escapes a workdir containing an embedded quote", async (t) => {
	const { scripts } = harness(t, "darwin", () => exitingChild(0));

	await openResumeTerminal("/Users/u/O'Brien", "claude --resume 'sess-1'");

	assert.match(scripts[0].contents, /^cd '\/Users\/u\/O'\\''Brien' && /m);
});

test("openResumeTerminal on macOS falls back to iTerm when Terminal.app is absent — `open` exiting nonzero, not failing to spawn", async (t) => {
	// `open` is always present on macOS, so a clean spawn proves nothing about
	// whether the app it was asked for exists; only the exit status does.
	const { calls } = harness(t, "darwin", (_bin, args) => exitingChild(args.includes("iTerm") ? 0 : 1));

	await openResumeTerminal("/wd", "claude --resume 'sess-1'");

	assert.deepEqual(
		calls.map((c) => c.args[1]),
		["Terminal", "iTerm"],
	);
});

test("openResumeTerminal on macOS reports the apps it tried, not the `open` binary", async (t) => {
	harness(t, "darwin", () => exitingChild(1));

	await assert.rejects(
		() => openResumeTerminal("/wd", "claude --resume 'sess-1'"),
		(err: Error) => {
			assert.ok(err instanceof NoTerminalEmulatorError);
			assert.match(err.message, /tried Terminal\.app, iTerm\.app/);
			return true;
		},
	);
});

test("openResumeTerminal on Windows runs the resume through PowerShell, which keeps POSIX single quotes intact", async (t) => {
	const { calls, scripts } = harness(t, "win32", () => fakeChild());

	await openResumeTerminal("C:\\Users\\u\\project", "claude --resume 'sess-123'");

	assert.equal(scripts.length, 1);
	assert.equal(scripts[0].ext, ".ps1");
	assert.equal(scripts[0].contents, "Set-Location -LiteralPath 'C:\\Users\\u\\project'\r\nclaude --resume 'sess-123'\r\n");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].bin, "wt.exe");
	assert.deepEqual(calls[0].args, [
		"-d",
		"C:\\Users\\u\\project",
		"powershell.exe",
		"-NoExit",
		"-ExecutionPolicy",
		"Bypass",
		"-File",
		"/tmp/target-resume-test.ps1",
	]);
});

test("openResumeTerminal on Windows PowerShell-quotes a workdir containing an embedded quote", async (t) => {
	const { scripts } = harness(t, "win32", () => fakeChild());

	await openResumeTerminal("C:\\Users\\O'Brien", "claude --resume 'sess-1'");

	assert.match(scripts[0].contents, /^Set-Location -LiteralPath 'C:\\Users\\O''Brien'/);
});

test("openResumeTerminal on Windows falls back to `cmd /c start` when Windows Terminal is absent", async (t) => {
	const { calls } = harness(t, "win32", (bin) => (bin === "wt.exe" ? missingChild() : fakeChild()));

	await openResumeTerminal("C:\\wd", "claude --resume 'sess-1'");

	assert.deepEqual(
		calls.map((c) => c.bin),
		["wt.exe", "cmd.exe"],
	);
	// `start` is what allocates the new console window; the empty string is its
	// title argument, without which `start` would eat the quoted command as one.
	assert.deepEqual(calls[1].args, [
		"/c",
		"start",
		"",
		"powershell.exe",
		"-NoExit",
		"-ExecutionPolicy",
		"Bypass",
		"-File",
		"/tmp/target-resume-test.ps1",
	]);
});
