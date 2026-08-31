# The daily run and automation

What `npm run daily` does, how the two schedulers (macOS launchd and GitHub Actions) split the work so that exactly one process writes each file, and how a push to `main` becomes a deploy. Measurements below were taken 2026-08-15 to 2026-08-24 unless a later date is given; the live counts are on the site.

## The daily run

```bash
npm run daily                              # sync → verify → sweep → derive → enrich → diff
npm run daily -- --report-only             # skip the pipeline, just re-report
npm run daily -- --skip-sync               # or --skip-verify / --skip-sweep / --skip-derive
npm run daily -- --profiles=nyc-entry-level
npm run daily -- --since=2026-08-18        # override what "new" means
npm run daily -- --limit=25 --quiet --db=<path>
```

`src/daily.mjs` runs the pipeline stages in order and then the diff:

| stage | what runs |
| --- | --- |
| Sync slugs | `sync-slugs.mjs` — pull every upstream company list, dedupe, write `data/slugs/` |
| Verify new ashby / greenhouse / lever / workday slugs | `probe-boards.mjs --ats=<ats> --only-unknown`, once per ATS |
| Sweep ashby / greenhouse / lever / workday boards | `sweep.mjs --ats=<ats>`, once per ATS |
| Normalize | `derive.mjs --only-new` |
| Read company sectors | `enrich-companies.mjs --only-new` — one model call per company the sweep found; one line and a clean exit with no API key |

The daily ATS list (`DAILY_ATSES`) is **Ashby, Greenhouse, Lever and Workday**; Lever was added on 2026-08-24 and Workday on 2026-08-27, each having previously been swept only by `npm run sweep`. All four are verified and swept every day rather than alternating: a full Greenhouse content sweep moves ~2.7 GB, which would be a real reason to alternate, except that the sweeper sends `If-None-Match` and an unchanged board answers 304 with a zero-byte body, so repeat runs cost almost nothing in transfer. Lever ignores `If-None-Match` and sends every board in full — about 930 MB and two minutes a night at 2,611 boards — which is the price of not serving a third of the corpus days stale. Workday is the expensive one — one request per job on the first backfill, 5h45m for 5,747 boards — but a repeat run pays only for the list pages and a detail request per *new* posting, because the adapter declares `hydrates` and the sweeper skips the detail request for every job whose description is already stored; the first repeat run, on 2026-08-27, ran at Workday's measured ceiling of ~22 requests a second for 1h58m and covered 5,057 of the 5,747 boards before it was stopped. Most of those requests were details rather than list pages: it recovered 220 boards — 97,006 jobs, Airbus, CVS Health and JLL among them — that had answered 429 during the backfill, and found some 16,000 genuinely new postings on the rest. A day's churn alone is about 37,000 list pages plus a detail request per new posting, which at that ceiling is around 40 minutes. If that ever stops being affordable, splitting the ATSes across days is the lever. Sweep behaviour, conditional GET and per-ATS timings are in [pipeline.md](./pipeline.md).

`--skip-verify` and `--skip-sweep` skip the stage for every ATS, which is what someone typing them means.

Each stage runs as its own process rather than being imported. A sweep that dies on a network error must not take the derive pass or the report with it; a failed stage is recorded and the run continues, so a flaky upstream produces a report with a gap in it and a `**failed**` row rather than no report. Each script already reports its own progress to `progress/state.json`.

**What it reports on.** With no `--profiles`, the run covers the profiles that name an [`owner`](./filtering.md#whose-profile-is-it--owner) — somebody's standing job search — and falls back to every profile in the directory when nothing is owned, which is what a fresh clone sees. `profiles/recent-openings.json`, the starter the app boots strangers into, matches a third of the corpus, and reporting on it every morning would bury the section that matters.

**What the report says.** A profile matching 221 jobs is worth reading once; re-reading it every morning is not. What changed overnight is a handful of postings, so `data/daily-report.md` leads with **what appeared since the previous run** and keeps the standing list as a footnote. It opens with the pipeline table (stage, result, time), then "what moved" — jobs that appeared or reappeared, jobs whose content hash moved, jobs that stopped being listed — then one section per profile with the new matches and the standing total. `data/daily-history.jsonl` gets one line per run, appended forever: open jobs, new / changed / gone counts, every stage's outcome and duration, and each profile's new and standing counts. It is the record of how much this actually moves day to day, which is the only way to tell whether a daily cadence is the right one.

**Where "new" comes from.** Ashby and Lever publish no `updatedAt`, so none of this is a timestamp comparison: it comes from `job_events`, which the sweep writes one row per job per day it appeared, changed, reappeared or vanished. An *edited* posting is detected by the content hash. The diff runs the new ids back through the ordinary filter engine, with the id set restricted, rather than reimplementing the criteria — so "new and matching my filters" cannot drift from "matching my filters".

**The watermark.** "New" means everything since the previous daily run (`last_daily_day` in the database's `meta` table), or since the last sweep on a first run. Only a run that actually swept advances it. `--report-only` and an explicit `--since` are ways of *looking* at the diff, and a look must not consume the window — otherwise re-reading this morning's report would be enough to make tomorrow's say "nothing new".

**Runs so far**, from `data/daily-history.jsonl`. The first entry was taken when the event log held a single sweep day, so every open job counted as new; the diff has been meaningful from the second run onwards, and the report said so itself rather than reading as a spectacular morning.

| run (UTC) | corpus | since | new | edited | gone | stages | profile: new / standing |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-08-22 (report only) | 61,213 | 2026-08-15 | 61,213 | 0 | 0 | — | nyc-entry-level: 221 (+232 aside) / 221 |
| 2026-08-22 (report only, after Greenhouse) | 265,698 | 2026-08-22 | 204,485 | 0 | 0 | — | 443 / 656 |
| 2026-08-23 | 337,925 | 2026-08-23 | 5,686 | 5,615 | 5,175 | sync **failed** (1.2 s) · verify 0.1 s + 0.1 s · sweep ashby 7,324 s · sweep greenhouse 2,709 s · derive 238 s | 25 / 708 |
| 2026-08-24 | 337,888 | 2026-08-23 | 8,340 | 7,361 | 7,795 | sync skipped · verify 0.2 s + 0.3 s · sweep ashby 9,430 s · sweep greenhouse 10,567 s · derive 437 s | 31 / 708 |

The 2026-08-23 sync failure is the run that exposed the two-runner conflict described below: the laptop failed every fetch to `raw.githubusercontent.com` while the GitHub runner got all of them. From 2026-08-24 the laptop runs with `--skip-sync`. Stage times are wall-clock as the run recorded them on the laptop; the isolated sweep timings are in [pipeline.md](./pipeline.md).

## Automation

```bash
npm run schedule                       # write the launchd and Actions files, install nothing
npm run schedule -- --at=08:15         # local time for the launchd job (default 08:15)
npm run schedule -- --install          # macOS launchd, explicit opt-in, asks first
npm run schedule -- --status           # is the launchd job loaded?
npm run schedule -- --uninstall
```

`src/schedule.mjs` writes three files and schedules **nothing** until asked: `automation/com.jobfinder.daily.plist`, `automation/daily-local.sh` (what launchd actually runs), and `.github/workflows/daily.yml`. A background job that starts running because a script was executed once is the kind of surprise this project should not have. `--install` copies the plist to `~/Library/LaunchAgents/` and loads it; it is macOS-only, and on another platform the workflow is the answer.

### The two runners split the work

They started as a pick-one choice — launchd, GitHub Actions in the project's own repository, or a scheduled cloud agent (never written) — and for a while both of the first two were switched on. Each ran the whole pipeline every morning, each rewrote `data/slugs/` from its own sync, and the two answers disagreed by a few hundred slugs and ~76,000 lines of reordering — every day, forever. Neither was wrong; they were both doing the same job badly. The Actions run was also building a database it then threw away: restoring a cached copy (the 1.0 GB Ashby-only database of mid-August 2026), verifying, sweeping, deriving and reporting took 11+ minutes a day (with a 90-minute timeout) to produce a `jobs.db` that had nowhere to go, because the deployed site is fed from the laptop's `data/jobs.db` by hand with `deploy/upload-db.sh`. The only output of that job that outlived it was the slug commit at the bottom.

So each now does the half it is actually good at, and the rule that keeps them from fighting is **exactly one writer per file**:

| | GitHub Actions (`.github/workflows/daily.yml`) | launchd (`automation/daily-local.sh`) |
| --- | --- | --- |
| Owns | `data/slugs/` and `data/sync-report.md` | `data/jobs.db` |
| Runs | `node src/sync-slugs.mjs`, then commits the slug store as `job-finder-bot` and pushes | `git pull --ff-only`, then `node src/daily.mjs --quiet --skip-sync` |
| When | `15 8 * * *` — 08:15 UTC year-round; GitHub's cron has no timezone field, so it drifts relative to local time across daylight saving | 08:15 local (`--at`) |
| Needs a database | no — `sync-slugs.mjs` only reads upstream company lists and writes JSON. The one thing carried between runs is `data/sync-state.json`, restored by the `Restore the sync bookmarks` cache step (keyed `sync-state-`, rewritten every run) | yes; this is the only process that maintains it |
| Runs when the laptop is asleep | yes — and it has a reliable network | no — missed runs are dropped, not queued |
| Setup | commit and push the workflow; needs a GitHub repository | `npm run schedule -- --install`, one command, no account |
| Budget | `timeout-minutes: 30`; a few dozen conditional gets plus a few minutes of paging against the archive index servers, which answer slowly and retry on 503 | the full sweep; hours, see the run table above |
| Also | uploads `data/sync-report.md` as a workflow artifact, kept 30 days; `workflow_dispatch` for a manual run | logs to `data/daily.log`; `RunAtLoad` is false; `ProcessType Background`, `LowPriorityIO` |

Turning the sync back on locally, or the sweep back on in CI, re-creates the conflict.

Slug stores are small and worth keeping in git — they are the part that accumulates, and a diff on them shows which sources moved. The Actions commit is the one the laptop fast-forwards to before its own sweep, so it sweeps the slugs GitHub found this morning rather than last week's. `data/sync-state.json` is gitignored runtime state and is not in the commit; it rides between Actions runs in the cache instead, keyed `sync-state-<run id>` so each run rewrites it and `restore-keys` hands the newest one to the next. That is what stops a runner starting blind every morning — re-downloading every file it already has, re-reading Common Crawl indexes it has already read, and measuring the Wayback window from the seed date rather than from yesterday. A cache miss is safe, just slower: a missing validator reads as a first run, and the Wayback lookback is floored at 90 days so the query can never widen into the 504 the CDX server answers with on a window that big.

`--ff-only` is the whole safety argument for the pull. It fast-forwards or it fails; it will not merge, will not rebase, will not touch an edited file, and cannot leave the working tree half-resolved at 08:15 while nobody is looking. A failure is expected whenever there are local commits or the network is down, so it is logged ("could not fast-forward — sweeping with what is on disk") and stepped over rather than aborting the sweep, which is the part of the morning that matters. Both interpolated paths in the wrapper are quoted, and that is not decoration: the project directory has spaces in its name, and an unquoted path reaches node as three arguments and fails every morning with a confusing "Cannot find module".

`launchd` dropping missed runs is the right behaviour here: the sweep is a full refresh, not an increment, so catching up on three skipped mornings would do the same work three times for the same answer; a missed morning costs nothing but a day of diff granularity.

**State as of 2026-08-24.** The launchd job `com.jobfinder.daily` is installed and loaded on the machine that holds `data/jobs.db`, and the Actions workflow has been committing `daily: slug refresh <date>` to `main` each morning since 2026-08-23.

### Deploy on push

`.github/workflows/deploy.yml` deploys to Fly on every push to `main` that changes something the image ships. Before it existed, `git push` and `fly deploy` were two separate things to remember, and forgetting the second is how the live site ended up two hours ahead of GitHub while the repository sat on stale code. Now the push is the deploy.

The paths filter is the interesting part. Not because of the bot — its daily slug commits are pushed with the workflow's own `GITHUB_TOKEN`, and GitHub creates no workflow runs from those, so they could never deploy — but because a README, docs or notes push should not rebuild and restart the machine to ship a byte-identical container. The workflow lists what the Dockerfile actually copies (`src/**`, `app/**`, `profiles/**`, `deploy/**`, `package.json`, `package-lock.json`, `Dockerfile`, `.dockerignore`) plus the two files that describe the machine (`fly.toml`, the workflow itself), and ignores everything else. Adding a `COPY` to the Dockerfile means adding its source here too.

The steps are checkout, Node 24, `npm ci`, **`npm test`**, then `flyctl deploy --remote-only` with `FLY_API_TOKEN` from the repository secrets. The test run is the gate: every test is self-contained — no network, no API key, no `jobs.db` — so it costs about a minute and is the only thing standing between a bad commit and the public URL. `--remote-only` builds on Fly's builder rather than needing Docker on the runner; the context is ~5 MB after `.dockerignore`, so the upload is trivial.

One deploy runs at a time (`concurrency: deploy-fly`, `cancel-in-progress: false`). Two overlapping `fly deploy` runs against a single machine race over which image it ends on, and the loser wins about half the time. Superseded deploys are queued rather than cancelled: a superseded deploy is still a correct intermediate state, and cancelling mid-release is how a machine gets stranded.

The database is not part of a deploy and never has been. It lives on the Fly volume at `/data` and is uploaded by hand with `deploy/upload-db.sh`, which `VACUUM INTO`s a compact copy (the working database is never modified or write-locked), gzips it (~3.3 GB → ~865 MB), uploads it with `fly sftp put`, unpacks it and restarts. A deploy replaces the code around it and leaves the database, the accounts and the saved profiles exactly where they are. The full setup — app name, region, volume, secrets, machine size — is in [deploy.md](./deploy.md).
