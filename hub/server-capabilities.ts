/**
 * What the linked target-server advertises it accepts, from the
 * `server_capabilities` field of its sync register/heartbeat responses (see
 * target-server docs/remote-sync.md, "server_capabilities.events").
 *
 * Kept in memory and persisted in the `settings` table so a restart doesn't
 * forget it before the next heartbeat. Its own module (not sync.ts) so that
 * device-link.ts can clear it on unlink without an import cycle.
 */
import { clearServerCapabilitiesJson, getServerCapabilitiesJson, saveServerCapabilitiesJson } from "./db.ts";

let loaded = false;
let events = new Set<string>();

function ensureLoaded(): void {
	if (loaded) return;
	loaded = true;
	events = new Set();
	try {
		const raw = getServerCapabilitiesJson();
		if (!raw) return;
		const parsed = JSON.parse(raw) as { events?: unknown };
		if (Array.isArray(parsed.events)) {
			events = new Set(parsed.events.filter((e): e is string => typeof e === "string" && e.length > 0));
		}
	} catch {
		// Unreadable → advertise nothing: gated event types are simply not sent.
	}
}

/**
 * Record the `server_capabilities` of a sync response that was actually
 * received and parsed. A missing field / missing `events` (an older server)
 * yields an empty list, i.e. clears support. Non-string entries are ignored.
 * Callers must NOT call this for failed requests.
 */
export function recordServerCapabilities(response: unknown): void {
	const caps =
		response && typeof response === "object" && !Array.isArray(response)
			? (response as { server_capabilities?: unknown }).server_capabilities
			: undefined;
	const rawEvents =
		caps && typeof caps === "object" && !Array.isArray(caps) ? (caps as { events?: unknown }).events : undefined;
	const list = Array.isArray(rawEvents)
		? [...new Set(rawEvents.filter((e): e is string => typeof e === "string" && e.length > 0))]
		: [];
	loaded = true;
	events = new Set(list);
	try {
		saveServerCapabilitiesJson(JSON.stringify({ events: list }));
	} catch {
		// Persistence is best effort; the in-memory value still applies.
	}
}

/** True when the server's last advertised `server_capabilities.events` lists `type`. */
export function serverSupportsEvent(type: string): boolean {
	ensureLoaded();
	return events.has(type);
}

/** Last advertised event types (sorted copy). */
export function serverAdvertisedEvents(): string[] {
	ensureLoaded();
	return [...events].sort();
}

/** Forget the advertised capabilities (hub unlinked from its server). */
export function clearServerCapabilities(): void {
	loaded = true;
	events = new Set();
	try {
		clearServerCapabilitiesJson();
	} catch {
		// Best effort, like clearOwnerSnapshot.
	}
}

/** Drop the process cache so the next read reloads from settings (tests / init). */
export function resetServerCapabilitiesCache(): void {
	loaded = false;
	events = new Set();
}
