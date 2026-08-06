/**
 * Tests for the single-user account layer (account.ts + auth.ts), against a
 * throwaway TARGET_HOME like every other suite here.
 *
 * Covered: the singleton guard (setup can only happen once), the scrypt
 * password round-trip, login lockout counters, the recovery-token reset path
 * (rotation + session purge + lockout clear), and session lazy expiry. The
 * HTTP wiring of these is in auth-routes.test.ts.
 *
 * The tests share one account (node --test runs this file's tests in order),
 * so the recovery token is captured at creation and threaded through.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "target-test-account-"));
process.env.TARGET_HOME = tmpHome;

const {
	AccountError,
	createAccount,
	createSession,
	deleteSession,
	getAccount,
	isSetupComplete,
	resetPasswordWithToken,
	resolveSession,
	verifyAccountPassword,
} = await import("./account.ts");
const { generateRecoveryToken, hashRecoveryToken, isRecoveryTokenShape, normalizeRecoveryToken, sha256Hex } =
	await import("./auth.ts");
const { open } = await import("./db.ts");

const PASSWORD = "correct horse battery";
const OTHER_PASSWORD = "a totally different password";

/** The one-time recovery token, captured where it's legitimately seen once: the createAccount response. */
let savedRecoveryToken = "";

test("no account exists on a fresh install, and getAccount leaks nothing", () => {
	assert.equal(isSetupComplete(), false);
	assert.equal(getAccount(), null);
});

test("the recovery token is human-formatted and normalizes back to itself", () => {
	const token = generateRecoveryToken();
	assert.equal(isRecoveryTokenShape(token), true, `unexpected shape: ${token}`);
	// Four groups of five, Crockford base32 (no I/L/O/U).
	assert.match(token, /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
	// Lowercase with no dashes (as a user might retype it) hashes identically.
	const sloppy = token.replaceAll("-", "").toLowerCase();
	assert.equal(hashRecoveryToken(sloppy), hashRecoveryToken(token));
	assert.equal(normalizeRecoveryToken(` ${token.toLowerCase()} `), token.replaceAll("-", ""));
});

test("createAccount stores hashes only and returns the token in the clear exactly once", () => {
	const { account, recoveryToken } = createAccount({ password: PASSWORD, displayName: "  Ada  " });
	savedRecoveryToken = recoveryToken;
	assert.equal(isSetupComplete(), true);
	assert.equal(isRecoveryTokenShape(recoveryToken), true);
	assert.equal(account.displayName, "Ada");
	assert.ok(account.recoveryTokenSetAt.length > 0);

	// The row holds neither the password nor the token in readable form.
	const row = open().prepare("SELECT * FROM auth WHERE id = 1").get() as Record<string, unknown>;
	assert.notEqual(String(row.password_hash), PASSWORD);
	assert.equal(String(row.recovery_token_hash), hashRecoveryToken(recoveryToken));
	// getAccount never exposes the hashes.
	assert.deepEqual(Object.keys(getAccount() as object).sort(), ["createdAt", "displayName", "recoveryTokenSetAt"]);
});

test("the singleton guard refuses a second account", () => {
	assert.throws(() => createAccount({ password: OTHER_PASSWORD }), (err: unknown) => {
		assert.ok(err instanceof AccountError);
		assert.equal(err.code, "setup_already_completed");
		return true;
	});
});

test("password verification round-trips, and a success resets the failure counter", () => {
	assert.deepEqual(verifyAccountPassword("not the password"), { ok: false, retryAfterSec: null });
	assert.deepEqual(verifyAccountPassword(PASSWORD), { ok: true });
	const row = open().prepare("SELECT failed_logins FROM auth WHERE id = 1").get() as Record<string, unknown>;
	assert.equal(row.failed_logins, 0);
});

test("five consecutive failures lock the account — even against the right password", () => {
	for (let i = 0; i < 4; i++) {
		const verdict = verifyAccountPassword("nope");
		assert.equal(verdict.ok, false);
		assert.equal(verdict.ok ? null : verdict.retryAfterSec, null);
	}
	const fifth = verifyAccountPassword("nope");
	assert.equal(fifth.ok, false);
	assert.ok(!fifth.ok && typeof fifth.retryAfterSec === "number" && fifth.retryAfterSec > 0);
	// While locked, even the correct password is refused (a lockout that lets it
	// through would tell an attacker exactly when they've found it).
	const locked = verifyAccountPassword(PASSWORD);
	assert.equal(locked.ok, false);
	assert.ok(!locked.ok && typeof locked.retryAfterSec === "number" && locked.retryAfterSec > 0);
});

test("reset with the saved token rotates it, kills every session and clears the lockout", () => {
	// The account is still locked from the previous test — exactly the state a
	// forgot-password reset has to work from.
	const sessionA = createSession();
	const sessionB = createSession();
	assert.equal(resolveSession(sessionA.token), true);

	// A wrong token changes nothing.
	assert.equal(resetPasswordWithToken("AAAAA-BBBBB-CCCCC-DDDDD", OTHER_PASSWORD), null);

	const outcome = resetPasswordWithToken(savedRecoveryToken, OTHER_PASSWORD);
	assert.ok(outcome !== null);
	assert.equal(isRecoveryTokenShape(outcome.recoveryToken), true);
	assert.notEqual(hashRecoveryToken(outcome.recoveryToken), hashRecoveryToken(savedRecoveryToken));

	// Old token is dead, new password works, sessions are gone.
	assert.equal(resetPasswordWithToken(savedRecoveryToken, PASSWORD), null);
	assert.deepEqual(verifyAccountPassword(OTHER_PASSWORD), { ok: true });
	assert.equal(resolveSession(sessionA.token), false);
	assert.equal(resolveSession(sessionB.token), false);

	// The lockout counters were cleared by the reset (read before the next
	// deliberate failure below re-arms them).
	const row = open().prepare("SELECT failed_logins, locked_until FROM auth WHERE id = 1").get() as Record<
		string,
		unknown
	>;
	assert.equal(row.failed_logins, 0);
	assert.equal(row.locked_until, null);

	// The old password no longer authenticates (checked last: the attempt itself
	// counts as a failure).
	assert.equal(verifyAccountPassword(PASSWORD).ok, false);
	assert.deepEqual(verifyAccountPassword(OTHER_PASSWORD), { ok: true });

	savedRecoveryToken = outcome.recoveryToken;
});

test("sessions: unknown tokens never resolve, and expiry is lazy", () => {
	const session = createSession();
	assert.equal(resolveSession("0".repeat(64)), false);
	assert.equal(resolveSession(session.token), true);
	deleteSession(session.token);
	assert.equal(resolveSession(session.token), false);

	// Age a row past both windows by hand; the next resolve must collect it.
	const stale = createSession();
	const ancient = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
	open()
		.prepare("UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE token_hash = ?")
		.run(ancient, ancient, sha256Hex(stale.token));
	assert.equal(resolveSession(stale.token), false);
	// The lazy sweep deleted the row rather than just refusing it.
	const row = open().prepare("SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?").get(sha256Hex(stale.token)) as Record<string, unknown>;
	assert.equal(Number(row.n), 0);
});
