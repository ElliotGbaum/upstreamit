#!/bin/sh
# Written by `node src/schedule.mjs` — edit that, not this.
#
# launchd runs this, not node directly, so the repo can be fast-forwarded
# first. See the header of src/schedule.mjs for why the sync is skipped.
set -u
cd "/Users/elliotgreenbaum/Job Finder ATS" || exit 1

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

exec "/usr/local/bin/node" "/Users/elliotgreenbaum/Job Finder ATS/src/daily.mjs" --quiet --skip-sync
