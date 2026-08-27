#!/usr/bin/env node
/**
 * The daily run.
 *
 *   node src/daily.mjs                       # the whole pipeline, then the diff
 *   node src/daily.mjs --report-only         # skip the pipeline, just re-report
 *   node src/daily.mjs --skip-sync           # (or --skip-verify/-sweep/-derive)
 *   node src/daily.mjs --profiles=nyc-entry-level
 *   node src/daily.mjs --since=2026-08-18    # override what "new" means
 *
 * sync slugs → verify the new ones → sweep the boards → derive → diff.
 *
 * The output that matters is the last step. A profile that matches 221 jobs is
 * worth reading once; re-reading it every morning is not. What changed overnight
 * is a handful of postings, and that handful is the deliverable — so the report
 * leads with what appeared since the previous run and keeps the full standing
 * list as a footnote.
 *
 * Each stage runs as its own process rather than being imported. That is
 * deliberate: a sweep that dies on a network error must not take the derive pass
 * or the report with it, and each script already reports its own progress to
 * `progress/state.json`. A failed stage is recorded and the run continues, so a
 * flaky upstream produces a report with a gap in it rather than no report.
 */

import { spawn } from 'node:child_process';
import { writeFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDb, getMeta, setMeta } from './lib/db.mjs';
import { search, corpusMeta, invalidateIndex } from './lib/filter/index.mjs';
import { newSince, changedSince, goneSince, activity, day } from './lib/filter/diff.mjs';
import { listProfiles, loadProfile } from './find.mjs';
import { logEvent } from './lib/progress.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = join(ROOT, 'data', 'daily-report.md');
const HISTORY = join(ROOT, 'data', 'daily-history.jsonl');

/**
 * The ATSes the daily run maintains, in order.
 *
 * All four are verified and swept every day rather than alternating. Ashby
 * and Greenhouse honour `If-None-Match`, so an unchanged board answers 304
 * with a zero-byte body and a repeat run costs almost nothing in transfer.
 * Lever ignores it and sends every board in full — about 930 MB and two
 * minutes a night, measured at 2,611 boards — which is the price of not
 * serving a third of the corpus days stale.
 *
 * Workday, added 2026-08-27, is the expensive one and the one that most
 * needs to be daily: it is two thirds of the corpus. Its first backfill cost
 * one request per job and ran 5h45m, but a repeat run pays only for the list
 * pages plus a detail request per *new* posting, because the adapter
 * declares `hydrates` and the sweeper hands it the jobs whose descriptions
 * are already stored. The first repeat run, fifteen hours after the
 * backfill, ran at Workday's measured ceiling of ~22 requests a second for
 * 1h58m and covered 5,057 of the 5,747 boards before it was stopped. Most
 * of those requests were details, not list pages: it recovered 220 boards,
 * 97,006 jobs, that had answered 429 during the backfill, and found some
 * 16,000 genuinely new postings on the rest. A day's churn alone is about
 * 37,000 list pages plus a detail request per new posting, which at that
 * ceiling is around 40 minutes. If that ever stops being affordable,
 * splitting the ATSes across days is the lever.
 */
const DAILY_ATSES = ['ashby', 'greenhouse', 'lever', 'workday'];

// The `key` is what `--skip-verify` / `--skip-sweep` match on, so the per-ATS
// stages deliberately share one — skipping a phase skips it for every ATS,
// which is what someone typing `--skip-sweep` means.
const STAGES = [
  { key: 'sync', label: 'Sync slugs', script: 'sync-slugs.mjs', args: [] },
  ...DAILY_ATSES.map((ats) => ({
    key: 'verify',
    label: `Verify new ${ats} slugs`,
    script: 'probe-boards.mjs',
    args: [`--ats=${ats}`, '--only-unknown'],
  })),
  ...DAILY_ATSES.map((ats) => ({
    key: 'sweep',
    label: `Sweep ${ats} boards`,
    script: 'sweep.mjs',
    args: [`--ats=${ats}`],
  })),
  { key: 'derive', label: 'Normalize', script: 'derive.mjs', args: ['--only-new'] },
];

function parseArgs(argv) {
  const args = { skip: new Set(), profiles: null, since: null, reportOnly: false, limit: 25, db: undefined, quiet: false };
  for (const arg of argv.slice(2)) {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
    if (key.startsWith('skip-')) args.skip.add(key.slice(5));
    else if (key === 'report-only') args.reportOnly = true;
    else if (key === 'profiles') args.profiles = value.split(',').map((s) => s.trim()).filter(Boolean);
    else if (key === 'since') args.since = value;
    else if (key === 'limit') args.limit = Number(value);
    else if (key === 'quiet') args.quiet = true;
    else if (key === 'db') args.db = value;
    else {
      console.error(`Unknown flag --${key}`);
      process.exit(2);
    }
  }
  return args;
}

/** Run one pipeline stage. Never throws — a bad stage is data, not a crash. */
function runStage(stage, { quiet }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [join(ROOT, 'src', stage.script), ...stage.args], {
      cwd: ROOT,
      stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let tail = '';
    if (quiet) {
      const collect = (chunk) => {
        tail = (tail + chunk).slice(-2000);
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
    }
    child.on('error', (err) => resolve({ ...stage, ok: false, ms: Date.now() - started, error: err.message }));
    child.on('close', (code) =>
      resolve({ ...stage, ok: code === 0, code, ms: Date.now() - started, error: code === 0 ? null : tail.trim() || `exit ${code}` }),
    );
  });
}

const fmt = (n) => Number(n ?? 0).toLocaleString('en-US');
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

/**
 * Which profiles the daily report covers when nobody said.
 *
 * The ones somebody owns, if anybody owns any — otherwise all of them.
 *
 * `profiles/` holds two kinds of document now. A profile with an `owner` is a
 * person's standing job search, and "what appeared overnight that matches it"
 * is exactly what this report is for. `profiles/recent-openings.json` is the
 * starter the app boots strangers into: no keywords, no city, a third of the
 * corpus. Reporting on it every morning would bury the section that matters
 * under a section that matches nothing in particular.
 *
 * A fresh clone owns nothing, and there the starter is the only saved search
 * there is — so it is reported on, and the rule costs that setup nothing.
 * `--profiles=` overrides all of it.
 */
function reportOn() {
  const all = listProfiles();
  const owned = all.filter((p) => p.owner);
  return owned.length ? owned : all;
}


async function main() {
  const args = parseArgs(process.argv);
  const startedAt = Date.now();

  // What "new" means: everything since the previous daily run, or since the
  // last sweep on a first run. Read before the pipeline moves it.
  let db = openDb(args.db);
  const previousRun = getMeta(db, 'last_daily_day', null);
  db.close();

  const stages = [];
  if (!args.reportOnly) {
    for (const stage of STAGES) {
      if (args.skip.has(stage.key)) {
        stages.push({ ...stage, ok: true, skipped: true, ms: 0 });
        continue;
      }
      console.log(`\n── ${stage.label} ────────────────────────────────────`);
      const result = await runStage(stage, args);
      stages.push(result);
      if (!result.ok) console.error(`  ! ${stage.label} failed: ${result.error}`);
    }
  }

  // Reopened after the pipeline so the diff reads what the sweep just wrote.
  db = openDb(args.db);
  invalidateIndex();

  const since = args.since ?? previousRun ?? 'last-sweep';
  const fresh = newSince(db, since);
  const edited = changedSince(db, since);
  const gone = goneSince(db, since);

  const names = args.profiles ?? reportOn().map((p) => p.name);
  const reports = [];
  for (const name of names) {
    let data;
    try {
      data = loadProfile(name).data;
    } catch (err) {
      reports.push({ name, error: err.message });
      continue;
    }
    // The diff runs through the ordinary engine with the id set restricted, so
    // "new and matching my filters" cannot drift from "matching my filters".
    const newMatches = search(db, data, { restrictTo: fresh.ids, limit: args.limit, facets: false });
    const standing = search(db, data, { limit: 0, facets: false });
    reports.push({
      name,
      label: newMatches.profile.label ?? name,
      new: newMatches,
      standing: { total: standing.total, aside: standing.aside_total },
      warnings: [...new Set([...newMatches.warnings, ...standing.warnings])],
    });
  }

  const meta = corpusMeta(db);
  const today = day(startedAt);
  // Only a run that actually swept moves the watermark. `--report-only` and an
  // explicit `--since` are ways of *looking* at the diff, and a look should not
  // consume the window — otherwise re-reading this morning's report is enough to
  // make tomorrow's say "nothing new".
  const advances = !args.reportOnly && args.since == null;
  if (advances) {
    setMeta(db, 'last_daily', String(startedAt));
    setMeta(db, 'last_daily_day', today);
  }

  const markdown = buildReport({ startedAt, stages, since: fresh, edited, gone, reports, meta, db, args });
  writeFileSync(REPORT, markdown);

  // One line per run, appended forever — the record of how much this actually
  // moves day to day, which is the only way to tell whether a daily cadence is
  // the right one.
  appendFileSync(
    HISTORY,
    `${JSON.stringify({
      at: startedAt,
      day: today,
      since: fresh.from,
      open_jobs: meta.open,
      new_jobs: fresh.ids.size,
      changed_jobs: edited.ids.size,
      gone_jobs: gone.rows.length,
      stages: stages.map((s) => ({ key: s.key, ok: s.ok, skipped: Boolean(s.skipped), ms: s.ms })),
      profiles: reports.map((r) => ({
        name: r.name,
        new: r.new?.total ?? null,
        new_aside: r.new?.aside_total ?? null,
        standing: r.standing?.total ?? null,
      })),
    })}\n`,
  );

  console.log(printSummary({ stages, since: fresh, edited, gone, reports, startedAt }));
  console.log(`  Full report → data/daily-report.md\n`);
  logEvent(
    `daily: ${fmt(fresh.ids.size)} new jobs since ${fresh.from} · ` +
      reports.map((r) => `${r.name} +${r.new?.total ?? '?'}`).join(' · '),
    stages.every((s) => s.ok) ? 'ok' : 'warn',
  );
  db.close();
}

function buildReport({ startedAt, stages, since, edited, gone, reports, meta, db, args }) {
  const lines = [];
  lines.push('# Daily run', '');
  lines.push(`${new Date(startedAt).toISOString()} · corpus ${fmt(meta.open)} open jobs from ${fmt(meta.boards_live)} live boards`, '');

  if (stages.length) {
    lines.push('## Pipeline', '', '| Stage | Result | Time |', '| --- | --- | --- |');
    for (const stage of stages) {
      const verdict = stage.skipped ? 'skipped' : stage.ok ? 'ok' : `**failed** — ${String(stage.error).split('\n').pop()}`;
      lines.push(`| ${stage.label} | ${verdict} | ${stage.skipped ? '—' : secs(stage.ms)} |`);
    }
    lines.push('');
  } else {
    lines.push('_Report only — the pipeline was not run._', '');
  }

  lines.push('## What moved', '');
  lines.push(`Comparing against **${since.from}** (latest sweep day: ${since.latest}).`, '');
  lines.push('| | Jobs |', '| --- | --- |');
  lines.push(`| appeared or reappeared | ${fmt(since.ids.size)} |`);
  lines.push(`| edited (content hash moved) | ${fmt(edited.ids.size)} |`);
  lines.push(`| stopped being listed | ${fmt(gone.rows.length)} |`);
  lines.push('');
  if (since.from === since.latest && since.ids.size === meta.open) {
    // Worth saying rather than letting it read as a spectacular day.
    lines.push(
      '> Every open job counts as new because the event log holds a single sweep day. ' +
        'The diff becomes meaningful from the second run onwards.',
      '',
    );
  }

  for (const report of reports) {
    lines.push(`## ${report.label ?? report.name}`, '');
    if (report.error) {
      lines.push(`_Could not run: ${report.error}_`, '');
      continue;
    }
    lines.push(
      `**${fmt(report.new.total)} new** matching this profile` +
        (report.new.aside_total ? `, plus ${fmt(report.new.aside_total)} worth a look` : '') +
        ` · standing total ${fmt(report.standing.total)}` +
        (report.standing.aside ? ` + ${fmt(report.standing.aside)} aside` : ''),
      '',
    );
    for (const warning of report.warnings) lines.push(`> ! ${warning}`, '');

    if (!report.new.results.length && !report.new.aside.length) {
      lines.push('_Nothing new._', '');
      continue;
    }
    lines.push('| Job | Company | Where | Level | Salary | Why |', '| --- | --- | --- | --- | --- | --- |');
    for (const row of report.new.results) lines.push(rowLine(row));
    lines.push('');
    if (report.new.aside.length) {
      lines.push('<details><summary>Worth a look — new, but we could not classify them</summary>', '');
      lines.push('| Job | Company | Where | Level | Salary | Why |', '| --- | --- | --- | --- | --- | --- |');
      for (const row of report.new.aside) lines.push(rowLine(row));
      lines.push('', '</details>', '');
    }
  }

  if (gone.rows.length) {
    lines.push('## Closed since the last run', '');
    lines.push('| Job | Company | Closed |', '| --- | --- | --- |');
    for (const row of gone.rows.slice(0, 50)) {
      lines.push(`| ${escape(row.title)} | ${escape(row.company_name ?? '')} | ${row.day} |`);
    }
    if (gone.rows.length > 50) lines.push('', `_…and ${fmt(gone.rows.length - 50)} more._`, '');
    lines.push('');
  }

  const days = activity(db, 14);
  if (days.length > 1) {
    lines.push('## Recent activity', '', '| Day | Appeared | Changed | Disappeared |', '| --- | --- | --- | --- |');
    for (const d of days) lines.push(`| ${d.day} | ${fmt(d.appeared)} | ${fmt(d.changed)} | ${fmt(d.disappeared)} |`);
    lines.push('');
  }

  lines.push('---', '');
  lines.push(`Profiles live in \`profiles/\`. Re-run one interactively with \`npm run find -- <name>\` or browse them at \`npm run serve\`.`, '');
  return lines.join('\n');
}

function rowLine(row) {
  const level = row.years_known
    ? `${row.min_years}${row.max_years ? `–${row.max_years}` : '+'} yrs`
    : (row.seniority ?? 'unknown');
  return (
    `| [${escape(row.title)}](${row.url ?? '#'}) | ${escape(row.company ?? '')} | ` +
    `${(row.metros ?? []).join(', ') || '—'} · ${row.workplace} | ${level} | ${row.salary_label ?? '—'} | ` +
    `${escape((row.title_hits ?? []).join(', '))} |`
  );
}

/** Markdown table cells cannot contain a bare pipe or newline. */
const escape = (text) => String(text ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

function printSummary({ stages, since, edited, gone, reports, startedAt }) {
  const lines = ['', `  Daily run · ${secs(Date.now() - startedAt)}`, ''];
  for (const stage of stages) {
    const mark = stage.skipped ? '·' : stage.ok ? '✓' : '✗';
    lines.push(`    ${mark} ${stage.label.padEnd(20)} ${stage.skipped ? 'skipped' : secs(stage.ms)}`);
  }
  if (stages.length) lines.push('');
  lines.push(`    since ${since.from}:  ${fmt(since.ids.size)} new · ${fmt(edited.ids.size)} edited · ${fmt(gone.rows.length)} closed`);
  lines.push('');
  for (const report of reports) {
    if (report.error) {
      lines.push(`    ${report.name.padEnd(24)} ! ${report.error}`);
      continue;
    }
    lines.push(
      `    ${report.name.padEnd(24)} ${String(fmt(report.new.total)).padStart(6)} new` +
        (report.new.aside_total ? ` (+${fmt(report.new.aside_total)} aside)` : '') +
        `   standing ${fmt(report.standing.total)}`,
    );
    for (const row of report.new.results.slice(0, 5)) {
      lines.push(`        · ${row.title} — ${row.company}`);
    }
  }
  return lines.join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

