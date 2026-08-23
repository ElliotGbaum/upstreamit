#!/usr/bin/env node
/**
 * Repair pass for Ashby names and links.
 *
 *   node src/repair-ashby-links.mjs                  # every live ashby board
 *   node src/repair-ashby-links.mjs --only=greptile
 *   node src/repair-ashby-links.mjs --limit=100      # smoke run
 *
 * Two problems, one org lookup each (see `fetchOrganization` in the adapter):
 *
 *  1. Ashby's posting API publishes no company name, so boards render as a
 *     title-cased slug ("Openai") until the real name is fetched from the
 *     GraphQL host and stored.
 *
 *  2. An org can switch its hosted jobs.ashbyhq.com page off and serve the
 *     board through its own site instead (greptile.com/careers/open). The
 *     posting API keeps handing out jobs.ashbyhq.com jobUrls regardless, and
 *     every one of them renders "Page not found". For boards in that state this
 *     pass rewrites each stored job's url to the careers-page deep link
 *     (`<careers_url>?ashby_jid=<id>`) — the link the org's own careers page
 *     renders.
 *
 * Results are written to the database *and* merged into
 * `data/slugs/ashby-verified.json`, which `sweep.mjs` reads back. Both halves
 * matter: without the merge, the next non-304 sweep would put the posting API's
 * dead links right back; without the database write, boards that answer 304
 * from here on would never be repaired at all.
 *
 * The GraphQL host rate-limits hard (429s within a few dozen requests at
 * higher concurrency, per the adapter's notes), hence the default concurrency
 * of `adapter.nameConcurrency`.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './lib/http.mjs';
import { openDb, transact, setMeta } from './lib/db.mjs';
import { ticker, logEvent } from './lib/progress.mjs';
import * as ashby from './lib/adapters/ashby.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERIFIED_PATH = join(ROOT, 'data', 'slugs', 'ashby-verified.json');

const args = parseArgs(process.argv.slice(2));
const db = openDb(args.db);

let slugs;
if (args.only) {
  slugs = args.only;
} else {
  slugs = db
    .prepare("SELECT slug FROM companies WHERE ats = 'ashby' AND status IN ('live','empty') ORDER BY slug")
    .all()
    .map((r) => r.slug);
}
if (args.limit > 0) slugs = slugs.slice(0, args.limit);
if (!slugs.length) {
  console.error('No ashby boards to repair.');
  process.exit(1);
}

const concurrency = args.concurrency || ashby.nameConcurrency || 2;
console.log(`Resolving ${slugs.length.toLocaleString()} ashby org(s) at concurrency ${concurrency}…\n`);
logEvent(`repair ashby: ${slugs.length.toLocaleString()} boards, concurrency ${concurrency}`);

const updateCompany = db.prepare(
  "UPDATE companies SET name = ?, name_source = 'api', website = COALESCE(?, website) WHERE ats = 'ashby' AND slug = ?",
);
const updateJobNames = db.prepare(
  "UPDATE jobs SET company_name = ? WHERE ats = 'ashby' AND company_slug = ?",
);
const selectJobs = db.prepare(
  "SELECT id, native_id FROM jobs WHERE ats = 'ashby' AND company_slug = ?",
);
const updateJobUrl = db.prepare('UPDATE jobs SET url = ?, apply_url = NULL WHERE id = ?');

const organizations = new Map();
const counts = { named: 0, disabled: 0, relinked_jobs: 0, missing: 0, errors: 0 };
const bar = ticker('repair:ashby', 'Repairing Ashby boards', slugs.length);

await pool(slugs, concurrency, async (slug) => {
  let org = null;
  try {
    org = await ashby.fetchOrganization(slug);
  } catch {
    counts.errors += 1;
  }
  if (org) {
    organizations.set(slug, org);
    transact(db, () => {
      if (org.name) {
        updateCompany.run(org.name, org.website ?? null, slug);
        updateJobNames.run(org.name, slug);
        counts.named += 1;
      }
      if (org.hosted_disabled === 1 && org.careers_url) {
        counts.disabled += 1;
        for (const job of selectJobs.all(slug)) {
          updateJobUrl.run(ashby.externalJobUrl(org.careers_url, job.native_id), job.id);
          counts.relinked_jobs += 1;
        }
      }
    });
  } else {
    counts.missing += 1;
  }
  bar.tick(1, {
    note: `named ${counts.named} · disabled boards ${counts.disabled} · jobs relinked ${counts.relinked_jobs}`,
    extra: { ...counts },
  });
});

// Merge what was learned into the verified file so the next sweep keeps it.
// Read-merge-write rather than overwrite: this run may have covered a subset
// (--only/--limit) and the file also carries probe verdicts this pass never
// touches.
const verified = await readJson(VERIFIED_PATH, { ats: 'ashby', companies: {} });
const companies = Object.assign(Object.create(null), verified.companies ?? {});
for (const [slug, org] of organizations) {
  const existing = Object.hasOwn(companies, slug) ? companies[slug] : {};
  companies[slug] = { ...existing };
  for (const key of ['name', 'website', 'careers_url', 'allow_indexing', 'hosted_disabled']) {
    if (org[key] !== undefined && org[key] !== null) companies[slug][key] = org[key];
  }
}
await writeFile(
  VERIFIED_PATH,
  `${JSON.stringify({ ...verified, companies: sortObject(companies) }, null, 2)}\n`,
);

// The server's in-memory index reloads on the derive stamp; a url/name UPDATE
// moves none of the counts it watches, so stamp it here or the fix stays
// invisible until the next derive.
if (counts.named || counts.relinked_jobs) setMeta(db, 'last_derive', String(Date.now()));

bar.done(
  `${counts.named.toLocaleString()} named · ${counts.disabled} disabled boards · ${counts.relinked_jobs.toLocaleString()} jobs relinked`,
);
logEvent(
  `repair ashby done: ${counts.named.toLocaleString()} named · ${counts.disabled} hosted-disabled boards · ` +
    `${counts.relinked_jobs.toLocaleString()} jobs relinked · ${counts.missing} unresolved · ${counts.errors} errors`,
);
console.log(`
  named          ${counts.named.toLocaleString()}
  disabled       ${counts.disabled.toLocaleString()} board(s) with dead hosted pages
  jobs relinked  ${counts.relinked_jobs.toLocaleString()}
  unresolved     ${counts.missing.toLocaleString()}
  errors         ${counts.errors.toLocaleString()}
`);
db.close();

function parseArgs(argv) {
  const parsed = { only: null, limit: 0, concurrency: 0, db: undefined };
  for (const arg of argv) {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
    if (key === 'only') parsed.only = value.split(',').map((s) => s.trim()).filter(Boolean);
    else if (key === 'limit') parsed.limit = Number(value);
    else if (key === 'concurrency') parsed.concurrency = Number(value);
    else if (key === 'db') parsed.db = value;
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
