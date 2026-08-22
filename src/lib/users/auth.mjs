/**
 * Passwords, session tokens, cookies, and the two request-level checks that
 * stand between "there are accounts now" and "there are accounts now and they
 * are trivially stealable".
 *
 * Zero dependencies, like the rest of the project: `node:crypto` has scrypt,
 * a CSPRNG and a timing-safe comparison, which is the whole shopping list.
 *
 * Three decisions worth not re-litigating:
 *
 * **scrypt, not SHA-anything.** A password hash has to be slow. The parameters
 * below cost ~100 ms and 16 MB per attempt, which is invisible on a login form
 * and ruinous for an offline guessing run against a stolen file.
 *
 * **The cookie value is never stored.** The database keeps SHA-256 of the token.
 * A session token is a bearer credential, so storing it would mean a read of
 * `users.db` is a login as anyone in it; storing the hash means it is not.
 * SHA-256 rather than scrypt here is correct — the token is 256 bits of CSPRNG
 * output, so there is no dictionary to slow an attacker down against.
 *
 * **Same-origin is checked on every write.** `SameSite=Lax` already stops the
 * cross-site form post, but it is one browser default away from not doing so,
 * and the whole cookie-auth failure mode is a page on another origin issuing
 * writes with your cookie attached. Two independent checks, neither sufficient.
 */

import {
  randomBytes,
  scrypt as scryptCb,
  createHash,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

/**
 * scrypt cost. N=16384 is the interactive-login figure from the original paper,
 * re-checked here: ~95 ms on this laptop. Stored *in* the hash string, so
 * raising it later verifies old hashes at their old cost instead of locking
 * everyone out.
 */
const SCRYPT = { N: 16_384, r: 8, p: 1, keylen: 64, saltBytes: 16 };

/** Rejected outright, before hashing. Length is the only rule that survives contact. */
export const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 1024; // scrypt on a 10 MB "password" is a free CPU burn

/** Deliberately permissive: an email regex that tries to be clever is wrong. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

export function validEmail(email) {
  const value = normalizeEmail(email);
  return value.length <= 254 && EMAIL.test(value);
}

/**
 * `scrypt$N$r$p$salt$hash`, all base64. Self-describing so the parameters can
 * move without a migration.
 */
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) throw new Error('password is too long');
  const salt = randomBytes(SCRYPT.saltBytes);
  const key = await scrypt(password.normalize('NFKC'), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 256 * 1024 * 1024,
  });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

/**
 * Constant-time verify. Returns false rather than throwing on a malformed or
 * absent hash — a provider-only account has no password, and "wrong password"
 * is the right answer to a password attempt against it.
 */
export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || typeof password !== 'string') return false;
  if (password.length > MAX_PASSWORD_LENGTH) return false;
  const [scheme, n, r, p, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  let actual;
  try {
    actual = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 256 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------- sessions --

/** 256 bits from the CSPRNG. url-safe so it survives a cookie without encoding. */
export function newSessionToken() {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export function randomId(prefix) {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

// ----------------------------------------------------------------- cookies --

export const SESSION_COOKIE = 'jf_session';

export function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (key) out[key] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/**
 * `HttpOnly` so page scripts cannot read it; `SameSite=Lax` so another origin
 * cannot post with it; `Secure` only when the connection actually is HTTPS,
 * because a `Secure` cookie on plain http://localhost is simply dropped and the
 * result is a login that appears to succeed and then does nothing.
 */
export function sessionCookie(token, { maxAge, secure }) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAge / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearedCookie({ secure } = {}) {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** True when the request reached us over TLS, directly or through a proxy. */
export function isSecureRequest(req) {
  if (req.socket?.encrypted) return true;
  const forwarded = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  return forwarded === 'https';
}

/**
 * The CSRF check: a state-changing request must come from this origin.
 *
 * A browser always sends `Origin` on cross-origin requests and on every
 * same-origin POST/PUT/DELETE (since Chrome 76 / Firefox 70 / Safari 12.1), so
 * a missing one means a non-browser client — curl, the CLI, a test — which has
 * no ambient cookie to abuse and is allowed through. A *present* one must match
 * the Host we were reached on.
 */
export function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return true;
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  return host === req.headers.host;
}

// ------------------------------------------------------------ rate limiting --

/**
 * A fixed-window counter over (ip, key), in memory.
 *
 * In memory is the honest scope for it: this is one process serving one
 * machine, and a limiter that survives a restart would be a database write on
 * every failed password — the wrong trade for the threat, which is someone
 * grinding a weak password over a coffee-shop network for as long as the server
 * happens to be up.
 */
export function rateLimiter({ limit = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const hits = new Map();

  const sweep = (now) => {
    for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
  };

  return {
    /** Returns `{ ok, retryAfterMs }`. Counts the attempt when it is allowed. */
    take(key, now = Date.now()) {
      if (hits.size > 4096) sweep(now);
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= now) {
        hits.set(key, { count: 1, resetAt: now + windowMs });
        return { ok: true, retryAfterMs: 0 };
      }
      if (entry.count >= limit) return { ok: false, retryAfterMs: entry.resetAt - now };
      entry.count++;
      return { ok: true, retryAfterMs: 0 };
    },
    /** A success wipes the counter, so normal use never trips it. */
    clear(key) {
      hits.delete(key);
    },
  };
}

/** Best-effort client address; `x-forwarded-for` only matters behind a proxy. */
export function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || 'unknown';
}
