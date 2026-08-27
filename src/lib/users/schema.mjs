/**
 * The accounts store — schema.
 *
 * Everything here lives in `data/users.db`, **not** in `data/jobs.db`, and the
 * split is load-bearing for three reasons:
 *
 *  1. `data/jobs.db` is committed to this repository. A password hash, a
 *     session token or someone's list of jobs they applied to must never be a
 *     git object. `data/users.db` is gitignored.
 *  2. The two have opposite lifecycles. The corpus is disposable — delete it,
 *     re-sweep, re-derive, and nothing of value is lost. An account is the
 *     opposite: it is the only thing here a person actually authored.
 *  3. A corpus rebuild must not cascade into user data. With one database and a
 *     real foreign key, `saved_jobs` would be deleted by a `jobs` row vanishing.
 *
 * Because they are separate databases there is no foreign key from `saved_jobs`
 * to `jobs`, so a saved row also carries a **snapshot** of the title, company
 * and URL as they read on the day it was saved. That is not denormalization for
 * speed; it is the answer to "what happens to my applied-to list when the job is
 * pulled from the board" — the honest answer being that it still reads
 * correctly, which is what someone tracking an application needs.
 *
 * The three-valued rule the filter engine follows applies here too, in its own
 * form: a field nobody filled in is NULL, never a default that reads as an
 * answer. `applied_at` is null until you actually mark it applied.
 */

/**
 * Where a saved job is in the pipeline.
 *
 * Ordered as the process runs, and it is a small closed list on purpose: a free
 * text status would be unsortable, uncountable and unfilterable, and the whole
 * point of tracking this is being able to ask "what have I applied to and heard
 * nothing back on".
 *
 * `saved` is the state a ★ leaves a job in — "I want to look at this again",
 * which is different from having done anything about it.
 */
export const APPLICATION_STATUSES = ['saved', 'applied', 'interviewing', 'offer', 'rejected'];

/** Human labels for the statuses, so the UI does not keep its own copy. */
export const STATUS_LABELS = {
  saved: 'Saved',
  applied: 'Applied',
  interviewing: 'Interviewing',
  offer: 'Offer',
  rejected: 'Rejected',
};

/** Statuses that mean "I have actually acted on this". Drives `applied_at`. */
export const ACTED_ON = new Set(['applied', 'interviewing', 'offer', 'rejected']);

/** Profile and list names become URL segments and are shown verbatim. */
export const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export const USERS_SCHEMA_VERSION = 2;

/** How long a session cookie stays valid without being used. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ------------------------------------------------------------------ users --
-- password_hash is nullable: an account created through Google has no
-- password and never should be given a blank one, because a blank one is a
-- password that can be guessed.
CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,        -- "u_" + 16 random hex
  email          TEXT NOT NULL UNIQUE,    -- lowercased at write time
  email_verified INTEGER NOT NULL DEFAULT 0,
  display_name   TEXT,
  password_hash  TEXT,                    -- NULL for provider-only accounts
  created_at     INTEGER NOT NULL,
  last_seen_at   INTEGER
);

-- External sign-in methods. Kept in its own table rather than as columns on
-- users so that adding a second provider is a row, not a migration, and so
-- one account can be reachable by both a password and Google.
CREATE TABLE IF NOT EXISTS identities (
  provider  TEXT NOT NULL,                -- 'google'
  subject   TEXT NOT NULL,                -- the provider's own stable user id
  user_id   TEXT NOT NULL,
  email     TEXT,
  linked_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_identities_user ON identities(user_id);

-- The cookie value itself is never stored — only its SHA-256. A stolen copy of
-- this database therefore cannot be used to impersonate anyone, which is the
-- one property that makes a session table safe to keep on disk.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  user_agent   TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Short-lived OAuth handshake state: one row per sign-in attempt, carrying the
-- CSRF state token and the PKCE verifier. In the database rather than a cookie
-- so the callback works even when the browser drops the cookie on the redirect
-- back from Google.
CREATE TABLE IF NOT EXISTS oauth_states (
  state      TEXT PRIMARY KEY,
  provider   TEXT NOT NULL,
  verifier   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- --------------------------------------------------------------- profiles --
-- A saved filter document. Stored as the same JSON the CLI reads off disk and
-- the UI posts to /api/search — an account changes where a profile lives, never
-- what a profile is, which is what keeps "someone else's search is a different
-- document, not a different build" true once there is more than one someone.
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  document   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, name),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Small key/value bag for per-user state that is not a named profile: the
-- working filter document (so a returning user does not re-enter anything),
-- the last scope they were looking at, and so on.
CREATE TABLE IF NOT EXISTS user_settings (
  user_id    TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ------------------------------------------------------------ saved jobs --
CREATE TABLE IF NOT EXISTS saved_jobs (
  user_id    TEXT NOT NULL,
  job_id     TEXT NOT NULL,          -- "<ats>:<slug>:<native id>", no FK by design
  status     TEXT NOT NULL DEFAULT 'saved',
  note       TEXT,
  saved_at   INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  applied_at INTEGER,                -- when it first became 'applied' or later
  -- snapshot, taken at save time, so the row still reads correctly after the
  -- posting is pulled or the corpus is rebuilt from scratch
  title      TEXT,
  company    TEXT,
  url        TEXT,
  PRIMARY KEY (user_id, job_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_saved_status ON saved_jobs(user_id, status);

-- ----------------------------------------------------------- hidden jobs --
-- Jobs you answered "no" to. They are kept out of every search you run from
-- then on, which is the only criterion in this project that is about a single
-- posting rather than about what a posting is — and that is exactly why it
-- lives here and not in a filter profile. A profile is a portable document
-- describing a kind of job; "not this one, and not that one" is a fact about
-- you, it belongs to the account, and it has to survive being applied to a
-- profile you have never opened.
--
-- Snapshotted for the same reason saved_jobs is, and it matters more here: the
-- hidden list is the *only* place a hidden job can be read, because by
-- construction it is missing from every search. Without the snapshot, a corpus
-- rebuild would leave a page of rows nothing could render, and the un-hide
-- button would be the only thing on it.
--
-- Deliberately independent of saved_jobs. Hiding a job you applied to and were
-- rejected from is a sensible thing to do, and the two tables answer different
-- questions: what did I do about this, and do I want to see it again.
CREATE TABLE IF NOT EXISTS hidden_jobs (
  user_id   TEXT NOT NULL,
  job_id    TEXT NOT NULL,          -- "<ats>:<slug>:<native id>", no FK by design
  hidden_at INTEGER NOT NULL,
  title     TEXT,
  company   TEXT,
  url       TEXT,
  PRIMARY KEY (user_id, job_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------- lists --
-- A named bucket. Orthogonal to status on purpose: "apply this week" and
-- "applied" answer different questions, and forcing one to stand in for the
-- other is how a tracker stops matching how anyone actually works.
CREATE TABLE IF NOT EXISTS lists (
  id         TEXT PRIMARY KEY,       -- "l_" + 16 random hex
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, name),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS list_items (
  list_id  TEXT NOT NULL,
  job_id   TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (list_id, job_id),
  FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_list_items_job ON list_items(job_id);
`;
