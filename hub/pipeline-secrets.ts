/**
 * The hub's secret store for pipelines (docs/pipelines.md, "Secrets").
 *
 * Kept apart from TCP tool tokens on purpose: a pipeline reads its secrets as
 * `${{ secrets.NAME }}` in `env`, and that is the only way a value gets into a
 * run. The values sit in the hub's database, which is created with mode 0600.
 *
 * Nothing here returns a value except `resolveSecrets`, which the executor calls
 * right before a run. `listSecrets` reads only names and timestamps, so the API
 * can show what is set without ever being able to show what it is set to.
 */

import { open } from "./db.ts";
import { registerSecret } from "./redact.ts";

/** Secret names are upper-case environment-style names, the form `${{ secrets.NAME }}` takes. */
export const SECRET_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

export type PipelineSecretErrorCode = "invalid_name" | "empty_value" | "missing_secret";

export class PipelineSecretError extends Error {
	readonly code: PipelineSecretErrorCode;

	constructor(code: PipelineSecretErrorCode, message: string = code) {
		super(message);
		this.name = "PipelineSecretError";
		this.code = code;
	}
}

export interface SecretInfo {
	name: string;
	/** Always true for a stored secret: an unset name is simply absent from the list. */
	isSet: true;
	updatedAt: string;
}

function requireName(name: string): void {
	if (!SECRET_NAME_PATTERN.test(name)) {
		throw new PipelineSecretError(
			"invalid_name",
			"secret names are upper-case letters, digits and \"_\", starting with a letter or \"_\"",
		);
	}
}

/**
 * Stores a value under a name, replacing any earlier value. The value is handed
 * to the redactor at once, so a later log line that echoes it is masked even
 * before a run has started.
 */
export function setSecret(name: string, value: string): SecretInfo {
	requireName(name);
	if (typeof value !== "string" || value === "") throw new PipelineSecretError("empty_value", "a secret needs a value");
	const updatedAt = new Date().toISOString();
	open()
		.prepare(
			`INSERT INTO pipeline_secrets (name, value, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		)
		.run(name, value, updatedAt);
	registerSecret(value);
	return { name, isSet: true, updatedAt };
}

export function deleteSecret(name: string): boolean {
	requireName(name);
	return open().prepare("DELETE FROM pipeline_secrets WHERE name = ?").run(name).changes > 0;
}

/**
 * Names and timestamps only. The SELECT deliberately omits the `value` column,
 * so no code path that lists secrets can leak one, even by accident.
 */
export function listSecrets(): SecretInfo[] {
	const rows = open().prepare("SELECT name, updated_at FROM pipeline_secrets ORDER BY name").all() as Record<string, unknown>[];
	return rows.map((row) => ({ name: String(row.name), isSet: true, updatedAt: String(row.updated_at) }));
}

export function secretIsSet(name: string): boolean {
	if (!SECRET_NAME_PATTERN.test(name)) return false;
	return open().prepare("SELECT 1 FROM pipeline_secrets WHERE name = ?").get(name) !== undefined;
}

/**
 * The values for a run's `${{ secrets.NAME }}` references. Throws
 * `missing secret: NAME` for the first name with no value, and the executor
 * stops before any job step starts. Every value it returns is registered with
 * the redactor, so no log line produced by the run can contain it.
 */
export function resolveSecrets(names: readonly string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const name of [...new Set(names)]) {
		requireName(name);
		const row = open().prepare("SELECT value FROM pipeline_secrets WHERE name = ?").get(name) as
			| Record<string, unknown>
			| undefined;
		if (!row) throw new PipelineSecretError("missing_secret", `missing secret: ${name}`);
		const value = String(row.value);
		registerSecret(value);
		out[name] = value;
	}
	return out;
}
