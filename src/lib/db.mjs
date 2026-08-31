/**
 * SQLite store.
 *
 * `node:sqlite` ships with Node 24, so this has no install step. Everything the
 * sweep writes goes through `upsertJobs`, which is deliberately the only write
 * path — it is what keeps `first_seen`, `content_hash` and the `job_events`
 * history consistent, and those are what make "what's new since yesterday"
 * possible on an API (Ashby's) that has no `updatedAt`.
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DDL, SCHEMA_VERSION, SECTOR_VALUES, companyId, jobId, normText } from './schema.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_DB_PATH = join(ROOT, 'data', 'jobs.db');

export function openDb(path = DEFAULT_DB_PATH, { readonly = false } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { readOnly: readonly });
  // SQLite's default busy timeout is 0: a locked database throws immediately
  // rather than waiting. That is the wrong default for anything unattended —
  // the 08:15 launchd run would die on the spot because `server.mjs` happened
  // to be up or a derive pass was still writing, and all it would leave behind
  // is a stack trace in data/daily.log. Set it before the DDL below, which
  // takes a write lock of its own.
  db.exec('PRAGMA busy_timeout = 30000;');
  if (!readonly) {
    // Renames run *before* the DDL: its `CREATE INDEX` statements name the new
    // columns, so an un-renamed database would fail on the index, not the data.
    renameColumns(db);
    db.exec(DDL);
    migrate(db);
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
      'schema_version',
      String(SCHEMA_VERSION),
    );
  } else {
    db.exec('PRAGMA temp_store = MEMORY;');
  }
  db.exec('PRAGMA cache_size = -200000;'); // ~200 MB page cache
  return db;
}

const hasColumn = (db, table, column) =>
  db.prepare(`SELECT COUNT(*) n FROM pragma_table_info(?) WHERE name = ?`).get(table, column).n > 0;

/**
 * Apply the renames the schema has been through, before the DDL runs.
 *
 * Renames get their own pass rather than hiding among the additive columns
 * below: they are not free, and every reader of the old name has to move in the
 * same commit. They also have to precede the DDL, whose `CREATE INDEX` lines
 * name the new column — on a database still holding the old one, the index is
 * what fails, which reads as a schema bug rather than a pending migration.
 *
 * `RENAME COLUMN` carries the indexes with it, and the guard makes a re-run and
 * a brand-new database both no-ops.
 */
export function renameColumns(db) {
  const done = [];
  for (const [table, from, to] of RENAMED_COLUMNS) {
    if (hasColumn(db, table, from) && !hasColumn(db, table, to)) {
      db.exec(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`);
      done.push(`${table}.${from} → ${table}.${to}`);
    }
  }
  // `RENAME COLUMN` rewrites an index's definition but keeps its old *name*, so
  // the DDL below then builds a second index over the same column. Dropping the
  // old name leaves exactly one, the one the DDL declares.
  for (const name of ORPHANED_INDEXES) db.exec(`DROP INDEX IF EXISTS ${name}`);
  return done;
}

// `family` was our own word for it; `job function` is what job boards call the
// same field, and `department` was already taken by the raw ATS string.
const RENAMED_COLUMNS = [
  ['jobs', 'd_job_family', 'd_job_function'],
];

const ORPHANED_INDEXES = ['idx_jobs_family'];

/**
 * Add columns the DDL has grown since this database was created.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table, so a new
 * derived column would silently never appear on the 61,213 rows already swept.
 * `ADD COLUMN` is O(1) metadata in SQLite, so this is cheap enough to run on
 * every open. Only additive changes belong here — a rename goes above, and
 * anything beyond either is a real migration and should say so out loud.
 */
export function migrate(db) {
  const changed = [];
  for (const [table, column, type] of ADDITIVE_COLUMNS) {
    if (!hasColumn(db, table, column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      changed.push(`+${table}.${column}`);
    }
  }
  for (const [table, column] of DROPPED_COLUMNS) {
    if (hasColumn(db, table, column)) {
      db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
      changed.push(`-${table}.${column}`);
    }
  }
  return changed;
}

const ADDITIVE_COLUMNS = [
  ['jobs', 'd_salary_src', 'TEXT'],
  // The enrich pass's columns, on databases built before it existed.
  ['companies', 'sector', 'TEXT'],
  ['companies', 'blurb', 'TEXT'],
  ['companies', 'sector_src', 'TEXT'],
  ['companies', 'sector_at', 'INTEGER'],
];

/**
 * Columns that used to exist and should not any more.
 *
 * `job_content.description_html` was a second copy of every description --
 * 2.3 GB of the corpus -- that nothing ever rendered. The detail pane draws
 * `description_text` through `textContent`, so the HTML was fetched by the
 * API, sent over the wire and dropped on the floor. The adapters no longer
 * write it; this drops it from databases built before they stopped.
 *
 * Dropping a column frees its pages but does not shrink the file: SQLite marks
 * them reusable and keeps the size. `npm run vacuum` is what returns the disk.
 */
const DROPPED_COLUMNS = [
  ['job_content', 'description_html'],
];

export function getMeta(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setMeta(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, String(value));
}

/**
 * Content fingerprint used to detect an edited posting.
 *
 * `descriptionLength` overrides the length taken from `job.description_text`,
 * and exists for the one adapter that does not re-read every description on
 * every sweep. Workday keeps its prose behind a request per job, so a job whose
 * text is already stored comes back from the adapter with no `description_text`
 * at all (see `adapters/workday.mjs`). Hashing that as a zero-length
 * description would differ from the stored hash and mark the job `changed` on
 * every sweep for the rest of its life, filling the event log with edits that
 * never happened. `upsertBoard` passes the stored length instead, so an
 * untouched job hashes to exactly what it hashed to yesterday.
 */
export function hashJob(job, descriptionLength) {
  return createHash('sha1')
    .update(
      [
        job.title,
        job.location_raw,
        job.employment_type,
        job.comp_min,
        job.comp_max,
        job.department,
        descriptionLength ?? (job.description_text ?? '').length,
      ].join('\0'),
    )
    .digest('hex')
    .slice(0, 16);
}

const today = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 10);

/**
 * Insert or update one board's jobs, and reconcile disappearances.
 *
 * @param {DatabaseSync} db
 * @param {object} board  `{ ats, slug, name, url, etag, jobs: [] }`
 * @param {number} now    Sweep timestamp — shared across a run so `last_seen`
 *                        comparisons are exact rather than drifting per row.
 * @returns {{ seen:number, added:number, changed:number, closed:number }}
 */
export function upsertBoard(db, board, now = Date.now()) {
  const { ats, slug, jobs = [] } = board;
  const cid = companyId(ats, slug);
  const day = today(now);

  db.prepare(
    `INSERT INTO companies (id, ats, slug, name, name_source, board_url, job_count,
                            first_seen, last_seen, last_swept, last_etag, status, discovery)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name       = COALESCE(excluded.name, companies.name),
       name_source= COALESCE(excluded.name_source, companies.name_source),
       board_url  = COALESCE(excluded.board_url, companies.board_url),
       job_count  = excluded.job_count,
       last_seen  = excluded.last_seen,
       last_swept = excluded.last_swept,
       last_etag  = excluded.last_etag,
       status     = excluded.status,
       discovery  = COALESCE(companies.discovery, excluded.discovery)`,
  ).run(
    cid,
    ats,
    slug,
    board.name ?? null,
    board.name ? (board.nameSource ?? 'api') : null,
    board.url ?? null,
    jobs.length,
    now,
    now,
    now,
    board.etag ?? null,
    jobs.length > 0 ? 'live' : 'empty',
    board.discovery ?? null,
  );

  // `desc_len` joins in the length of the description already stored, for the
  // hash of a job whose prose was deliberately not re-fetched. See `hashJob`.
  // The join costs one index seek per board against a table already keyed by
  // job_id, on a query that was already reading every job on the board.
  const existing = new Map(
    db
      .prepare(
        `SELECT j.id, j.content_hash, j.is_open, LENGTH(c.description_text) AS desc_len
           FROM jobs j
           LEFT JOIN job_content c ON c.job_id = j.id
          WHERE j.company_id = ?`,
      )
      .all(cid)
      .map((r) => [r.id, r]),
  );

  const insertJob = db.prepare(`
    INSERT INTO jobs (
      id, ats, company_id, company_slug, company_name, native_id,
      title, title_norm, department, team, employment_type,
      location_raw, locations_all, country, region, city, postal_code,
      raw_workplace, raw_remote,
      posted_at, source_updated_at, first_seen, last_seen, is_open, content_hash,
      url, apply_url, comp_min, comp_max, comp_currency, comp_interval, comp_text, has_equity
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      company_name      = COALESCE(excluded.company_name, jobs.company_name),
      title             = excluded.title,
      title_norm        = excluded.title_norm,
      department        = excluded.department,
      team              = excluded.team,
      employment_type   = excluded.employment_type,
      -- Coalesced, like the description below it and for the same reason: an
      -- adapter that could not read a job's location this time leaves these
      -- undefined, and a sweep that learned nothing must not erase what an
      -- earlier one learned. Workday is why — its listing collapses a
      -- multi-location posting to "3 Locations", and every incremental sweep
      -- was overwriting nine real cities with that placeholder.
      location_raw      = COALESCE(excluded.location_raw, jobs.location_raw),
      locations_all     = COALESCE(excluded.locations_all, jobs.locations_all),
      country           = COALESCE(excluded.country, jobs.country),
      region            = excluded.region,
      city              = excluded.city,
      postal_code       = excluded.postal_code,
      raw_workplace     = excluded.raw_workplace,
      raw_remote        = excluded.raw_remote,
      posted_at         = COALESCE(excluded.posted_at, jobs.posted_at),
      source_updated_at = excluded.source_updated_at,
      last_seen         = excluded.last_seen,
      is_open           = 1,
      content_hash      = excluded.content_hash,
      url               = excluded.url,
      apply_url         = excluded.apply_url,
      comp_min          = excluded.comp_min,
      comp_max          = excluded.comp_max,
      comp_currency     = excluded.comp_currency,
      comp_interval     = excluded.comp_interval,
      comp_text         = excluded.comp_text,
      has_equity        = excluded.has_equity,
      -- An edited posting overwrites every column the derive pass reads, so the
      -- d_* columns beside them are now answers to the old question. Clearing
      -- the stamp is what puts the job back in front of derive.mjs --only-new,
      -- whose whole selector is "d_derived_at IS NULL"; without this a job that
      -- moves keeps its first day's derivation for the rest of its life. Found
      -- on a Chainalysis role that moved Seoul to Tokyo and kept a country of
      -- kr, and on its neighbour, which kept no metro at all and so answered
      -- "not New York? cannot say" to a New York search.
      d_derived_at      = CASE WHEN jobs.content_hash IS NOT excluded.content_hash
                               THEN NULL ELSE jobs.d_derived_at END
  `);

  // Two statements, because an absent description and an empty one mean
  // different things and SQL cannot tell them apart once both are NULL.
  //
  // A job with no `description_text` key at all is saying "I did not read one"
  // — the Workday adapter skips the request for prose it already stored, and a
  // detail fetch that simply failed looks identical from here. Either way the
  // stored text stays exactly as it is; overwriting it would blank a good
  // description and the derive pass would quietly lose the skills, degree and
  // visa signals that only the prose carries.
  //
  // A job whose `description_text` is null was read and found empty, and that
  // lands like any other edit: the posting no longer has prose, so neither
  // does the store.
  const insertContent = db.prepare(
    `INSERT INTO job_content (job_id, description_text)
     VALUES (?, ?)
     ON CONFLICT(job_id) DO UPDATE SET
       description_text = excluded.description_text`,
  );
  const keepContent = db.prepare(
    'INSERT OR IGNORE INTO job_content (job_id, description_text) VALUES (?, NULL)',
  );

  const insertEvent = db.prepare(
    'INSERT OR IGNORE INTO job_events (job_id, day, event) VALUES (?, ?, ?)',
  );

  let added = 0;
  let changed = 0;
  const seenIds = new Set();

  for (const job of jobs) {
    const id = job.id ?? jobId(ats, slug, job.native_id);
    seenIds.add(id);
    const prior = existing.get(id);
    // `undefined` means the adapter did not read a description this time;
    // `null` means it read one and there was nothing there. Only the first
    // hashes against what is already stored.
    const unread = job.description_text === undefined;
    const hash = hashJob(job, unread ? (prior?.desc_len ?? 0) : undefined);

    insertJob.run(
      id,
      ats,
      cid,
      slug,
      job.company_name ?? board.name ?? null,
      job.native_id ?? null,
      job.title ?? '',
      job.title_norm ?? normText(job.title),
      job.department ?? null,
      job.team ?? null,
      job.employment_type ?? null,
      job.location_raw ?? null,
      job.locations_all === undefined ? null : JSON.stringify(job.locations_all ?? []),
      job.country ?? null,
      job.region ?? null,
      job.city ?? null,
      job.postal_code ?? null,
      job.raw_workplace ?? null,
      job.raw_remote == null ? null : job.raw_remote ? 1 : 0,
      job.posted_at ?? null,
      job.source_updated_at ?? null,
      now, // first_seen — the DO UPDATE clause omits it, so it sticks at insert time
      now,
      1,
      hash,
      job.url ?? null,
      job.apply_url ?? null,
      job.comp_min ?? null,
      job.comp_max ?? null,
      job.comp_currency ?? null,
      job.comp_interval ?? null,
      job.comp_text ?? null,
      job.has_equity == null ? null : job.has_equity ? 1 : 0,
    );

    if (unread) keepContent.run(id);
    else insertContent.run(id, job.description_text ?? null);

    if (!prior) {
      added++;
      insertEvent.run(id, day, 'appeared');
    } else {
      if (prior.is_open === 0) insertEvent.run(id, day, 'reappeared');
      if (prior.content_hash !== hash) {
        changed++;
        insertEvent.run(id, day, 'changed');
      }
    }
  }

  // Anything the board no longer lists is closed, not deleted — history is the
  // point, and a re-listed role should read as "reappeared", not "brand new".
  let closed = 0;
  const closeStmt = db.prepare('UPDATE jobs SET is_open = 0, last_seen = ? WHERE id = ?');
  for (const [id, row] of existing) {
    if (!seenIds.has(id) && row.is_open === 1) {
      closeStmt.run(now, id);
      insertEvent.run(id, day, 'disappeared');
      closed++;
    }
  }

  return { seen: jobs.length, added, changed, closed };
}

/**
 * Record what the enrich pass read about one company.
 *
 * The only write path for the four `sector*` columns, so that "was this company
 * ever read?" has one answer: `sector_at` is set on every call, including one
 * that found no bucket to commit to. A NULL `sector` under a set `sector_at` is
 * "read, and unsure" — the filter treats it as unknown, and `--only-new` does
 * not re-spend a call on it. `--all` does.
 *
 * `sector` is checked against `SECTOR_VALUES` here as well as by the caller: an
 * enum the filter has never heard of stored on 300 companies would be a facet
 * row nobody can tick and a criterion that quietly matches nothing.
 */
export function recordSector(db, id, { sector = null, blurb = null, src = null, at = Date.now() } = {}) {
  const value = sector && SECTOR_VALUES.includes(sector) ? sector : null;
  const text = typeof blurb === 'string' && blurb.trim() ? blurb.trim() : null;
  return db
    .prepare('UPDATE companies SET sector = ?, blurb = ?, sector_src = ?, sector_at = ? WHERE id = ?')
    .run(value, text, src, at, id).changes;
}

/** Mark a board dead (404) without touching its historical jobs. */
export function markBoard(db, ats, slug, status, now = Date.now()) {
  const cid = companyId(ats, slug);
  db.prepare(
    `INSERT INTO companies (id, ats, slug, first_seen, last_seen, last_swept, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET last_swept = excluded.last_swept, status = excluded.status`,
  ).run(cid, ats, slug, now, now, now, status);
  if (status === 'dead') {
    db.prepare('UPDATE jobs SET is_open = 0 WHERE company_id = ? AND is_open = 1').run(cid);
  }
}

/**
 * Record that a board was swept and found unchanged — the 304 path.
 *
 * Deliberately not `markBoard(…, 'unchanged')`: that would overwrite
 * `companies.status`, and `live` / `empty` / `dead` is the vocabulary the whole
 * pipeline reads (`boards_live`, the sweeper's fallback slug list, the
 * removal-not-deletion rule). "Unchanged" is a fact about this sweep, not a new
 * state for the board, so only the timestamps move.
 *
 * Job rows are left open and their `last_seen` is bumped, because that is what
 * a 304 actually means: the board's response is byte-identical, so every job it
 * listed is still listed. Closing them, or letting `last_seen` go stale, would
 * make a working cache look like a company that stopped hiring.
 */
export function touchBoard(db, ats, slug, now = Date.now()) {
  const cid = companyId(ats, slug);
  db.prepare(
    'UPDATE companies SET last_seen = ?, last_swept = ? WHERE id = ?',
  ).run(now, now, cid);
  db.prepare('UPDATE jobs SET last_seen = ? WHERE company_id = ? AND is_open = 1').run(now, cid);
}

/** Record a probe verdict so mutation never re-tries a known-dead string. */
export function recordAttempt(db, { ats, slug, status, verdict, strategy, seed, rank }, now = Date.now()) {
  db.prepare(
    `INSERT INTO slug_attempts (ats, slug, status, verdict, strategy, seed, rank, tried_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(ats, slug) DO UPDATE SET
       status = excluded.status, verdict = excluded.verdict, tried_at = excluded.tried_at`,
  ).run(ats, slug, status ?? null, verdict, strategy ?? null, seed ?? null, rank ?? null, now);
}

export function knownSlugs(db, ats) {
  return new Set(
    db.prepare('SELECT slug FROM slug_attempts WHERE ats = ?').all(ats).map((r) => r.slug),
  );
}

/** Wrap a callback in one transaction. Bulk inserts are ~50x faster inside one. */
export function transact(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    throw err;
  }
}
