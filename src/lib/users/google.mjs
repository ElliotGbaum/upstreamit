/**
 * "Continue with Google" — OpenID Connect, authorization-code flow with PKCE.
 *
 * Dormant until credentials exist. With no client id configured, `googleConfig()`
 * returns null, `/api/meta` reports `auth.google: false`, and the button is
 * never drawn — so the password path is the whole app out of the box and this
 * file costs a returning reader nothing. Setup is in the README: one OAuth
 * client in the Google Cloud console, two values into `config/google-oauth.json`
 * or the environment.
 *
 * Why the code flow and not Google Identity Services' one-tap credential:
 * one-tap hands the *browser* an id_token, which means the server's only
 * evidence is a JWT that arrived from a page it does not control, and it must
 * then fetch and cache Google's signing keys to believe any of it. The code
 * flow's token exchange happens server-to-server over TLS with the client
 * secret attached, which is both simpler and stronger.
 *
 * **On not verifying the id_token signature.** The token here is not received
 * from the browser; it is the response body of a direct TLS request to
 * `oauth2.googleapis.com`, authenticated with our client secret. OIDC Core
 * §3.1.3.7 says signature validation MAY be skipped in exactly this case, and
 * the checks that do matter — issuer, audience, expiry, and `email_verified` —
 * are all made below. PKCE and the single-use `state` cover the rest.
 */

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CONFIG_FILE = join(ROOT, 'config', 'google-oauth.json');

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

/**
 * Credentials, from the environment or `config/google-oauth.json`.
 *
 * Environment first so a hosted deployment never needs the file, and the file
 * at all so a laptop does not need a shell profile edit. Both are gitignored /
 * absent from the repo; a client secret is a secret.
 *
 * `redirect_uri` is optional. Left out, the callback URL is built from the
 * request the browser actually arrived on, which is right for localhost and
 * wrong behind a proxy that rewrites the host — that is what the override is
 * for.
 */
export function googleConfig() {
  let file = {};
  if (existsSync(CONFIG_FILE)) {
    try {
      file = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    } catch {
      /* a malformed config is the same as no config, and says so in /api/meta */
    }
  }
  const clientId = process.env.GOOGLE_CLIENT_ID ?? file.client_id ?? null;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? file.client_secret ?? null;
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    redirectUri: process.env.GOOGLE_REDIRECT_URI ?? file.redirect_uri ?? null,
    configFile: CONFIG_FILE,
  };
}

/** The URL Google must be told to come back to. Must match the console exactly. */
export function callbackUrl(req, config, { secure = false } = {}) {
  if (config.redirectUri) return config.redirectUri;
  const proto = secure ? 'https' : 'http';
  return `${proto}://${req.headers.host}/api/auth/google/callback`;
}

/** PKCE: a high-entropy verifier and its SHA-256 challenge. */
export function pkce() {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function newState() {
  return randomBytes(24).toString('base64url');
}

/**
 * Where to send the browser.
 *
 * `prompt=select_account` rather than the default: on a shared machine the
 * default silently reuses whichever Google account the browser last used, which
 * is how someone ends up signed into a colleague's job tracker.
 */
export function authUrl({ clientId, redirectUri, state, challenge }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_type: 'online',
    prompt: 'select_account',
  });
  return `${AUTH_ENDPOINT}?${params}`;
}

/** Swap the one-time code for tokens. Server-to-server, with the client secret. */
export async function exchangeCode({ code, verifier, redirectUri, config }) {
  const body = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: verifier,
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Google refused the code exchange: ${payload.error_description ?? payload.error ?? res.status}`);
  }
  if (!payload.id_token) throw new Error('Google returned no id_token');
  return payload;
}

/**
 * Read the claims, checking everything that is checkable without the signature.
 *
 * See the module header for why that is the right set here: the token came from
 * Google's own token endpoint over TLS, not from the browser.
 */
export function readIdToken(idToken, { clientId, now = Date.now() } = {}) {
  const parts = String(idToken).split('.');
  if (parts.length !== 3) throw new Error('malformed id_token');
  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('unreadable id_token');
  }
  if (!ISSUERS.has(claims.iss)) throw new Error(`unexpected issuer ${claims.iss}`);
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(clientId)) throw new Error('id_token was issued for a different client');
  if (!claims.exp || claims.exp * 1000 <= now) throw new Error('id_token has expired');
  if (!claims.sub) throw new Error('id_token carries no subject');
  return {
    subject: claims.sub,
    email: claims.email ?? null,
    // Google sends this as a boolean or the string "true" depending on the era
    // of the endpoint; both mean verified and neither should be trusted loosely.
    email_verified: claims.email_verified === true || claims.email_verified === 'true',
    display_name: claims.name ?? null,
    picture: claims.picture ?? null,
  };
}
