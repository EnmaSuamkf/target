/**
 * Which address a *sandboxed* agent should use to reach this hub.
 *
 * A step with `--sandbox docker` runs inside a container on the default bridge
 * network. `127.0.0.1` in there is the container itself, so every hub url the
 * prompt hands the agent — the TCP execute endpoint, and awb's own result and
 * started callbacks — points at nothing. The symptom is not a clean error
 * either: the agent gets a connection refused, concludes the hub "isn't
 * running", and goes off inventing its own way to do the job.
 *
 * From inside a default-bridge container the host is the bridge gateway, which
 * is the host's own address on `docker0`. Docker Desktop (macOS, Windows)
 * publishes `host.docker.internal` for the same thing; on Linux the broker
 * passes `--add-host=host.docker.internal:host-gateway` on every sandboxed
 * `docker run`, so this hostname resolves there too.
 *
 * Knowing the address is only half of it: the hub also has to be LISTENING on
 * something the container can reach. Bound to `127.0.0.1` (the default, and the
 * right default for a single-user local tool) it will refuse the connection
 * however correct the url is — see `hubReachableFromSandbox`, which the
 * dispatcher uses to say so out loud instead of letting the agent discover it.
 */
import * as os from "node:os";

/** Bridge interfaces docker creates: the default one, plus per-network `br-<id>`. */
const BRIDGE_PREFIXES = ["docker0", "br-"];

/**
 * The host's address as seen from inside a container, or null when it can't be
 * worked out (no docker bridge on this machine — which also means no sandboxed
 * step is going to run here).
 */
export function dockerHostAddress(): string | null {
	// Docker Desktop resolves this name natively, and there the bridge is inside
	// a VM whose address the host can't see anyway.
	if (process.platform === "darwin" || process.platform === "win32") return "host.docker.internal";
	const interfaces = os.networkInterfaces();
	for (const name of Object.keys(interfaces)) {
		if (!BRIDGE_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
		for (const address of interfaces[name] ?? []) {
			if (address.family === "IPv4" && !address.internal) return address.address;
		}
	}
	return null;
}

/**
 * The host part of every hub url handed to this step's agent. Unchanged
 * (`cfg.host`) for a step running on the host — which is every step that was
 * working before — and the container-visible address for a sandboxed one.
 *
 * `sandboxHost` in config.json overrides the lot, for a setup this can't guess:
 * rootless docker, a custom bridge, podman, or a hub reached through a name.
 */
export function hubHostForStep(
	cfg: { host: string; sandboxHost?: string },
	sandboxed: boolean,
): string {
	if (!sandboxed) return cfg.host;
	return cfg.sandboxHost ?? dockerHostAddress() ?? cfg.host;
}

/**
 * Whether a container could actually open a connection to this hub, given what
 * it is bound to. A loopback bind cannot be reached from another network
 * namespace no matter what address the url names, so this is the difference
 * between a url that works and one that merely looks right.
 */
export function hubReachableFromSandbox(cfg: { host: string }): boolean {
	return cfg.host !== "127.0.0.1" && cfg.host !== "localhost" && cfg.host !== "::1";
}
