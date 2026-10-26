/**
 * Child-process fakes for the availability probes in awb.ts. The probes run
 * through `_impl.spawn`, so a test swaps that seam for one of these: a CLI that
 * answers, a binary that isn't on PATH, or one that never returns. Shared by
 * the suites that drive the probes, and deliberately not a `*.test.ts` file.
 */
import { EventEmitter } from "node:events";
import type * as cp from "node:child_process";

/**
 * A stand-in for `ChildProcess`: an emitter with a `kill`. `onKill` runs when
 * the probe's timeout (or anything else) kills it, and gets the child so it can
 * emit the `close` a real killed process would.
 */
function fakeChild(onKill: (child: EventEmitter) => void = () => {}): cp.ChildProcess {
	const child: EventEmitter & { kill?: () => boolean } = new EventEmitter();
	child.kill = () => {
		onKill(child);
		return true;
	};
	return child as unknown as cp.ChildProcess;
}

/** A CLI that answers and exits `code` on the next tick — `0` is "installed" / "daemon up". */
export function exitingWith(code: number): cp.ChildProcess {
	const child = fakeChild();
	setImmediate(() => (child as unknown as EventEmitter).emit("close", code, null));
	return child;
}

/** A binary that isn't on PATH: spawning it emits `error` (ENOENT) and never a `close`. */
export function missingBinary(): cp.ChildProcess {
	const child = fakeChild();
	setImmediate(() => {
		(child as unknown as EventEmitter).emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
	});
	return child;
}

/** A CLI that never answers. Only the probe's timeout settles it; `kill` ends it the way a real SIGTERM does. */
export function hangingChild(): cp.ChildProcess {
	return fakeChild((self) => {
		setImmediate(() => self.emit("close", null, "SIGTERM"));
	});
}

/** A CLI that answers `code`, but only after `ms` — a probe still running while a request comes in. */
export function slowExit(ms: number, code: number): cp.ChildProcess {
	const child = fakeChild();
	setTimeout(() => (child as unknown as EventEmitter).emit("close", code, null), ms);
	return child;
}
