# Filtering — the profile

How a search is expressed, evaluated and ranked in UpstreamIt: the profile document, the three-outcome rule that every criterion follows, the CLI, the ranking weights, and why the filter runs in memory rather than in SQL. Measurements below were taken 2026-08-11 to 2026-08-22 unless a later date is given; the live counts are on the site. Percentages measured on the Ashby-only corpus (61,213 open jobs, mid-August 2026) are marked as such; the unknown shares were re-measured on 2026-08-22 over the three-ATS corpus of 337,487 open jobs.

## The profile document

A **profile** is a JSON document describing what someone wants. It is the only place criteria live: the app posts one to `POST /api/search`, `npm run find` reads one off disk, and the daily run iterates a directory of them. Nothing is hardcoded, including location and seniority, which is what makes someone else's search a different file rather than a different build.

The engine that evaluates it (`src/lib/filter/index.mjs`) is shared verbatim by the CLI (`src/find.mjs`), the server (`src/server.mjs`) and the daily diff (`src/daily.mjs`), so the three agree by construction rather than by care. Every field maps onto a derived `d_*` column or a normalized enum, never onto raw ATS JSON — that is what makes improving a metro alias a re-derive rather than a re-sweep (see [pipeline.md](./pipeline.md)).

Unset means inactive. `metros: []` is "any metro", not "no metros" — an empty criterion is skipped entirely, including its unknown policy.

`profiles/nyc-entry-level.json` is the worked example. It was the original profile — the author's own search, settled 2026-08-15 — and it is a solutions / GTM / operations profile rather than a software-engineering one:

```jsonc
{
  "name": "nyc-entry-level",
  "owner": "<an email address>",              // see "Whose profile is it"
  "label": "NYC · entry level · solutions & operations",

  "title_keywords": ["implementation", "deployment", "solutions", "consultant",
                     "strategist", "ai", "product", "specialist", "analyst",
                     "associate", "operations", "technical"],
  "title_match": "any",                                       // "all" to require every one
  "description_keywords": ["consulting", "implementation", "client-facing",
                           "stakeholder", "onboarding"],      // gates and scores
  "exclude_title_keywords": ["intern", "internship", "senior", "staff",
                             "principal", "director", "vp"],
  "exclude_description_keywords": ["security clearance", "unpaid", "commission only"],

  "metros": ["nyc"],
  "remote_counts_as_match": false,
  "workplace": ["onsite", "hybrid"],

  "max_years_experience": 2,
  "include_intern": false,

  "employment_type": ["FullTime"],
  "posted_within_days": 90,
  "salary_min": null,

  "unknowns": {                               // the important part, see below
    "metro": "include",
    "workplace": "include",
    "experience": "include",
    "salary": "include",
    "employment_type": "include",
    "posted": "include",
    "job_function": "include",
    "skills": "include",
    "degree": "include",
    "visa": "include"
  },

  "limit": 100
}
```

`consulting` is deliberately a description keyword and not a title keyword: it produced 0 title hits in 4,760 jobs and 42 description hits.

`profiles/recent-openings.json` is the starter — what the app opens on for anyone who has not saved a search of their own. It is deliberately nobody's criteria: no keywords, no city, no seniority, no salary floor. It scopes the corpus to full-time roles posted in the last 30 days, ranks them by relevance, and includes every unknown, so a posting that did not publish its employment type or its date is still there.

### Whose profile is it — `owner`

A profile document may name an owner, one email address:

```jsonc
{ "name": "nyc-entry-level", "owner": "someone@example.com", ... }
```

An owned profile is listed and served **only** to a session signed in as that address. Everyone else gets a 404 from `/api/profiles/<name>` and never sees it in the menu — 404 rather than 403, because "not yours" would still tell a stranger that this address has a saved search here. Omit the field and the profile belongs to everyone, which is what every profile was before the field existed and what a starter profile should stay.

This is a **visibility** rule, not a secret: the file sits in `profiles/` next to the others and anyone with the repository can read it. What it buys is that nobody boots into somebody else's job search. The app opens on the first profile the server lists, and the server lists owned ones first — so a signed-in owner's criteria are already on screen, while a signed-out visitor opens on `profiles/recent-openings.json`. Before the field existed, every visitor booted into the twelve title keywords and two-year cap of one person's NYC search as though it were the corpus's own opinion of a good job.

Three consequences:

- **The CLI ignores ownership entirely.** It reads the directory off disk, on the machine the database is on, where having the file is the whole authority there is. `npm run find -- nyc-entry-level` is unchanged.
- **The daily run reports on the owned profiles, if there are any.** Otherwise on all of them. A standing job search is what "what appeared overnight matching this" is for; the starter profile matches a third of the corpus and reporting on it every morning would bury the section worth reading. A fresh clone owns nothing, so there the starter is the only saved search and it is still covered. `--profiles=` overrides all of it. See [automation.md](./automation.md).
- **Changing an owned profile from the app needs that session.** Saving over one, or deleting it, requires being signed in as its owner — even on a loopback bind, where an anonymous request may still write an unowned profile. Editing the file by hand is unaffected.

## Every criterion has three outcomes, not two

Match, no-match, and **unknown**. Measured on the Ashby-only corpus: 24.9% of jobs carried no seniority signal, 62.8% published no salary, 15.9% had no location that could be placed, 1.1% had no workplace. A binary filter folds those into "no" and hides most of the market without saying so, so each criterion that can be unknown carries a policy in `unknowns`:

| policy | what happens |
| --- | --- |
| `include` | keep them in the results |
| `exclude` | drop them |
| `separate` | a second **"worth a look"** list underneath the main one |

**Every criterion defaults to `include`. A filter may rule a job out on evidence, never on the absence of it.** Silence is the company's omission, not the job's answer. This is the rule the whole project is built around, and two defaults were changed to honour it:

- `metro` used to default to `exclude`, on the theory that a location filter admitting unplaceable jobs is not a location filter. Measured on the shipped NYC profile it costs 27 extra rows, not the flood the theory predicted — the other criteria remove almost all of them anyway. Those rows arrive tagged `? metro` in the UI, and `exclude` is still one field away in a saved profile.
- `experience` used to default to `separate`, which sorted the jobs with no seniority signal into a "worth a look" list rather than interleaving them with jobs that matched the years asked for. That list and the panel controlling it were removed from the page; a default of `separate` with no second list to render it would have dropped those jobs off the page altogether.

The roster of criteria that can be unknown also had gaps: `degree`, `visa`, `skills` and `job_function` were missing from it and were therefore hard `no`s on silence — a degree filter dropped 75.6% of the Ashby-only corpus for never mentioning school (61.6% on the three-ATS corpus, in the table below). The rule is now uniform, and `--unknown-<criterion>` on the CLI is derived from the roster rather than a separate list, so a criterion added to it is reachable without a second edit.

The share each policy affects is published next to the control. Re-measured 2026-08-22 over the full 337,487-job Ashby + Greenhouse + Lever corpus, by activating one criterion at a time and counting the jobs the engine itself answers `unknown` for — which is exactly what `exclude` would drop:

| criterion | unknown when | share |
| --- | --- | --- |
| `equity` | no equity component published | 96.7% |
| `visa` (sponsorship) | nothing said about visa sponsorship | 94.4% |
| `salary` | no compensation published | 74.2% |
| `salary_source` (pay as published) | no figure to have published as-stated | 74.2% |
| `pay_period` | no compensation published, so no interval either | 74.1% |
| `currency` | no compensation published, so no currency either | 74.1% |
| `employment_type` (job type) | no employment type published | 66.4% |
| `degree` | no degree requirement stated | 61.6% |
| `skills` | description names none of the tracked skills | 42.4% |
| `experience` (seniority) | no title band and no years stated | 27.9% |
| `job_function` | title and department match no function rule | 19.3% |
| `metro` (location) | no location string that could be placed | 12.7% |
| `remote_scope` (remote reach) | a remote role that never said how far it reaches | 3.6% |
| `workplace` | no onsite / hybrid / remote signal at all | 2.3% — a floor, see below |
| `description` | no description text to search (758 jobs of 337,487) | 0.22% |
| `posted` | no publication date | 0.0% |

Three of those need the note that came with them:

- **`remote_scope` had been wrong rather than stale.** It read 83.1%, which is the share of jobs carrying no `d_remote_scope` value at all — but the matcher answers `no` for a job that is placed and not remote, not `unknown`. Only a remote job that never said how far it reaches, or a job with no workplace signal at all, is unknown: 3.6%. The old figure overstated the cost of excluding by 23×. A share measured a different way than the filter decides is worse than no number.
- **`employment_type` moved with each ATS.** It was genuinely 0.0% when Ashby was the whole corpus, because Ashby publishes `employmentType` on every job. Greenhouse publishes it on none — the key exists in the payload and was populated 0 times out of 1,140 sampled — which took it to 77.0%. Lever pulled it back to 66.4% by publishing a usable type on 72.5% of its jobs. `exclude` still discards two thirds of the market.
- **`workplace` is a floor.** 2.3% is the jobs with no workplace signal at all. Asking for **hybrid** adds 51.7% to that: 174,537 jobs are `onsite` by the `default-has-metro` guess rather than by the employer saying so, and Greenhouse — 165,962 of those — publishes no workplace field on any posting, so it can never say hybrid. The matcher answers `unknown` for those on a hybrid search and `match` on an onsite one, which is why no single share fits the slot. The guessed share fell from 65.2% because Lever states a workplace on 98.0% of its jobs — only 1,316 of its 71,789 land in the guess.

The app exposes the policies as their own panel — **"When a posting doesn't say"**, at the foot of the filter rail — one row per criterion, each printing the measured share next to a keep / drop switch. Across a sixty-board survey nothing else has an equivalent; the closest anyone gets is a single "include jobs without salary" checkbox on a single criterion.

`separate` is honoured but not offered there: it routes jobs into a second list and the page draws one result list, so a policy the page cannot render is not one the page can set. It still works in a saved profile and on the command line, where it shows up as the "worth a look" block in `npm run find` and in the daily report.

## What else a profile can say

All of it optional, and all of it reachable from the app, the CLI and a saved file alike. The full list of fields is `blankProfile()` in `src/lib/filter/profile.mjs`; every consumer starts from that blank so a field added later cannot be silently missing on an older saved document.

| field | what it does |
| --- | --- |
| `title_keywords` / `title_match` | whole-word matches against the title; `any` (default) or `all` |
| `description_keywords` / `description_match` | the same against the description, run in FTS5; gates and scores |
| `exclude_title_keywords` / `exclude_description_keywords` | the negative halves |
| `text` | free FTS5 query over title + company + description |
| `ats` | which of `ashby` / `greenhouse` / `lever` to draw from; the only criterion that can never be `unknown` |
| `metros` / `countries` | place, by registry id or ISO country code |
| `remote_counts_as_match` | remote roles carry a country and a scope but no metro, so a metro filter excludes them by construction; this flag changes that |
| `workplace` | subset of onsite / hybrid / remote |
| `remote_scope` | how far a remote role reaches — `worldwide` · `country` · `region` · `timezone`; only remote postings carry one, so this narrows remote rather than replacing the workplace filter |
| `employment_type` | e.g. `["FullTime"]` |
| `job_functions` | the derived function; `families` is the pre-rename key and still loads |
| `skills` / `skills_match` / `exclude_skills` | any-of or all-of against `d_skills`; the negative half is a field Stack Overflow Jobs paired with its positive one (`tl` / `td`) and no live board has copied |
| `seniority` | an explicit band allow-list; when empty, the years cap derives one (below) |
| `max_years_experience` / `min_years_experience` / `include_intern` | the years cap, and whether internships count |
| `salary_min` / `salary_max` | annualised figures |
| `posted_within_days` | age |
| `sort` | `relevance` (default) · `newest` · `oldest` · `salary-high` · `salary-low` · `quality` · `company`. Every order keeps the jobs that cannot answer it — they sink to the bottom, they never vanish. |
| `collapse_duplicates` | one row per company + title. 3,049 company + title pairs accounted for 10,164 open postings on the Ashby-only corpus — 16.6%, one role posted once per city; the copies fold into the survivor and their locations come with them. CareerBuilder's `ExcludeNational` was the only prior art and it is retired. |
| `pay_period` | `YEAR` · `HOUR` · `MONTH` · `WEEK` · `DAY` · `HALF_YEAR` · `NONE`. 1,901 open jobs (Ashby-only corpus) were priced hourly and invisible as a class without it. |
| `currencies` | ISO codes as the board published them — `["EUR"]`, `["USD","CAD"]`. Validated by shape (`/^[A-Z]{3}$/`) rather than against a list: the corpus carries 40-odd codes and grows one every time a board in a new country is swept. |
| `requires_equity` | postings with an equity component. Never rules a job out: no posting in the corpus says "no equity", so silence is unknown. |
| `salary_stated_only` | pay exactly as the employer published it, excluding figures that had to be reinterpreted (`d_salary_src` records the provenance). Glassdoor badges every figure "Employer Est." and offers no way to filter on it; Indeed, ZipRecruiter, SimplyHired, Adzuna, Talent.com and Monster all impute estimates and none let a searcher exclude them. |
| `company_size` | open roles at the company: `1` · `2-5` · `6-20` · `21-100` · `101-500` · `500+`. A proxy for size, labelled as the thing it actually counts — no ATS publishes headcount. |
| `companies` | an allow-list, by slug or display name. (`exclude_companies` was removed; a profile saved with one says so in `warnings` rather than losing the entries silently.) |
| `degree` | `none` · `bachelors` · `masters` · `phd` |
| `requires_visa_sponsorship` / `exclude_visa_refusal` | only the postings that say they sponsor, or merely not the ones that say they won't |
| `exclude_clearance` | drop the postings naming a security clearance — 896 on the Ashby-only corpus |
| `weights` | the ranking weights (below) |
| `limit` | rows returned, clamped to 1–5000; default 100 |

The seniority criterion consults two signals because they cover different jobs. A quarter of postings state no years at all but do carry `Senior` in the title; conversely `Solutions Analyst` carries no title marker but says "6+ years" in the body. Filtering on years alone lets every senior-titled posting with a silent description through; filtering on the band alone lets `Associate Consultant, 8+ years` through. The engine requires both to agree. A years cap admits the bands whose floor is at or under it:

| band | intern | entry | junior | mid | manager | senior | director | staff | principal | executive |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| floor (years) | 0 | 0 | 2 | 3 | 5 | 6 | 8 | 9 | 10 | 10 |

`intern` is excluded unless `include_intern` is set: an internship is a different thing from an entry-level job, and `employment_type` does not always say so — 437 jobs on the Ashby-only corpus carried `Intern` as their type while others posted internships as `FullTime`. A `min_years_experience` rules out bands that top out below it (entry and intern top out at 1, junior at 2, mid at 5, senior at 8).

`normalizeProfile()` coerces anything profile-shaped into a complete, valid document. Unknown keys survive into `extra` rather than being dropped, so a document saved by a newer UI round-trips through an older CLI without losing fields. Invalid enum members are dropped with a note in `warnings` — a typo'd metro silently returning zero jobs is exactly the failure the facet counts exist to prevent, so it says so out loud instead.

Salary bands in the facet counts are cut from the figures in the current result set rather than from a fixed ladder, so they describe an hourly warehouse search and a staff-engineer search differently.

## Running it

```bash
npm run find                                 # the default profile
npm run find -- nyc-entry-level --why        # named, with the score breakdown
npm run find -- ./my-profile.json            # or by path
npm run find -- --metros=nyc,boston --max-years=3
npm run find -- --facets                     # what loosening each filter would buy
npm run find -- --new-since=yesterday        # only jobs that appeared since
npm run find -- --sort=newest --collapse     # order it, fold duplicate postings
npm run find -- --pay-period=HOUR            # the hourly jobs
npm run find -- --equity --salary-stated     # equity, and pay as published
npm run find -- --unknown-salary=exclude     # only postings that published a figure
npm run find -- --json                       # machine-readable
npm run find -- --list                       # what profiles exist
```

With no profile named, `src/find.mjs` uses `profiles/nyc-entry-level.json` if it exists and otherwise the first profile in the directory alphabetically. A bare name is looked up in `profiles/` with or without `.json`; anything else is treated as a path.

Every flag is a profile field, so anything the CLI can express a saved profile can too, and there is no criterion that only the CLI can express. The flags, as `src/find.mjs` parses them:

| flag | profile field |
| --- | --- |
| `--ats`, `--metros`, `--countries`, `--workplace`, `--employment-type`, `--job-functions`, `--skills`, `--seniority`, `--keywords` / `--title-keywords`, `--description-keywords`, `--exclude`, `--companies`, `--degree`, `--company-size`, `--remote-scope`, `--pay-period`, `--currencies`, `--exclude-skills` | comma-separated lists |
| `--max-years`, `--min-years`, `--salary-min`, `--salary-max`, `--posted-within` | numbers (`none` or empty clears) |
| `--include-intern`, `--remote`, `--equity`, `--salary-stated`, `--exclude-clearance`, `--exclude-visa-refusal`, `--sponsors-visas`, `--collapse` | booleans (`=false` to unset) |
| `--text=…`, `--sort=…` | as named |
| `--unknown-<criterion>=<policy>` (`include`, `exclude` or `separate`) | one entry in `unknowns`, for any criterion on the roster |

Engine controls that are not profile fields: `--limit`, `--json`, `--facets`, `--why`, `--no-aside` (suppress the "worth a look" block), `--new-since=<YYYY-MM-DD | yesterday | last-sweep | 7d>` (restrict to jobs first seen since; `yesterday` means the day before the newest sweep day, not before today), `--description-limit`, `--list`, `--db=<path>`.

The report prints the active criteria, then the funnel — open jobs → after text and exclusions → past the title gate → matched → after folding duplicates → set aside on a `separate` criterion — because a count that drops with no explanation is indistinguishable from a filter that went wrong. Rows follow, then the "worth a look" block if any, then (with `--facets`) what loosening each of metro, workplace, seniority, salary, age, job function and company would buy.

## How it ranks

Filtering alone is not enough — even the tight NYC funnel returned 221 jobs on the Ashby-only corpus (708 standing on the full corpus, 2026-08-24). `relevance`, the default sort, is a weighted score, and the weights are profile fields rather than constants in the code:

| component | default weight |
| --- | --- |
| `text_match` | 30 |
| `title_keyword` (per distinct keyword matched) | 10 |
| `description_keyword` (per hit) | 1.5, capped at 6 |
| `recency` | 8 |
| `salary` | 4 |
| `years_fit` | 5 |
| `quality` (listing completeness) | 3 |

Title-keyword count dominates deliberately: it is what separates `AI Deployment Strategist` (3 keywords) from `Product Designer` (1), and on real titles that ordering is the one that reads correctly. Description hits are worth a fraction of a title hit and are capped: a word that appears once in 5 KB of prose says far less about a job than the same word in its title, and past the third or fourth hit it says nothing new. Both lists gate as well as score, but the gate is a yes/no and this is the ordering.

`text_match` is the largest weight because free-text search is the one input where the reader has said, in their own words, what they are looking for. It was worth nothing at all for a while: `profile.text` produced an id set that gated the corpus and then took no part in the ordering, so a job *at* Palantir and a job whose description mentions Palantir Foundry once in paragraph nine scored identically. Searching `palantir` put the first real Palantir posting at rank 137 of 1,568 — past the 200 rows the page draws — for 306 of its 308 openings. The weight has to clear the ~17-point spread the other components produce on a corpus scan, or a company-name hit still loses to a fresher posting elsewhere.

`--why` prints the breakdown per result. Two rules the measurements forced:

- **Whole-word matching, never substring.** `ai` as a substring returned 355 title hits instead of 263 on the Ashby-only corpus — the extras were `P-ai-d Social`, `Supply Ch-ai-n`, `Mount-ai-n View`.
- **Description keywords gate as well as score.** They used to score only, on a measurement saying 93.2% of jobs match at least one keyword from a typical list — a filter that removes 7% of the corpus is not a filter. That did not survive contact with a real list: the shipped profile's five terms were in 35.8% of the 61,213 open descriptions, against 29.5% of titles for its twelve title terms. The two lists are comparable filters, so both gate; turning the description gate on took that profile from 520 matches to 252. The gate runs in FTS5 rather than in the word-boundary matcher, because that is where the 296 MB of prose already is — slightly broader on hyphenated terms (`client-facing` also finds `client facing`) and never narrower, so it cannot drop a job the ranking pass would have credited.

The other six sort orders exist because a score is an opinion, and someone who disagrees needs a way to say so. There was no sort control at all until they were added, which put the project in company with ZipRecruiter, Monster, CareerBuilder and Talent.com, none of which have one. Each names the column it reads so the menu cannot promise an order the engine does not implement: `newest` / `oldest` by posting date with undated postings last; `salary-high` by the top of the published range, `salary-low` by the bottom, unpublished pay last; `quality` by how many of the eight filterable fields the posting filled in; `company` alphabetical, then by score within a company. Sorting by salary with most of the corpus publishing nothing must not become a salary filter nobody asked for — the same rule the criteria follow, applied to the ordering.

## Why the filter is in memory, not in SQL

The obvious build is one `WHERE` clause per criterion and a `GROUP BY` per facet. It was measured and rejected. Facet counts have to be **leave-one-out** — "how many more jobs if Boston is also ticked" is not the same query as the result set — so each dimension is its own query, and the title gate ends up expressed twice: as FTS for SQL and as word-boundary regex for ranking, with two different notions of what a word is.

Instead, the hot columns (ids, title, company, the `d_*` enums and figures, dates — everything except the description and the two links) are loaded into memory once. On the Ashby-only corpus that took **388 ms and ~190 MB** for 61,213 open jobs, and every query after it ran in **74–160 ms** with all nine facets computed in the same pass, using the same matcher the derive pass is regression-tested against. The cold 296 MB of descriptions stays in SQLite and is read only for rows that survived the filter — 453 of them for the shipped profile. Facet computation costs ~200 ms of a query and is skipped when the caller does not want counts (the daily diff does not).

On the full three-ATS corpus, a warm filter run over all 337,487 jobs with every facet counted measured **1.4–4.3 s** (2026-08-22), with ~10 s to build the index on the first query after a sweep. It was ~800 ms at 265,698 jobs; the re-measurement was taken on a machine also running the app server and DB Browser, so the top of that range is contention rather than cost. Building the index is one synchronous pass over every open row — ~3 s on a laptop, ~20 s on the deployed machine — and the server does it before opening the port rather than after, because warming inside the `listen` callback hid the wait behind an open port and the first visitors after a deploy sat through the build. The index retains ~427 MB on the deployed copy; building it holds the raw SQLite rows and the built objects alive at once, which peaked at ~1.5 GB RSS and OOM-killed a 2 GB machine on first boot, so the deployed machine has 4 GB (see [deploy.md](./deploy.md)).

Two things changed on 2026-08-26, ahead of the corpus roughly tripling as Workday lands, and both are measured on the same 339,145-job corpus. The index is now **streamed** out of SQLite a row at a time rather than read whole: `.all()` materialised every open row as an object and the build then made a second object from each, so both copies of the entire corpus were alive at once and none of the first could be collected until the last was built. That is what made building a 450 MB index cost 1,705 MB of RSS. Streaming it dropped the peak to **880 MB RSS / 394 MB heap** with the build time unchanged (3,205 ms → 3,266 ms). Separately, `url` and `apply_url` **left the index**: they averaged 133 characters a row — more than title, company and the JSON columns together — and no criterion, ranker or facet had ever read them. They are fetched from SQLite for the ~50 rows on the page instead, exactly as descriptions already were, and the retained index fell from 450 MB to **387 MB**. Scaled to a million jobs that is the difference between wanting ~5 GB of RSS and wanting ~2.6 GB, on a machine that has 4 GB.

The index is cached and invalidated on the derive generation — `last_derive` plus the open-job and derived-job counts — so a re-derive is picked up without a restart. Reading that generation is three single-row queries, which sounded free and was not: `search()`, the missing-descriptions check and the metro-label lookup each asked, and on the 337k-job corpus that was 264 ms of a 767 ms query spent re-answering "has anything changed?" three times inside one request. The reading is now trusted for 500 ms, long enough that one request pays once and short enough that a re-derive in another process is still picked up; `invalidateIndex()` bypasses it for an in-process re-derive.

Free-text search (`text`) and the description-keyword gate are the two things that still run in SQLite, through the FTS5 index, because the prose is there and only there.
