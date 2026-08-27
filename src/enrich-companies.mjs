#!/usr/bin/env node
/**
 * Read what each company does off its own postings, and store it.
 *
 *   node src/enrich-companies.mjs                  # every hiring company not yet read
 *   node src/enrich-companies.mjs --all            # re-read every hiring company
 *   node src/enrich-companies.mjs --limit=50       # smoke run, biggest boards first
 *   node src/enrich-companies.mjs --dry-run        # print dossiers and the bill; spend nothing
 *   node src/enrich-companies.mjs --concurrency=4 --model=claude-sonnet-5
 *   node src/enrich-companies.mjs --max-cost=25    # stop once the list-price estimate passes $25
 *
 * The one stage in the pipeline that spends money, and the only one that talks
 * to something other than an ATS. Everything about it is sized for that:
 *
 *  - **One call per company, never per job.** 17,000 hiring companies is a
 *    one-off of tens of dollars on the default model; the daily `--only-new`
 *    run after that is the handful of boards the sweep found overnight.
 *  - **Biggest boards first.** Ordered by open roles, so a run cut short has
 *    read the companies behind the most jobs, and a `--limit` smoke run shows
 *    the ones you would recognise.
 *  - **Nothing is re-spent by accident.** A company is read once and its
 *    `sector_at` is set whether or not the model committed to a bucket; the
 *    default run skips anything with a timestamp. `--all` is the explicit way
 *    to pay again, after a prompt change or a vocabulary change.
 *  - **The bill is printed, and can be capped.** Token counts and the
 *    list-price estimate, at the end and in `data/enrich-report.md`, so "what
 *    did that cost" is a line in a file and not a trip to the console.
 *    `--max-cost` stops the run once the running estimate passes a figure;
 *    with biggest-first ordering, a capped run has read the companies behind
 *    the most jobs, and the next run picks up exactly where it stopped.
 *  - **No key is not an error.** The daily run calls this after derive; on a
 *    machine with no `ANTHROPIC_API_KEY` it says so and exits clean, and the
 *    corpus is exactly what it was — every company unknown, which the filter
 *    already handles.
 *
 * Writes `companies.sector`, `blurb`, `sector_src`, `sector_at` through
 * `recordSector`, and `meta.last_enrich` at the end, which is what tells a
 * running server's in-memory index to pick the new column up.
 */

import './lib/env.mjs';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, recordSector, setMeta } from './lib/db.mjs';
import { ticker, logEvent, setStat } from './lib/progress.mjs';
import { SECTORS } from './lib/schema.mjs';
import { aiConfig, aiMeta } from './lib/interpret.mjs';
import { classifyCompany, dossier, enrichModel, estimateCost } from './lib/enrich.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = join(ROOT, 'data', 'enrich-report.md');

function parseArgs(argv) {
  const args = { all: false, limit: 0, concurrency: 4, dryRun: false, model: null, db: undefined, report: true, maxCost: 0 };
  for (const arg of argv.slice(2)) {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
    if (key === 'all') args.all = true;
    else if (key === 'only-new') args.all = false; // the default, named so the daily run can say it
    else if (key === 'limit') args.limit = Number(value);
    else if (key === 'concurrency') args.concurrency = Math.max(1, Number(value) || 1);
    else if (key === 'dry-run') args.dryRun = true;
    else if (key === 'model') args.model = value;
    else if (key === 'max-cost') args.maxCost = Number(value) || 0;
    else if (key === 'no-report') args.report = false;
    else if (key === 'db') args.db = value;
    else {
      console.error(`Unknown flag --${key}`);
      process.exit(2);
    }
  }
  return args;
}

const fmt = (n) => Number(n ?? 0).toLocaleString('en-US');
const money = (n) => (n == null ? '—' : `$${n.toFixed(2)}`);

/**
 * Open roles per company, counted once.
 *
 * Not a correlated `(SELECT COUNT(*) …)` per company: for that shape the
 * planner picks `idx_jobs_open` over `idx_jobs_company` and walks every open
 * row in the corpus once per company — 21,000 × 967,000 rows, which is a
 * dry run that never comes back. One `GROUP BY` is the same shape `getIndex`
 * already uses, and it is seconds.
 */
function openRolesByCompany(db) {
  const out = new Map();
  for (const r of db.prepare('SELECT company_id, COUNT(*) AS n FROM jobs WHERE is_open = 1 GROUP BY company_id').iterate()) {
    out.set(r.company_id, r.n);
  }
  return out;
}

/**
 * The companies to read: live boards with at least one open job, unread ones
 * only unless `--all`. Biggest first — see the header.
 */
function selectCompanies(db, { all, limit }) {
  const openRoles = openRolesByCompany(db);
  const rows = db
    .prepare(
      `SELECT id, name, slug, website, board_url, sector_at FROM companies
        WHERE status = 'live' ${all ? '' : 'AND sector_at IS NULL'}`,
    )
    .all()
    .map((c) => ({ ...c, open_roles: openRoles.get(c.id) ?? 0 }))
    .filter((c) => c.open_roles > 0)
    .sort((a, b) => b.open_roles - a.open_roles || (a.id < b.id ? -1 : 1));
  return limit ? rows.slice(0, limit) : rows;
}

/** What the model gets to read about one company. Two cheap indexed reads. */
function gather(db, company) {
  // `INDEXED BY` on both: with an ORDER BY on posted_at the planner reaches
  // for `idx_jobs_posted` and walks the corpus newest-first until it has found
  // 60 rows for this company — the whole table, for a company with three.
  const titles = db
    .prepare('SELECT title FROM jobs INDEXED BY idx_jobs_company WHERE company_id = ? AND is_open = 1 ORDER BY posted_at DESC LIMIT 60')
    .all(company.id)
    .map((r) => r.title);
  const descriptions = db
    .prepare(
      `SELECT c.description_text AS text
         FROM jobs j INDEXED BY idx_jobs_company JOIN job_content c ON c.job_id = j.id
        WHERE j.company_id = ? AND j.is_open = 1 AND LENGTH(c.description_text) > 200
        ORDER BY j.posted_at DESC LIMIT 6`,
    )
    .all(company.id)
    .map((r) => r.text);
  return dossier(company, titles, descriptions);
}

/** Run `fn` over `items` with at most `n` in flight. Order of completion is not kept. */
async function pool(items, n, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

async function main() {
  const args = parseArgs(process.argv);
  const config = aiConfig();
  const model = args.model ?? enrichModel();

  if (!config.enabled && !args.dryRun) {
    // Clean exit on purpose. This runs at the end of every daily pipeline, and
    // a laptop with no key is a laptop whose companies stay unknown — a state
    // the filter handles — not a failed stage.
    console.log(`Company sectors: off — ${aiMeta().setup}`);
    return;
  }

  const db = openDb(args.db);
  const companies = selectCompanies(db, args);
  if (!companies.length) {
    console.log(args.all ? 'No hiring companies to read.' : 'Every hiring company has been read. --all re-reads them.');
    db.close();
    return;
  }
  const jobsCovered = companies.reduce((n, c) => n + c.open_roles, 0);
  console.log(
    `Reading ${fmt(companies.length)} compan${companies.length === 1 ? 'y' : 'ies'} (${fmt(jobsCovered)} open jobs) with ${model}` +
      `${args.all ? ', re-reading the ones already read' : ''}…`,
  );

  // Roughly 1,500 input tokens a company plus the cached prompt, and ~60 out.
  // Printed before spending anything, so a bigger model is a choice made with
  // the number in front of you.
  // Measured on the first 40: ~3,100 input tokens a company (the dossier plus
  // a prompt too short for the model's cache minimum) and ~85 out.
  const guess = estimateCost(model, { input: companies.length * 3100, output: companies.length * 85 });
  console.log(`  estimated list price: ${guess == null ? 'unknown for this model' : `about ${money(guess)}`}`);
  if (args.maxCost && guess == null) {
    console.error(`  ! --max-cost needs a model with a known price; ${model} is not one. Add it to PRICES in lib/enrich.mjs.`);
    process.exit(2);
  }
  if (args.maxCost) console.log(`  stopping once the estimate passes ${money(args.maxCost)}`);

  if (args.dryRun) {
    for (const company of companies.slice(0, 3)) {
      console.log(`\n────── ${company.name ?? company.slug} · ${fmt(company.open_roles)} open ──────`);
      console.log(gather(db, company));
    }
    if (companies.length > 3) console.log(`\n…and ${fmt(companies.length - 3)} more. Nothing was sent.`);
    db.close();
    return;
  }

  const started = Date.now();
  const tick = ticker('enrich', 'Company sectors', companies.length);
  logEvent(`enrich: ${fmt(companies.length)} companies with ${model}`);

  const stats = { read: 0, sure: 0, unsure: 0, failed: 0, sectors: {}, usage: { input: 0, output: 0, cached: 0, cache_written: 0 } };
  const errors = [];
  let abort = null;
  let consecutiveFailures = 0;

  await pool(companies, args.concurrency, async (company) => {
    if (abort) return;
    const text = gather(db, company);
    let result;
    try {
      result = await classifyCompany(text, { model, config });
      consecutiveFailures = 0;
    } catch (err) {
      stats.failed++;
      if (errors.length < 20) errors.push(`${company.id}: ${err.message}`);
      // A key that is rejected fails every call; twenty in a row is the same
      // thing wearing a different message. Either way the run stops rather
      // than logging seventeen thousand identical lines.
      if (err.fatal || ++consecutiveFailures >= 20) abort = err.message;
      tick.tick(1);
      return;
    }
    for (const k of Object.keys(stats.usage)) stats.usage[k] += result.usage[k] ?? 0;
    // The cap is on the running estimate, checked after each answer lands, so
    // it overshoots by at most one call per worker. A model with no price on
    // the list cannot be capped, and says so up front rather than here.
    if (args.maxCost && (estimateCost(model, stats.usage) ?? 0) >= args.maxCost) {
      abort = `reached --max-cost=${args.maxCost} (estimated ${money(estimateCost(model, stats.usage))}); the next run continues from here`;
    }

    const verdict = result.verdict;
    recordSector(db, company.id, {
      sector: verdict?.sector ?? null,
      blurb: verdict?.blurb ?? null,
      src: `${model}${verdict ? `:${verdict.confidence}` : `:${result.note}`}`,
      at: Date.now(),
    });
    stats.read++;
    if (verdict?.sector) {
      stats.sure++;
      stats.sectors[verdict.sector] = (stats.sectors[verdict.sector] ?? 0) + 1;
    } else {
      stats.unsure++;
    }
    tick.tick(1);
  });

  // Whether or not it finished, what was written is real and the index should
  // see it. The stamp is what the filter's generation key watches.
  if (stats.read) setMeta(db, 'last_enrich', String(Date.now()));

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const cost = estimateCost(model, stats.usage);
  tick.done(`${fmt(stats.read)} read · ${elapsed}s`);

  const report = buildReport({ args, model, companies, stats, errors, abort, cost, elapsed, db });
  if (args.report) {
    writeFileSync(REPORT, report.markdown);
    console.log(report.console);
    console.log(`\nFull report → data/enrich-report.md`);
  } else {
    console.log(report.console);
  }

  setStat('sectors', db.prepare('SELECT COUNT(*) n FROM companies WHERE sector IS NOT NULL').get().n, 'companies with a sector');
  logEvent(
    `enrich done: ${fmt(stats.read)} read · ${fmt(stats.sure)} placed · ${fmt(stats.unsure)} unsure · ${fmt(stats.failed)} failed · ${money(cost)} · ${elapsed}s`,
    abort ? 'warn' : 'ok',
  );
  db.close();
  if (abort) {
    // A cap that was reached is the run doing what it was told; a failure is
    // not. Only the second is an error to the daily run.
    const capped = abort.startsWith('reached --max-cost');
    console[capped ? 'log' : 'error'](`\n  ${capped ? '·' : '!'} stopped early: ${abort}`);
    if (!capped) process.exit(1);
  }
}

function buildReport({ args, model, companies, stats, errors, abort, cost, elapsed, db }) {
  const label = new Map(SECTORS.map((s) => [s.value, s.label]));
  const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : '—');

  const lines = [];
  lines.push('# Company sector report', '');
  lines.push(`Run: ${new Date().toISOString()} · ${fmt(stats.read)} of ${fmt(companies.length)} companies read in ${elapsed}s · model ${model}${args.all ? ' · --all' : ''}`);
  if (abort) lines.push('', `**Stopped early:** ${abort}`);
  lines.push('');

  lines.push('## This run', '', '| | Companies | Share |', '| --- | --- | --- |');
  lines.push(`| placed in a sector | ${fmt(stats.sure)} | ${pct(stats.sure, stats.read)} |`);
  lines.push(`| read, but unsure | ${fmt(stats.unsure)} | ${pct(stats.unsure, stats.read)} |`);
  lines.push(`| failed | ${fmt(stats.failed)} | ${pct(stats.failed, companies.length)} |`);
  lines.push('');

  lines.push('## The bill', '');
  lines.push(`| Tokens | |`, `| --- | --- |`);
  lines.push(`| input (uncached) | ${fmt(stats.usage.input)} |`);
  lines.push(`| input, read from cache | ${fmt(stats.usage.cached)} |`);
  lines.push(`| input, written to cache | ${fmt(stats.usage.cache_written)} |`);
  lines.push(`| output | ${fmt(stats.usage.output)} |`);
  lines.push(`| **estimated list price** | **${money(cost)}** — an estimate from published rates; the invoice is the answer |`);
  lines.push('');

  lines.push('## Sectors, whole corpus', '');
  lines.push('Every hiring company, including ones read on earlier runs.', '');
  lines.push('| Sector | Companies | Open jobs |', '| --- | --- | --- |');
  const rows = db
    .prepare(
      `SELECT co.sector, COUNT(*) AS companies, SUM(COALESCE(o.n, 0)) AS jobs
         FROM companies co
         LEFT JOIN (SELECT company_id, COUNT(*) AS n FROM jobs WHERE is_open = 1 GROUP BY company_id) o
           ON o.company_id = co.id
        WHERE co.status = 'live'
        GROUP BY co.sector ORDER BY jobs DESC`,
    )
    .all();
  for (const row of rows) {
    lines.push(`| ${row.sector ? label.get(row.sector) ?? row.sector : '_unknown_'} | ${fmt(row.companies)} | ${fmt(row.jobs)} |`);
  }
  lines.push('');

  if (errors.length) {
    lines.push('## Failures', '', ...errors.map((e) => `- ${e}`), '');
    if (stats.failed > errors.length) lines.push(`_…and ${fmt(stats.failed - errors.length)} more._`, '');
  }

  const top = Object.entries(stats.sectors).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const consoleLines = [
    '',
    `  read                ${fmt(stats.read).padStart(7)}   ${fmt(stats.sure)} placed · ${fmt(stats.unsure)} unsure · ${fmt(stats.failed)} failed`,
    `  tokens              ${fmt(stats.usage.input).padStart(7)} in · ${fmt(stats.usage.cached)} cached · ${fmt(stats.usage.output)} out`,
    `  estimated cost      ${money(cost).padStart(7)}   list price, ${model}`,
    ...(top.length ? [`  most common         ${top.map(([k, n]) => `${label.get(k) ?? k} ${fmt(n)}`).join(' · ')}`] : []),
  ].join('\n');

  return { markdown: lines.join('\n'), console: consoleLines };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
