/**
 * Lever adapter.
 *
 * `GET api.lever.co/v0/postings/<slug>?mode=json` returns an entire board as a
 * bare JSON array, no auth, no pagination needed. Facts that cost a debugging
 * cycle to learn, kept here next to the code that depends on them.
 *
 * Numbers below are from the full sweep on 2026-08-22 — **71,789 open jobs on
 * 2,025 live boards**, 931 MB — except where they are marked as coming from the
 * 8,697-job / 160-board sample the adapter was designed against. The two differ
 * more than they should: the sample put `employment_type` coverage at 45.9%
 * against a real 72.5%, because one board with 3,462 identically-labelled jobs
 * was 40% of it. Sampling boards evenly does not sample *jobs* evenly.
 *
 *  - **`description` is only the opening paragraphs.** This is the big one. The
 *    requirements, the responsibilities and the benefits live in `lists[]`, and
 *    the closing — relocation, visa, EEO, clearance — lives in `additional`.
 *    Measured by character count the split is 33.9% / 50.3% / 15.8% (sample), so
 *    storing `descriptionPlain` alone throws away two thirds of every posting,
 *    and specifically the two thirds that `d_skills`, `d_degree`, `d_visa` and
 *    `d_clearance` read. The stored text averages 4,054 characters across the
 *    full 71,789 jobs. Running the derivation pass both ways over the sample:
 *
 *                     descriptionPlain    assembled
 *        characters         11,427,868   29,807,727   +161%
 *        degree stated             294        1,708   +481%
 *        visa stated                 9           42   +367%
 *        clearance                  64          221   +245%
 *        any skill               1,095        2,929   +167%
 *
 *    It fails silently, which is the point: the field is populated, the text is
 *    coherent, and four derivations are simply blind to the half of the posting
 *    that answers them. `buildHtml` reassembles all three parts.
 *  - **The markup is real HTML, not escaped** (sample). 8,667 of 8,697
 *    `description` values contain live tags and 0 contain escaped ones — the exact opposite of
 *    Greenhouse. Do **not** run `decodeEntitiesOnce` over it: 9.6% of payloads
 *    carry `&amp;`, correctly escaping a literal `&`, and decoding first would
 *    turn a `&lt;p&gt;` written *in the prose* into a tag for `htmlToText` to
 *    strip. `htmlToText` already decodes entities as its last step, after the
 *    tags are gone, which is the safe order.
 *  - **`lists[].content` is a bare run of `<li>` elements** with no `<ul>`
 *    around it on 14,888 of 20,615 lists (sample), and the heading is a sibling field
 *    rather than markup. Concatenating the raw strings glues a heading onto its
 *    first bullet; `buildHtml` supplies the missing structure.
 *  - **`workplaceType` is a real enum on 98.0% of jobs** — `onsite` 47.9% /
 *    `remote` 30.6% / `hybrid` 19.6%, plus `unspecified` on the other 2.0%,
 *    already in the spelling `deriveWorkplace` wants.
 *    `unspecified` is mapped to NULL on purpose, and that mapping is
 *    load-bearing: passed through, `deriveWorkplace` answers
 *    `ats-enum-unrecognised:unspecified` and stops, which would suppress the
 *    location-text fallback for the one group of jobs that needs it most.
 *  - **Lever is where hybrid comes back.** 14,054 jobs, 19.6% of the board,
 *    against Ashby's 15,932 and a structurally impossible 0 on Greenhouse,
 *    which publishes no enum at all. Lever nearly doubled the number of hybrid
 *    jobs this project can see. See `derive/workplace.mjs`.
 *  - **`categories.commitment` is free text, not an employment type.** 120
 *    distinct values in the sample alone, only 18 used by more than one board. The
 *    single commonest, `"Contract Full time"` (3,462 jobs), comes from one
 *    company and is ambiguous between two of our enum values; the list also
 *    holds `"Hybrid"`, `"Remote"`, `"正社員"`, `"Efetivo"` and `"CDI"`. So
 *    `employmentType` maps only strings that name exactly one type and returns
 *    NULL for everything else. See the note there for why that is not
 *    conservatism for its own sake.
 *  - **There is no `updatedAt`.** `createdAt` is on 100% of jobs and is already
 *    epoch ms; `source_updated_at` stays NULL and change detection falls to the
 *    content hash, exactly as it does for Ashby.
 *  - **There is no company name anywhere in the postings API.** `hostedUrl`
 *    carries the slug and nothing else. `fetchOrganization` below gets one, and
 *    is cheaper than it looks.
 *  - **The ETag is decorative.** Lever sends one on every response and then
 *    ignores `If-None-Match`: replaying a freshly-issued ETag against
 *    `solidcore` returned HTTP 200 and all 2.9 MB, with the same ETag echoed
 *    back. The header is still sent — it costs nothing and the day Lever honours
 *    it a whole sweep becomes free — but a Lever sweep budgets for full
 *    transfer every night, unlike Ashby and Greenhouse. The full sweep moved
 *    **931 MB** and reported 0 unchanged boards, which is the header being
 *    ignored showing up in the totals exactly as predicted.
 *  - **`country` is an ISO alpha-2 code**, which must be expanded before it is
 *    stored. Of the 66,537 jobs carrying one, **10,784 (16.2%) would land in the
 *    wrong country** if the raw code were stored: every Canadian job (4,669)
 *    reads as American, every Indian job (3,055) as Indiana, every German job
 *    (1,517) as Delaware. See `iso-countries.mjs`.
 */

import { getJson, request } from '../http.mjs';
import { blankJob, jobId, normText } from '../schema.mjs';
import { decodeEntitiesOnce, htmlToText } from './html.mjs';
import { countryName } from './iso-countries.mjs';

export const id = 'lever';
export const label = 'Lever';
// 10 swept all 2,025 live boards — 71,789 jobs, 931 MB — in 106 seconds with
// zero 429s and zero errors. 16 held clean over 120 boards in testing and HEAD
// probes held at 24 across 600, so there is headroom; 10 is kept because it is
// the number the full run is actually measured at.
export const concurrency = 10;

const API = 'https://api.lever.co/v0/postings';
const HOSTED = 'https://jobs.lever.co';

/** The human-facing careers page. Also the source `fetchOrganization` reads. */
export function boardUrl(slug) {
  return `${HOSTED}/${encodeURIComponent(slug)}`;
}

/**
 * `mode=json` is the documented spelling and is what the hosted page itself
 * requests. It is also, measurably, a no-op — the endpoint returns identical
 * bytes without it. Kept because relying on an undocumented default is how a
 * sweep breaks on a Tuesday for no visible reason.
 */
export function apiUrl(slug) {
  return `${API}/${encodeURIComponent(slug)}?mode=json`;
}

/**
 * HEAD-equivalent existence check. Correct on both sides: a real board answers
 * 200 and an unknown slug answers 404 `{"ok":false,"error":"Document not
 * found"}`, rather than the empty-array-means-nothing ambiguity some hosts have.
 *
 * A board with no open roles is a *200 with `[]`*, which is a live board that is
 * not hiring — `sweep.mjs` records that as `empty`, not `dead`.
 */
export function probeUrl(slug) {
  return `${API}/${encodeURIComponent(slug)}`;
}

/**
 * @param {string} slug
 * @param {{etag?:string|null}} [opts]  an `etag` is sent as `If-None-Match` for
 *   symmetry with the other adapters, but Lever ignores it. See the header.
 */
export async function fetchBoard(slug, opts = {}) {
  const { etag = null, ...rest } = opts;
  const res = await getJson(apiUrl(slug), {
    timeoutMs: 60_000,
    ...rest,
    headers: { ...(etag ? { 'if-none-match': etag } : {}), ...(rest.headers ?? {}) },
  });

  // Never observed from Lever, but the contract every adapter here answers to.
  if (res.notModified) {
    return { ok: true, notModified: true, status: 304, bytes: 0, etag: res.etag ?? etag, jobs: [] };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, error: res.error, dead: res.status === 404 };
  }

  // The payload is the array itself, not `{ jobs: [...] }` like Ashby and
  // Greenhouse. Anything else is a shape change, not an empty board.
  const rows = Array.isArray(res.data) ? res.data : [];

  return {
    ok: true,
    status: res.status,
    bytes: res.bytes,
    etag: res.etag,
    // No company name in this API at all — `probe-boards.mjs --with-names` fills
    // `companies.name` out of band via `fetchOrganization`.
    name: null,
    url: boardUrl(slug),
    jobs: rows.map((row) => mapJob(row, slug)).filter(Boolean),
  };
}

/**
 * Company display name, scraped from the `<title>` of the hosted board page.
 *
 * Ugly on its face and cheap in practice. The page is ~970 KB of rendered
 * postings, but the `<title>` sits in the first chunk off the socket, so this
 * reads the body until the tag closes and then aborts the request. Measured over
 * 140 boards: **1.5 KB per board** rather than 970 KB, a ~650× saving, at ~17
 * boards/second.
 *
 * It is worth the trouble because the names are ones no slug could produce —
 * `ajccanada` → "Allison Jones Consulting Services", `bofcorp` → "B-O-F
 * Corporation", `bv` → "Banco BV".
 *
 * Two things to know before touching this:
 *
 *  1. **Abort after leaving the loop, never inside it.** Calling `abort()` while
 *     still in the `for await` makes the iterator's cleanup throw an AbortError
 *     that propagates out of the loop — so the `catch` swallows the name that
 *     was just found and this returns null for every board. It fails at 100% and
 *     looks like a parsing bug.
 *  2. **A 404 here is not a dead board.** 5 of 60 boards with live postings in
 *     the API had no hosted page. The API is the authority on existence; this is
 *     only ever a display name.
 */
export const nameConcurrency = 6;

// The head is long past by here. A page that has not produced a <title> within
// a quarter-megabyte is not going to.
const TITLE_SCAN_LIMIT = 262_144;
const TITLE = /<title>([^<]*)<\/title>/i;

export async function fetchOrganization(slug) {
  const controller = new AbortController();
  let res;
  try {
    res = await request(boardUrl(slug), {
      timeoutMs: 30_000,
      // One attempt. A retry re-downloads a page we abandon on purpose, and a
      // display name is not worth a backoff schedule.
      retries: 0,
      headers: { accept: 'text/html' },
      signal: controller.signal,
    });
  } catch {
    return null;
  }

  if (!res.ok || !res.body) {
    controller.abort();
    return null;
  }

  let found = null;
  let read = 0;
  let buffer = '';
  const decoder = new TextDecoder();
  try {
    for await (const chunk of res.body) {
      read += chunk.length;
      buffer += decoder.decode(chunk, { stream: true });
      const match = buffer.match(TITLE);
      if (match) {
        found = match[1];
        break; // break first — see (1) above
      }
      if (read > TITLE_SCAN_LIMIT) break;
    }
  } catch {
    // A stream that dies mid-title is a board without a name, not a failure.
  }
  controller.abort(); // …and abort only once the loop is done with the body

  // The title is markup, so its text is entity-escaped: 34 of 2,313 resolved
  // names contain `&amp;`, every one of them a company with an ampersand in it —
  // "BoxLunch &amp; Hot Topic", "CI&amp;T", "Alice &amp; Bob". Stored raw, that
  // is what shows in the company column and what a company search has to match.
  // Decoded exactly once, for the reason `decodeEntitiesOnce` exists.
  const name = decodeEntitiesOnce(found ?? '').trim();
  return name ? { name } : null;
}

export function mapJob(row, slug) {
  if (!row || typeof row !== 'object') return null;
  const job = blankJob();

  job.ats = 'lever';
  job.company_slug = slug;
  // Nothing in the payload carries it. `upsertBoard` keeps whatever
  // `fetchOrganization` found, and falls back to the slug for display.
  job.company_name = null;

  job.native_id = String(row.id ?? '');
  if (!job.native_id || job.native_id === 'undefined') return null;
  job.id = jobId('lever', slug, job.native_id);

  // `text` is the title. 0 of 8,697 needed trimming, which is worth exactly
  // nothing the day one does.
  job.title = String(row.text ?? '').trim();
  if (!job.title) return null;
  job.title_norm = normText(job.title);

  const categories = row.categories ?? {};
  job.department = trimmed(categories.department);
  job.team = trimmed(categories.team);
  job.employment_type = employmentType(categories.commitment);

  job.location_raw = trimmed(categories.location);
  job.locations_all = collectPlaces(categories);

  // No structured address — `allLocations` is a list of free-text places and
  // nothing splits it into fields. NULL is what tells the derive pass there is
  // nothing pre-parsed to trust.
  job.city = null;
  job.region = null;
  job.postal_code = null;
  // Expanded, never the raw code. See `iso-countries.mjs`.
  job.country = countryName(row.country);

  // Already in the vocabulary `deriveWorkplace` reads; `unspecified` is a
  // stated absence and becomes NULL rather than an unrecognised enum.
  job.raw_workplace = workplace(row.workplaceType);
  // Lever publishes no separate remote boolean. Deriving one from the enum
  // would just be the enum again, and `deriveWorkplace` prefers the enum anyway.
  job.raw_remote = null;

  // Epoch ms already, on 100% of jobs. There is no updated timestamp.
  job.posted_at = Number.isFinite(row.createdAt) ? row.createdAt : null;
  job.source_updated_at = null;

  job.url = row.hostedUrl ?? `${boardUrl(slug)}/${job.native_id}`;
  job.apply_url = row.applyUrl ?? `${job.url}/apply`;

  const pay = pickSalary(row.salaryRange);
  if (pay) {
    job.comp_min = pay.min;
    job.comp_max = pay.max;
    job.comp_currency = pay.currency;
    job.comp_interval = pay.interval;
  }
  // Prose, on 3.2% of jobs, and the only compensation signal on some of them.
  job.comp_text = trimmed(row.salaryDescriptionPlain) ?? trimmed(row.salaryDescription);
  // Lever has no equity field. NULL means "not stated here", which is true.
  job.has_equity = null;

  const html = buildHtml(row);
  job.description_text = htmlToText(html) || null;

  return job;
}

/**
 * Reassemble the whole posting: opening, then each list under its heading, then
 * the closing.
 *
 * Order matters and matches the hosted page, so the plaintext reads the way a
 * candidate reads it. The `<h3>` and `<ul>` are supplied rather than found —
 * `lists[].text` is a plain string with no markup on all 20,615 sampled lists,
 * and `lists[].content` is usually a naked run of `<li>`. Both tags are ones
 * `htmlToText` already treats as block boundaries, so the heading lands on its
 * own line instead of running into the first bullet.
 *
 * `descriptionPlain` / `additionalPlain` are deliberately unused. Lever publishes
 * no plaintext for `lists`, which is half the posting, so it would have to be
 * derived from the markup regardless — and one path through `htmlToText` is one
 * set of rules about what a line break is.
 */
export function buildHtml(row) {
  const parts = [];
  const push = (value) => {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text) parts.push(text);
  };

  push(row.description);

  for (const list of row.lists ?? []) {
    const heading = typeof list?.text === 'string' ? list.text.trim() : '';
    const content = typeof list?.content === 'string' ? list.content.trim() : '';
    if (!heading && !content) continue;
    push(`${heading ? `<h3>${heading}</h3>` : ''}${content ? `<ul>${content}</ul>` : ''}`);
  }

  push(row.additional);

  return parts.join('\n');
}

/**
 * Every place this job is findable.
 *
 * `allLocations` contains `location` on 8,697 of 8,697 jobs, so the primary is
 * added first only to fix the order — the derive pass does not care, but the
 * stored array is read by humans debugging a metro miss.
 *
 * No comma-splitting, same as Greenhouse: "San Francisco, California" is one
 * place, and `parseFragment` already splits on every plausible separator.
 */
function collectPlaces(categories) {
  const places = new Set();
  const add = (value) => {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text) places.add(text);
  };

  add(categories.location);
  for (const location of categories.allLocations ?? []) add(location);
  return [...places];
}

/** `onsite` | `hybrid` | `remote`, or NULL. See the header on `unspecified`. */
function workplace(raw) {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return value === 'onsite' || value === 'hybrid' || value === 'remote' ? value : null;
}

/**
 * The employment-type families, and the spellings that actually occur.
 *
 * `[\s-]*` rather than `[\s-]?` because `"Full- Time"` is a real value on 24
 * jobs and a single optional separator misses it.
 */
const COMMITMENT = [
  [/\b(full[\s-]*time|fulltime)\b/i, 'FullTime'],
  [/\b(part[\s-]*time|parttime)\b/i, 'PartTime'],
  [/\b(contract|contractor|freelance|freelancer)\b/i, 'Contract'],
  [/\b(temporary|temp|seasonal|fixed[\s-]*term)\b/i, 'Temporary'],
  [/\b(intern|internship|trainee|apprentice|co[\s-]*op)\b/i, 'Intern'],
  [/\b(volunteer|voluntary)\b/i, 'Volunteer'],
];

/**
 * `categories.commitment` → one of `EMPLOYMENT_TYPES`, or NULL.
 *
 * A value is only taken when it names **exactly one** family. That is the whole
 * rule, and it is doing more work than it looks like:
 *
 *   "Full-time"                  → FullTime    one family, unambiguous
 *   "Contract Full time"         → NULL        two families; 3,462 jobs, and
 *                                              nobody outside that company knows
 *                                              which one the employer meant
 *   "Full-time or Part-time"     → NULL        the posting is genuinely both
 *   "Permanent" / "CDI" / "正社員" → NULL        a real answer, in a vocabulary
 *                                              this column does not have
 *   "Remote" / "Hybrid"          → NULL        not an employment type at all
 *
 * Measured over the full 71,789-job sweep: 72.5% resolve — FullTime 38,769,
 * PartTime 8,564, Contract 2,981, Temporary 1,253, Intern 478, Volunteer 12 —
 * and 27.5% stay NULL because they name two or more families, name something
 * outside this vocabulary, or publish nothing at all.
 *
 * Guessing at the other half would be worse than useless here, because NULL is
 * not a hole in this schema — `matchEmploymentType` reads it as `unknown` and a
 * filter never rules a job out on it. A wrong `Contract` does rule it out.
 */
export function employmentType(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const hits = COMMITMENT.filter(([pattern]) => pattern.test(raw));
  return hits.length === 1 ? hits[0][1] : null;
}

/**
 * Lever's own interval spellings → `PAY_PERIODS`.
 *
 * `bi-week-salary` and `semi-month-salary` are why `PER_YEAR` in
 * `derive/salary.mjs` gained BIWEEK and SEMI_MONTH. They are rare — 52 and 32
 * jobs of 71,789 — but without a factor a $3,000 fortnightly figure has no
 * reading that lands in the plausible band except MONTH, and the job would be
 * filed at $36k instead of $78k. Being rare is not the same as being safe to
 * get wrong.
 *
 * `one-time` is Lever saying the figure is not on a recurring interval, which is
 * exactly what Ashby's `NONE` means, so it is spelled the same.
 */
const INTERVALS = {
  'per-year-salary': 'YEAR',
  'per-month-salary': 'MONTH',
  'semi-month-salary': 'SEMI_MONTH',
  'bi-week-salary': 'BIWEEK',
  'per-week-salary': 'WEEK',
  'per-day-wage': 'DAY',
  'per-hour-wage': 'HOUR',
  'one-time': 'NONE',
};

/**
 * `salaryRange` → the raw compensation columns.
 *
 * One range per job and it is always base pay — no `pay_input_ranges` array to
 * pick a non-bonus row out of, and no OTE. Present on 31.1% of jobs, which is
 * better than Greenhouse's 20.7% and short of Ashby's 37.2%.
 *
 * The figures are plain units, not cents: `{min: 100000, max: 200000}` is
 * $100k–$200k and `{min: 15, max: 15, interval: 'per-hour-wage'}` is $15/hour.
 * No `/100` here, unlike Greenhouse — applying one would be just as wrong in the
 * other direction.
 *
 * 11 of 1,608 ranges carry no usable number at either end and return NULL, which
 * reads downstream as "published nothing" rather than "published zero".
 */
function pickSalary(range) {
  if (!range || typeof range !== 'object') return null;
  const min = numeric(range.min);
  const max = numeric(range.max);
  if (min == null && max == null) return null;

  const stated = typeof range.interval === 'string' ? range.interval.trim().toLowerCase() : '';
  return {
    min,
    max: max ?? min,
    currency: (range.currency ?? 'USD').toUpperCase(),
    // An interval Lever adds later is unknown rather than wrongly assumed
    // annual; `deriveSalary` reinterprets from the magnitude when it is NULL.
    interval: INTERVALS[stated] ?? null,
  };
}

function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function trimmed(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
}
