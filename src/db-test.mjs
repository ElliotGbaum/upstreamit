#!/usr/bin/env node
/**
 * Store tests.
 *
 *   node src/db-test.mjs
 *
 * `upsertBoard` is the only write path into the corpus, and two of its rules
 * exist for an adapter that does not re-read every description on every sweep
 * (Workday keeps its prose one request per job, so the sweep skips the request
 * for text it already holds). Both are the kind of thing a reasonable-looking
 * edit would break without any other test noticing:
 *
 *  - a job that comes back with `description_text` *absent* keeps the text
 *    already stored, and hashes to what it hashed to yesterday, so a skipped
 *    request is never recorded as an edit that did not happen;
 *  - a job that comes back with `description_text: null` was read and found
 *    empty, and that is a real change.
 *
 * `search()` is exercised here too, for the one thing the filter tests cannot
 * see: `url` and `apply_url` left the in-memory index on 2026-08-26 and are
 * read from SQLite for the rows on the page, so a result row must still carry
 * both. And `searchYielding` — the one the server runs — must actually hand
 * the event loop back mid-scan, or every other request waits for the search.
 *
 * Uses a throwaway file in the OS temp directory, like `users-test.mjs`, so it
 * never sees `data/jobs.db` and leaves nothing behind.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, upsertBoard, hashJob } from './lib/db.mjs';
import { blankJob, jobId } from './lib/schema.mjs';
import { search, searchYielding, getIndex, invalidateIndex } from './lib/filter/index.mjs';

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
const hashOf = (id = ID) => db.prepare('SELECT content_hash FROM jobs WHERE id = ?').get(id)?.content_hash;
const events = (id = ID) =>
  db.prepare('SELECT event FROM job_events WHERE job_id = ? ORDER BY day, rowid').all(id).map((r) => r.event);
const company = () =>
  db.prepare("SELECT name, name_source FROM companies WHERE id = 'ashby:acme'").get();

try {
  // ------------------------------------------------- the description rules --
  {
    check('first sweep: the job is added', upsertBoard(db, board([job()]), day(0)), { seen: 1, added: 1, changed: 0, closed: 0 });
    check('first sweep: the description is stored', stored(), 'Build things with SQL and Python.');
    check('first sweep: one appeared event', events(), ['appeared']);
    const hash = hashOf();

    check('unchanged: an identical job is not a change', upsertBoard(db, board([job()]), day(1)).changed, 0);

    // The adapter did not read the description this time. Nothing about the
    // job may move: not the text, not the hash, not the event log.
    const unread = job();
    delete unread.description_text;
    check('unread: not a change', upsertBoard(db, board([unread]), day(2)).changed, 0);
    check('unread: the stored text survives', stored(), 'Build things with SQL and Python.');
    check('unread: the hash is what it was', hashOf(), hash);
    check('unread: no event is written', events(), ['appeared']);

    // The adapter read it and there was nothing. That is a change, and the
    // stored text goes with it.
    check('read as empty: a change', upsertBoard(db, board([job({ description_text: null })]), day(3)).changed, 1);
    check('read as empty: the stored text is gone', stored(), null);
    check('read as empty: the event says so', events(), ['appeared', 'changed']);

    check('new prose: a change', upsertBoard(db, board([job({ description_text: 'Now with Rust.' })]), day(4)).changed, 1);
    check('new prose: replaces the old', stored(), 'Now with Rust.');

    // Same length, different words. The hash is a content fingerprint of the
    // fields plus the description *length*, so this is the one edit it
    // cannot see; the test pins that as the known trade rather than a bug.
    check('same-length edit: invisible to the hash', upsertBoard(db, board([job({ description_text: 'Now with Java.' })]), day(5)).changed, 0);

    // Back to the original prose, so the blocks below start from a known job.
    upsertBoard(db, board([job()]), day(5));
  }

  // A job first seen without prose gains some later. That is a change — the
  // first sweep hashed it against a stored length of zero.
  {
    const first = job({ native_id: 'j2', url: 'https://jobs.ashbyhq.com/acme/j2' });
    delete first.description_text;
    const id = jobId('ashby', 'acme', 'j2');
    const r = upsertBoard(db, board([job(), first]), day(6));
    check('born unread: added', [r.added, r.changed], [1, 0]);
    check('born unread: nothing stored', stored(id), null);
    const hydrated = job({ native_id: 'j2', url: 'https://jobs.ashbyhq.com/acme/j2', description_text: 'Prose at last.' });
    check('born unread: gaining prose is a change', upsertBoard(db, board([job(), hydrated]), day(7)).changed, 1);
    check('born unread: the prose is stored', stored(id), 'Prose at last.');
  }

  // `hashJob` on its own: the override stands in for a description that was
  // not read, and only its length matters.
  {
    const j = job();
    const bare = job();
    delete bare.description_text;
    check('hashJob: an unread description hashes by stored length', hashJob(bare, j.description_text.length), hashJob(j));
    check('hashJob: a different stored length is a different hash', hashJob(bare, j.description_text.length + 1) === hashJob(j), false);
    check('hashJob: with no override, absent and empty hash alike', hashJob(bare), hashJob(job({ description_text: '' })));
  }

  // ------------------------------------------------------- the board name --
  {
    check('name: stated by the API', company(), { name: 'Acme', name_source: 'api' });
    upsertBoard(db, board([job()], { name: 'Acme Corp', nameSource: 'derived' }), day(8));
    check('name: worked out from a URL says so', company(), { name: 'Acme Corp', name_source: 'derived' });
    // An incremental sweep that hydrated nothing learns no name. The stored
    // one, and how it was learned, both stay.
    upsertBoard(db, board([job()], { name: null }), day(9));
    check('name: an adapter with no name keeps the stored one', company(), { name: 'Acme Corp', name_source: 'derived' });
  }

  // ----------------------------------------------------------- the links --
  {
    upsertBoard(db, board([job(), job({ native_id: 'j2', url: 'https://jobs.ashbyhq.com/acme/j2', apply_url: null })]), day(10));
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

  // -------------------------------------------------------- hidden jobs --
  // The set a signed-in reader's × builds, handed to the engine as ids. The
  // engine knows nothing about accounts; this is the whole of the contract.
  {
    const hidden = search(db, {}, { facets: false, exclude: new Set([ID]) });
    check('exclude: the hidden job is not in the results', hidden.results.map((r) => r.id), [jobId('ashby', 'acme', 'j2')]);
    check('exclude: nor in the total', hidden.total, 1);
    // Counted, because a list that quietly shrinks is indistinguishable from a
    // filter that went wrong — and this is the number the page offers a way
    // back from.
    check('exclude: but it is counted', hidden.funnel.hidden, 1);
    check('exclude: an empty set changes nothing', search(db, {}, { facets: false, exclude: new Set() }).total, 2);
    check('exclude: no set at all changes nothing', search(db, {}, { facets: false }).funnel.hidden, 0);

    // The facets are counts of the match set, so a hidden job must be out of
    // them too: a control promising "+1 job" that cannot appear in the list is
    // a number the list cannot keep. Checked as a before and after, because
    // "0" would pass on a facet that was never going to count anything.
    const workplace = (opts) =>
      search(db, {}, opts).facets?.workplace?.find((r) => r.value === 'unknown')?.count ?? 0;
    check('exclude: the facet counts drop with it', [workplace({}), workplace({ exclude: new Set([ID]) })], [2, 1]);
  }

  // ------------------------------------------------------- applied jobs --
  // The second set, built from the jobs an account has marked applied. It
  // leaves the results by the same door and is counted through a different one,
  // because the page tells you which of the two answers held a job back and
  // sends you to the screen that has the way out of it.
  {
    const applied = search(db, {}, { facets: false, excludeApplied: new Set([ID]) });
    check('applied: the job is not in the results', applied.results.map((r) => r.id), [jobId('ashby', 'acme', 'j2')]);
    check('applied: nor in the total', applied.total, 1);
    check('applied: it is counted under its own name', [applied.funnel.applied, applied.funnel.hidden], [1, 0]);
    check('applied: no set at all changes nothing', search(db, {}, { facets: false }).funnel.applied, 0);

    // A job can be both. Counted once, and under `hidden`: two counts for one
    // missing row would add up to more jobs than the search held back.
    const both = search(db, {}, { facets: false, exclude: new Set([ID]), excludeApplied: new Set([ID]) });
    check('applied: a job in both sets is counted once', [both.total, both.funnel.hidden, both.funnel.applied], [1, 1, 0]);

    // The two sets are subtracted independently, so between them they can empty
    // a search — the state someone who has worked through a filter set is in.
    const neither = search(db, {}, {
      facets: false,
      exclude: new Set([ID]),
      excludeApplied: new Set([jobId('ashby', 'acme', 'j2')]),
    });
    check('applied: both sets subtract', [neither.total, neither.funnel.hidden, neither.funnel.applied], [0, 1, 1]);

    // Same rule as the hidden set: out of the facets too, or a control would
    // promise a job the list cannot show.
    const workplace = (opts) =>
      search(db, {}, opts).facets?.workplace?.find((r) => r.value === 'unknown')?.count ?? 0;
    check('applied: the facet counts drop with it', workplace({ excludeApplied: new Set([ID]) }), 1);
  }

  // --------------------------------------------------- yielding the loop --
  // The deployed server is one thread, and a pass over the whole corpus holds
  // it for a second or more — so a ★ pressed while anyone's search is running
  // waited for that search to finish. `searchYielding` is the same search
  // handing the event loop back between strides. The stride is set to one job
  // because two jobs is the whole corpus here; the immediate is queued before
  // the search starts, so a search that never yields answers before it runs.
  {
    let turned = false;
    setImmediate(() => {
      turned = true;
    });
    const yielded = await searchYielding(db, {}, { facets: false, yieldEvery: 1 });
    check('yielding: the event loop turns while a search runs', turned, true);
    const plain = search(db, {}, { facets: false });
    const seen = (r) => ({ ids: r.results.map((x) => x.id), total: r.total, funnel: r.funnel });
    check('yielding: the answer is the plain search\'s answer', seen(yielded), seen(plain));
  }

  // ---------------------------------------------------------- disappearance --
  {
    const r = upsertBoard(db, board([job()]), day(11));
    check('closed: a job the board no longer lists is closed, not deleted', [r.closed, stored(jobId('ashby', 'acme', 'j2'))], [1, 'Build things with SQL and Python.']);
    check('closed: the event log says disappeared', events(jobId('ashby', 'acme', 'j2')).at(-1), 'disappeared');
    upsertBoard(db, board([job(), job({ native_id: 'j2' })]), day(12));
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
