/**
 * Extracts the judge's verdict from its free-form answer.
 *
 * The prompt (runner.ts `judgeInput`) asks the judge to narrate its
 * verification and END with `{"ok": bool, "reason": string}` on its own final
 * line. Both the narration and the reason routinely contain braces of their
 * own — an API step's judge writes shapes like `{ items: [] }` or
 * `featuredProducts {id,name,code}` — so no regex over `{...}` can find the
 * verdict reliably: a flat match never spans a reason that has braces inside
 * it, and a greedy match starts at the first brace of the narration.
 *
 * So we look for it from the end, the way the prompt promises it:
 *
 *  1. the last non-empty line, parsed on its own (optionally inside a ``` fence);
 *  2. failing that, every `{` from the last one back to the first, parsing the
 *     balanced object that starts there (strings and escapes respected, so a
 *     brace inside the reason doesn't end it). The latest object that is a
 *     verdict wins — the closing one, not an example shape quoted earlier.
 *
 * Accepts `{"ok": boolean}` and the `{"verdict": "ok"|"fail"}` shape. Returns
 * null when nothing parses — the caller treats that as "can't evaluate" and
 * fails the step rather than looping on a guess.
 */
export function parseJudgeVerdict(text: string | undefined): { ok: boolean; reason: string } | null {
	if (!text) return null;

	const lines = text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l !== "" && !/^```\w*$/.test(l));
	const lastLine = lines.at(-1);
	if (lastLine) {
		const verdict = toVerdict(tryParse(lastLine));
		if (verdict) return verdict;
	}

	// `start > 0` guard: lastIndexOf with a negative position clamps to 0, so
	// stepping back from index 0 would find the same brace forever.
	for (let start = text.lastIndexOf("{"); start >= 0; start = start > 0 ? text.lastIndexOf("{", start - 1) : -1) {
		const end = balancedEnd(text, start);
		if (end < 0) continue;
		const verdict = toVerdict(tryParse(text.slice(start, end + 1)));
		if (verdict) return verdict;
	}
	return null;
}

function tryParse(candidate: string): unknown {
	try {
		return JSON.parse(candidate);
	} catch {
		return undefined;
	}
}

function toVerdict(value: unknown): { ok: boolean; reason: string } | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const obj = value as Record<string, unknown>;
	const reason = typeof obj.reason === "string" ? obj.reason : "";
	if (typeof obj.ok === "boolean") return { ok: obj.ok, reason };
	if (typeof obj.verdict === "string") {
		return { ok: /^(ok|pass|passed|true|approv)/i.test(obj.verdict.trim()), reason };
	}
	return null;
}

/**
 * Index of the `}` that closes the object opened at `start`, skipping braces
 * inside JSON strings; -1 when it never closes.
 */
function balancedEnd(text: string, start: number): number {
	let depth = 0;
	let inString = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (ch === "\\") i++;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}" && --depth === 0) return i;
	}
	return -1;
}
