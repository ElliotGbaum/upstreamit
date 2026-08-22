/**
 * Location → canonical metros + countries.
 *
 * Why this reads every fragment rather than the primary `location` string:
 * measured on 400 boards, the primary string alone finds only **64%** of a
 * metro's jobs. For NYC, 5.4% appear only in `secondaryLocations` and 0.5% only
 * in the structured address — jobs whose `location` reads "Remote" or "NY"
 * while `addressLocality` says "NYC". The sweep already unions all three into
 * `locations_all`, so this reads that array and never the single string.
 *
 * A job legitimately belongs to several metros, so the output is a set. That is
 * also why `job_metros` is a join table: facet counts become an index seek
 * instead of a JSON scan across 61,213 rows.
 *
 * The parser is deliberately conservative. An unrecognised fragment yields no
 * metro rather than a guess — it lands in the unmatched report instead, where
 * it can be turned into a real alias. Silent wrong answers are worse than
 * visible gaps in a filter people trust to not hide jobs.
 */

import { fold, slugify } from './text.mjs';
import { COUNTRIES, SUPRANATIONAL, REGIONS, CITY_TO_METRO, METRO_BY_ID } from './geo.mjs';

/** Split a fragment into components. Real separators seen in the data. */
const SEPARATORS = /\s*(?:,|\||\/|;|·|•|•|\bor\b|\band\b|\+)\s*/g;

/** Words that decorate a place without changing it. `San Francisco Office` -> `San Francisco`. */
const DECORATORS = new RegExp(
  '\\s*\\b(?:' +
    'office|offices|hq|headquarters|based|based in|area|metro|metro area|metropolitan area|' +
    'region|greater|downtown|city center|city centre|campus|site|location|onsite|on-site|' +
    'in person|in-person|hybrid|flexible|preferred|optional|only|usa office' +
  ')\\b\\s*', 'g',
);

/** Remote markers. `distributed` and `anywhere` are real values in the data. */
const REMOTE_RE = /\b(?:remote|remotely|work from home|wfh|distributed|anywhere|virtual|telecommute|home[- ]based|fully remote)\b/;

/** Parenthetical qualifiers: `New York (HQ)`, `Remote (US)`. Kept, not dropped — `(US)` is the scope. */
function flattenParens(text) {
  return text.replace(/[()[\]{}]/g, ' ');
}

/**
 * Parse one raw location fragment.
 * @returns {{metros:Set<string>, countries:Set<string>, supra:Set<string>,
 *            remote:boolean, cities:string[], unmatched:string[]}}
 */
export function parseFragment(raw) {
  const out = { metros: new Set(), countries: new Set(), supra: new Set(), remote: false, cities: [], unmatched: [] };
  let text = fold(raw);
  if (!text) return out;

  text = flattenParens(text);
  if (REMOTE_RE.test(text)) {
    out.remote = true;
    // Strip the marker so `remote - us` leaves `us` to be read as the scope.
    text = text.replace(new RegExp(REMOTE_RE.source, 'g'), ' ');
  }
  // Only a *spaced* hyphen separates components: `New York - Remote` is two
  // things, `Baden-Wurttemberg` and `Ile-de-France` are one each. Replacing
  // every hyphen shattered those into phantom metros named `baden` and `ile`.
  text = text.replace(DECORATORS, ' ').replace(/\s+-\s+/g, ', ').replace(/\s+/g, ' ').trim();
  if (!text) return out;

  const parts = text
    .split(SEPARATORS)
    .map(cleanComponent)
    .filter(Boolean);

  // Country and region are read from anywhere in the fragment, not just the
  // tail: real values include `United States, New York, New York City`, where
  // the country leads. Cities are whatever is left over.
  const leftovers = [];
  let country = null;
  let region = null;

  for (const part of parts) {
    if (COUNTRIES[part]) {
      country = COUNTRIES[part];
      out.countries.add(country);
      // City-states are both. `Singapore` and `Hong Kong` are the country *and*
      // the metro, so they fall through to the city pass as well instead of
      // being consumed here and losing their metro.
      if (!CITY_TO_METRO.has(part)) continue;
    }
    if (SUPRANATIONAL.has(part)) { out.supra.add(part); continue; }
    leftovers.push(part);
  }

  for (const part of leftovers.slice()) {
    // A component is only a region if it isn't a city we know. `New York` is
    // both a state and a city; the city reading wins because a posting saying
    // "New York" means the city ~99% of the time in this data.
    if (CITY_TO_METRO.has(part)) continue;
    const hit = REGIONS.get(part);
    if (hit) {
      region = hit;
      if (!country) { country = hit.country; out.countries.add(country); }
      leftovers.splice(leftovers.indexOf(part), 1);
    }
  }

  for (const part of leftovers) {
    // Try the bare name, then the name disambiguated by region — `newark` is
    // NYC-metro, `newark, ca` is Bay Area, and both spellings are in the table.
    const qualified = region ? `${part}, ${region.code}` : null;
    const metro = (qualified && CITY_TO_METRO.get(qualified)) || CITY_TO_METRO.get(part);
    if (metro) {
      const group = METRO_BY_ID.get(metro);
      out.metros.add(metro);
      out.cities.push({ city: part, metro, minted: false });
      if (group?.country) out.countries.add(group.country);
      continue;
    }
    // Unknown place name. Only treat it as a city — and mint a metro id from
    // it — when it looks like one: not a stray number, not a postal code, not
    // a single letter. Otherwise it is reported as unmatched.
    if (isPlausibleCity(part)) {
      const minted = slugify(part);
      out.metros.add(minted);
      out.cities.push({ city: part, metro: minted, minted: true, country });
      if (country) out.countries.add(country);
    } else {
      out.unmatched.push(part);
    }
  }

  if (country && !out.countries.size) out.countries.add(country);
  return out;
}

/**
 * Tidy one component before lookup.
 *
 * Drops the preposition that survives decorator stripping (`in person in New
 * York City` leaves a bare `in`, which would otherwise glue onto the city and
 * mint a phantom `in-new-york-city` metro), and folds internal periods so
 * `washington d.c` reaches the table as `washington dc`.
 */
function cleanComponent(part) {
  return part
    .replace(/\./g, '')
    .replace(/^(?:in|at|near|from)\s+/, '')
    .replace(/^[\s'-]+|[\s'-]+$/g, '')
    .trim();
}

const NOT_A_CITY = /^(?:\d|[a-z]$|\d{4,}|.{1,2}$)/;

/**
 * Facility and street words. A structured address whose `addressLine` leaked
 * into the city slot was minting metros like `pangyo-software-dream-center`
 * and `829-boston` — one Korean office block became three separate "metros"
 * carrying 97 jobs each.
 */
const NOT_A_PLACE = /\b(?:center|centre|tower|building|floor|suite|plaza|complex|road|street|avenue|boulevard|parkway|po box|department|division|team|remote|various|multiple|tbd|none|worldwide|global)\b/;

function isPlausibleCity(part) {
  if (!part || part.length < 3 || part.length > 40) return false;
  if (NOT_A_CITY.test(part)) return false;
  if (/^\d[\d\s-]*$/.test(part)) return false;          // postal codes
  if (/\d/.test(part)) return false;                     // street numbers, `829 boston`
  if (/^(?:full|part)[- ]time$/.test(part)) return false; // employment type leaking in
  if (NOT_A_PLACE.test(part)) return false;
  // Real city names run to four words (`ho chi minh city`). Longer than that is
  // an address line or a sentence. Street abbreviations are deliberately absent
  // from NOT_A_PLACE above — blocking `st` to catch "Main St" also blocked
  // `St Louis`, and the digit guard already rejects real street addresses.
  if (part.split(' ').length > 4) return false;
  return /[a-z]/.test(part);
}

/**
 * Resolve every location signal on a job into canonical sets.
 *
 * @param {object} job  needs `locations_all` (array or JSON string), `location_raw`,
 *                      and the structured `city` / `region` / `country` columns.
 */
export function deriveLocation(job) {
  const fragments = [];
  const push = (v) => { if (typeof v === 'string' && v.trim()) fragments.push(v); };

  let all = job.locations_all;
  if (typeof all === 'string') { try { all = JSON.parse(all); } catch { all = []; } }
  if (Array.isArray(all)) all.forEach(push);
  push(job.location_raw);
  // The structured address is user-entered and dirty — `city` holds "United
  // States" on thousands of rows — but it is the only signal on 0.5% of NYC
  // jobs, so it is parsed like any other fragment rather than trusted as a city.
  if (job.city && job.region) push(`${job.city}, ${job.region}`);
  else push(job.city);
  push(job.country);

  const metros = new Set();
  const countries = new Set();
  const supra = new Set();
  const unmatched = [];
  const cities = [];
  let remote = false;

  for (const fragment of new Set(fragments.map((f) => f.trim()))) {
    const parsed = parseFragment(fragment);
    parsed.metros.forEach((m) => metros.add(m));
    parsed.countries.forEach((c) => countries.add(c));
    parsed.supra.forEach((s) => supra.add(s));
    cities.push(...parsed.cities);
    unmatched.push(...parsed.unmatched);
    remote = remote || parsed.remote;
  }

  return {
    metros: [...metros].sort(),
    countries: [...countries].sort(),
    supra: [...supra].sort(),
    remoteHint: remote,
    cities,
    unmatched,
  };
}

/**
 * Remote scope, for the 27.9% of jobs that are remote: how far the "anywhere"
 * actually reaches. A NYC job seeker cares that "Remote - Philippines" is not
 * open to them, and the workplace enum alone cannot say so.
 */
export function deriveRemoteScope({ countries, supra }) {
  if (supra.length) return supra.includes('worldwide') || supra.includes('anywhere') || supra.includes('global')
    ? 'worldwide' : 'region';
  if (countries.length === 1) return 'country';
  if (countries.length > 1) return 'region';
  return null;
}
