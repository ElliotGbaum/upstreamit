#!/usr/bin/env node
/**
 * Phase 5 — run a filter profile from the command line.
 *
 *   node src/find.mjs                                   # the default profile
 *   node src/find.mjs nyc-entry-level                   # by name, from profiles/
 *   node src/find.mjs ./my-profile.json                 # or by path
 *   node src/find.mjs --metros=nyc,boston --max-years=3 # ad-hoc overrides
 *   node src/find.mjs --sort=newest --collapse             # order it, fold duplicates
 *   node src/find.mjs --pay-period=HOUR --currencies=USD   # the compensation block
 *   node src/find.mjs --equity --salary-stated             # equity, and pay as published
 *   node src/find.mjs --new-since=2026-08-20            # only jobs first seen since
 *   node src/find.mjs --json                            # machine-readable
 *   node src/find.mjs --facets                          # what loosening each filter would buy
 *   node src/find.mjs --why                             # per-result score breakdown
 *
 * Every flag is a profile field, so anything expressible here is expressible in
 * a saved profile and in the UI — there is no criterion that only the CLI can
 * express, which is the point of keeping the profile a document.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDb } from './lib/db.mjs';
import { search, corpusMeta, activeCriteria, UNKNOWNABLE } from './lib/filter/index.mjs';
import { newSince } from './lib/filter/diff.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PROFILE_DIR = join(ROOT, 'profiles');

/** Flags that set a profile field directly. Everything else is engine control. */
const LIST_FLAGS = {
  ats: 'ats',
  metros: 'metros',
  countries: 'countries',
  workplace: 'workplace',
  'employment-type': 'employment_type',
  'job-functions': 'job_functions',
  skills: 'skills',
  seniority: 'seniority',
  keywords: 'title_keywords',
  'title-keywords': 'title_keywords',
  'description-keywords': 'description_keywords',
  exclude: 'exclude_title_keywords',
  companies: 'companies',
  degree: 'degree',
  'company-size': 'company_size',
  'remote-scope': 'remote_scope',
  'pay-period': 'pay_period',
  currencies: 'currencies',
  'exclude-skills': 'exclude_skills',
};

/**
 * Flags that are a plain on/off switch on the profile.
 *
 * A table rather than a run of `else if`s because that run had already grown
 * past the point where a missing branch is visible — `--degree` shipped while
 * `--unknown-degree` was silently rejected, which is the same class of gap.
 */
const BOOLEAN_FLAGS = {
  'include-intern': 'include_intern',
  remote: 'remote_counts_as_match',
  equity: 'requires_equity',
  'salary-stated': 'salary_stated_only',
  'exclude-clearance': 'exclude_clearance',
  'exclude-visa-refusal': 'exclude_visa_refusal',
  'sponsors-visas': 'requires_visa_sponsorship',
  collapse: 'collapse_duplicates',
};

/** Criteria that can come back unknown, so `--unknown-<key>` accepts each one. */
const UNKNOWN_KEYS = new Set(UNKNOWNABLE.map((u) => u.key));

const NUMBER_FLAGS = {
  'max-years': 'max_years_experience',
  'min-years': 'min_years_experience',
  'salary-min': 'salary_min',
  'salary-max': 'salary_max',
  'posted-within': 'posted_within_days',
};

function parseArgs(argv) {
  const args = {
    profile: null,
    overrides: {},
    limit: 0,
    json: false,
    facets: false,
    why: false,
    aside: true,
    newSince: null,
    db: undefined,
    descriptionLimit: 8000,
    list: false,
  };

  for (const arg of argv.slice(2)) {
    if (!arg.startsWith('--')) {
      args.profile = arg;
      continue;
    }
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=');

    if (key in LIST_FLAGS) {
      args.overrides[LIST_FLAGS[key]] = value.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (key in NUMBER_FLAGS) {
      args.overrides[NUMBER_FLAGS[key]] = value === 'none' || value === '' ? null : Number(value);
    } else if (key === 'text') args.overrides.text = value;
    else if (key === 'sort') args.overrides.sort = value;
    else if (key in BOOLEAN_FLAGS) args.overrides[BOOLEAN_FLAGS[key]] = value !== 'false';
    else if (key.startsWith('unknown-') && UNKNOWN_KEYS.has(key.slice('unknown-'.length))) {
      // Derived from UNKNOWNABLE rather than listed here, so a criterion added
      // to the roster is reachable from the CLI without a second edit — the
      // hardcoded list this replaced had gone stale and left `--unknown-degree`
      // silently rejected while `--degree` quietly dropped 75.6% of the corpus.
      args.overrides.unknowns = { ...(args.overrides.unknowns ?? {}), [key.slice('unknown-'.length)]: value };
    } else if (key === 'limit') args.limit = Number(value);
    else if (key === 'json') args.json = value !== 'false';
    else if (key === 'facets') args.facets = value !== 'false';
    else if (key === 'why') args.why = value !== 'false';
    else if (key === 'no-aside') args.aside = false;
    else if (key === 'new-since') args.newSince = value;
    else if (key === 'description-limit') args.descriptionLimit = Number(value);
    else if (key === 'list') args.list = true;
    else if (key === 'db') args.db = value;
    else {
      console.error(`Unknown flag --${key}`);
      process.exit(2);
    }
  }
  return args;
}

/** Resolve a profile argument: a path, a bare name in `profiles/`, or the default. */
export function loadProfile(nameOrPath) {
  if (!nameOrPath) {
    const fallback = join(PROFILE_DIR, 'nyc-entry-level.json');
    if (existsSync(fallback)) return { source: fallback, data: readJson(fallback) };
    const first = listProfiles()[0];
    if (!first) return { source: null, data: {} };
    return { source: first.path, data: readJson(first.path) };
  }
  const candidates = [
    resolve(process.cwd(), nameOrPath),
    join(PROFILE_DIR, nameOrPath),
    join(PROFILE_DIR, `${nameOrPath}.json`),
  ];
  for (const path of candidates) if (existsSync(path)) return { source: path, data: readJson(path) };
  throw new Error(`No profile "${nameOrPath}" — looked in ${PROFILE_DIR} and as a path`);
}

export function listProfiles() {
  if (!existsSync(PROFILE_DIR)) return [];
  return readdirSync(PROFILE_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const path = join(PROFILE_DIR, f);
      let data = {};
      try {
        data = readJson(path);
      } catch {
        /* a malformed file should not hide the good ones */
      }
      return {
        name: f.replace(/\.json$/, ''),
        path,
        label: data.label ?? null,
        notes: data.notes ?? null,
        owner: ownerOf(data),
      };
    });
}

/**
 * Whose profile is this?
 *
 * A profile document may name an `owner` — one email address. A document
 * without one is everybody's, which is what every profile was before this
 * field existed and what a starter profile should stay.
 *
 * This is a *visibility* rule for the server, not a secret. The file sits in
 * `profiles/` next to the others and anyone with the repository can read it;
 * what the field buys is that the app stops handing one person's criteria to
 * every visitor as though they were the worked example for the whole corpus.
 * A criteria set is not neutral — it is the twelve title keywords and the one
 * city that a particular person needs a job in — so it belongs to them and
 * boots for them, and nobody else should have to un-tick it.
 */
export const ownerOf = (data) => {
  const owner = String(data?.owner ?? '').trim().toLowerCase();
  return owner || null;
};

/** May `email` (null when signed out) see a profile owned by `owner`? */
export const ownedBy = (owner, email) => !owner || owner === String(email ?? '').trim().toLowerCase();

/**
 * The profiles this viewer may see, theirs first.
 *
 * The ordering is load-bearing rather than cosmetic: the app boots into the
 * first profile in this list, so "yours first" is the whole of "log in and
 * your filters are already there" — and its absence is the whole of "a
 * stranger boots into your job search".
 */
export function profilesVisibleTo(email, profiles = listProfiles()) {
  const mine = [];
  const shared = [];
  for (const profile of profiles) {
    if (!profile.owner) shared.push(profile);
    else if (ownedBy(profile.owner, email)) mine.push(profile);
    // else: someone else's. Not listed, and `/api/profiles/:name` 404s on it.
  }
  return [...mine, ...shared];
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const fmt = (n) => Number(n).toLocaleString('en-US');

async function main() {
  const args = parseArgs(process.argv);

  if (args.list) {
    const profiles = listProfiles();
    if (!profiles.length) console.log(`No profiles in ${PROFILE_DIR}`);
    for (const p of profiles) console.log(`  ${p.name.padEnd(24)} ${p.label ?? ''}`);
    return;
  }

  const { source, data } = loadProfile(args.profile);
  const merged = { ...data, ...args.overrides };
  if (args.overrides.unknowns) merged.unknowns = { ...(data.unknowns ?? {}), ...args.overrides.unknowns };

  const db = openDb(args.db);
  const meta = corpusMeta(db);
  if (!meta.derived) {
    console.error('No derived jobs in the database — run `npm run sweep && npm run derive` first.');
    process.exit(1);
  }

  const opts = { descriptionLimit: args.descriptionLimit };
  if (args.limit) opts.limit = args.limit;
  if (args.newSince) {
    const since = newSince(db, args.newSince);
    opts.restrictTo = since.ids;
    opts.sinceLabel = since.label;
  }

  const result = search(db, merged, opts);

  if (args.json) {
    console.log(JSON.stringify({ source, ...result }, null, 2));
    db.close();
    return;
  }

  printReport(result, { source, args, meta, opts });
  db.close();
}

function printReport(result, { source, args, meta, opts }) {
  const { profile, funnel } = result;

  console.log('');
  console.log(`  ${profile.label ?? profile.name}`);
  if (source) console.log(`  ${source.replace(`${ROOT}/`, '')}`);
  if (opts.sinceLabel) console.log(`  restricted to jobs first seen ${opts.sinceLabel}`);
  console.log('');

  for (const { key, summary } of activeCriteria(profile)) {
    console.log(`    · ${summary}`);
  }
  const policies = Object.entries(profile.unknowns).filter(([, v]) => v !== 'include');
  if (policies.length) {
    console.log(`    · unknowns: ${policies.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  console.log('');

  // The funnel is the honest version of "why did I get this many results".
  console.log(`  ${fmt(funnel.open_jobs).padStart(8)}  open jobs`);
  if (funnel.considered !== funnel.open_jobs) console.log(`  ${fmt(funnel.considered).padStart(8)}  after text / exclusions`);
  console.log(`  ${fmt(funnel.passed_title_gate).padStart(8)}  past the title gate`);
  console.log(`  ${fmt(funnel.matched).padStart(8)}  matched`);
  // Named rather than silently applied: a count that drops with no explanation
  // is indistinguishable from a filter that went wrong.
  if (funnel.folded)
    console.log(`  ${fmt(funnel.matched - funnel.folded).padStart(8)}  after folding ${fmt(funnel.folded)} duplicate postings`);
  if (funnel.set_aside) console.log(`  ${fmt(funnel.set_aside).padStart(8)}  set aside (unknown on a "separate" criterion)`);
  console.log('');

  for (const warning of result.warnings) console.log(`  ! ${warning}`);
  if (result.warnings.length) console.log('');

  printRows(result.results, args);

  if (args.aside && result.aside.length) {
    console.log('');
    console.log(`  ── worth a look: ${fmt(result.aside_total)} jobs that match everything except that we could not tell ──`);
    console.log('');
    printRows(result.aside, args);
  }

  if (args.facets && result.facets) printFacets(result.facets);

  console.log('');
  console.log(
    `  ${fmt(result.total)} results${result.aside_total ? ` · ${fmt(result.aside_total)} aside` : ''} · ` +
      `${result.stats.ms} ms · corpus derived ${meta.last_derive ? new Date(meta.last_derive).toISOString().slice(0, 10) : '—'}`,
  );
  console.log('');
}

function printRows(rows, args) {
  if (!rows.length) {
    console.log('  (nothing)');
    return;
  }
  const width = Math.max(...rows.map((r) => (r.title ?? '').length), 10);
  for (const [i, row] of rows.entries()) {
    const rank = String(i + 1).padStart(3);
    const place = row.metros.length ? row.metros.join('/') : (row.workplace ?? '—');
    console.log(
      `  ${rank}. ${row.title.padEnd(Math.min(width, 58))}  ${(row.company ?? '').padEnd(22).slice(0, 22)} ` +
        `${String(row.score).padStart(6)}  ${place} · ${row.workplace}` +
        `${row.salary_label ? ` · ${row.salary_label}` : ''}`,
    );
    if (args.why) {
      // Only when there is something to say: `why` is now just the description
      // keyword hits, so a search with no description criteria has none, and a
      // blank indented line under every result is worse than no line.
      if (row.why.length) console.log(`       ${row.why.join(' · ')}`);
      console.log(
        `       ${Object.entries(row.score_parts)
          .filter(([, v]) => v > 0)
          .map(([k, v]) => `${k} ${v.toFixed(1)}`)
          .join('  ')}`,
      );
    }
    console.log(`       ${row.url ?? ''}`);
  }
}

function printFacets(facets) {
  const show = [
    ['metro', 'Metros'],
    ['workplace', 'Workplace'],
    ['seniority', 'Seniority'],
    ['salary_band', 'Salary'],
    ['age_band', 'Age'],
    ['job_function', 'Job function'],
    ['company', 'Companies'],
  ];
  console.log('');
  console.log('  ── if you loosened one filter ──');
  for (const [key, label] of show) {
    const rows = (facets[key] ?? []).slice(0, 12);
    if (!rows.length) continue;
    console.log(`\n  ${label}`);
    for (const row of rows) {
      console.log(`    ${row.selected ? '✓' : ' '} ${String(row.label).padEnd(30)} ${fmt(row.count).padStart(7)}`);
    }
    if (facets[`${key}_truncated`]) console.log(`      … ${facets[`${key}_truncated`]} more`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
