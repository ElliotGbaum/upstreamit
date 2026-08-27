/**
 * Workday adapter.
 *
 * The first ATS here that cannot hand over a board in one request. Ashby,
 * Greenhouse and Lever each answer a whole board — descriptions included — from
 * a single URL. Workday answers a *list* twenty rows at a time, with no
 * description in any of them, and keeps the prose behind one more request per
 * job. A 1,242-job board is 63 list requests plus 1,242 detail requests, so the
 * shape of this file is dictated by making that affordable rather than by the
 * API being awkward.
 *
 *   POST <tenant>.<dc>.myworkdayjobs.com/wday/cxs/<tenant>/<site>/jobs
 *        {"appliedFacets":{},"limit":20,"offset":0,"searchText":""}
 *   GET  <tenant>.<dc>.myworkdayjobs.com/wday/cxs/<tenant>/<site><externalPath>
 *
 * Both are unauthenticated. Facts measured 2026-08-26 over the tenant list in
 * `data/slugs/workday.json`, kept here next to the code that depends on them:
 *
 *  - **A slug is three fields, not one.** `tenant|dc|site` — Workday shards
 *    customers across datacenters (`wd1`, `wd3`, `wd5`, `wd103`, `wd503`…) and
 *    the datacenter is part of the hostname, so it cannot be inferred. See
 *    `parseSlug`, which also rejects the malformed half of the collected list.
 *
 *  - **`limit` is hard-capped at 20.** 21 returns HTTP 400, not a clamped page.
 *    There is no page size to tune; the only lever is concurrency.
 *
 *  - **An offset past the end returns a full page, not an empty one.** Asking
 *    for offset `total + 50` answers 200 with 20 postings. A loop that pages
 *    "until the page comes back empty" never terminates. Pagination here is
 *    bounded by `total` and by a hard page ceiling, and duplicate
 *    `externalPath`s are dropped, because that is three independent guards on
 *    the one failure that would hang a sweep of six thousand boards.
 *
 *  - **Only page 0 is on the critical path.** It carries `total`, so every other
 *    offset is known at once and they are fetched together. Paging in sequence
 *    instead — which a first version did — put 20 round trips and ~12 s in front
 *    of the first description on a 400-job board, with the sockets idle
 *    throughout.
 *
 *  - **There are no ETags.** The list response sends none, so unlike Ashby and
 *    Greenhouse there is no conditional GET to be had and every sweep re-reads
 *    every list page. Change detection is `db.hashJob`, and the reason the
 *    descriptions are not also re-read every night is `opts.described` below.
 *
 *  - **422 means the board is gone.** Not 404 — a retired site answers 422 with
 *    an empty `message`, and its human-facing page answers 500. Confirmed on
 *    every 422 sampled. 404 also occurs and means the same thing. Every other
 *    status is the host having an opinion about us, so `probeSlug` reports it
 *    as an error and the slug keeps whatever verdict it already had.
 *
 *  - **`jobPostingId` is the last segment of `externalPath`.** That matters more
 *    than it looks: it is the one stable identifier available from the *list*,
 *    so a job's id can be built without spending a request on its detail. That
 *    is what makes an incremental sweep possible at all. `jobReqId` is not
 *    unique — a posting opened in two locations shares one, and Workday
 *    disambiguates with a `-1` suffix that only `jobPostingId` carries.
 *
 *  - **`remoteType` is a real workplace enum, and it is per-tenant.** Values
 *    observed: "On-Site", "Hybrid", "Remote" — which `deriveWorkplace` already
 *    maps, hyphen included. Populated on 163 of 387 jobs across five boards, but
 *    that average hides the real shape: one board publishes it on 100% of its
 *    jobs, one on 37%, and three on none at all. It is a switch the customer
 *    either configured or did not, so it is worth having and cannot be relied
 *    on. Passed through verbatim into `raw_workplace`; absent stays NULL rather
 *    than being assumed onsite, and the derive pass records whether it used the
 *    enum (`ats-enum`) or guessed. Measured over those same 387 jobs: 88 onsite,
 *    45 hybrid and 30 remote came from the enum rather than from prose.
 *
 *  - **`locationsText` is not always a place.** One board publishes "Noble
 *    Endeavor" (a drilling rig) where a city would go. Location strings are
 *    stored verbatim and the derive pass is left to fail to match them, which is
 *    the correct outcome — an unknown metro, not a wrong one.
 *
 *  - **No structured compensation.** This API exposes no pay range on any job
 *    sampled; where a Workday posting states pay it states it in the
 *    description prose. `comp_*` is left NULL for every row rather than
 *    synthesized, and the salary derivation reads the prose like it does for
 *    any other board that publishes nothing structured.
 *
 *  - **What it does publish, it publishes completely.** Over the same 387 jobs:
 *    `startDate` on 100%, a description on 100%, averaging 5,933 characters
 *    after `htmlToText` — a little longer than Greenhouse's. `timeType` gives a
 *    real employment type, which Greenhouse's API cannot.
 */

import { getJson, pool } from '../http.mjs';
import { blankJob, jobId, normText } from '../schema.mjs';
import { htmlToText } from './html.mjs';

export const id = 'workday';
export const label = 'Workday';

/**
 * Boards in flight. Deliberately lower than the other adapters: each board here
 * is not one request but dozens, and every one of them fans out again by
 * `detailConcurrency`, so the real ceiling is the product of the two.
 */
export const concurrency = 4;

/**
 * Detail requests in flight *within* one board. 4 x 6 = 24 sockets at peak,
 * which is the same order as Greenhouse's flat 8 and spread across many hosts
 * rather than pointed at one — every tenant is its own hostname.
 */
export const detailConcurrency = 6;

/**
 * List pages in flight within one board, after page 0 has reported `total`.
 *
 * Lower than `detailConcurrency` because most boards have only a handful of
 * pages, and the pages are the part that cannot start until the first response
 * lands — spending a lot of sockets on them buys little.
 */
export const listConcurrency = 4;

/** Tells `sweep.mjs` to pass `opts.described`. See `fetchBoard`. */
export const hydrates = true;

/** Workday's own page size. Not configurable — 21 is a 400. */
const PAGE_SIZE = 20;

/**
 * Hard ceiling on list pages per board, independent of `total`.
 *
 * 2,000 postings is far past the largest board observed (1,242) and exists only
 * so that a tenant which reports a nonsense `total`, or paginates in a circle,
 * costs 100 requests instead of an unbounded number.
 */
const MAX_PAGES = 100;

/**
 * A collected slug is `tenant|dc|site`.
 *
 * 6,055 of the 12,884 slugs collected carry a datacenter where the tenant
 * belongs — `wd102|wd1|accenturecareers` — because the upstream publishes them
 * that way, verified against its raw file. The tenant is simply absent.
 *
 * Rejecting them outright looks lossy and is not: **all 6,055 duplicate a
 * well-formed row with the same datacenter and site that is already in the
 * store.** The upstream lists every Workday board twice, once correctly and
 * once with the fields shifted, so there is nothing behind the damaged form.
 * `repair-workday-slugs.mjs` is the pass that established that — it recovered
 * 1,402 tenants and exactly five boards. The real Workday universe is 6,834
 * boards, not 12,884.
 *
 * Returning `null` is what makes those rows *dead* rather than *error*, so they
 * drop out of the live list instead of being retried nightly forever.
 */
export function parseSlug(slug) {
  if (typeof slug !== 'string') return null;
  const parts = slug.split('|').map((part) => part.trim());
  if (parts.length !== 3) return null;
  const [tenant, dc, site] = parts;
  if (!tenant || !dc || !site) return null;
  // A datacenter in the tenant field. The real tenant is not in the string.
  if (/^wd\d+$/i.test(tenant)) return null;
  // Hostname labels and one path segment: anything else is not a board.
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(tenant)) return null;
  if (!/^wd\d+$/i.test(dc)) return null;
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(site)) return null;
  return { tenant, dc, site };
}

const host = ({ tenant, dc }) => `https://${tenant}.${dc}.myworkdayjobs.com`;

/** The CxS API root for one board. Every other URL hangs off this. */
const apiRoot = (board) => `${host(board)}/wday/cxs/${board.tenant}/${board.site}`;

export function boardUrl(slug) {
  const board = parseSlug(slug);
  return board ? `${host(board)}/${board.site}` : null;
}

export function apiUrl(slug) {
  const board = parseSlug(slug);
  return board ? `${apiRoot(board)}/jobs` : null;
}

const listBody = (offset) =>
  JSON.stringify({ appliedFacets: {}, limit: PAGE_SIZE, offset, searchText: '' });

const LIST_HEADERS = { 'content-type': 'application/json', accept: 'application/json' };

/**
 * Existence check.
 *
 * `probe-boards.mjs` HEADs `probeUrl(slug)` for every other ATS, which cannot
 * work here: the list endpoint is a POST and a HEAD against it answers 405. So
 * this adapter exports the whole verdict instead, which `probe-boards.mjs`
 * prefers when an adapter provides it.
 *
 * One page of one job is the cheapest question that distinguishes a real board
 * from a retired one; `total` comes back with it, which is worth having.
 */
export async function probeSlug(slug) {
  const board = parseSlug(slug);
  if (!board) return { status: 'dead', reason: 'malformed slug' };

  const res = await getJson(`${apiRoot(board)}/jobs`, {
    method: 'POST',
    headers: LIST_HEADERS,
    body: listBody(0),
    timeoutMs: 30_000,
  });

  if (res.ok) return { status: 'exists', total: res.data?.total ?? null };
  // 422: retired site. 404: never existed, or the path is wrong. Same verdict.
  if (res.status === 422 || res.status === 404) return { status: 'dead' };
  return { status: 'error', error: res.error ?? `HTTP ${res.status}` };
}

/**
 * Every posting on a board, with descriptions.
 *
 * @param {string} slug  `tenant|dc|site`
 * @param {{described?:Set<string>, detailConcurrency?:number, signal?:AbortSignal}} [opts]
 *   `described` is the set of job ids this database already holds a description
 *   for, supplied by `sweep.mjs`. A job in that set is returned from the list
 *   row alone and its `description_text` is left `undefined`, which
 *   `upsertBoard` coalesces onto the stored text rather than over it.
 *
 *   This is the whole economics of sweeping Workday. A first backfill of ~6,500
 *   boards costs one request per job — roughly 700,000 of them. Every sweep
 *   after it costs one request per *new* job plus the list pages, because a
 *   description that has not been re-read cannot have changed under us in a way
 *   the list would not already show. The trade that buys: a posting whose prose
 *   is edited without its title, location, type or req id changing is not
 *   noticed until it closes and reappears. `--no-conditional` on the sweep
 *   forces a full re-read for the weekly check that this has not drifted.
 */
export async function fetchBoard(slug, opts = {}) {
  const board = parseSlug(slug);
  if (!board) {
    return { ok: false, status: 0, error: `malformed workday slug "${slug}"`, dead: true };
  }

  const root = apiRoot(board);
  const described = opts.described ?? null;
  const detailLimit = opts.detailConcurrency ?? detailConcurrency;
  const listLimit = opts.listConcurrency ?? listConcurrency;

  // ------------------------------------------------------------- the list --
  //
  // Page 0 first, alone, because it is the only request whose answer is needed
  // before the others can be made: it carries `total`, which says how many
  // pages exist. Paging strictly in sequence after that is what a first
  // implementation did and it is dominated by latency — a 400-job board is 20
  // round trips, ~12 s, before a single description can start downloading, and
  // that is 20 idle sockets on a run of 5,747 boards. Once `total` is known
  // every remaining offset is independent, so they go out together.
  const postings = [];
  const seenPaths = new Set();
  let bytes = 0;

  const first = await getJson(`${root}/jobs`, {
    method: 'POST',
    headers: LIST_HEADERS,
    body: listBody(0),
    timeoutMs: 45_000,
  });

  if (!first.ok) {
    return {
      ok: false,
      status: first.status,
      error: first.error ?? `HTTP ${first.status}`,
      dead: first.status === 422 || first.status === 404,
    };
  }
  bytes += first.bytes ?? 0;
  const total = Number(first.data?.total) || 0;

  const take = (res) => {
    const rows = Array.isArray(res?.data?.jobPostings) ? res.data.jobPostings : [];
    for (const row of rows) {
      const path = typeof row?.externalPath === 'string' ? row.externalPath : null;
      // Dedup by path: an offset past the end answers 200 with a *full page*
      // rather than an empty one, so a board whose `total` overstates itself
      // would otherwise return the same postings several times over.
      if (!path || seenPaths.has(path)) continue;
      seenPaths.add(path);
      postings.push(row);
    }
  };
  take(first);

  // Bounded by `total` and by a hard ceiling, never by "page until it comes
  // back empty" — which, given the behaviour above, never happens.
  const pages = Math.min(Math.ceil(total / PAGE_SIZE), MAX_PAGES);
  const offsets = Array.from({ length: Math.max(0, pages - 1) }, (_, i) => (i + 1) * PAGE_SIZE);

  if (offsets.length) {
    const rest = await pool(offsets, Math.min(listLimit, offsets.length), (offset) =>
      getJson(`${root}/jobs`, {
        method: 'POST',
        headers: LIST_HEADERS,
        body: listBody(offset),
        timeoutMs: 45_000,
      }),
    );

    // A hole in the middle of the listing is not a smaller board — it is an
    // unknown one. Returning the pages that did arrive would close every job
    // behind the missing offset, which reads exactly like a company that
    // withdrew them. The whole board is reported as an error instead and left
    // untouched until the next sweep.
    const failed = rest.find((res) => !res || res.error || !res.ok);
    if (failed) {
      return {
        ok: false,
        status: failed.status ?? 0,
        error: `partial list: ${failed.error ?? `HTTP ${failed.status}`}`,
        dead: false,
      };
    }
    for (const res of rest) {
      bytes += res.bytes ?? 0;
      take(res);
    }
  }

  if (!postings.length) {
    return { ok: true, status: 200, bytes, etag: null, name: null, url: boardUrl(slug), jobs: [] };
  }

  // ---------------------------------------------------------- the details --
  // One request per posting we do not already hold prose for.
  const needed = postings.filter((row) => {
    if (!described) return true;
    const nativeId = nativeIdFromPath(row.externalPath);
    return !nativeId || !described.has(jobId('workday', slug, nativeId));
  });

  const details = new Map();
  await pool(needed, detailLimit, async (row) => {
    const res = await getJson(`${root}${row.externalPath}`, { timeoutMs: 45_000 });
    if (!res.ok) return;
    bytes += res.bytes ?? 0;
    const info = res.data?.jobPostingInfo;
    if (info) details.set(row.externalPath, info);
  });

  const jobs = postings
    .map((row) => mapJob(row, details.get(row.externalPath) ?? null, slug, board))
    .filter(Boolean);

  // Taken from the first detail that came back, since every job on a board
  // shares one site segment. An incremental sweep that hydrated nothing finds
  // no name and returns null, which `upsertBoard` coalesces onto the stored one
  // rather than over it.
  let name = null;
  for (const detail of details.values()) {
    name = companyNameFromUrl(detail.externalUrl);
    if (name) break;
  }

  return {
    ok: true,
    status: 200,
    bytes,
    etag: null,
    name,
    // Never 'api': this came out of a URL, not out of a field. See
    // `companyNameFromUrl`.
    nameSource: name ? 'derived' : null,
    url: boardUrl(slug),
    jobs,
  };
}

/**
 * The stable per-posting id, straight off the list row.
 *
 * `/job/Jeffersonville-IN/IT-Engineer_10001263-1` → `IT-Engineer_10001263-1`,
 * which is exactly the `jobPostingId` the detail response reports. Read from
 * the path rather than the detail so that a job already in the database can be
 * recognised without paying for its detail request.
 */
export function nativeIdFromPath(externalPath) {
  if (typeof externalPath !== 'string' || !externalPath) return null;
  const tail = externalPath.split('/').filter(Boolean).pop();
  return tail ? decodeURIComponent(tail) : null;
}

/**
 * One list row plus its (optional) detail → the common schema.
 *
 * `detail` is null in two cases that mean different things and are handled the
 * same way: the job was skipped because its description is already stored, or
 * its detail request failed. Both leave `description_text` `undefined` rather
 * than null so that `upsertBoard` coalesces — a failed fetch must not blank a
 * description that is already good.
 */
export function mapJob(row, detail, slug, board = parseSlug(slug)) {
  if (!row || typeof row !== 'object') return null;
  const nativeId = nativeIdFromPath(row.externalPath);
  if (!nativeId) return null;

  const job = blankJob();
  job.ats = 'workday';
  job.company_slug = slug;
  job.native_id = nativeId;
  job.id = jobId('workday', slug, nativeId);

  job.title = String(detail?.title ?? row.title ?? '').trim();
  if (!job.title) return null;
  job.title_norm = normText(job.title);

  // The list's `locationsText` is the display string and collapses a
  // multi-location posting to "3 Locations", which names no place at all. The
  // detail's `location` is the primary one; `additionalLocations` carries the
  // rest. Prefer the detail, fall back to the list.
  const primary = detail?.location ?? row.locationsText ?? null;
  job.location_raw = primary;

  const places = new Set();
  if (primary) places.add(String(primary));
  // Only when it is a real place — "3 Locations" is a count, not a location.
  if (row.locationsText && !/^\d+\s+locations?$/i.test(row.locationsText)) {
    places.add(String(row.locationsText));
  }
  for (const extra of detail?.additionalLocations ?? []) {
    if (typeof extra === 'string') places.add(extra);
    else if (extra?.descriptor) places.add(String(extra.descriptor));
  }
  job.locations_all = [...places].filter(Boolean);

  const country = detail?.country?.descriptor ?? detail?.jobRequisitionLocation?.country?.descriptor;
  job.country = country ? String(country).trim() : null;

  job.employment_type = employmentType(detail?.timeType);
  // Verbatim, sparse, and never inferred from the location string. See header.
  job.raw_workplace = detail?.remoteType ?? null;
  job.raw_remote = null;

  // `startDate` is the day the req was posted (`2026-08-26`). The list has only
  // "Posted 2 Days Ago", which is relative to the read and useless to store, so
  // an unhydrated job leaves this null and `upsertBoard` keeps the stored value.
  job.posted_at = toEpoch(detail?.startDate);

  job.url = detail?.externalUrl ?? `${host(board)}/${board.site}${row.externalPath}`;
  job.apply_url = job.url;

  // No structured pay anywhere in this API. See the header.
  if (detail) {
    const text = htmlToText(detail.jobDescription ?? '');
    job.description_text = text || null;
  } else {
    // Not null: `undefined` is what upsertBoard coalesces onto stored text.
    delete job.description_text;
  }

  return job;
}

/**
 * A display name, from the one place Workday puts the customer's own casing.
 *
 * Nothing in this API states a company name — not the listing, not the detail,
 * and the board's own page is a single-page app whose `<title>` is empty. What
 * *is* there is the site segment of `externalUrl`, which Workday renders in the
 * casing the customer configured:
 *
 *     …myworkdayjobs.com/CanadianSolar/job/…   ->  "Canadian Solar"
 *     …myworkdayjobs.com/RiminiStreet/job/…    ->  "Rimini Street"
 *
 * That casing is the whole value here: the slug is `canadiansolar` either way,
 * and without word boundaries there is nothing to titleize. So a segment that
 * arrives all-lowercase returns **null** rather than a mangled guess —
 * "Catalyte" is a coin flip and "Adventisthealthcare" is simply wrong. Five of
 * six live boards sampled carried usable casing; the sixth gets NULL and the UI
 * falls back to the slug, which is honest.
 *
 * Recorded as `name_source: 'derived'`, never `'api'`, because the API did not
 * say this — a URL did.
 */
export function companyNameFromUrl(externalUrl) {
  if (typeof externalUrl !== 'string') return null;
  const segment = externalUrl.split('myworkdayjobs.com/')[1]?.split('/')[0];
  if (!segment || !/[A-Z]/.test(segment)) return null;

  const spaced = segment
    // "CanadianSolar" -> "Canadian Solar"
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    // "BOFCorp" -> "BOF Corp", without splitting "BOF" itself
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // The site is a careers site; that word names the site, not the company.
  const name = spaced.replace(/\s+(external\s+)?careers?$/i, '').replace(/\s+jobs$/i, '').trim();
  return name.length > 1 ? name : null;
}

/** Workday publishes "Full time" / "Part time" and nothing else observed. */
export function employmentType(timeType) {
  if (!timeType) return null;
  const text = String(timeType).toLowerCase().replace(/[\s_-]+/g, '');
  if (text === 'fulltime') return 'FullTime';
  if (text === 'parttime') return 'PartTime';
  return null;
}

function toEpoch(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
