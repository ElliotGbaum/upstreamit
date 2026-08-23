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
 * two and installs nothing unless asked — a background job that starts running
 * because a script was executed once is the kind of surprise this project
 * should not have.
 *
 * **The two runners are not alternatives any more. They split the work.**
 * They used to be a pick-one, and for a while both were switched on: each ran
 * the whole pipeline every morning, each rewrote `data/slugs/` from its own
 * sync, and the two answers disagreed by a few hundred slugs and ~76,000 lines
 * of reordering — every day, forever. Neither was wrong; they were just both
 * doing the same job badly. So each now does the half it is actually good at:
 *
 *   GitHub Actions   syncs the slug store and commits it. Nothing else. It has
 *                    a reliable network — the run that exposed this had the
 *                    laptop failing every fetch to raw.githubusercontent.com
 *                    while the runner got all of them, 109 slugs' worth — and
 *                    it runs whether the laptop is awake or not. Seconds, not
 *                    the 11+ minutes the full pipeline cost it.
 *   launchd          sweeps, derives and reports, with `--skip-sync`. It is
 *                    the only one of the two that maintains `data/jobs.db`,
 *                    which is the database the deployed site is fed from by
 *                    `deploy/upload-db.sh`, so this half has to be here. It
 *                    fast-forwards the repo first so it sweeps the slugs
 *                    GitHub found this morning rather than last week's.
 *
 * The rule that keeps them from fighting: **exactly one writer per file.**
 * GitHub owns `data/slugs/`; the laptop owns `data/jobs.db`. Turning the sync
 * back on locally, or the sweep back on in CI, re-creates the conflict.
 *
 * `launchd` misses runs when the machine is asleep rather than queueing them.
 * That is the right behaviour here: the sweep is a full refresh, not an
 * increment, so a missed morning costs nothing but a day of diff granularity.
 */

import { writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LABEL = 'com.jobfinder.daily';
const PLIST_SRC = join(ROOT, 'automation', `${LABEL}.plist`);
const PLIST_DEST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const WRAPPER = join(ROOT, 'automation', 'daily-local.sh');
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
    <string>/bin/sh</string>
    <string>${join(ROOT, 'automation', 'daily-local.sh')}</string>
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

/**
 * What launchd actually runs.
 *
 * A wrapper rather than `node src/daily.mjs` directly, for one reason: the
 * pipeline has to fast-forward the repo before it sweeps. GitHub Actions owns
 * `data/slugs/` now (see the header), so without a pull this machine would
 * sweep whatever slug store it last saw and quietly drift further behind every
 * morning.
 *
 * `--ff-only` is the whole safety argument. It fast-forwards or it fails; it
 * will not merge, will not rebase, will not touch a file you have edited, and
 * cannot leave the working tree half-resolved at 08:15 while nobody is looking.
 * A failure is fine and expected — you have local commits, or the network is
 * down — so it is logged and stepped over rather than aborting the sweep, which
 * is the part of the morning that matters.
 *
 * `--skip-sync` is the other half of the split: syncing here is what used to
 * fight with the workflow.
 *
 * Both interpolated paths are quoted, and that is not decoration: this project
 * lives in `~/Job Finder ATS`, so an unquoted `${ROOT}/src/daily.mjs` reaches
 * node as the three arguments `.../Job`, `Finder` and `ATS/src/daily.mjs`, and
 * the job fails every morning with a confusing "Cannot find module .../Job".
 */
function wrapper() {
  return `#!/bin/sh
# Written by \`node src/schedule.mjs\` — edit that, not this.
#
# launchd runs this, not node directly, so the repo can be fast-forwarded
# first. See the header of src/schedule.mjs for why the sync is skipped.
set -u
cd "${ROOT}" || exit 1

echo ""
echo "=== daily $(date '+%Y-%m-%d %H:%M:%S') ==="

# Fast-forward only. Never merges, never rebases, never touches an edited file.
# Expected to fail whenever there is local work; that is not a reason to skip
# the sweep, so the failure is noted and the run continues.
if /usr/bin/git pull --ff-only --quiet 2>&1; then
  echo "slug store: up to date with origin"
else
  echo "slug store: could not fast-forward (local commits, or offline) — sweeping with what is on disk"
fi

exec "${process.execPath}" "${join(ROOT, 'src', 'daily.mjs')}" --quiet --skip-sync
`;
}

function workflow({ hour, minute }) {
  // GitHub cron is UTC with no timezone support, so the comment has to say so
  // or the job silently drifts by an hour twice a year.
  return `# Daily slug refresh.
#
# Written by \`node src/schedule.mjs\`. GitHub's cron is **UTC only** — there is
# no timezone field — so this fires at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} UTC year-round and drifts
# relative to local time across daylight saving. Adjust the minute/hour here if
# that matters.
#
# **This syncs the slug store and nothing else.** It used to run the whole
# pipeline — restore a cached database, verify, sweep, derive, report — which
# took 11+ minutes a day to build a database that was thrown away at the end of
# the run. It was thrown away because it never had anywhere to go: the deployed
# site is fed from \`data/jobs.db\` on the laptop, by hand, with
# \`./deploy/upload-db.sh\`. The only output of this job that outlived it was
# the slug commit at the bottom, and meanwhile the laptop's own daily run was
# syncing the same slugs to a different answer and fighting this one for the
# file every morning.
#
# So: this owns \`data/slugs/\`, and the laptop's launchd job runs with
# \`--skip-sync\` and owns \`data/jobs.db\`. One writer per file. See the header
# of src/schedule.mjs.
#
# No database is needed here at all — \`sync-slugs.mjs\` only reads upstream
# company lists and writes JSON — so there is no cache step and nothing to
# restore.
name: daily

on:
  schedule:
    - cron: "${minute} ${hour} * * *"
  workflow_dispatch:

permissions:
  contents: write

jobs:
  slugs:
    runs-on: ubuntu-latest
    # Minutes, not the 90 the full pipeline needed. This is a few dozen HTTP
    # gets against raw.githubusercontent.com and a handful of JSON writes.
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "24"

      - name: Sync the slug store
        run: node src/sync-slugs.mjs

      # Slug stores are small and worth keeping in git — they are the part that
      # accumulates, and a diff on them shows which sources moved. This is the
      # commit the laptop fast-forwards to before its own sweep.
      #
      # \`data/sync-state.json\` is deliberately not in the add list: it is
      # gitignored runtime state, so adding it was always a no-op.
      - name: Commit the slug store
        run: |
          git config user.name  "job-finder-bot"
          git config user.email "job-finder-bot@users.noreply.github.com"
          git add data/slugs data/sync-report.md || true
          git diff --staged --quiet || git commit -m "daily: slug refresh $(date -u +%F)"
          git push || true

      - name: Upload the sync report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: sync-report
          path: data/sync-report.md
          retention-days: 30
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
  writeFileSync(WRAPPER, wrapper());
  // The plist hands this to /bin/sh by name, which does not need the execute
  // bit — but `./automation/daily-local.sh` from a terminal does, and someone
  // debugging a morning that went wrong will type exactly that.
  chmodSync(WRAPPER, 0o755);
  writeFileSync(WORKFLOW, workflow(args));

  console.log('');
  console.log(`  wrote  ${PLIST_SRC.replace(`${ROOT}/`, '')}      (macOS launchd, ${args.at} local)`);
  console.log(`  wrote  ${WRAPPER.replace(`${ROOT}/`, '')}           (what launchd runs: pull, then sweep)`);
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

  console.log('  Nothing has been scheduled. These two halves are meant to run together:');
  console.log('');
  console.log('  1. GitHub Actions — syncs the slug store and commits it, laptop or no laptop:');
  console.log('      git add .github/workflows/daily.yml && git commit && git push');
  console.log('');
  console.log(`  2. macOS launchd — sweeps and reports against your local database, ${args.at} local:`);
  console.log(`      npm run schedule -- --install --at=${args.at}`);
  console.log('');
  console.log('  Either alone is fine. What is not fine is putting the sync back into the');
  console.log('  local run: both would then write data/slugs/ and disagree every morning.');
  console.log('');
  console.log('  Or neither — `npm run daily` does the same work on demand.');
  console.log('');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
