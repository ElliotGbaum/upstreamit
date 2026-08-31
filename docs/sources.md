# Slug sources

Where UpstreamIt's company slugs come from: the eleven upstream lists in `sources.json`, the two web archives that now feed it on every run, what each one measurably contributes, the enumeration avenues that were tested and ruled out, how upstream changes are detected without a webhook, and the licence each source is recorded under. Measurements below were taken 2026-08-11 to 2026-08-22 unless a later date is given; the Ashby live/only counts are from the Ashby-only corpus of mid-August 2026 (4,297 verified boards). The live counts are on the site.

Related: [pipeline.md](./pipeline.md) for the sync, verify and sweep stages that consume these lists, and the [README](../README.md).

## Why eleven sources

A single GitHub repo (`Feashliaa/job-board-aggregator`, the first list found) yields 2,478 live Ashby boards on its own. Merging eleven sources and verifying each slug against the live API yields 4,297, 73% more companies to search, with 3,654 dead slugs identified and excluded rather than silently wasting requests. Verification is cheap (a `HEAD` per slug, about 55 slugs/s on Ashby), so the strategy is to harvest dirty and filter, not to curate upstream.

## The sources

**`only`** counts live boards no other source knew about. That column, not the raw count, is the argument for keeping a source: a large list with zero uniques is redundant, and a small list with uniques is worth keeping. `node src/stats.mjs [ats]` computes it by joining the slug store (the authority on provenance) with the verification results (the authority on whether a board exists).

Ashby, measured mid-August 2026:

| Source | Origin | Slugs | Live | Dead % | Only | Upstream refresh |
| --- | --- | --- | --- | --- | --- | --- |
| `backfill` (2026-08) | web harvest | 4,174 | 4,174 | 0%\* | **113** | one-time capture |
| `latmay/ats-career-page-urls` | HuggingFace | 7,558 | 3,947 | 48% | 45 | static snapshot |
| `kalil0321/ats-scrapers` | GitHub | 3,447 | 3,309 | 4% | 2 | manual batches, roughly monthly |
| `datascry/openroles` | GitHub | 3,137 | 3,113 | **1%** | 11 | cron, weekly-ish |
| `Feashliaa/job-board-aggregator` | GitHub | 3,161 | 2,478 | **22%** | **0** | slug lists every 1-2 months |
| `colophon-group/jobseek` | GitHub | 921 | 889 | 3% | 7 | 15-20 companies/day, reviewed |
| `outscal/OpenJobs` | GitHub | 235 | 204 | 13% | 3 | manual |
| `crypto-jobs-fyi/crawler` | GitHub | 149 | 139 | 7% | 0 | curated |
| `Mayank-glitch-cpu/JobSync-Service` | GitHub | 120 | 117 | 3% | 0 | abandoned (Apr 2026) |
| `tjwenger/job_scraper` | GitHub | 75 | 74 | 1% | 1 | hand-maintained |
| `ConorsCode/open-jobs-data` | GitHub | 71 | 70 | 1% | 1 | **cron, truly daily** |

\* `backfill`'s 0% dead rate is not a quality signal: it was filtered to live-only at capture time, so it is not better curated than the raw lists.

Notes on the picks:

- **The HuggingFace CSV is the highest-yield single source**, though at 48% dead it is also the noisiest. That is fine because verification is free: harvest dirty and filter. It is one CSV of canonical career-page URLs across every ATS; the sync reads `canonical_url` and lets the URL patterns route each row, so one file feeds every ATS. Junk rows (bare integers, `$10.2K`, `.well-known`) are dropped by slug validation.
- **`kalil0321` is the best GitHub source**, not Feashliaa: more live boards, a fifth of the junk, and it ships company display names next to slugs (`name,slug,url`). Actively maintained in batch commits (`ashby.csv`: 2026-07-23 "+592 discovered Ashby boards", 2026-05-23, 2026-05-11), just not cron-driven.
- **`datascry/openroles` publishes its own live/dead probe status**, so dead entries are filtered before they are ever fetched (`where: {"status": {"not": "dead"}}`). Covers 53 ATS families. Its weekly cron is `43 2 * * 1`; the observed refresh of the tenant lists is roughly biweekly.
- **`jobseek` is the freshest**, adding reviewed companies daily from a 03:00 UTC discovery timer. Small on Ashby, but its `boards.csv` (5,874 rows) covers about 40 ATS families including several nothing else here touches (pinpoint, recruitee, personio, smartrecruiters, rippling, workable). The sync reads `board_url` and lets the normalizer unwrap the slug, which covers rows whose `monitor_config` uses a non-standard key.
- **`Feashliaa` is the biggest dump by volume**, but its Ashby list was last touched 2026-06-16 and 22% of its Ashby slugs are dead boards, against 4% for `kalil0321` and 1% for `datascry/openroles`. It contributes zero boards no other source has. It is still wired in and is the first candidate to drop; its bamboohr / icims / paylocity lists were dropped in August 2026 because no adapter can sweep them.
- **`outscal/OpenJobs`** has 12,144 companies skewed toward gaming studios and tech, which general-purpose crawls miss; `ats_links` is an array of full board URLs per company, flattened and routed by URL pattern.
- **`crypto-jobs-fyi/crawler`** is 365 hand-curated crypto / AI / fintech companies, a vertical under-represented in the bulk crawls; `jobs_url` is routed by URL pattern.
- **`tjwenger/job_scraper`** is 74 slugs scraped out of a Python list literal, skewed toward well-known companies the bulk sources oddly lack (vercel, mercury, snyk, temporal, wiz).
- **`ConorsCode/open-jobs-data`** has only 378 companies but a real daily cron (`0 6 * * *`), so it is the fastest to reflect a newly launched board.
- **Four sources contribute 0 unique live boards** (`feashliaa`, `cryptojobs`, `jobsync`, and nearly `kalil`). They are kept because polling them is free (see below), but they are the first candidates to drop if the sync ever needs trimming.

On the 2026-08-24 sync, after the store was extended to Greenhouse and Lever, the per-source contribution in *slugs* (accepted, and unique to that source; these are collected slugs, not verified boards) was:

| Source | Ashby | Greenhouse | Lever |
| --- | --- | --- | --- |
| `hf-latmay` | 5,461 (823 unique) | 14,233 (4,792 unique) | 8,530 (3,783 unique) |
| `backfill` | 4,174 (108 unique) | — | — |
| `kalil` | 3,447 (30 unique) | 6,028 (448 unique) | 2,400 (133 unique) |
| `feashliaa` | 3,161 (5 unique) | 8,333 (171 unique) | 4,368 (46 unique) |
| `openroles` | 3,100 (11 unique) | 5,137 (59 unique) | 2,135 (4 unique) |
| `jobseek` | 922 (9 unique) | 2,519 (28 unique) | 182 (0 unique) |
| `outscal` | 235 (10 unique) | 642 (20 unique) | 314 (12 unique) |
| `cryptojobs` | 149 (0 unique) | 107 (0 unique) | 63 (0 unique) |
| `jobsync` | 120 (0 unique) | — | — |
| `tjwenger` | 75 (0 unique) | — | — |
| `openjobsdata` | 71 (0 unique) | 263 (1 unique) | 11 (0 unique) |

The HuggingFace dataset is the dominant contributor for Greenhouse and Lever by a wide margin. The Ashby slug counts are lower than in the mid-August table: on the 2026-08-23 sync, the first time the HuggingFace CSV was re-downloaded since 2026-08-11, its accepted Ashby count went from 7,558 to 5,461 and 2,168 Ashby slugs stopped being claimed by any source (7,951 active to 5,844). Removals are recorded rather than executed, so the store still tracked 8,013 Ashby slugs on 2026-08-24, and the verified live list held 4,355.

### Deliberately rejected

- `CarterPerez-dev/exs-cyberjob-scraper`: AGPL, and its data is a stale copy of `kalil`.
- `ABHIMANYU993/OpenJobs`: unlicensed mirror of Feashliaa.
- `glin23/mrweirdo-jobs`: strict subset.
- `Kayvan-Zahiri/state-of-ats-2026`: report slugs, not board tokens.
- `joblisttoday/data`: 9 months stale.
- `wyattowalsh/openoppsdb`: ideal licence and cadence on paper, but at the time of checking it published 4 rows of Faker placeholder data. Worth re-checking later.

One repo found during the search, `Somitha-git/find-companies-using-ashby-job-boards`, ships a `.zip` containing a `Launcher.cmd` + `lua51.exe` pair, a common malware-loader shape. It was not downloaded and is not wired in.

## Do the slugs have to come from GitHub?

No, and the non-GitHub sources turned out to be the stronger half:

| Origin | Live Ashby boards | Found nowhere else |
| --- | --- | --- |
| GitHub repos (9 sources) | 3,761 | **30** |
| Open web (2 sources) | 4,267 | **536** |
| **Union** | **4,297** | |

A single HuggingFace dataset out-yields all nine GitHub repos combined. The web sources also have a blind spot the repos cover: they harvest slugs with a URL regex, which mangles the boards whose token contains a space (`flock safety`, `tools for humanity`). Those come in via the repos.

## The archives feed continuously, the lists do not

Every list above is maintained by somebody else, which caps coverage at their diligence: most refresh monthly at best, several have stopped, and none of them owes this project anything. Common Crawl and the Wayback Machine are not lists. They are indexes of the open web that keep crawling whether or not anyone curates them, so a board that no list-maintainer has noticed still appears in them once somebody links to it.

Both were queried once, on 2026-08-11, and the answers frozen into `data/backfill/ashby-nongithub-2026-08-11.txt`. That was the bug: the archives kept crawling and the store stopped asking. `jobs.ashbyhq.com/lupapets` was crawled by Common Crawl on 2026-08-17, six days after the freeze, and stayed invisible to the site until the archives became live sources.

Measured on 2026-08-28 against a store holding 8,013 Ashby slugs:

| Archive | Ashby boards seen | New to the store | Live | Open jobs behind them |
| --- | --- | --- | --- | --- |
| Common Crawl `CC-MAIN-2026-34` | 2,778 | 93 | 81 | 683 |
| Wayback, captures since 2026-08-11 | 787 | 39 | not probed | — |

Only 9 slugs appear in both, so they are close to independent nets: Common Crawl records what its crawler reached, Wayback records what a person or a bot actually visited. Their union was 120 new Ashby boards from two queries taking under a minute.

Two properties make them different from every other source, and both are declared in `sources.json`:

- **`incremental: true`.** Neither returns the whole population on any run — one Common Crawl month holds roughly a third of the Ashby boards already known. So a slug missing from a run means "not new", not "gone", and `mergeStore` must never retract an archive's claim for absence. Without that flag each source would delete its own findings on the following run.
- **`optional: true`.** The Wayback CDX server is slow and moody on a prefix this wide — 15-40s for an answer, and identical queries time out under any sustained rate, whoever you say you are. A failed run must cost a day of freshness and nothing else. Each archive keeps its own bookmark and only advances it on success, so a bad day is simply re-read on the next.

Wayback cannot serve the three highest-volume hosts at all. `boards.greenhouse.io`, `job-boards.greenhouse.io` and `jobs.lever.co` answer 504 after about 60 seconds, and narrowing the date window does not help: a 2-day window fails exactly as a 17-day one does, because the server scans the prefix's index blocks before applying the date filter. Since the bookmark only advances on success, leaving those patterns in would have wedged them permanently while costing about 13 minutes of every run. They are removed. Pagination is available (286 pages for Greenhouse, 367 for Lever) but not at a daily cadence, and `commoncrawl` already covers those hosts well. So Wayback runs on Ashby and the low-volume regional hosts, which is where its unique contribution was measured anyway.

`filter=statuscode:200` would drop captures of dead and mistyped board URLs, but it makes the CDX server answer 504 on a prefix this wide. The junk is left in: `normalizeSlug` discards what is not slug-shaped, and `probe-boards.mjs` is what decides a board is live anyway.

### Query every regional host, not just the obvious one

These indexes are keyed by host, so a pattern only finds what that exact hostname served. Each ATS runs several, and coverage is not where you would guess. In `CC-MAIN-2026-34`:

| Host | Captures | Real boards |
| --- | --- | --- |
| `jobs.eu.lever.co` | 982 | 75 |
| `jobs.lever.co` | 62 | **0** |

Every single capture under `jobs.lever.co` was `/robots.txt`. Querying only the US host — the obvious choice, and the first thing configured here — found one junk slug and no companies at all; Lever discovery works entirely through the EU host. Greenhouse splits the same way across `boards`, `job-boards` and their `.eu` variants, which together contributed 226 new boards against 121 for the two US hosts alone. So both archive sources list one pattern per regional host.

Two consequences worth keeping:

- `job-boards.anz.greenhouse.io` exists in the index and is deliberately **not** queried: `normalizeSlug` has no URL pattern for the ANZ host, so every row would be rejected. Adding the host means adding the pattern first.
- `robots.txt`, `sitemap.xml` and `favicon.ico` are in `normalizeSlug`'s blocklist. Curated lists never contain them, so nothing needed it before; an archive reads raw crawl URLs, where a crawler fetches `/robots.txt` far more often than it reaches any one board, and `robots.txt` is slug-shaped enough to pass the pattern.

### Tested and ruled out

Recorded so that none of it is re-litigated:

- **Ashby has no enumeration surface.** `jobs.ashbyhq.com/sitemap.xml` returns the SPA shell, not a sitemap; `robots.txt` has no `Sitemap:` directive; there is no public customer directory; and every unauthenticated collection endpoint (`/job-board`, `/job-boards`, `/companies`) returns 401.
- **Search-engine enumeration is dead for scripted use.** DuckDuckGo serves a CAPTCHA, Bing returns zero Ashby URLs in its HTML, Mojeek 403s. Yield: 0 slugs/page.
- **BuiltWith and Wappalyzer do not track Ashby at all**, confirmed against Wappalyzer's full 7,278-technology catalog and BuiltWith's ATS category listings.
- **Certificate transparency / DNS is meaningless here.** Every board is a URL path on one shared Cloudflare host, so there is no per-company signal.
- **Guess-and-probe from company directories is a bad trade.** 75 Y Combinator companies produced 125 slug guesses and exactly 1 hit. (`slug_attempts` in the database still records the strategy and seed of each guess.)
- **TheirStack** is the one vendor with real Ashby data (about 14k companies claimed, and its free keyword endpoint is a decent growth signal), but full extraction runs about $400. Not worth paying when the free avenues already produced 4,297 verified boards.

## How upstream changes are detected

Four of the nine GitHub sources (`feashliaa`, `openroles`, `cryptojobs`, `openjobsdata`) refresh themselves with GitHub Actions: a YAML file under `.github/workflows/` that GitHub runs on a timer on its own machines, which scrapes and then commits the results straight back into the repo. Feashliaa's is `.github/workflows/scrape-jobs.yml`:

```yaml
on:
  schedule:
    - cron: "33 7 * * *"   # 07:33 UTC daily
```

That daily cron does *not* refresh Feashliaa's company lists; it refreshes the job data and the trend snapshots. `data/ashby_companies.json` was last touched 2026-06-16, and the staleness is measurable: 22% of its Ashby slugs are dead boards, versus 4% for `kalil0321` and 1% for `datascry/openroles`. The refresh cadence recorded per source in `sources.json` (`upstreamSchedule`) is the cadence of the *slug list*, not of the repo.

**A webhook is not an option.** Only a repo's owner can register a webhook on it; there is no subscribe-to-a-public-repo API. So the sync polls, using the mechanism that makes polling nearly free: a conditional request. Every fetch stores the file's `ETag` (and `Last-Modified` where offered) in `data/sync-state.json`. The archives bookmark themselves the same way in the same file, with the identifier that suits each: Common Crawl stores the id of the newest index it has finished reading, and skips the run entirely when nothing newer has been published; Wayback stores a date, set one day behind the run so a capture recorded later the same day cannot fall into the gap between two queries, and floored at 90 days back so that a bookmark lost between runs costs a bounded re-read rather than a query wide enough for the CDX server to answer 504 forever. The next run sends it back as `If-None-Match`, and if nothing changed the origin replies `304 Not Modified` with a zero-byte body:

```
· openroles    ashby          not modified upstream
· kalil        ashby          not modified upstream
✓ jobseek      ashby          921 slugs          ← only this one actually re-downloaded
```

A full no-change poll of all eleven sources transfers essentially nothing, so checking hourly would be fine; daily is the practical cadence since no upstream moves faster. The trade-off against a webhook is latency (a change is seen on the next poll rather than the instant it lands), which is irrelevant for job boards where postings sit up for weeks. A source that returns 304 or fails keeps its prior claims, so one upstream hiccup cannot read as thousands of deletions. `--force` ignores the stored validators and re-downloads everything.

## Adding a source

`sources.json` is configuration, not code. Adding a source means appending an entry; nothing in `src/` changes. Transport (`kind`) is decoupled from parsing (`format`), so any origin that can hand over bytes works: a GitHub repo, a plain URL, a gist, an S3 object, a CSV exported from a paid tech-lookup service and dropped in `data/manual/`. The `commoncrawl` and `wayback` kinds are the exception to "nothing in `src/` changes": they are queried rather than downloaded, so they take a `urlPattern` instead of a path or URL and live in `src/lib/archives.mjs`.

```json
{
  "id": "my-source",
  "kind": "github-raw",
  "name": "owner/repo",
  "license": "MIT",
  "upstreamSchedule": "cron 0 6 * * *",
  "repo": "owner/repo",
  "branch": "main",
  "enabled": true,
  "files": [
    { "path": "data/boards.csv", "ats": "ashby", "format": "csv",
      "column": "board_url", "where": { "monitor_type": "ashby" } }
  ]
}
```

- `kind`: `github-raw` (`repo` + `branch` + `files[].path`, fetched from `raw.githubusercontent.com`) · `http` (`files[].url`, any host: an API, a HuggingFace file, an S3 object) · `file` (local `files[].path`, for manual dumps and CSV exports).
- `format`: `json-array` (array of strings) · `json-objects` (+`slugKey`) · `json-keys` · `text-lines` · `csv` (+`column`, optional `where`) · `regex-scrape` (+`pattern`, optional `between`, used to pull slugs out of a Python list literal).
- Optional per file: `jsonPath` (`data.companies`) to descend before parsing; `where` to select rows of a mixed-ATS table (`{"status": {"not": "dead"}}` works); `headers` with `${ENV_VAR}` so API keys stay out of the file.
- Per source: `enabled: false` parks a source without deleting its config; `optional: true` makes a missing file a skip rather than an error (the backfill and manual files use it). `name`, `license`, `upstreamSchedule` and `notes` are documentation fields; the sync does not read them, and this page's attribution section is built from them.
- Slugs are extracted from full board URLs automatically, so pointing `column` / `slugKey` at a URL field is usually the most robust choice: one mixed-ATS file can then feed every ATS by listing it once per `ats`, as `hf-latmay`, `jobseek`, `cryptojobs` and `outscal` do.

For slugs added by hand, `data/manual/ashby.txt` is a plain newline list; blank lines and `#` comments are ignored.

## Repeating the web harvest

`data/backfill/ashby-nongithub-2026-08-11.txt` holds a one-time capture: the union of four non-GitHub avenues, each slug `HEAD`-verified live at capture time. Common Crawl's index (49 crawls, about 3,300 live), the Wayback Machine's CDX index over the `jobs.ashbyhq.com` domain history (about 3,246 live), a Kaggle ATS company directory (95% live, the cleanest single feed), and urlscan.io plus hiring.cafe as new-board tripwires.

The repeatable part is Common Crawl, one index query per new monthly crawl:

```
https://index.commoncrawl.org/collinfo.json                 # list crawl IDs
https://index.commoncrawl.org/CC-MAIN-2026-30-index?url=jobs.ashbyhq.com%2F*&output=json&fl=url&page=N
```

Yield saturates fast: 1 crawl gave 2,820 slugs, 15 gave 4,172, 49 gave 4,354. Sweeping the newest 10-15 crawls is enough. `urlscan.io` (`?q=page.domain:jobs.ashbyhq.com`) and `hiring.cafe` work as cheap new-board tripwires between crawls.

## Attribution

Licences as recorded in `sources.json`. The slug store under `data/slugs/` is derived from all of them.

| Source | Where | Licence recorded |
| --- | --- | --- |
| `latmay/ats-career-page-urls` | HuggingFace dataset | CC BY 4.0 |
| `datascry/openroles` | GitHub | MIT (code) / CC BY-SA 4.0 (data); share-alike applies to redistributed derived slug lists |
| `kalil0321/ats-scrapers` | GitHub | MIT |
| `colophon-group/jobseek` | GitHub | AGPL-3.0 (code); the data files are under the repo's `LICENSE-JOB-DATA` |
| `Feashliaa/job-board-aggregator` | GitHub | MIT |
| `Mayank-glitch-cpu/JobSync-Service` | GitHub | MIT |
| `tjwenger/job_scraper` | GitHub | MIT |
| `crypto-jobs-fyi/crawler` | GitHub | Apache-2.0 |
| `outscal/OpenJobs` | GitHub | MIT |
| `ConorsCode/open-jobs-data` | GitHub | MIT |
| `backfill` (2026-08-11 capture) | Common Crawl index, Wayback CDX, a Kaggle ATS directory, urlscan.io, hiring.cafe | mixed; each avenue's own terms |
| `manual` | local file | n/a |

The job postings themselves come from the public, unauthenticated board APIs of Ashby, Greenhouse and Lever, and belong to the companies that published them.

**The committed slug store is a derived dataset.** `data/slugs/*.json` merges slugs from every source above, including `datascry/openroles`, whose data is CC BY-SA 4.0. To honour that share-alike term the slug store is offered under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/); the code in this repository is MIT (see [../LICENSE](../LICENSE)).
