#!/usr/bin/env node
/**
 * Store tests.
 *
 *   node src/db-test.mjs
 *
 * `upsertBoard` is the only write path into the corpus, and `search()` is the
 * only read path the page uses. Neither had a test that touched a database:
 * the filter tests exercise the criteria on hand-built rows, so they cannot
 * see what happens between SQLite and the in-memory index.
 *
 * The case that prompted this: `url` and `apply_url` left the index on
 * 2026-08-26 and are read from SQLite for the rows on the page instead, so a
 * result row must still carry both and the index row must not.
 *
 * Uses a throwaway file in the OS temp directory, like `users-test.mjs`, so it
 * never sees `data/jobs.db` and leaves nothing behind.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, upsertBoard } from './lib/db.mjs';
import { blankJob, jobId } from './lib/schema.mjs';
import { search, getIndex, invalidateIndex } from './lib/filter/index.mjs';

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed++;
  else failures.push(`${name}\n      got      ${a}\n      expected ${e}`);
}

const dir = mkdtempSync(join(tmpdir(), 'jobfinder-db-'));
const db = openDb(join(dir, 'jobs.db'));

// One sweep per calendar day. `job_events` is keyed on (job, day, event), so
// two sweeps on the same day would fold their events together and hide a
// second `changed`.
const day = (n) => Date.parse('2026-08-20T09:00:00Z') + n * 86_400_000;

const job = (over = {}) => ({
  ...blankJob(),
  ats: 'ashby',
  company_slug: 'acme',
  native_id: 'j1',
  title: 'Solutions Engineer',
  title_norm: 'solutions engineer',
  location_raw: 'New York, NY',
  locations_all: ['New York, NY'],
  url: 'https://jobs.ashbyhq.com/acme/j1',
  apply_url: 'https://jobs.ashbyhq.com/acme/j1/application',
  description_text: 'Build things with SQL and Python.',
  ...over,
});

const board = (jobs, over = {}) => ({
  ats: 'ashby',
  slug: 'acme',
  name: 'Acme',
  url: 'https://jobs.ashbyhq.com/acme',
  etag: null,
  jobs,
  ...over,
});

const ID = jobId('ashby', 'acme', 'j1');
const stored = (id = ID) =>
  db.prepare('SELECT description_text FROM job_content WHERE job_id = ?').get(id)?.description_text;
const events = (id = ID) =>
  db.prepare('SELECT event FROM job_events WHERE job_id = ? ORDER BY day, rowid').all(id).map((r) => r.event);

try {
  // ------------------------------------------------------------ a sweep --
  {
    check('first sweep: the job is added', upsertBoard(db, board([job()]), day(0)), { seen: 1, added: 1, changed: 0, closed: 0 });
    check('first sweep: the description is stored', stored(), 'Build things with SQL and Python.');
    check('first sweep: one appeared event', events(), ['appeared']);
    check('unchanged: an identical job is not a change', upsertBoard(db, board([job()]), day(1)).changed, 0);
    check('new prose: a change', upsertBoard(db, board([job({ description_text: 'Now with Rust.' })]), day(2)).changed, 1);
    check('new prose: replaces the old', stored(), 'Now with Rust.');
    upsertBoard(db, board([job()]), day(3));
  }

  // ----------------------------------------------------------- the links --
  {
    upsertBoard(db, board([job(), job({ native_id: 'j2', url: 'https://jobs.ashbyhq.com/acme/j2', apply_url: null })]), day(4));
    invalidateIndex();
    const index = getIndex(db, { force: true });
    check('index: two open jobs', index.jobs.length, 2);
    // Not on the indexed row. Holding them for every job in the corpus was the
    // largest string cost in the index, for a field only the page reads.
    check('index: url is not held in memory', 'url' in index.jobs[0], false);
    check('index: apply_url is not held in memory', 'apply_url' in index.jobs[0], false);

    const { results, total } = search(db, {}, { facets: false });
    check('search: an empty profile returns everything', total, 2);
    const byId = new Map(results.map((r) => [r.id, r]));
    check('search: url comes back on the row', byId.get(ID)?.url, 'https://jobs.ashbyhq.com/acme/j1');
    check('search: apply_url comes back on the row', byId.get(ID)?.apply_url, 'https://jobs.ashbyhq.com/acme/j1/application');
    check('search: a missing apply_url is null, not undefined', byId.get(jobId('ashby', 'acme', 'j2'))?.apply_url, null);
  }

  // ---------------------------------------------------------- disappearance --
  {
    const r = upsertBoard(db, board([job()]), day(5));
    check('closed: a job the board no longer lists is closed, not deleted', [r.closed, stored(jobId('ashby', 'acme', 'j2'))], [1, 'Build things with SQL and Python.']);
    check('closed: the event log says disappeared', events(jobId('ashby', 'acme', 'j2')).at(-1), 'disappeared');
    upsertBoard(db, board([job(), job({ native_id: 'j2' })]), day(6));
    check('closed: a relisted job reappears rather than being born again', events(jobId('ashby', 'acme', 'j2')).at(-1), 'reappeared');
  }
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} failing:\n`);
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  console.error(`${passed} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`✓ ${passed} store checks passed`);
