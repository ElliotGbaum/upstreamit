# Job Finder ATS

Pulls ATS company slugs from public datasets, verifies them against the live ATS APIs,
sweeps the job boards, normalizes the results, and filters them against a profile you
write once.

> **[PROJECT.md](PROJECT.md)** is the context doc — what's been established, what was ruled
> out and why, and the reasoning behind the filter design. This file is how to run things.

**All six phases are built, across three ATSes.** Slug aggregation, verification, the
board sweep, the normalization pass, the filter engine, and the local app with its
daily diff — now over Ashby, Greenhouse **and** Lever, with a filter to pick between
them.

| | |
| --- | --- |
| Boards swept | **12,519 live** — 6,730 Greenhouse + 3,764 Ashby + 2,025 Lever |
| Open jobs stored | **337,487** with full descriptions |
| Metros discovered | **20,449**, built from observed location strings |
| Database | `data/jobs.db`, 4.5 GB, FTS5 index over every description |
| A full filter run | **1.4–4.3 s** warm over all 337,487 jobs, every facet counted (~10 s to build the index on the first query after a sweep). This was ~800 ms at 265,698 jobs; the re-measurement was taken on a machine also running the app server and DB Browser, so treat the top of that range as contention, not cost — worth re-timing on an idle machine. |
| Tests | **518** — 105 derivation, 191 filter, 130 adapter, 92 account — no database, no network |

### The three ATSes are not equivalent, and the filter says so

Greenhouse roughly **quadrupled** the corpus, but its API publishes less per job.
Lever publishes the most per job of the three and is the one that brings hybrid back.
The gaps are visible in the UI rather than averaged away:

| | Ashby | Greenhouse | Lever |
| --- | --- | --- | --- |
| Open jobs | 61,213 | 204,485 | **71,789** |
| Live boards | 3,764 | 6,730 | 2,025 (+586 live but not hiring) |
| `employment_type` (full-time / contract) | 100% | **0% — the API has no such field** | **72.5%** — free text, mapped only where it names exactly one type |
| Workplace enum | 100% | **none** — inferred from the location string | **98.0%** |
| Hybrid jobs | 15,932 | **0. Not rare — undetectable.** | **14,054** — nearly doubles what the corpus can see |
| Salary published | 37.2% | 20.7% (a board-level setting, so it is lumpy by company) | 31.1% |
| `updated_at` for change detection | none | **100%** | none — content hash, as with Ashby |
| Company display name | needs a rate-limited GraphQL call | on every job | **none in the API** — scraped from the board page `<title>`, 1.5 KB per board |
| Conditional GET | honoured | honoured | **ETag sent, `If-None-Match` ignored** |
| Description | one field | one field | **three fields that must be reassembled** — see `lever.mjs` |
| Full sweep | — | 2.7 GB / 32 min | 931 MB / **106 s** |

Corpus-wide that moved every "unknown" share the filter publishes. The two that
moved most: **job type went from 0.0% to 77.0% unknown**, and salary from 62.8% to
75.6%. Those numbers are printed next to the include/exclude controls, so excluding
unknowns is a visible choice rather than a silent one.

```bash
npm run serve      # the app: http://localhost:7799
npm run find       # the same search, in the terminal
npm run daily      # sweep, derive, and report what's new since yesterday
```

### Slug coverage

| ATS | slugs collected | verified live | swept |
| --- | --- | --- | --- |
| **ashby** | **7,951** | **4,297** (54.0%) | yes |
| **greenhouse** | **15,197** | **8,272** (54.4%) | yes |
| **lever** | **8,721** | **2,611** (29.9%) | yes |
| workday | 12,884 | not yet probed | — |
| bamboohr | 11,316 | not yet probed | — |
| paylocity | 10,252 | not yet probed | — |
| icims | 10,106 | not yet probed | — |

For Ashby: the single repo you pointed at yields **2,478 live boards** on its own. Merging
eleven sources and verifying each slug against the live API yields **4,297** — **73% more
companies to search**, with 3,654 dead slugs identified and excluded rather than silently
wasting requests.

---

## Quick start

```bash
npm run sync       # pull every source, dedupe, write the slug store
npm run verify     # check each Ashby slug against the live API (~2.5 min)
npm run sweep      # fetch all 4,297 live boards into data/jobs.db  (~25 s)
npm run derive     # normalize into the d_* columns filters read     (~50 s)
npm test           # 518 regression tests, no DB and no network needed
npm run refresh    # all four in order

npm run find       # run a filter profile in the terminal
npm run serve      # the app — http://localhost:7799
npm run daily      # refresh + "what's new since yesterday" report
npm run schedule   # write the launchd / GitHub Actions files (installs nothing)
```

`derive` is a pure function of what the sweep stored — no network — so improving a
metro alias or a seniority rule means re-running it, never re-sweeping. Use
`npm run derive:new` to touch only jobs a sweep has added since the last pass.

Outputs land in `data/slugs/`:

| File | What it is |
| --- | --- |
| `ashby.json` | Canonical store. Per slug: which sources vouch for it, `first_seen`, `last_seen`. |
| `ashby.txt` | Every slug currently claimed by at least one source (includes unverified). |
| `ashby-live.txt` | **Feed the sweeper this one** — 4,297 slugs confirmed to exist. |
| `ashby-verified.json` | Per-slug verdict (`exists` / `dead`), plus display name if fetched with `--with-names`. |
| `../sync-report.md` | What changed on the last run, and which source contributed what. |

Useful flags:

```bash
node src/sync-slugs.mjs --check            # report drift, write nothing, exit 1 if changed
node src/sync-slugs.mjs --ats=ashby        # one ATS only
node src/sync-slugs.mjs --force            # ignore ETags, re-download everything
node src/sync-slugs.mjs --prune-after=60   # drop slugs no source has vouched for in 60 days

# One probe for every ATS, driven by the adapter's own probeUrl().
# (This replaced probe-ashby.mjs, which hardcoded the Ashby endpoint.)
node src/probe-boards.mjs --ats=greenhouse                 # HEAD every slug in the store
node src/probe-boards.mjs --ats=greenhouse --only-unknown  # only slugs added since last run
node src/probe-boards.mjs --ats=greenhouse --sample=300    # quick estimate instead of a full pass
node src/probe-boards.mjs --ats=ashby --with-names         # display names (Ashby + Lever, slow)
```

Verifying all 15,197 Greenhouse slugs takes **3.7 minutes** at concurrency 8 and
found **8,272 live boards (54.4%)** with zero errors. Verifying first is what keeps
the sweep from paying for the 45% of slugs that are dead.

Lever is harsher: all 8,721 slugs took **4.1 minutes** at concurrency 16 and found
**2,611 live boards (29.9%)**, zero errors. Seven slugs in ten were dead — and of
the 2,611 that survived, 586 were live boards with no open roles, so the sweep found
jobs on 2,025.

### Sweeping

```bash
npm run sweep                              # all three ATSes, in order
npm run sweep:greenhouse                   # one of them
node src/sweep.mjs --ats=greenhouse --limit=200        # smoke run
node src/sweep.mjs --ats=greenhouse --no-conditional   # ignore stored ETags
```

Ashby and Greenhouse honour `If-None-Match`, and the sweeper sends the ETag it
already stored. An unchanged board answers `304` with a zero-byte body and its jobs
are left open untouched. That matters at Greenhouse's scale: a full content sweep
moves **2.7 GB** (200,868 jobs from 6,573 boards in 32 minutes), and without
conditional GET the daily run would pay that every morning.

**Lever is the exception.** It sends an ETag on every response and then ignores the
`If-None-Match` you send back — replaying a freshly-issued ETag returns `200` and the
whole body, with the same ETag echoed. The header is still sent, since it costs
nothing and would start working the day Lever implements it, but budget a Lever sweep
for full transfer every night. The first full sweep moved **931 MB** and reported
**0 unchanged boards**, which is that header being ignored showing up in the totals.
It is still the fastest of the three: 2,611 boards in **106 seconds**, zero errors.

Run `--no-conditional` weekly and diff the counts. A 304 means the *response body*
is unchanged, so a board with a broken ETag would look like a company that stopped
hiring — that is the one failure mode this optimization can hide.

---

## Your questions, answered

### What is GitHub Actions?

It's a scheduled-task runner built into GitHub. A repo commits a YAML file under
`.github/workflows/`, and GitHub runs it on a timer on their machines. Feashliaa's is
`.github/workflows/scrape-jobs.yml`, and its schedule line is:

```yaml
on:
  schedule:
    - cron: "33 7 * * *"   # 07:33 UTC daily
```

The job scrapes, then commits the results straight back into the repo. That's why the data
appears to update by itself — a robot is committing to it every night.

**Important correction to the assumption in your question:** that daily cron does *not*
refresh Feashliaa's company lists. It refreshes the *job* data and the trend snapshots.
`data/ashby_companies.json` was last touched **2026-06-16** — about two months ago. That
staleness is measurable: **22% of Feashliaa's Ashby slugs are dead boards**, versus 4% for
`kalil0321` and 1% for `datascry/openroles`. Worse, it now contributes **zero** boards that
no other source has. It's still wired in, but it is no longer the primary and is a
candidate to drop.

### Can we hook it up with a webhook?

No — and it's worth knowing exactly why, because it changes the design.

Only a repo's **owner** can register a webhook on it. You can't ask GitHub to notify you
about pushes to someone else's repo. There's no subscribe-to-a-public-repo API.

So this polls instead, using the mechanism that makes polling nearly free: a **conditional
request**. Every fetch stores the file's `ETag` (GitHub's content fingerprint) in
`data/sync-state.json`. The next run sends it back as `If-None-Match`, and if nothing
changed GitHub replies **`304 Not Modified`** with a zero-byte body:

```
· openroles    ashby          not modified upstream
· kalil        ashby          not modified upstream
✓ jobseek      ashby          921 slugs          ← only this one actually re-downloaded
```

A full no-change poll of all eleven sources transfers essentially nothing, so checking
hourly would be fine; daily is the practical cadence since no upstream moves faster. The
trade-off vs. a webhook is latency — you learn about a change on your next poll rather than
the instant it lands. For job boards, where postings sit up for weeks, that's irrelevant.

### Do the slugs have to come from GitHub?

No, and it turns out **the non-GitHub sources are the stronger half**:

| Origin | Live Ashby boards | Found nowhere else |
| --- | --- | --- |
| GitHub repos (9 sources) | 3,761 | **30** |
| Open web (2 sources) | 4,267 | **536** |
| **Union** | **4,297** | |

A single HuggingFace dataset out-yields all nine GitHub repos combined. The web sources
also have a blind spot the repos cover: they harvest slugs with a URL regex, which mangles
the boards whose token contains a space (`flock safety`, `tools for humanity`) — those come
in via the repos.

What was tested and **ruled out**, so nobody re-litigates it:

- **Ashby has no enumeration surface.** `jobs.ashbyhq.com/sitemap.xml` returns the SPA
  shell, not a sitemap; `robots.txt` has no `Sitemap:` directive; there's no public
  customer directory; and every unauthenticated collection endpoint (`/job-board`,
  `/job-boards`, `/companies`) returns 401.
- **Search-engine enumeration is dead for scripted use.** DuckDuckGo serves a CAPTCHA,
  Bing returns zero Ashby URLs in its HTML, Mojeek 403s. Yield: 0 slugs/page.
- **BuiltWith and Wappalyzer do not track Ashby at all** — confirmed against Wappalyzer's
  full 7,278-technology catalog and BuiltWith's ATS category listings.
- **Certificate transparency / DNS is meaningless here** — every board is a URL path on one
  shared Cloudflare host, so there's no per-company signal.
- **Guess-and-probe from company directories is a bad trade** — 75 Y Combinator companies
  produced 125 slug guesses and exactly 1 hit.
- **TheirStack** is the one vendor with real Ashby data (~14k companies claimed, and its
  free keyword endpoint is a decent growth signal), but full extraction runs ~$400. Not
  worth paying when the free avenues already produced 4,297 verified boards.

### What still needs deciding

**The runner.** `npm run daily` does the whole pipeline plus the diff on demand, and
`npm run schedule` writes both automation files — but nothing is scheduled until you say so.

1. **launchd** (macOS native) — `npm run schedule -- --install`. Local only, no accounts,
   runs while the laptop is awake.
2. **GitHub Actions in your own repo** — `.github/workflows/daily.yml` is written and ready;
   commit and push it. Free for public repos, runs whether or not your laptop is on.
3. **A scheduled cloud agent** — heavier, still unwritten.

See **[Automation](#automation)** for the trade-off between the first two. Say which and
it's one command.

---

## Sources

Eleven sources. **`only`** counts live boards no other source knew about — that column,
not the raw count, is the argument for keeping a source.

| Source | Origin | Slugs | Live | Dead % | Only | Upstream refresh |
| --- | --- | --- | --- | --- | --- | --- |
| `backfill` (2026-08) | web harvest | 4,174 | 4,174 | 0%\* | **113** | one-time capture |
| `latmay/ats-career-page-urls` | HuggingFace | 7,558 | 3,947 | 48% | 45 | static snapshot |
| `kalil0321/ats-scrapers` | GitHub | 3,447 | 3,309 | 4% | 2 | manual batches, ~monthly |
| `datascry/openroles` | GitHub | 3,137 | 3,113 | **1%** | 11 | cron, weekly-ish |
| `Feashliaa/job-board-aggregator` | GitHub | 3,161 | 2,478 | **22%** | **0** | slug lists ~2-monthly |
| `colophon-group/jobseek` | GitHub | 921 | 889 | 3% | 7 | ~15-20/day, reviewed |
| `outscal/OpenJobs` | GitHub | 235 | 204 | 13% | 3 | manual |
| `crypto-jobs-fyi/crawler` | GitHub | 149 | 139 | 7% | 0 | curated |
| `Mayank-glitch-cpu/JobSync-Service` | GitHub | 120 | 117 | 3% | 0 | abandoned (Apr 2026) |
| `tjwenger/job_scraper` | GitHub | 75 | 74 | 1% | 1 | hand-maintained |
| `ConorsCode/open-jobs-data` | GitHub | 71 | 70 | 1% | 1 | **cron, truly daily** |

\* `backfill`'s 0% dead rate is not a quality signal — it was filtered to live-only at
capture time. Don't read it as better-curated than the raw lists.

Notes on the picks:

- **The HuggingFace CSV is the highest-yield single source**, though at 48% dead it's also
  the noisiest. That's fine: verification is free (see below), so harvest dirty and filter.
- **`kalil0321` is the best GitHub source**, not Feashliaa — more live boards, a fifth of
  the junk, and it ships company display names.
- **`datascry/openroles` publishes its own live/dead probe status**, so dead entries are
  filtered before we ever fetch them. Covers 53 ATS families.
- **`jobseek` is the freshest**, adding reviewed companies daily. Small on Ashby, but its
  `boards.csv` covers ~40 ATS families including several nothing else here touches
  (pinpoint, recruitee, personio, smartrecruiters, rippling, workable).
- **Four sources now contribute 0 unique live boards** (`feashliaa`, `cryptojobs`,
  `jobsync`, and nearly `kalil`). They're kept because polling them is free, but they're
  the first candidates to drop if the sync ever needs trimming.

Deliberately rejected: `CarterPerez-dev/exs-cyberjob-scraper` (AGPL, and its data is a
stale copy of `kalil`), `ABHIMANYU993/OpenJobs` (unlicensed mirror of Feashliaa),
`glin23/mrweirdo-jobs` (strict subset), `Kayvan-Zahiri/state-of-ats-2026` (report slugs,
not board tokens), `joblisttoday/data` (9 months stale), `wyattowalsh/openoppsdb` (ideal
license and cadence on paper, but currently publishes 4 rows of Faker placeholder data —
worth re-checking later).

⚠️ One repo found during the search — `Somitha-git/find-companies-using-ashby-job-boards` —
ships a `.zip` containing a `Launcher.cmd` + `lua51.exe` pair, a common malware-loader
shape. It was not downloaded and is not wired in. Don't run it.

### Adding a source

Append to `sources.json` — no code changes. Slugs are extracted from full board URLs
automatically, so pointing `column`/`slugKey` at a URL field is usually most robust:

```json
{
  "id": "my-source",
  "kind": "github-raw",
  "repo": "owner/repo",
  "branch": "main",
  "files": [
    { "path": "data/boards.csv", "ats": "ashby", "format": "csv",
      "column": "board_url", "where": { "monitor_type": "ashby" } }
  ]
}
```

- `kind`: `github-raw` · `http` (any URL — an API, a HuggingFace file, an S3 object) ·
  `file` (local)
- `format`: `json-array` · `json-objects` (+`slugKey`) · `json-keys` · `text-lines` ·
  `csv` (+`column`) · `regex-scrape` (+`pattern`, optional `between`)
- Optional: `jsonPath` to descend first, `where` to filter rows (`{"not": "dead"}` works),
  `headers` with `${ENV_VAR}` so API keys stay out of the file

For slugs you add by hand, `data/manual/ashby.txt` is a plain newline list.

### Repeating the web harvest

`data/backfill/` holds a one-time capture. The repeatable part is **Common Crawl** — one
index query per new monthly crawl:

```
https://index.commoncrawl.org/collinfo.json                 # list crawl IDs
https://index.commoncrawl.org/CC-MAIN-2026-30-index?url=jobs.ashbyhq.com%2F*&output=json&fl=url&page=N
```

Yield saturates fast — 1 crawl gave 2,820 slugs, 15 gave 4,172, 49 gave 4,354. Sweep the
newest 10–15 and stop. `urlscan.io` (`?q=page.domain:jobs.ashbyhq.com`) and `hiring.cafe`
work as cheap new-board tripwires between crawls.

---

## How the merge behaves

Details that matter once this runs unattended:

- **Dedup is per ATS**, on the normalized slug. `jobs.ashbyhq.com/Acme`, `Acme`, and `acme`
  all collapse to one entry. Verified against the live API: Ashby board tokens are
  case-insensitive, so lowercasing is safe.
- **Spaces in slugs are real.** `flock safety` and `tools for humanity` are genuine Ashby
  boards. They arrive percent-encoded inside URLs and get re-encoded when called. A
  normalizer that rejected spaces would silently lose those companies — which is exactly
  what the URL-regex web harvests do.
- **A source that returns 304 or fails keeps its prior claims.** Without this, one upstream
  hiccup would read as thousands of deletions.
- **Removals are recorded, not executed.** When every source stops vouching for a slug it
  stays in `ashby.json` with `sources: []` and its last-seen date, and drops out of
  `ashby.txt`. `--prune-after=<days>` deletes them for real.
- **`dead` and `empty` are different things.** A company between hiring rounds returns `200`
  with zero jobs; a bad slug returns `404`. Conflating them would delete real companies.
  Only `404` marks a slug dead.
- **`ashby.json` is the only authority on provenance.** `ashby-verified.json` deliberately
  does not copy the source list — a `--only-unknown` run would freeze stale copies while
  the real attribution moved on.
- Workday needs a `tenant|wdN|site` triple rather than one slug, so its identifiers keep
  the pipes. Its entries aren't directly comparable across sources yet.

### Ashby API facts worth writing down

Established by probing the live API, and confirmed against the full sweep:

- `GET api.ashbyhq.com/posting-api/job-board/<slug>?includeCompensation=true` returns the
  **entire** board in one call — full descriptions included, no pagination.
  `includeCompensation` must be exactly lowercase `true`, or compensation is silently
  omitted. **37.2%** of jobs carry a usable salary figure — an early sample suggested
  71%, which the full sweep did not bear out.
- **`HEAD` works and returns zero bytes**, which is the whole reason verification is cheap:
  200 = real board, 404 = dead, at ~55 slugs/sec moving almost no data. A GET-based check
  would have pulled gigabytes — OpenAI's board alone is ~12 MB.
- **The two Ashby hosts throttle differently.** `api.ashbyhq.com/posting-api` showed no rate
  limiting at all (7,951 requests at concurrency 10, **zero** 429s).
  `jobs.ashbyhq.com/api/non-user-graphql` **does** limit, returning
  `{"error": "Rate limit exceeded"}` within a few dozen requests — that endpoint is the only
  way to get a company's display name, so `--with-names` runs at concurrency 2 with backoff.
- **Ashby has no `updatedAt` field** — only `publishedAt`. Detecting an edited posting needs
  the board `ETag` or a content hash, not a timestamp comparison.
- Cloudflare **403s a `Python-urllib/*` User-Agent**. Any explicit UA works. Easy to misread
  as throttling.

---

## Where the data lives

`data/jobs.db` (SQLite, via Node's built-in `node:sqlite` — no install step):

| Table | What's in it |
| --- | --- |
| `jobs` | One row per posting. Raw columns as published, plus `d_*` columns from the derive pass. **Filters read `d_*` only** — that's what makes an alias fix a 50-second re-derive instead of a re-sweep. |
| `job_content` | Descriptions, split out so facet scans never touch 296 MB of text. |
| `job_metros` / `job_skills` | Join tables, so a facet count is an index seek. A job can be in several metros — 76,041 rows across 61,213 jobs. |
| `metros` / `metro_aliases` | The canonical registry, built from observed strings. **This is the authority at query time** — a wrong grouping is one row edit plus a re-derive, not a code change. |
| `jobs_fts` | FTS5 over title + company + description. Join through `jobs_fts_map`. |
| `job_events` | One row per job per day it appeared/changed/vanished — what makes "new since yesterday" possible on an API with no `updatedAt`. |
| `companies`, `sweeps`, `slug_attempts` | Boards, run history, probe verdicts. |

Accounts live in a **second** database, `data/users.db`, and that split is deliberate:
`data/jobs.db` is committed to this repository, so a password hash, a session token or
someone's list of jobs they applied to must never be in it. The corpus is disposable —
delete it, re-sweep, re-derive, nothing of value is lost. An account is the opposite. See
[Accounts](#accounts).

The derive pass writes `data/derive-report.md` every run: coverage per signal, the
distribution of each derived enum, the top metros, and — most useful — every location
fragment it could **not** place, ranked by frequency. That list is the to-do list for
improving the alias table.

---

## Filtering — the profile

A **profile** is a JSON document describing what you want. It is the only place criteria
live: the app posts one, `npm run find` reads one off disk, the daily run iterates a
directory of them. Nothing is hardcoded, including location and seniority, which is what
makes someone else's search a different file rather than a different build.

`profiles/nyc-entry-level.json` is the worked example:

```jsonc
{
  "name": "nyc-entry-level",
  "title_keywords": ["implementation", "deployment", "solutions", "consultant",
                     "strategist", "ai", "product", "specialist", "analyst",
                     "associate", "operations", "technical"],
  "description_keywords": ["consulting", "implementation", "client-facing"], // gates and scores
  "description_match": "any",                                                // "all" to require every one
  "exclude_title_keywords": ["intern", "senior", "staff", "principal", "director"],
  "metros": ["nyc"],
  "workplace": ["onsite", "hybrid"],
  "max_years_experience": 2,
  "employment_type": ["FullTime"],
  "posted_within_days": 90,

  "unknowns": {                     // ← the important part, see below
    "metro": "exclude",
    "experience": "separate",
    "salary": "include"
  }
}
```

### Whose profile is it — `owner`

A profile document may name an owner:

```jsonc
{ "name": "nyc-entry-level", "owner": "elliotgreenbaum@gmail.com", ... }
```

An owned profile is listed and served **only** to a session signed in as that address.
Everyone else gets a 404 from `/api/profiles/<name>` and never sees it in the menu — 404
rather than 403, because "not yours" still tells a stranger that this address has a saved
search here. Omit the field and the profile belongs to everyone, which is what every
profile was before this existed and what a starter profile should stay.

This is a **visibility** rule, not a secret: the file sits in `profiles/` next to the
others and anyone with the repository can read it. What it buys is that nobody boots into
somebody else's job search. The app opens on the first profile the server lists, and the
server lists owned ones first — so you sign in and your criteria are already on screen,
while a signed-out visitor opens on `profiles/recent-openings.json`, which is deliberately
nobody's: full-time, posted in the last 30 days, no keywords, no city, every unknown
included.

Two consequences worth knowing:

- **The CLI ignores ownership entirely.** It reads the directory off disk, on the machine
  the database is on, where having the file is the whole authority there is.
  `npm run find -- nyc-entry-level` is unchanged.
- **The daily run reports on the owned profiles, if there are any.** Otherwise on all of
  them. A standing job search is what "what appeared overnight matching this" is for; the
  starter profile matches a third of the corpus and reporting on it every morning would
  bury the section worth reading. A fresh clone owns nothing, so there the starter is the
  only saved search there is and it is still covered. `--profiles=` overrides all of it.
- **Changing an owned profile from the app needs that session.** Saving over one, or
  deleting it, requires being signed in as its owner — even on a loopback bind, where an
  anonymous request may still write an unowned profile. Editing the file by hand is
  unaffected.

### Every criterion has three outcomes, not two

Match, no-match, and **unknown**. 24.9% of jobs carry no seniority signal, 62.8% publish no
salary, 15.9% have no location we could place. A binary filter folds those into "no" and
hides most of the market without saying so, so each of them carries a policy:

| policy | what happens |
| --- | --- |
| `include` | keep them in the results |
| `exclude` | drop them |
| `separate` | a second **"worth a look"** list underneath the main one |

Every criterion defaults to `include`: a filter may rule a job out on evidence, never on the
absence of it.

The app exposes this as its own panel — **“When a posting doesn’t say”**, at the foot of the
filter rail — one row per criterion, each printing the measured share of the corpus that
never answers it next to a `keep` / `drop` switch. Across a sixty-board survey nothing else
has an equivalent; the closest anyone gets is a single “include jobs without salary”
checkbox on a single criterion.

`separate` is honoured but not offered there: it routes jobs into a second “worth a look”
list and the page draws one result list, so a policy the page cannot render is not one the
page can set. It still works in a saved profile and on the command line, where it shows up
as the “worth a look” block in `npm run find` and in the daily report.

### What else a profile can say

Beyond the example above, all of it optional and all of it reachable from the app, the CLI
and a saved file alike:

| field | what it does |
| --- | --- |
| `sort` | `relevance` (default) · `newest` · `oldest` · `salary-high` · `salary-low` · `quality` · `company`. Every order keeps the jobs that cannot answer it — they sink to the bottom, they never vanish. |
| `collapse_duplicates` | one row per company + title. 16.6% of the corpus is one role posted once per city; the copies fold into the survivor and their locations come with them. |
| `pay_period` | `YEAR` · `HOUR` · `MONTH` · `WEEK` · `DAY` · `HALF_YEAR` · `NONE`. 1,901 open jobs are priced hourly and are invisible as a class without it. |
| `currencies` | ISO codes as the board published them — `["EUR"]`, `["USD","CAD"]`. |
| `requires_equity` | postings with an equity component. Never rules a job out: no posting in the corpus says "no equity", so silence is unknown. |
| `salary_stated_only` | pay exactly as the employer published it, excluding figures we had to reinterpret. No board in the survey offers this. |
| `remote_scope` | how far a remote role reaches — `worldwide` · `country` · `region` · `timezone`. |
| `company_size` | open roles at the company: `1` · `2-5` · `6-20` · `21-100` · `101-500` · `500+`. A proxy for size, labelled as the thing it actually counts — no ATS publishes headcount. |
| `companies` | an allow-list, by slug or display name. |
| `degree` | `none` · `bachelors` · `masters` · `phd`. |
| `requires_visa_sponsorship` / `exclude_visa_refusal` | only the postings that say they sponsor, or merely not the ones that say they won't. |
| `exclude_clearance` | drop the 896 postings naming a security clearance. |
| `exclude_skills` | the negative half of the skills list. Stack Overflow Jobs paired "tech you like" with "tech you dislike" and no live board has copied it. |

Salary bands are cut from the figures in **your** current result set rather than from a fixed
ladder, so they describe an hourly warehouse search and a staff-engineer search differently.

### Running it

```bash
npm run find                                 # the default profile
npm run find -- nyc-entry-level --why        # named, with the score breakdown
npm run find -- --metros=nyc,boston --max-years=3
npm run find -- --facets                     # what loosening each filter would buy
npm run find -- --new-since=yesterday        # only jobs that appeared since
npm run find -- --sort=newest --collapse     # order it, fold duplicate postings
npm run find -- --pay-period=HOUR            # the 1,901 hourly jobs
npm run find -- --equity --salary-stated     # equity, and pay as published
npm run find -- --unknown-salary=exclude     # only postings that published a figure
npm run find -- --json                       # machine-readable
npm run find -- --list                       # what profiles exist
```

Every flag is a profile field, so anything the CLI can express a saved profile can too.

### How it ranks

Filtering alone isn't enough — even the tight NYC funnel returns 221 jobs. Ranking is by
**number of distinct title keywords matched** first (that's what puts `AI Deployment
Strategist` above `Product Designer`), then description hits (capped, and worth a fraction
of a title hit), recency, salary, years-fit and listing completeness. The weights are
profile fields; `--why` prints the breakdown per result.

Two rules the measurements forced:

- **Whole-word matching, never substring.** `ai` as a substring returns 355 title hits
  instead of 263 — the extras are `P-ai-d Social`, `Supply Ch-ai-n`, `Mount-ai-n View`.
- **Description keywords gate as well as score.** They used to score only, on a
  measurement saying 93.2% of jobs match at least one keyword from a typical list — a
  filter that removes 7% of the corpus is not a filter. That does not survive contact with
  a real list: the shipped profile's five terms are in 35.8% of the 61,213 open
  descriptions, against 29.5% of titles for its twelve title terms. Turning the gate on
  takes that profile from 520 matches to 252. The gate runs in FTS5 rather than in the
  word-boundary matcher, because that is where the 296 MB of prose already is — slightly
  broader on hyphenated terms (`client-facing` also finds `client facing`) and never
  narrower, so it cannot drop a job the ranking pass would have credited.

---

## The app

```bash
npm run serve            # http://localhost:7799
npm run serve -- --port=8080
```

Binds to `127.0.0.1` unless you pass `--host`. The database holds a full copy of 61,213 job
descriptions and the API will serve any of them; that's fine on a laptop and not fine on a
café network, so exposing it is an explicit flag.

What it does that the CLI doesn't:

- **Every control carries a live count, and the count is leave-one-out** — how many jobs you
  would get if you *also* ticked this box, with the rest of your filters still applied.
  `New York City (453) · San Francisco Bay Area (613) · Boston (49)`. With 61,213 jobs, a
  user who picks four criteria blind and lands on zero has no way to tell which one was too
  narrow; the counts are what make it a tool instead of a guessing game.
- **The options come from the data.** The metro list is the registry the derive pass built
  from observed location strings, so a corpus that grows a new city grows a new option with
  no code change.
- **The unknown policies are visible controls**, each labelled with the share it affects.
- **The filter set is a thing you can see you own.** The header names the saved search on
  screen (`FILTER SET · NYC · entry level · solutions & operations`), marks itself *unsaved
  filters* the moment your filters stop matching it, and saves under a name you type in
  a small form on the page — which says where the set is going (your account, or
  `profiles/<name>.json`), what it will be stored as, and whether it updates the set you are
  looking at or starts a new one. The menu lists both stores together, each row carrying the
  document's own name underneath, because two sets can honestly share a label.
- **Every result opens its full audit trail** — the raw location string, which signal decided
  the workplace (`ats-enum`), which decided the seniority (`title:entry`), whether the salary
  was as-stated or reinterpreted, and the full description. Plus the link to apply.

The API underneath is six routes: `GET /api/meta`, `POST /api/search`, `GET /api/job/:id`,
`GET|PUT|DELETE /api/profiles/:name`, `GET /api/gone`, `POST /api/interpret`. `POST /api/search`
takes the same profile document as the CLI. [Accounts](#accounts) add `/api/auth/*` and
`/api/me/*` on top of those, and change none of them.

### Describe your search, and let it fill the filters in

**Optional, off by default, and nothing is behind it.** The panel at the top of the rail
takes a sentence — typed or dictated — and sets the forty controls below it:

> *entry-level ops or solutions roles in NYC, I'd take remote too, nothing needing a
> security clearance*

...becomes five title keywords, four title exclusions, `metros: ["nyc"]`,
`remote_counts_as_match: true`, a two-year experience cap, `job_functions: ["operations"]`
and `exclude_clearance: true` — the same profile document you would have built by hand, and
the same one the CLI and the daily run read. There is no second search path: it writes
`profile` and the page redraws.

Three things about how it behaves, each of which is a decision rather than an accident:

- **It shows its work and it is one click to undo.** Every criterion it set is listed in the
  page's own words (`+ metro in nyc`, `− posted within 30 days`), so you are reading what the
  *engine* now holds, not the model's account of itself. **Undo** puts back exactly the
  filters that were there a second before.
- **It cannot exclude a job for staying silent.** The [three-outcome rule](#every-criterion-has-three-outcomes-not-two)
  is the one a language model is most likely to break, because "at least $150k" reads like an
  instruction to drop everything that doesn't say $150k — and that would discard 74.2% of the
  market without a word on screen. So the unknown policies are not a field it can write.
  It gets one narrow list, `exclude_when_unstated`, and it may only fill that in when you
  asked for it in so many words.
- **It says what it could not do.** A place it can't find is named on screen and sets no
  filter (never a criterion that quietly matches nothing), and anything these filters can't
  express — culture, team size, "somewhere I can grow" — comes back as
  *Couldn't filter on that: …* rather than being approximated with keywords that would
  narrow your search behind your back.

**Turning it on.** It needs an [Anthropic API key](https://console.anthropic.com/settings/keys),
and until it has one the panel says so and does nothing else:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run serve
```

...or put it in `config/anthropic.json` (gitignored, same as the Google OAuth secret):

```json
{ "api_key": "sk-ant-...", "model": "claude-opus-5" }
```

Each press is one API call — roughly 6k input tokens and 500 output, well under a cent on
`claude-opus-5`. `ANTHROPIC_MODEL` overrides the model. This is the project's only network
dependency at *query* time and its only npm dependency at all; with no key set, the server
never loads the SDK and the app is exactly what it was.

**It is capped at 30 calls per hour per person** — per account where there is one, per
socket where there isn't (`ANTHROPIC_CALLS_PER_HOUR`, `0` to remove it). This is the only
route in the project whose worst case is a bill rather than a slow page, and the deployed
copy is open to anyone who signs up. The cap is taken at the line that spends, so a failure
that costs nothing — a rejected key, an unreachable API — gives the call back; mistyping
your key should not lock you out at the moment you are trying to fix it.

**Dictation is your browser's, not ours.** The Speak button is the built-in
`SpeechRecognition` API — no key, no dependency, and it does not appear in a browser that
lacks it. In Chrome it sends the audio to Google, which is a surprising thing for a tool
whose whole pitch is that it runs on your laptop, so the hint under the button says so.

**The vocabulary is generated, never written down twice.** The list of job functions,
seniority bands, pay periods, skills and ATSes the model chooses from is built from
`schema.mjs` and the live corpus — the same rule the metro dropdown follows. Places are the
one exception and get a hybrid: the 200 busiest metros are served as ids to pick from (60.3%
of every placed job, 4 KB of prompt), and everything else is free text resolved against the
full 24,576-row registry by exact match only. Fuzzy matching was tried and removed — on a
registry built from raw location strings it turned "Germany" into a two-job metro *labelled*
"Germany Berlin" and found *something* for every unrecognised word. Knowing that "the Bay
Area" is `sf-bay` is the model's job; it does it correctly, and a `LIKE` cannot.

### Why the filter is in memory, not in SQL

The obvious build is one `WHERE` clause per criterion. It was measured and rejected: facet
counts have to be leave-one-out, so each dimension is its own query, and the title gate ends
up expressed twice — as FTS for SQL and as word-boundary regex for ranking — with two
different notions of what a word is.

Loading the 20 hot columns for all 61,213 open jobs takes **388 ms and ~190 MB**, and every
query after that runs in **74–160 ms** with all nine facets computed in the same pass, using
the same matcher the derive pass is regression-tested against. The cold 296 MB of
descriptions stays in SQLite and is read only for rows that survived the filter. The index
is cached and invalidated on the derive generation, so a re-derive is picked up without a
restart.

---

## Accounts

**Optional, and nothing is behind them.** Signed out, the app is exactly what it was: every
job, every filter, every leave-one-out count, every description and every apply link. There
is no gate, no nag, and no reduced mode. What an account adds is *memory*:

- **Your filters, kept.** The working filter document is saved as you change it and restored
  when you come back, so a search you spent ten minutes building is still there tomorrow.
  Named profiles save to your account too, alongside the shared `profiles/*.json` files —
  the same JSON document either way, listed together in the profile menu.
- **Starred jobs.** A ★ on every result. Signed out it goes to the sign-in screen rather than
  disappearing, because a control that vanishes teaches nobody what an account is for.
- **What you did about them.** Each saved job carries a status — saved / applied /
  interviewing / offer / rejected — and a note to yourself.
- **Curated lists.** Any number of named buckets ("dream jobs", "apply this week"),
  orthogonal to status, because "apply this week" and "applied" answer different questions.

The saved view is *not* a filtered view of the corpus. It shows everything you starred,
including postings the board has since pulled — tagged `no longer listed`, or
`not in this corpus` if the database was rebuilt under it. Each saved row carries a snapshot
of the title, company and URL taken at save time, so **"did I ever apply to this" keeps
answering after the posting is gone**, which is the whole point of writing it down.

```bash
npm run serve                          # accounts on, optional
npm run serve -- --no-accounts         # exactly the Phase 6 server
npm run accounts -- --list             # who exists, and what they hold
npm run accounts -- --passwd=<email>   # there is no mail server; this is the reset path
npm run accounts -- --delete=<email>   # account, saved jobs, lists, profiles
```

### Sign in with Google

Supported, and dormant until you configure it — with no client id the button is never drawn
and the password form is the whole dialog. To turn it on:

1. In the [Google Cloud console](https://console.cloud.google.com/apis/credentials), create
   an **OAuth client ID** of type *Web application*.
2. Add `http://localhost:7799/api/auth/google/callback` as an authorized redirect URI
   (Google allows plain `http` for `localhost` only — anything else needs HTTPS).
3. Put the credentials in `config/google-oauth.json` (gitignored):

   ```json
   { "client_id": "…apps.googleusercontent.com", "client_secret": "…" }
   ```

   or set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in the environment. Restart the server.

It is the authorization-code flow with PKCE, not the one-tap credential: the token exchange
happens server-to-server over TLS with the client secret, so the server's evidence never
passes through the browser. An account is linked to an existing one **only** when Google
says the address is verified — an unverified assertion is how "sign in with Google" becomes
an account takeover, so it is refused rather than guessed.

The connectors in a Claude session (Gmail, Drive, Calendar) are a different thing entirely:
they authenticate *Claude* to your Google account for tool use. They cannot log a visitor
into this app.

### What holds it up

| | |
| --- | --- |
| Passwords | scrypt, N=16384 — ~95 ms per attempt, ruinous for an offline guessing run. Parameters stored in the hash, so raising them later doesn't lock anyone out. |
| Sessions | 256 bits of CSPRNG in an `HttpOnly; SameSite=Lax` cookie. The database stores only its SHA-256, so a stolen copy of `users.db` cannot be used to log in as anyone. |
| CSRF | `SameSite=Lax` **and** a same-origin check on every write. Neither is trusted alone. |
| Enumeration | Wrong password and unknown address return the same message, and take the same time — the miss path hashes a dummy so it can't be timed. |
| Rate limits | Per (address, IP), separate counters for login and signup, in memory. |
| Isolation | Every store function is scoped by `user_id`; no route takes a user id as a parameter, so there is nothing to forge. |

**Over plain HTTP a password is a password in the clear.** The server binds to `127.0.0.1`,
where that is between you and your laptop. Exposing it with `--host` and keeping accounts on
means passwords and session cookies crossing the network unencrypted — put TLS in front of
it, or run `--no-accounts`. The startup banner says so out loud. On a non-loopback bind,
writing a *shared* `profiles/*.json` also starts requiring a session, since that directory
is the one the CLI and the daily run read.

---

## The daily run

```bash
npm run daily                          # sync → verify → sweep → derive → diff
npm run daily -- --report-only         # skip the pipeline, just re-report
npm run daily -- --skip-sync           # or --skip-verify / --skip-sweep / --skip-derive
npm run daily -- --profiles=nyc-entry-level
```

With no `--profiles`, it covers the profiles that name an [`owner`](#whose-profile-is-it--owner) —
somebody's standing job search — and falls back to every profile in the directory when
nothing is owned, which is what a fresh clone sees.

The output that matters is the last step. A profile matching 221 jobs is worth reading once;
re-reading it every morning is not. What changed overnight is a handful of postings, so
`data/daily-report.md` leads with **what appeared since the previous run** and keeps the
standing list as a footnote. `data/daily-history.jsonl` gets one line per run forever —
the record of how much this actually moves day to day.

Ashby publishes no `updatedAt`, so none of this is a timestamp comparison: it comes from
`job_events`, which the sweep writes one row per job per day it appeared, changed,
reappeared or vanished. An *edited* posting is detected by the content hash. The diff runs
the new ids back through the ordinary filter engine rather than reimplementing the
criteria, so "new and matching my filters" can't drift from "matching my filters".

Each stage runs as its own process. A sweep that dies on a network error produces a report
with a gap in it and a `**failed**` row, not a missing report.

> The event log currently holds a single sweep day, so today every open job counts as new.
> The diff becomes meaningful from the second run onwards — the report says so itself
> rather than reading as a spectacular morning.

### Automation

```bash
npm run schedule                       # write both files, install nothing
npm run schedule -- --at=08:15
npm run schedule -- --install          # macOS launchd, explicit opt-in
npm run schedule -- --status
npm run schedule -- --uninstall
```

Writes `automation/com.jobfinder.daily.plist` and `.github/workflows/daily.yml` and
schedules **nothing** until asked. A background job that starts running because a script was
executed once is the kind of surprise this project shouldn't have.

| | launchd | GitHub Actions |
| --- | --- | --- |
| Runs when the laptop is asleep | no — missed runs are dropped, not queued | yes |
| Setup | one command | commit + push the workflow |
| Where the 1.0 GB database lives | your disk | rebuilt each run from the sweep, cached between runs |
| Accounts needed | none | a GitHub repo |

`launchd` dropping missed runs is the right behaviour here: the sweep is a full refresh, not
an increment, so catching up on three skipped mornings would do the same work three times
for the same answer. The Actions workflow restores the previous database from the run cache
before sweeping — without that the `job_events` history is empty and the diff has nothing to
compare against.

---

## What's built

- [x] Aggregate slugs from GitHub repos *and* non-GitHub web sources, dedupe with provenance
- [x] Detect upstream changes cheaply (ETag / 304)
- [x] Verify slugs against the live Ashby API; separate dead from merely-empty
- [x] Report which sources are actually earning their place
- [x] Sweep all 4,297 live Ashby boards and store the jobs
- [x] Normalize location, salary, seniority, workplace into canonical columns
- [x] Filter: keywords, location, workplace, seniority, salary, age — three-valued throughout
- [x] Rank, so a 221-job result reads from the top
- [x] A local app whose every control shows what it would cost you
- [x] Optional accounts: kept filters, starred jobs, application status, curated lists —
      with the signed-out app unchanged and password-free Google sign-in available
- [x] "What's new since yesterday", and a daily run behind it
- [x] launchd and GitHub Actions artifacts, installed only on request
- [ ] Extend the sweep to Greenhouse and Lever (endpoints already confirmed working)
- [ ] Fetch real company display names (all 4,297 are currently title-cased slugs)
- [ ] Merge the duplicate metros the derive pass mints (`sf-bay` vs `san-francisco-bay`) —
      visible in the app's metro list, fixed by an alias edit plus a re-derive

The messy fields below are now handled — this is what the derive pass does, kept here
because the reasoning still explains the shape of the data:

- `location` is a **single free-text string** (`"New York, NY (HQ)"`, `"Remote U.S."`,
  `"Europe"`). There's a structured `address.postalAddress` too, but it's user-entered and
  dirty — real values include `"San Fransisco"` (typo) and `"California "` (trailing space),
  with `USA` / `United States` / `European Union` used interchangeably. City filtering needs
  a normalization layer, not a string match.
- `isRemote` is **nullable** — `true`, `false`, *or* `null` (14.6% of jobs measured on
  the full sweep). It is also a trap: every Hybrid job reports `true`. `d_workplace` is
  derived from `workplaceType` instead, falling back to the location text.
- Salary should come from `compensation.summaryComponents` (pre-flattened min/max), not the
  prose `compensationTierSummary`.
