import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";

// scrypt parameters. Memory use is 128 * N * r bytes (~16 MB here), which is
// well within Node's 32 MB default maxmem and slow enough to make offline
// guessing expensive.
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

/** Returns a self-describing hash string: scrypt$N$r$p$salt$key (both base64). */
export function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, KEYLEN, { N, r: R, p: P });
  return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

/**
 * Constant-time password check. Returns false rather than throwing on a
 * malformed stored hash, so a corrupt row can't crash the login route.
 */
export function verifyPassword(password, stored) {
  try {
    const [scheme, n, r, p, saltB64, keyB64] = String(stored).split("$");
    if (scheme !== "scrypt") return false;

    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(keyB64, "base64");
    const actual = scryptSync(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// Burned when an email doesn't exist, so a failed login costs the same amount
// of time whether or not the account is real. Without this, response latency
// alone tells an attacker which emails are registered.
const DUMMY_HASH = hashPassword(randomBytes(32).toString("hex"));
export const burnTime = () => verifyPassword("not-the-password", DUMMY_HASH);

export const SESSION_TTL_DAYS = 7;

/** Session tokens are random 256-bit values; only their SHA-256 is stored. */
export function newSessionToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

export const hashToken = (token) =>
  createHash("sha256").update(token).digest("hex");

export function sessionExpiry() {
  const ms = Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
  // SQLite datetime() comparisons need 'YYYY-MM-DD HH:MM:SS' in UTC.
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}
