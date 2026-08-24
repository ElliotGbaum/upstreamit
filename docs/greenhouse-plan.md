# Greenhouse plan

The plan and live measurements for adding Greenhouse as the second ATS alongside Ashby, together with the ATS filter that had to land in the same change. Written 2026-08-22; every number below was probed live against the Greenhouse board API on that date rather than read from documentation, and the probe commands are in the appendix so any of it can be re-run when it goes stale. File and line references are as of that date. Greenhouse and Lever were both built afterwards; the as-built numbers are in [design-notes.md](./design-notes.md) and the current corpus counts are on the site.

---

## The decision

**Greenhouse next.** Not Lever, not SmartRecruiters.

| | **Greenhouse** | Lever | Ashby (at the time) |
| --- | --- | --- | --- |
| Slugs already on disk | **15,197** | 8,721 | 7,951 |
| Live rate, sampled | **50.8%** (122/240) | 27.5% (55/200) | 54.0% (4,297/7,951) |
| → live boards | **~7,700** | ~2,400 | 4,297 |
| Jobs per live board | 12–16 | 86 (skewed) | 14.2 |
| → open jobs added | **~92,000–123,000** | wide, unreliable | 61,213 |
| One GET = whole board | yes | yes | yes |
| Auth | none | none | none |
| Pagination | none | none | none |
| `HEAD` liveness probe | **200/404, correct** | untested | 200/404 |
| Conditional GET | **304 on `If-None-Match`** | untested | 304 |
| Per-job salary published | 33.1% | 43.4% | 37.2% |
| Change detection | **`updated_at`, 100%** | `createdAt` only | none — content hash |
| Company display name | **`company_name`, per job** | board only | GraphQL, rate-limited |

Greenhouse roughly **triples the corpus** off a slug list already sitting in
`data/slugs/greenhouse.txt`, on the same one-unauthenticated-GET shape the Ashby
adapter already proves out. Lever is the obvious follow-on but adds a third of the
jobs for the same adapter work, and its description is split across four fields.

### Method, so the numbers can be trusted or discarded

Three independent samples were drawn from `data/slugs/greenhouse.txt` by evenly-spaced
stride (deterministic, reproducible), at concurrency 10, no auth, honest User-Agent:

| Run | Slugs sampled | Boards 200 | Jobs seen | What it measured |
| --- | --- | --- | --- | --- |
| A | 240 | 122 (50.8%) | 1,922 | liveness, jobs/board, per-job pay share |
| B | 120 | — | 626 | field fill rates, content escaping, location shapes |
| C | 160 | 96 (60.0%) | 1,140 | payload bytes, `employment`, `metadata`, pay shape |

**Liveness came out at 50.8% and 60.0% on two different subsets** — about two standard
errors apart at these sample sizes — so the plan is against a range of **7,700 ± 800
live boards**, with step 0 (a real `--sample=1000` probe run) as the number that
settles it. 7,700 is a projection, not a count.

Zero 429s, zero 5xx, zero timeouts across all three runs at concurrency 10.

---

## The API

```
GET https://boards-api.greenhouse.io/v1/boards/<slug>/jobs?content=true&pay_transparency=true
```

One request, entire board, full descriptions, no pagination, no key. Same shape as
Ashby's posting API.

Everything else confirmed live:

| Endpoint | Status | Returns | Use |
| --- | --- | --- | --- |
| `/v1/boards/<slug>` | 200 | `{name, content}` | **company display name, one cheap call** |
| `/v1/boards/<slug>/jobs` | 200 | jobs without `content` | small; the liveness/count call |
| `/v1/boards/<slug>/jobs/<id>` | 200 | one job, same keys | not needed — the board call is complete |
| `/v1/boards/<slug>/departments` | 200 | department tree + jobs | not needed for v1 |
| `/v1/boards/<slug>/offices` | 200 | offices with `location` strings | **richer than the job payload's offices — see gotcha 6** |
| `HEAD /v1/boards/<slug>/jobs` | 200 / 404 | zero bytes | the verification pass |

Hosts and redirects, checked:

- `boards.greenhouse.io/<slug>` → **301** → `job-boards.greenhouse.io/<slug>`.
  `job-boards.greenhouse.io` is the canonical human-facing host; `boardUrl()` should
  use it.
- A board with its own careers site then **302**s onward to the company
  (`job-boards.greenhouse.io/stripe` → `stripe.com/jobs/search`). Expected, not an error.
- **There is no EU API mirror.** `boards-api.eu.greenhouse.io` does not resolve;
  `api.eu.greenhouse.io` returns the Greenhouse web app's HTML with a 200 — a trap if
  anything ever probes it and reads the status code alone. EU boards are served from
  the same `boards-api.greenhouse.io`. `normalize.mjs` already carries the
  `boards.eu.greenhouse.io` *board-URL* patterns, which is correct and unrelated.

### Conditional GET works, and the stored ETag was never being sent

```
GET  /v1/boards/stripe/jobs                         → 200, ETag: W/"027b1d56…"
GET  /v1/boards/stripe/jobs  If-None-Match: W/"…"   → 304, zero bytes
```

Ashby does this too (verified against `ramp`: `W/"job-board:e150b520…"` → 304).

`companies.last_etag` was **written on every sweep and never read back**
(`src/lib/db.mjs:148,157,171`; `src/sweep.mjs:135`). At Ashby's scale that was a
missed optimization. At Greenhouse's scale it is the difference between a ~1.2 GB
daily re-sweep and one that transfers almost nothing. See step 6.

One plumbing consequence: `getJson` in `src/lib/http.mjs` treated every non-2xx as
`ok:false` with `error:'HTTP 304'`. A 304 is an **answer** — "nothing changed" — not a
failure, and needs its own branch, the same way 404 already means "dead, never retry".

---

## Payload → common schema

Union of keys across 1,140 jobs on 96 boards:

```
absolute_url, data_compliance, education, internal_job_id, location, metadata, id,
updated_at, requisition_id, title, pay_input_ranges, company_name, first_published,
language, application_deadline, content, departments, offices, ai_disclaimer,
include_ai_disclaimer, ai_opt_out_request_url, employment
```

| `blankJob()` field | Greenhouse source | Fill | Note |
| --- | --- | --- | --- |
| `ats` | literal `'greenhouse'` | — | |
| `company_slug` | the slug | — | |
| `company_name` | `company_name` | 100% | **on every job** — Ashby needs a rate-limited GraphQL call for this |
| `native_id` | `String(id)` | 100% | `internal_job_id` is a different number; do not use it |
| `id` | `jobId('greenhouse', slug, native_id)` | — | |
| `title` | `title.trim()` | 100% | 11.6% carry stray whitespace (132/1,140) |
| `title_norm` | `normText(title)` | — | |
| `department` | `departments[0].name` | 99.6% | free text, often internal (`"1653 Startups - Account Executives (NA)"`) |
| `team` | — | 0% | no such concept; leave null |
| `employment_type` | — | **0%** | see gotcha 4 |
| `location_raw` | `location.name` | 100% | |
| `locations_all` | `location.name` ∪ `offices[].name` ∪ `offices[].location` | — | see gotcha 6 |
| `city` / `region` / `country` / `postal_code` | — | 0% | no structured address; the derive pass parses the string |
| `raw_workplace` | — | **0%** | see gotcha 3 |
| `raw_remote` | — | 0% | leave null — do **not** synthesize from the location string |
| `posted_at` | `Date.parse(first_published)` | 99.8% | fall back to `updated_at` |
| `source_updated_at` | `Date.parse(updated_at)` | **100%** | Ashby has nothing equivalent |
| `url` | `absolute_url` | 100% | may point at the company's own site |
| `apply_url` | `absolute_url`, else `job-boards.greenhouse.io/<slug>/jobs/<id>` | — | |
| `comp_min` / `comp_max` | `pay_input_ranges[].min_cents / 100` | 33.1% | **cents** — gotcha 5 |
| `comp_currency` | `pay_input_ranges[].currency_type` | | |
| `comp_interval` | inferred from `pay_input_ranges[].title` | | gotcha 5 |
| `comp_text` | `pay_input_ranges[].title` | | the `blurb` is HTML boilerplate; drop it |
| `has_equity` | — | 0% | sometimes in `metadata`; v2 |
| `description_html` | `decodeEntitiesOnce(content)` | 100% | gotcha 1 |
| `description_text` | `htmlToText(decodeEntitiesOnce(content))` | — | gotcha 2 |

---

## The seven gotchas

Each one measured; each one would otherwise cost a debugging cycle.

### 1. `content` is HTML-entity-escaped — decode exactly once

The payload contains `&lt;h2&gt;Who we are&lt;/h2&gt;`, not `<h2>`. **626 of 626** jobs
in run B were escaped; **zero** arrived as raw HTML. Ashby's `descriptionHtml` is raw,
so the two adapters must not share a parser — this was already flagged in the project
notes and is now confirmed universal rather than anecdotal.

Decode **once**, never in a loop until stable:

- 96.8% of payloads (1,104/1,140) contain `&amp;` — that is the correct single-escape
  of a literal `&` in the prose (`Fish &amp;amp; chips` → `Fish &amp; chips` → renders
  `Fish & chips`). A second decode pass turns it into a bare `&` and corrupts the HTML.
- 2 of 1,140 contain `&amp;lt;` — genuinely double-escaped, i.e. the original posting
  displayed a literal `&lt;`. A single decode is right for those too.

### 2. There is no `descriptionPlain`

Ashby supplies plaintext. Greenhouse gives only `content`. The adapter has to produce
the plaintext itself, and four things read it: the description keyword gate (FTS5), and
the skills, degree and visa derivations. A weak strip — one that leaves `</p>` glued to
the next sentence, or drops `<li>` boundaries — degrades all four silently.

Minimum viable `htmlToText`: decode once → drop `<script>`/`<style>` bodies → convert
`<br>`, `</p>`, `</li>`, `</h1-6>`, `</div>`, `</tr>` to newlines → strip remaining tags
→ decode entities in the surviving text → collapse 3+ newlines to 2.

It belongs in `src/lib/adapters/html.mjs`, not inside the Greenhouse adapter — Rippling,
Breezy and every future HTML-only ATS need the identical function, and a second copy is
how the two drift.

### 3. No workplace enum — hybrid effectively disappears

Greenhouse publishes no `workplaceType`. The only signal is the location string:

- 31.2% of location names match `/remote/i` (195/626)
- **0.5% match `/hybrid/i` (3/626)**

Against Ashby, where `workplaceType` is explicit and **26% of the corpus is Hybrid**
(15,932 of 61,213). So the hybrid population does not become wrong on Greenhouse rows —
it becomes *invisible*, and `deriveWorkplace` will classify most of it `onsite` via the
`default-has-metro` rule (`src/lib/derive/workplace.mjs`).

This matters specifically for the shipped NYC profile, whose whole point is "in person,
and Hybrid counts." Those two values collapse into one on Greenhouse rows. The
derivation is not wrong to do it — a named office with no remote marker *is* an office
job — but `d_workplace_src` becomes the only way to tell a Greenhouse `onsite` (guessed
from having a metro) from an Ashby `onsite` (stated by the employer). **This is the
single strongest argument for shipping the ATS filter in the same change**, not after:
it is how the difference becomes visible instead of silently averaged.

`deriveWorkplace` needs no code change. It already handles a missing enum.

### 4. No employment type at all

An `employment` key appears in the union of keys, and is populated on **0 of 1,140**
jobs. There is no `employment_type` in the Greenhouse board API.

Consequence: `employment_type` is NULL for every Greenhouse row. At the time of writing
that criterion was listed in `UNKNOWNABLE` at **`share: 0.0`** — the one criterion where
nothing is ever unknown. After this sweep it is roughly **62% unknown corpus-wide**
(~100k of ~161k). See "the measured shares go stale" below.

A partial fallback exists in `metadata` (32.8% of jobs carry custom fields, and
`Employment Type` / `Job Type` are among the observed names) — but those are per-board
custom schemas with no shared vocabulary. **v2, deliberately.** Guessing an enum from a
board's free-text custom field is exactly the "silent wrong answer" the location parser
was built to avoid.

### 5. `pay_transparency=true`, and the money is in cents

Two independent traps in one field.

**The param.** Without `&pay_transparency=true` the `pay_input_ranges` key is absent
from the response entirely — confirmed by diffing the key union with and without it.
Same class of bug as Ashby's lowercase-only `includeCompensation=true`, which returns
200 and silently omits every salary.

**The shape.**

```json
[{ "min_cents": 8500000, "max_cents": 10000000, "currency_type": "USD",
   "title": "Budgeted Salary Range (not including eligible commission):",
   "blurb": "<p>For full-time U.S. based-employees…</p>" }]
```

- `min_cents` / `max_cents` are **cents**. `8500000` is $85,000, not $8.5M. A missing
  `/100` puts every Greenhouse job in the `$200k+` salary band and quietly wrecks the
  facet.
- The array holds **several ranges per job**, and they are not all base salary. Observed
  titles include `Bonus Range`, `Zone 1 (National Average)`, `Remote Pay Range`, `Hourly
  Pay Range`, and job-title-shaped ones (`Director Of Marketing`). Pick the way the Ashby
  adapter picks `compensationType === 'Salary'` from `summaryComponents` — except there
  is no type field here, so it has to be a title heuristic: skip anything matching
  `/bonus|equity|commission|sign[- ]on/i`, prefer the first survivor.
- Interval is only in that prose title. 27 of 203 observed ranges mention "hour". Map
  `/hour/i → 'HOUR'`, else `'YEAR'`. An hourly range read as annual reads as $18 total
  compensation and will be filtered out by every salary floor.
- Pay transparency is a **board-level setting, not a per-job one**: 33.1% of *jobs*
  carry a range but only 14.8% of *boards* do (18/122). The boards that publish are the
  big ones. Expect the salary facet to be lumpy by company, not evenly thin.

### 6. `location.name` is free text, and the comma is ambiguous

37.4% of location names contain a separator beyond a single comma. But the separator is
usually structure, not a list:

```
"New York, New York, United States"     ← one place, city/region/country
"Austin, Texas, United States"          ← one place
"Detroit, Michigan 48209"               ← one place, with a postal code
"New York or Boston"                    ← two places
"New York, Chicago, or Miami"           ← three places
"Wilkes-Barre, PA, Reno, NV, or Batesville, IN"  ← three places
"Playa Vista, CA or Remote"             ← a place and a remote option
"Richmond, VA (Henrico/West End)"       ← one place with a parenthetical
```

`" or "` is the reliable multi-place marker; the comma is not.

**No parser change is needed.** `parseFragment` in `src/lib/derive/location.mjs`
already splits on `,` `|` `/` `;` `or` `and` and then matches each token against the
known city/region/country tables, discarding what it cannot place. "Austin, Texas,
United States" yields the Austin metro plus the US country from three tokens; "New York
or Boston" yields two metros. The conservative design handles both without being told
which case it is in. Worth recording anyway, because the project notes describe
"`location.name` can pack several cities into one string" as a Greenhouse gotcha, and
that phrasing invites a comma-splitter that breaks the common case.

The **union** rule from the Ashby adapter still applies and still earns its keep: put
`location.name`, every `offices[].name`, and every `offices[].location` into
`locations_all`. Note that `offices[].location` is filled on only **38.4%** of office
entries in the job payload (245/638) — the `/offices` board endpoint has it far more
often (`"Dubai, Dubai, United Arab Emirates"` where the job payload just says `"US"`).
Fetching `/offices` per board is a second request and a v2 enrichment, not v1.

### 7. Department names are internal and messy

`departments[0].name` on Stripe reads `"1653 Startups - Account Executives (NA)"` —
requisition-numbered internal org names. This is the same free-text problem that already
produced 464 distinct department spellings across Ashby boards, and it is why
`d_job_function` is derived from the title first and the department second. Store the
raw string; do not surface it as a filter.

---

## What Greenhouse provides that Ashby does not

1. **`updated_at`, on 100% of jobs.** Real change detection instead of `hashJob`'s
   content fingerprint. The hash stays — it is the cross-ATS mechanism and it catches
   edits an ATS forgets to timestamp — but `source_updated_at` becomes trustworthy for
   Greenhouse rows, which makes "what actually changed today" answerable rather than
   inferred.
2. **`company_name` on every job.** Ashby requires the rate-limited GraphQL endpoint
   (concurrency 2, backoff) to learn display names, which is why the app at the time
   still read `Mistral.Ai` and `Silnahealth.Com` — the Phase 6 "real company display
   names" item. Greenhouse rows arrive with correct names for free, and
   `/v1/boards/<slug>` gives the board name in one more cheap call.
3. **Conditional GET that can actually be exploited** (both ATSes support it; only
   Greenhouse's scale forces the issue).
4. **~2× the live boards** off a slug list already collected and never verified.

## What it costs

1. **No hybrid signal** (gotcha 3) — the real regression.
2. **No employment type at all** (gotcha 4).
3. **Salary is board-level and lumpy** (gotcha 5).
4. **~1.2 GB per full content sweep.** Measured 13.8 MB across 96 boards = **12.7 KB per
   job**, ~144 KB per board. At ~100k jobs that is ~1.2 GB, against Ashby's 13.7 KB/job.
   Not a blocker; it is the reason step 6 (conditional GET) stops being optional.

---

## The ATS filter

Ships in the same change. Half the value of a second ATS is being able to see which one
a job came from, and the workplace regression above is invisible without it.

(`app/app.js` line numbers are deliberately omitted — the file was being edited
concurrently and grew 35 lines mid-research. Anchor on the symbols instead.)

The groundwork was already there: `jobs.ats TEXT NOT NULL` with
`idx_jobs_ats ON jobs(ats, is_open)` (`src/lib/schema.mjs:153,223`), `ATS_KEYS` already
listing 20 ids in display order (`src/lib/schema.mjs:25`), and a facet system that is
table-driven by design.

| File | Change |
| --- | --- |
| `src/lib/filter/index.mjs:37` | add `j.ats` to `HOT_COLUMNS` |
| `src/lib/filter/index.mjs:88` | add `ats: r.ats` to the in-memory row |
| `src/lib/filter/index.mjs:337` | one row in `FACET_DIMENSIONS`: `{ key: 'ats', criterion: 'ats', values: (j) => [j.ats] }` |
| `src/lib/filter/match.mjs` | `matchAts(job, profile, c)` + one row in `CRITERIA` |
| `src/lib/filter/profile.mjs` | `ats: []` in `blankProfile`, `subsetOf(input.ats, ATS_KEYS)` in `normalizeProfile`, one line in `activeCriteria` |
| `src/lib/filter/index.mjs:627` | `corpusMeta`: add `ats: SELECT ats, COUNT(*) … GROUP BY ats` so the control's universe comes from data |
| `app/index.html` | one `<section class="card collapsed" data-panel="ats">` with `<div class="options" id="ats-options">` |
| `app/app.js` — next to `drawEmployment` | `const drawAts = optionList('ats-options', 'ats')` |
| `app/app.js` — in `redrawFacets` | `drawAts(facets.ats ?? [])` |
| `app/app.js` — the panel/badge map | `'ats': { badge: 'n-ats', fields: ['ats'] }` |
| `src/filter-test.mjs` | cases: empty list inactive, match, no, and a facet leave-one-out |

~60 lines. Two design decisions, recorded so they are not re-litigated:

**It is the first criterion that can never be unknown.** Every job has an `ats` — it is
`NOT NULL` and the adapter sets it literally. So `ats` does **not** join `UNKNOWNABLE`
and gets no include/exclude/separate control. That is consistent with the project rule,
not an exception to it: the rule is that a criterion may only rule a job out on
published evidence, and here the evidence is always present.

**It is a real criterion, not a display badge.** Putting it in `CRITERIA` (rather than
filtering the row set before evaluation) is what makes the leave-one-out facet counts
work — "how many more jobs would this profile get if it also allowed Greenhouse" is the
same set-size question every other facet answers, and short-circuiting it would make the
ATS counts the only ones in the UI that lie.

---

## The measured shares go stale the moment this lands

This is the least obvious consequence and the easiest to ship a wrong number on.

`UNKNOWNABLE` in `src/lib/filter/profile.mjs` publishes a `share` per criterion,
rendered next to each unknown-policy control, measured over the 61,213-job all-Ashby
corpus. Those percentages are the only thing standing between a user and silently
discarding most of the market. Every one of them becomes wrong:

| Criterion | Before (Ashby only) | After Greenhouse, projected |
| --- | --- | --- |
| `employment_type` | 0.0% | **~62%** — Greenhouse publishes none |
| `workplace` | 1.1% | rises; and `hybrid` stops appearing on ~60% of the corpus |
| `salary` | 62.8% | ~65% (Greenhouse 33.1% known vs Ashby 37.2%) |
| `metro` | 15.9% | unknown until measured — Greenhouse location strings are free text |
| `degree`, `skills`, `visa`, `experience` | 75.6 / 28.4 / 96.8 / 24.9% | all derived from description text; shift with the corpus |

Same for the prose: the header comment in `src/lib/derive/workplace.mjs` quotes an exact
`OnSite 19,859 / Remote 16,495 / Hybrid 15,932 / null 8,927` breakdown that will read as
current and be a year out of date.

**Re-measure after the first full sweep and derive, and update both.** It is in the
acceptance checks below so it cannot be forgotten — a stale 0.0% next to "job type" is
worse than no number, because it reads as measured.

---

## Other things hardcoded to Ashby

Found by grep; all small, all have to move for the second ATS to be a first-class
citizen rather than a bolt-on.

| Location | At the time | Needs |
| --- | --- | --- |
| `src/probe-ashby.mjs` | whole file: `POSTING_API` const, `ashby.json`/`ashby-verified.json`/`ashby-live.txt` paths, 15 mentions | generalize → `src/probe-boards.mjs --ats=<x>` driven by `adapter.probeUrl(slug)` |
| `src/lib/filter/index.mjs:647` | `last_sweep: Number(meta.last_sweep_ashby ?? 0)` | per-ATS map — `sweep.mjs` already writes `last_sweep_<ats>` |
| `src/daily.mjs:42-43` | `script: 'probe-ashby.mjs'`, `args: ['--ats=ashby']` | loop over configured ATSes |
| `src/stats.mjs:19` | `const ats = process.argv[2] ?? 'ashby'` | fine as a default; document it |
| `package.json` | `sweep`, `verify`, `verify:all`, `refresh` all say ashby | add `sweep:greenhouse`, `verify:greenhouse`; make `refresh` loop |
| `src/lib/adapters/index.mjs` | registry already lists 18 ids | **17 of them have no file** — `loadAdapter` catches and returns null, so this is inert, but `availableAdapters()` returned `['ashby']` and will return `['ashby','greenhouse']` |

Note also: `src/lib/db.mjs` is detected by `file(1)` as `data`, not text — it contains a
byte that makes `grep` treat it as binary (`grep -a` works). Unrelated to this work;
worth a look sometime.

---

## Implementation plan

Ordered so each step is independently verifiable and nothing later depends on a guess.

### Step 0 — measure liveness for real (~25 min wall clock, no code)

Generalize the probe first (step 2) or run a one-off: `HEAD` all 15,197 slugs at
concurrency 8. Settles the 50.8%-vs-60.0% question and produces
`data/slugs/greenhouse-live.txt`, which `sweep.mjs` already prefers over
`greenhouse.txt` (`src/sweep.mjs:43`). Zero 429s were observed at concurrency 10, so 8
is conservative.

### Step 1 — `src/lib/adapters/html.mjs` (~60 lines)

`decodeEntitiesOnce(html)` and `htmlToText(html)`. Shared, not Greenhouse-local
(gotcha 2). Unit-testable with no network — add cases to `filter-test.mjs` or a new
`adapters-test.mjs`: the `&amp;` single-decode case and the `&amp;lt;` double-escaped
case are the two that matter.

### Step 2 — `src/probe-boards.mjs` (~30 min)

Copy `probe-ashby.mjs`, replace the hardcoded `POSTING_API` with
`adapter.probeUrl(slug)`, parameterize the three file paths on `--ats=`, keep the
`--sample` / `--only-unknown` / `--concurrency` flags and the "a network error never
overwrites a known-good verdict" rule verbatim — that rule is load-bearing. Keep the
Ashby `--with-names` GraphQL pass behind an adapter capability check so it does not
follow Greenhouse around; Greenhouse does not need it.

Leave `probe-ashby.mjs` as a thin shim or delete it and update `package.json` +
`daily.mjs:42` together. Do not leave two probes.

### Step 3 — `src/lib/adapters/greenhouse.mjs` (~150 lines)

Mirror `ashby.mjs` exactly: `id`, `label`, `concurrency`, `boardUrl`, `apiUrl`,
`probeUrl`, `fetchBoard`, `mapJob`. Header comment carries gotchas 1, 4 and 5 next to
the code that depends on them — same convention as the Ashby adapter's
`includeCompensation` note.

- `concurrency`: start at **8**. 10 held with zero 429s across ~500 board fetches, but
  that was minutes, not an hour-long sweep.
- `apiUrl` must carry **both** `content=true` and `pay_transparency=true`.
- `dead: res.status === 404`, matching the Ashby contract.

### Step 4 — the ATS filter (~60 lines)

The table above. Ship with tests.

### Step 5 — sweep, derive, measure

```
node src/probe-boards.mjs --ats=greenhouse            # step 0, if not already run
node src/sweep.mjs --ats=greenhouse --limit=200       # smoke: ~200 boards, eyeball the rows
node src/sweep.mjs --ats=greenhouse                   # full, ~1.2 GB, hours
node src/derive.mjs --only-new
node src/stats.mjs greenhouse
```

Then re-measure every `share` in `UNKNOWNABLE` and update the prose numbers in
`workplace.mjs`, `profile.mjs` and the project notes.

### Step 6 — conditional GET (now, not later)

Send `If-None-Match: companies.last_etag` on every board fetch; treat 304 as "unchanged,
skip the upsert, still mark the board swept". Needs:

- `getJson`/`request` in `src/lib/http.mjs` to return 304 as a distinct outcome rather
  than `error: 'HTTP 304'`
- `fetchBoard(slug, opts)` to accept `etag` — the signature already takes `opts`
- `sweep.mjs` to read `last_etag` alongside the slug list
- `markBoard` to record the sweep without touching job rows

Turns the daily re-sweep from ~1.2 GB into approximately nothing on unchanged boards,
and applies to Ashby unchanged. **Caveat to verify before trusting it:** a 304 means the
*response body* is unchanged, so a board whose ETag is stable is assumed to have no new
jobs. That is the intended behaviour, but it means a bug in Greenhouse's ETag would look
like a board that stopped hiring. Sanity-check by forcing a full re-fetch weekly
(`--no-conditional`) and diffing counts for the first month.

### Step 7 — docs

Project notes: a "Phase 8 — Greenhouse, as built" section, the corrected corpus numbers,
and move Greenhouse out of "Next:". README: the new commands.

---

## Acceptance checks

As written in the plan; the as-built results are in [design-notes.md](./design-notes.md).

- [ ] `node src/probe-boards.mjs --ats=greenhouse --sample=300` reports a live rate in
      the 45–65% band. Far outside it means the slug list or the probe is wrong.
- [ ] A smoke sweep of 200 boards produces jobs whose `comp_min` values are plausible
      salaries, not 100× too large (gotcha 5).
- [ ] `SELECT COUNT(*) FROM jobs WHERE ats='greenhouse' AND description_text LIKE '%&lt;%'`
      returns **0** (gotcha 1 — undecoded content leaked into plaintext).
- [ ] `SELECT COUNT(*) FROM jobs WHERE ats='greenhouse' AND description_text LIKE '%<p>%'`
      returns **0** (gotcha 2 — tags survived the strip).
- [ ] `SELECT ats, COUNT(*) FROM jobs WHERE is_open=1 GROUP BY ats` shows both.
- [ ] The ATS facet in the UI shows two rows with counts that sum to the result total.
- [ ] Ticking `greenhouse` alone and then `ashby` alone partitions the result set —
      no job appears in both, and the two counts sum to the unfiltered total.
- [ ] Every `share` in `UNKNOWNABLE` re-measured against the combined corpus.
- [ ] `npm test` passes.
- [ ] The shipped `profiles/nyc-entry-level.json` still returns a sane result set, and
      the hybrid population is spot-checked for the Greenhouse collapse (gotcha 3).

---

## The runners-up, with evidence

**Lever** — `api.lever.co/v0/postings/<slug>?mode=json`. Confirmed live (200, full
descriptions inline). The clear #3.

- Live rate **27.5%** (55/200) → ~2,400 live boards from 8,721 slugs.
- 86 jobs per live board, but badly skewed — `leverdemo` alone returns 2.4 MB. The mean
  is not the typical board; do not plan capacity off it.
- **Better data than Greenhouse in two ways**: a real `workplaceType` enum with values
  `onsite` / `hybrid` / `remote` (verified), and `salaryRange` on **43.4%** of jobs —
  higher than either Ashby or Greenhouse.
- Confirmed field union: `additional, additionalPlain, categories, createdAt,
  descriptionPlain, description, id, lists, salaryRange, text, country, workplaceType,
  opening, openingPlain, descriptionBody, descriptionBodyPlain, hostedUrl, applyUrl`.
- The known gotchas hold: title is in **`text`**, not `title`; the description is split
  across `description` + `lists[].content` + `additional` (+ `opening`) and reading only
  one field yields ~13% of the text; location is `categories.location` with
  `categories.allLocations` as the union.
- `descriptionPlain` / `additionalPlain` / `openingPlain` exist, so **no HTML parsing is
  needed** — concatenation is the whole job. Arguably a *simpler* adapter than
  Greenhouse's.

**Rippling** — `api.rippling.com/platform/api/ats/v1/board/<slug>/jobs`. Confirmed live,
single JSON array, no auth, no pagination, 223 KB for its own board. Adapter is easy.
**There are zero slugs on disk for it.** That is a discovery problem, not an adapter
problem, and discovery is the expensive half.

**Breezy** — `<slug>.breezy.hr/json`. Confirmed live, clean array. Same zero-slug
problem.

**SmartRecruiters — skip.** `api.smartrecruiters.com/v1/companies/<id>/postings` returned
**HTTP 200 with `totalFound: 0`** for every identifier tried (`Ubisoft`, `Visa`,
`Bosch`, `IKEA`, `McDonalds`). It never 404s. That breaks the one question the entire
slug pipeline is built on — "does this board exist?" — because a wrong slug and an empty
board are indistinguishable. Everything downstream (`probe`, `markBoard`'s
`dead`/`empty` distinction, the removal-not-deletion rule) depends on being able to tell
those apart. Not worth adapting until a correct identifier scheme is found.

**Workable — friction.** `apply.workable.com/api/v1/widget/accounts/<slug>?details=true`
returns the account name with an **empty `jobs` array** for real accounts (`gitlab`,
`veriff`). Needs a different endpoint; not free.

**Workday / iCIMS / Paylocity / BambooHR — a different project.** 44,558 slugs collected
across the four (`workday` 12,884, `bamboohr` 11,316, `paylocity` 10,252, `icims`
10,106), and not one is a single unauthenticated GET returning JSON. Workday is POST +
tenant/site pairs + pagination; iCIMS is HTML. Real work, not this work.

---

## Open questions at the time of writing

1. **Verify all 15,197 slugs, or sweep the unverified list directly?** Verifying
   is ~15k HEADs (cheap, minutes) and halves the sweep. Decision: verify.
2. **Concurrency for an hour-long sweep.** 10 was clean for minutes. Start at 8, watch
   for 429s, and add the `Retry-After` handling `http.mjs` already has.
3. **Does the daily run sweep both ATSes every day, or alternate?** With conditional GET
   (step 6) both every day is cheap. Without it, ~1.2 GB/day is not.
4. **`metadata` mining for employment type and equity** (gotcha 4) — deferred. Revisit
   once there is a measurement of how consistent the field names are across boards.
5. **`/offices` per-board enrichment** (gotcha 6) — deferred. One extra request per
   board for better location strings on the 61.6% of office entries that lack one.
6. **Should `boardUrl` prefer `job-boards.greenhouse.io/<slug>` or `absolute_url`?**
   `absolute_url` is what the employer wants clicked and often lands on their own site;
   the Greenhouse-hosted page is more uniform. As planned: `url` = `absolute_url`,
   `apply_url` falls back to the hosted page.

---

## Appendix — reproducing the numbers

```bash
# liveness + jobs/board + per-job pay share  (run A)
node -e '
  const fs=require("fs");
  const all=fs.readFileSync("data/slugs/greenhouse.txt","utf8").split("\n").map(s=>s.trim()).filter(Boolean);
  const N=240, step=Math.floor(all.length/N);
  const sample=Array.from({length:N},(_,i)=>all[i*step]).filter(Boolean);
  // HEAD or GET ?pay_transparency=true at concurrency 10, count 200s vs 404s
'

# conditional GET
curl -sI https://boards-api.greenhouse.io/v1/boards/stripe/jobs | grep -i etag
curl -s -o /dev/null -w '%{http_code}\n' -H 'If-None-Match: W/"<etag>"' \
  https://boards-api.greenhouse.io/v1/boards/stripe/jobs        # -> 304

# HEAD liveness contract
curl -sI -o /dev/null -w '%{http_code}\n' https://boards-api.greenhouse.io/v1/boards/stripe/jobs         # 200
curl -sI -o /dev/null -w '%{http_code}\n' https://boards-api.greenhouse.io/v1/boards/notarealxyz/jobs    # 404

# the pay_transparency key diff
curl -s 'https://boards-api.greenhouse.io/v1/boards/stripe/jobs?content=true' | grep -c pay_input_ranges                        # 0
curl -s 'https://boards-api.greenhouse.io/v1/boards/stripe/jobs?content=true&pay_transparency=true' | grep -c pay_input_ranges   # >0

# board URL redirects
curl -s -o /dev/null -w '%{http_code} -> %{redirect_url}\n' https://boards.greenhouse.io/stripe
```

Raw run outputs:

```
run A  {sampled:240, live:122, dead:118, err:0, codes:{200:122,404:118},
        boardsWithJobs:96, jobs:1922, avgJobsPerLiveBoard:15.8,
        payJobs:636, payBoards:18, payShare:0.331}

run B  {jobs:626, remoteInLoc:195, hybridInLoc:3, officeTotal:638, officeWithLoc:245,
        deptNull:4, updatedAt:626, firstPub:625, escaped:626, plainHtml:0}

run C  {boards:96, jobs:1140, mb:13.8, bytesPerJob:12712, empSet:0, mdSet:374,
        payCents:203, payHourly:27, dblEsc:2, ampEsc:1104, titleWs:132}

lever  {sampled:200, live:55, dead:145, err:0, codes:{200:55,404:145},
        boardsWithJobs:47, jobs:4730, avgJobsPerLiveBoard:86,
        salaryJobs:2052, salaryShare:0.434}
```
