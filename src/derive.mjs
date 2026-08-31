#!/usr/bin/env node
/**
 * Normalization.
 *
 *   node src/derive.mjs                  # derive every job, rebuild everything
 *   node src/derive.mjs --only-new       # just the jobs a sweep added since last time
 *   node src/derive.mjs --limit=2000     # smoke run
 *   node src/derive.mjs --no-fts         # skip the full-text rebuild (the slow part)
 *
 * Turns the raw columns the sweep stored into the canonical ones filters read.
 * Nothing here touches the network: derivation is a pure function of the swept
 * data, which is what makes it safe to re-run after editing a metro alias or a
 * title rule. Re-deriving the whole corpus is minutes of local CPU (about 50 s
 * at 61k jobs, when the corpus was Ashby only), so improving a rule never means
 * re-sweeping twelve thousand boards.
 *
 * Writes, in order: the `d_*` columns on `jobs`, the `job_metros` and
 * `job_skills` join tables, the `metros` / `metro_aliases` registry built from
 * what was actually observed, display names for companies whose ATS exposes
 * none, and finally the FTS index.
 */

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, transact, setMeta } from './lib/db.mjs';
import { ticker, logEvent, setStat } from './lib/progress.mjs';
import { deriveJob } from './lib/derive/index.mjs';
import { METRO_BY_ID, CITY_TO_METRO } from './lib/derive/geo.mjs';
import { FX_AS_OF } from './lib/derive/salary.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { limit: 0, batch: 2000, fts: true, onlyNew: false, db: undefined, report: true };
  for (const arg of argv.slice(2)) {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
    if (key === 'limit') args.limit = Number(value);
    else if (key === 'batch') args.batch = Number(value);
    else if (key === 'no-fts') args.fts = false;
    else if (key === 'fts') args.fts = value !== 'false';
    else if (key === 'only-new') args.onlyNew = true;
    else if (key === 'no-report') args.report = false;
    else if (key === 'db') args.db = value;
  }
  return args;
}

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : '—');
const fmt = (n) => n.toLocaleString('en-US');

/** Title-case a slug for display. `acme-corp` -> `Acme Corp`. */
function titleCase(text) {
  return String(text)
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

async function main() {
  const args = parseArgs(process.argv);
  const db = openDb(args.db);
  const now = Date.now();

  const where = args.onlyNew ? 'WHERE j.d_derived_at IS NULL' : '';
  const total = db.prepare(`SELECT COUNT(*) n FROM jobs j ${where}`).get().n;
  const target = args.limit ? Math.min(args.limit, total) : total;

  if (!target) {
    console.log(args.onlyNew ? 'Nothing new to derive.' : 'No jobs in the database — run the sweep first.');
    return;
  }

  console.log(`Deriving ${fmt(target)} job${target === 1 ? '' : 's'}${args.onlyNew ? ' (new only)' : ''}…`);
  const tick = ticker('derive', 'Normalization pass', target);
  logEvent(`derive: ${fmt(target)} jobs`);

  const select = db.prepare(`
    SELECT j.rowid AS rid, j.id, j.title, j.department, j.team, j.employment_type,
           j.location_raw, j.locations_all, j.country, j.region, j.city,
           j.raw_workplace, j.raw_remote, j.posted_at, j.company_slug, j.company_name,
           j.comp_min, j.comp_max, j.comp_currency, j.comp_interval,
           c.description_text AS description
    FROM jobs j
    LEFT JOIN job_content c ON c.job_id = j.id
    ${where ? `${where} AND` : 'WHERE'} j.rowid > ?
    ORDER BY j.rowid
    LIMIT ?
  `);

  const update = db.prepare(`
    UPDATE jobs SET
      d_workplace = ?, d_workplace_src = ?, d_remote_scope = ?,
      d_metros = ?, d_countries = ?,
      d_salary_min = ?, d_salary_max = ?, d_salary_known = ?, d_salary_src = ?,
      d_min_years = ?, d_max_years = ?, d_years_known = ?,
      d_seniority = ?, d_seniority_src = ?, d_job_function = ?, d_skills = ?,
      d_visa = ?, d_clearance = ?, d_degree = ?, d_age_days = ?, d_quality = ?,
      d_derived_at = ?
    WHERE id = ?
  `);
  const delMetros = db.prepare('DELETE FROM job_metros WHERE job_id = ?');
  const insMetro = db.prepare('INSERT OR IGNORE INTO job_metros (job_id, metro) VALUES (?, ?)');
  const delSkills = db.prepare('DELETE FROM job_skills WHERE job_id = ?');
  const insSkill = db.prepare('INSERT OR IGNORE INTO job_skills (job_id, skill) VALUES (?, ?)');

  // Tallies for the report. Counting during the pass costs nothing and turns
  // "did this work?" into a number instead of a spot check.
  const stats = {
    workplace: {}, seniority: {}, jobFunction: {}, salarySrc: {}, degree: {},
    metroCount: new Map(), metroCountry: new Map(), mintedCities: new Map(),
    unmatched: new Map(), aliases: new Map(),
    salaryKnown: 0, yearsKnown: 0, noMetro: 0, visaYes: 0, visaNo: 0, clearance: 0,
    qualitySum: 0, multiMetro: 0,
  };
  const bump = (obj, key) => { obj[key] = (obj[key] ?? 0) + 1; };
  const bumpMap = (map, key, by = 1) => map.set(key, (map.get(key) ?? 0) + by);

  let cursor = 0;
  let done = 0;
  while (done < target) {
    const rows = select.all(cursor, Math.min(args.batch, target - done));
    if (!rows.length) break;

    transact(db, () => {
      for (const row of rows) {
        const d = deriveJob(row, row.description ?? '', now);

        update.run(
          d.d_workplace, d.d_workplace_src, d.d_remote_scope,
          d.d_metros, d.d_countries,
          d.d_salary_min, d.d_salary_max, d.d_salary_known, d.d_salary_src,
          d.d_min_years, d.d_max_years, d.d_years_known,
          d.d_seniority, d.d_seniority_src, d.d_job_function, d.d_skills,
          d.d_visa, d.d_clearance, d.d_degree, d.d_age_days, d.d_quality,
          d.d_derived_at, row.id,
        );

        delMetros.run(row.id);
        for (const metro of d._metros) insMetro.run(row.id, metro);
        delSkills.run(row.id);
        for (const skill of d._skills) insSkill.run(row.id, skill);

        bump(stats.workplace, d.d_workplace);
        bump(stats.seniority, d.d_seniority);
        bump(stats.jobFunction, d.d_job_function);
        bump(stats.salarySrc, d.d_salary_src.split(':')[0]);
        if (d.d_degree) bump(stats.degree, d.d_degree);
        if (d.d_salary_known) stats.salaryKnown++;
        if (d.d_years_known) stats.yearsKnown++;
        if (d.d_visa === 1) stats.visaYes++;
        if (d.d_visa === 0) stats.visaNo++;
        if (d.d_clearance === 1) stats.clearance++;
        stats.qualitySum += d.d_quality;
        if (!d._metros.length) stats.noMetro++;
        if (d._metros.length > 1) stats.multiMetro++;
        for (const metro of d._metros) bumpMap(stats.metroCount, metro);
        for (const { city, metro, minted, country } of d._cities) {
          stats.aliases.set(city, metro);
          if (minted) {
            bumpMap(stats.mintedCities, metro);
            if (country) bumpMap(stats.metroCountry, `${metro}|${country}`);
          }
        }
        for (const frag of d._unmatched) bumpMap(stats.unmatched, frag);
      }
    });

    cursor = rows[rows.length - 1].rid;
    done += rows.length;
    tick.tick(rows.length);
  }

  // ---------------------------------------------------------------- registry --
  // Built from what the corpus actually contained, so the UI's metro dropdown
  // can be generated from the data rather than a hardcoded list.
  transact(db, () => {
    db.exec('DELETE FROM metro_aliases; DELETE FROM metros;');
    const insMetroRow = db.prepare(
      'INSERT OR REPLACE INTO metros (id, label, country, region, job_count) VALUES (?, ?, ?, ?, ?)',
    );
    const insAlias = db.prepare('INSERT OR REPLACE INTO metro_aliases (alias, metro_id) VALUES (?, ?)');

    for (const [metro, count] of stats.metroCount) {
      const known = METRO_BY_ID.get(metro);
      let country = known?.country ?? null;
      if (!country) {
        // Most frequently observed country for an auto-minted metro.
        let best = 0;
        for (const [key, n] of stats.metroCountry) {
          const [id, code] = key.split('|');
          if (id === metro && n > best) { best = n; country = code; }
        }
      }
      insMetroRow.run(metro, known?.label ?? titleCase(metro), country, known?.region ?? null, count);
    }
    // Curated aliases first, then every alias observed in the wild.
    for (const [city, metro] of CITY_TO_METRO) if (stats.metroCount.has(metro)) insAlias.run(city, metro);
    for (const [city, metro] of stats.aliases) insAlias.run(city, metro);
  });

  // ------------------------------------------------------------ company names --
  // Ashby's posting API returns no company name, so every Ashby board lands
  // nameless and every result would read `notion` instead of `Notion`. The slug
  // is the only signal available without hitting the rate-limited GraphQL host,
  // so it is title-cased and marked `name_source = 'slug'` — visibly a guess,
  // and overwritten the moment a real name arrives (upsertBoard COALESCEs).
  const named = transact(db, () => {
    const rows = db.prepare(
      "SELECT id, slug FROM companies WHERE name IS NULL OR name = ''",
    ).all();
    const stmt = db.prepare("UPDATE companies SET name = ?, name_source = 'slug' WHERE id = ?");
    for (const row of rows) stmt.run(titleCase(row.slug), row.id);
    // Jobs inherit from `companies`, not from the loop above: a board named on
    // an earlier run still sweeps in new rows with a blank company_name, and
    // those have to pick the stored name up too.
    db.prepare(
      `UPDATE jobs SET company_name = (SELECT name FROM companies WHERE companies.id = jobs.company_id)
       WHERE (company_name IS NULL OR company_name = '')
         AND company_id IN (SELECT id FROM companies WHERE name IS NOT NULL AND name != '')`,
    ).run();
    return rows.length;
  });

  // -------------------------------------------------------------------- FTS --
  let ftsRows = 0;
  if (args.fts) {
    // The pass reads the whole corpus even under --only-new (readFts below has
    // no WHERE beyond the cursor), so its ticker counts all jobs, not this
    // run's — the old denominator made the progress page read "700,000 of
    // 2,625" for the longest stage of the night.
    const ftsTotal = db.prepare('SELECT COUNT(*) n FROM jobs').get().n;
    const ftsTick = ticker('derive:fts', 'Full-text index', ftsTotal);
    // Contentless FTS5 tables cannot be UPDATEd row-by-row, so a rebuild is a
    // drop and repopulate. It is the slow half of this script by a wide margin
    // — tens of minutes on the full corpus — so it is built under a scratch
    // name and swapped in one transaction at the end. Dropping the live table
    // first meant a kill, an OOM or a mid-pass sleep left every keyword search
    // silently answering from a truncated index until the next derive, with no
    // error anywhere: ftsSearch just returns fewer ids.
    db.exec(`
      DROP TABLE IF EXISTS jobs_fts_new;
      DROP TABLE IF EXISTS jobs_fts_map_new;
      CREATE VIRTUAL TABLE jobs_fts_new USING fts5(
        title, company, body, content = '', tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TABLE jobs_fts_map_new (
        rowid  INTEGER PRIMARY KEY,
        job_id TEXT UNIQUE NOT NULL
      );
    `);
    const insFts = db.prepare('INSERT INTO jobs_fts_new (rowid, title, company, body) VALUES (?, ?, ?, ?)');
    const insMap = db.prepare('INSERT INTO jobs_fts_map_new (rowid, job_id) VALUES (?, ?)');
    const readFts = db.prepare(`
      SELECT j.rowid AS rid, j.id, j.title, j.company_name, c.description_text AS body
      FROM jobs j LEFT JOIN job_content c ON c.job_id = j.id
      WHERE j.rowid > ? ORDER BY j.rowid LIMIT ?
    `);
    let fcur = 0;
    for (;;) {
      const rows = readFts.all(fcur, args.batch);
      if (!rows.length) break;
      transact(db, () => {
        for (const row of rows) {
          insFts.run(row.rid, row.title ?? '', row.company_name ?? '', row.body ?? '');
          insMap.run(row.rid, row.id);
          ftsRows++;
        }
      });
      fcur = rows[rows.length - 1].rid;
      ftsTick.tick(rows.length);
    }
    db.exec("INSERT INTO jobs_fts_new (jobs_fts_new) VALUES ('optimize')");
    // The swap. A rename is metadata-only, so the window where no complete
    // index exists shrinks from the whole build to one transaction; a crash
    // before this line leaves the old index answering, and the next run's
    // DROP IF EXISTS clears the half-built scratch.
    transact(db, () => {
      db.exec(`
        DROP TABLE IF EXISTS jobs_fts;
        DROP TABLE IF EXISTS jobs_fts_map;
        ALTER TABLE jobs_fts_new RENAME TO jobs_fts;
        ALTER TABLE jobs_fts_map_new RENAME TO jobs_fts_map;
      `);
    });
    ftsTick.done(`${fmt(ftsRows)} documents`);
  }

  setMeta(db, 'last_derive', String(now));
  setMeta(db, 'last_derive_count', String(done));

  const elapsed = ((Date.now() - now) / 1000).toFixed(1);
  tick.done(`${fmt(done)} jobs · ${elapsed}s`);

  const report = buildReport({ args, done, stats, named, ftsRows, elapsed, db });
  if (args.report) {
    writeFileSync(join(ROOT, 'data', 'derive-report.md'), report.markdown);
    console.log(report.console);
    console.log(`\nFull report → data/derive-report.md`);
  } else {
    console.log(report.console);
  }

  setStat('derived', done, 'jobs normalized');
  setStat('metros', stats.metroCount.size, 'metros discovered');
  logEvent(
    `derive done: ${fmt(done)} jobs · ${stats.metroCount.size} metros · ` +
    `${pct(stats.salaryKnown, done)} salary · ${pct(stats.yearsKnown, done)} years · ${elapsed}s`,
    'ok',
  );
  db.close();
}

function buildReport({ args, done, stats, named, ftsRows, elapsed, db }) {
  const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  const rank = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]);
  const row = (k, v) => `| ${k} | ${fmt(v)} | ${pct(v, done)} |`;

  const classified = done - (stats.seniority.unknown ?? 0);
  const known = (obj, key) => obj[key] ?? 0;

  const lines = [];
  lines.push('# Derivation report', '');
  lines.push(`Run: ${new Date().toISOString()} · ${fmt(done)} jobs in ${elapsed}s`);
  lines.push(`FX rates as of **${FX_AS_OF}** (static — see \`src/lib/derive/salary.mjs\`)`, '');

  lines.push('## Coverage', '');
  lines.push('| Signal | Jobs | Share |', '| --- | --- | --- |');
  lines.push(row('workplace known', done - known(stats.workplace, 'unknown')));
  lines.push(row('placed in ≥1 metro', done - stats.noMetro));
  lines.push(row('in >1 metro', stats.multiMetro));
  lines.push(row('salary in USD/yr', stats.salaryKnown));
  lines.push(row('years of experience parsed', stats.yearsKnown));
  lines.push(row('seniority classified', classified));
  lines.push(row('visa: sponsors', stats.visaYes));
  lines.push(row('visa: explicitly not', stats.visaNo));
  lines.push(row('security clearance', stats.clearance));
  lines.push(`| mean listing quality | ${(stats.qualitySum / done).toFixed(2)} | of 1.00 |`);
  lines.push('');

  const dist = (title, obj) => {
    lines.push(`## ${title}`, '', '| Value | Jobs | Share |', '| --- | --- | --- |');
    for (const [k, v] of rank(obj)) lines.push(row(k, v));
    lines.push('');
  };
  dist('Workplace', stats.workplace);
  dist('Seniority', stats.seniority);
  dist('Job function', stats.jobFunction);
  dist('Salary parse outcome', stats.salarySrc);
  dist('Degree requirement', stats.degree);

  lines.push('## Metros', '');
  lines.push(`${fmt(stats.metroCount.size)} distinct metros, of which ${fmt(stats.mintedCities.size)} were minted from city names not in the curated table.`, '');
  lines.push('| Metro | Jobs |', '| --- | --- |');
  for (const [metro, n] of top(stats.metroCount, 30)) lines.push(`| ${metro} | ${fmt(n)} |`);
  lines.push('');

  lines.push('## Unmatched location fragments', '');
  lines.push('Fragments that produced no metro. Each is a candidate alias — adding it to', '`METRO_GROUPS` and re-running costs seconds and needs no re-sweep.', '');
  const unmatched = top(stats.unmatched, 40);
  if (!unmatched.length) lines.push('_None._', '');
  else {
    lines.push('| Fragment | Occurrences |', '| --- | --- |');
    for (const [frag, n] of unmatched) lines.push(`| \`${frag}\` | ${fmt(n)} |`);
    lines.push('');
  }

  lines.push('## Also written', '');
  lines.push(`- \`job_metros\`: ${fmt(db.prepare('SELECT COUNT(*) n FROM job_metros').get().n)} rows`);
  lines.push(`- \`job_skills\`: ${fmt(db.prepare('SELECT COUNT(*) n FROM job_skills').get().n)} rows`);
  lines.push(`- \`metro_aliases\`: ${fmt(db.prepare('SELECT COUNT(*) n FROM metro_aliases').get().n)} rows`);
  lines.push(`- company display names filled from slug: ${fmt(named)}`);
  lines.push(`- full-text documents indexed: ${args.fts ? fmt(ftsRows) : 'skipped (--no-fts)'}`);
  lines.push('');

  const consoleLines = [
    '',
    `  workplace known     ${pct(done - known(stats.workplace, 'unknown'), done).padStart(6)}   (onsite ${fmt(known(stats.workplace, 'onsite'))} · hybrid ${fmt(known(stats.workplace, 'hybrid'))} · remote ${fmt(known(stats.workplace, 'remote'))})`,
    `  metro assigned      ${pct(done - stats.noMetro, done).padStart(6)}   ${fmt(stats.metroCount.size)} distinct metros`,
    `  salary in USD/yr    ${pct(stats.salaryKnown, done).padStart(6)}`,
    `  years parsed        ${pct(stats.yearsKnown, done).padStart(6)}`,
    `  seniority known     ${pct(classified, done).padStart(6)}`,
    `  company names       ${fmt(named)} filled from slug`,
  ].join('\n');

  return { markdown: lines.join('\n'), console: consoleLines };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
