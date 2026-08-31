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
 * instead of a JSON scan across every row in the corpus.
 *
 * The parser is deliberately conservative. An unrecognised fragment yields no
 * metro rather than a guess — it lands in the unmatched report instead, where
 * it can be turned into a real alias. Silent wrong answers are worse than
 * visible gaps in a filter people trust to not hide jobs.
 *
 * The title is read last, and only when the location fields named no country
 * at all. See `placeInTitle` for why it is read so much more strictly.
 */

import { fold, slugify } from './text.mjs';
import { COUNTRIES, SUPRANATIONAL, REGIONS, CITY_TO_METRO, METRO_BY_ID } from './geo.mjs';

/**
 * Split a fragment into components. Real separators seen in the data.
 *
 * `>` and `:` are Workday's location hierarchy, which it publishes verbatim:
 * `Mexico > Mexico City : Building B` is a country, a city and a room. Without
 * them that is one six-word component, too long to be a city name, and the
 * posting keeps no metro at all.
 */
const SEPARATORS = /\s*(?:,|\||\/|;|>|:|·|•|•|\bor\b|\band\b|\+)\s*/g;

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

  // Underscores are separators, never spelling: `AZ_Mesa_HQ` is a Greenhouse
  // office code. They also block `\b`, so left in place they would hide the
  // decorators (`hq`) and qualifiers (`az`) inside one opaque token.
  text = text.replace(/_/g, ' ');
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
    // The comma-less spelling of a qualified city. `Dallas, TX` has always
    // resolved; `Dallas TX` minted a phantom `dallas-tx` metro — see
    // `resolveGlued` for the shape and the guard.
    const glued = resolveGlued(part);
    if (glued) {
      out.metros.add(glued.metro);
      out.cities.push({ city: part, metro: glued.metro, minted: false });
      if (glued.country) out.countries.add(glued.country);
      continue;
    }
    // A place buried inside a facility code — `Office MPS TX Lewisville 1`.
    // See `resolveEmbedded`.
    const embedded = resolveEmbedded(part, region, country);
    if (embedded) {
      out.metros.add(embedded.metro);
      out.cities.push({ city: embedded.city, metro: embedded.metro, minted: embedded.minted });
      const scope = embedded.country ?? country;
      if (scope) out.countries.add(scope);
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
 * A component that reads "city + its own qualifier", comma missing.
 *
 * `Dallas, TX` has always resolved: the comma splits it, `tx` reads as a
 * region, the qualified lookup does the rest. `Dallas TX` — the same answer
 * minus one comma — fell through to the mint and became a phantom `dallas-tx`
 * metro, and a job whose only metro is the phantom answers a confident *no*
 * to a Dallas search. Not an unknown the policy could keep: invisible.
 * Measured before the fix, the glued shapes (`us-ny-new-york`, `boston-ma`,
 * `london-uk`, `berlin-germany`, `atlanta-georgia`…) covered every US metro
 * and most European ones.
 *
 * So, before minting, strip a recognised region or country off either end —
 * two levels deep, for `US NY New York` — and look the remainder up again.
 *
 * The guard is what keeps this from being a guess: the stripped qualifier
 * must *agree* with the metro it resolves to, or the strip is rejected and
 * the component mints exactly as before. Agreement means the group's own
 * region for a state/province, the group's country for a country name, or
 * the group's ISO code for a bare code the country table refuses (`Berlin
 * DE` — `de` is reserved for Delaware). That is what keeps `Portland ME`
 * (Maine, not Oregon's group), `Paris TX` (Texas, not France), `Surrey GB`
 * (England, not Vancouver's suburb) and `Costa Mesa` (`costa` reads as Costa
 * Rica) apart instead of merged wrongly — a wrong merge silently mixes a
 * different city into a metro search, which is worse than the split.
 */
const QUALIFIER_WORDS_MAX = 3; // regions run to three words: `new south wales`

function readQualifier(token) {
  const region = REGIONS.get(token) ?? null;
  const country = COUNTRIES[token] ?? null;
  if (!region && !country) return null;
  return { region, country, token };
}

function agreesWith(group, q) {
  if (!group) return false;
  if (q.region) {
    if (group.region && group.region.toLowerCase() === q.region.code) return true;
    if (!group.region && group.country === q.region.country) return true;
  }
  if (q.country && group.country === q.country) return true;
  return q.token === group.country;
}

function lookupQualified(cityPart, q, depth) {
  // An explicit disambiguated entry is the table's own answer — `newark, ca`
  // is Bay Area whatever the guard would say — so it outranks `agreesWith`.
  const qualified = q.region ? CITY_TO_METRO.get(`${cityPart}, ${q.region.code}`) : null;
  if (qualified) return { metro: qualified, group: METRO_BY_ID.get(qualified) };
  const metro = CITY_TO_METRO.get(cityPart) ?? resolveGlued(cityPart, depth + 1)?.metro;
  if (!metro) return null;
  const group = METRO_BY_ID.get(metro);
  return agreesWith(group, q) ? { metro, group } : null;
}

function resolveGlued(part, depth = 0) {
  if (depth > 1) return null;
  return (
    gluedWords(part.split(' '), depth) ??
    // Greenhouse names offices `US-MA-Boston`. A bare hyphen is never a
    // separator (`Baden-Wurttemberg`, `Winston-Salem` are one name each), but
    // reading the hyphenated tokens as words here is safe for the same reason
    // the rest of this is: nothing merges unless the qualifier agrees with
    // the metro it resolves to, so `La-Mesa` and `FL-Midtown` still mint.
    (part.includes('-') ? gluedWords(part.split(/[-\s]+/).filter(Boolean), depth) : null)
  );
}

function gluedWords(words, depth) {
  if (words.length < 2) return null;
  for (const fromEnd of [true, false]) {
    for (let take = Math.min(QUALIFIER_WORDS_MAX, words.length - 1); take >= 1; take--) {
      const q = readQualifier((fromEnd ? words.slice(-take) : words.slice(0, take)).join(' '));
      if (!q) continue;
      const rest = (fromEnd ? words.slice(0, -take) : words.slice(take)).join(' ');
      const hit = lookupQualified(rest, q, depth);
      if (hit) return { metro: hit.metro, country: hit.group?.country ?? q.country ?? q.region?.country ?? null };
    }
  }
  return null;
}

/**
 * The place buried inside a facility code.
 *
 * `resolveGlued` reads a component that is *exactly* a city and its own
 * qualifier. Workday customers name their offices instead, and an office name
 * is neither: `Office MPS TX Lewisville 1` is an org acronym, a state, a city
 * and a building number in one string. The parser refused it outright — a
 * digit anywhere blocks the mint — so those postings carried no metro at all
 * and, since no filter excludes on a blank field, were offered to everyone
 * regardless of where they were looking. Its sibling `Office MPS TN Nashville`
 * was worse: no digit, so the whole string minted as `mps-tn-nashville`, a
 * phantom metro that answers a confident *no* to a Nashville search.
 *
 * So look for the place *inside* the string rather than requiring it to be the
 * whole of it. Two passes, in this order.
 *
 * **A known city, lifted out.** Any run of up to four words already in the
 * table. Lifting a city out of a longer string is only safe when the words
 * around it cannot be part of a city name themselves — otherwise `New York
 * Mills, MN` reads as New York and `North Chicago` as Chicago, which is
 * exactly the wrong *merge* this file exists to avoid. So the run must be
 * bounded, each side, by the end of the component or by an **opaque** token:
 * one carrying a digit, one with no vowel (`MPS`, `TX`, `DN` — an acronym,
 * never a name), a venue word (`hospital`, `hotel`), or a region code. A
 * component naming a street is refused outright: `829 Boston Post Road` is not
 * in Boston, and its house number and `Road` would bound `boston` perfectly.
 *
 * **A better mint.** When nothing in the table matches, mint the run *beside*
 * the state code rather than the whole string — `lewisville`, not
 * `mps-tx-lewisville-1`, and not nothing. Three conditions, each protecting a
 * reading that is already right:
 *
 *  - Exactly one contiguous run of qualifier tokens. `de la selva de mar` has
 *    three (`de`, `la`, `de`) and is Catalan, not Delaware.
 *  - Something must be left over once the qualifier and the city are taken
 *    out. `Washington State`, `Costa Mesa` and `La Mesa` leave nothing, which
 *    means `resolveGlued` already tried this exact reading and its guard
 *    rejected it; minting the remainder here would undo that.
 *  - The run must not itself be a known city. `Portland ME`, `Paris TX` and
 *    `FL-Midtown` are the guard's own answers, and minting the bare city would
 *    quietly merge them into the wrong metro.
 */
const CITY_WORDS_MAX = 4; // `ho chi minh city`

/**
 * Words that name a facility rather than a place. Used only to bound a lifted
 * city, never to reject a component, so this list can be broad where
 * `NOT_A_PLACE` has to be careful.
 */
const VENUE_WORDS = new Set([
  'hotel', 'motel', 'resort', 'casino', 'hospital', 'medical', 'clinic', 'health',
  'healthcare', 'university', 'college', 'school', 'academy', 'campus', 'institute',
  'laboratory', 'lab', 'inc', 'llc', 'corp', 'ltd', 'gmbh', 'group', 'holdings',
  'bank', 'store', 'shop', 'branch', 'warehouse', 'plant', 'factory', 'depot',
  'terminal', 'garage', 'headquarters', 'hq', 'office', 'facility', 'center',
  'centre', 'tower', 'building', 'bldg', 'plaza', 'complex', 'department',
  'division', 'team', 'unit', 'district', 'region', 'site',
]);

/** Vowel-less words that *are* part of a name. `St Louis`, `Mt Vernon`. */
const NAME_PARTICLES = new Set(['st', 'mt', 'ft']);

/**
 * A token that cannot be part of *any* name: a building number, or an acronym
 * a company stamped on an office (`MPS`, `DN`, `SSM`, `PHL`). No city is
 * vowel-less except the abbreviated particles above.
 */
function isHardBoundary(word) {
  if (NAME_PARTICLES.has(word)) return false;
  return /\d/.test(word) || !/[aeiou]/.test(word);
}

/**
 * A token a city name may end against. Weaker than `isHardBoundary`: a venue
 * word can equally well be part of what the *institution* is called, which is
 * why an unqualified lift is not allowed to rest on one alone.
 */
function isOpaqueToken(word) {
  return isHardBoundary(word) || VENUE_WORDS.has(word) || readQualifier(word) !== null;
}

/**
 * The span of the component that could be a name at all, ignoring the building
 * numbers a facility code carries at either end. `MPS TX Lewisville 1` ends at
 * `Lewisville`, so that is where a city is allowed to end.
 */
function nameSpan(words) {
  let start = 0;
  let end = words.length;
  while (start < end && /\d/.test(words[start])) start += 1;
  while (end > start && /\d/.test(words[end - 1])) end -= 1;
  return { start, end };
}

/**
 * Contiguous runs of qualifier tokens, left to right, longest match first.
 * `US FL` is one run, not two — a country followed by its own state is a chain,
 * and the more specific end of it is the qualifier that matters.
 */
function qualifierRuns(words) {
  const runs = [];
  let i = 0;
  while (i < words.length) {
    let found = null;
    for (let take = Math.min(QUALIFIER_WORDS_MAX, words.length - i); take >= 1; take--) {
      const q = readQualifier(words.slice(i, i + take).join(' '));
      if (q) { found = { q, start: i, end: i + take }; break; }
    }
    if (!found) { i += 1; continue; }
    const last = runs[runs.length - 1];
    if (last && last.end === found.start) {
      last.end = found.end;
      if (found.q.region || !last.q.region) last.q = found.q;
    } else {
      runs.push(found);
    }
    i = found.end;
  }
  return runs;
}

/** The qualifier governing a span: the nearest run in the component, if any. */
function nearestRun(runs, start, end) {
  let best = null;
  let bestGap = Infinity;
  for (const run of runs) {
    const gap = run.end <= start ? start - run.end : run.start - end;
    if (gap >= 0 && gap < bestGap) { best = run; bestGap = gap; }
  }
  return best;
}

function liftKnownCity(words, runs, outerQ, fragmentCountry) {
  const inRun = (i) => runs.some((run) => i >= run.start && i < run.end);
  const span = nameSpan(words);

  for (let len = Math.min(CITY_WORDS_MAX, words.length); len >= 1; len--) {
    for (let i = 0; i + len <= words.length; i++) {
      // The whole component is what the caller already tried.
      if (i === 0 && len === words.length) continue;
      // A city buried between two facility words is part of the facility's
      // name, not its address: `Columbia University Irving Medical Center` is
      // in New York and the `Irving` in it is a person. Only a name that runs
      // to one end of the component is the place.
      if (i !== span.start && i + len !== span.end) continue;
      let overlaps = false;
      for (let k = i; k < i + len && !overlaps; k++) overlaps = inRun(k);
      if (overlaps) continue;
      const left = i > 0 ? words[i - 1] : null;
      const right = i + len < words.length ? words[i + len] : null;
      if (left !== null && !isOpaqueToken(left)) continue;
      if (right !== null && !isOpaqueToken(right)) continue;

      const city = words.slice(i, i + len).join(' ');
      const q = nearestRun(runs, i, i + len)?.q ?? outerQ;
      if (q) {
        // Depth 1 so this reads the table only; the recursive strip has
        // already had its turn on the whole component.
        const hit = lookupQualified(city, q, 1);
        if (hit && agreesWithFragment(hit.group, fragmentCountry)) {
          return { metro: hit.metro, city, minted: false, country: hit.group?.country ?? null };
        }
        continue;
      }
      // Nothing in the fragment vouches for this reading, so the string itself
      // has to: a venue word beside the city is as likely to mean the city is
      // part of the *institution's* name (`Berkeley Medical Center` is in West
      // Virginia; `Casino Hollywood` is in Florida). An acronym or a building
      // number beside it cannot be a name, so it is a facility code.
      if (!(left !== null && isHardBoundary(left)) && !(right !== null && isHardBoundary(right))) continue;
      const metro = CITY_TO_METRO.get(city);
      const group = metro ? METRO_BY_ID.get(metro) : null;
      if (metro && agreesWithFragment(group, fragmentCountry)) {
        return { metro, city, minted: false, country: group?.country ?? null };
      }
    }
  }
  return null;
}

/** The run of words beside a qualifier, stopping at the first opaque token. */
function runBeside(words, run, after) {
  const out = [];
  if (after) {
    for (let k = run.end; k < words.length && out.length < CITY_WORDS_MAX; k++) {
      if (isOpaqueToken(words[k])) break;
      out.push(words[k]);
    }
  } else {
    for (let k = run.start - 1; k >= 0 && out.length < CITY_WORDS_MAX; k--) {
      if (isOpaqueToken(words[k])) break;
      out.unshift(words[k]);
    }
  }
  return out;
}

function mintBesideQualifier(words, runs) {
  if (runs.length !== 1) return null;
  const [run] = runs;
  // A state or province, never a bare country. `Beth Israel Deaconess Medical
  // Center` is a Boston hospital whose second word is a country, and reading
  // the acronym beside it as a city minted `beth` onto 430 postings.
  if (!run.q.region) return null;
  const span = nameSpan(words);
  for (const after of [true, false]) {
    const start = after ? run.end : run.start - 1;
    const side = runBeside(words, run, after);
    if (!side.length) continue;
    // A name, like a lifted one, runs to an end of the component. In the
    // middle it is part of whatever the facility is called.
    if (after ? run.end + side.length !== span.end : start + 1 - side.length !== span.start) continue;
    // Nothing left over means the qualifier and the city are the whole
    // component — `resolveGlued` already read it that way and refused.
    if ((run.end - run.start) + side.length >= words.length) continue;
    const city = side.join(' ');
    if (CITY_TO_METRO.has(city)) continue;
    if (!isPlausibleCity(city)) continue;
    const { q } = run;
    return {
      metro: slugify(city),
      city,
      minted: true,
      country: q.region?.country ?? q.country ?? null,
    };
  }
  return null;
}

/** A metro on another continent than the fragment's own country is not it. */
function agreesWithFragment(group, fragmentCountry) {
  if (!group?.country || !fragmentCountry) return true;
  return group.country === fragmentCountry;
}

function resolveEmbedded(part, outerRegion, fragmentCountry) {
  // A street address names a building, and the city it is in is not reliably
  // one of the words around it. `829 Boston Post Road` is the case in point.
  if (STREET_RE.test(part)) return null;
  const words = part.split(/[-\s]+/).filter(Boolean);
  if (words.length < 2) return null;

  const runs = qualifierRuns(words);
  const outerQ = outerRegion ? { region: outerRegion, country: null, token: outerRegion.code } : null;
  const lifted = liftKnownCity(words, runs, outerQ, fragmentCountry);
  if (lifted) return lifted;
  // Minting a *fragment* of a name is worse than minting the whole of it —
  // `Rio de Janeiro` must not become `janeiro` because `de` is also Delaware.
  // So this only ever fills a vacuum: it runs where the component is not a
  // plausible city at all and the parser was about to report it unmatched.
  if (isPlausibleCity(part)) return null;
  return mintBesideQualifier(words, runs);
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

/**
 * Street words, including the abbreviations an address line actually uses.
 * Broader than the `NOT_A_PLACE` list below because it only ever *disables*
 * `resolveEmbedded`: a component naming a building says nothing reliable about
 * which city the building is in.
 */
const STREET_RE = /\b(?:floor|suite|road|street|avenue|boulevard|parkway|po box|plaza|ave|av|blvd|rd|pkwy|hwy|ln|dr|route|rue|calle|avenida|paseo|strasse|str)\b/;
/**
 * Facility and street words. A structured address whose `addressLine` leaked
 * into the city slot was minting metros like `pangyo-software-dream-center`
 * and `829-boston` — one Korean office block became three separate "metros"
 * carrying 97 jobs each.
 */
const NOT_A_PLACE = /\b(?:center|centre|tower|building|floor|suite|plaza|complex|road|street|avenue|boulevard|parkway|po box|department|division|team|remote|various|multiple|tbd|none|worldwide|global)\b/;

function isPlausibleCity(part) {
  if (!part || part.length < 3 || part.length > 40) return false;
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
 * A place named in the title, read only when the location fields named none.
 *
 * `Enterprise Sales Representative – Saudi Arabia` was posted with the
 * location `Remote`. Nothing in the location fields placed it, so it carried
 * no country — and a job with no country is *unknown* to a New York search,
 * offered rather than hidden, because no filter excludes on a blank field.
 * The title said where it was the whole time. Measured on 60,000 open jobs
 * the location fields could not place, one title in 23 names a place the
 * tables recognise.
 *
 * A title is prose, not a location field, so this reads it far more strictly
 * than `parseFragment` reads a fragment:
 *
 *  - Only what the tables already know: a country by name, a supranational
 *    region, a state or province by name, a city in the metro table. Nothing
 *    is minted. `Product Manager - Growth` must not become a `growth` metro
 *    that answers a confident *no* to every metro search.
 *  - A bare two-letter code is never a place on its own. `Senior Network
 *    Engineer, IT` is not in Italy, `Physical Therapist, PT` is not in
 *    Portugal, and `PE`, `MD`, `AR`, `QC` are job words before they are
 *    provinces. The exceptions are `US`, `UK` and `EU`, which a title uses as
 *    a place (`Remote US`) and for nothing else.
 *  - A code does count in the `City, ST` shape — `Indianapolis, IN`, `Tulsa,
 *    OK`, `Ottawa, ON`: after a comma, a state or province, and something
 *    before it that could be a city. Measured across the corpus that shape
 *    is a real place all but a few dozen times in five thousand. It yields
 *    the state's country, and a metro only if the table knows the city
 *    under that qualifier — `Portland, ME` is still not Portland, Oregon.
 *  - `resolveGlued` and `resolveEmbedded` are not consulted. They exist to
 *    read office codes, and on prose they read `Sign On Bonus` as Ontario
 *    and the French `de` as Delaware.
 *
 * The parentheticals and the dash-separated pieces of the title are each
 * read as a segment, because that is where a title puts a place. Within a
 * segment only a comma joins a city to its qualifier: `MD/DO`, `LC/MS` and
 * `Kältetechniker:in` all put a code after a separator, and none is a place.
 */
const TITLE_DASHES = /\s+-\s*|\s*-\s+/;
const TITLE_PARENS = /\(([^()]*)\)/g;
const TITLE_CLAUSES = /\s*(?:\||\/|;|>|:|·|•|•|\bor\b|\band\b|\+)\s*/;
/** Short tokens a title uses as a place and for nothing else. */
const BARE_PLACE_CODES = new Set(['us', 'uk', 'eu']);
/**
 * A code that follows a comma in a title without being a province. Measured:
 * `, PE` closes `Structural Engineer, PE` — a licensed engineer — forty times
 * for every once it is Prince Edward Island. `, QC` is mostly Quebec and stays.
 */
const TITLE_NOT_A_QUALIFIER = new Set(['pe']);

export function placeInTitle(title) {
  const out = { metros: new Set(), countries: new Set(), supra: new Set(), cities: [] };
  let text = fold(title);
  if (!text) return out;
  const segments = [];
  text = text.replace(TITLE_PARENS, (_, inner) => { segments.push(inner); return ' '; });
  segments.push(text);
  for (const segment of segments) {
    for (const piece of segment.split(TITLE_DASHES)) readTitleSegment(piece, out);
  }
  return out;
}

function readTitleSegment(segment, out) {
  const text = segment
    .replace(new RegExp(REMOTE_RE.source, 'g'), ' ')
    .replace(DECORATORS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return;
  const addMetro = (metro, city) => {
    out.metros.add(metro);
    out.cities.push({ city, metro, minted: false });
    const country = METRO_BY_ID.get(metro)?.country;
    if (country) out.countries.add(country);
  };
  for (const clause of text.split(TITLE_CLAUSES)) {
    const parts = clause.split(/\s*,\s*/).map(cleanComponent).filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const short = part.length <= 2;
      const country = COUNTRIES[part];
      // City-states fall through to the city pass, as in `parseFragment`.
      if (country && !CITY_TO_METRO.has(part)) {
        if (!short || BARE_PLACE_CODES.has(part)) out.countries.add(country);
        continue;
      }
      if (SUPRANATIONAL.has(part)) {
        if (!short || BARE_PLACE_CODES.has(part)) out.supra.add(part);
        continue;
      }
      if (short) continue;
      // A city, known or merely plausible, with its qualifier after the comma.
      // This is read before the state-name pass because `New Brunswick, NJ`
      // is a city in New Jersey, not a province. The qualifier is not
      // consumed: it adds its own country on the next pass, and a city-state
      // (`Sales Lead, Hong Kong`) keeps its metro.
      const q = i + 1 < parts.length && !TITLE_NOT_A_QUALIFIER.has(parts[i + 1])
        ? readQualifier(parts[i + 1]) : null;
      if (q && (q.region || parts[i + 1].length > 2 || BARE_PLACE_CODES.has(parts[i + 1]))) {
        if (CITY_TO_METRO.has(part) || isPlausibleCity(part)) {
          // Depth 1: the table only, never the glued reading.
          const hit = lookupQualified(part, q, 1);
          if (hit) addMetro(hit.metro, part);
          out.countries.add(q.region?.country ?? q.country);
          continue;
        }
      }
      const region = REGIONS.get(part);
      if (region && !CITY_TO_METRO.has(part)) {
        out.countries.add(region.country);
        continue;
      }
      const metro = CITY_TO_METRO.get(part);
      if (metro) {
        addMetro(metro, part);
        if (country) out.countries.add(country);
      }
    }
  }
}

/**
 * Resolve every location signal on a job into canonical sets.
 *
 * @param {object} job  needs `locations_all` (array or JSON string), `location_raw`,
 *                      the structured `city` / `region` / `country` columns, and
 *                      `title`, which is read only when the rest named no country.
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

  // The title, only when nothing above named a country. See `placeInTitle`.
  if (!countries.size) {
    const titled = placeInTitle(job.title);
    titled.metros.forEach((m) => metros.add(m));
    titled.countries.forEach((c) => countries.add(c));
    titled.supra.forEach((s) => supra.add(s));
    cities.push(...titled.cities);
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
