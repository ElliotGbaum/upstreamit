/**
 * Greenhouse adapter.
 *
 * `GET boards-api.greenhouse.io/v1/boards/<slug>/jobs?content=true&pay_transparency=true`
 * returns an entire board in one response, full descriptions included, no auth
 * and no pagination — the same shape the Ashby adapter already proves out.
 * Facts that cost a debugging cycle to learn, kept here next to the code that
 * depends on them. Every number was measured over 1,140 jobs on 96 live boards.
 *
 *  - **Both query params are load-bearing.** Without `content=true` there are no
 *    descriptions; without `pay_transparency=true` the `pay_input_ranges` key is
 *    absent from the response entirely. Same class of bug as Ashby's
 *    lowercase-only `includeCompensation=true`: HTTP 200, silently no salaries.
 *  - **`content` is entity-escaped markup**, on 626 of 626 sampled jobs, and
 *    there is no `descriptionPlain`. See `html.mjs` for why it is decoded
 *    exactly once.
 *  - **The money is in cents.** `8500000` is $85,000, not $8.5M. A missing
 *    `/100` puts every Greenhouse job in the `$200k+` band.
 *  - **There is no employment type.** An `employment` key appears in the key
 *    union and is populated on 0 of 1,140 jobs. `employment_type` is NULL for
 *    every row here, deliberately — `metadata` sometimes carries a per-board
 *    custom field for it, with no shared vocabulary, and guessing an enum from
 *    free text is the silent wrong answer this project exists to avoid.
 *  - **There is no workplace enum.** 31.2% of location strings match /remote/i
 *    but only 0.5% match /hybrid/i, against 26% of the Ashby corpus being
 *    explicitly Hybrid. `raw_workplace` stays NULL rather than being synthesized
 *    from the location string; `deriveWorkplace` already handles a missing enum
 *    and records `d_workplace_src` so a guess is distinguishable from a statement.
 *  - **`updated_at` is on 100% of jobs**, which no other adapter here can say.
 *  - **`company_name` is on every job.** Ashby needs a rate-limited GraphQL call
 *    for the same thing.
 *  - **There is no EU API mirror.** `boards-api.eu.greenhouse.io` does not
 *    resolve and `api.eu.greenhouse.io` serves the Greenhouse web app with a
 *    200 — a trap for anything that reads the status code alone. EU boards come
 *    from this same host.
 */

import { getJson } from '../http.mjs';
import { blankJob, jobId, normText } from '../schema.mjs';
import { decodeEntitiesOnce, htmlToText } from './html.mjs';

export const id = 'greenhouse';
export const label = 'Greenhouse';
// 10 held with zero 429s across ~500 board fetches, but that was minutes and a
// full sweep is ~7,700 boards. 8 is the conservative starting point.
export const concurrency = 8;

const API = 'https://boards-api.greenhouse.io/v1/boards';

/**
 * `boards.greenhouse.io/<slug>` 301s here, so this is the canonical
 * human-facing page. A board with its own careers site then 302s onward to the
 * company, which is expected and not an error.
 */
export function boardUrl(slug) {
  return `https://job-boards.greenhouse.io/${encodeURIComponent(slug)}`;
}

export function apiUrl(slug) {
  return `${API}/${encodeURIComponent(slug)}/jobs?content=true&pay_transparency=true`;
}

/** HEAD-equivalent existence check. 200 or 404, correct on both. */
export function probeUrl(slug) {
  return `${API}/${encodeURIComponent(slug)}/jobs`;
}

/**
 * @param {string} slug
 * @param {{etag?:string|null}} [opts]  an `etag` turns this into a conditional
 *   GET; a matching board answers 304 with a zero-byte body instead of the
 *   ~144 KB it would otherwise send. Verified against `stripe`.
 */
export async function fetchBoard(slug, opts = {}) {
  const { etag = null, ...rest } = opts;
  const res = await getJson(apiUrl(slug), {
    timeoutMs: 60_000,
    ...rest,
    headers: { ...(etag ? { 'if-none-match': etag } : {}), ...(rest.headers ?? {}) },
  });

  // 304 is an answer — "nothing changed since that ETag" — not a failure. The
  // ETag is echoed back so the caller can keep storing the one still in force.
  if (res.notModified) {
    return { ok: true, notModified: true, status: 304, bytes: 0, etag: res.etag ?? etag, jobs: [] };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, error: res.error, dead: res.status === 404 };
  }

  const payload = res.data ?? {};
  const rows = Array.isArray(payload.jobs) ? payload.jobs : [];
  // Board-level display name, off whichever job carries one. `/v1/boards/<slug>`
  // returns it authoritatively, but that is a second request per board and the
  // per-job field is filled on 100% of rows.
  const boardName = rows.find((r) => r?.company_name)?.company_name ?? null;

  return {
    ok: true,
    status: res.status,
    bytes: res.bytes,
    etag: res.etag,
    name: boardName,
    url: boardUrl(slug),
    jobs: rows.map((row) => mapJob(row, slug, boardName)).filter(Boolean),
  };
}

export function mapJob(row, slug, boardName = null) {
  if (!row || typeof row !== 'object') return null;
  const job = blankJob();

  job.ats = 'greenhouse';
  job.company_slug = slug;
  job.company_name = row.company_name ?? boardName ?? null;

  // `internal_job_id` is a different number on the same job. Using it would
  // make every id unstable against the URLs and against a re-sweep.
  job.native_id = String(row.id ?? '');
  if (!job.native_id || job.native_id === 'undefined') return null;
  job.id = jobId('greenhouse', slug, job.native_id);

  // 132 of 1,140 sampled titles carried stray whitespace.
  job.title = String(row.title ?? '').trim();
  if (!job.title) return null;
  job.title_norm = normText(job.title);

  // Free text, and often an internal org name with a requisition number in it
  // ("1653 Startups - Account Executives (NA)"). Stored, never surfaced as a
  // filter — `d_job_function` reads the title first and this second.
  job.department = firstName(row.departments);
  job.team = null;

  // No employment type in this API at all. See the header.
  job.employment_type = null;

  job.location_raw = row.location?.name?.trim() || null;
  job.locations_all = collectPlaces(row);

  // No structured address. The derive pass parses the strings above; leaving
  // these NULL is what tells it there is nothing pre-parsed to trust.
  job.city = null;
  job.region = null;
  job.country = null;
  job.postal_code = null;

  // No enum, and the location string is not a substitute for one. See the header.
  job.raw_workplace = null;
  job.raw_remote = null;

  job.posted_at = toEpoch(row.first_published) ?? toEpoch(row.updated_at);
  job.source_updated_at = toEpoch(row.updated_at);

  // `absolute_url` is what the employer wants clicked and often lands on their
  // own careers site; the hosted board page is the uniform fallback.
  job.url = row.absolute_url ?? boardUrl(slug);
  job.apply_url = row.absolute_url ?? `${boardUrl(slug)}/jobs/${job.native_id}`;

  const pay = pickSalary(row.pay_input_ranges);
  if (pay) {
    job.comp_min = pay.min;
    job.comp_max = pay.max;
    job.comp_currency = pay.currency;
    job.comp_interval = pay.interval;
    job.comp_text = pay.text;
  }
  // `has_equity` is sometimes buried in a board's custom `metadata` fields with
  // no shared name for it. NULL means "not stated here", which is true.
  job.has_equity = null;

  const html = decodeEntitiesOnce(row.content ?? '');
  job.description_text = htmlToText(html) || null;

  return job;
}

/**
 * Every place this job is findable: the location string plus each office's name
 * and its own location string.
 *
 * The union rule comes from Ashby, where one signal finds only 64% of a metro's
 * jobs, and it earns its keep here for a different reason — `offices[].location`
 * is filled on only 38.4% of entries (245/638) and `offices[].name` is often
 * just `"US"`, so neither alone is enough.
 *
 * No comma-splitting. `location.name` is free text where the comma is usually
 * structure, not a list: "Austin, Texas, United States" is one place and "New
 * York or Boston" is two. `parseFragment` in the derive pass already splits on
 * every plausible separator and discards tokens it cannot place, which handles
 * both without being told which case it is in.
 */
function collectPlaces(row) {
  const places = new Set();
  const add = (value) => {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text) places.add(text);
  };

  add(row.location?.name);
  for (const office of row.offices ?? []) {
    add(office?.name);
    add(office?.location);
  }
  return [...places];
}

// Ranges that are definitely not a base salary. A bonus range read as pay puts
// a $10k figure where a $150k one belongs.
const NOT_SALARY = /\b(bonus|equity|commission|sign[-\s]?on|signing|relocation|stipend|rsu|stock)\b/i;
// On-target earnings fold commission into the number. Usable, but never in
// preference to a plain base range on the same job.
const ON_TARGET = /\b(ote|on[-\s]?target)\b/i;
const HOURLY = /\b(hour|hourly|per\s?hr|\/hr)\b/i;

/**
 * Pick one range out of `pay_input_ranges`.
 *
 * The array holds several per job and they are not all base salary. Observed
 * titles across 203 ranges include `Zone 1 Pay Range`, `Remote Pay Range`,
 * `Hourly Pay Range`, `OTE Range`, `Bonus Range`, bare state lists
 * (`CA, NY, CT, NJ`) and job-title-shaped ones. There is no type field the way
 * Ashby has `compensationType`, so the title is the only signal.
 *
 * Interval lives only in that prose title, and the title frequently does not
 * say. Robinhood publishes `min_cents: 2040` — $20.40, plainly hourly — under
 * the title `Zone 1 (Menlo Park, CA; New York, NY; …)`. That is fine and is
 * handled downstream on purpose: `deriveSalary` checks every figure for
 * plausibility and reinterprets the interval when the stated one produces a
 * nonsense annual, exactly as it already does for Ashby's mislabelled rows. So
 * this returns the honest reading of the title and lets the derive pass be the
 * one place that arbitrates magnitude.
 */
function pickSalary(ranges) {
  if (!Array.isArray(ranges) || !ranges.length) return null;

  const usable = [];
  for (const range of ranges) {
    const title = typeof range?.title === 'string' ? range.title : '';
    if (NOT_SALARY.test(title)) continue;
    const min = cents(range?.min_cents);
    const max = cents(range?.max_cents);
    if (min == null && max == null) continue;
    usable.push({
      min,
      max: max ?? min,
      currency: (range?.currency_type ?? 'USD').toUpperCase(),
      interval: HOURLY.test(title) ? 'HOUR' : 'YEAR',
      text: title.trim() || null,
      ote: ON_TARGET.test(title),
    });
  }
  if (!usable.length) return null;

  // Order is otherwise the board's own, which puts the primary range first.
  return usable.find((r) => !r.ote) ?? usable[0];
}

/** Cents → dollars. The single `/100` the whole salary facet depends on. */
function cents(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n / 100;
}

function firstName(list) {
  if (!Array.isArray(list)) return null;
  for (const entry of list) {
    const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
    if (name) return name;
  }
  return null;
}

function toEpoch(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
