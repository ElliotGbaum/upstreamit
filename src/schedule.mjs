#!/usr/bin/env node
/**
 * Phase 6 — automation setup.
 *
 *   node src/schedule.mjs                     # write both artifacts, print the how-to
 *   node src/schedule.mjs --at=08:15          # local time for the launchd job
 *   node src/schedule.mjs --status            # is the launchd job loaded?
 *   node src/schedule.mjs --install           # load it (macOS only, asks first)
 *   node src/schedule.mjs --uninstall
 *
 * PROJECT.md left the choice of runner open between macOS `launchd`, GitHub
 * Actions in your own repo, and a scheduled cloud agent. This writes the first
 * two — they are files, and files can sit in the repo unused — and installs
 * nothing unless asked. A background job that starts running because a script
 * was executed once is the kind of surprise this project should not have.
 *
 * The trade-off, since it decides which one you want:
 *
 *   launchd          runs only while this laptop is awake. Zero accounts, zero
 *                    setup, and the 1.0 GB database stays on your disk.
 *   GitHub Actions   runs whether the laptop is on or not, but the database has
 *                    to live somewhere the runner can reach — a 1.0 GB SQLite
 *                    file is past what a repo should carry, so the workflow
 *                    written here rebuilds from the sweep each run and uploads
 *                    the report as an artifact rather than committing the DB.
 *
 * `launchd` misses runs when the machine is asleep rather than queueing them.
 * That is the right behaviour here: the sweep is a full refresh, not an
 * increment, so a missed morning costs nothing but a day of diff granularity.
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LABEL = 'com.jobfinder.daily';
const PLIST_SRC = join(ROOT, 'automation', `${LABEL}.plist`);
const PLIST_DEST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const WORKFLOW = join(ROOT, '.github', 'workflows', 'daily.yml');

function parseArgs(argv) {
  const args = { at: '08:15', install: false, uninstall: false, status: false };
  for (const arg of argv.slice(2)) {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
    if (key === 'at') args.at = value;
    else if (key === 'install') args.install = true;
    else if (key === 'uninstall') args.uninstall = true;
    else if (key === 'status') args.status = true;
    else {
      console.error(`Unknown flag --${key}`);
      process.exit(2);
    }
  }
  const match = /^(\d{1,2}):(\d{2})$/.exec(args.at);
  if (!match) {
    console.error(`--at must look like 08:15, got "${args.at}"`);
    process.exit(2);
  }
  args.hour = Number(match[1]);
  args.minute = Number(match[2]);
  if (args.hour > 23 || args.minute > 59) {
    console.error(`--at=${args.at} is not a time of day`);
    process.exit(2);
  }
  return args;
}

function plist({ hour, minute }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>            <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${join(ROOT, 'src', 'daily.mjs')}</string>
    <string>--quiet</string>
  </array>
  <key>WorkingDirectory</key> <string>${ROOT}</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>   <integer>${hour}</integer>
    <key>Minute</key> <integer>${minute}</integer>
  </dict>
  <!-- Local time, and missed runs are dropped rather than queued: the sweep is
       a full refresh, so catching up on three skipped mornings at once would do
       the same work three times for the same answer. -->
  <key>RunAtLoad</key>        <false/>
  <key>StandardOutPath</key>  <string>${join(ROOT, 'data', 'daily.log')}</string>
  <key>StandardErrorPath</key><string>${join(ROOT, 'data', 'daily.log')}</string>
  <key>ProcessType</key>      <string>Background</string>
  <key>LowPriorityIO</key>    <true/>
</dict>
</plist>
`;
}

function workflow({ hour, minute }) {
  // GitHub cron is UTC with no timezone support, so the comment has to say so
  // or the job silently drifts by an hour twice a year.
  return `# Daily job sweep + diff.
#
# Written by \`node src/schedule.mjs\`. GitHub's cron is **UTC only** — there is
# no timezone field — so this fires at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} UTC year-round and drifts
# relative to local time across daylight saving. Adjust the minute/hour here if
# that matters.
#
# The 1.0 GB database is deliberately not committed. Each run rebuilds it from
# the sweep (24 seconds for 4,297 boards) and uploads the report; the cost of
# that is losing the \`job_events\` history that makes the diff meaningful, so
# the run restores the previous database from the last successful run's cache
# before sweeping.
name: daily

on:
  schedule:
    - cron: "${minute} ${hour} * * *"
  workflow_dispatch:

permissions:
  contents: write

jobs:
  sweep:
    runs-on: ubuntu-latest
    # A cold Greenhouse sweep measured 32.1 minutes on its own (8,272 boards,
    # 2.5 GB), so the old 30 was under the cost of a single stage and every
    # cache-miss run died partway through. Warm runs finish in minutes because
    # unchanged boards answer 304; this ceiling is sized for the cold one.
    timeout-minutes: 90
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "24"

      # The event log is the whole reason "what's new" works, and it only exists
      # inside the database. Restoring it means the diff compares against
      # yesterday rather than against an empty table.
      - name: Restore the job database
        uses: actions/cache/restore@v4
        with:
          path: data/jobs.db
          key: jobs-db-\${{ github.run_id }}
          restore-keys: |
            jobs-db-

      - name: Run the pipeline
        run: node src/daily.mjs --quiet

      - name: Save the job database
        if: always()
        uses: actions/cache/save@v4
        with:
          path: data/jobs.db
          key: jobs-db-\${{ github.run_id }}

      - name: Upload the report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: daily-report
          path: |
            data/daily-report.md
            data/derive-report.md
            data/sync-report.md
          retention-days: 30

      # Slug stores are small and worth keeping in git — they are the part that
      # accumulates, and a diff on them shows which sources moved.
      - name: Commit the slug store
        run: |
          git config user.name  "job-finder-bot"
          git config user.email "job-finder-bot@users.noreply.github.com"
          git add data/slugs data/sync-state.json data/sync-report.md data/daily-history.jsonl || true
          git diff --staged --quiet || git commit -m "daily: slug refresh $(date -u +%F)"
          git push || true
`;
}

/**
 * `stdio` is captured rather than inherited because `launchctl list <label>`
 * is also the "is it loaded?" probe, and its stderr on a miss ("Could not find
 * service …") would otherwise print above our own answer to the same question.
 */
function launchctl(...args) {
  return execFileSync('/bin/launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function isLoaded() {
  try {
    launchctl('list', LABEL);
    return true;
  } catch {
    return false;
  }
}

function main() {
  const args = parseArgs(process.argv);

  if (args.status) {
    if (process.platform !== 'darwin') return console.log('launchd status is macOS-only.');
    console.log(`  ${LABEL}: ${isLoaded() ? 'loaded' : 'not loaded'}`);
    console.log(`  plist installed: ${existsSync(PLIST_DEST) ? PLIST_DEST : 'no'}`);
    console.log(`  log: ${join(ROOT, 'data', 'daily.log')}`);
    return;
  }

  if (args.uninstall) {
    if (process.platform !== 'darwin') return console.log('launchd is macOS-only.');
    try {
      launchctl('bootout', `gui/${process.getuid()}/${LABEL}`);
      console.log(`  unloaded ${LABEL}`);
    } catch {
      console.log(`  ${LABEL} was not loaded`);
    }
    console.log(`  the plist is still at ${PLIST_DEST} — delete it to finish removing the job`);
    return;
  }

  mkdirSync(dirname(PLIST_SRC), { recursive: true });
  mkdirSync(dirname(WORKFLOW), { recursive: true });
  writeFileSync(PLIST_SRC, plist(args));
  writeFileSync(WORKFLOW, workflow(args));

  console.log('');
  console.log(`  wrote  ${PLIST_SRC.replace(`${ROOT}/`, '')}      (macOS launchd, ${args.at} local)`);
  console.log(`  wrote  ${WORKFLOW.replace(`${ROOT}/`, '')}   (GitHub Actions, ${args.at} UTC)`);
  console.log('');

  if (args.install) {
    if (process.platform !== 'darwin') {
      console.error('  --install is macOS-only. On another platform, use the GitHub Actions workflow.');
      process.exit(1);
    }
    mkdirSync(dirname(PLIST_DEST), { recursive: true });
    writeFileSync(PLIST_DEST, plist(args));
    if (isLoaded()) launchctl('bootout', `gui/${process.getuid()}/${LABEL}`);
    launchctl('bootstrap', `gui/${process.getuid()}`, PLIST_DEST);
    console.log(`  installed and loaded ${LABEL} — next run ${args.at} local`);
    console.log(`  log → data/daily.log · check with \`npm run schedule -- --status\``);
    console.log('');
    return;
  }

  console.log('  Nothing has been scheduled. Pick one:');
  console.log('');
  console.log('  macOS, local only — runs when the laptop is awake:');
  console.log(`      npm run schedule -- --install --at=${args.at}`);
  console.log('');
  console.log('  GitHub Actions — runs whether the laptop is on or not:');
  console.log('      git add .github/workflows/daily.yml && git commit && git push');
  console.log('      (the workflow rebuilds the database each run and uploads the report)');
  console.log('');
  console.log('  Or neither — `npm run daily` does the same work on demand.');
  console.log('');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
