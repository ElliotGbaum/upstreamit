#!/usr/bin/env node
/**
 * Rebuild the metro registry from the job↔metro links already in the database.
 *
 *   node src/rebuild-metros.mjs              # rebuild in place
 *   node src/rebuild-metros.mjs --dry-run    # report what it would write
 *
 * `derive.mjs` builds `metros` and `metro_aliases` from `stats.metroCount`,
 * which only accumulates over the jobs *that run* touched — and it opens with
 * `DELETE FROM metro_aliases; DELETE FROM metros;`. So a partial pass
 * (`--only-new`) does not update the registry, it replaces it with a registry
 * describing only the new jobs. A 2,625-job run left 930 metros behind where
 * the corpus actually holds 24,391, and every count in the UI's dropdown was
 * the count within those 2,625.
 *
 * `job_metros` is not damaged by this: derive rewrites it per job
 * (`DELETE FROM job_metros WHERE job_id = ?`), so it still holds every link for
 * every job. That makes the registry recoverable without re-deriving anything —
 * the counts are a GROUP BY, and the labels come from the same curated table
 * derive uses.
 *
 * One thing does not survive: the aliases observed in the wild, which live only
 * in `stats.aliases` during a run. So aliases are added to rather than replaced
 * — the curated set is re-asserted and whatever earlier runs observed is kept.
 */

import { openDb, transact, setMeta } from './lib/db.mjs';
import { METRO_BY_ID, CITY_TO_METRO } from './lib/derive/geo.mjs';

const args = parseArgs(process.argv.slice(2));
const db = openDb(args.db);

/** Title-case a slug for display. `acme-corp` -> `Acme Corp`. (as derive.mjs) */
function titleCase(text) {
  return String(text)
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

const before = {
  metros: db.prepare('SELECT COUNT(*) n FROM metros').get().n,
  aliases: db.prepare('SELECT COUNT(*) n FROM metro_aliases').get().n,
};

// ------------------------------------------------------------------ counts --
// One row per (job, metro), so a plain GROUP BY is the job count derive would
// have arrived at by tallying every job it processed.
const counts = db.prepare('SELECT metro, COUNT(*) c FROM job_metros GROUP BY metro').all();
const countOf = new Map(counts.map((r) => [r.metro, r.c]));

// --------------------------------------------------------------- countries --
// Curated metros carry their own country. A minted one takes the country most
// often seen on the jobs placed in it — the same "most frequently observed"
// rule derive applies, reconstructed from the stored per-job country lists
// rather than from the observations of a single run.
const metroCountry = new Map(); // `${metro}|${code}` -> n
for (const row of db.prepare(
  "SELECT d_metros, d_countries FROM jobs WHERE d_metros IS NOT NULL AND d_metros != '' AND d_metros != '[]'",
).iterate()) {
  const metros = parseList(row.d_metros);
  const countries = parseList(row.d_countries);
  if (!metros.length || !countries.length) continue;
  for (const metro of metros) {
    if (METRO_BY_ID.has(metro)) continue; // curated: country comes from the table
    for (const code of countries) {
      const key = `${metro}|${code}`;
      metroCountry.set(key, (metroCountry.get(key) ?? 0) + 1);
    }
  }
}

function bestCountry(metro) {
  let best = 0;
  let country = null;
  for (const [key, n] of metroCountry) {
    const sep = key.lastIndexOf('|');
    if (key.slice(0, sep) !== metro) continue;
    if (n > best) {
      best = n;
      country = key.slice(sep + 1);
    }
  }
  return country;
}

const rows = counts.map(({ metro, c }) => {
  const known = METRO_BY_ID.get(metro);
  return {
    id: metro,
    label: known?.label ?? titleCase(metro),
    country: known?.country ?? bestCountry(metro),
    region: known?.region ?? null,
    job_count: c,
  };
});

const curatedAliases = [...CITY_TO_METRO].filter(([, metro]) => countOf.has(metro));

if (args.dryRun) {
  report('would write');
  db.close();
  process.exit(0);
}

// ----------------------------------------------------------------- write ----
// `metro_aliases.metro_id` is declared ON DELETE CASCADE, so clearing `metros`
// takes every alias with it — including the ones observed in the wild that this
// script cannot reconstruct. Snapshot them first and put them back.
const keptAliases = db.prepare('SELECT alias, metro_id FROM metro_aliases').all();

transact(db, () => {
  // `metros` is fully derivable from the links, so replacing it is safe.
  db.exec('DELETE FROM metros;');
  const insMetro = db.prepare(
    'INSERT OR REPLACE INTO metros (id, label, country, region, job_count) VALUES (?, ?, ?, ?, ?)',
  );
  for (const r of rows) insMetro.run(r.id, r.label, r.country, r.region, r.job_count);

  // Restore the snapshot, then re-assert the curated set. An alias whose metro
  // no longer appears anywhere in the corpus is dropped rather than re-inserted:
  // the cascade was right that it points at nothing.
  const insAlias = db.prepare('INSERT OR REPLACE INTO metro_aliases (alias, metro_id) VALUES (?, ?)');
  for (const a of keptAliases) if (countOf.has(a.metro_id)) insAlias.run(a.alias, a.metro_id);
  for (const [city, metro] of curatedAliases) insAlias.run(city, metro);
});

// The server rebuilds its in-memory index off this stamp; without it the new
// registry sits in the file and the running process keeps the old dropdown.
setMeta(db, 'last_derive', String(Date.now()));

report('wrote');
db.close();

function report(verb) {
  const after = {
    metros: args.dryRun ? rows.length : db.prepare('SELECT COUNT(*) n FROM metros').get().n,
    aliases: args.dryRun
      ? before.aliases + curatedAliases.length
      : db.prepare('SELECT COUNT(*) n FROM metro_aliases').get().n,
  };
  const top = [...rows].sort((a, b) => b.job_count - a.job_count).slice(0, 8);
  console.log(`
  ${verb}:
    metros   ${before.metros.toLocaleString()} -> ${after.metros.toLocaleString()}
    aliases  ${before.aliases.toLocaleString()} -> ${after.aliases.toLocaleString()}

  largest metros:`);
  for (const r of top) {
    console.log(`    ${r.id.padEnd(18)} ${String(r.job_count).padStart(7)}  ${r.label}`);
  }
  console.log();
}

function parseList(json) {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseArgs(argv) {
  const parsed = { db: undefined, dryRun: false };
  for (const arg of argv) {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
    if (key === 'db') parsed.db = value;
    else if (key === 'dry-run') parsed.dryRun = value !== 'false';
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return parsed;
}
