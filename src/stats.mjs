#!/usr/bin/env node
/**
 * Which sources are actually earning their place.
 *
 * Joins the slug store (authority on provenance) with the verification results
 * (authority on whether a board exists). The column that matters is "only" — boards
 * no other source knew about. A source with a high count but zero uniques is
 * redundant; a small source with uniques is worth keeping.
 *
 *   node src/stats.mjs            # ashby
 *   node src/stats.mjs greenhouse # any ATS (unverified ATSes show candidates only)
 */

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Positional, and defaulting to Ashby for continuity — `node src/stats.mjs
// greenhouse` is the other one. Not a flag because this script predates there
// being more than one ATS and the bare invocation is in muscle memory.
const ats = process.argv[2] ?? 'ashby';

/** Sources that came from the open web rather than a git repo. */
const WEB_SOURCES = new Set(['hf-latmay', 'backfill']);

const store = JSON.parse(await readFile(join(ROOT, 'data', 'slugs', `${ats}.json`), 'utf8'));
const verified = await readJson(join(ROOT, 'data', 'slugs', `${ats}-verified.json`), null);

const active = Object.entries(store.slugs).filter(([, record]) => record.sources.length > 0);
const statusOf = (slug) => verified?.companies?.[slug]?.status ?? 'unprobed';

const rows = new Map();
for (const [slug, record] of active) {
  const status = statusOf(slug);
  for (const sourceId of record.sources) {
    const row = mapGet(rows, sourceId, () => ({ total: 0, live: 0, dead: 0, unprobed: 0, only: 0 }));
    row.total += 1;
    row[status === 'exists' ? 'live' : status === 'dead' ? 'dead' : 'unprobed'] += 1;
    if (record.sources.length === 1 && status !== 'dead') row.only += 1;
  }
}

const live = active.filter(([slug]) => statusOf(slug) === 'exists').length;
const dead = active.filter(([slug]) => statusOf(slug) === 'dead').length;
const unprobed = active.length - live - dead;

console.log(`\n${ats}: ${active.length} slugs — ${live} live, ${dead} dead, ${unprobed} unprobed\n`);
console.log('  source          slugs     live    dead%    only');
console.log('  ' + '-'.repeat(48));
for (const [sourceId, row] of [...rows].sort((a, b) => b[1].live - a[1].live || b[1].total - a[1].total)) {
  const probed = row.live + row.dead;
  const deadRate = probed ? `${((100 * row.dead) / probed).toFixed(0)}%` : '—';
  console.log(
    `  ${sourceId.padEnd(14)} ${String(row.total).padStart(6)} ${String(row.live).padStart(8)} ` +
      `${deadRate.padStart(8)} ${String(row.only).padStart(7)}`,
  );
}

// Compare any two groups of sources by their live coverage. Useful for questions like
// "is the GitHub half still pulling its weight now that the web harvest is in?"
if (verified) {
  const groups = { github: [], 'non-github': [] };
  for (const [slug, record] of active) {
    if (statusOf(slug) !== 'exists') continue;
    const fromWeb = record.sources.some((id) => WEB_SOURCES.has(id));
    const fromRepo = record.sources.some((id) => !WEB_SOURCES.has(id) && id !== 'manual');
    if (fromWeb) groups['non-github'].push(slug);
    if (fromRepo) groups.github.push(slug);
  }
  const repos = new Set(groups.github);
  const web = new Set(groups['non-github']);
  console.log('\n  live coverage by origin type');
  console.log(`    github repos      ${repos.size}   (${[...repos].filter((s) => !web.has(s)).length} found nowhere else)`);
  console.log(`    non-github web    ${web.size}   (${[...web].filter((s) => !repos.has(s)).length} found nowhere else)`);
  console.log(`    union             ${new Set([...repos, ...web]).size}`);
}
console.log('');

function mapGet(map, key, create) {
  if (!map.has(key)) map.set(key, create());
  return map.get(key);
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}
