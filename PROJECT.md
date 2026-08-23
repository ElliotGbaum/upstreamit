# Job Finder ATS — project notes

Durable context: what this is, what's been established, what was ruled out, and what
happens next. `README.md` is the operational doc (how to run things); this is the
reasoning behind it.

Last updated: 2026-08-22

---

## The goal

Find jobs worth applying to, without depending on job boards that hide, stale, or
rank-manipulate their listings.

Companies that use an ATS (Applicant Tracking System — the software that runs their
careers page and application flow) expose their open roles through a public API. Ashby,
Greenhouse, Lever and others all do this. If you know a company's **slug** — the short
name in `jobs.ashbyhq.com/<slug>` — you can pull their entire job list in one request,
free, no key.

So the whole problem is: **get every slug, then filter the resulting jobs hard.**

Ashby came first, then Greenhouse, then Lever — all three are swept. The next
candidates (Workday, BambooHR, Paylocity, iCIMS) have slugs collected but no adapter
and no probe yet.

---

## Status

| Phase | State |
| --- | --- |
| 1. Collect slugs from public sources | **Done** |
| 2. Verify each slug against the live API | **Done** |
| 3. Sweep the live boards, store the jobs | **Done** — 337,487 jobs across Ashby, Greenhouse and Lever |
| 4. Normalize the messy fields (location, salary, seniority) | **Done** — see below |
| 5. Filter by your criteria | **Done** — ~800 ms warm over the full corpus |
| 6. UI + daily automation + "what's new since yesterday" | **Done** — app, diff, and both runners written |
| 7. Accounts | **Done** — see below |
| 8. Greenhouse as a second ATS, + the ATS filter | **Done 2026-08-22** — see below |
| 9. Lever as a third ATS | **Done 2026-08-22** — 71,789 jobs on 2,025 boards; see below |
| 10. Describe the search in words instead of forty controls | **Done 2026-08-22** — optional, off without an API key, and the one thing that needs an account; see below |

Everything below the sweep line is now measured on the **full corpus** rather than
the 400-board sample, so where the two disagree the numbers here supersede the
sampled estimates further down. Three moved materially — salary coverage, seniority
classification, and NYC's share — and each is called out where it appears.

**Where the numbers landed:**

```
     7,951   candidate slugs collected from 11 sources
       │
       ├──  3,654   →  404 Not Found      (discarded — confirmed absent)
       │
       └──  4,297   →  200 OK             (confirmed real boards)
                          │
                          ├──  ~11%  exist but zero openings right now
                          └──  ~89%  actively hiring  →  ~60,500 open jobs
```

---

## How much did the extra sources actually buy?

You asked this directly, so here it is measured rather than asserted. Sampled 250 boards
from each group and counted their real job listings.

| | Boards | Hiring now | Avg jobs/board | Est. open jobs |
| --- | --- | --- | --- | --- |
| Feashliaa alone (your original repo) | 2,478 | 91% | 16.6 | **~41,300** |
| Everything else added | 1,819 | 81% | 10.6 | **~19,300** |
| **Total** | **4,297** | | | **~60,500** |

**+73% more companies, +47% more jobs.**

The gap between those two percentages is the interesting part. The boards we added are
*smaller on average* — 10.6 jobs vs 16.6 — because Feashliaa's list skews toward
well-known companies that everyone's scraper already found. But the **median is identical
at 7 jobs each**, meaning the average difference comes from a handful of giant boards, not
from the new companies being junk. And 81% of them are actively hiring. These are real
companies, just less famous ones.

Whether that's "worth it" depends on what you're after. If you only want to apply to
companies you've heard of, Feashliaa's list was mostly sufficient. If you want the
less-contested postings — the ones with fewer applicants precisely because they're harder
to find — the added 19,300 jobs are the ones that matter.

### Did we hit a limit?

**Yes, roughly — for free public sources.** Three independent lines of evidence:

**1. The marginal-gain curve collapsed.** Live boards contributed by each source that *no
other source had*:

```
backfill (web crawl)  113
hf-latmay              45
openroles              11
jobseek                 7
outscal                 3
kalil                   2
tjwenger                1
openjobsdata            1
feashliaa               0   ← your original repo now adds nothing unique
cryptojobs              0
jobsync                 0
```

**2. Web-crawl archives saturate almost immediately.** Searching one month of Common Crawl
found 2,820 slugs. Fifteen months found 4,172. Forty-nine months found 4,354. Nearly
everything is in the first couple of months; the rest is churn.

**3. Capture-recapture says we're near the ceiling.** This is the technique used to
estimate fish populations: tag a batch, release, catch a second batch, and the fraction
already tagged tells you how much of the lake you've sampled. Treating two sources as the
two catches, every pairing estimated a total population of **3,800–4,250** — at or below
what we've already found.

The honest caveat on #3: that method assumes the two samples are independent, and these
sources aren't — they copy each other and all ultimately crawl the same web. Correlated
samples bias the estimate *low*. So the correct reading is **"the free public sources are
exhausted,"** not "4,297 is the true total." There is certainly some unknown remainder;
it's just not reachable by collecting more lists.

What could still move the number:

- **Common Crawl, refreshed monthly** — free and repeatable, catches boards that launched
  since. Tens per month, not hundreds.
- **Slug mutation** (your idea — see below) — untested, genuinely promising, costs nothing.
- **TheirStack**, ~$400 — the only vendor with real Ashby data. Claims 14,006 companies,
  but that counts job-posting *mentions*, not boards, so it's heavily inflated.
- **Guess from company directories** — measured and bad: 75 Y Combinator companies produced
  125 slug guesses and exactly 1 hit.

---

## Your idea: mutate the failed slugs

**Parked for later, but worth doing.** Of the 7,951 candidates, 3,654 returned 404. Some
fraction of those are almost certainly real companies whose slug was recorded with the
wrong punctuation — a scraper that turned `flock safety` into `flock-safety`, or dropped a
`.ai`, or added `-inc`.

This is unusually cheap to test because verification is free: HEAD probes run at ~55/sec
with no rate limiting, so even 30,000 generated variants is a ~10-minute run.

Concrete plan when we get to it:

1. Take the 3,654 dead slugs as seeds.
2. Generate variants per seed:
   - separator swaps: `-` ↔ `_` ↔ `.` ↔ ` ` ↔ removed
   - suffix add/remove: `-inc`, `-hq`, `-io`, `-ai`, `-labs`, `-co`, `.ai`, `.com`, `.io`
   - `&` ↔ `and`, digit ↔ word (`0x` / `zerox`)
   - singular/plural, and de-duplicated doubled letters
3. **Also mutate from company display names**, not just failed slugs. `kalil0321`'s CSV
   ships real company names, so `Flock Safety` generates `flocksafety`, `flock-safety`,
   `flock safety`, `flock`. This is likely the higher-yield direction — it starts from
   ground truth rather than from a corrupted string.
4. Drop any variant already in the 7,951 tried.
5. HEAD-probe the remainder; keep the 200s.
6. **Measure the hit rate and record it here** — if it's under ~0.5%, say so and stop
   rather than keeping a permanently-running mutation loop.

Risk to watch: this is the one part of the pipeline that generates traffic without a prior
reason to believe the slug exists. Keep concurrency modest and don't re-probe known-dead
variants on every run — cache them.

---

## How discovery actually works

Worth writing down because it constrains everything else.

**There is no way to ask Ashby for a customer list.** Every collection endpoint
(`/job-board`, `/job-boards`, `/companies`) returns 401 Unauthorized. There's no sitemap
(`jobs.ashbyhq.com/sitemap.xml` returns the app shell, not a sitemap), no `Sitemap:` line
in `robots.txt`, and no public customer directory.

You can only ask about one slug at a time. So discovery is: **collect candidate names from
anywhere, then ask the server about each.** The sources are lists of guesses; the API is
the oracle that tells you which guesses are right.

The pipeline is three steps:

1. **Collect** — 11 sources, each in a different format. Config in `sources.json` says
   which column to read and how to parse it. No code changes to add one.
2. **Normalize and dedupe** — `jobs.ashbyhq.com/Acme`, `Acme`, and `acme` are one company.
   Everything collapses to a canonical form. Provenance is kept (which sources vouched for
   each slug) so it's possible to tell when a source stops earning its place.
3. **Verify** — a HEAD request per slug. HEAD asks "does this exist?" without downloading
   the content: 200 means real, 404 means no such board. This is what makes the whole thing
   practical — downloading each board for real would move gigabytes.

---

## Established facts — Ashby API

Empirically verified, not from docs. These constrain the next phase.

- **One request returns an entire board**, full job descriptions included. No pagination.
  ```
  GET https://api.ashbyhq.com/posting-api/job-board/<slug>?includeCompensation=true
  ```
- `includeCompensation` **must be exactly lowercase `true`**. `True` or `1` return HTTP 200
  and silently omit all salary data. Easy silent-data-loss bug.
- **HEAD works and returns zero bytes** — the basis of cheap verification.
- **No rate limiting on `api.ashbyhq.com/posting-api`** — 7,951 requests at concurrency 10,
  zero 429s, ~55 req/s.
- **`jobs.ashbyhq.com/api/non-user-graphql` DOES rate limit** — returns
  `{"error": "Rate limit exceeded"}` within a few dozen requests. That host is the only way
  to get a company's *display name*, so name fetching runs at concurrency 2 with backoff.
  (Earlier research claimed Ashby had no rate limiting at all; that was only true of the
  REST host, and the distinction cost a debugging cycle.)
- **There is no `updatedAt` field** — only `publishedAt`. Detecting an *edited* posting
  requires storing the board's ETag or hashing the content. A timestamp comparison won't
  work.
- **Cloudflare 403s the `Python-urllib/*` User-Agent.** Any explicit UA works. Looks exactly
  like throttling if you don't know.
- **Slugs are case-insensitive**, so lowercasing is safe. But **spaces in slugs are real** —
  `flock safety` and `tools for humanity` are genuine boards, percent-encoded in URLs. Any
  URL-regex harvest mangles these; they only survive because the normalizer handles them.
- **404 and "zero jobs" are different.** A company between hiring rounds returns 200 with an
  empty list. Only 404 means the board doesn't exist. Conflating them deletes real companies.
- **`includeCompensation` is the *only* query parameter that does anything.** Tested against
  a live 136-job board: `?location=`, `?department=`, `?employmentType=`, `?workplaceType=`
  and `?limit=` each returned all 136 jobs, unchanged. There is no server-side filtering,
  search, or pagination. **Every filter we build is client-side over swept data** — which is
  the better arrangement anyway, since it turns filtering into a local query instead of
  thousands of round-trips.

---

## Phases 3 and 4 as built — the full-corpus numbers

The sweep and the normalization pass both run. Everything in this section is
counted over all 61,213 jobs, not sampled.

### The sweep (Phase 3)

4,297 boards fetched in **24 seconds**, 823 MB of JSON, zero errors, zero rate
limiting. 3,764 boards were hiring, 519 were real but empty, 14 had died since
verification. `data/jobs.db` holds the jobs, the full descriptions (296 MB of
text), and a per-day event log.

### The normalization pass (Phase 4)

`node src/derive.mjs` — pure function of the swept data, no network, ~50 seconds
for all 61,213 jobs including the full-text rebuild. That runtime is the point:
improving a metro alias or a title rule costs a re-derive, never a re-sweep.

| Signal | Coverage | Notes |
| --- | --- | --- |
| workplace | **98.9%** | onsite 27,118 · hybrid 15,932 · remote 17,508 |
| metro | **84.1%** | 3,178 distinct metros discovered |
| salary (USD/yr) | **37.2%** | annualised and FX-converted |
| years of experience | **55.9%** | parsed from description text |
| seniority | **75.1%** | title rules, then years, else `unknown` |

Also written: `job_metros` (76,041 rows — a job averages 1.2 metros), `job_skills`
(161,350), `metros` + `metro_aliases` (3,178 / 3,461), and an FTS5 index over
title + company + description. The database is now **1.0 GB**.

### Four corrections to the sampled estimates

The 400-board sample was directionally right and wrong in the details. Where they
conflict, believe these:

- **Salary coverage is 37.2%, not 41.5%** (and not the 71% the README claimed
  before that). The direction of the design decision is unchanged and now
  stronger: a hard salary floor discards **six jobs in ten**.
- **Seniority classifies 75.1%, not 84.6%** — so `unknown` is **24.9%**, not
  15.4%. A quarter of the board being unclassifiable makes the three-state rule
  load-bearing rather than tidy. These are stricter rules than the sample's:
  `Account Manager` is not a people manager and `Solutions Architect` is not
  principal-level, both of which cost coverage and buy accuracy.
- **NYC is 14.2% of the board, not 16.7%** — 8,702 jobs.
- **`isRemote` held up exactly as measured.** All 15,932 Hybrid jobs report
  `isRemote = true`, and `isRemote = false` ⟺ `OnSite` with no exceptions in
  61,213 rows.

### Elliot's funnel, measured for real

```
61,213  100.0%   all open jobs
 8,702   14.2%   in New York City
 7,384   12.1%   ...and in-person (OnSite or Hybrid)
 2,398    3.9%   ...and title matches a role keyword
   328    0.5%   ...and entry level (≤2 yrs)     ← the result set
   419    0.7%   ...seniority unknown            ← surfaced separately
```

**328 jobs, plus 419 worth a second look.** The sampled projection was ~344 plus
~226, so the result set landed almost exactly where predicted and the unknown
pile came in nearly twice as large — which is the 24.9% unknown rate showing up
where it matters.

> **Two corrections, 2026-08-21**, now that the filter engine exists and these
> can be run rather than counted by hand.
>
> - The result set read **276**. That number is reproducible and it is a correct
>   count of *"band is entry or junior **and** the description states ≤2 years"*.
>   The engine returns **328** because it also admits the 52 postings whose title
>   classifies them as entry or junior while the description names no figure at
>   all. Dropping those would hide entry-level jobs for the sole offence of not
>   quoting a number, so the wider reading is the one that shipped.
> - The unknown pile read **471** and does not reproduce under any reading; it is
>   **419**. Worth knowing why there is no second reading to check: in this corpus
>   `d_seniority = 'unknown'` is exactly `d_years_known = 0`, because a posting
>   with no title marker still gets a band from its stated years. Unknown
>   seniority and unstated years are the same 419 jobs.

Top of the ranked list, and a good smoke test that the whole chain works:
`Deployment Associate, AI Solutions` (Brellium, 4 keywords, hybrid, 0 yrs,
$85–125k), `Product Operations Associate` (Fortuna Health), `AI Deployment
Strategist` (Axion, $135–180k), `Client Solutions Analyst` (Mednet). All four
still surface at the top of what the shipped profile returns.

### Decisions made during Phase 4 that are worth not re-litigating

- **Multiple experience claims: strictest wins.** 15.8% of postings state more
  than one figure and those disagree 82.5% of the time, median gap 3 years. A
  posting wanting "5+ years in sales" and "1+ year with Salesforce" is a
  five-year job. Taking the smallest would have moved 267 jobs per 8,744 into
  "≤2 years" — 23% of that bucket — and the cost is asymmetric: a missed junior
  job is invisible, a flood of senior ones makes the list useless.
- **The interval field lies, so salary is sanity-checked.** 154 rows carry
  `YEAR` with a value under $1,000 (a $30–50/hr inspector) and 54 exceed $1M.
  Each figure is reinterpreted under whichever interval makes it plausible
  ($5k–$2M/yr); if none does, the job is `salary_known = 0` rather than carrying
  a confidently wrong number into a filter. `d_salary_src` records which.
- **Unrecognised places yield no metro rather than a guess.** Address lines were
  minting metros — one Korean office block became `pangyo-software-dream-center`,
  `gyeonggi-do` and `pangyo`, three "metros" of 97 jobs each. Fragments with
  digits, facility words, or more than four words are now rejected and reported
  instead. The unmatched list in `data/derive-report.md` is the to-do list.
- **Company names are derived from slugs, visibly.** Ashby's posting API returns
  no company name, so all 4,297 boards landed nameless and every result read
  `notion` instead of `Notion`. The slug is title-cased and marked
  `name_source = 'slug'` — a labelled guess, overwritten the moment a real name
  arrives. Getting real names means the rate-limited GraphQL host or `kalil0321`'s
  data, and is worth doing before the UI ships.
- **FX rates are static, as of 2026-08.** They touch 13.5% of the 37% with a
  figure — about 5% of the board — and a 10% drift does not change whether a
  €120k listing clears a $100k floor.

---

## Phases 5 and 6 as built

The filter engine, the app, the diff and the two automation artifacts. Everything
in this section is measured against the live 61,213-job corpus.

### Where the numbers landed

| | |
| --- | --- |
| Full-corpus filter run | **74–160 ms**, all nine facets counted in the same pass |
| Index build (once, cached) | **388 ms**, ~190 MB for the 20 hot columns × 61,213 rows |
| The shipped profile | **221** matches + **232** worth a look |
| Same profile without the age cap and title exclusions | **328** + **419** — the funnel above |
| Tests | **176** — 82 derivation, 94 filter — no database, no network |

### The shape of it

```
profiles/*.json        the criteria, as a portable document
  │
  ├── src/find.mjs         terminal
  ├── src/server.mjs       the app at :7799  ──  app/
  └── src/daily.mjs        pipeline + "what's new", writes data/daily-report.md
        │
        └── src/lib/filter/
              profile.mjs  the document: defaults, validation, seniority bands
              match.mjs    one criterion, one function, three outcomes
              rank.mjs     scoring
              diff.mjs     what appeared / changed / vanished, from job_events
              index.mjs    the in-memory index, the query, the facets
```

Three consumers, one engine. The diff does not reimplement the criteria — it
restricts the id set and runs the same `search()`, which is the only way "new and
matching my filters" can be guaranteed not to drift from "matching my filters".

### The decision worth writing down: the filter is in memory, not in SQL

The obvious build is one `WHERE` clause per criterion and a `GROUP BY` per facet.
It was measured and rejected for two reasons that only show up once you try it:

1. **Facet counts have to be leave-one-out.** "How many more jobs if I also tick
   Boston" is not the result-set query with a `GROUP BY` on the end — it is the
   query with the metro criterion *removed*. That is one query per dimension, and
   nine dimensions means nine near-duplicate SQL statements that have to stay in
   step with each other and with the result query.
2. **The title gate would have to exist twice.** SQL wants FTS5; ranking wants the
   word-boundary matcher from `src/lib/derive/text.mjs` that knows `Paid` does not
   contain `ai`. Two matchers with two different notions of a word, one of which
   decides what you see and the other how it is ordered.

Loading the hot columns costs 388 ms and ~190 MB once. Every query after that is
74–160 ms with all facets in one pass, using the same matcher the derive pass is
regression-tested against. The 296 MB of descriptions stays in SQLite and is read
only for rows that survived — 453 rows for the shipped profile, ~200 ms — and
above a configurable ceiling the engine says it skipped the description scoring
rather than quietly not doing it.

Full-text search and description *exclusions* still run in SQLite, because that is
where the prose lives and FTS5 is already built over it. They produce id sets the
in-memory pass intersects. Exclusions specifically had to be there rather than
applied afterwards, or every facet count would be a small lie.

### Three-valued, end to end

The design rule from Phase 4 turned out to be the load-bearing one. Each criterion
returns `match` / `no` / `unknown`, and the profile's `unknowns` block decides what
happens to the third:

| criterion | unknown share | shipped default | why |
| --- | --- | --- | --- |
| location | 15.9% | **exclude** | a job with no parseable location is not plausibly in your city, and 9,741 of them would swamp any metro filter |
| seniority | 24.9% | **separate** | 232 jobs against 221 confirmed — too many to drop, too many to mix in |
| salary | 62.8% | include | a silent floor is the most destructive thing this filter could do |
| workplace | 1.1% | include | small enough not to matter either way |
| employment type / date | ~0% | include | |

Location is the one deliberate deviation from "default to include", and it is a
toggle in the app like the rest, with the affected share printed beside it.

The `separate` bucket has one rule worth not breaking: a job qualifies only if
every non-separate criterion is satisfied *and* it is unknown on at least one
separate criterion. Without that last clause the aside list is a copy of the
result list.

### Decisions made during Phase 5 that are worth not re-litigating

- **The title band and the stated years must agree.** Either signal alone fails,
  in opposite directions: years alone lets `Senior Engineer` through whenever the
  description happens not to state a number (44.1% of postings), and the band
  alone lets `Associate Consultant — 8+ years required` through. Requiring both
  costs 25 senior-titled postings that state ≤2 years, and that is the point.
- **A title-only classification still counts.** 52 NYC postings are entry or
  junior by title and name no figure at all. Requiring a stated number would hide
  them for the offence of not quoting one.
- **`intern` is excluded from a years cap unless asked for.** An internship is
  not an entry-level job, and `employment_type` does not reliably separate them:
  437 jobs carry `Intern` as their type while others post internships as
  `FullTime`.
- **A salary floor compares against the top of the range.** A $90–140k posting is
  a live answer to a $100k search; comparing on the bottom would drop it.
- **A range top can clear an experience floor, a bare figure cannot.** "2–6 years"
  satisfies a 5-year minimum; "2 years" does not.
- **`remote` does not match a metro filter by default.** Remote roles carry a
  country and a scope but no metro, so they are excluded by construction. That is
  the right answer for "an office in New York" and the wrong one for "a job I can
  do from New York", so it is one flag — `remote_counts_as_match` — rather than a
  default. (This settles open question 5.)
- **A typo'd enum warns instead of returning nothing.** `workplace: ["wfh"]`
  silently matching zero jobs is the exact failure the facet counts exist to
  prevent, so the profile normalizer drops it and says so.
- **Malformed FTS is a warning, not a crash.** `implementation AND` is a
  reasonable thing to have typed halfway through; the rest of the filter still
  runs and the syntax error comes back as a notice.

### The app

`npm run serve`, bound to `127.0.0.1` unless told otherwise — the API will serve
any of 61,213 job descriptions, which is fine on a laptop and not fine on a shared
network, so exposing it is an explicit flag.

The constraint from *The user interface* below held: **no criterion is hardcoded,
including location and seniority.** The whole page is a view over one `profile`
object; every control reads it and writes back to it; the metro list is the
registry the derive pass built from observed strings, so a corpus that grows a new
city grows a new option with no code change. Every control shows its leave-one-out
count. Every result opens its own audit trail — the raw location string, which
signal decided the workplace and the seniority, whether the salary was as-stated
or reinterpreted — because a ranked list nobody can interrogate is a ranked list
nobody trusts.

One security note, since the page renders third-party content from 4,297
companies: descriptions are inserted with `textContent`, never as the ATS's HTML.

### The daily run

`sync → verify → sweep → derive → diff`, each stage its own process so a sweep
that dies on a network error produces a report with a `**failed**` row rather than
no report. Output is `data/daily-report.md`, which leads with what appeared since
the previous run, plus one line per run appended forever to
`data/daily-history.jsonl`.

The diff comes from `job_events` rather than any timestamp, because Ashby has no
`updatedAt` — `appeared`, `changed` (content hash moved), `reappeared`,
`disappeared`. `reappeared` counts as new on purpose: a role that was pulled and
re-posted is a live opening again.

**Today the event log holds a single sweep day, so every open job reads as new.**
The report says so itself rather than presenting it as a spectacular morning; the
diff becomes meaningful from the second run onwards.

### Automation — written, not installed

`npm run schedule` writes `automation/com.jobfinder.daily.plist` and
`.github/workflows/daily.yml` and schedules **nothing**. Installing is
`npm run schedule -- --install`, an explicit opt-in, because a background job that
starts running because a script was executed once is a bad surprise.

| | launchd | GitHub Actions |
| --- | --- | --- |
| Runs while the laptop sleeps | no — missed runs are dropped, not queued | yes |
| Where the 1.0 GB database lives | your disk | rebuilt each run, cached between runs |
| Accounts | none | a GitHub repo |

Two details that would otherwise bite:

- **launchd drops missed runs rather than queueing them**, which is correct here:
  the sweep is a full refresh, so catching up on three skipped mornings would do
  the same work three times for the same answer.
- **The Actions workflow restores the database from the run cache before
  sweeping.** Without that, `job_events` is empty on every run and the diff has
  nothing to compare against — the workflow would report 61,213 new jobs every
  morning, forever. The database itself is never committed; 1.0 GB is past what a
  repo should carry.

### Still open after Phase 6

- **Which runner.** Both files exist; nothing is scheduled. One command either way.
- **Duplicate metros.** The app's metro list shows `sf-bay` alongside
  `san-francisco-bay`, and `madhive-new-york` next to `nyc` — auto-minted ids the
  derive pass never merged. Visible now that there is a UI listing them, and fixed
  by an alias edit plus a re-derive, not by code.
- **Real company display names.** Every board still reads as a title-cased slug
  (`Mistral.Ai`, `Silnahealth.Com`). This was called out in Phase 4 as worth doing
  before the UI shipped; the UI shipped first and it now looks it.

---

## Phase 7 — accounts, as built

The ask: signing up is optional; without one you get the same app; with one you keep
your filter preferences, star jobs, record that you applied, and build curated lists.

That held exactly until Phase 10, which added the first and so far only thing an
account is *required* for — "describe your search", because it spends money per
press. The rule it replaces the old one with is narrower rather than weaker:
**an account may be required to spend, never to see.** Every job, filter, count,
description and apply link is still anonymous, and nothing that worked signed out
before Phase 10 stopped working.

### The shape of it

Two new things and no changes to the old ones. `src/lib/users/` (schema, store, auth,
google, routes) owns everything about an account, and `app/account.js` owns everything
about drawing one. The search server calls into the first through a single line —
"handle this, or tell me you didn't" — and the page calls into the second through four
functions that all no-op when signed out. `--no-accounts` gives back the Phase 6 server
exactly.

### Decisions worth not re-litigating

**A second database.** `data/users.db`, not a set of tables in `data/jobs.db`. Three
reasons, in order of how much they would hurt: `data/jobs.db` is committed to this
repository, so a password hash or someone's applied-to list would become a git object;
the corpus is disposable and an account is not; and a real foreign key would mean a
corpus rebuild cascading into user data. The cost is that "my saved jobs, joined to the
jobs table" happens in JS rather than SQL, over a few dozen rows. That is not a cost.

**Saved rows carry a snapshot.** Title, company and URL as they read on the day you
starred it. Without it, a saved job whose posting has been pulled renders as a bare id —
and "did I ever apply to this" is a question you ask *precisely* about roles that are no
longer listed. The saved view says which of the three states a row is in: still listed,
`no longer listed`, or `not in this corpus`.

**Status and lists are orthogonal.** A five-value status (saved → applied →
interviewing → offer → rejected) and any number of named buckets. Collapsing them was
tempting and wrong: "apply this week" and "applied" answer different questions, and one
standing in for the other is how a tracker stops matching how anyone works. `applied_at`
is stamped once and never cleared — moving a job back to `saved` corrects where it
stands, it does not unsay that you applied.

**The working profile is not a named profile.** Two separate things: `user_settings.
working_profile` is *where you are*, written on a debounce as you change anything;
`user_profiles` is a search you decided to keep. Only the first answers "I don't want to
re-enter these", and only the second is worth a name. A saved profile is the same JSON
document as `profiles/*.json` — an account changes where a profile lives, never what one
is, so both kinds sit in one menu and the CLI is unaffected.

**The star is drawn signed out too.** It goes to the sign-in screen instead of vanishing.
A feature that is invisible until you have an account cannot explain what an account is
for, and the alternative — a banner — is worse.

**Signing in is a screen, not a modal.** `/signin`, `/signup` and `/password` all render
`app/auth.html`, which reads its mode off the path. A modal had no address, which left the
Google callback nowhere to return to and its errors nowhere to land; it inherited a 400px
column the fields were cramped inside; and it framed an account as an interruption of the
page rather than somewhere you went. The one thing the modal got for free and a navigation
has to carry is the filter document on screen when a new account is created — the header
stashes it in `sessionStorage` on the way out and the screen posts it to `/api/me/prefs`
once the account exists.

**Google sign-in is built and dormant.** The code path exists; with no client id
configured, `/api/meta` reports `auth.google: false` and the button is never drawn, so
the password form is the whole feature out of the box. Authorization-code flow with
PKCE rather than the one-tap credential: the token exchange is server-to-server over TLS
with the client secret, so the only evidence the server trusts never passes through the
browser, and no JWKS fetching or key caching is needed to believe it (OIDC Core §3.1.3.7).
Linking to an existing account happens **only** on a provider-verified address — an
unverified assertion is exactly how "continue with Google" becomes an account takeover.

**There is no mail server, so the reset path is `npm run accounts -- --passwd=<email>`.**
The authority that command requires is having the database file, which is the same
authority that could read the file directly. Building a mailer to protect it would be
theatre.

### The thing to be careful about

Accounts do not make this safe to expose. Over plain HTTP a password is a password in
the clear and the session cookie behind it is a bearer token in the clear. The server
still binds to `127.0.0.1`, the banner says this out loud on any other bind, and
`--no-accounts` is the honest answer for a shared network without TLS. One rule did
change on a non-loopback bind: writing a *shared* `profiles/*.json` now requires a
session, because that directory is the one the CLI and the daily run read and an
anonymous stranger should not be able to overwrite it.

### Still open after Phase 7

- **No email verification, and no email at all.** An address is a login handle. Fine for
  a local tool; a hosted one needs a verification step before it means anything.
- **Sessions are not listed in the UI.** "Sign out everywhere" exists; seeing *what* you
  would be signing out of does not.
- **`prompt()` for naming lists and profiles**, which is what the page already used for
  Save. Consistent, and still a browser dialog.
- **Nothing in the daily run knows about accounts.** "Here's what's new in your saved
  companies" is the obvious next thing and is not built.

---

## What's actually filterable — measured

Sampled **400 live boards → 4,760 jobs → 65 MB** of raw payloads (2026-08-15) and counted,
rather than inferring from a handful of examples. This is the ground truth Phases 4 and 5
are built on.

### Every field in the payload

| Field | Fill rate | Filterable as |
| --- | --- | --- |
| `title` | 100% | free text — **405/4,760 carry stray whitespace**; trim |
| `descriptionPlain` | 100% | free text, median 5,146 chars, never empty |
| `descriptionHtml` | 100% | display only |
| `department` / `team` | 100% | free text posing as an enum — **464** and **758** distinct values |
| `employmentType` | 100% | true enum (below) |
| `location` | 100% | free text, single string |
| `publishedAt` | 100% | date — **4.8% of live postings are >1 year old** |
| `jobUrl` / `applyUrl` | 100% | the link to display |
| `shouldDisplayCompensationOnJobPostings` | 100% | boolean; exactly predicts salary presence |
| `address.postalAddress` | 96% | structured locality / region / country / postalCode |
| `workplaceType` | 85% | enum — **the only trustworthy remote signal** |
| `isRemote` | 85% | **misleading, see below** |
| `compensation.summaryComponents` | 41.5% | structured min/max + interval |
| `secondaryLocations` | 20% | additional cities |
| `isListed` | 100% | always `true` — useless as a filter |

Enum distributions:

```
employmentType   FullTime 96.3% · Intern 1.3% · Contract 1.3% · PartTime 0.6% · Temporary 0.4%
workplaceType    Hybrid 30.1% · Remote 27.9% · OnSite 26.7% · null 15.2%
interval         1 YEAR 30.7% · NONE 9.2% · 1 HOUR 1.3% · 1 MONTH 0.3% · 1 WEEK · 6 MONTH
```

### Three corrections to earlier assumptions

- **Salary coverage is 41.5%, not 71%.** Only **37%** carry a USD figure. This turns "what do
  we do with jobs that post no range" from an edge case into a primary design decision — a
  hard salary floor discards nearly six jobs in ten. `shouldDisplayCompensationOnJobPostings`
  predicts it perfectly: 0 jobs had salary data while the flag was false.
- **`descriptionPlain` is present on 100% of jobs.** Keyword matching needs no HTML parsing.
  (`descriptionHtml` is still the right field for rendering.)
- **`department` and `team` are on 100% of jobs** — a free coarse pre-filter, previously
  unrecorded. Both are free text, so they need the same alias treatment as location if used
  for anything precise.

### `isRemote` is a trap — use `workplaceType`

```
1417   Hybrid | isRemote=true
1273   OnSite | isRemote=false
 672   Remote | isRemote=true
 656   Remote | isRemote=true  (location string also says "remote")
 724   null   | isRemote=null
```

`isRemote` is `true` for **every** Hybrid job. It means "not fully onsite," not "remote."
Filtering `isRemote === false` to get in-person roles silently discards all 1,435 hybrid
jobs. `isRemote === false` ⟺ `workplaceType === "OnSite"` exactly, so the boolean carries no
information the enum doesn't.

For the 15% where `workplaceType` is null, fall back to the location string — of 724 nulls,
only 50 mention "remote," so **defaulting nulls to in-person is roughly right**. Null is a
per-company setting more than a per-job one: 25 of 356 boards leave it null on every job.

### Location: one signal finds only 64% of a metro

Matching NYC across the sample:

```
 513   10.8%   found in the primary `location` string
+259    5.4%   found ONLY in secondaryLocations
+ 26    0.5%   found ONLY in address.postalAddress
─────────────
 798   16.8%   total NYC jobs
```

Filtering on `location` alone misses **36%** of NYC jobs. The structured-address-only cases
are jobs whose `location` reads `"Remote"` or `"NY"` while `addressLocality` says `"NYC"`.
36 distinct raw spellings appeared in just 400 boards: `New York City`, `New York, NY`,
`NYC Office`, `In person in New York City`, `NYC | SF`, `Washington D.C, New York`,
`New York City Metro`, `New York - Remote`, `United States, New York, New York City`.

### Seniority: no field exists, so it must be inferred — here's what works

Ranked by measured yield:

**1. Years-of-experience regex over `descriptionPlain` — parseable on 59% of jobs.** The best
single signal. Distribution of the minimum stated requirement:

```
0 yrs   0.4%      3 yrs   20.4%      9+ yrs   7.9%
1 yr    6.0%      4-5 yrs 32.5%
2 yrs  15.6%      6-8 yrs 17.1%
```

Only **6.4%** of postings that state a requirement ask for ≤1 year. Entry level is genuinely
scarce on Ashby — worth knowing before building around it. Extraction needs a context guard
(`experience`, `background`, `professional`, `track record`) or it picks up "the last 15
years building…" from company boilerplate.

**2. Title keywords — but 42.9% of titles carry no seniority word at all.** "Software
Engineer" is both the entry-level title and the eight-year title. Useful mainly in the
negative: `Senior` / `Staff` / `Principal` / `Lead` / `Director` / `Intern` reliably rule
*out*.

**3. Salary — a weak proxy. Do not filter on it.**

| Years required | n | Median top of range |
| --- | --- | --- |
| 0–1 | 83 | $115k |
| 2 | 203 | $192k |
| 3 | 251 | $180k |
| 4–5 | 401 | $230k |
| 6–8 | 219 | $240k |
| 9+ | 84 | $266k |

The trend is real but the overlap is fatal: **8% of 0–1 year jobs pay above the median 6–8
year job**, the 2 and 3 year buckets invert, and it only applies to the 41% with salary data.
Tiebreaker only.

**4. Explicit phrases — near-worthless.** "entry level" appears in 0.2% of descriptions, "new
grad" 0.3%, "no experience required" 0.0%.

Title-rule-out → years-extraction → entry-ish-title fallback classifies **84.6%** of jobs.
The remaining **15.4% must be a third state**, not a silent drop.

### The measured funnel — NYC + in-person + entry level

```
4,760  100.0%   all jobs in the sample
  794   16.7%   in New York City
  650   13.7%   ...and in-person (OnSite or Hybrid)
   65    1.4%   ...and entry level        →  ~785 jobs across all 4,297 boards
  106    2.2%   ...unknown seniority      →  ~1,279 more worth a look
  479   10.1%   ...ruled out as too senior/intern
```

Real hits from the sample: Plaid `Software Engineer, Backend` (1+ yrs, Hybrid), Notion
`Software Engineer, AI Platform` (2+ yrs, Hybrid), Rain `Backend Engineer` (2+ yrs), Decagon
`Research Engineer` (2+ yrs, OnSite), Minerva `Data Scientist` (2+ yrs, OnSite).

~785 is a readable number. Adding role keywords brings it to a single sitting's worth.

### Two consequences for the filter engine

- **Every criterion needs three outcomes: match / no-match / unknown.** 15% unknown
  seniority, 59% unknown salary, 15% unknown workplace type. Binary filters silently discard
  these — for a user with a salary floor that means throwing away most of the market. The
  user chooses per-criterion whether unknowns are included, excluded, or shown separately.
- **Filters split into exact and derived.** `employmentType`, `publishedAt`, `workplaceType`
  are cheap direct predicates. Location, seniority and salary are *derived* and must be
  computed at ingest into canonical columns. User filters should only ever touch derived
  columns — that's what makes it safe to improve the NYC alias table later without
  re-sweeping 60,000 jobs.

---

## Phase 8 — Greenhouse, as built (2026-08-22)

Shipped per `GreenhousePlan.MD`. The plan's projections and what actually happened:

| | Plan projected | Measured |
| --- | --- | --- |
| Live boards | 7,700 ± 800 | **8,272** (54.4% of 15,197 slugs, zero errors, 3.7 min) |
| Open jobs added | ~92,000–123,000 | **204,485** |
| Jobs per live board | 12–16 | **~31** |
| Full sweep | ~1.2 GB | **2.7 GB**, 32 min, zero errors |

Corpus went from 61,213 to **265,698 open jobs** and 4,297 to **10,494 live boards**.
Every board count above is boards that answered, not slugs that were tried.

Lever then added **71,789 jobs on 2,025 boards** for 931 MB in 106 seconds — the
cheapest of the three per job, and the one that restored hybrid: corpus-wide hybrid
went from 15,932 to **29,986**, because Lever publishes a `workplaceType` enum on
98.0% of its jobs and Greenhouse publishes none at all.

**All seven gotchas held.** The two that would have cost the most:

- `content` is entity-escaped on 100% of jobs and must be decoded **exactly once** —
  `src/lib/adapters/html.mjs`, shared rather than Greenhouse-local because Rippling
  and Breezy need the identical function. Verified in the DB: zero jobs with a
  surviving entity or tag in `description_text`.
- `pay_input_ranges` is in **cents**, and the array is not all base salary. Titles
  observed in the wild include `Zone 1 Pay Range`, `OTE Range`, `Bonus Range` and
  bare state lists like `CA, NY, CT, NJ`. The adapter rejects bonus/equity/commission
  ranges outright and prefers a base range over OTE.

**One thing the plan did not anticipate:** Greenhouse boards publish hourly rates
under titles that never say "hour" — Robinhood's `Zone 1 (Menlo Park, CA; …)` is
`min_cents: 2040`, i.e. $20.40/hr. The adapter reports the honest reading of the
title and `deriveSalary`'s existing plausibility check reinterprets it
(`reinterpreted:YEAR->HOUR` → $42,432/yr). That split — adapter reports, derive
arbitrates — is why no adapter change was needed for it.

### The regression, stated plainly

Greenhouse publishes **no workplace enum and no employment type at all**. Measured
over its 204,485 jobs: 165,962 `onsite` (every one of them the `default-has-metro`
guess), 31,634 `remote` from the location text, 6,889 `unknown`, and **zero hybrid**.
Hybrid is not rare on Greenhouse — it is undetectable. All 15,932 hybrid jobs in the
corpus are Ashby jobs.

This is why the ATS filter shipped in the same change rather than after it. Without
it, a user filtering for hybrid work silently searches 23% of the corpus, and a
Greenhouse `onsite` is indistinguishable from an Ashby one that the employer
actually stated. `d_workplace_src` records which rule fired; the `ats` filter is how
a person sees it.

### The ATS filter

`ats` is a first-class criterion in `CRITERIA`, not a pre-filter on the row set —
that is what makes its leave-one-out facet counts honest. It is also the only
criterion that **can never answer `unknown`**: `jobs.ats` is `NOT NULL` and the
adapter writes it as a literal, so it carries no include/exclude policy. That is
consistent with the "never rule a job out on a blank field" rule, not an exception
to it: the evidence is always present.

Verified end to end: ticking Greenhouse alone and Ashby alone partitions the result
set exactly, with no job in both and the two counts summing to the unfiltered total.

### Also landed

- `src/probe-boards.mjs` replaces `probe-ashby.mjs` — one probe for every ATS,
  driven by `adapter.probeUrl(slug)`. Ashby's GraphQL display-name pass moved into
  the adapter as an optional `fetchOrganization` capability so it no longer follows
  other ATSes around.
- **Conditional GET.** `companies.last_etag` was written on every sweep and never
  read back. The sweeper now sends it; a 304 is treated as an answer ("unchanged")
  rather than an error, and `touchBoard` records the sweep without touching a job
  row. At 2.7 GB per full sweep this is what makes sweeping Ashby and Greenhouse
  daily viable. Lever is the exception and always will be until they implement it:
  it sends an ETag and answers a matching `If-None-Match` with 200 and the full
  body, so its nightly 931 MB is not avoidable this way.
- Every `share` in `UNKNOWNABLE` re-measured against the combined corpus. `job type`
  went 0.0% → **77.0%**; salary 62.8% → 75.6%. A stale share reads as measured and
  is worse than no number.

---

## Phase 9 — Lever, as built (2026-08-22)

| | Measured |
| --- | --- |
| Slugs probed | **8,721** in 4.1 min at concurrency 16, zero errors |
| Live boards | **2,611** (29.9%) — of which 586 exist but have no open roles |
| Boards with jobs | **2,025** |
| Open jobs added | **71,789** (~35 per board) |
| Full sweep | **931 MB**, **106 seconds**, zero errors, zero dead boards |

Corpus went from 265,698 to **337,487 open jobs** across three ATSes. Lever is the
cheapest of the three per job and by far the fastest to sweep.

### What Lever is good for, and what it costs

It publishes **more per job** than either of the others, and it is the ATS that makes
hybrid visible again. Corpus-wide hybrid went from 15,932 to **29,986** — Lever
publishes a `workplaceType` enum on 98.0% of its jobs, where Greenhouse publishes
none at all and its 204,485 jobs therefore contribute exactly zero hybrid.

The cost is that its payload is the least convenient of the three, in four specific
ways that are all documented at the top of `src/lib/adapters/lever.mjs`:

1. **The description is three fields.** `description` is only the opening; the
   requirements are in `lists[]` and the closing in `additional`. Storing the obvious
   field would have left `d_skills`, `d_degree`, `d_visa` and `d_clearance` reading a
   third of the posting — and reading it *successfully*, which is why it would never
   have been noticed. Assembling all three raised degree detection 481%, visa 367%,
   clearance 245% and skills 167% on the same jobs.
2. **`country` is an ISO code, and the location parser reads two-letter tokens as US
   states.** `"DE"` is Delaware to `parseFragment`, because in a location string that
   is what it is. Of 66,537 Lever jobs carrying a country, **10,784 (16.2%) would
   have landed in the wrong one** — every Canadian job American, every Indian job
   Indiana. Expanding the code to a name first (`iso-countries.mjs`) drops that to 2.
3. **`categories.commitment` is free text, not an employment type.** 120 distinct
   values; the commonest is one company's `"Contract Full time"`, which names two of
   our enum values at once. Mapped only where it names exactly one — 72.5% resolve,
   the rest stay NULL, which every filter reads as `unknown` rather than excluding.
4. **The ETag is decorative.** Lever sends one and ignores `If-None-Match`. A Lever
   sweep reports 0 unchanged boards and moves its full 931 MB every night.

### The company-name gap this exposed

Lever publishes no company name anywhere in its postings API — `hostedUrl` carries
the slug and nothing else. `fetchOrganization` scrapes the board page `<title>`,
which sounds expensive and is not: the tag lands in the first chunk off the socket,
so the request is aborted after ~1.5 KB rather than downloading the ~970 KB page, a
~650× saving. The names are ones no slug could produce — `ajccanada` →
"Allison Jones Consulting Services", `bofcorp` → "B-O-F Corporation".

Building it surfaced a pre-existing hole: **`probe-boards.mjs --with-names` wrote its
results to `<ats>-verified.json`, which nothing but `stats.mjs` ever read.** Ashby
never noticed because its board payload carries a name; Lever has none, so all 2,025
of its companies rendered as their slug. `sweep.mjs` now loads that file and uses it
to fill the gap when an adapter returns no name — the adapter still wins whenever it
has one.

### A latent bug this uncovered: slugs that are `Object.prototype` keys

`probe-boards.mjs` accumulated its results as `const companies = { ...previous.companies }`
and then read `companies[slug]`. A slug is arbitrary text from a third-party list,
and Ashby has a real board whose slug is **`constructor`** — so that lookup returned
the `Object` constructor *function*, and `pickNameFields` dutifully read its `.name`
and stored **`"Object"`** as the company's display name. `toString`, `valueOf` and
`hasOwnProperty` would do the same; `__proto__` would not even create an own key.

It had been sitting in `ashby-verified.json` since 2026-08-11 doing nothing visible,
because Ashby's display names reach the database from the board payload rather than
from that file. Wiring `<ats>-verified.json` into `sweep.mjs` for Lever's sake is
exactly what would have made it fire — the next Ashby sweep would have replaced
Constructor's name with "Object".

Fixed by building the accumulator with `Object.create(null)` and adding an own-property
`record()` helper for the `--only-unknown` read. The one corrupted record was repaired
in place. Greenhouse and Lever have no colliding slugs.

The general lesson: **anything keyed by a slug is keyed by untrusted text.** Use a
`Map`, a null-prototype object, or `Object.hasOwn` — never a bare object literal.

### Two shared files changed

- `derive/salary.mjs` gained `BIWEEK: 26` and `SEMI_MONTH: 24` in `PER_YEAR`, and
  `schema.mjs` the matching `PAY_PERIODS` entries. Lever is the only ATS that
  publishes those intervals (52 and 32 jobs). Purely additive: the reinterpretation
  loop does not try them as fallbacks, so no other ATS changes. Without a factor a
  $3,000 fortnightly figure has no plausible reading except MONTH, and the job files
  at $36k instead of $78k.
- `adapters/iso-countries.mjs` is new and sits beside `html.mjs` for the same reason
  it does — SmartRecruiters, Workable, Recruitee and Personio all publish ISO codes
  too, and a second copy of that table is how the two drift.

### A sampling lesson worth keeping

The adapter was designed against 8,697 jobs sampled evenly across 160 boards. Two of
its numbers were materially wrong against the full sweep: `employment_type` coverage
read 45.9% against a real **72.5%**, and salary 18.5% against **31.1%**. The cause is
that one board contributed 3,462 identically-labelled jobs — 40% of the sample.
**Sampling boards evenly does not sample jobs evenly**, and board size is Pareto.
Sample boards to design the adapter; re-measure on the corpus before quoting a number.

---

## Other ATSes, confirmed working

- **Greenhouse**: **done — see Phase 8 above.**
- **Lever**: **done — see Phase 9 above.** (The old note here estimated the split
  description cost you ~87% of the text; measured, `description` alone is 33.9%.)

---

## Dead ends — do not re-litigate

Each of these was tested, not assumed.

| Avenue | Verdict |
| --- | --- |
| Ashby sitemap / robots / public directory | Doesn't exist. Collection endpoints 401. |
| Search-engine enumeration (`site:jobs.ashbyhq.com`) | DuckDuckGo CAPTCHAs, Bing returns zero Ashby URLs, Mojeek 403s. **0 slugs/page.** |
| BuiltWith, Wappalyzer | **Neither tracks Ashby at all** — verified against Wappalyzer's full 7,278-technology catalog. |
| Certificate transparency / DNS | Meaningless — every board is a path on one shared Cloudflare host. |
| Aggregators (Trueup, Simplify, Jobright, Wellfound, RemoteOK) | Zero `ashbyhq` mentions in served HTML; all client-rendered or API-gated. |
| Guess slugs from Y Combinator directory | 75 companies → 125 guesses → **1 hit**. |
| SimilarTech, Datanyze | Defunct / bot-blocked. |

One with a caveat: **hiring.cafe** does server-render its full search payload with ATS
slugs for *every* ATS, but hard-caps at page 249 (a 10,000-result limit). Not worth it for
Ashby. Potentially very worth it when expanding to Greenhouse/Lever/Workday, if partitioned
into disjoint filter slices.

⚠️ **Security note:** `Somitha-git/find-companies-using-ashby-job-boards` ships a `.zip`
containing a `Launcher.cmd` + `lua51.exe` pair — a common malware-loader shape. Not
downloaded, not wired in. Don't run it.

---

## Design decisions worth remembering

- **Polling, not webhooks.** Only a repo's *owner* can register a webhook; there's no way to
  subscribe to pushes on someone else's public repo. Instead, each fetch stores the file's
  ETag (a content fingerprint) and sends it back next time — unchanged files return `304 Not
  Modified` with a zero-byte body. A full no-change poll of all 11 sources transfers
  essentially nothing.
- **A source that fails keeps its prior claims.** Otherwise one upstream hiccup reads as
  thousands of deleted companies.
- **Removals are recorded, not executed.** When no source vouches for a slug anymore it stays
  in the store with `sources: []` and its last-seen date, and drops out of the active list.
  `--prune-after=<days>` deletes for real.
- **`ashby.json` is the sole authority on provenance.** The verification file deliberately
  doesn't copy source lists — an incremental re-verify would freeze stale copies. (This was
  an actual bug; it skewed the contribution table before being caught.)
- **Feashliaa's daily cron doesn't refresh its company lists** — only its job data. The slug
  file was last touched 2026-06-16, and 22% of its slugs are now dead.

---

## Next: the filtering system

This is the real work. Four phases, each independently useful.

### Phase 3 — Sweep and store — **built**

> Built as `src/sweep.mjs` + `src/lib/adapters/ashby.mjs`. Actuals in
> [Phases 3 and 4 as built](#phases-3-and-4-as-built--the-full-corpus-numbers).
> The estimates below were written before the run; the real sweep took 24 seconds,
> not 2–3 minutes, because gzip and the absence of rate limiting both helped more
> than expected.

Fetch all 4,297 live boards and keep the results. At ~55 req/s this is roughly 2–3 minutes
per full sweep; the constraint is bandwidth (~670 MB uncompressed), not rate limits, and
gzip cuts that ~11x.

**Storage recommendation: SQLite**, via Node 24's built-in `node:sqlite` — no dependencies
to install. Reasons: 60,000 jobs with full descriptions is too much to re-parse from JSON on
every filter tweak, and filtering becomes a query rather than hand-written loops. A raw
JSONL archive alongside it keeps the option to re-derive everything if the schema changes.

Two things to build in from the start:

- **Change detection.** Ashby has no `updatedAt`, so store the board ETag plus a per-job
  content hash. This is what makes "what's new since yesterday" possible — which is the
  single most useful feature for an actual job search, since you want the 40 new postings,
  not to re-read 60,000.
- **Job history.** Keep `first_seen` / `last_seen` per job. A posting that's been up for 6
  months means something different from one posted yesterday.

### Phase 4 — Normalization — **built**

> Built as `src/derive.mjs` + `src/lib/derive/`, with 82 regression tests in
> `src/derive-test.mjs`. Coverage numbers and the decisions taken are in
> [Phases 3 and 4 as built](#phases-3-and-4-as-built--the-full-corpus-numbers).
> The plan below is what was built, with one addition: unrecognised places are
> rejected and reported rather than guessed at.

The filtering can't work until the messy fields are cleaned. This is where the real
engineering is, and it's worth doing carefully because every filter depends on it.

All four derivations below are now backed by measurement — see **What's actually filterable**
above for the numbers behind each.

**Location** is the hard one, and one signal isn't enough: the primary `location` string
alone finds only **64%** of a metro's jobs. Must read `location` + `secondaryLocations[]` +
`address.postalAddress` and union the results. Plan: an alias table mapping raw strings to
canonical metros, built by pulling the actual distinct strings out of the swept data and
clustering — not by guessing in advance. 36 distinct NYC spellings appeared in a 400-board
sample, so expect a few hundred across the full sweep. Still to decide per user: whether
`Remote - US` counts as a metro match.

→ derives `metro[]` (a job can be in several).

**Salary** — read `compensation.summaryComponents`, take the entry where
`compensationType == "Salary"`, and multiply by interval (`1 YEAR` ×1, `1 MONTH` ×12,
`1 WEEK` ×52, `1 HOUR` ×2080, `6 MONTH` ×2; `NONE` means no usable figure). Only **41.5%**
of jobs have this and **37%** have it in USD — so a hard salary floor discards most of the
market. Default must be include-unknown.

→ derives `salary_min_usd`, `salary_max_usd`, `salary_known`.

**Seniority** — no such field. Order of operations, by measured yield: rule out on title
keywords (`Senior`/`Staff`/`Principal`/`Lead`/`Director`/`Intern`), then extract minimum
years from `descriptionPlain` (works on 59%), then fall back to entry-ish title words.
Classifies 84.6%; the rest stay `unknown`. Needs a context guard on the years regex or it
matches company boilerplate ("the last 15 years building…").

→ derives `min_years` (nullable), `seniority` (`intern|entry|mid|senior|staff|lead|unknown`).

**Remote** — use `workplaceType`, not `isRemote`. `isRemote` is `true` for every Hybrid job
and carries no information the enum lacks. Null on 15%; fall back to scanning the location
string, defaulting null → in-person (only 50 of 724 nulls mention remote).

→ derives `is_in_person` (OnSite or Hybrid), `workplace` (`onsite|hybrid|remote|unknown`).

### Phase 5 — Filter profiles — **built**

> Built as `src/lib/filter/` + `src/find.mjs`, with 94 regression tests in
> `src/filter-test.mjs`. Actuals and the decisions taken are in
> [Phases 5 and 6 as built](#phases-5-and-6-as-built). The sketch below is
> what shipped, with four additions: skills, job family, visa/clearance/degree
> flags, and a free-text FTS field. `exclude_keywords` split into a title list
> and a description list, because the two are enforced at different points —
> the title one in the in-memory pass, the description one in FTS so that facet
> counts see it.

A config file describing what you want, so criteria can be tweaked without touching code.
This is also the shape other people would fill in, since the eventual goal is for anyone to
supply their own criteria. Sketch, updated against the measured data:

```jsonc
{
  "name": "nyc-entry-level",
  "title_keywords":       ["implementation", "deployment", "solutions", "consultant",
                           "strategist", "ai", "product", "specialist", "analyst",
                           "associate", "operations", "technical"],
  "description_keywords": ["consulting"],             // gates and scores (see 2026-08-22)
  "exclude_keywords":     ["clearance", "unpaid", "commission only"],
  "metros":               ["nyc"],
  "include_remote_us":    false,                      // NYC in-person only
  "workplace":            ["onsite", "hybrid"],
  "max_years_experience": 2,
  "employment_type":      ["FullTime"],
  "posted_within_days":   60,
  "salary_min":           null,
  "exclude_companies":    ["some-company-i-already-applied-to"],

  // every criterion that can be unknown needs a policy — see fill rates above
  "unknowns": {
    "seniority": "surface_separately",   // 15.4% of jobs
    "salary":    "include",              // 58.5% of jobs
    "workplace": "include"               // 15.2% of jobs
  }
}
```

Design rules, each now backed by a measurement:

- **Three outcomes per criterion, never two.** match / no-match / **unknown**. Binary filters
  silently discard the 15% with no seniority signal and the 59% with no salary. The
  `unknowns` block above is not a nicety — without it a salary floor throws away most of the
  market without saying so.
- **Filters read derived columns only.** Never raw JSON. That's what lets the NYC alias table
  improve later without re-sweeping.
- **Where keywords match** — title is the filter, description is a *score*. Every description
  mentions "collaborate"; `descriptionPlain` averages 5,146 chars, so substring hits there
  are near-meaningless as a gate.
- **Whole-word matching by default** — "go" as a substring matches "algorithms" and "going".
- **Rank, don't just filter.** Even the tight NYC + in-person + entry-level funnel returns
  ~785. Score on title-keyword hits, description hits, recency, salary, and years-fit, then
  surface a top 20.
- **Age is a real filter.** 4.8% of live postings are over a year old and 34% are over 90
  days — a `posted_within_days` default of 60–90 removes a lot of noise.

### Phase 6 — Interface, output, automation — **built**

> Built as `src/server.mjs` + `app/`, `src/lib/filter/diff.mjs`, `src/daily.mjs`
> and `src/schedule.mjs`. Actuals in
> [Phases 5 and 6 as built](#phases-5-and-6-as-built). The automation question
> below is answered as far as it can be from here: both runners are written and
> neither is installed, because scheduling a background job is the user's call.

- **The UI is the deliverable, not a report.** See *The user interface* below — criteria are
  entered by the user, options are populated from the derived data, controls show live
  counts, and every result links to its posting.
- A daily run behind it: sync slugs → verify new ones → sweep boards → derive → report.
- The output that matters is **the diff**: jobs matching a profile that weren't there
  yesterday. ~344 results is readable once; re-reading it daily is not.
- Automation options, still undecided: macOS `launchd` (local, zero setup), GitHub Actions
  in your own repo (needs this to be a git repo; runs whether the laptop is on), or a
  scheduled cloud agent.

### Phase 7 — Optional accounts — **built**

Kept filters, starred jobs, application status, curated lists. Anonymous use unchanged;
`data/users.db` separate from the committed corpus; Google sign-in built and dormant
until configured. Written up above. Phase 10 later made one route — and only one —
require a session; see the rule under Phase 7 above.

### Then: Greenhouse and Lever

Both endpoints already confirmed. Greenhouse is the bigger prize — **15,197 slugs already
collected** and unverified, likely ~8–9,000 live, and its API includes `updated_at` and
`company_name` which Ashby lacks. Lever has 8,721 collected but its slugs churn hard, so
expect a lower hit rate.

The slug store is already ATS-generic; the work is a per-ATS fetch adapter that maps each
API's shape onto one common job schema. That common schema should be designed **now**,
during Phase 3, rather than retrofitted — it's much cheaper to define it once against three
known API shapes than to migrate Ashby-shaped data later.

---

## Elliot's criteria — settled 2026-08-15

The first filter profile, and the default the UI ships with:

- **Location:** New York City
- **In person: yes, and Hybrid counts.** Confirmed — both mean going to an office. So
  `workplace ∈ {OnSite, Hybrid}`, plus the nulls that don't say "remote". This is 30% of all
  jobs riding on one decision, now settled.
- **Entry level:** ≤2 years, via years-required extraction from the description
- **Role keywords** (title match, word-boundary):

  ```
  implementation · deployment · solutions · consultant · consulting · strategist
  ai · product · specialist · analyst · associate · operations · technical
  ```

Note this is a **solutions / GTM / operations profile, not a software-engineering one** —
which is worth stating because most job-search tooling assumes the latter, and the keyword
and seniority heuristics tuned for engineering titles don't transfer cleanly.

### The funnel with these exact keywords, measured

```
4,760  100.0%   all jobs in the sample          →  ~51,100 across all 4,297 boards
  794   16.7%   in New York City                →   ~8,530
  650   13.7%   ...and in-person (OnSite/Hybrid)→   ~6,980
  238    5.0%   ...and title matches a keyword  →   ~2,560
   32    0.7%   ...and entry level (≤2 yrs)     →     ~344   ← the actual result set
   21    0.4%   ...unknown seniority            →     ~226   ← surfaced separately
```

**~344 jobs**, plus ~226 worth a second look. That's a readable list, and it's the number to
sanity-check the first real sweep against.

Sample hits, ranked by keyword count: `AI Deployment Strategist` (axion, 3kw),
`Operations Associate (Deployment)` (hanover-park, 3kw), `Commercial Solutions Consultant,
New York` (notion), `Implementation Specialist` (rain), `Client Solutions Analyst` (mednet),
`Enterprise AI Associate` (mercor), `Intelligence Operations & Strategy Associate`
(qualitate).

### What testing these keywords proved

- **Word-boundary matching is mandatory, not a preference.** Substring matching on `ai`
  produces 355 title hits instead of 263 — the extras are `P-ai-d Social Account Director`,
  `Supply Ch-ai-n`, `Mount-ai-n View`. `specialist` as a substring pulls in Spanish and
  Portuguese postings via `Especialista`. `technical` pulls in `Geotechnical Engineer`.
- **`consulting` is dead weight as a title keyword** — 0 title hits in 4,760 jobs. It's a
  description word (42 hits there). Keep it as a description signal, drop it from the title
  gate.
- **`product` and `ai` are the broad ones** (472 and 263 title hits across all jobs); the
  precise ones are `implementation` (21), `deployment` (33), `consultant` (34),
  `strategist` (34). Ranking by *number of keywords matched* is what separates
  `AI Deployment Strategist` from `Product Designer`, and it works well on real titles.
- **Description matching cannot be a gate. 93.2% of all jobs match at least one of these
  keywords somewhere in the description.** Requiring a description hit filters almost
  nothing; it must be a ranking score only. In the NYC in-person pool, description-only
  matches add ~4,300 jobs — the entire reason this stays a score.

  **Reversed 2026-08-22.** The 93.2% was never re-measured against a list anyone shipped,
  and it does not hold for one. The profile's five description keywords — `consulting`,
  `implementation`, `client-facing`, `stakeholder`, `onboarding` — are in 21,891 of the
  61,213 open descriptions, 35.8%; its twelve title keywords are in 29.5% of titles. The
  two lists are comparable filters, and a 35.8% gate is a gate. `description_keywords` now
  gates *and* scores, `description_match` picks `any` / `all` exactly like `title_match`,
  and the shipped profile goes from 520 matches to 252 with no other change. The `~4,300`
  finding above is untouched and still the reason it is an `AND` with the title gate rather
  than an `OR` alongside it.

  Two things the reversal had to get right. The gate runs as one FTS5 query over the `body`
  column, not as the word-boundary matcher — the prose deliberately never enters the
  in-memory index, and running it in FTS is also what lets it apply *before* the facet
  tally instead of making every leave-one-out count a small lie. FTS is the broader of the
  two matchers on hyphenated terms (4 extra jobs in 2,932 measured, nothing the regex found
  that it missed), which is the safe direction. And a job with no description text answers
  `unknown`, never `no`: it is on the `UNKNOWNABLE` roster like every other criterion whose
  column can be absent, at 0.0% of today's corpus, because "we had nothing to search"
  is not "we searched and it isn't there".

---

## The user interface — a core requirement, not a delivery detail

**Other people must be able to enter their own criteria and get their own results.** Elliot's
criteria above are one saved profile, not the product. This is a hard constraint on
everything downstream:

- **The filter profile is data end to end.** UI form → JSON profile → SQL over derived
  columns. No criterion is ever hardcoded, including location and seniority.
- **The UI's options come from the data, not a hardcoded list.** The metro dropdown is built
  from the alias table that Phase 4 derives from real location strings; workplace and
  employment-type checkboxes come from the observed enums. When the data grows a new metro,
  the UI grows a new option with no code change.
- **Show counts on every control.** `New York City (8,530)`, `Hybrid (30%)`. With ~51,000
  jobs, a user who picks four criteria blind and gets zero results has no way to tell which
  one was too narrow. Live facet counts are what make it usable rather than a guessing game.
- **Unknowns are a visible, user-controlled choice.** Given 59% unknown salary and 15%
  unknown seniority, every criterion that can be unknown needs an include / exclude / show-
  separately toggle in the UI, defaulting to include. A silently-applied salary floor hides
  most of the market.
- **Every result links to its posting.** `jobUrl` is present on 100% of jobs, so this is
  free — and it's the thing the user is actually there for.
- **Nobody boots into somebody else's search.** For a while the app opened on
  `profiles/nyc-entry-level.json` for every visitor, because it was the first file in
  `profiles/` and opening on *something* beat opening on the unranked corpus. Both halves
  of that were right and the combination was not: a stranger's first screen was twelve
  title keywords, one city and a two-year experience cap, presented as what the corpus
  thinks a good job is. The fix is two rules rather than a special case — a profile
  document may name an **`owner`**, and the server lists and serves an owned one only to a
  session signed in as that address; and the page boots into the first profile the server
  lists, which is owner-first. So Elliot signs in and his filters are already there, and
  everyone else opens on `profiles/recent-openings.json`, which is deliberately nobody's
  criteria: full-time, posted in the last 30 days, no keywords and no city.

Open scope question: **local page vs hosted.** A local HTML page reading `jobs.db` serves
Elliot on day one and needs no infrastructure. Letting other people use it means hosting,
which brings accounts, saved profiles, and per-user diffs. The schema and profile format
above work for both, so this can stay undecided until the local version is real — but it
shouldn't be decided *by accident*, so: build local first, keep the profile a portable JSON
document.

---

## Open questions for you

Answered so far: locations (NYC), in-person (yes, Hybrid counts), role keywords (13, listed
above), and delivery (a user interface, local first).

**Answered by shipping**, each as one profile's answer rather than a constraint — every one
is a field in `profiles/nyc-entry-level.json` and a control in the app:

- **4. Do the unknown-seniority NYC jobs get shown by default?** They go to a **separate
  "worth a look" list** — 232 of them against 221 confirmed matches. Too many to drop, too
  many to mix in. `unknowns.experience` is `include` / `exclude` / `separate`.
- **5. Does `Remote - US` count as a NYC match?** **No**, by default. Remote roles carry a
  country and a scope but no metro, so a metro filter excludes them by construction.
  `remote_counts_as_match: true` reverses it.
- **2. Salary floor** — **none**, as assumed. Salary is a ranking signal, weakly weighted
  and never a gate. `salary_min` exists if you want one; the app prints the 62.8% it would
  cost you next to the control.

Remaining:

1. **Automation — which runner?** Both artifacts are written and neither is installed:
   `npm run schedule -- --install` for launchd, or commit `.github/workflows/daily.yml`
   for Actions. The trade-off is in [Automation — written, not installed](#automation--written-not-installed).
   A cloud agent is still unwritten. **This is the one live decision.**
3. **Hosted or local-only**, eventually — see the UI section. Local is real now and the
   profile is a portable JSON document, so this still blocks nothing.
6. **Do you want the duplicate metros merged before anything else?** The app surfaces them
   plainly now: `sf-bay` next to `san-francisco-bay`, `madhive-new-york` next to `nyc`. It
   is an alias-table edit plus a re-derive — minutes, not a rebuild — but it is cosmetic
   until a search actually misses a job because of it.


---

## Phase 10 — describe it in words

**The problem this solves is the first ten minutes, not the tenth search.**

The rail is forty controls across seventeen panels, six of them collapsed by
default. That is the right shape once you know the corpus: every one of them
carries a leave-one-out count, and adjusting a criterion by hand is the whole
reason the counts exist. It is the wrong shape for someone who has just opened
the page, because the thing they know is a sentence — *entry-level ops or
solutions roles in NYC, I'd take remote too, nothing needing a clearance* — and
turning that sentence into eleven controls spread over six panels is a task
they have to learn the tool to perform.

So: a text box at the top of the rail, and a microphone beside it. Free text in,
a filter profile out. `src/lib/interpret.mjs`, `app/ai.js`, one route.

**It is not a second way to search, and that is the constraint that kept it
small.** It writes the same `profile` object every control below it writes, and
nothing downstream knows where a criterion came from. That is why the whole
feature is one module and a hundred lines of page, why it inherits the funnel,
the facet counts, the audit trail and the saved-set machinery for free, and why
a search it built can be saved to `profiles/<name>.json` and read by the CLI
tomorrow. Had it produced its own query object, none of that would be true and
every one of them would have needed a second implementation.

### The four rules, and what each one is preventing

**1. The vocabulary is generated, not written down twice.** The tool schema the
model chooses from is built from `schema.mjs`'s enums, `SKILL_TERMS` and the
live corpus, the same way `/api/meta` builds the page's dropdowns. A second
hand-kept list of job functions would drift from the first the day somebody adds
a function, and the failure is silent: the model returns a value the engine has
never heard of, and the search comes back empty with no error. `interpret-test.mjs`
asserts each enum against its source for exactly this.

**2. A filter may only rule a job out on evidence.** This is the rule the whole
project is built on and the one a language model is most likely to break, because
*at least $150k* reads like an instruction to drop everything that does not say
$150k — which is 74.2% of the corpus, discarded without a word on screen. So the
unknown policies are not a field the model can write. It gets one narrow list,
`exclude_when_unstated`, the prompt tells it that filling that in unasked is an
error, and `buildProfile` builds the policy object from the defaults plus that
list and nothing else. The first test in the file is the assertion that a request
naming a salary floor, a degree, a workplace and a date moves no policy at all.

**3. Places are a hybrid, because the registry is two things.** 200 metros
anybody would name, and a 24,576-row tail. The first are served to the model as
ids to pick from — 60.3% of every placed job for 4 KB of prompt — and everything
else goes through free text resolved by **exact match only**.

The first version resolved free text with `LIKE 'name%'` and then `LIKE '%name%'`,
which on a registry built from raw location strings is not fuzzy matching, it is
a random walk. Measured against the real corpus it turned `Germany` into a
two-job metro *labelled* "Germany Berlin" instead of the country filter with
eleven thousand, matched a metro called `Narnia` (2 jobs, and it is genuinely in
there, along with "Field" at 2,985 and one company's own name at 4,985), and
still could not resolve "the Bay Area" or "Austin, Texas". Both passes were
deleted. Knowing that the Bay Area is `sf-bay` belongs to the model, which does
it correctly; a string comparison against 24,576 rows cannot, and its failures
are confident.

**4. The answer is shown, not just applied.** The route returns the profile *and*
a diff against what was on screen, rendered in `activeCriteria`'s own words — so
what you read is the engine's account of what it now holds, not the model's
account of itself. Undo restores the previous profile exactly. Anything that did
not resolve is named; anything these filters cannot express comes back as
*Couldn't filter on that: …* rather than being approximated with keywords that
would narrow the search invisibly.

### What it costs, and what it does not

One API call per press. Measured on the first live run: 9,600 input tokens and
395 out, which is **about 6c** on `claude-opus-5` — an order of magnitude more
than the "well under a cent" this section estimated before anyone had run it,
and the correction is the reason the cap moved from 30 to 5. The input is almost
all fixed cost: the tool schema and the 200-metro list are ~19 KB and the
person's sentence is a rounding error against them, so the price per press is
flat no matter how much they type. That also makes it an obvious candidate for
prompt caching, which is not done yet. It is the project's only npm dependency and its only network
call at query time, and with no key configured the server never loads the SDK:
`/api/meta` reports `ai.enabled: false`, the panel says which environment
variable to set, and every other route behaves exactly as it did. Deleting
`config/anthropic.json` and unsetting `ANTHROPIC_API_KEY` is the whole uninstall,
the same property accounts have.

`/api/meta` answers three questions rather than one, because the panel has three
different things to say and a single boolean is how a control ends up dead with
no explanation. `enabled` is "is there a key at all" — an operator's question,
answered by `setup`. `usable` is "may *this* visitor press it". `blocked` is the
sentence they get when the answer is no, and it is ordered most-fundamental
first: a server with no key reports the key rather than telling a visitor to sign
in to something that would not work if they did. Under `--no-accounts` it says
that instead, since there is no sign-in screen to send anybody to — and the page
does not draw a Sign in button that opens no door.

**This is the one route in the project that requires an account**, and the only
exception to "signing in is optional and subtractive of nothing".

It was first gated the way shared profile writes are: anonymous on a loopback
bind, session required once bound to `--host=0.0.0.0`. That is the right rule for
a profile write, where the question is whether a stranger can reach the socket,
and the wrong one here, where the question is who is pressing the button. The
bind address is a fact about the network; what this route needs is a fact about
the person. It protected the deployed copy and left the laptop wide open, and
those are the same route with the same cost per press.

So it requires a session, always. The argument for it is not that describing a
search is precious — it is that an anonymous caller cannot be capped, cannot be
told they have reached their limit, and cannot be told apart from a script. Every
mechanism below this depends on knowing who is asking.

The line it draws is narrower than "accounts now matter": **an account may be
required to spend, never to see.** Every job, filter, count, description and
apply link is still anonymous, and the search this route produces is an ordinary
profile that anyone can then use, save, or run from the CLI.

There is a cap as well — 5 calls an hour per account, a number you can actually
reach. It was 30, which is comfortably more than anyone uses in a sitting and
therefore not really a cap at all; the thing it is sized against is an
unattended bill on somebody else's key, and one line in `.env` undoes the
inconvenience while nothing undoes the bill. Two details in it are the whole design.
It is taken **inside `interpret`, at the line that spends**, after every
pre-flight check has had its chance to throw, so nothing that never reached the
API is charged for; and the failures that provably cost nothing — a rejected
key, a model the key cannot reach, no network — hand the call back, because
"you mistyped your key" must not also mean "and you are locked out for an hour"
at the exact moment somebody is trying to fix it. It is a cap on a runaway and
not a budget: it resets on restart, and the Anthropic console's spend limit is
the thing that is actually a budget.

**Dictation adds nothing to the stack.** It is the browser's own
`SpeechRecognition`, so it needs no key and no package, and the button is not
drawn where the API is missing. In Chrome it is a round trip to Google's servers,
which is a surprising thing for a tool whose pitch is that it runs on your
laptop — so the hint under the button says so out loud rather than leaving it to
be discovered.

### What was considered and not done

- **Streaming the answer.** The output is a tool call, not prose; there is
  nothing to stream but a spinner, and the call takes a few seconds.
- **Letting it write `text` (the raw FTS5 query).** It would duplicate the
  keyword gates with worse ranking and no way to see what it did.
- **Merging its answer into the filters on screen.** It is told what is on
  screen and returns a complete set that replaces it. A half-stated answer
  merged into whatever happened to be there is the version nobody can predict,
  explain, or diff — and the diff is the feature.
- **Forcing `tool_choice`.** Forced tool choice and extended thinking have
  historically not been combinable. A request that 400s on a parameter
  combination is a worse failure than the one forcing it would prevent, so the
  prompt asks three times and the no-tool-call path is handled: the model's own
  words are shown, which for an ambiguous request is usually a useful question.

