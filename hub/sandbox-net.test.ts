/**
 * The hub urls a SANDBOXED step is given have to name an address the container
 * can actually reach.
 *
 * A step with `--sandbox docker` runs on the default bridge network, where
 * `127.0.0.1` is the container. Every hub url built on `cfg.host` therefore
 * pointed at nothing: the agent's TCP execute endpoint and the broker's own
 * result/started callbacks alike. It failed as a bare connection refused, which
 * an agent reads as "the hub isn't running" — so instead of reporting a broken
 * tool it would go and improvise the job by other means.
 *
 * Two separate things have to be true, and both are covered here: the url has
 * to name the container-visible host, AND the hub has to be listening on
 * something a container can open a connection to. The second is why a correct
 * url is not on its own enough.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";

const { dockerHostAddress, hubHostForStep, hubReachableFromSandbox } = await import("./sandbox-net.ts");

test("a step on the host keeps using cfg.host, exactly as before", () => {
	// The unchanged path: no sandbox, no rewriting, whatever the operator bound.
	assert.equal(hubHostForStep({ host: "127.0.0.1" }, false), "127.0.0.1");
	assert.equal(hubHostForStep({ host: "0.0.0.0" }, false), "0.0.0.0");
	// Even with sandboxHost configured, a host-side step is not affected by it.
	assert.equal(hubHostForStep({ host: "127.0.0.1", sandboxHost: "172.17.0.1" }, false), "127.0.0.1");
});

test("a sandboxed step never gets loopback — that address is the container itself", () => {
	const resolved = hubHostForStep({ host: "127.0.0.1" }, true);
	// Either the bridge gateway was found or there is no docker on this machine,
	// in which case there is no sandboxed step to serve and the fallback stands.
	if (dockerHostAddress() !== null) {
		assert.notEqual(resolved, "127.0.0.1", "loopback in a container points at the container");
		assert.equal(resolved, dockerHostAddress());
	} else {
		assert.equal(resolved, "127.0.0.1", "no bridge to resolve, so nothing to rewrite to");
	}
});

test("sandboxHost overrides the guess, for setups this cannot work out", () => {
	// Rootless docker, podman, a custom bridge, or a hub behind a name.
	assert.equal(hubHostForStep({ host: "127.0.0.1", sandboxHost: "host.docker.internal" }, true), "host.docker.internal");
	assert.equal(hubHostForStep({ host: "0.0.0.0", sandboxHost: "10.88.0.1" }, true), "10.88.0.1");
});

test("a loopback bind is reported as unreachable from a sandbox", () => {
	// The half a correct url cannot fix: bound here, the connection is refused
	// however right the address in the prompt is.
	assert.equal(hubReachableFromSandbox({ host: "127.0.0.1" }), false);
	assert.equal(hubReachableFromSandbox({ host: "localhost" }), false);
	assert.equal(hubReachableFromSandbox({ host: "::1" }), false);
});

test("a bind a container can open a connection to is reported reachable", () => {
	assert.equal(hubReachableFromSandbox({ host: "0.0.0.0" }), true);
	assert.equal(hubReachableFromSandbox({ host: "172.17.0.1" }), true);
	assert.equal(hubReachableFromSandbox({ host: "192.168.1.10" }), true);
});

test("dockerHostAddress returns a usable address or null, never loopback", () => {
	const address = dockerHostAddress();
	if (address === null) return;
	assert.notEqual(address, "127.0.0.1");
	assert.notEqual(address, "localhost");
	// Either a bridge IPv4 or the name Docker Desktop publishes.
	const looksUsable = address === "host.docker.internal" || /^\d+\.\d+\.\d+\.\d+$/.test(address);
	assert.ok(looksUsable, `unexpected address: ${address}`);
});
