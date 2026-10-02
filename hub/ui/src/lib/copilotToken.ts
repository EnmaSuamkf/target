/**
 * Pure rules for the Copilot-in-Docker token UI (CopilotTokenPanel and the
 * create dialog), kept out of the components so they can be tested without a
 * DOM. Everything here works from the non-secret status the hub returns — there
 * is no token anywhere in this file's inputs or outputs.
 */
import type { CopilotTokenRequired, CopilotTokenStatus } from "../api/types.ts";

/** How often the panel re-reads the status after "Sign in with GitHub CLI", and for how long. */
export const GH_LOGIN_POLL_MS = 2000;
export const GH_LOGIN_TIMEOUT_MS = 3 * 60 * 1000;

/** The runner/sandbox pair that needs a GitHub token handed into the container. */
export function needsCopilotToken(runner: string, sandbox: string): boolean {
	return runner === "copilot" && sandbox === "docker";
}

export type TokenTone = "ok" | "warn" | "error" | "missing";

export interface TokenView {
	tone: TokenTone;
	/** "Copilot token: found (GitHub CLI login)" / "Copilot token: not found" … */
	headline: string;
	/** Shown under the headline for a gh / unknown-type token. */
	warning: string | null;
	/** Shown, as an error, for a classic token. */
	error: string | null;
}

const SOURCE_LABEL = {
	gh: "GitHub CLI login",
	settings: "saved in Settings",
} as const;

export function describeTokenStatus(status: CopilotTokenStatus): TokenView {
	if (!status.available) {
		return { tone: "missing", headline: "Copilot token: not found", warning: null, error: null };
	}
	const where =
		status.source === "env"
			? `environment variable ${status.envName ?? "COPILOT_GITHUB_TOKEN"}`
			: status.source
				? SOURCE_LABEL[status.source]
				: "unknown source";
	if (status.tokenType === "classic" || !status.usable) {
		return {
			tone: "error",
			headline: `Copilot token: found (${where}) but not usable`,
			warning: null,
			error:
				status.warning ??
				"Classic personal access tokens (ghp_...) are not supported by Copilot CLI. Use a fine-grained token with the “Copilot Requests” permission, or sign in with the GitHub CLI.",
		};
	}
	return {
		tone: status.warning ? "warn" : "ok",
		headline: `Copilot token: found (${where})`,
		warning: status.warning,
		error: null,
	};
}

/**
 * Why the create dialog's submit is blocked for a token reason, or null when it
 * is not. `status` is null while it is still loading or when it could not be
 * read — in both cases the server's own check (the structured 400) stays the
 * backstop, so an unreadable status never blocks a workflow that would work.
 */
export function tokenSubmitBlock(runner: string, sandbox: string, status: CopilotTokenStatus | null): string | null {
	if (!needsCopilotToken(runner, sandbox) || status === null) return null;
	if (status.usable) return null;
	return status.available
		? "The Copilot token found is not supported — fix it above to create this workflow."
		: "Copilot in Docker needs a GitHub token — sign in with the GitHub CLI or paste one above to create this workflow.";
}

/** The info line shown (non-blocking) once a usable token exists. */
export function tokenInfoLine(status: CopilotTokenStatus): string | null {
	return status.usable ? describeTokenStatus(status).headline : null;
}

/**
 * The structured 400 body when `err` is one (an ApiError carries the parsed
 * body as `payload`), so callers branch on `error === "copilot_token_required"`
 * instead of matching message text; null for anything else.
 */
export function asCopilotTokenRequired(err: unknown): CopilotTokenRequired | null {
	const payload = (err as { status?: unknown; payload?: unknown } | null)?.payload;
	if (!payload || typeof payload !== "object") return null;
	const body = payload as Partial<CopilotTokenRequired>;
	if (body.error !== "copilot_token_required" || typeof body.message !== "string") return null;
	if (!body.status || typeof body.status !== "object") return null;
	return {
		error: "copilot_token_required",
		message: body.message,
		actions: Array.isArray(body.actions) ? body.actions.filter((a): a is string => typeof a === "string") : [],
		status: body.status,
	};
}

/**
 * Thrown inside an `act(...)` callback once the failure has already been shown
 * somewhere better than a toast (the token panel), so `act` skips its generic error toast.
 */
export class HandledError extends Error {}

/** A readable message for a failed "Sign in with GitHub CLI" request. */
export function ghLoginFailureMessage(err: unknown): string {
	const e = err as { status?: number; message?: string; payload?: { message?: unknown } } | null;
	if (e?.status === 400 && typeof e.payload?.message === "string") return e.payload.message;
	if (e?.status === 409 || e?.status === 501) {
		return "No terminal could be opened on this machine. Run `gh auth login` in a terminal yourself, or paste a token below.";
	}
	return e?.message ? `Could not open the GitHub CLI login: ${e.message}` : "Could not open the GitHub CLI login.";
}

/** The panel's poll loop decision, separated so it can be tested with fake time. */
export function ghLoginPollOutcome(
	status: CopilotTokenStatus | null,
	elapsedMs: number,
): "found" | "timeout" | "keep-waiting" {
	if (status?.available) return "found";
	return elapsedMs >= GH_LOGIN_TIMEOUT_MS ? "timeout" : "keep-waiting";
}
