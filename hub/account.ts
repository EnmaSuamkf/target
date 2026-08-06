/**
 * The single-user account and its login sessions (plan: usershandler.html).
 *
 * One account per machine, stored as the single row of the `auth` table
 * (guarded by `CHECK (id = 1)` — see db.ts). That row's existence IS the
 * "setup completed" flag, and the table doubles as the brute-force state
 * (`failed_logins`/`locked_until`): with exactly one account there is one
 * counter for the whole machine, surviving restarts for free.
 *
 * Sessions are a small table rather than a single active one, so the operator
 * can be logged in from two browsers without kicking themselves out. Rows hold
 * only the SHA-256 of the opaque cookie token. Expiry is lazy — the same
 * philosophy as the step timeouts in db.ts: every resolve checks the row and
 * deletes the dead ones, so there are no timers and restarts don't matter.
 */
import {
	generateRecoveryToken,
	hashPassword,
	hashRecoveryToken,
	newSessionToken,
	sha256Hex,
	timingSafeEqualHex,
	verifyPassword,
} from "./auth.ts";
import { open } from "./db.ts";

/** The public shape of the account — everything the API may return. Never includes any hash. */
export interface PublicAccount {
	displayName: string | null;
	recoveryTokenSetAt: string;
	createdAt: string;
}

interface AuthRow {
	id: number;
	display_name: string | null;
	password_hash: string;
	password_salt: string;
	recovery_token_hash: string;
	recovery_token_set_at: string;
	failed_logins: number;
	locked_until: string | null;
	created_at: string;
	updated_at: string;
}

/** Errors the routes map to status codes (see server.ts). */
export class AccountError extends Error {
	readonly code: "setup_already_completed";
	constructor(code: "setup_already_completed", message: string) {
		super(message);
		this.name = "AccountError";
		this.code = code;
	}
}

export const MIN_PASSWORD_LENGTH = 10;

// Login brute-force: 5 consecutive failures lock the account for 5 minutes,
// doubling on every further lockout (5, 10, 20, 40…), capped at a day. A
// successful login or a token reset clears the counters.
const MAX_FAILED_LOGINS = 5;
const BASE_LOCK_MS = 5 * 60 * 1000;
const MAX_LOCK_MS = 24 * 60 * 60 * 1000;

/** Hard cap on a session's life, however active it is. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A session unused for this long is dead even inside its TTL (sliding window). */
export const SESSION_IDLE_MS = 14 * 24 * 60 * 60 * 1000;
/** `last_seen_at` writes are throttled to one per minute per session — the UI polls every 2s. */
const SESSION_TOUCH_THROTTLE_MS = 60_000;

function getAuthRow(): AuthRow | null {
	const row = open().prepare("SELECT * FROM auth WHERE id = 1").get();
	return (row as AuthRow | undefined) ?? null;
}

function toPublic(row: AuthRow): PublicAccount {
	return {
		displayName: row.display_name,
		recoveryTokenSetAt: row.recovery_token_set_at,
		createdAt: row.created_at,
	};
}

export function isSetupComplete(): boolean {
	return getAuthRow() !== null;
}

export function getAccount(): PublicAccount | null {
	const row = getAuthRow();
	return row ? toPublic(row) : null;
}

/**
 * Creates the one and only account. The recovery token is returned in the
 * clear exactly once — only its SHA-256 is stored (see auth.ts). A second call
 * (or a raced twin) loses to the singleton CHECK constraint, which surfaces as
 * `AccountError("setup_already_completed")`.
 */
export function createAccount(input: { password: string; displayName?: string | null }): {
	account: PublicAccount;
	recoveryToken: string;
} {
	const { hash, salt } = hashPassword(input.password);
	const recoveryToken = generateRecoveryToken();
	const now = new Date().toISOString();
	try {
		open()
			.prepare(
				`INSERT INTO auth (id, display_name, password_hash, password_salt, recovery_token_hash, recovery_token_set_at, created_at, updated_at)
				 VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				(typeof input.displayName === "string" && input.displayName.trim()) || null,
				hash,
				salt,
				hashRecoveryToken(recoveryToken),
				now,
				now,
				now,
			);
	} catch (err) {
		// node:sqlite reports the CHECK/PRIMARY KEY violation as a generic Error
		// whose message names the constraint; either way, an insert that fails on
		// the singleton row can only mean the account already exists.
		if (getAuthRow()) throw new AccountError("setup_already_completed", "setup already completed");
		throw err;
	}
	return { account: toPublic(getAuthRow() as AuthRow), recoveryToken };
}

export type LoginVerdict =
	| { ok: true }
	| { ok: false; /** Seconds until the lockout ends; null while merely counting failures. */ retryAfterSec: number | null };

/**
 * Verifies a login attempt, owning the lockout counters on the auth row.
 *
 * While locked, EVERY attempt fails — the correct password included: a lockout
 * that lets the right password through would tell an attacker exactly when
 * they've found it. Uniform `{ ok: false }` either way; only the presence of
 * `retryAfterSec` distinguishes "locked" from "wrong password".
 */
export function verifyAccountPassword(password: string): LoginVerdict {
	const row = getAuthRow();
	if (!row) return { ok: false, retryAfterSec: null };
	const now = Date.now();
	if (row.locked_until) {
		const lockedUntilMs = Date.parse(row.locked_until);
		if (lockedUntilMs > now) return { ok: false, retryAfterSec: Math.ceil((lockedUntilMs - now) / 1000) };
	}
	if (verifyPassword(password, row.password_salt, row.password_hash)) {
		open()
			.prepare("UPDATE auth SET failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = 1")
			.run(new Date().toISOString());
		return { ok: true };
	}
	const failures = row.failed_logins + 1;
	let lockedUntil: string | null = null;
	if (failures >= MAX_FAILED_LOGINS) {
		const lockCount = Math.floor(failures / MAX_FAILED_LOGINS);
		const lockMs = Math.min(BASE_LOCK_MS * 2 ** (lockCount - 1), MAX_LOCK_MS);
		lockedUntil = new Date(now + lockMs).toISOString();
	}
	open()
		.prepare("UPDATE auth SET failed_logins = ?, locked_until = ?, updated_at = ? WHERE id = 1")
		.run(failures, lockedUntil, new Date().toISOString());
	return {
		ok: false,
		retryAfterSec: lockedUntil ? Math.ceil((Date.parse(lockedUntil) - now) / 1000) : null,
	};
}

/**
 * The forgot-password path: the recovery token saved at setup is the only
 * recovery channel (there is no e-mail in this system). On a match, in one
 * transaction: the password is re-hashed with a fresh salt, the token ROTATES
 * (a used token that leaked can't be replayed), every session is killed
 * (force re-login in every browser) and the lockout counters reset.
 *
 * Returns the new recovery token — shown to the user exactly once, like at
 * setup — or null for a token that doesn't match.
 */
export function resetPasswordWithToken(
	recoveryToken: string,
	newPassword: string,
): { account: PublicAccount; recoveryToken: string } | null {
	const row = getAuthRow();
	if (!row) return null;
	if (!timingSafeEqualHex(hashRecoveryToken(recoveryToken), row.recovery_token_hash)) return null;
	const { hash, salt } = hashPassword(newPassword);
	const nextToken = generateRecoveryToken();
	const now = new Date().toISOString();
	const db = open();
	db.exec("BEGIN");
	try {
		db.prepare(
			`UPDATE auth SET password_hash = ?, password_salt = ?, recovery_token_hash = ?, recovery_token_set_at = ?,
			 failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = 1`,
		).run(hash, salt, hashRecoveryToken(nextToken), now, now);
		db.prepare("DELETE FROM sessions").run();
		db.exec("COMMIT");
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
	return { account: toPublic(getAuthRow() as AuthRow), recoveryToken: nextToken };
}

// --- sessions ---

/**
 * Last time the dead-session sweep ran. The sweep piggybacks on resolves
 * (throttled to the hour) rather than running on every one: the table is tiny,
 * but the UI polls through this path every 2 seconds.
 */
let lastCleanupAt = 0;

function sweepExpiredSessions(now: Date): void {
	if (now.getTime() - lastCleanupAt < 60 * 60 * 1000) return;
	lastCleanupAt = now.getTime();
	const horizon = new Date(now.getTime() - SESSION_IDLE_MS).toISOString();
	open()
		.prepare("DELETE FROM sessions WHERE expires_at < ? OR last_seen_at < ?")
		.run(now.toISOString(), horizon);
}

/** Creates a session and returns the plaintext token (for the cookie) — the DB row holds only its SHA-256. */
export function createSession(): { token: string; expiresAt: string } {
	const token = newSessionToken();
	const now = new Date();
	const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
	open()
		.prepare("INSERT INTO sessions (token_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?)")
		.run(sha256Hex(token), now.toISOString(), expiresAt, now.toISOString());
	return { token, expiresAt };
}

/**
 * Answers whether this cookie token maps to a live session. Dead sessions —
 * past the hard TTL, or idle past the sliding window — are deleted on the way
 * out (lazy expiry: no timers, survives restarts). A live session's
 * `last_seen_at` is refreshed at most once a minute, so the UI's 2s poll costs
 * one read per request and one write per minute.
 */
export function resolveSession(token: string): boolean {
	const now = new Date();
	sweepExpiredSessions(now);
	const row = open().prepare("SELECT * FROM sessions WHERE token_hash = ?").get(sha256Hex(token)) as
		| { expires_at: string; last_seen_at: string }
		| undefined;
	if (!row) return false;
	const idleHorizon = now.getTime() - SESSION_IDLE_MS;
	if (Date.parse(row.expires_at) <= now.getTime() || Date.parse(row.last_seen_at) <= idleHorizon) {
		deleteSession(token);
		return false;
	}
	if (now.getTime() - Date.parse(row.last_seen_at) > SESSION_TOUCH_THROTTLE_MS) {
		open()
			.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?")
			.run(now.toISOString(), sha256Hex(token));
	}
	return true;
}

export function deleteSession(token: string): void {
	open().prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256Hex(token));
}

/** Every session dies — the password-reset path uses it to force re-login in every browser. */
export function deleteAllSessions(): void {
	open().prepare("DELETE FROM sessions").run();
}
