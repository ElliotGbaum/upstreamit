#!/usr/bin/env node
/**
 * Sweep every live board for one ATS and store the jobs.
 *
 *   node src/sweep.mjs --ats=ashby
 *   node src/sweep.mjs --ats=ashby --limit=200        # quick smoke run
 *   node src/sweep.mjs --ats=greenhouse --concurrency=8
 *   node src/sweep.mjs --ats=greenhouse --no-conditional   # ignore stored ETags
 *   node src/sweep.mjs --ats=workday --detail-concurrency=8
 *
 * Reads its slug list from `data/slugs/<ats>-live.txt` when that exists,
 * otherwise from `data/slugs/<ats>.txt`, otherwise from whatever the database
 * already knows is live.
 *
 * ## Conditional GET
 *
 * Ashby and Greenhouse honour `If-None-Match`, and `companies.last_etag` was
 * being written on every sweep and never read back. At Ashby's 4,300 boards
 * that was a missed optimization; at Greenhouse's ~7,700 boards and 12.7 KB per
 * job it is the difference between a ~1.2 GB daily re-sweep and one that
 * transfers almost nothing. An unchanged board answers 304 with a zero-byte
 * body, and `touchBoard` records the sweep without touching a job row.
 *
 * Lever does not honour it — it sends an ETag and then answers a matching
 * `If-None-Match` with 200 and the full body. Nothing here needs a special case
 * for that (a 200 is just a sweep that found jobs), but a Lever run reports
 * 0 unchanged boards every night and moves its full 931 MB, and that is the
 * host's behaviour rather than a bug in the conditional-GET path.
 *
 * The caveat worth knowing: a 304 says the *response body* is unchanged, so a
 * board with a broken ETag would look like a company that stopped hiring. Run
 * `--no-conditional` weekly and diff the counts before trusting it.
 *
 * ## Boards that cost one request per job
 *
 * Workday sends no ETag and no description in its listing, so neither of the
 * savings above is available to it: prose costs one request per posting. An
 * adapter that declares `hydrates` is therefore handed the set of jobs on that
 * board whose descriptions this database already holds, and skips a request for
 * each one — see `describedStmt` below and the header of
 * `lib/adapters/workday.mjs`. `--no-conditional` turns that off too, which is
 * the same weekly full re-read the paragraph above prescribes.
 *
 * The one job a stored description does *not* excuse is one still carrying
 * Workday's "3 Locations" placeholder. Only the detail request names those
 * cities, so such a job is left out of the set and re-read once; after that it
 * has a real location and costs nothing again.
 *
 * Writes go through `upsertBoard` in batched transactions — one transaction per
 * board would fsync thousands of times; one for the whole sweep would hold a
 * write lock for minutes and lose everything on a crash.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pool } from './lib/http.mjs';
import { openDb, upsertBoard, markBoard, touchBoard, transact, setMeta } from './lib/db.mjs';
import { companyId } from './lib/schema.mjs';
import { ticker, logEvent, setStat } from './lib/progress.mjs';
import { loadAdapter } from './lib/adapters/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { ats: 'ashby', limit: 0, concurrency: 0, batch: 40, only: null, conditional: true };
  for (const arg of argv.slice(2)) {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
    if (key === 'ats') args.ats = value;
    else if (key === 'limit') args.limit = Number(value);
    else if (key === 'concurrency') args.concurrency = Number(value);
    // Detail requests in flight within one board, for an ATS that keeps its
    // descriptions one request per job. Ignored by every other adapter.
    else if (key === 'detail-concurrency') args.detailConcurrency = Number(value);
    else if (key === 'batch') args.batch = Number(value);
    else if (key === 'only') args.only = value.split(',').map((s) => s.trim()).filter(Boolean);
    else if (key === 'no-conditional') args.conditional = false;
    else if (key === 'db') args.db = value;
  }
  return args;
}

/**
 * Board facts resolved out-of-band (`probe-boards.mjs --with-names`,
 * `repair-ashby-links.mjs`), keyed by slug.
 *
 * Two gaps this fills, neither of which the postings APIs can:
 *
 *  - Display names. Greenhouse puts `company_name` on every posting; Lever and
 *    Ashby publish it nowhere in theirs, so it comes from a separate GraphQL
 *    pass whose output lands in `<ats>-verified.json`. Without this, companies
 *    render as their slug: "bofcorp" instead of "B-O-F Corporation".
 *
 *  - Working links. An Ashby org can switch its hosted jobs.ashbyhq.com page
 *    off and serve the board through its own site; the posting API keeps
 *    handing out jobs.ashbyhq.com jobUrls anyway, and every one of them renders
 *    "Page not found". A record with `hosted_disabled` and a `careers_url`
 *    tells the sweep to point each job at the careers-page deep link instead.
 *
 * The adapter still wins when it returns a name — this only fills gaps, never
 * overwrites a name that came with the jobs.
 */
export function loadResolvedBoards(ats) {
  const path = join(ROOT, 'data', 'slugs', `${ats}-verified.json`);
  if (!existsSync(path)) return new Map();
  try {
    const companies = JSON.parse(readFileSync(path, 'utf8'))?.companies ?? {};
    const boards = new Map();
    for (const [slug, record] of Object.entries(companies)) {
      const name = typeof record?.name === 'string' ? record.name.trim() : '';
      const careers = typeof record?.careers_url === 'string' ? record.careers_url.trim() : '';
      if (!name && !careers) continue;
      boards.set(slug, {
        name: name || null,
        careers_url: careers || null,
        hosted_disabled: record?.hosted_disabled ? 1 : 0,
      });
    }
    return boards;
  } catch {
    // A malformed or half-written verified file is a missing display name, not
    // a reason to abandon a sweep that is about to fetch thousands of boards.
    return new Map();
  }
}

export function loadSlugs(ats) {
  for (const file of [`${ats}-live.txt`, `${ats}.txt`]) {
    const path = join(ROOT, 'data', 'slugs', file);
    if (!existsSync(path)) continue;
    const slugs = readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    if (slugs.length) return { slugs, file };
  }
  return { slugs: [], file: null };
}

async function main() {
  const args = parseArgs(process.argv);
  const adapter = await loadAdapter(args.ats);
  if (!adapter) {
    console.error(`No adapter for ATS "${args.ats}".`);
    process.exit(1);
  }

  const db = openDb(args.db);
  const task = `sweep:${args.ats}`;

  let slugs;
  if (args.only) {
    slugs = args.only;
  } else {
    const loaded = loadSlugs(args.ats);
    slugs = loaded.slugs;
    if (!slugs.length) {
      slugs = db
        .prepare("SELECT slug FROM companies WHERE ats = ? AND status IN ('live','empty')")
        .all(args.ats)
        .map((r) => r.slug);
    }
  }
  if (args.limit > 0) slugs = slugs.slice(0, args.limit);

  if (!slugs.length) {
    console.error(`No slugs to sweep for ${args.ats}.`);
    process.exit(1);
  }

  // One read for the whole sweep rather than a query per board. ~7,700 rows of
  // (slug, etag) is a rounding error next to the index the filter already holds
  // in memory, and it keeps SQLite off the network hot path entirely.
  const etags = new Map();
  if (args.conditional) {
    for (const row of db
      .prepare('SELECT slug, last_etag FROM companies WHERE ats = ? AND last_etag IS NOT NULL')
      .all(args.ats)) {
      etags.set(row.slug, row.last_etag);
    }
  }

  // Names and link repairs resolved out-of-band. See `loadResolvedBoards`.
  const resolved = loadResolvedBoards(args.ats);

  /**
   * Which jobs on a board already have their prose stored.
   *
   * Only for an adapter that declares `hydrates` — meaning its descriptions
   * cost one request *each* rather than arriving with the list. Workday is the
   * only one, and on a 700,000-job corpus the difference between re-reading
   * every description nightly and re-reading only the new ones is the
   * difference between a sweep that takes hours and one that takes minutes.
   *
   * Queried per board rather than once for the whole ATS on purpose: the
   * all-at-once map that `etags` uses would be ~700,000 strings held for the
   * length of the run, and this is one indexed seek issued immediately before a
   * board fetch that takes seconds.
   *
   * `--no-conditional` skips it, so the same flag that forces a full re-read
   * past the ETags forces a full re-read of the descriptions.
   */
  const describedStmt =
    adapter.hydrates && args.conditional
      ? db.prepare(
          `SELECT j.id
             FROM jobs j
             JOIN job_content c ON c.job_id = j.id
            WHERE j.company_id = ? AND c.description_text IS NOT NULL
              AND (j.location_raw IS NULL OR j.location_raw NOT GLOB '[0-9]* Location*')`,
        )
      : null;

  const concurrency = args.concurrency || adapter.concurrency || 10;
  const startedAt = Date.now();
  const sweepRow = db
    .prepare('INSERT INTO sweeps (ats, started_at) VALUES (?, ?)')
    .run(args.ats, startedAt);
  const sweepId = Number(sweepRow.lastInsertRowid);

  const bar = ticker(task, `Sweeping ${adapter.label} boards`, slugs.length);
  logEvent(`sweep ${args.ats}: ${slugs.length.toLocaleString()} boards, concurrency ${concurrency}`);

  const totals = {
    boards: 0, live: 0, empty: 0, dead: 0, errors: 0,
    jobs: 0, added: 0, changed: 0, closed: 0, bytes: 0, unchanged: 0,
  };

  // Results queue drained into SQLite in batches; the network is the bottleneck
  // and SQLite writes are synchronous, so batching keeps them off the hot path.
  let pending = [];
  const flush = () => {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    transact(db, () => {
      for (const item of batch) {
        if (item.kind === 'board') {
          const stats = upsertBoard(db, item.board, startedAt);
          totals.jobs += stats.seen;
          totals.added += stats.added;
          totals.changed += stats.changed;
          totals.closed += stats.closed;
        } else if (item.kind === 'unchanged') {
          touchBoard(db, args.ats, item.slug, startedAt);
        } else {
          markBoard(db, args.ats, item.slug, item.status, startedAt);
        }
      }
    });
  };

  await pool(slugs, concurrency, async (slug) => {
    let result;
    try {
      const described = describedStmt
        ? new Set(describedStmt.all(companyId(args.ats, slug)).map((r) => r.id))
        : null;
      result = await adapter.fetchBoard(slug, {
        etag: etags.get(slug) ?? null,
        ...(described ? { described } : {}),
        ...(args.detailConcurrency ? { detailConcurrency: args.detailConcurrency } : {}),
      });
    } catch (err) {
      result = { ok: false, error: String(err?.message ?? err) };
    }
    totals.boards++;

    if (result.notModified) {
      // Nothing came over the wire and nothing needs writing. The board is
      // still live and its jobs are still open — see `touchBoard`.
      totals.unchanged++;
      pending.push({ kind: 'unchanged', slug });
    } else if (result.ok) {
      totals.bytes += result.bytes ?? 0;
      if (result.jobs.length) totals.live++;
      else totals.empty++;
      const record = resolved.get(slug);
      // The adapter's own answer wins; the resolved map only fills a gap.
      const name = result.name ?? record?.name ?? null;
      // A board whose hosted page is switched off publishes jobUrls that all
      // render "Page not found"; when the org names its own careers page,
      // point every job there instead. Without this, each sweep would put the
      // dead links right back.
      const relink =
        record?.hosted_disabled &&
        record.careers_url &&
        typeof adapter.externalJobUrl === 'function';
      const jobs =
        relink || name
          ? result.jobs.map((job) => ({
              ...job,
              company_name: job.company_name ?? name,
              ...(relink
                ? { url: adapter.externalJobUrl(record.careers_url, job.native_id), apply_url: null }
                : {}),
            }))
          : result.jobs;
      pending.push({
        kind: 'board',
        board: {
          ats: args.ats,
          slug,
          name,
          // An adapter that had to work its name out rather than read it says
          // so, and `name_source` records the difference. Absent means the
          // usual case: the API stated it.
          nameSource: result.name ? (result.nameSource ?? 'api') : undefined,
          url: result.url,
          etag: result.etag,
          jobs,
        },
      });
    } else if (result.dead) {
      totals.dead++;
      pending.push({ kind: 'mark', slug, status: 'dead' });
    } else {
      totals.errors++;
      pending.push({ kind: 'mark', slug, status: 'error' });
    }

    if (pending.length >= args.batch) flush();
    bar.tick(1, {
      note:
        `${totals.jobs.toLocaleString()} jobs · ${totals.live} live · ${totals.dead} dead · ${totals.errors} err` +
        (totals.unchanged ? ` · ${totals.unchanged} unchanged` : ''),
      extra: { jobs: totals.jobs, live: totals.live, dead: totals.dead, errors: totals.errors, unchanged: totals.unchanged },
    });
  });

  flush();

  const endedAt = Date.now();
  db.prepare(
    `UPDATE sweeps SET ended_at = ?, boards = ?, jobs_seen = ?, jobs_new = ?, jobs_gone = ?, errors = ?, bytes = ?
     WHERE id = ?`,
  ).run(endedAt, totals.boards, totals.jobs, totals.added, totals.closed, totals.errors, totals.bytes, sweepId);
  setMeta(db, `last_sweep_${args.ats}`, endedAt);

  bar.done(
    `${totals.jobs.toLocaleString()} jobs from ${totals.live.toLocaleString()} boards in ${((endedAt - startedAt) / 1000).toFixed(0)}s`,
  );
  setStat(`jobs_${args.ats}`, totals.jobs, `${adapter.label} jobs`);
  logEvent(
    `sweep ${args.ats} done: ${totals.jobs.toLocaleString()} jobs · ${totals.added.toLocaleString()} new · ` +
      `${totals.closed.toLocaleString()} closed · ${totals.unchanged.toLocaleString()} unchanged (304) · ` +
      `${totals.dead} dead boards · ${totals.errors} errors · ${(totals.bytes / 1e6).toFixed(0)} MB`,
  );

  console.log(
    `\n${adapter.label}: ${totals.jobs.toLocaleString()} jobs · ${totals.live.toLocaleString()} live boards · ` +
      `${totals.empty} empty · ${totals.unchanged.toLocaleString()} unchanged · ${totals.dead} dead · ` +
      `${totals.errors} errors · ${(totals.bytes / 1e6).toFixed(0)} MB · ` +
      `${((endedAt - startedAt) / 1000).toFixed(0)}s`,
  );
  db.close();
}

// NB: the project path contains spaces, so a raw `file://${argv[1]}` comparison
// fails against the percent-encoded import.meta.url. Always go through pathToFileURL.
//
// The argv[1] guard matters because this module has exports (`loadSlugs`,
// `loadResolvedBoards`) that are meant to be imported: under `node -e` and in a
// worker there is no argv[1], and `pathToFileURL(undefined)` throws before any
// importer gets to use them.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
