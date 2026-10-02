/**
 * Where the hub finds the GitHub token a `copilot` + docker workflow needs
 * inside its container (no OS keyring there, so COPILOT_GITHUB_TOKEN has to be
 * handed in). Sources, first hit wins:
 *
 *   1. the hub's environment — COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN
 *      (Copilot's own precedence);
 *   2. a token the operator pasted in Settings;
 *   3. `gh auth token` (GitHub CLI) — accepted, but its token carries broader
 *      scopes than Copilot needs, hence the warning in the status.
 *
 * Copilot CLI accepts OAuth (`gho_`) and fine-grained PAT (`github_pat_`)
 * tokens, not classic PATs (`ghp_`).
 *
 * The token itself is a secret: only `resolveCopilotToken` returns it, and
 * `copilotTokenStatus` — the one shape that crosses the API — carries
 * non-secret facts only (no prefix beyond the classified type, no last-4).
 */
import { _impl } from "./awb.ts";
import { getCopilotToken } from "./db.ts";
import { redactSecrets, registerSecret } from "./redact.ts";

export { redactSecrets };

export type TokenSource = "env" | "settings" | "gh";
export type TokenType = "oauth" | "fine-grained" | "classic" | "unknown";

/** Environment variables checked in order, like Copilot's own precedence. */
const TOKEN_ENV_NAMES = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;

/** `gh` on PATH first; a GUI launch's PATH often lacks these install dirs. */
const GH_BINARIES = ["gh", "/usr/bin/gh", "/usr/local/bin/gh", "/opt/homebrew/bin/gh"];

const GH_TIMEOUT_MS = 5000;

export const CLASSIC_TOKEN_MESSAGE =
	"Classic personal access tokens (ghp_...) are not supported by Copilot CLI. Use a fine-grained token (github_pat_...) with the \"Copilot Requests\" permission, or sign in with the GitHub CLI.";
export const GH_TOKEN_WARNING =
	"gh tokens carry broader scopes (repo, workflow...); a fine-grained token with only the Copilot Requests permission is safer";
const UNKNOWN_TOKEN_WARNING =
	"Unrecognised token format; Copilot CLI supports gho_ (OAuth) and github_pat_ (fine-grained) tokens";

export function classifyToken(token: string): TokenType {
	if (token.startsWith("gho_")) return "oauth";
	if (token.startsWith("github_pat_")) return "fine-grained";
	if (token.startsWith("ghp_")) return "classic";
	return "unknown";
}

/** Runs `gh <args>` through the first binary that answers; null when none does. */
function runGh(args: string[]): { status: number | null; stdout: string } | null {
	for (const bin of GH_BINARIES) {
		try {
			const result = _impl.spawnSync(bin, args, { encoding: "utf8", timeout: GH_TIMEOUT_MS });
			// ENOENT (not installed there) and timeouts surface as `error`; try the next path.
			if (result.error) continue;
			return { status: result.status, stdout: typeof result.stdout === "string" ? result.stdout : "" };
		} catch {
			continue;
		}
	}
	return null;
}

/** The token `gh` holds for github.com, or null (gh missing, logged out, timed out, empty output). */
export function ghAuthToken(): string | null {
	const result = runGh(["auth", "token", "--hostname", "github.com"]);
	if (!result || result.status !== 0) return null;
	const token = result.stdout.trim();
	return token === "" ? null : token;
}

export function ghInstalled(): boolean {
	return runGh(["--version"])?.status === 0;
}

export interface ResolvedCopilotToken {
	token: string;
	source: TokenSource;
	/** Which variable held it; only for source `env`. */
	envName?: string;
}

export function resolveCopilotToken(): ResolvedCopilotToken | null {
	const resolved = findCopilotToken();
	if (resolved) registerSecret(resolved.token);
	return resolved;
}

function findCopilotToken(): ResolvedCopilotToken | null {
	for (const envName of TOKEN_ENV_NAMES) {
		const token = (process.env[envName] ?? "").trim();
		if (token !== "") return { token, source: "env", envName };
	}
	const stored = getCopilotToken();
	if (stored !== "") return { token: stored, source: "settings" };
	const fromGh = ghAuthToken();
	if (fromGh) return { token: fromGh, source: "gh" };
	return null;
}

export interface CopilotTokenStatus {
	available: boolean;
	source: TokenSource | null;
	envName: string | null;
	tokenType: TokenType | null;
	/** False for a classic token (Copilot CLI rejects it) and when nothing was found. */
	usable: boolean;
	warning: string | null;
	ghInstalled: boolean;
	ghLoggedIn: boolean;
	storedInSettings: boolean;
}

/** Non-secret facts about the token the hub would use — safe to serialise. */
export function copilotTokenStatus(): CopilotTokenStatus {
	const resolved = resolveCopilotToken();
	const tokenType = resolved ? classifyToken(resolved.token) : null;
	let warning: string | null = null;
	if (tokenType === "classic") warning = CLASSIC_TOKEN_MESSAGE;
	else if (resolved?.source === "gh") warning = GH_TOKEN_WARNING;
	else if (tokenType === "unknown") warning = UNKNOWN_TOKEN_WARNING;
	return {
		available: resolved !== null,
		source: resolved?.source ?? null,
		envName: resolved?.envName ?? null,
		tokenType,
		usable: resolved !== null && tokenType !== "classic",
		warning,
		ghInstalled: ghInstalled(),
		ghLoggedIn: runGh(["auth", "status", "--hostname", "github.com"])?.status === 0,
		storedInSettings: getCopilotToken() !== "",
	};
}
