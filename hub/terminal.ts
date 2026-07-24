/**
 * Spawns a terminal emulator on this machine to run a harness resume command
 * in a workflow's workdir — the server-side half of the UI's "Open
 * conversation" button. Only makes sense because the hub is a local
 * single-user tool (see hub/ui/index.html's "Local single-user tool" note):
 * the browser can't open an OS terminal window itself, so the server does it
 * on the operator's own machine.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { shellQuote } from "./awb.ts";

// Indirection so tests can swap in a fake without touching real terminal
// emulators (there usually aren't any on a CI box, and we don't want to pop
// windows during `node --test` anyway).
export const _impl = { spawn: nodeSpawn };

export class NoTerminalEmulatorError extends Error {}

interface TerminalCandidate {
	bin: string;
	/** Args to run `shellCmd` under this emulator — passed as argv, not through a shell. */
	args: (shellCmd: string) => string[];
}

// Preference order: try each in turn until one is actually present. `-e`/`--`
// here all take the *rest* of argv as a program+args to exec, not one string
// — that's why "bash", "-c", shellCmd are three separate elements, not one.
const TERMINAL_CANDIDATES: TerminalCandidate[] = [
	{ bin: "x-terminal-emulator", args: (cmd) => ["-e", "bash", "-c", cmd] },
	{ bin: "gnome-terminal", args: (cmd) => ["--", "bash", "-c", cmd] },
	{ bin: "konsole", args: (cmd) => ["-e", "bash", "-c", cmd] },
	{ bin: "xterm", args: (cmd) => ["-e", "bash", "-c", cmd] },
];

/** Tries to launch one candidate; resolves false (never rejects) on ENOENT/spawn failure. */
function trySpawn(bin: string, args: string[]): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		let child: ChildProcess;
		try {
			child = _impl.spawn(bin, args, { detached: true, stdio: "ignore" });
		} catch {
			resolve(false);
			return;
		}
		child.once("error", () => {
			if (settled) return;
			settled = true;
			resolve(false);
		});
		child.once("spawn", () => {
			if (settled) return;
			settled = true;
			// detached + unref: the terminal is a real desktop window the user
			// keeps around after this request returns, so it must survive the
			// hub process exiting, not get killed with it.
			child.unref();
			resolve(true);
		});
	});
}

/**
 * Opens a terminal in `workdir` running `resumeCommand`, trying each known
 * emulator until one launches. `; exec bash` keeps the window open once the
 * harness exits instead of dropping the user back to a dead terminal.
 * Throws NoTerminalEmulatorError if none of the candidates are available.
 */
export async function openResumeTerminal(workdir: string, resumeCommand: string): Promise<void> {
	const shellCmd = `cd ${shellQuote(workdir)} && ${resumeCommand}; exec bash`;
	for (const candidate of TERMINAL_CANDIDATES) {
		if (await trySpawn(candidate.bin, candidate.args(shellCmd))) return;
	}
	throw new NoTerminalEmulatorError(
		`no terminal emulator found (tried ${TERMINAL_CANDIDATES.map((c) => c.bin).join(", ")})`,
	);
}
