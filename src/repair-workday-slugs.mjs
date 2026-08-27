#!/usr/bin/env node
/**
 * Recover the tenant for Workday slugs that arrived without one.
 *
 *   node src/repair-workday-slugs.mjs                    # every unrepaired slug
 *   node src/repair-workday-slugs.mjs --sample=200        # measure the hit rate first
 *   node src/repair-workday-slugs.mjs --concurrency=6
 *   node src/repair-workday-slugs.mjs --retry-failed      # ignore recorded misses
 *
 * Writes `data/backfill/workday-recovered.txt`, which `sources.json` reads back
 * as a local `file` source — the same shape the Ashby backfill already uses, so
 * a recovered slug survives the next `npm run sync` instead of being flattened
 * by it.
 *
 * ## The damage
 *
 * A Workday board is addressed by three things — tenant, datacenter, site — and
 * the one upstream that publishes Workday at all
 * (`Feashliaa/job-board-aggregator`) pipe-joins them. On 6,055 of its 12,884
 * rows, 47%, the join is wrong in a specific and recoverable way:
 *
 *     accenture|wd102|accenturecareers     <- what it should say
 *     wd102|wd1|accenturecareers           <- what it says
 *
 * The datacenter has been shifted left into the tenant field, the middle field
 * has been filled with the default `wd1`, and the tenant has been dropped
 * entirely. Verified against the raw upstream file on 2026-08-26: our own
 * parser is not at fault, the published data is already like this.
 *
 * So the datacenter is not lost — it is the first field — and the site is
 * intact. Only the tenant has to be guessed, and the site name is the only
 * evidence there is about it.
 *
 * ## What this actually found, which is not what it was written to find
 *
 * It works: two passes recovered 1,402 tenants, 46.1% of the guessable rows,
 * by guessing the tenant from the site name and confirming each against the
 * live API.
 *
 * And it recovered **five boards**. Every one of the other 1,397 was already in
 * the slug store, in correct form, from the same upstream file.
 *
 * Checking that properly: of the 6,055 damaged rows, **6,055 — 100% — have a
 * well-formed row with the same datacenter and site already in the store.** The
 * upstream publishes every Workday board twice, once correctly and once with
 * the fields shifted. The damaged half contains no boards that the intact half
 * does not.
 *
 * That is worth knowing for two reasons. It means `parseSlug` rejecting the
 * damaged rows outright is not a lossy shortcut but the whole correct answer —
 * nothing is behind them. And it means the Workday universe is 6,834 boards
 * rather than the 12,884 the raw count suggests, which is the number any
 * estimate of the corpus has to be built on.
 *
 * So this script is kept for what it is now: the evidence for that claim,
 * re-runnable the day the upstream changes shape, and worth five boards. It is
 * not on the critical path and `npm run refresh` does not call it.
 *
 * ## Where the guessing stops
 *
 * Most Workday customers name the site after themselves: `aareon` on tenant
 * `aareon`, `adventisthealthcarecareers` on `adventisthealthcare`. That is what
 * `tenantGuesses` encodes, in descending order of how often it was right —
 * measured across both passes: guess #1 (the site as-is) 513, #2 (minus a
 * `careers` affix) 800, #3 73, #4 4.
 *
 * It stops dead at the sites named after nothing. `external`, `careers`,
 * `external_careers` and their kin are used by hundreds of unrelated tenants
 * and contain no evidence whatsoever about who owns them — no amount of
 * cleverness recovers those, and this pass is not the place to pretend
 * otherwise.
 *
 * Every attempt is recorded in `slug_attempts` with its strategy and rank, so a
 * re-run costs nothing for a slug already resolved, and so the hit rate of each
 * guess is measurable rather than assumed.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getJson, pool } from './lib/http.mjs';
import { openDb, recordAttempt, transact } from './lib/db.mjs';
import { ticker, logEvent } from './lib/progress.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STORE_PATH = join(ROOT, 'data', 'slugs', 'workday.json');
const OUT_PATH = join(ROOT, 'data', 'backfill', 'workday-recovered.txt');

const options = parseArgs(process.argv.slice(2));

/** A row this script can work on: `wdNNN|wdN|site`, datacenter in field one. */
const DAMAGED = /^wd\d+$/i;

/**
 * Tenant candidates for a site name, best first.
 *
 * Ordered by observed hit rate, and capped: every candidate past the first is a
 * request spent on a board that probably does not exist, multiplied by six
 * thousand slugs.
 */
export function tenantGuesses(site) {
  const guesses = [];
  const add = (value) => {
    const clean = String(value ?? '').trim().toLowerCase();
    if (clean.length > 1 && !guesses.includes(clean)) guesses.push(clean);
  };

  add(site);
  // "adventisthealthcarecareers" -> "adventisthealthcare"; also the underscored
  // and hyphenated spellings, and the `external` prefix Workday sites often use.
  add(site.replace(/[-_]?(external[-_]?)?careers?$/i, ''));
  add(site.replace(/^external[-_]?/i, ''));
  add(site.replace(/^external[-_]?/i, '').replace(/[-_]?careers?$/i, ''));
  // "piramal_external_careers" -> "piramal"
  add(site.split(/[-_]/)[0]);
  // "canadian_solar" -> "canadiansolar"
  add(site.replace(/[-_]/g, ''));

  return guesses.slice(0, 5);
}

/**
 * Sites that name no company.
 *
 * Skipped without spending a request: they are shared by hundreds of unrelated
 * tenants, so every guess derived from them is a guess about a word rather than
 * about a company. Counted and reported rather than silently dropped.
 */
const ANONYMOUS = new Set([
  'external', 'externalcareers', 'external_careers', 'external-careers',
  'careers', 'career', 'jobs', 'job', 'externalsite', 'external_site',
  'externaljobs', 'external_jobs', 'campus', 'internal', 'corporate',
  'externalcareersite', 'external_career_site', 'externalcareer',
]);

const store = JSON.parse(await readFile(STORE_PATH, 'utf8'));
const damaged = Object.keys(store.slugs ?? {})
  .map((slug) => slug.split('|'))
  .filter((parts) => parts.length === 3 && DAMAGED.test(parts[0]))
  .map(([dc, , site]) => ({ dc: dc.toLowerCase(), site: site.toLowerCase() }));

if (!damaged.length) {
  console.log('No damaged Workday slugs in the store — nothing to repair.');
  process.exit(0);
}

const db = openDb(options.db);

/**
 * Damaged slugs already resolved, keyed by the damaged form.
 *
 * Every outcome is recorded against the *damaged* string, not the repaired one,
 * which is the only key a re-run can look itself up by — a recovered slug is
 * additionally recorded under its repaired form so the sweep's own attempt log
 * knows the board is live.
 *
 * An errored slug is deliberately recorded as nothing at all, so a transient
 * DNS failure or timeout is retried next run rather than being frozen into a
 * verdict. That is the same rule `probe-boards.mjs` follows for the same
 * reason: the network failing us is not evidence about a board.
 */
const settled = new Set(
  db
    .prepare(
      options.retryFailed
        ? "SELECT slug FROM slug_attempts WHERE ats = 'workday' AND verdict = 'live'"
        : "SELECT slug FROM slug_attempts WHERE ats = 'workday'",
    )
    .all()
    .map((r) => r.slug),
);

let targets = damaged.filter(({ dc, site }) => !settled.has(`${dc}|wd1|${site}`));
const anonymous = targets.filter(({ site }) => ANONYMOUS.has(site));
targets = targets.filter(({ site }) => !ANONYMOUS.has(site));
// Counted before sampling, or a `--sample` run reports the slugs it chose not
// to look at this time as though they were already resolved.
const guessable = targets.length;
if (options.sample && options.sample < targets.length) {
  const step = targets.length / options.sample;
  targets = Array.from({ length: options.sample }, (_, i) => targets[Math.floor(i * step)]);
}

console.log(
  `${damaged.length.toLocaleString()} damaged Workday slug(s): ` +
    `${guessable.toLocaleString()} guessable, ` +
    `${anonymous.length.toLocaleString()} skipped as unguessable, ` +
    `${(damaged.length - guessable - anonymous.length).toLocaleString()} already settled` +
    (targets.length === guessable ? '' : ` — trying ${targets.length.toLocaleString()} this run`) +
    '.\n',
);
logEvent(`repair workday: ${targets.length.toLocaleString()} slugs, concurrency ${options.concurrency}`);

const recovered = new Map(); // repaired slug -> { site, tenant, rank, total }
const counts = { recovered: 0, exhausted: 0, error: 0, requests: 0 };
const attempts = [];

const bar = ticker('repair:workday', 'Recovering Workday tenants', targets.length);

await pool(targets, options.concurrency, async ({ dc, site }) => {
  const guesses = tenantGuesses(site);
  let outcome = 'exhausted';
  let sawError = false;

  for (let rank = 0; rank < guesses.length; rank++) {
    const tenant = guesses[rank];
    counts.requests++;
    const res = await getJson(
      `https://${tenant}.${dc}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: '' }),
        timeoutMs: 25_000,
        // One retry, not the default three. A wrong guess is wrong reliably and
        // answers 422 immediately, which `request` never retries anyway — so
        // this budget is spent only on the failures that are worth re-asking.
        // It is not zero because thousands of distinct hostnames in quick
        // succession produce a steady trickle of DNS and connection failures,
        // and at zero every one of those became a slug this pass gave up on: a
        // first run at `retries: 0` errored on 24% of what it tried.
        retries: 1,
      },
    );

    if (res.ok) {
      const slug = `${tenant}|${dc}|${site}`;
      recovered.set(slug, { tenant, dc, site, rank: rank + 1, total: res.data?.total ?? 0 });
      attempts.push({ slug, status: 200, verdict: 'live', strategy: 'tenant-from-site', seed: site, rank: rank + 1 });
      // Also against the damaged form, so a re-run recognises this one as done.
      attempts.push({
        slug: `${dc}|wd1|${site}`, status: 200, verdict: 'live',
        strategy: 'tenant-from-site', seed: tenant, rank: rank + 1,
      });
      outcome = 'recovered';
      break;
    }
    // 422/404 is "no such board", which is the answer for this guess. Anything
    // else is the host talking about us, and must not be recorded as a miss.
    if (res.status !== 422 && res.status !== 404) sawError = true;
  }

  if (outcome === 'recovered') counts.recovered++;
  else if (sawError) {
    counts.error++;
  } else {
    counts.exhausted++;
    // Remembered against the damaged form, so a re-run skips it.
    attempts.push({
      slug: `${dc}|wd1|${site}`, status: 422, verdict: 'dead',
      strategy: 'tenant-from-site', seed: site, rank: guesses.length,
    });
  }

  bar.tick(1, {
    note: `${counts.recovered} recovered · ${counts.exhausted} exhausted · ${counts.error} err`,
    extra: { ...counts },
  });
});

transact(db, () => {
  for (const attempt of attempts) recordAttempt(db, { ats: 'workday', ...attempt });
});

// Merge with anything a previous run recovered, so a sampled run adds to the
// file rather than truncating it to its own sample.
const previous = existsSync(OUT_PATH)
  ? (await readFile(OUT_PATH, 'utf8')).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  : [];
const merged = [...new Set([...previous, ...recovered.keys()])].sort();

await mkdir(dirname(OUT_PATH), { recursive: true });
await writeFile(
  OUT_PATH,
  `# Workday tenants recovered by src/repair-workday-slugs.mjs.\n` +
    `# The upstream list ships these with the datacenter in the tenant field and\n` +
    `# the tenant missing; each line below was confirmed against the live API.\n` +
    `# Regenerate rather than edit. Last run: ${new Date().toISOString()}\n` +
    `${merged.join('\n')}\n`,
);

const tried = counts.recovered + counts.exhausted;
const jobs = [...recovered.values()].reduce((sum, r) => sum + r.total, 0);

bar.done(`${counts.recovered.toLocaleString()} recovered from ${targets.length.toLocaleString()} tried`);
logEvent(
  `repair workday done: ${counts.recovered.toLocaleString()} recovered ` +
    `(${tried ? ((100 * counts.recovered) / tried).toFixed(1) : '0'}%) · ` +
    `${jobs.toLocaleString()} jobs on them · ${counts.requests.toLocaleString()} requests`,
);

console.log('');
console.log(`  recovered  ${counts.recovered.toLocaleString()}`);
console.log(`  exhausted  ${counts.exhausted.toLocaleString()}`);
console.log(`  errors     ${counts.error.toLocaleString()}`);
console.log(`  requests   ${counts.requests.toLocaleString()}`);
if (tried) console.log(`\n  ${((100 * counts.recovered) / tried).toFixed(1)}% of guessable slugs recovered`);
if (recovered.size) {
  console.log(`  ${jobs.toLocaleString()} open jobs on the boards recovered this run`);
  // Which guess earned its place, so the ordering above can be revisited with
  // evidence rather than intuition.
  const byRank = new Map();
  for (const r of recovered.values()) byRank.set(r.rank, (byRank.get(r.rank) ?? 0) + 1);
  console.log(
    `  by guess: ${[...byRank].sort((a, b) => a[0] - b[0]).map(([rank, n]) => `#${rank} ${n}`).join(' · ')}`,
  );
}
console.log(`\n  ${merged.length.toLocaleString()} total recovered slug(s) → ${OUT_PATH}\n`);

db.close();

function parseArgs(argv) {
  const parsed = { concurrency: 6, sample: null, retryFailed: false, db: undefined };
  for (const arg of argv) {
    if (arg.startsWith('--concurrency=')) parsed.concurrency = Math.max(1, Number(arg.slice(14)));
    else if (arg.startsWith('--sample=')) parsed.sample = Math.max(1, Number(arg.slice(9)));
    else if (arg.startsWith('--db=')) parsed.db = arg.slice(5);
    else if (arg === '--retry-failed') parsed.retryFailed = true;
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return parsed;
}
