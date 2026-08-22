#!/usr/bin/env node
/**
 * Verify one ATS's slugs against its live board API.
 *
 *   node src/probe-boards.mjs --ats=greenhouse                # every slug in the store
 *   node src/probe-boards.mjs --ats=greenhouse --sample=300   # a sample (quick estimate)
 *   node src/probe-boards.mjs --ats=ashby --only-unknown      # skip resolved slugs
 *   node src/probe-boards.mjs --ats=ashby --with-names        # display names too (slow)
 *   node src/probe-boards.mjs --ats=greenhouse --concurrency=8
 *
 * Reads  `data/slugs/<ats>.json`
 * Writes `data/slugs/<ats>-verified.json` and `data/slugs/<ats>-live.txt`,
 * which is the list `sweep.mjs` prefers over the raw one.
 *
 * ## Why this exists at all
 *
 * Aggregated slug lists always carry junk: boards that were shut down, slugs
 * that were never real, and artifacts of whatever scraper produced them. Half
 * of Greenhouse's 15,197 collected slugs are expected to be dead. Resolving
 * them first halves the sweep, and the sweep is the expensive half — a full
 * Greenhouse content sweep moves ~1.2 GB.
 *
 * ## Why HEAD
 *
 * `adapter.probeUrl(slug)` returns the cheapest endpoint that answers 200 or
 * 404 correctly, and `HEAD` against it returns that status with a zero-byte
 * body. A GET would work and would move megabytes — OpenAI's Ashby board is
 * ~12 MB, Stripe's Greenhouse board 4.4 MB — just to learn which slugs exist.
 *
 * This replaced `probe-ashby.mjs`, which hardcoded the Ashby endpoint and file
 * paths. The Ashby-only GraphQL display-name pass moved into the adapter as an
 * optional capability (`fetchOrganization`), so it no longer follows every
 * other ATS around: Greenhouse puts `company_name` on every job and needs none
 * of it.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request, pool } from './lib/http.mjs';
import { loadAdapter, ADAPTER_IDS } from './lib/adapters/index.mjs';
import { ticker, logEvent } from './lib/progress.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SLUG_DIR = join(ROOT, 'data', 'slugs');

const options = parseArgs(process.argv.slice(2));

const adapter = await loadAdapter(options.ats);
if (!adapter) {
  console.error(`No adapter for ATS "${options.ats}". Known: ${ADAPTER_IDS.join(', ')}`);
  process.exit(1);
}
if (typeof adapter.probeUrl !== 'function') {
  console.error(`Adapter "${options.ats}" has no probeUrl(slug) — nothing to probe against.`);
  process.exit(1);
}

const STORE_PATH = join(SLUG_DIR, `${options.ats}.json`);
const VERIFIED_PATH = join(SLUG_DIR, `${options.ats}-verified.json`);
const LIVE_LIST_PATH = join(SLUG_DIR, `${options.ats}-live.txt`);

const startedAt = new Date().toISOString();

const store = await readJson(STORE_PATH, null);
if (!store?.slugs) {
  console.error(`No slug store at ${STORE_PATH}. Run \`npm run sync\` first.`);
  process.exit(1);
}
const previous = await readJson(VERIFIED_PATH, { companies: {} });

let candidates = Object.entries(store.slugs)
  .filter(([, record]) => (record.sources?.length ?? 0) > 0)
  .map(([slug]) => slug);

if (options.onlyUnknown) candidates = candidates.filter((slug) => !previous.companies[slug]?.status);
if (options.sample && options.sample < candidates.length) candidates = sampleEvenly(candidates, options.sample);

if (!candidates.length) {
  console.log(`Nothing to probe for ${adapter.label}${options.onlyUnknown ? ' (all slugs already resolved)' : ''}.`);
  process.exit(0);
}

console.log(
  `Validating ${candidates.length.toLocaleString()} ${adapter.label} slug(s) at concurrency ` +
    `${options.concurrency}${options.sample ? ' (sample)' : ''}…\n`,
);
logEvent(`probe ${options.ats}: ${candidates.length.toLocaleString()} slugs, concurrency ${options.concurrency}`);

const results = new Map();
const counts = { exists: 0, dead: 0, error: 0 };
const clock = Date.now();
let completed = 0;

const bar = ticker(`probe:${options.ats}`, `Verifying ${adapter.label} slugs`, candidates.length);

await pool(candidates, options.concurrency, async (slug) => {
  const verdict = await validateSlug(slug);
  results.set(slug, verdict);
  counts[verdict.status] += 1;
  completed += 1;
  bar.tick(1, {
    note: `exists ${counts.exists} · dead ${counts.dead} · error ${counts.error}`,
    extra: { ...counts },
  });
  if (completed % 1000 === 0 || completed === candidates.length) {
    const rate = completed / ((Date.now() - clock) / 1000);
    console.log(
      `  ${String(completed).padStart(6)}/${candidates.length}  ${rate.toFixed(1)} req/s  ` +
        `exists ${counts.exists}  dead ${counts.dead}  error ${counts.error}`,
    );
  }
});

// Display names are a separate, slower pass over confirmed boards, and only for
// the adapters that can't get a name any cheaper.
const names = new Map();
if (options.withNames) {
  if (typeof adapter.fetchOrganization !== 'function') {
    console.log(`\n${adapter.label} needs no name pass — names come with the jobs. Skipping --with-names.`);
  } else {
    const targets = [...results].filter(([, r]) => r.status === 'exists').map(([slug]) => slug);
    const nameConcurrency = adapter.nameConcurrency ?? 2;
    console.log(`\nFetching display names for ${targets.length} board(s) at concurrency ${nameConcurrency}…`);
    let named = 0;
    await pool(targets, nameConcurrency, async (slug) => {
      const organization = await adapter.fetchOrganization(slug);
      if (organization) names.set(slug, organization);
      named += 1;
      if (named % 250 === 0 || named === targets.length) console.log(`  ${named}/${targets.length}`);
    });
  }
}

const companies = { ...previous.companies };
for (const [slug, result] of results) {
  const existing = companies[slug];

  // A network error means the network failed us, not that the board is gone —
  // never let it overwrite a known-good verdict. This rule is load-bearing: a
  // flaky ten minutes must not mark a thousand live boards dead and take them
  // out of every sweep after it.
  if (result.status === 'error') {
    companies[slug] = { ...(existing ?? {}), last_error: result.error, last_error_at: startedAt };
    continue;
  }

  const organization = names.get(slug);
  // Deliberately no `sources` here. <ats>.json is the sole authority on
  // provenance; copying it would freeze a snapshot from probe time, and a later
  // --only-unknown run would leave those copies stale while the real
  // attribution moved on.
  companies[slug] = {
    status: result.status,
    checked_at: startedAt,
    ...(organization ?? pickNameFields(existing)),
  };
  delete companies[slug].last_error;
  delete companies[slug].last_error_at;
}

const existing = Object.entries(companies)
  .filter(([, record]) => record.status === 'exists')
  .map(([slug]) => slug)
  .sort();

await writeFile(
  VERIFIED_PATH,
  `${JSON.stringify(
    {
      ats: options.ats,
      generated_at: startedAt,
      probed: candidates.length,
      partial: Boolean(options.sample || options.onlyUnknown),
      counts,
      companies: sortObject(companies),
    },
    null,
    2,
  )}\n`,
);
await writeFile(LIVE_LIST_PATH, existing.length ? `${existing.join('\n')}\n` : '');

const resolved = counts.exists + counts.dead;
const liveRate = resolved ? (100 * counts.exists) / resolved : 0;

bar.done(`${counts.exists.toLocaleString()} live · ${counts.dead.toLocaleString()} dead · ${counts.error} error`);
logEvent(
  `probe ${options.ats} done: ${counts.exists.toLocaleString()} live of ${resolved.toLocaleString()} resolved ` +
    `(${liveRate.toFixed(1)}%) · ${counts.error} errors`,
);

console.log('');
console.log(`  exists ${counts.exists.toLocaleString()}`);
console.log(`  dead   ${counts.dead.toLocaleString()}`);
console.log(`  error  ${counts.error.toLocaleString()}`);
if (resolved) console.log(`\n  ${liveRate.toFixed(1)}% of resolved slugs are real boards`);
console.log(`\n  ${existing.length.toLocaleString()} confirmed board(s) → ${LIVE_LIST_PATH}\n`);

/**
 * HEAD the adapter's probe endpoint. 404 is the only "does not exist" — every
 * other 4xx/5xx is the host having an opinion about us, not about the slug.
 * (Slugs may contain spaces, e.g. Ashby's "flock safety"; `probeUrl` is
 * responsible for percent-encoding.)
 */
async function validateSlug(slug) {
  let res;
  try {
    res = await request(adapter.probeUrl(slug), { method: 'HEAD', timeoutMs: 30_000 });
  } catch (err) {
    return { status: 'error', error: String(err?.message ?? err) };
  }
  // Drain so the socket can be reused — a HEAD body is empty but the stream
  // still has to be closed.
  await res.arrayBuffer().catch(() => {});
  if (res.status === 404) return { status: 'dead' };
  if (res.status >= 400) return { status: 'error', error: `HTTP ${res.status}` };
  return { status: 'exists' };
}

/** Deterministic evenly-spaced sample, so a sampled run is reproducible. */
function sampleEvenly(items, count) {
  const step = items.length / count;
  return Array.from({ length: count }, (_, i) => items[Math.floor(i * step)]);
}

/** Preserve previously-fetched name fields across a validation-only re-run. */
function pickNameFields(record) {
  if (!record) return {};
  const kept = {};
  for (const key of ['name', 'website', 'careers_url', 'allow_indexing']) {
    if (record[key] !== undefined) kept[key] = record[key];
  }
  return kept;
}

function parseArgs(argv) {
  const parsed = { ats: 'ashby', concurrency: 8, sample: null, onlyUnknown: false, withNames: false };
  for (const arg of argv) {
    if (arg.startsWith('--ats=')) parsed.ats = arg.slice(6).trim();
    else if (arg.startsWith('--concurrency=')) parsed.concurrency = Math.max(1, Number(arg.slice(14)));
    else if (arg.startsWith('--sample=')) parsed.sample = Math.max(1, Number(arg.slice(9)));
    else if (arg === '--only-unknown') parsed.onlyUnknown = true;
    else if (arg === '--with-names') parsed.withNames = true;
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return parsed;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function sortObject(object) {
  return Object.fromEntries(Object.entries(object).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
