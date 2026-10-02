/**
 * Masks GitHub token material in text that is stored or shown. A failing agent
 * can echo its environment (`env`, a stack trace, a docker error), and the
 * copilot docker flow puts a real token there, so everything the hub keeps from
 * a run passes through here first. Leaf module (no imports) so db.ts can use it.
 */

/** Token-shaped strings: OAuth (gho_), user-to-server (ghu_), server-to-server (ghs_), classic (ghp_), fine-grained. */
const TOKEN_SHAPES = /\b(?:gh[opus]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})/g;

/** Exact token values this process has handled (so an oddly shaped one is masked too). */
const knownValues = new Set<string>();

/** Remember `value` so `redactSecrets` masks it verbatim from now on. */
export function registerSecret(value: string): void {
	if (value.length >= 8) knownValues.add(value);
}

export function redactSecrets(text: string): string {
	let out = text.replace(TOKEN_SHAPES, "***");
	for (const value of knownValues) {
		if (out.includes(value)) out = out.split(value).join("***");
	}
	return out;
}
