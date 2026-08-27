/**
 * The accounts store — every query against `data/users.db` lives here.
 *
 * The server module below it does HTTP and nothing else; this one does SQL and
 * nothing else. That seam is what makes the account layer testable without a
 * socket (`src/users-test.mjs` drives this file directly) and what would make a
 * different transport — a CLI `npm run account`, a hosted service later — a
 * different caller rather than a second copy of the rules.
 *
 * Two invariants the whole module maintains:
 *
 *  - **A row never leaves here with a secret in it.** `publicUser()` is the only
 *    way a user reaches the outside, and `password_hash` is not in it.
 *  - **Every read is scoped by `user_id`.** There is no function that fetches a
 *    saved job, a list or a profile by id alone; the owner is always part of the
 *    lookup, so a guessed id is not an access path.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DDL,
  USERS_SCHEMA_VERSION,
  APPLICATION_STATUSES,
  ACTED_ON,
  SESSION_TTL_MS,
  SAFE_NAME,
} from './schema.mjs';
import {
  hashPassword,
  verifyPassword,
  normalizeEmail,
  validEmail,
  newSessionToken,
  hashToken,
  randomId,
} from './auth.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const DEFAULT_USERS_DB_PATH = join(ROOT, 'data', 'users.db');

/** Thrown for anything the caller could have avoided; the server maps it to 4xx. */
export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function openUsersDb(path = DEFAULT_USERS_DB_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(DDL);
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    'users_schema_version',
    String(USERS_SCHEMA_VERSION),
  );
  purgeExpired(db);
  return db;
}

/** Expired sessions and abandoned OAuth handshakes. Cheap; runs on open. */
export function purgeExpired(db, now = Date.now()) {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  db.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').run(now);
}

/** The only shape of a user that crosses the wire. */
export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name ?? null,
    created_at: row.created_at,
    // Lets the UI say "you signed in with Google, there is no password to
    // change" instead of offering a control that cannot work.
    has_password: Boolean(row.password_hash),
  };
}

// -------------------------------------------------------------------- users --

/**
 * Create a password account.
 *
 * Email uniqueness is enforced by the UNIQUE index rather than by a prior
 * SELECT, because a check-then-insert is a race — two simultaneous signups on
 * the same address would both pass the check.
 */
export async function createUser(db, { email, password, display_name = null }, now = Date.now()) {
  const address = normalizeEmail(email);
  if (!validEmail(address)) throw new UserError('that does not look like an email address');
  let hash;
  try {
    hash = await hashPassword(password);
  } catch (err) {
    throw new UserError(err.message);
  }
  const id = randomId('u');
  try {
    db.prepare(
      `INSERT INTO users (id, email, email_verified, display_name, password_hash, created_at, last_seen_at)
       VALUES (?, ?, 0, ?, ?, ?, ?)`,
    ).run(id, address, display_name ? String(display_name).slice(0, 120) : null, hash, now, now);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      throw new UserError('an account with that email already exists', 409);
    }
    throw err;
  }
  return publicUser(getUser(db, id));
}

export function getUser(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) ?? null;
}

export function findByEmail(db, email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(normalizeEmail(email)) ?? null;
}

/**
 * Check an email/password pair.
 *
 * Returns null for "no such user" and for "wrong password" alike, and hashes a
 * dummy password in the first case so that the two take the same time — a login
 * form that answers faster for an unknown address is an account enumerator.
 */
export async function verifyLogin(db, email, password) {
  const row = findByEmail(db, email);
  if (!row?.password_hash) {
    await verifyPassword(String(password ?? ''), await dummyHash());
    return null;
  }
  const ok = await verifyPassword(String(password ?? ''), row.password_hash);
  return ok ? row : null;
}

/**
 * A real scrypt hash of a random string, used only to burn the same ~95 ms on a
 * miss as on a hit. Computed on the first miss and kept, rather than at module
 * load, so importing this file costs nothing.
 */
let dummyHashPromise = null;
function dummyHash() {
  dummyHashPromise ??= hashPassword(newSessionToken());
  return dummyHashPromise;
}

/** Change or set a password. Also used by the `account` CLI as a reset path. */
export async function setPassword(db, userId, password, now = Date.now()) {
  let hash;
  try {
    hash = await hashPassword(password);
  } catch (err) {
    throw new UserError(err.message);
  }
  const result = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
  if (result.changes === 0) throw new UserError('no such user', 404);
  // Every other session is invalidated: a password change that leaves an old
  // session alive has not actually locked anyone out.
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  void now;
  return true;
}

export function updateProfileFields(db, userId, { display_name }) {
  db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(
    display_name == null ? null : String(display_name).slice(0, 120),
    userId,
  );
  return publicUser(getUser(db, userId));
}

export function deleteUser(db, userId) {
  return db.prepare('DELETE FROM users WHERE id = ?').run(userId).changes > 0;
}

export function listUsers(db) {
  return db
    .prepare(
      `SELECT u.*, (SELECT COUNT(*) FROM saved_jobs s WHERE s.user_id = u.id) saved,
              (SELECT COUNT(*) FROM user_profiles p WHERE p.user_id = u.id) profiles
       FROM users u ORDER BY u.created_at`,
    )
    .all();
}

// --------------------------------------------------------------- identities --

/**
 * Find or create the account behind an external identity.
 *
 * Matching an existing account by email is what makes "I signed up with a
 * password in March and clicked Continue with Google in August" land on one
 * account instead of two — but it is also, done carelessly, an account
 * takeover: anyone who can get a provider to assert an address they do not own
 * inherits that address's account. So the link only happens when the provider
 * says the address is verified, which for Google means the `email_verified`
 * claim. Unverified, we refuse rather than guess.
 */
export function upsertIdentity(db, { provider, subject, email, display_name, email_verified }, now = Date.now()) {
  const existing = db
    .prepare('SELECT user_id FROM identities WHERE provider = ? AND subject = ?')
    .get(provider, String(subject));
  if (existing) {
    db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now, existing.user_id);
    return getUser(db, existing.user_id);
  }

  const address = normalizeEmail(email);
  if (!validEmail(address)) throw new UserError(`${provider} did not provide an email address`, 502);
  if (!email_verified) {
    throw new UserError(`${provider} has not verified that address, so it cannot be used to sign in`, 403);
  }

  let user = findByEmail(db, address);
  if (!user) {
    const id = randomId('u');
    db.prepare(
      `INSERT INTO users (id, email, email_verified, display_name, password_hash, created_at, last_seen_at)
       VALUES (?, ?, 1, ?, NULL, ?, ?)`,
    ).run(id, address, display_name ? String(display_name).slice(0, 120) : null, now, now);
    user = getUser(db, id);
  } else {
    db.prepare('UPDATE users SET email_verified = 1, last_seen_at = ? WHERE id = ?').run(now, user.id);
  }

  db.prepare(
    `INSERT INTO identities (provider, subject, user_id, email, linked_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(provider, String(subject), user.id, address, now);
  return getUser(db, user.id);
}

export function identitiesFor(db, userId) {
  return db.prepare('SELECT provider, email, linked_at FROM identities WHERE user_id = ?').all(userId);
}

// ----------------------------------------------------------------- sessions --

/** Returns the raw token — the only moment it exists outside the browser. */
export function createSession(db, userId, { userAgent = null, ttlMs = SESSION_TTL_MS } = {}, now = Date.now()) {
  const token = newSessionToken();
  db.prepare(
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_used_at, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(hashToken(token), userId, now, now + ttlMs, now, userAgent ? String(userAgent).slice(0, 300) : null);
  db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now, userId);
  return { token, expiresAt: now + ttlMs };
}

/**
 * Resolve a cookie to a user, sliding the expiry forward.
 *
 * The slide is throttled to once an hour: without it every request is a write,
 * and with a WAL database that is a lot of disk for a timestamp nobody reads.
 */
export function userForToken(db, token, now = Date.now()) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hashToken(token));
  if (!row) return null;
  if (row.expires_at <= now) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
    return null;
  }
  if (now - (row.last_used_at ?? 0) > 60 * 60 * 1000) {
    db.prepare('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE token_hash = ?').run(
      now,
      now + SESSION_TTL_MS,
      row.token_hash,
    );
  }
  return getUser(db, row.user_id);
}

export function destroySession(db, token) {
  if (!token) return false;
  return db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token)).changes > 0;
}

export function destroyAllSessions(db, userId) {
  return db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes;
}

// -------------------------------------------------------------- oauth state --

export function putOAuthState(db, { state, provider, verifier, ttlMs = 10 * 60 * 1000 }, now = Date.now()) {
  db.prepare(
    'INSERT INTO oauth_states (state, provider, verifier, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  ).run(state, provider, verifier, now, now + ttlMs);
}

/** Single-use: reading a state consumes it, so a replayed callback fails. */
export function takeOAuthState(db, state, now = Date.now()) {
  const row = db.prepare('SELECT * FROM oauth_states WHERE state = ?').get(String(state ?? ''));
  if (!row) return null;
  db.prepare('DELETE FROM oauth_states WHERE state = ?').run(row.state);
  return row.expires_at > now ? row : null;
}

// ----------------------------------------------------------- saved profiles --

export function listUserProfiles(db, userId) {
  return db
    .prepare('SELECT name, document, created_at, updated_at FROM user_profiles WHERE user_id = ? ORDER BY name')
    .all(userId)
    .map((row) => {
      let doc = {};
      try {
        doc = JSON.parse(row.document);
      } catch {
        /* a corrupt row should not hide the good ones */
      }
      return {
        name: row.name,
        label: doc.label ?? null,
        notes: doc.notes ?? null,
        updated_at: row.updated_at,
        owner: 'user',
      };
    });
}

export function getUserProfile(db, userId, name) {
  const row = db.prepare('SELECT document FROM user_profiles WHERE user_id = ? AND name = ?').get(userId, name);
  if (!row) return null;
  return JSON.parse(row.document);
}

/**
 * Saved as posted, not as normalized — the same rule the file-backed profiles
 * follow. Filling in every default would make the document unreadable and
 * undiffable, and the engine normalizes on read anyway.
 */
export function putUserProfile(db, userId, name, document, now = Date.now()) {
  if (!SAFE_NAME.test(name)) throw new UserError('profile names are [a-z0-9._-], 1–64 chars');
  const json = JSON.stringify(document ?? {});
  if (json.length > 200_000) throw new UserError('that profile is implausibly large', 413);
  db.prepare(
    `INSERT INTO user_profiles (user_id, name, document, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, name) DO UPDATE SET document = excluded.document, updated_at = excluded.updated_at`,
  ).run(userId, name, json, now, now);
  return listUserProfiles(db, userId);
}

export function deleteUserProfile(db, userId, name) {
  return db.prepare('DELETE FROM user_profiles WHERE user_id = ? AND name = ?').run(userId, name).changes > 0;
}

// ----------------------------------------------------------------- settings --

export function getSetting(db, userId, key, fallback = null) {
  const row = db.prepare('SELECT value FROM user_settings WHERE user_id = ? AND key = ?').get(userId, key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

export function setSetting(db, userId, key, value, now = Date.now()) {
  const json = JSON.stringify(value ?? null);
  if (json.length > 200_000) throw new UserError('that setting is implausibly large', 413);
  db.prepare(
    `INSERT INTO user_settings (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(userId, key, json, now);
  return true;
}

// -------------------------------------------------------------- saved jobs --

const SAVED_COLUMNS = `job_id, status, note, saved_at, updated_at, applied_at, title, company, url`;

export function listSaved(db, userId, { status = null, listId = null } = {}) {
  if (listId) {
    return db
      .prepare(
        `SELECT s.job_id, s.status, s.note, s.saved_at, s.updated_at, s.applied_at, s.title, s.company, s.url
         FROM list_items i
         JOIN lists l ON l.id = i.list_id AND l.user_id = ?
         LEFT JOIN saved_jobs s ON s.user_id = l.user_id AND s.job_id = i.job_id
         WHERE i.list_id = ?
         ORDER BY i.added_at DESC`,
      )
      .all(userId, listId)
      .filter((row) => row.job_id);
  }
  if (status) {
    return db
      .prepare(`SELECT ${SAVED_COLUMNS} FROM saved_jobs WHERE user_id = ? AND status = ? ORDER BY updated_at DESC`)
      .all(userId, status);
  }
  return db
    .prepare(`SELECT ${SAVED_COLUMNS} FROM saved_jobs WHERE user_id = ? ORDER BY updated_at DESC`)
    .all(userId);
}

export function getSaved(db, userId, jobId) {
  return db.prepare(`SELECT ${SAVED_COLUMNS} FROM saved_jobs WHERE user_id = ? AND job_id = ?`).get(userId, jobId) ?? null;
}

/**
 * Save a job, or update the one already saved.
 *
 * `applied_at` is stamped the first time the status reaches a state that means
 * you actually did something, and is never cleared afterwards: moving a job
 * back to `saved` is a correction to where it stands now, not a claim that you
 * never applied. The distinction matters for "what have I applied to and heard
 * nothing back on", which is the question this table exists to answer.
 *
 * Fields that are not supplied are left alone rather than overwritten with
 * null, so the star button can create a row without wiping a note.
 */
export function saveJob(db, userId, jobId, patch = {}, now = Date.now()) {
  if (typeof jobId !== 'string' || !jobId || jobId.length > 300) throw new UserError('bad job id');
  const status = patch.status ?? null;
  if (status != null && !APPLICATION_STATUSES.includes(status)) {
    throw new UserError(`status must be one of ${APPLICATION_STATUSES.join(', ')}`);
  }
  const note = patch.note == null ? null : String(patch.note).slice(0, 10_000);
  const existing = getSaved(db, userId, jobId);
  const nextStatus = status ?? existing?.status ?? 'saved';
  const appliedAt = existing?.applied_at ?? (ACTED_ON.has(nextStatus) ? now : null);

  db.prepare(
    `INSERT INTO saved_jobs (user_id, job_id, status, note, saved_at, updated_at, applied_at, title, company, url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, job_id) DO UPDATE SET
       status     = excluded.status,
       note       = COALESCE(excluded.note, saved_jobs.note),
       updated_at = excluded.updated_at,
       applied_at = COALESCE(saved_jobs.applied_at, excluded.applied_at),
       title      = COALESCE(excluded.title, saved_jobs.title),
       company    = COALESCE(excluded.company, saved_jobs.company),
       url        = COALESCE(excluded.url, saved_jobs.url)`,
  ).run(
    userId,
    jobId,
    nextStatus,
    note,
    existing?.saved_at ?? now,
    now,
    appliedAt,
    patch.title ?? null,
    patch.company ?? null,
    patch.url ?? null,
  );
  return getSaved(db, userId, jobId);
}

/**
 * Un-save. Also drops the job from every list, because a list membership whose
 * job is no longer saved is a row nothing can render.
 */
export function unsaveJob(db, userId, jobId) {
  db.prepare(
    `DELETE FROM list_items WHERE job_id = ? AND list_id IN (SELECT id FROM lists WHERE user_id = ?)`,
  ).run(jobId, userId);
  return db.prepare('DELETE FROM saved_jobs WHERE user_id = ? AND job_id = ?').run(userId, jobId).changes > 0;
}

/** Counts per status, used for the scope menu. Absent statuses come back as 0. */
export function savedCounts(db, userId) {
  const counts = Object.fromEntries(APPLICATION_STATUSES.map((s) => [s, 0]));
  for (const row of db
    .prepare('SELECT status, COUNT(*) n FROM saved_jobs WHERE user_id = ? GROUP BY status')
    .all(userId)) {
    counts[row.status] = row.n;
  }
  counts.total = Object.values(counts).reduce((a, b) => a + b, 0);
  return counts;
}

// ------------------------------------------------------------ hidden jobs --

const HIDDEN_COLUMNS = `job_id, hidden_at, title, company, url`;

/**
 * Hide a job. Idempotent: hiding one twice keeps the first timestamp, so the
 * list stays in the order you actually said no in.
 *
 * The snapshot is not optional here in the way it is for a save. A hidden job
 * is absent from every search by construction, so this row is the only place it
 * can ever be read again — without the title and the company, the page that is
 * supposed to let you take it back would be a list of opaque ids.
 */
export function hideJob(db, userId, jobId, snapshot = {}, now = Date.now()) {
  if (typeof jobId !== 'string' || !jobId || jobId.length > 300) throw new UserError('bad job id');
  db.prepare(
    `INSERT INTO hidden_jobs (user_id, job_id, hidden_at, title, company, url)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, job_id) DO UPDATE SET
       title   = COALESCE(excluded.title, hidden_jobs.title),
       company = COALESCE(excluded.company, hidden_jobs.company),
       url     = COALESCE(excluded.url, hidden_jobs.url)`,
  ).run(userId, jobId, now, snapshot.title ?? null, snapshot.company ?? null, snapshot.url ?? null);
  return getHidden(db, userId, jobId);
}

/** Un-hide. The job goes back into the searches it always matched. */
export function unhideJob(db, userId, jobId) {
  return db.prepare('DELETE FROM hidden_jobs WHERE user_id = ? AND job_id = ?').run(userId, jobId).changes > 0;
}

export function getHidden(db, userId, jobId) {
  return (
    db.prepare(`SELECT ${HIDDEN_COLUMNS} FROM hidden_jobs WHERE user_id = ? AND job_id = ?`).get(userId, jobId) ?? null
  );
}

/** Newest first: the one you just hid by mistake is the one you came back for. */
export function listHidden(db, userId) {
  return db
    .prepare(`SELECT ${HIDDEN_COLUMNS} FROM hidden_jobs WHERE user_id = ? ORDER BY hidden_at DESC`)
    .all(userId);
}

/**
 * Just the ids, as a Set — what the search engine takes to keep them out of a
 * result set. One indexed read per search, which is why this returns ids and
 * not rows: the engine has no use for a title it is about to not show.
 */
export function hiddenIds(db, userId) {
  return new Set(db.prepare('SELECT job_id FROM hidden_jobs WHERE user_id = ?').all(userId).map((r) => r.job_id));
}

export function hiddenCount(db, userId) {
  return db.prepare('SELECT COUNT(*) n FROM hidden_jobs WHERE user_id = ?').get(userId)?.n ?? 0;
}

// -------------------------------------------------------------------- lists --

export function listsFor(db, userId) {
  return db
    .prepare(
      `SELECT l.id, l.name, l.created_at, (SELECT COUNT(*) FROM list_items i WHERE i.list_id = l.id) count
       FROM lists l WHERE l.user_id = ? ORDER BY l.created_at`,
    )
    .all(userId);
}

export function createList(db, userId, name, now = Date.now()) {
  const label = String(name ?? '').trim().slice(0, 60);
  if (!label) throw new UserError('a list needs a name');
  const id = randomId('l');
  try {
    db.prepare('INSERT INTO lists (id, user_id, name, created_at) VALUES (?, ?, ?, ?)').run(id, userId, label, now);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw new UserError('you already have a list with that name', 409);
    throw err;
  }
  return { id, name: label, created_at: now, count: 0 };
}

export function renameList(db, userId, listId, name) {
  const label = String(name ?? '').trim().slice(0, 60);
  if (!label) throw new UserError('a list needs a name');
  const result = db.prepare('UPDATE lists SET name = ? WHERE id = ? AND user_id = ?').run(label, listId, userId);
  if (result.changes === 0) throw new UserError('no such list', 404);
  return true;
}

export function deleteList(db, userId, listId) {
  return db.prepare('DELETE FROM lists WHERE id = ? AND user_id = ?').run(listId, userId).changes > 0;
}

/**
 * Filing a job into a list saves it first if it was not saved.
 *
 * "Add to my apply-this-week list" plainly means "and keep it", and a list
 * whose members are not in `saved_jobs` would have no status, no note and no
 * snapshot to render.
 */
export function addToList(db, userId, listId, jobId, snapshot = {}, now = Date.now()) {
  const list = db.prepare('SELECT id FROM lists WHERE id = ? AND user_id = ?').get(listId, userId);
  if (!list) throw new UserError('no such list', 404);
  if (!getSaved(db, userId, jobId)) saveJob(db, userId, jobId, snapshot, now);
  db.prepare('INSERT OR IGNORE INTO list_items (list_id, job_id, added_at) VALUES (?, ?, ?)').run(listId, jobId, now);
  return true;
}

export function removeFromList(db, userId, listId, jobId) {
  const list = db.prepare('SELECT id FROM lists WHERE id = ? AND user_id = ?').get(listId, userId);
  if (!list) throw new UserError('no such list', 404);
  return db.prepare('DELETE FROM list_items WHERE list_id = ? AND job_id = ?').run(listId, jobId).changes > 0;
}

/** `{ jobId: [listId, …] }` for every saved job — one query, drawn on the cards. */
export function listMembership(db, userId) {
  const out = {};
  for (const row of db
    .prepare(
      `SELECT i.job_id, i.list_id FROM list_items i JOIN lists l ON l.id = i.list_id WHERE l.user_id = ?`,
    )
    .all(userId)) {
    (out[row.job_id] ??= []).push(row.list_id);
  }
  return out;
}

/** Everything the UI needs to draw the account panel, in one round trip. */
export function accountState(db, userId) {
  return {
    saved: listSaved(db, userId),
    counts: savedCounts(db, userId),
    lists: listsFor(db, userId),
    membership: listMembership(db, userId),
    profiles: listUserProfiles(db, userId),
    // The count, not the rows. The page needs a number for the tab; the rows
    // are only ever read on the one screen that asks for them, and a reader
    // with 800 hidden jobs should not carry all 800 into every page load.
    hidden_count: hiddenCount(db, userId),
  };
}
