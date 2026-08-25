# Data pipeline

How UpstreamIt's data pipeline runs: the slug sync, board verification, the sweep and the derive pass, with the flags each stage takes, the API behaviour the design depends on, and where the results are stored. Measurements below were taken 2026-08-11 to 2026-08-22 unless a later date is given; the live counts are on the site. On 2026-08-24 the corpus held 337,925 open jobs (343,173 rows including closed) on 12,138 live boards, 15,207 companies known, 24,337 metros, across three ATSes (Ashby, Greenhouse, Lever). Figures quoted from earlier in August, such as 61,213 jobs or 4,297 boards, are from the Ashby-only corpus and are kept as dated measurements.

Related: [sources](./sources.md) for the eleven upstream slug lists, [filtering](./filtering.md) for what the derived columns feed, [automation](./automation.md) for the daily run that chains these stages, and the [README](../README.md).

## The four stages

1. **sync** (`src/sync-slugs.mjs`) pulls company slugs from every configured source, normalizes and deduplicates them, and writes a per-ATS slug store under `data/slugs/`.
2. **verify** (`src/probe-boards.mjs`) sends a `HEAD` request per slug to the ATS's board API and records which slugs are real boards.
3. **sweep** (`src/sweep.mjs`) fetches every live board's postings, full descriptions included, into `data/jobs.db`.
4. **derive** (`src/derive.mjs`) turns the raw columns into the canonical `d_*` columns the filter engine reads. It is a pure function of what the sweep stored and never touches the network, so improving a metro alias or a seniority rule means re-running it, not re-sweeping.

Each stage is its own process. A stage that dies on a network error leaves the previous stage's output intact.

## Quick start

Every command below exists in `package.json`.

```bash
npm run sync           # pull every source, dedupe, write the slug store
npm run verify         # probe the slugs not yet resolved, all three ATSes
npm run verify:all     # re-probe every slug in the store
npm run sweep          # fetch every live board into data/jobs.db (ashby, greenhouse, lever)
npm run derive         # normalize into the d_* columns the filters read
npm run derive:new     # derive only the jobs a sweep has added since the last pass
npm run refresh        # sync → verify → sweep → derive
npm test               # 680 checks, about a second, no database and no network
```

Per-ATS variants: `npm run verify:ashby`, `verify:greenhouse`, `verify:lever`, `sweep:ashby`, `sweep:greenhouse`, `sweep:lever`.

Utilities:

```bash
npm run sync:dry       # do the sync work, write nothing
npm run sync:check     # report drift, write nothing, exit 1 if anything changed
npm run stats          # which sources are earning their place (node src/stats.mjs greenhouse for another ATS)
npm run db             # sqlite3 -readonly shell on data/jobs.db, box output preloaded from db-init.sql
npm run vacuum         # checkpoint the WAL and VACUUM data/jobs.db (stop the server first)
npm run progress       # static server for progress/index.html on :7788, separate from the app
```

The test count is 680: 132 derivation, 216 filter, 133 adapter, 92 account and 107 interpret checks, run by `npm test` in that order.

## Sync

```bash
node src/sync-slugs.mjs                   # everything
node src/sync-slugs.mjs --ats=ashby       # one ATS only
node src/sync-slugs.mjs --check           # report drift, write nothing, exit 1 if changed
node src/sync-slugs.mjs --dry-run         # do the work, write nothing
node src/sync-slugs.mjs --force           # ignore ETags, re-download everything
node src/sync-slugs.mjs --sources=a,b     # limit to specific source ids
node src/sync-slugs.mjs --prune-after=60  # drop slugs no source has vouched for in 60 days
```

Outputs, per ATS, under `data/slugs/`:

| File | What it is |
| --- | --- |
| `<ats>.json` | Canonical store. Per slug: which sources vouch for it, `first_seen`, `last_seen`. The only authority on provenance. |
| `<ats>.txt` | Every slug currently claimed by at least one source, verified or not. |
| `<ats>-live.txt` | Written by verify; the list the sweeper prefers. |
| `<ats>-verified.json` | Written by verify. Per-slug verdict (`exists` / `dead`), plus display name when fetched with `--with-names`. |
| `../sync-report.md` | What changed on the last run and which source contributed what. |
| `../sync-state.json` | ETag / Last-Modified validators per upstream file, so a re-run costs almost nothing (not committed). |

The sources themselves, and how a no-change poll is detected, are in [sources.md](./sources.md).

## Verify

One probe script serves every ATS, driven by each adapter's own `probeUrl()`. It replaced an earlier `probe-ashby.mjs` that hardcoded the Ashby endpoint and file paths.

```bash
node src/probe-boards.mjs --ats=greenhouse                 # HEAD every slug in the store
node src/probe-boards.mjs --ats=greenhouse --only-unknown  # only slugs added since the last run
node src/probe-boards.mjs --ats=greenhouse --sample=300    # quick estimate instead of a full pass
node src/probe-boards.mjs --ats=greenhouse --concurrency=8
node src/probe-boards.mjs --ats=ashby --with-names         # display names too (Ashby and Lever; slow)
```

Reads `data/slugs/<ats>.json`; writes `data/slugs/<ats>-verified.json` and `data/slugs/<ats>-live.txt`.

`HEAD` against the board endpoint returns the status with a zero-byte body: 200 is a real board, 404 is dead. A GET-based check would move gigabytes just to learn which slugs exist (OpenAI's Ashby board is about 12 MB; Stripe's Greenhouse board 4.4 MB). Verifying first is what keeps the sweep from paying for the roughly half of collected slugs that are dead.

Measured verification runs:

| ATS | Slugs probed | Live | Time | Concurrency | Errors |
| --- | --- | --- | --- | --- | --- |
| Ashby | 7,951 | 4,297 (54.0%) | about 2.5 min (about 55 slugs/s) | 10 | no 429s |
| Greenhouse | 15,197 | 8,272 (54.4%) | 3.7 min | 8 | 0 |
| Lever | 8,721 | 2,611 (29.9%) | 4.1 min | 16 | 0 |

Seven Lever slugs in ten were dead, and of the 2,611 that survived, 586 were live boards with no open roles, so the Lever sweep found jobs on 2,025 boards.

**`dead` and `empty` are different things.** A company between hiring rounds returns `200` with zero jobs; a bad slug returns `404`. Conflating them would delete real companies, so only a `404` marks a slug dead. `sweep.mjs` records a live board with no roles as `empty`.

The Ashby display-name pass (`--with-names`) is an optional adapter capability rather than a step every ATS runs, because Greenhouse puts `company_name` on every job and needs none of it. See the Ashby facts below for why it runs at concurrency 2.

### Slug coverage

Measured mid-August 2026, before the sweep was extended past Ashby:

| ATS | Slugs collected | Verified live | Swept |
| --- | --- | --- | --- |
| **ashby** | **7,951** | **4,297** (54.0%) | yes |
| **greenhouse** | **15,197** | **8,272** (54.4%) | yes |
| **lever** | **8,721** | **2,611** (29.9%) | yes |
| workday | 12,884 | not yet probed | — |
| bamboohr | 11,316 | not yet probed | — |
| paylocity | 10,252 | not yet probed | — |
| icims | 10,106 | not yet probed | — |

On 2026-08-24 the live lists held 4,355 Ashby, 8,299 Greenhouse and 2,611 Lever slugs (`data/slugs/<ats>-live.txt`); the four unprobed ATSes were unchanged. Workday identifiers are `tenant|wdN|site` triples rather than one slug, so they keep the pipes and are not yet directly comparable across sources.

## Sweep

```bash
npm run sweep                                          # all three ATSes, in order
npm run sweep:greenhouse                               # one of them
node src/sweep.mjs --ats=greenhouse --limit=200        # smoke run
node src/sweep.mjs --ats=greenhouse --concurrency=8
node src/sweep.mjs --ats=greenhouse --only=stripe,ramp # named boards only
node src/sweep.mjs --ats=greenhouse --no-conditional   # ignore stored ETags
```

The sweeper reads its slug list from `data/slugs/<ats>-live.txt` when that exists, otherwise from `data/slugs/<ats>.txt`, otherwise from whatever the database already knows is live. Writes go through batched transactions: one transaction per board would fsync thousands of times, and one for the whole sweep would hold a write lock for minutes and lose everything on a crash.

Every adapter fetches an entire board in one response, with full descriptions and no pagination:

| ATS | Endpoint |
| --- | --- |
| Ashby | `GET api.ashbyhq.com/posting-api/job-board/<slug>?includeCompensation=true` |
| Greenhouse | `GET boards-api.greenhouse.io/v1/boards/<slug>/jobs?content=true&pay_transparency=true` |
| Lever | `GET api.lever.co/v0/postings/<slug>?mode=json` |

Measured full sweeps, from the `sweeps` table:

| ATS | Date | Boards swept | Jobs | Transfer | Time | Errors |
| --- | --- | --- | --- | --- | --- | --- |
| Ashby | 2026-08-15 | 4,297 | 61,213 | 823 MB | 24 s | 0 |
| Greenhouse | 2026-08-22 | 8,272 (200,868 jobs came from 6,573 of them) | 200,868 | 2.7 GB | 32 min | 0 |
| Lever (concurrency 10) | 2026-08-22 | 2,611 | 71,789 | 931 MB | 106 s | 0 |

Those are first-pass timings; the later daily sweeps are not re-timed here.

### Conditional GET

Ashby and Greenhouse honour `If-None-Match`, and the sweeper sends the ETag it stored in `companies.last_etag` on the previous pass. An unchanged board answers `304` with a zero-byte body and its jobs are left open untouched. That matters at Greenhouse's scale: without conditional GET the daily run would move the full 2.7 GB every morning. (An earlier version wrote `last_etag` on every sweep and never read it back.)

**Lever is the exception.** It sends an ETag on every response and then ignores the `If-None-Match` sent back: replaying a freshly issued ETag against `solidcore` returned `200` and all 2.9 MB, with the same ETag echoed. The header is still sent, since it costs nothing and would start working the day Lever implements it, but a Lever sweep is budgeted for full transfer every night. The first full Lever sweep moved 931 MB and reported 0 unchanged boards, which is that header being ignored showing up in the totals. It is still the fastest of the three.

The one failure mode conditional GET can hide: a `304` says the *response body* is unchanged, so a board with a broken ETag would look like a company that stopped hiring. `--no-conditional` is meant to be run weekly with the counts diffed.

### Change detection without `updatedAt`

Ashby and Lever publish no `updatedAt` (Ashby has `publishedAt`, Lever `createdAt`), so an edited posting is detected by a content hash (`db.hashJob`). Greenhouse has `updated_at` on 100% of jobs. Either way the sweep writes one `job_events` row per job per day it appeared, changed, reappeared or disappeared, which is what "new since yesterday" is built on.

## Derive

```bash
node src/derive.mjs                  # derive every job, rebuild everything
node src/derive.mjs --only-new       # just the jobs a sweep added since last time
node src/derive.mjs --limit=2000     # smoke run
node src/derive.mjs --no-fts         # skip the full-text rebuild (the slow part)
```

Writes, in order: the `d_*` columns on `jobs`, the `job_metros` and `job_skills` join tables, the `metros` / `metro_aliases` registry built from what was observed, display names for companies whose ATS exposes none, and finally the FTS index. Re-deriving the 61,213-job Ashby corpus took well under a minute (about 50 s in mid-August); a partial `--only-new` pass over 2,625 jobs on 2026-08-24 took 436 s including the FTS rebuild.

Every run writes `data/derive-report.md`: coverage per signal, the distribution of each derived enum, the top metros, and every location fragment it could not place, ranked by frequency. That last list is the to-do list for the alias table.

**A partial derive replaces the metro registry.** `derive.mjs` builds `metros` and `metro_aliases` from the jobs *that run* touched, and opens with `DELETE FROM metro_aliases; DELETE FROM metros;`. So `--only-new` does not update the registry, it replaces it with one describing only the new jobs: a 2,625-job run left 930 metros behind where the corpus held 24,391, and every count in the app's metro dropdown was the count within those 2,625. `job_metros` is not damaged (derive rewrites it per job), so the registry is recoverable without re-deriving:

```bash
node src/rebuild-metros.mjs              # rebuild the registry from job_metros
node src/rebuild-metros.mjs --dry-run    # report what it would write
```

Aliases observed in the wild live only in memory during a run, so the rebuild adds to the alias table rather than replacing it.

## How the merge behaves

Details that matter once the sync runs unattended:

- **Dedup is per ATS, on the normalized slug.** `jobs.ashbyhq.com/Acme`, `Acme` and `acme` collapse to one entry. Verified against the live API: Ashby board tokens are case-insensitive, so lowercasing is safe.
- **Spaces in slugs are real.** `flock safety` and `tools for humanity` are genuine Ashby boards. They arrive percent-encoded inside URLs and are re-encoded when called. A normalizer that rejected spaces would silently lose those companies, which is exactly what URL-regex web harvests do.
- **A source that returns 304 or fails keeps its prior claims.** Without this, one upstream hiccup would read as thousands of deletions.
- **Removals are recorded, not executed.** When every source stops vouching for a slug it stays in `<ats>.json` with `sources: []` and its last-seen date, and drops out of `<ats>.txt`. `--prune-after=<days>` deletes it for real.
- **Only a `404` marks a slug dead.** See verify above.
- **`<ats>.json` is the only authority on provenance.** `<ats>-verified.json` deliberately does not copy the source list: a `--only-unknown` run would freeze stale copies while the real attribution moved on.
- **Workday entries keep their pipes** (`tenant|wdN|site`) and are not yet comparable across sources.

## Ashby API facts worth writing down

Established by probing the live API and confirmed against the full Ashby sweep:

- `GET api.ashbyhq.com/posting-api/job-board/<slug>?includeCompensation=true` returns the entire board in one call, full descriptions included, no pagination. `includeCompensation` must be exactly lowercase `true`; `True` and `1` return HTTP 200 and silently omit every salary. 37.2% of jobs carry a usable salary figure; an early sample suggested 71%, which the full sweep did not bear out.
- **`HEAD` works and returns zero bytes**, which is why verification is cheap: 200 is a real board, 404 is dead, at about 55 slugs/s moving almost no data.
- **The two Ashby hosts throttle differently.** `api.ashbyhq.com/posting-api` showed no rate limiting at all (7,951 requests at concurrency 10, zero 429s). `jobs.ashbyhq.com/api/non-user-graphql` does limit, returning `{"error": "Rate limit exceeded"}` within a few dozen requests. That endpoint is the only way to get a company's display name, so `--with-names` runs at concurrency 2 with backoff, and the name lookup is not folded into the board fetch.
- **There is no `updatedAt`**, only `publishedAt`. Detecting an edited posting needs the board ETag or a content hash, not a timestamp comparison.
- **`isRemote` is `true` for every Hybrid job**; it means "not fully onsite". `workplaceType` is the only trustworthy signal and the adapter passes that enum through untouched.
- **Board tokens can contain spaces**, so the slug is percent-encoded on the way into the URL.
- **Conditional GET is honoured**, verified against `ramp`: `W/"job-board:e150b520…"` sent back as `If-None-Match` answers 304.
- Cloudflare **403s a `Python-urllib/*` User-Agent**. Any explicit UA works. Easy to misread as throttling.
- **A hosted board can be switched off** (found 2026-08-23). An organisation can disable its `jobs.ashbyhq.com` page and serve the board through its own site instead; the posting API keeps handing out `jobs.ashbyhq.com` job URLs regardless, and every one of them renders "Page not found". The state is detectable through the GraphQL host's job-board query (an org that answers the plain organisation query but returns null for the hosted board has switched it off). `src/repair-ashby-links.mjs` rewrites each stored job's URL for such boards to the careers-page deep link, `<careers_url>?ashby_jid=<id>`, and merges the result into both the database and `data/slugs/ashby-verified.json`, which the sweep reads back; without the merge the next non-304 sweep would restore the dead links, and without the database write boards that answer 304 from then on would never be repaired.

### Greenhouse and Lever facts, for comparison

From the adapters (`src/lib/adapters/greenhouse.mjs`, `src/lib/adapters/lever.mjs`), which keep the numbers next to the code that depends on them:

- Greenhouse: both query parameters are load-bearing. Without `content=true` there are no descriptions; without `pay_transparency=true` the `pay_input_ranges` key is absent entirely, HTTP 200 and silently no salaries. `content` is entity-escaped markup (626 of 626 sampled jobs) and is decoded exactly once. Pay figures are in cents (`8500000` is $85,000). `employment` is present in the key union and populated on 0 of 1,140 sampled jobs, so `employment_type` is NULL for every Greenhouse row on purpose. There is no workplace enum: 31.2% of location strings match `/remote/i` and only 0.5% match `/hybrid/i`, against 26% of the Ashby corpus being explicitly hybrid. `boards-api.eu.greenhouse.io` does not resolve and `api.eu.greenhouse.io` serves the web app with a 200; EU boards come from the same host. Sweep concurrency is 8.
- Lever: `description` holds only the opening paragraphs. Requirements, responsibilities and benefits are in `lists[]` and the closing (relocation, visa, EEO, clearance) in `additional`; by character count the split is 33.9% / 50.3% / 15.8% in the design sample. Storing `descriptionPlain` alone would discard two thirds of every posting, specifically the parts `d_skills`, `d_degree`, `d_visa` and `d_clearance` read: over the sample, assembling all three parts raised degree statements found from 294 to 1,708, visa from 9 to 42, clearance from 64 to 221, any skill from 1,095 to 2,929. The markup is real HTML, not escaped, the opposite of Greenhouse. `categories.commitment` is free text (120 distinct values in the sample, `"Contract Full time"` alone on 3,462 jobs from one board), so it maps to an employment type only where it names exactly one. `country` is an ISO alpha-2 code that must be expanded: stored raw, 10,784 of 66,537 jobs (16.2%) would land in the wrong country (every Canadian job as American, every Indian job as Indiana, every German job as Delaware). A board with no open roles answers `200` with `[]`. Sweep concurrency is 10, the number the 106-second full run was measured at.

## The three ATSes are not equivalent

Measured on the first full sweep of each ATS (Ashby 2026-08-15, Greenhouse and Lever 2026-08-22). Greenhouse roughly quadrupled the corpus but its API publishes less per job; Lever publishes the most per job and is the one that brings hybrid back. The gaps are shown in the UI rather than averaged away.

| | Ashby | Greenhouse | Lever |
| --- | --- | --- | --- |
| Open jobs | 61,213 | 204,485 | **71,789** |
| Live boards | 3,764 | 6,730 | 2,025 (+586 live but not hiring) |
| `employment_type` (full-time / contract) | 100% | **0%: the API has no such field** | **72.5%**, free text, mapped only where it names exactly one type |
| Workplace enum | 100% | **none**, inferred from the location string | **98.0%** |
| Hybrid jobs | 15,932 | **0. Not rare: undetectable.** | **14,054**, nearly doubling what the corpus can see |
| Salary published | 37.2% | 20.7% (a board-level setting, so lumpy by company) | 31.1% |
| `updated_at` for change detection | none | **100%** | none; content hash, as with Ashby |
| Company display name | needs a rate-limited GraphQL call | on every job | **none in the API**; scraped from the board page `<title>`, 1.5 KB per board |
| Conditional GET | honoured | honoured | **ETag sent, `If-None-Match` ignored** |
| Description | one field | one field | **three fields that must be reassembled** (see `lever.mjs`) |
| Full sweep | — | 2.7 GB / 32 min | 931 MB / **106 s** |

Corpus-wide, adding Greenhouse and Lever moved every "unknown" share the filter publishes. The two that moved most: job type went from 0.0% to 77.0% unknown, and salary from 62.8% to 75.6%. Those shares are printed next to the include/exclude controls in the app, so excluding unknowns is a visible choice rather than a silent one (see [filtering.md](./filtering.md)).

## Where the data lives

`data/jobs.db` is SQLite through Node's built-in `node:sqlite`, so there is no install step.

| Table | What is in it |
| --- | --- |
| `jobs` | One row per posting. Raw columns as published, plus `d_*` columns from the derive pass. **Filters read `d_*` only**, which is what makes an alias fix a re-derive instead of a re-sweep. |
| `job_content` | Descriptions, split out so facet scans never touch the text (296 MB on the Ashby-only corpus). |
| `job_metros` / `job_skills` | Join tables, so a facet count is an index seek. A job can be in several metros: 76,041 rows across the 61,213 Ashby-only jobs. |
| `metros` / `metro_aliases` | The canonical registry, built from observed strings. **This is the authority at query time**: a wrong grouping is one row edit plus a re-derive, not a code change. |
| `jobs_fts` | FTS5 over title + company + description, joined through `jobs_fts_map`. |
| `job_events` | One row per job per day it appeared / changed / reappeared / disappeared. |
| `companies`, `sweeps`, `slug_attempts` | Boards (with `last_etag` and a `live` / `empty` / `dead` / `error` status), run history, probe verdicts. |

The `data/` directory:

| Path | Committed | What it is |
| --- | --- | --- |
| `data/slugs/<ats>.json`, `.txt`, `-live.txt`, `-verified.json` | yes | The slug store and verification results for all seven ATSes (20 files). |
| `data/backfill/ashby-nongithub-2026-08-11.txt` | yes | The one-time web harvest, HEAD-verified at capture. |
| `data/manual/ashby.txt` | yes | Hand-added slugs, one per line; `#` comments ignored. |
| `data/sync-report.md` | yes | The latest sync report; tracked because the GitHub Actions slug sync owns it and commits it. |
| `data/derive-report.md`, `daily-report.md` | no | The latest derive and daily reports, regenerated by every run on the laptop. |
| `data/jobs.db` (+ `-wal`, `-shm`) | **no** | The corpus. 4.5 GB on disk and it changes every sweep; GitHub rejects any single file over 100 MB anyway. Rebuild it with `npm run refresh`. |
| `data/jobs-deploy.db`, `.gz` | no | The compacted copy `deploy/upload-db.sh` makes on its way to Fly (about 857 MB gzipped). See [deploy.md](./deploy.md). |
| `data/users.db` (+ `-wal`, `-shm`) | **no** | Accounts. See below. |
| `data/sync-state.json`, `daily-history.jsonl`, `daily.log`, `repair-ashby.log` | no | Runtime state written by the runs. |

Accounts live in a **second** database, `data/users.db`, and the split is deliberate: the corpus is disposable (delete it, re-sweep, re-derive, nothing of value is lost), while a password hash, a session token or someone's list of jobs they applied to is the opposite. Neither database is a git object, but keeping them apart means a copy of the corpus can be shipped, cached in CI or uploaded to a host without ever carrying an account. See [app-and-accounts.md](./app-and-accounts.md).
