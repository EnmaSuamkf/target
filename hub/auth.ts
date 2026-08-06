/**
 * Crypto primitives for the single-user access layer (see account.ts and the
 * plan in usershandler.html). Everything here is built on node:crypto alone —
 * the hub deliberately has zero native/runtime dependencies, and scrypt +
 * SHA-256 + timingSafeEqual cover every need of a local single-user system:
 *
 *  - passwords: scrypt (memory-hard KDF, Node defaults N=16384 r=8 p=1) with a
 *    fresh 16-byte salt per password;
 *  - recovery token: 100 bits of entropy, Crockford-base32 formatted for
 *    humans, stored only as SHA-256 (a fast hash is correct for a token with
 *    this much entropy — brute force is infeasible, and hashing keeps a DB
 *    read from becoming an account takeover);
 *  - session tokens: 256-bit opaque random, again stored only as SHA-256.
 */
import * as crypto from "node:crypto";

export function sha256Hex(input: string): string {
	return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

/** Hashes a password with a fresh salt. Synchronous like the rest of the hub's storage layer (node:sqlite is sync too). */
export function hashPassword(password: string): { hash: string; salt: string } {
	const salt = crypto.randomBytes(SALT_BYTES);
	const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
	return { hash: hash.toString("hex"), salt: salt.toString("hex") };
}

export function verifyPassword(password: string, saltHex: string, expectedHashHex: string): boolean {
	const expected = Buffer.from(expectedHashHex, "hex");
	if (expected.length !== SCRYPT_KEYLEN) return false;
	const actual = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), SCRYPT_KEYLEN);
	return crypto.timingSafeEqual(actual, expected);
}

/**
 * Crockford base32 — the alphabet excludes I/L/O/U entirely, so a token read
 * aloud or retyped by hand can't be confused (0/O, 1/I/l are the same char).
 */
const BASE32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function base32Encode(bytes: Buffer): string {
	let bits = 0;
	let value = 0;
	let out = "";
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
	return out;
}

/**
 * Recovery tokens are four groups of five base32 chars ("XXXXX-XXXXX-XXXXX-XXXXX"):
 * 20 chars × 5 bits = 100 bits of entropy — infeasible to brute force even
 * before the login/reset rate limits, and short enough to copy by hand.
 */
const RECOVERY_GROUPS = 4;
const RECOVERY_GROUP_LEN = 5;
const RECOVERY_TOKEN_PATTERN = new RegExp(
	`^[0-9A-Z]{${RECOVERY_GROUP_LEN}}(-[0-9A-Z]{${RECOVERY_GROUP_LEN}}){${RECOVERY_GROUPS - 1}}$`,
);

export function generateRecoveryToken(): string {
	const chars = base32Encode(crypto.randomBytes(16)).slice(0, RECOVERY_GROUPS * RECOVERY_GROUP_LEN);
	const groups: string[] = [];
	for (let i = 0; i < chars.length; i += RECOVERY_GROUP_LEN) {
		groups.push(chars.slice(i, i + RECOVERY_GROUP_LEN));
	}
	return groups.join("-");
}

export function isRecoveryTokenShape(token: string): boolean {
	return RECOVERY_TOKEN_PATTERN.test(token);
}

/** What the user typed → the canonical form that was hashed (dashes/spaces stripped, uppercased). */
export function normalizeRecoveryToken(input: string): string {
	return input.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

export function hashRecoveryToken(token: string): string {
	return sha256Hex(normalizeRecoveryToken(token));
}

/** Timing-safe comparison of two hex digests (unequal lengths ⇒ not equal, without leaking which byte differed). */
export function timingSafeEqualHex(aHex: string, bHex: string): boolean {
	const a = Buffer.from(aHex, "hex");
	const b = Buffer.from(bHex, "hex");
	if (a.length !== b.length) return false;
	return crypto.timingSafeEqual(a, b);
}

/** A 256-bit opaque session token; the DB only ever stores `sha256Hex(token)`. */
export function newSessionToken(): string {
	return crypto.randomBytes(32).toString("hex");
}
