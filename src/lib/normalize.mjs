/**
 * Slug normalization.
 *
 * Upstream sources are inconsistent: some publish bare slugs, some publish full
 * board URLs, some publish display names alongside. Everything funnels through
 * `normalizeSlug` so the merged store holds exactly one canonical form per company
 * per ATS — that canonical form is what dedup keys on.
 */

// Patterns that pull the slug out of a full board URL, per ATS.
const URL_PATTERNS = {
  ashby: [
    /^https?:\/\/(?:www\.)?jobs\.ashbyhq\.com\/([^/?#]+)/i,
    /^https?:\/\/api\.ashbyhq\.com\/posting-api\/job-board\/([^/?#]+)/i,
  ],
  greenhouse: [
    /^https?:\/\/boards-api\.greenhouse\.io\/v1\/boards\/([^/?#]+)/i,
    /^https?:\/\/(?:job-)?boards(?:\.eu)?\.greenhouse\.io\/embed\/job_board\?for=([^/?#&]+)/i,
    /^https?:\/\/(?:job-)?boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/i,
  ],
  lever: [
    /^https?:\/\/api\.lever\.co\/v0\/postings\/([^/?#]+)/i,
    /^https?:\/\/jobs\.(?:eu\.)?lever\.co\/([^/?#]+)/i,
  ],
  workday: [/^https?:\/\/([^./]+)\.(?:wd\d+\.)?myworkdayjobs\.com/i],
  bamboohr: [/^https?:\/\/([^./]+)\.bamboohr\.com/i],
  smartrecruiters: [/^https?:\/\/(?:api|careers|jobs)\.smartrecruiters\.com\/([^/?#]+)/i],
  workable: [/^https?:\/\/(?:apply|jobs|www)\.workable\.com\/(?:api\/v1\/accounts\/)?([^/?#]+)/i],
  recruitee: [/^https?:\/\/([^./]+)\.recruitee\.com/i],
  teamtailor: [/^https?:\/\/([^./]+)\.teamtailor\.com/i],
};

// Deliberately permissive — real slugs include digits-first ("0x", "11x"), dots,
// and underscores. We only reject things that clearly aren't slugs.
const DEFAULT_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

// Per-ATS character sets, widened only where real upstream data requires it:
//  - ashby board tokens can contain spaces ("flock safety", "tools for humanity").
//    They arrive percent-encoded inside URLs and must be re-encoded when we call
//    the API. Verified: the Ashby posting API is case-insensitive, so lowercasing
//    is safe, but dropping the space would lose the board entirely.
//  - workday isn't addressed by a single slug: it needs a triple
//    (tenant, datacenter, site), which upstream publishes pipe-joined — so the
//    pipe is part of the identifier, not a separator.
const SLUG_PATTERNS = {
  ashby: /^[a-z0-9][a-z0-9._ -]*$/,
  workday: /^[a-z0-9][a-z0-9._|-]*$/,
};

const MAX_SLUG_LENGTH = 120;

// Values that show up in scraped datasets as noise rather than companies.
//
// The well-known filenames matter to the archive sources specifically: those
// read raw crawl URLs, and a crawler fetches /robots.txt on a host far more
// often than it reaches any one board. In CC-MAIN-2026-34 every single capture
// under jobs.lever.co was robots.txt, which is slug-shaped enough to pass the
// pattern below and would otherwise enter the store as a company.
const BLOCKLIST = new Set([
  'null',
  'undefined',
  'none',
  'test',
  'example',
  'demo',
  'localhost',
  'www',
  'api',
  'jobs',
  'careers',
  'search',
  'index',
  'robots.txt',
  'sitemap.xml',
  'favicon.ico',
]);

/**
 * @param {unknown} raw   A slug, a board URL, or junk.
 * @param {string} ats    ATS key, used to pick URL patterns.
 * @returns {string|null} Canonical slug, or null if unusable.
 */
export function normalizeSlug(raw, ats) {
  if (typeof raw !== 'string') return null;

  let value = raw.trim();
  if (!value) return null;

  // Unwrap a full URL into just its slug segment.
  if (/^https?:\/\//i.test(value)) {
    const extracted = extractFromUrl(value, ats);
    if (!extracted) return null;
    value = extracted;
  }

  value = value
    .toLowerCase()
    .replace(/^\/+|\/+$/g, '') // stray path slashes
    .replace(/\?.*$/, '') // stray query string
    .trim();

  // A leftover path ("acme/jobs") means we grabbed too much — keep the first segment.
  if (value.includes('/')) value = value.split('/')[0];

  try {
    value = decodeURIComponent(value);
  } catch {
    // Malformed percent-encoding — keep the raw value.
  }

  // Collapse the whitespace that percent-decoding can reveal, so "tools  for
  // humanity" and "tools for humanity" dedupe to one entry.
  value = value.replace(/\s+/g, ' ').trim();

  if (!value || value.length > MAX_SLUG_LENGTH) return null;
  if (!(SLUG_PATTERNS[ats] ?? DEFAULT_SLUG_PATTERN).test(value)) return null;
  if (BLOCKLIST.has(value)) return null;

  return value;
}

function extractFromUrl(url, ats) {
  const patterns = URL_PATTERNS[ats] ?? [];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}
