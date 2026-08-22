/**
 * Ashby adapter.
 *
 * `GET api.ashbyhq.com/posting-api/job-board/<slug>?includeCompensation=true`
 * returns an entire board in one response, full descriptions included, no
 * pagination. Facts that cost a debugging cycle to learn, kept here next to the
 * code that depends on them:
 *
 *  - `includeCompensation` must be exactly lowercase `true`. `True` and `1`
 *    return HTTP 200 and silently omit every salary.
 *  - There is no `updatedAt`, only `publishedAt`, so change detection is a
 *    content hash (see `db.hashJob`).
 *  - `isRemote` is `true` for every Hybrid job. It means "not fully onsite".
 *    `workplaceType` is the only trustworthy signal and this adapter passes the
 *    enum through untouched rather than collapsing it.
 *  - Board tokens can contain spaces (`flock safety`), so the slug is
 *    percent-encoded on the way into the URL.
 */

import { getJson } from '../http.mjs';
import { blankJob, jobId, normText } from '../schema.mjs';

export const id = 'ashby';
export const label = 'Ashby';
export const concurrency = 12;

export function boardUrl(slug) {
  return `https://jobs.ashbyhq.com/${encodeURIComponent(slug)}`;
}

export function apiUrl(slug) {
  return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`;
}

/** HEAD-equivalent existence check. 404 is the only "does not exist". */
export function probeUrl(slug) {
  return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`;
}

/**
 * @param {string} slug
 * @param {{etag?:string|null}} [opts]  an `etag` makes this a conditional GET.
 *   Ashby honours `If-None-Match` (verified against `ramp`:
 *   `W/"job-board:e150b520…"` → 304), so an unchanged board costs zero bytes.
 */
export async function fetchBoard(slug, opts = {}) {
  const { etag = null, ...rest } = opts;
  const res = await getJson(apiUrl(slug), {
    timeoutMs: 45_000,
    ...rest,
    headers: { ...(etag ? { 'if-none-match': etag } : {}), ...(rest.headers ?? {}) },
  });
  if (res.notModified) {
    return { ok: true, notModified: true, status: 304, bytes: 0, etag: res.etag ?? etag, jobs: [] };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, error: res.error, dead: res.status === 404 };
  }
  const payload = res.data ?? {};
  const rows = Array.isArray(payload.jobs) ? payload.jobs : [];
  return {
    ok: true,
    status: res.status,
    bytes: res.bytes,
    etag: res.etag,
    name: payload.name ?? null,
    url: boardUrl(slug),
    jobs: rows.map((row) => mapJob(row, slug, payload.name ?? null)).filter(Boolean),
  };
}

/**
 * Company display name, which the posting API does not carry.
 *
 * This is a capability the generic probe checks for rather than assumes: Ashby
 * is the only ATS here that needs it (Greenhouse puts `company_name` on every
 * job), so `probe-boards.mjs` runs this pass only for adapters that export it.
 *
 * `jobs.ashbyhq.com` rate-limits hard — HTTP 429 within a few dozen requests,
 * against zero 429s in 7,951 requests to `api.ashbyhq.com`. Hence
 * `nameConcurrency: 2` and the opt-in flag, and why this is not folded into
 * `fetchBoard`.
 */
export const nameConcurrency = 2;

const GRAPHQL_URL =
  'https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiOrganizationFromHostedJobsPageName';

const ORG_QUERY = `query ApiOrganizationFromHostedJobsPageName($organizationHostedJobsPageName: String!) {
  organization: organizationFromHostedJobsPageName(organizationHostedJobsPageName: $organizationHostedJobsPageName) {
    name
    publicWebsite
    customJobsPageUrl
    allowJobPostIndexing
    __typename
  }
}`;

export async function fetchOrganization(slug) {
  const res = await getJson(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      operationName: 'ApiOrganizationFromHostedJobsPageName',
      variables: { organizationHostedJobsPageName: slug },
      query: ORG_QUERY,
    }),
    timeoutMs: 30_000,
  });
  if (!res.ok) return null;
  const org = res.data?.data?.organization;
  if (!org) return null;
  return {
    name: org.name ?? null,
    website: org.publicWebsite ?? null,
    careers_url: org.customJobsPageUrl ?? null,
    allow_indexing: org.allowJobPostIndexing ?? null,
  };
}

function mapJob(row, slug, boardName) {
  if (!row || typeof row !== 'object') return null;
  const job = blankJob();

  job.ats = 'ashby';
  job.company_slug = slug;
  job.company_name = boardName;
  job.native_id = String(row.id ?? row.jobId ?? '');
  if (!job.native_id) return null;
  job.id = jobId('ashby', slug, job.native_id);

  // 405 of 4,760 sampled titles carried stray whitespace.
  job.title = String(row.title ?? '').trim();
  job.title_norm = normText(job.title);
  job.department = row.department ?? null;
  job.team = row.team ?? null;
  job.employment_type = row.employmentType ?? null;

  job.location_raw = row.location ?? null;

  // Union of every place this job is findable. One signal finds only 64% of a
  // metro: 5.4% of NYC jobs appear only in secondaryLocations and 0.5% only in
  // the structured address.
  const places = new Set();
  if (row.location) places.add(String(row.location));
  for (const secondary of row.secondaryLocations ?? []) {
    if (typeof secondary === 'string') places.add(secondary);
    else if (secondary?.location) places.add(String(secondary.location));
    else if (secondary?.address?.postalAddress) {
      places.add(formatPostal(secondary.address.postalAddress));
    }
  }
  const postal = row.address?.postalAddress;
  if (postal) {
    places.add(formatPostal(postal));
    job.city = postal.addressLocality?.trim() || null;
    job.region = postal.addressRegion?.trim() || null;
    job.country = postal.addressCountry?.trim() || null;
    job.postal_code = postal.postalCode?.trim() || null;
  }
  job.locations_all = [...places].filter(Boolean);

  job.posted_at = toEpoch(row.publishedAt);
  job.url = row.jobUrl ?? boardUrl(slug);
  job.apply_url = row.applyUrl ?? row.jobUrl ?? null;

  // `workplaceType` verbatim; the derivation pass decides what it means.
  job.raw_workplace = row.workplaceType ?? null;
  job.raw_remote = row.isRemote ?? null;

  const comp = pickSalary(row.compensation);
  if (comp) {
    job.comp_min = comp.min;
    job.comp_max = comp.max;
    job.comp_currency = comp.currency;
    job.comp_interval = comp.interval;
  }
  job.comp_text = row.compensationTierSummary ?? row.compensation?.compensationTierSummary ?? null;
  job.has_equity = hasEquity(row.compensation);

  job.description_text = row.descriptionPlain ?? null;
  job.description_html = row.descriptionHtml ?? null;

  return job;
}

function formatPostal(p) {
  return [p.addressLocality, p.addressRegion, p.addressCountry].filter(Boolean).join(', ');
}

/**
 * `summaryComponents` is the pre-flattened min/max; the prose
 * `compensationTierSummary` is unparseable and only kept as a fallback string.
 * Several components can appear (salary, equity, bonus) — only Salary is money.
 */
function pickSalary(compensation) {
  const parts = compensation?.summaryComponents;
  if (!Array.isArray(parts)) return null;
  for (const part of parts) {
    if (part?.compensationType !== 'Salary') continue;
    const min = numeric(part.minValue);
    const max = numeric(part.maxValue);
    if (min == null && max == null) continue;
    return {
      min,
      max: max ?? min,
      currency: part.currencyCode ?? null,
      interval: normalizeInterval(part.interval),
    };
  }
  return null;
}

function hasEquity(compensation) {
  const parts = compensation?.summaryComponents;
  if (!Array.isArray(parts)) return null;
  return parts.some((p) => p?.compensationType === 'EquityPercentage' || p?.compensationType === 'Equity')
    ? 1
    : null;
}

// Ashby publishes "1 YEAR" / "1 HOUR" / "6 MONTH" / "NONE".
function normalizeInterval(raw) {
  if (!raw || raw === 'NONE') return 'NONE';
  const text = String(raw).toUpperCase();
  if (text.includes('YEAR')) return 'YEAR';
  if (text.includes('6 MONTH')) return 'HALF_YEAR';
  if (text.includes('MONTH')) return 'MONTH';
  if (text.includes('WEEK')) return 'WEEK';
  if (text.includes('DAY')) return 'DAY';
  if (text.includes('HOUR')) return 'HOUR';
  return 'NONE';
}

function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toEpoch(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
