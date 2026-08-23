/**
 * Geography tables: countries, sub-national regions, and the handful of metros
 * whose parts carry different names.
 *
 * Scope discipline — this file holds only what the swept data actually contains,
 * plus obvious neighbours. It is not a world gazetteer, and it does not need to
 * be: 9,107 distinct location fragments appear across 61,213 jobs, and the top
 * 500 cover 71% of them. The long tail is handled by falling back to the city
 * name itself as its own metro id, so an unlisted city is still filterable —
 * it just doesn't get merged with its neighbours.
 *
 * `metro_aliases` in the database is the authority at query time. This file is
 * the seed that builds it, which means a wrong grouping is fixed by editing one
 * table row and re-deriving, not by shipping code.
 */

/** Sub-national codes that outrank any same-spelled country code. See below. */
const US_STATES_RESERVED = {
  al: 1, ak: 1, az: 1, ar: 1, ca: 1, co: 1, ct: 1, de: 1, fl: 1, ga: 1, hi: 1,
  id: 1, il: 1, in: 1, ia: 1, ks: 1, ky: 1, la: 1, me: 1, md: 1, ma: 1, mi: 1,
  mn: 1, ms: 1, mo: 1, mt: 1, ne: 1, nv: 1, nh: 1, nj: 1, nm: 1, ny: 1, nc: 1,
  nd: 1, oh: 1, ok: 1, or: 1, pa: 1, ri: 1, sc: 1, sd: 1, tn: 1, tx: 1, ut: 1,
  vt: 1, va: 1, wa: 1, wv: 1, wi: 1, wy: 1, dc: 1, pr: 1,
};
const CA_RESERVED = { ab: 1, bc: 1, mb: 1, nb: 1, nl: 1, ns: 1, on: 1, pe: 1, qc: 1, sk: 1 };

/** Country aliases -> ISO 3166-1 alpha-2. Left side must be `fold`ed already. */
export const COUNTRIES = {
  'united states': 'us', 'united states of america': 'us', usa: 'us', us: 'us',
  'u.s.': 'us', 'u.s.a.': 'us', america: 'us',
  'united kingdom': 'gb', uk: 'gb', 'u.k.': 'gb', 'great britain': 'gb', britain: 'gb',
  england: 'gb', scotland: 'gb', wales: 'gb', 'northern ireland': 'gb',
  canada: 'ca', mexico: 'mx', brazil: 'br', brasil: 'br', argentina: 'ar', chile: 'cl',
  colombia: 'co', peru: 'pe', uruguay: 'uy', costa: 'cr', 'costa rica': 'cr',
  panama: 'pa', ecuador: 'ec', guatemala: 'gt', 'dominican republic': 'do',
  germany: 'de', deutschland: 'de', france: 'fr', spain: 'es', espana: 'es',
  italy: 'it', italia: 'it', netherlands: 'nl', 'the netherlands': 'nl', holland: 'nl',
  belgium: 'be', switzerland: 'ch', austria: 'at', poland: 'pl', polska: 'pl',
  portugal: 'pt', ireland: 'ie', sweden: 'se', norway: 'no', denmark: 'dk',
  finland: 'fi', iceland: 'is', estonia: 'ee', latvia: 'lv', lithuania: 'lt',
  'czech republic': 'cz', czechia: 'cz', slovakia: 'sk', hungary: 'hu',
  romania: 'ro', bulgaria: 'bg', greece: 'gr', croatia: 'hr', slovenia: 'si',
  serbia: 'rs', ukraine: 'ua', moldova: 'md', belarus: 'by', russia: 'ru',
  turkey: 'tr', turkiye: 'tr', cyprus: 'cy', malta: 'mt', luxembourg: 'lu',
  israel: 'il', 'united arab emirates': 'ae', uae: 'ae', 'saudi arabia': 'sa',
  qatar: 'qa', kuwait: 'kw', bahrain: 'bh', oman: 'om', jordan: 'jo', lebanon: 'lb',
  egypt: 'eg', morocco: 'ma', tunisia: 'tn', algeria: 'dz', nigeria: 'ng',
  kenya: 'ke', ghana: 'gh', 'south africa': 'za', ethiopia: 'et', uganda: 'ug',
  rwanda: 'rw', tanzania: 'tz', senegal: 'sn',
  india: 'in', pakistan: 'pk', bangladesh: 'bd', 'sri lanka': 'lk', nepal: 'np',
  china: 'cn', 'hong kong': 'hk', taiwan: 'tw', japan: 'jp', 'south korea': 'kr',
  korea: 'kr', singapore: 'sg', malaysia: 'my', indonesia: 'id', thailand: 'th',
  vietnam: 'vn', 'viet nam': 'vn', philippines: 'ph', cambodia: 'kh', myanmar: 'mm',
  australia: 'au', 'new zealand': 'nz', fiji: 'fj',
  armenia: 'am', georgia_country: 'ge', azerbaijan: 'az', kazakhstan: 'kz',
  uzbekistan: 'uz', mongolia: 'mn',
};

/**
 * Bare ISO-3166 alpha-2 codes, added for every country whose code does **not**
 * collide with a US state or Canadian province.
 *
 * `sg`, `cn`, `au`, `kr`, `hk` appear hundreds of times in the structured
 * address and were resolving to nothing. The exclusions are what matter:
 * `ca` means California ~3,650 times here and Canada approximately never,
 * `in` is Indiana before India, `de` Delaware before Germany. Those stay
 * region-only, which is the reading the data actually supports.
 */
for (const code of new Set(Object.values(COUNTRIES))) {
  if (code in US_STATES_RESERVED || code in CA_RESERVED) continue;
  if (!(code in COUNTRIES)) COUNTRIES[code] = code;
}

/**
 * Supra-national regions. Real values in the data (`europe` 288, `european
 * union` 226, `emea`, `apac`) — they are legitimate answers for a remote job's
 * scope, and deliberately never resolve to a metro.
 */
export const SUPRANATIONAL = new Set([
  'europe', 'european union', 'eu', 'eea', 'emea', 'apac', 'apj', 'latam',
  'latin america', 'north america', 'south america', 'asia', 'asia pacific',
  'africa', 'middle east', 'anywhere', 'worldwide', 'global', 'international',
  'americas', 'nordics', 'benelux', 'dach', 'oceania',
]);

/** US states + DC + Puerto Rico. Both the postal code and the spelled name. */
export const US_STATES = {
  al: 'Alabama', ak: 'Alaska', az: 'Arizona', ar: 'Arkansas', ca: 'California',
  co: 'Colorado', ct: 'Connecticut', de: 'Delaware', fl: 'Florida', ga: 'Georgia',
  hi: 'Hawaii', id: 'Idaho', il: 'Illinois', in: 'Indiana', ia: 'Iowa',
  ks: 'Kansas', ky: 'Kentucky', la: 'Louisiana', me: 'Maine', md: 'Maryland',
  ma: 'Massachusetts', mi: 'Michigan', mn: 'Minnesota', ms: 'Mississippi',
  mo: 'Missouri', mt: 'Montana', ne: 'Nebraska', nv: 'Nevada', nh: 'New Hampshire',
  nj: 'New Jersey', nm: 'New Mexico', ny: 'New York', nc: 'North Carolina',
  nd: 'North Dakota', oh: 'Ohio', ok: 'Oklahoma', or: 'Oregon', pa: 'Pennsylvania',
  ri: 'Rhode Island', sc: 'South Carolina', sd: 'South Dakota', tn: 'Tennessee',
  tx: 'Texas', ut: 'Utah', vt: 'Vermont', va: 'Virginia', wa: 'Washington',
  wv: 'West Virginia', wi: 'Wisconsin', wy: 'Wyoming', dc: 'District of Columbia',
  pr: 'Puerto Rico',
};

export const CA_PROVINCES = {
  ab: 'Alberta', bc: 'British Columbia', mb: 'Manitoba', nb: 'New Brunswick',
  nl: 'Newfoundland and Labrador', ns: 'Nova Scotia', on: 'Ontario',
  pe: 'Prince Edward Island', qc: 'Quebec', sk: 'Saskatchewan',
};

/** Lookup: folded region name or code -> { code, country }. */
export const REGIONS = (() => {
  const out = new Map();
  for (const [code, name] of Object.entries(US_STATES)) {
    out.set(code, { code, name, country: 'us' });
    out.set(name.toLowerCase(), { code, name, country: 'us' });
  }
  for (const [code, name] of Object.entries(CA_PROVINCES)) {
    // Canadian codes that collide with US ones (`on` = Ontario vs nothing, `pe`,
    // `ns`, `nb`, `nl`, `sk`, `ab`, `bc`, `mb`, `qc`) only resolve by full name
    // or alongside an explicit Canada, so the bare code is registered only when
    // it does not already belong to a US state.
    if (!out.has(code)) out.set(code, { code, name, country: 'ca' });
    out.set(name.toLowerCase(), { code, name, country: 'ca' });
  }
  // Non-US regions that appear in the data as the middle component.
  for (const [name, country] of Object.entries({
    'baden-wurttemberg': 'de', bavaria: 'de', bayern: 'de', hessen: 'de',
    'nordrhein-westfalen': 'de', berlin: 'de', hamburg: 'de', saxony: 'de',
    'ile-de-france': 'fr', 'ile de france': 'fr', occitanie: 'fr',
    'auvergne-rhone-alpes': 'fr', catalonia: 'es', cataluna: 'es', madrid: 'es',
    andalusia: 'es', lombardy: 'it', lazio: 'it', karnataka: 'in',
    maharashtra: 'in', telangana: 'in', 'tamil nadu': 'in', haryana: 'in',
    'uttar pradesh': 'in', delhi: 'in', gujarat: 'in', 'west bengal': 'in',
    'new south wales': 'au', victoria: 'au', queensland: 'au',
    'western australia': 'au', 'south australia': 'au',
  })) {
    if (!out.has(name)) out.set(name, { code: name, name, country });
  }
  return out;
})();

/**
 * Metros whose constituent cities carry different names.
 *
 * Only groupings a job seeker would expect to be one search. Everything absent
 * from this table becomes its own metro under its own name — the safe default,
 * since a wrong *merge* silently mixes a 90-minute commute into "New York"
 * while a wrong *split* is merely two checkboxes instead of one.
 *
 * `id` is stable and user-facing (it appears in saved filter profiles), so
 * renaming one is a migration. Add freely; rename with care.
 */
export const METRO_GROUPS = [
  { id: 'nyc', label: 'New York City', country: 'us', region: 'NY', cities: [
    'new york', 'new york city', 'nyc', 'new york metro', 'new york city metro',
    'manhattan', 'brooklyn', 'queens', 'the bronx', 'bronx', 'staten island',
    'long island city', 'harlem', 'midtown', 'soho', 'tribeca',
    'jersey city', 'hoboken', 'newark', 'weehawken', 'secaucus',
    'new york metropolitan area', 'greater new york', 'ny metro' ] },
  { id: 'sf-bay', label: 'San Francisco Bay Area', country: 'us', region: 'CA', cities: [
    'san francisco', 'sf', 'south san francisco', 'oakland', 'berkeley', 'emeryville',
    'san jose', 'palo alto', 'east palo alto', 'mountain view', 'menlo park',
    'sunnyvale', 'santa clara', 'redwood city', 'san mateo', 'foster city',
    'cupertino', 'fremont', 'burlingame', 'belmont', 'millbrae', 'brisbane',
    'san bruno', 'daly city', 'milpitas', 'campbell', 'los gatos', 'saratoga',
    'san carlos', 'newark, ca', 'alameda', 'walnut creek', 'pleasanton',
    'san ramon', 'dublin, ca', 'bay area', 'san francisco bay area',
    'silicon valley', 'sf bay area', 'greater bay area', 'peninsula',
    'san francisco bay', 'san francisco city' ] },
  { id: 'la', label: 'Los Angeles', country: 'us', region: 'CA', cities: [
    'los angeles', 'la', 'santa monica', 'culver city', 'pasadena', 'burbank',
    'glendale', 'el segundo', 'venice', 'hollywood', 'west hollywood',
    'marina del rey', 'manhattan beach', 'long beach', 'torrance', 'inglewood',
    'playa vista', 'beverly hills', 'greater los angeles', 'los angeles county' ] },
  { id: 'seattle', label: 'Seattle', country: 'us', region: 'WA', cities: [
    'seattle', 'bellevue', 'redmond', 'kirkland', 'tacoma', 'everett', 'renton',
    'greater seattle' ] },
  { id: 'boston', label: 'Boston', country: 'us', region: 'MA', cities: [
    'boston', 'cambridge', 'somerville', 'waltham', 'burlington, ma', 'newton',
    'quincy', 'lexington, ma', 'watertown', 'east boston', 'greater boston' ] },
  { id: 'dc', label: 'Washington, D.C.', country: 'us', region: 'DC', cities: [
    'washington', 'washington dc', 'washington d.c.', 'washington dc metro', 'district of columbia',
    'arlington', 'alexandria', 'bethesda', 'rockville', 'reston', 'mclean',
    'tysons', 'tysons corner', 'north bethesda', 'silver spring', 'chevy chase', 'crystal city', 'dmv' ] },
  { id: 'chicago', label: 'Chicago', country: 'us', region: 'IL', cities: [
    'chicago', 'chicago heights', 'chicago ridge', 'evanston', 'oak brook', 'schaumburg', 'naperville', 'greater chicago' ] },
  { id: 'austin', label: 'Austin', country: 'us', region: 'TX', cities: ['austin', 'round rock'] },
  { id: 'dallas', label: 'Dallas–Fort Worth', country: 'us', region: 'TX', cities: [
    'dallas', 'fort worth', 'plano', 'irving', 'richardson', 'frisco', 'arlington, tx',
    'addison', 'dfw', 'dallas fort worth', 'dallas-fort worth', 'dallas-fort-worth', 'north dallas', 'south dallas' ] },
  { id: 'houston', label: 'Houston', country: 'us', region: 'TX', cities: ['houston', 'south houston', 'the woodlands', 'sugar land'] },
  { id: 'denver', label: 'Denver', country: 'us', region: 'CO', cities: [
    'denver', 'boulder', 'broomfield', 'lakewood', 'aurora, co', 'louisville, co', 'westminster, co' ] },
  { id: 'atlanta', label: 'Atlanta', country: 'us', region: 'GA', cities: ['atlanta', 'alpharetta', 'sandy springs', 'marietta'] },
  { id: 'miami', label: 'Miami', country: 'us', region: 'FL', cities: [
    'miami', 'miami beach', 'coral gables', 'fort lauderdale', 'boca raton', 'doral', 'brickell' ] },
  { id: 'philadelphia', label: 'Philadelphia', country: 'us', region: 'PA', cities: ['philadelphia', 'philly', 'king of prussia', 'conshohocken'] },
  { id: 'phoenix', label: 'Phoenix', country: 'us', region: 'AZ', cities: ['phoenix', 'scottsdale', 'tempe', 'chandler', 'mesa', 'gilbert'] },
  { id: 'san-diego', label: 'San Diego', country: 'us', region: 'CA', cities: ['san diego', 'san diego county', 'la jolla', 'carlsbad', 'del mar'] },
  { id: 'portland', label: 'Portland', country: 'us', region: 'OR', cities: ['portland', 'beaverton', 'hillsboro'] },
  { id: 'minneapolis', label: 'Minneapolis–St. Paul', country: 'us', region: 'MN', cities: ['minneapolis', 'st paul', 'saint paul', 'bloomington, mn', 'twin cities'] },
  { id: 'salt-lake-city', label: 'Salt Lake City', country: 'us', region: 'UT', cities: ['salt lake city', 'lehi', 'provo', 'draper', 'sandy, ut', 'silicon slopes'] },
  { id: 'raleigh-durham', label: 'Raleigh–Durham', country: 'us', region: 'NC', cities: ['raleigh', 'durham', 'chapel hill', 'cary', 'research triangle', 'research triangle park', 'rtp'] },
  { id: 'nashville', label: 'Nashville', country: 'us', region: 'TN', cities: ['nashville', 'franklin, tn', 'brentwood, tn'] },
  { id: 'toronto', label: 'Toronto', country: 'ca', region: 'ON', cities: ['toronto', 'mississauga', 'markham', 'north york', 'etobicoke', 'scarborough', 'waterloo', 'kitchener', 'gta'] },
  { id: 'vancouver', label: 'Vancouver', country: 'ca', region: 'BC', cities: ['vancouver', 'north vancouver', 'west vancouver', 'burnaby', 'richmond, bc', 'surrey'] },
  { id: 'montreal', label: 'Montréal', country: 'ca', region: 'QC', cities: ['montreal', 'laval', 'longueuil'] },
  { id: 'london', label: 'London', country: 'gb', cities: [
    'london', 'greater london', 'shoreditch', 'canary wharf', 'the city of london',
    'city of london', 'westminster', 'camden', 'hackney', 'croydon' ] },
  { id: 'dublin', label: 'Dublin', country: 'ie', cities: ['dublin'] },
  { id: 'berlin', label: 'Berlin', country: 'de', cities: ['berlin'] },
  { id: 'munich', label: 'Munich', country: 'de', cities: ['munich', 'munchen', 'muenchen'] },
  { id: 'hamburg', label: 'Hamburg', country: 'de', cities: ['hamburg'] },
  { id: 'frankfurt', label: 'Frankfurt', country: 'de', cities: ['frankfurt', 'frankfurt am main', 'eschborn'] },
  { id: 'cologne', label: 'Cologne', country: 'de', cities: ['cologne', 'koln', 'koeln', 'dusseldorf', 'duesseldorf'] },
  { id: 'stuttgart', label: 'Stuttgart', country: 'de', cities: ['stuttgart', 'metzingen', 'riederich', 'reutlingen', 'boblingen'] },
  { id: 'paris', label: 'Paris', country: 'fr', cities: ['paris', 'la defense', 'boulogne-billancourt', 'levallois-perret', 'saint-denis', 'issy-les-moulineaux'] },
  { id: 'amsterdam', label: 'Amsterdam', country: 'nl', cities: ['amsterdam', 'amstelveen', 'hoofddorp', 'haarlem'] },
  { id: 'barcelona', label: 'Barcelona', country: 'es', cities: ['barcelona'] },
  { id: 'madrid', label: 'Madrid', country: 'es', cities: ['madrid'] },
  { id: 'lisbon', label: 'Lisbon', country: 'pt', cities: ['lisbon', 'lisboa'] },
  { id: 'milan', label: 'Milan', country: 'it', cities: ['milan', 'milano'] },
  { id: 'zurich', label: 'Zürich', country: 'ch', cities: ['zurich', 'zug'] },
  { id: 'stockholm', label: 'Stockholm', country: 'se', cities: ['stockholm'] },
  { id: 'copenhagen', label: 'Copenhagen', country: 'dk', cities: ['copenhagen', 'kobenhavn'] },
  { id: 'warsaw', label: 'Warsaw', country: 'pl', cities: ['warsaw', 'warszawa'] },
  { id: 'krakow', label: 'Kraków', country: 'pl', cities: ['krakow', 'cracow'] },
  { id: 'tel-aviv', label: 'Tel Aviv', country: 'il', cities: ['tel aviv', 'tel aviv-yafo', 'herzliya', 'ramat gan'] },
  { id: 'bangalore', label: 'Bengaluru', country: 'in', cities: ['bengaluru', 'bangalore'] },
  { id: 'mumbai', label: 'Mumbai', country: 'in', cities: ['mumbai', 'bombay', 'navi mumbai', 'thane'] },
  { id: 'delhi-ncr', label: 'Delhi NCR', country: 'in', cities: ['delhi', 'new delhi', 'gurgaon', 'gurugram', 'noida', 'ncr'] },
  { id: 'hyderabad', label: 'Hyderabad', country: 'in', cities: ['hyderabad'] },
  { id: 'pune', label: 'Pune', country: 'in', cities: ['pune'] },
  { id: 'chennai', label: 'Chennai', country: 'in', cities: ['chennai', 'madras'] },
  { id: 'singapore', label: 'Singapore', country: 'sg', cities: ['singapore'] },
  { id: 'hong-kong', label: 'Hong Kong', country: 'hk', cities: ['hong kong', 'kowloon'] },
  { id: 'tokyo', label: 'Tokyo', country: 'jp', cities: ['tokyo', 'shibuya', 'minato'] },
  { id: 'seoul', label: 'Seoul', country: 'kr', cities: ['seoul', 'gangnam'] },
  { id: 'sydney', label: 'Sydney', country: 'au', cities: ['sydney'] },
  { id: 'melbourne', label: 'Melbourne', country: 'au', cities: ['melbourne'] },
  { id: 'sao-paulo', label: 'São Paulo', country: 'br', cities: ['sao paulo'] },
  { id: 'mexico-city', label: 'Mexico City', country: 'mx', cities: ['mexico city', 'ciudad de mexico', 'cdmx'] },
  { id: 'bogota', label: 'Bogotá', country: 'co', cities: ['bogota'] },
  { id: 'buenos-aires', label: 'Buenos Aires', country: 'ar', cities: ['buenos aires'] },
  { id: 'kyiv', label: 'Kyiv', country: 'ua', cities: ['kyiv', 'kiev'] },
  { id: 'vilnius', label: 'Vilnius', country: 'lt', cities: ['vilnius'] },
  { id: 'bucharest', label: 'Bucharest', country: 'ro', cities: ['bucharest', 'bucuresti'] },
  { id: 'manila', label: 'Manila', country: 'ph', cities: ['manila', 'makati', 'taguig', 'bgc', 'quezon city', 'pasig', 'cebu'] },
  { id: 'dubai', label: 'Dubai', country: 'ae', cities: ['dubai', 'abu dhabi'] },
];

/** Folded city name -> metro id. Built once at module load. */
export const CITY_TO_METRO = (() => {
  const map = new Map();
  for (const group of METRO_GROUPS) {
    for (const city of group.cities) {
      if (!map.has(city)) map.set(city, group.id);
    }
  }
  return map;
})();

export const METRO_BY_ID = new Map(METRO_GROUPS.map((g) => [g.id, g]));
