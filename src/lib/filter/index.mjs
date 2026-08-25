/**
 * The filter engine.
 *
 * One profile in, a ranked list plus live facet counts out. Shared verbatim by
 * the CLI (`src/find.mjs`), the local app (`src/server.mjs`) and the daily diff
 * (`src/daily.mjs`), so all three agree by construction rather than by care.
 *
 * ## Why the hot columns live in memory
 *
 * The obvious build is SQL: one `WHERE` per criterion, `GROUP BY` per facet.
 * It was measured and rejected. Filter counts have to be *leave-one-out* — "how
 * many more jobs if I also tick Boston" is not the same query as the result set
 * — so a facet row costs one query per dimension, and the title gate has to be
 * expressed twice (as FTS for SQL and as word-boundary regex for ranking) with
 * two different notions of what a word is.
 *
 * Loading the 20 hot columns for every open job took 388 ms and ~190 MB once,
 * measured at 61k jobs, and every query after that ran in 74–160 ms with all
 * nine facets computed in the same pass. One matcher, one definition of a word
 * boundary, and the same code the derive pass is regression-tested against. The
 * cold descriptions (296 MB at the same measurement) stay in SQLite and are read
 * only for the rows that survived — 453 of them for the shipped profile. The
 * corpus has grown several-fold since and the index grows with it, in memory and
 * in load time alike.
 *
 * The index is cached and invalidated on the derive generation, so a re-derive
 * is picked up without restarting the server.
 */

import { openDb } from '../db.mjs';
import { fold } from '../derive/text.mjs';
import { GUESSED_ONSITE } from '../derive/workplace.mjs';
import { normalizeProfile } from './profile.mjs';
import { compileProfile, screen, hits, compileTerms } from './match.mjs';
import { scoreJob, explain, sortRows, topRows, salaryLabel, textSpecificity } from './rank.mjs';
import { ATS_KEYS, COMPANY_SIZE_BANDS, PAY_PERIODS, REMOTE_SCOPES, companySizeBand } from '../schema.mjs';
import { countryName } from '../adapters/iso-countries.mjs';

export {
  normalizeProfile,
  blankProfile,
  activeCriteria,
  UNKNOWN_POLICIES,
  UNKNOWNABLE,
  DEFAULT_WEIGHTS,
  SORTS,
} from './profile.mjs';
export { COMPANY_SIZE_BANDS, PAY_PERIODS, REMOTE_SCOPES } from '../schema.mjs';

/** Columns the filter reads. Everything else stays on disk. */
const HOT_COLUMNS = `
  j.id, j.ats, j.title, j.title_norm, j.company_name, j.company_slug, j.employment_type,
  j.d_workplace, j.d_workplace_src, j.d_remote_scope, j.d_metros, j.d_countries,
  j.d_salary_min, j.d_salary_max, j.d_salary_known, j.d_salary_src,
  j.comp_interval, j.comp_currency, j.has_equity,
  j.d_min_years, j.d_max_years, j.d_years_known,
  j.d_seniority, j.d_job_function, j.d_skills,
  j.d_visa, j.d_clearance, j.d_degree, j.d_age_days, j.d_quality,
  j.posted_at, j.first_seen, j.last_seen, j.url, j.apply_url, j.department
`;

const cache = new Map(); // db path -> index

/**
 * How long a generation reading is trusted before it is taken again.
 *
 * The key is three single-row reads, which sounds free and is not: `search()`
 * asks for it, then `missingDescriptions()` asks again, then `metroLabels()`
 * asks a third time, and on a 337k-job corpus that was 264 ms of a 767 ms query
 * spent re-answering "has anything changed?" three times inside one request.
 *
 * Half a second is chosen so that a re-derive in another process is still
 * picked up without a restart -- the property the generation key exists for --
 * while a burst of calls inside one query pays for it once. `invalidateIndex()`
 * and `{ force: true }` both bypass it, so an in-process re-derive is immediate.
 */
const GENERATION_TTL_MS = 500;
const generationCache = new Map(); // db path -> { value, at }

function corpusGeneration(db, key, { fresh = false } = {}) {
  const hit = generationCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < GENERATION_TTL_MS) return hit.value;

  const value = [
    db.prepare("SELECT value FROM meta WHERE key = 'last_derive'").get()?.value ?? '0',
    db.prepare('SELECT COUNT(*) n FROM jobs WHERE is_open = 1').get().n,
    db.prepare('SELECT COUNT(*) n FROM jobs WHERE d_derived_at IS NOT NULL').get().n,
  ].join(':');
  generationCache.set(key, { value, at: Date.now() });
  return value;
}

/**
 * The generation key, plus the one thing it does not watch: `job_events`.
 *
 * `corpusGeneration` is about the *index* — the open jobs and their derived
 * columns — and that is all the index needs. `corpusMeta` reads two more
 * tables' worth of history (`days`, and `activity` beside it), and a sweep can
 * append events without moving the open-job count. `MAX(rowid)` on an integer
 * primary key is an index seek to the last row and costs ~0.01 ms, so watching
 * it is free and the alternative — serving yesterday's activity strip — is not.
 */
function corpusStamp(db, key) {
  const events = db.prepare('SELECT MAX(rowid) n FROM job_events').get()?.n ?? 0;
  return `${corpusGeneration(db, key)}:${events}`;
}

/**
 * Identify a connection for caching. `DatabaseSync#location()` only exists on
 * newer Node builds, and this has to keep working on the 22.13 floor the project
 * declares, so an unnamed connection falls back to a single shared slot — which
 * is correct for every caller here, all of which open exactly one database.
 */
function dbKey(db) {
  try {
    return db.location?.() ?? 'default';
  } catch {
    return 'default';
  }
}

/**
 * Build (or return a cached) in-memory index of every open job.
 *
 * The generation key is `last_derive` plus the open-job count, both of which
 * are single-row reads. A sweep that adds jobs or a re-derive that changes the
 * rules both bump it; nothing else can change a `d_*` column.
 */
export function getIndex(db, { force = false } = {}) {
  const key = dbKey(db);
  const generation = force ? corpusGeneration(db, key, { fresh: true }) : corpusGeneration(db, key);
  const hit = cache.get(key);
  if (!force && hit && hit.generation === generation) return hit;

  const started = Date.now();
  const rows = db.prepare(`SELECT ${HOT_COLUMNS} FROM jobs j WHERE j.is_open = 1`).all();

  // Open roles per company, counted here rather than queried per search.
  // It is the company-size proxy, and it is also what makes that filter honest
  // about its own units: this is a count of postings in *this* corpus on *this*
  // sweep, which is why it is recomputed with the index and never cached beyond
  // the generation key.
  const openRoles = new Map();
  for (const r of rows) openRoles.set(r.company_slug, (openRoles.get(r.company_slug) ?? 0) + 1);

  const jobs = new Array(rows.length);
  const byId = new Map();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const job = {
      id: r.id,
      ats: r.ats,
      title: r.title,
      title_norm: r.title_norm,
      tf: fold(r.title), // pre-folded: the title gate runs over every row
      company_name: r.company_name,
      company_slug: r.company_slug,
      company_size: companySizeBand(openRoles.get(r.company_slug) ?? 1),
      company_open_roles: openRoles.get(r.company_slug) ?? 1,
      department: r.department,
      employment_type: r.employment_type,
      workplace: r.d_workplace,
      // Whether that value is the employer's word or our inference from the job
      // naming an office. `matchWorkplace` is the only criterion that reads it;
      // see `GUESSED_ONSITE`.
      workplace_guessed: r.d_workplace_src === GUESSED_ONSITE,
      remote_scope: r.d_remote_scope,
      metros: parseList(r.d_metros),
      countries: parseList(r.d_countries),
      salary_min: r.d_salary_min,
      salary_max: r.d_salary_max,
      salary_known: r.d_salary_known,
      salary_src: r.d_salary_src,
      pay_period: r.comp_interval,
      currency: r.comp_currency,
      // 1 or absent, never 0 — Ashby names an equity component or says nothing.
      // See `matchEquity` for why that means this criterion cannot answer `no`.
      equity: r.has_equity,
      min_years: r.d_min_years,
      max_years: r.d_max_years,
      years_known: r.d_years_known,
      seniority: r.d_seniority,
      job_function: r.d_job_function,
      skills: parseList(r.d_skills),
      visa: r.d_visa,
      clearance: r.d_clearance,
      degree: r.d_degree,
      age_days: r.d_age_days,
      quality: r.d_quality,
      posted_at: r.posted_at,
      first_seen: r.first_seen,
      last_seen: r.last_seen,
      url: r.url,
      apply_url: r.apply_url,
    };
    jobs[i] = job;
    byId.set(job.id, job);
  }

  const index = { jobs, byId, generation, builtAt: Date.now(), buildMs: Date.now() - started };
  cache.set(key, index);
  return index;
}

function parseList(json) {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Drop a cached index — used by the daily run after it re-derives in-process. */
export function invalidateIndex() {
  cache.clear();
  generationCache.clear();
  metaCache.clear();
}

// ------------------------------------------------------------------ search --

/**
 * Run a profile.
 *
 * @param {DatabaseSync} db
 * @param {object} rawProfile        anything profile-shaped; normalized here
 * @param {object} [opts]
 * @param {number} [opts.limit]      override the profile's own limit
 * @param {number} [opts.offset]
 * @param {boolean} [opts.facets]    compute leave-one-out counts (default true)
 * @param {number} [opts.descriptionLimit] how many descriptions to read for
 *   keyword scoring before giving up and saying so. Reading 2,400 of them costs
 *   ~200 ms; there is no point paying that on an unfiltered corpus scan.
 * @param {Set<string>} [opts.restrictTo] only consider these job ids — how the
 *   "new since" diff reuses the whole engine instead of reimplementing it.
 */
export function search(db, rawProfile, opts = {}) {
  const started = Date.now();
  const { profile, warnings } = normalizeProfile(rawProfile);
  const index = getIndex(db);
  const c = compileProfile(profile, descriptionIndex(db, profile, warnings));
  const facetsWanted = opts.facets !== false;
  const descriptionLimit = opts.descriptionLimit ?? 8000;

  // Free-text search runs in SQLite because that is where the 296 MB of prose
  // lives and FTS5 is already built over it. It produces an id set that the
  // in-memory pass intersects, so the two never disagree about ordering.
  let ftsIds = null;
  let textField = null;
  let textSpec = 1;
  if (profile.text) {
    // `textQuery` is what turns a half-typed word into a prefix search; the
    // ranker below gets the same rewritten query, so "which column matched"
    // is answered about the query that actually ran and not a stricter one.
    const query = textQuery(profile.text);
    const result = ftsSearch(db, query);
    if (result.error) warnings.push(`text search: ${result.error}`);
    else {
      ftsIds = result.ids;
      textField = textFieldRanker(db, query);
      textSpec = textSpecificity(ftsIds.size, index.jobs.length);
    }
  }

  // Description exclusions run in FTS too, so that facet counts see them. Doing
  // them after the fact would make every count a small lie.
  let excludedIds = null;
  if (profile.exclude_description_keywords.length) {
    const query = `body:(${profile.exclude_description_keywords.map(quoteFts).join(' OR ')})`;
    const result = ftsSearch(db, query);
    if (result.error) warnings.push(`description exclusions: ${result.error}`);
    else excludedIds = result.ids;
  }

  const restrictTo = opts.restrictTo ?? null;

  const inRows = [];
  const asideRows = [];
  const facets = facetsWanted ? newFacets(profile) : null;
  let scanned = 0;
  let titleGated = 0;

  // One object, reused for every job. `screen` writes its answers here instead
  // of returning them, which is the difference between zero allocations in this
  // loop and 337,000 of them.
  const verdict = { titleHits: null, failures: 0, failedKey: null, bucket: null, unknownOn: null };

  for (const job of index.jobs) {
    if (restrictTo && !restrictTo.has(job.id)) continue;
    if (ftsIds && !ftsIds.has(job.id)) continue;
    if (excludedIds && excludedIds.has(job.id)) continue;
    scanned++;

    if (!screen(job, profile, c, verdict)) continue; // title gate
    titleGated++;

    // Two or more failures: excluded, and countable towards no facet either —
    // see `screen`, which stops asking at that point for exactly this reason.
    if (verdict.failures > 1) continue;
    if (facets) tallyFacets(facets, job, verdict.failedKey, profile);
    if (verdict.failures) continue;

    (verdict.bucket === 'in' ? inRows : asideRows).push({
      job,
      titleHits: verdict.titleHits,
      // The criteria this posting is silent on. Kept rather than the whole
      // verdict map, because this is the only part of it anything reads.
      unknownOn: verdict.unknownOn,
    });
  }

  // ------------------------------------------------- description keywords --
  // The gate already ran, in FTS, before the loop above — see
  // `descriptionIndex`. This second pass is only about *which* keywords hit, and
  // it exists because the score is by count and the UI names the terms. It reads
  // the descriptions of the survivors, so it is bounded by the result set rather
  // than by the corpus.
  const candidates = [...inRows, ...asideRows];
  let descriptionsRead = 0;
  if (profile.description_keywords.length) {
    if (candidates.length > descriptionLimit) {
      warnings.push(
        `description keywords not scored: ${candidates.length.toLocaleString('en-US')} results exceed the ` +
          `${descriptionLimit.toLocaleString('en-US')}-row read limit — narrow the filters or raise --description-limit`,
      );
    } else {
      const compiled = compileTerms(profile.description_keywords);
      const texts = readDescriptions(db, candidates.map((r) => r.job.id));
      descriptionsRead = texts.size;
      for (const row of candidates) row.descHits = hits(texts.get(row.job.id) ?? '', compiled);
    }
  }

  for (const row of candidates) {
    row.textHit = textField ? textField(row.job.id) : null;
    const scored = scoreJob(row.job, profile, {
      titleHits: row.titleHits,
      descHits: row.descHits ?? [],
      textHit: row.textHit,
      textSpec,
    });
    row.score = scored.score;
    row.parts = scored.parts;
    row.why = explain({ descHits: row.descHits ?? [] });
  }

  const matched = inRows.length;
  const limit = opts.limit ?? profile.limit;
  const offset = opts.offset ?? 0;

  // The ordering runs after the score, never instead of it: every sort falls
  // through to the score and then to a fixed tiebreak, so two identical queries
  // always come back in the same order whichever one is picked.
  //
  // **How deep that ordering has to go depends on collapsing.** Collapsing
  // walks the whole list in rank order and keeps the best copy of each
  // duplicate, so it needs every row placed. Paging does not: a request reads
  // `offset + limit` rows and never looks below them, and on an unfiltered
  // corpus that is 200 rows out of 337,000 — ordering the other 337,000 was a
  // third of the query. `topRows` returns exactly what the full sort's first
  // `k` would have been; see the note there on why "exactly" is provable.
  const collapsing = profile.collapse_duplicates;
  const inOrdered = collapsing ? sortRows(inRows, profile.sort) : topRows(inRows, profile.sort, offset + limit);
  const asideOrdered = collapsing ? sortRows(asideRows, profile.sort) : topRows(asideRows, profile.sort, limit);

  // Collapsing happens after the sort so the copy that survives is the
  // best-ranked one, not whichever the scan reached first.
  const shown = collapsing ? collapse(inOrdered) : inOrdered;
  const shownAside = collapsing ? collapse(asideOrdered) : asideOrdered;

  // `shown` is the whole match set when collapsing and only the page when not,
  // so the totals come off the row arrays rather than off the page.
  const total = collapsing ? shown.length : matched;
  const asideTotal = collapsing ? shownAside.length : asideRows.length;

  return {
    profile,
    warnings,
    total,
    aside_total: asideTotal,
    results: shown.slice(offset, offset + limit).map(present),
    aside: shownAside.slice(0, limit).map(present),
    facets: facets ? finishFacets(facets, db, profile) : null,
    funnel: {
      open_jobs: index.jobs.length,
      considered: scanned,
      passed_title_gate: titleGated,
      matched,
      // How many postings the collapse folded away. Reported rather than
      // silently applied: a result count that drops from 453 to 291 with no
      // explanation is indistinguishable from a filter that went wrong.
      folded: matched - total,
      set_aside: asideRows.length,
    },
    stats: {
      ms: Date.now() - started,
      index_ms: index.buildMs,
      descriptions_read: descriptionsRead,
      generation: index.generation,
    },
  };
}

/**
 * One posting per company + title.
 *
 * Measured at 61k open jobs, 3,049 company+title pairs accounted for 10,164 of
 * them — 16.6% of the corpus, and it is one role posted once per city rather
 * than 113 distinct openings. LinkedIn and Indeed both drown in this and
 * neither offers a way out; CareerBuilder's retired `ExcludeNational` is the
 * only prior art in the entire survey.
 *
 * The copies are folded into the survivor rather than dropped, because the
 * thing that differs between them is usually the location and that is
 * information: `Territory Partner (Field Sales)` posted 113 times in 113 cities
 * should read as one role hiring in 113 cities, which is what it is.
 *
 * Keyed on `title_norm` — the whitespace-collapsed, lowercased title the schema
 * already stores and indexes — so "Senior  Engineer" and "senior engineer" are
 * the same posting, which is the whole point.
 */
function collapse(rows) {
  const seen = new Map();
  const kept = [];
  for (const row of rows) {
    const key = `${row.job.company_slug}\u0000${row.job.title_norm ?? row.job.tf}`;
    const first = seen.get(key);
    if (first) {
      first.duplicates++;
      for (const metro of row.job.metros) first.duplicateMetros.add(metro);
      continue;
    }
    row.duplicates = 0;
    row.duplicateMetros = new Set(row.job.metros);
    seen.set(key, row);
    kept.push(row);
  }
  return kept;
}

/** The wire shape. Deliberately flat — the UI and the CLI both render this. */
function present(row) {
  const j = row.job;
  return {
    id: j.id,
    // Which board this posting was swept from. A row that says where it came
    // from is a row you can go and check, and it is the one fact about a
    // posting that the posting itself never states.
    ats: j.ats,
    title: j.title,
    company: j.company_name,
    company_slug: j.company_slug,
    company_open_roles: j.company_open_roles,
    company_size: j.company_size,
    department: j.department,
    url: j.url,
    apply_url: j.apply_url,
    workplace: j.workplace,
    workplace_guessed: j.workplace_guessed,
    remote_scope: j.remote_scope,
    metros: j.metros,
    countries: j.countries,
    seniority: j.seniority,
    min_years: j.min_years,
    max_years: j.max_years,
    years_known: j.years_known === 1,
    salary_known: j.salary_known === 1,
    salary_min: j.salary_min,
    salary_max: j.salary_max,
    salary_label: salaryLabel(j),
    salary_src: j.salary_src,
    pay_period: j.pay_period,
    currency: j.currency,
    equity: j.equity === 1,
    employment_type: j.employment_type,
    job_function: j.job_function,
    skills: j.skills,
    visa: j.visa,
    clearance: j.clearance,
    degree: j.degree,
    age_days: j.age_days,
    posted_at: j.posted_at,
    first_seen: j.first_seen,
    quality: j.quality,
    score: row.score,
    score_parts: row.parts,
    title_hits: row.titleHits,
    description_hits: row.descHits ?? [],
    // Which FTS column the free-text term hit: company | title | body. Absent
    // when the search box is empty, which is a different statement from `body`.
    text_hit: row.textHit ?? undefined,
    why: row.why,
    // Only ever set when the collapse ran. 0 means "this is the only copy",
    // absent means "nothing was collapsed at all" — two different statements.
    duplicates: row.duplicates,
    duplicate_metros: row.duplicateMetros ? [...row.duplicateMetros] : undefined,
    unknown_on: row.unknownOn ?? [],
  };
}

// ------------------------------------------------------------------ facets --

/**
 * Facet dimensions and how a job is bucketed into each.
 *
 * These are the controls the UI draws, so the list here *is* the list of
 * filters someone can set — adding a dimension adds a control, with no other
 * change. The `criterion` field says which criterion must be ignored when
 * counting it: a metro count that already applied the metro filter would read
 * `New York City (8,702) · Boston (0)` and be useless.
 *
 * A job with no location we could place counts towards no metro row at all —
 * the list is a list of places you can pick, with no row for the absence of
 * one. Not being counted is not being excluded: `matchMetro` answers UNKNOWN
 * for those jobs and the `metro` unknown policy, `include` by default, keeps
 * them in the results the same way an unpublished salary does.
 */
const FACET_DIMENSIONS = [
  // First in the list because it is the one dimension that *partitions* the
  // corpus rather than describing it: every job has exactly one ATS, so these
  // counts sum to the unfiltered total and no job is counted twice. That also
  // makes it the cheapest sanity check in the UI — if the ATS rows stop summing
  // to the result total, a facet is lying somewhere.
  { key: 'ats', criterion: 'ats', value: (j) => j.ats, order: ATS_KEYS },
  { key: 'metro', criterion: 'metro', values: (j) => j.metros },
  { key: 'workplace', criterion: 'workplace', value: (j) => j.workplace ?? 'unknown' },
  { key: 'seniority', criterion: 'experience', value: (j) => j.seniority ?? 'unknown' },
  // No `unknown` row, for the reason `metro` has none: the list is a list of
  // types you can ask for, and "unstated" is not one of them. `matchEmploymentType`
  // answers UNKNOWN for those jobs and the `employment_type` unknown policy —
  // `include` by default — decides what happens to them. Offering it as a
  // tick-box asked the profile for a value it rejects, and the panel said so.
  { key: 'employment_type', criterion: 'employment_type', value: (j) => j.employment_type },
  { key: 'job_function', criterion: 'job_function', value: (j) => j.job_function ?? 'other' },
  // Not a tally but a sample: the salary ladder is built from the figures in
  // the result set at render time, so `collect` gathers the numbers and
  // `finishFacets` decides where the rungs go. See `salaryLadder`.
  { key: 'salary_band', criterion: 'salary', collect: (j) => (j.salary_known ? (j.salary_max ?? j.salary_min) : null) },
  { key: 'age_band', criterion: 'posted', values: ageBands },
  { key: 'country', criterion: 'metro', values: (j) => j.countries },
  {
    key: 'company_size',
    criterion: 'company_size',
    value: (j) => j.company_size,
    order: COMPANY_SIZE_BANDS.map((b) => b.value),
  },
  {
    key: 'remote_scope',
    criterion: 'remote_scope',
    value: (j) => j.remote_scope,
    order: REMOTE_SCOPES,
  },
  { key: 'pay_period', criterion: 'pay_period', value: (j) => j.pay_period, order: PAY_PERIODS },
  { key: 'degree', criterion: 'degree', value: (j) => j.degree, order: ['none', 'bachelors', 'masters', 'phd'] },
  {
    key: 'visa',
    criterion: 'visa',
    value: (j) => (j.visa === 1 ? 'sponsors' : j.visa === 0 ? 'will not sponsor' : null),
    order: ['sponsors', 'will not sponsor'],
  },
  // The one facet that counts what a control would **remove** rather than what
  // it would return, because that is what its control does. 896 postings name a
  // clearance; the checkbox drops them. The page labels it as such — a count
  // that means the opposite of every other count on the page and does not say
  // so is worse than no count.
  { key: 'clearance', criterion: 'clearance', value: (j) => (j.clearance === 1 ? 'requires clearance' : null) },
  { key: 'currency', criterion: 'currency', value: (j) => j.currency },
  // Two rows, both of them worth seeing. The control is a single checkbox and
  // reads the `yes` count; the `not stated` count next to it is the cost of
  // ticking it, which is the number that should decide whether you do.
  { key: 'equity', criterion: 'equity', value: (j) => (j.equity === 1 ? 'yes' : 'not stated'), order: ['yes', 'not stated'] },
  {
    key: 'salary_source',
    criterion: 'salary_source',
    value: (j) => (!j.salary_known ? 'not published' : j.salary_src === 'as-stated' ? 'as-stated' : 'reinterpreted'),
    order: ['as-stated', 'reinterpreted', 'not published'],
  },
  // Company and skills are counted over the result set rather than
  // leave-one-out: they are almost never the criterion someone is loosening,
  // and "which companies am I looking at" is the more useful question.
  { key: 'company', criterion: null, value: (j) => j.company_name ?? j.company_slug },
  { key: 'skill', criterion: null, values: (j) => j.skills },
];

/**
 * The ladder used when the result set is too thin to build one from.
 *
 * These are the numbers that used to be the *only* ladder, and they were wrong
 * twice over: `<$80k / $80–120k / … / $200k+` says nothing useful about a
 * warehouse search priced hourly, and nothing useful about a staff-engineer
 * search where every row is in the top band. They survive as the fallback
 * because a distribution built from nine figures is noise, not a distribution.
 */
export const SALARY_BANDS = [
  ['unknown', null, null],
  ['<$80k', 0, 80_000],
  ['$80–120k', 80_000, 120_000],
  ['$120–160k', 120_000, 160_000],
  ['$160–200k', 160_000, 200_000],
  ['$200k+', 200_000, Infinity],
];

/** Fewer published figures than this and the fixed ladder is the honest answer. */
const LADDER_FLOOR = 40;

const money = (n) =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}m` : `$${Math.round(n / 1000)}k`;

/**
 * Round a cut point to a number a person would have chosen.
 *
 * A quintile of real salaries lands on $127,438. Printing that as a band edge
 * makes the reader do arithmetic to compare two rows; $125k does not, and the
 * band is a summary rather than a measurement, so the precision was never
 * carrying anything.
 */
function niceRound(n) {
  if (n < 20_000) return Math.round(n / 1_000) * 1_000;
  if (n < 100_000) return Math.round(n / 5_000) * 5_000;
  if (n < 500_000) return Math.round(n / 10_000) * 10_000;
  return Math.round(n / 50_000) * 50_000;
}

/**
 * Build the salary ladder from the figures actually in front of you.
 *
 * SimplyHired is the only board found doing this — its ladder arrives in the
 * page props as a `salaryRangeBoundaries` array with no fixed ladder anywhere
 * behind it. Everyone else ships a constant, and a constant is wrong for most
 * searches by construction: the five rungs that describe a national corpus
 * describe neither half of it once someone filters.
 *
 * Quintiles of the published figures, rounded to readable cuts, deduplicated —
 * a result set where 60% of the figures are the same number produces fewer
 * rungs rather than four labelled the same thing.
 */
export function salaryLadder(values) {
  const known = values.filter((v) => v != null).sort((a, b) => a - b);
  if (known.length < LADDER_FLOOR) return SALARY_BANDS;

  const cuts = [];
  for (const q of [0.2, 0.4, 0.6, 0.8]) {
    const cut = niceRound(known[Math.floor(q * (known.length - 1))]);
    if (cut > 0 && cut !== cuts[cuts.length - 1]) cuts.push(cut);
  }
  if (cuts.length < 2) return SALARY_BANDS;

  const bands = [['unknown', null, null]];
  let lo = 0;
  for (const cut of cuts) {
    bands.push([lo === 0 ? `under ${money(cut)}` : `${money(lo)}–${money(cut)}`, lo, cut]);
    lo = cut;
  }
  bands.push([`${money(lo)}+`, lo, Infinity]);
  return bands;
}

/** Which rung of a ladder one figure sits on. `null` is the published silence. */
function salaryBand(value, ladder) {
  if (value == null) return 'unknown';
  for (const [label, lo, hi] of ladder) if (lo != null && value >= lo && value < hi) return label;
  return 'unknown';
}

export const AGE_BANDS = [
  ['≤7 days', 7],
  ['≤30 days', 30],
  ['≤90 days', 90],
  ['≤180 days', 180],
  ['any age', Infinity],
];

export const ageBandLabel = (days) => `≤${days} day${days === 1 ? '' : 's'}`;

/**
 * The cap in force, as a band, when it is not one of the presets.
 *
 * `posted_within_days` has always accepted any number — the four presets are
 * the common answers, not the whole range — so a profile set to 45 days would
 * otherwise be the one setting the panel shows five counts for, none of them
 * the one actually in force.
 */
export function customAgeBand(profile) {
  const days = profile?.posted_within_days;
  if (days == null || !Number.isFinite(days)) return null;
  if (AGE_BANDS.some(([, max]) => max === days)) return null;
  return [ageBandLabel(days), days];
}

/** The bands to count for this search: the presets, plus theirs if they typed one. */
export function ageBandsFor(profile) {
  const custom = customAgeBand(profile);
  return custom ? [...AGE_BANDS, custom] : AGE_BANDS;
}

/**
 * Age bands are **cumulative**, unlike the salary bands below.
 *
 * The criterion they sit under is `posted_within_days <= N`, so the number a
 * user needs next to "≤30 days" is how many jobs they would get by picking 30 —
 * not how many fall in the 8-to-30 slice. A job therefore counts towards every
 * band it clears, the same way a job in two metros counts towards both.
 * Salary stays a disjoint distribution because its labels are ranges, not caps.
 */
function ageBands(job, profile) {
  if (job.age_days == null) return ['unknown'];
  return ageBandsFor(profile).filter(([, max]) => job.age_days <= max).map(([label]) => label);
}

/**
 * The age bands start at zero rather than absent.
 *
 * Every other facet grows its rows from the jobs it counted, which is right for
 * a list of metros — but the age bands are a fixed set of five, six with a cap
 * of their own, and a band that disappears when nothing is that fresh takes the
 * answer with it: `≤7 days` missing reads as a list that lost a row, where
 * `≤7 days · 0` reads as the answer to the question you asked.
 */
function newFacets(profile) {
  const out = {};
  for (const dim of FACET_DIMENSIONS) out[dim.key] = dim.collect ? [] : new Map();
  for (const [label] of ageBandsFor(profile)) out.age_band.set(label, 0);
  return out;
}

/**
 * Count one job into every facet it is eligible for.
 *
 * Eligibility is the leave-one-out rule: a job counts towards dimension D when
 * the only thing standing between it and the result list is D. `failed` is
 * already the list of criteria that would exclude it, so this is a set-size
 * check rather than a re-evaluation.
 */
/**
 * Which dimensions a job failing exactly one criterion can still count towards.
 *
 * The leave-one-out rule says a job that fails only criterion K counts towards
 * the dimensions built on K and towards nothing else — so that lookup is a Map
 * built once here, not a twenty-iteration scan per job. Two dimensions share
 * `metro` (place and country) and dimensions with a null criterion — company
 * and skill, counted over the result set rather than leave-one-out — belong to
 * no bucket, which is exactly the old `failed[0] !== dim.criterion` outcome.
 */
const DIMENSIONS_BY_CRITERION = new Map();
for (const dim of FACET_DIMENSIONS) {
  if (dim.criterion == null) continue;
  const list = DIMENSIONS_BY_CRITERION.get(dim.criterion);
  if (list) list.push(dim);
  else DIMENSIONS_BY_CRITERION.set(dim.criterion, [dim]);
}

function tallyFacets(facets, job, failedKey, profile) {
  // `failedKey` is null when the job cleared everything and the name of the one
  // criterion it did not otherwise. The two-or-more case never gets here: the
  // caller drops it, and `screen` stops evaluating as soon as it knows.
  //
  // The lookup replaces what used to be a twenty-iteration scan per job, most
  // of it spent deciding that this dimension was not the failing one.
  const dims = failedKey === null ? FACET_DIMENSIONS : DIMENSIONS_BY_CRITERION.get(failedKey);
  if (!dims) return;

  for (const dim of dims) {
    const bucket = facets[dim.key];
    if (dim.collect) {
      bucket.push(dim.collect(job, profile));
      continue;
    }
    // A dimension that yields one value says so, and is counted without
    // wrapping it in an array first: the old shape allocated a fresh
    // one-element array per dimension per job, which on an unfiltered scan is
    // millions of throwaway arrays and the GC pause to go with them.
    if (dim.value) {
      const value = dim.value(job, profile);
      if (value != null) bucket.set(value, (bucket.get(value) ?? 0) + 1);
      continue;
    }
    for (const value of dim.values(job, profile)) {
      if (value == null) continue;
      bucket.set(value, (bucket.get(value) ?? 0) + 1);
    }
  }
}

/**
 * Turn the tallies into what the UI renders: sorted, capped, and labelled from
 * the metro registry so the dropdown says "New York City", not "nyc".
 */
function finishFacets(facets, db, profile) {
  const labels = metroLabels(db);
  const bandLabels = new Map(COMPANY_SIZE_BANDS.map((b) => [b.value, b.label]));
  const out = {};
  // 250 for both place dimensions. The corpus holds 100 distinct countries and
  // the ISO list tops out at 249, so this cap can no longer cut a country off
  // the list — which the old 60 did, silently, to the 40 smallest. A country a
  // profile can be written in has to be one the panel can offer, and a row here
  // is a code, a name and a number.
  const caps = { metro: 250, company: 60, skill: 60, country: 250 };

  // What the panel prints. The `value` stays the id the profile is written in —
  // `nyc`, `de`, `101-500` — so widening a label never changes what a saved
  // profile means. Each falls back to the id: a row whose label is missing is
  // still a row you can tick, and a blank one reads as a broken filter.
  const labelFor = (key, value) =>
    key === 'metro' ? (labels.get(value) ?? value)
    : key === 'company_size' ? (bandLabels.get(value) ?? value)
    // `countryName` refuses anything that is not an alpha-2 code, which is the
    // right answer where it is used to *store* a country and the wrong one
    // here, where the code is already the id and only its caption is at stake.
    : key === 'country' ? (countryName(value) ?? value)
    : value;

  for (const dim of FACET_DIMENSIONS) {
    // The salary ladder is derived from the figures this search actually
    // returned, so its rows are built here rather than tallied in the loop.
    if (dim.collect) {
      const ladder = salaryLadder(facets[dim.key]);
      const counts = new Map(ladder.map(([label]) => [label, 0]));
      for (const value of facets[dim.key]) {
        const band = salaryBand(value, ladder);
        counts.set(band, (counts.get(band) ?? 0) + 1);
      }
      out[dim.key] = ladder.map(([label]) => ({
        value: label,
        label: label === 'unknown' ? 'no figure published' : label,
        count: counts.get(label) ?? 0,
        selected: false,
      }));
      continue;
    }

    const selected = selectedValues(dim.key, profile);
    const entries = [...facets[dim.key]].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    // A dimension with a natural order keeps it. Sorting company-size bands by
    // how many jobs are in each prints `21-100 · 6-20 · 101-500 · 2-5`, which
    // is a list of sizes in no size order and reads as a bug.
    if (dim.order) {
      const rank = (v) => (dim.order.indexOf(v) === -1 ? Number.MAX_SAFE_INTEGER : dim.order.indexOf(v));
      entries.sort((a, b) => rank(a[0]) - rank(b[0]));
    }
    const cap = caps[dim.key] ?? 40;
    // A selected value always survives the cap. Otherwise ticking a small metro
    // makes its own control vanish from the list, which reads as a bug.
    const kept = entries.slice(0, cap);
    for (const entry of entries.slice(cap)) if (selected.has(entry[0])) kept.push(entry);

    out[dim.key] = kept.map(([value, count]) => ({
      value,
      label: labelFor(dim.key, value),
      count,
      selected: selected.has(value),
    }));
    if (entries.length > kept.length) {
      out[`${dim.key}_truncated`] = entries.length - kept.length;
    }
  }
  return out;
}

function selectedValues(key, profile) {
  switch (key) {
    case 'ats':
      return new Set(profile.ats);
    case 'metro':
      return new Set(profile.metros);
    case 'country':
      return new Set(profile.countries);
    case 'workplace':
      return new Set(profile.workplace);
    case 'seniority':
      return new Set(profile.seniority);
    case 'employment_type':
      return new Set(profile.employment_type);
    case 'job_function':
      return new Set(profile.job_functions);
    case 'skill':
      return new Set(profile.skills);
    case 'company':
      return new Set(profile.companies);
    case 'company_size':
      return new Set(profile.company_size);
    case 'remote_scope':
      return new Set(profile.remote_scope);
    case 'pay_period':
      return new Set(profile.pay_period);
    case 'currency':
      return new Set(profile.currencies);
    // Equity and pay-provenance are single booleans rather than value lists, so
    // the row a tick corresponds to is named here instead of read off a set.
    case 'equity':
      return new Set(profile.requires_equity ? ['yes'] : []);
    case 'salary_source':
      return new Set(profile.salary_stated_only ? ['as-stated'] : []);
    case 'degree':
      return new Set(profile.degree);
    case 'visa':
      return new Set(profile.requires_visa_sponsorship ? ['sponsors'] : []);
    case 'clearance':
      return new Set();
    default:
      return new Set();
  }
}

/**
 * Metro id -> display label, cached on the same generation as the index so a
 * re-derive that renames or merges a metro is picked up without a restart.
 */
let metroLabelCache = { generation: null, map: null };
function metroLabels(db) {
  const generation = getIndex(db).generation;
  if (metroLabelCache.generation !== generation) {
    metroLabelCache = {
      generation,
      map: new Map(db.prepare('SELECT id, label FROM metros').all().map((r) => [r.id, r.label])),
    };
  }
  return metroLabelCache.map;
}

// -------------------------------------------------------------- SQLite bits --

/** Quote a term so FTS5 reads it as a phrase and never as syntax. */
function quoteFts(term) {
  return `"${String(term).replace(/"/g, '""')}"`;
}

/**
 * Anything that means something to FTS5 rather than to a reader. A query
 * carrying one of these was written *at* the engine — `company:(devops OR sre)`,
 * `"staff engineer"`, `data NOT analyst` — and is passed through untouched,
 * because rewriting it would change what it asked for.
 *
 * `+`, FTS5's phrase-concatenation operator, is *not* on this list. Nobody
 * writes it without quotes around the phrases it joins, so the quote catches
 * that query anyway — and leaving `+` off means `c++` tokenizes to the word `c`
 * the way it does everywhere else, instead of parsing as syntax and failing.
 */
const FTS_SYNTAX = /["*^():]|(?:^|\s)(?:AND|OR|NOT|NEAR)(?:\s|$)/;

/**
 * The shortest word we will complete for you. A one- or two-letter prefix is
 * not evidence of anything: `a*` matches 341,582 of 341,589 documents and costs
 * 1.5 s to say so, where `ai` as a whole word is 164,895 and 24 ms. Below this
 * the term stays exact, which is also what someone typing `go`, `ai` or `qa`
 * meant — `go*` would bury them in `google` and `governance`.
 */
const PREFIX_MIN = 3;

/**
 * Turn what someone typed in the search box into an FTS5 query.
 *
 * FTS5 matches whole tokens, so `afterque` found nothing at all until the `ry`
 * arrived — a search box that answers "no such company" to eight of the nine
 * letters of a company it has 27 jobs from. Every word long enough to be a real
 * prefix therefore gets FTS5's `*`, so a half-typed name still finds its
 * employer and `data eng` still finds data engineers.
 *
 * Words are joined with an explicit `AND`, which is what adjacent phrases
 * already meant to FTS5 — this only says it out loud alongside the wildcards.
 *
 * Two things it deliberately does not do. It does not complete *inside* a word:
 * this index has no trigram over it, so `query` will never find `AfterQuery`,
 * only `afterq` will. And it does not touch a query that already speaks FTS5
 * (see `FTS_SYNTAX`) — someone who typed `"staff engineer"` in quotes asked for
 * that phrase exactly, and a wildcard would widen a deliberately narrow search.
 */
export function textQuery(text) {
  const raw = String(text ?? '').trim();
  if (!raw || FTS_SYNTAX.test(raw)) return raw;
  // The same split unicode61 makes: everything that is not a letter or a digit
  // is a separator, so `c#`, `react-native` and `hi!` tokenize here exactly the
  // way the index tokenized the prose.
  const words = raw.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!words.length) return raw;
  return words.map((w) => `${quoteFts(w)}${w.length >= PREFIX_MIN ? '*' : ''}`).join(' AND ');
}

/**
 * Run one FTS5 query and return the matching job ids.
 *
 * A malformed query is a user error, not a crash — `implementation AND` is a
 * perfectly reasonable thing to have typed halfway through, so the syntax error
 * comes back as a warning and the rest of the filter still runs.
 */
export function ftsSearch(db, query) {
  try {
    const rows = db
      .prepare(
        `SELECT m.job_id FROM jobs_fts f JOIN jobs_fts_map m ON m.rowid = f.rowid WHERE jobs_fts MATCH ?`,
      )
      .all(query);
    return { ids: new Set(rows.map((r) => r.job_id)) };
  } catch (err) {
    return { error: err.message.replace(/^.*?: /, '') };
  }
}

/**
 * Decide, per job, which FTS column the reader's search term actually hit.
 *
 * The gate above answers "did this match"; the ordering needs "match on what".
 * Two extra column-scoped queries answer it for the whole corpus at once —
 * `company` and `title`. `body` is the residual rather than a third query,
 * because every row that reached the ranker is already known to match
 * somewhere, so anything absent from both narrow sets matched on prose.
 *
 * `text` here is the *rewritten* query `search()` ran, not the raw box — a
 * prefix search must stay a prefix search on the way through, or `afterque`
 * would match the gate and then match neither column and read as a body hit.
 *
 * It is interpolated into a column filter rather than quoted as a phrase, so a
 * reader who types FTS syntax keeps it: `company:(devops OR sre)` is a query
 * someone can reasonably write, and re-quoting it would turn it into a search
 * for that literal string. The cost is that a malformed term can parse
 * here even though it parsed in the gate — an unbalanced paren wrapped in
 * another paren is a different expression. That is why a failed column query
 * degrades to `null` instead of throwing: every row then reads as `body`, the
 * boost becomes a flat floor across the whole result set, and the ordering is
 * exactly what it was before this function existed. A search that ranks no
 * better is a much smaller failure than a search that returns an error.
 */
function textFieldRanker(db, text) {
  const scoped = (column) => {
    const result = ftsSearch(db, `${column}:(${text})`);
    return result.error ? null : result.ids;
  };
  const companyIds = scoped('company');
  const titleIds = scoped('title');
  if (!companyIds && !titleIds) return null;
  return (id) => (companyIds?.has(id) ? 'company' : titleIds?.has(id) ? 'title' : 'body');
}

/**
 * Answer the description keyword gate for the whole corpus, in one FTS query.
 *
 * Returns the two id sets `matchDescription` reads: who matched, and who had no
 * text to match against. `any` is `OR`, `all` is `AND` — FTS5 takes both inside
 * a column filter, so the two modes cost the same and neither one reads a byte
 * of the 296 MB of prose into this process.
 *
 * A malformed keyword is a warning and an inactive gate, never a silent empty
 * result: someone mid-word in the keyword box should see their old results, not
 * zero.
 */
function descriptionIndex(db, profile, warnings) {
  if (!profile.description_keywords.length) return {};

  // A term with no letters or digits tokenizes to nothing, and a phrase that
  // tokenizes to nothing matches nothing — so `-` as a keyword would return an
  // empty result set with no error and no explanation. It is not evidence about
  // any job, so it is dropped out loud instead.
  const terms = profile.description_keywords.filter((t) => /[\p{L}\p{N}]/u.test(t));
  const dropped = profile.description_keywords.filter((t) => !/[\p{L}\p{N}]/u.test(t));
  if (dropped.length) warnings.push(`description keywords: nothing to search for in ${dropped.join(', ')} — ignored`);
  if (!terms.length) return {};

  const joiner = profile.description_match === 'all' ? ' AND ' : ' OR ';
  const query = `body:(${terms.map(quoteFts).join(joiner)})`;
  const result = ftsSearch(db, query);
  if (result.error) {
    warnings.push(`description keywords: ${result.error} — the keyword gate was not applied`);
    return {};
  }
  return { descriptionIds: result.ids, missingDescriptions: missingDescriptions(db) };
}

/**
 * Open jobs with no description text at all — the rows the gate must answer
 * `unknown` for rather than `no`.
 *
 * It has been empty every time it was checked — every open job carried a body.
 * It is still computed, because "there are none right now" is not a property
 * the sweep guarantees, and the alternative is a filter that quietly drops
 * every job whose description failed to arrive. One scan, 180 ms warm, cached
 * on the same generation key as the index and only ever run for a profile that
 * sets description keywords.
 */
let missingDescriptionCache = { generation: null, ids: null };
function missingDescriptions(db) {
  const generation = getIndex(db).generation;
  if (missingDescriptionCache.generation !== generation) {
    const rows = db
      .prepare(
        `SELECT j.id FROM jobs j
          LEFT JOIN job_content c ON c.job_id = j.id
         WHERE j.is_open = 1
           AND (c.job_id IS NULL OR c.description_text IS NULL OR c.description_text = '')`,
      )
      .all();
    missingDescriptionCache = { generation, ids: new Set(rows.map((r) => r.id)) };
  }
  return missingDescriptionCache.ids;
}

/** Read descriptions for a set of ids, chunked around SQLite's variable limit. */
function readDescriptions(db, ids) {
  const out = new Map();
  const CHUNK = 400;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const rows = db
      .prepare(
        `SELECT job_id, description_text FROM job_content WHERE job_id IN (${slice.map(() => '?').join(',')})`,
      )
      .all(...slice);
    for (const row of rows) out.set(row.job_id, fold(row.description_text ?? ''));
  }
  return out;
}

// ------------------------------------------------------------------ lookups --

/** One job in full, descriptions included. What the detail pane renders. */
export function getJob(db, id) {
  const row = db
    .prepare(
      `SELECT j.*, c.description_text, co.name AS company_display, co.name_source, co.board_url
       FROM jobs j
       LEFT JOIN job_content c ON c.job_id = j.id
       LEFT JOIN companies co ON co.id = j.company_id
       WHERE j.id = ?`,
    )
    .get(id);
  if (!row) return null;
  return {
    ...row,
    d_metros: parseList(row.d_metros),
    d_countries: parseList(row.d_countries),
    d_skills: parseList(row.d_skills),
    locations_all: parseList(row.locations_all),
    salary_label: salaryLabel({
      salary_known: row.d_salary_known,
      salary_min: row.d_salary_min,
      salary_max: row.d_salary_max,
    }),
    events: db.prepare('SELECT day, event FROM job_events WHERE job_id = ? ORDER BY day DESC').all(id),
  };
}

/**
 * Everything the UI needs to draw its controls before any filter is applied.
 *
 * All of it comes from the data. The metro list is the registry the derive pass
 * built from observed location strings, not a hardcoded array — when the corpus
 * grows a new city the dropdown grows an option with no code change.
 */
/**
 * The oldest `last_sweep_<ats>` timestamp, or null if nothing has ever swept.
 *
 * Deliberately the minimum. "When was this data last refreshed" has one honest
 * answer across a multi-ATS corpus and it is the stalest one — a Greenhouse
 * sweep finishing does not make the Ashby rows any newer.
 */
function stalestSweep(meta) {
  const stamps = Object.entries(meta)
    .filter(([key]) => key.startsWith('last_sweep_'))
    .map(([, value]) => Number(value))
    .filter((n) => Number.isFinite(n) && n > 0);
  return stamps.length ? Math.min(...stamps) : null;
}

/** How many metro rows `corpusMeta` samples. See the comment on `metros`. */
const METRO_SAMPLE = 250;

const metaCache = new Map(); // db path -> { stamp, value }

/**
 * Everything the page needs to describe the corpus, cached until the corpus
 * changes.
 *
 * This is eleven aggregate queries — a `GROUP BY` over 337k skill rows, another
 * over every job's ATS, two over the event log — and none of them depend on who
 * is asking or on anything but the data. Recomputing them on every page load
 * cost ~70 ms locally and ~300 ms on the deployed machine, all of it in front of
 * the first search, which is the wait a visitor actually notices.
 *
 * The result is shared, not copied: `/api/meta` spreads it into a fresh object
 * and `interpret` reads two counts off it. Nothing mutates it, and nothing
 * should — treat what comes back as frozen.
 */
export function corpusMeta(db) {
  const key = dbKey(db);
  const stamp = corpusStamp(db, key);
  const hit = metaCache.get(key);
  if (hit && hit.stamp === stamp) return hit.value;
  const value = buildCorpusMeta(db);
  metaCache.set(key, { stamp, value });
  return value;
}

function buildCorpusMeta(db) {
  const meta = Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map((r) => [r.key, r.value]));
  // Three counts, three queries, on purpose. As one `SELECT` with a `CASE` in
  // it there is no index that answers all three at once, so SQLite scanned the
  // whole table -- 83 ms on this corpus, on every page load. Split, each one
  // rides an index it already has and the set costs 7 ms.
  const count = (sql) => db.prepare(sql).get().n;
  return {
    jobs: count('SELECT COUNT(*) n FROM jobs'),
    open: count('SELECT COUNT(*) n FROM jobs WHERE is_open = 1'),
    derived: count('SELECT COUNT(*) n FROM jobs WHERE d_derived_at IS NOT NULL'),
    companies: db.prepare('SELECT COUNT(*) n FROM companies').get().n,
    boards_live: db.prepare("SELECT COUNT(*) n FROM companies WHERE status = 'live'").get().n,
    // The *registry* is 24,576 rows and serializing all of them made `/api/meta`
    // a 1.8 MB payload on every page load. Nothing reads them: the metro control
    // is drawn from the search facets, which are already capped and already
    // labelled, and the only caller of this field wanted its length. So the
    // count is the field, and the rows are the top of the list for anyone who
    // wants a registry sample without a second query.
    metros_total: db.prepare('SELECT COUNT(*) n FROM metros').get().n,
    metros: db
      .prepare(`SELECT id, label, country, job_count FROM metros ORDER BY job_count DESC LIMIT ${METRO_SAMPLE}`)
      .all(),
    skills: db
      .prepare('SELECT skill AS value, COUNT(*) AS count FROM job_skills GROUP BY skill ORDER BY count DESC LIMIT 200')
      .all(),
    // The ATS control's universe, read off the data rather than a hardcoded
    // list: an ATS with no swept jobs draws no row, and the day a third adapter
    // lands the control grows an option with no code change. Same rule the
    // metro dropdown already follows.
    //
    // `SUM(is_open)` rather than `COUNT(*) WHERE is_open = 1`, which is the same
    // number by a slower road: the `WHERE` makes SQLite reach for
    // `idx_jobs_open` and then sort 337k rows through a temp B-tree, 124 ms.
    // Summing lets it walk the covering `(ats, is_open)` index it already has,
    // 13 ms, and `HAVING` keeps the "no swept jobs draws no row" rule.
    ats: db
      .prepare('SELECT ats AS value, SUM(is_open) AS count FROM jobs GROUP BY ats HAVING count > 0 ORDER BY count DESC')
      .all(),
    // Per-ATS. This used to read `last_sweep_ashby` alone, which was correct
    // when Ashby was the corpus and became a quiet lie the moment it wasn't —
    // it would have gone on reporting the Ashby time while Greenhouse rows aged
    // beside it. `sweep.mjs` has always written `last_sweep_<ats>`.
    last_sweep_by_ats: Object.fromEntries(
      Object.entries(meta)
        .filter(([key]) => key.startsWith('last_sweep_'))
        .map(([key, value]) => [key.slice('last_sweep_'.length), Number(value) || 0])
        .filter(([, value]) => value > 0),
    ),
    // The corpus as a whole is as fresh as its **stalest** ATS, not its
    // freshest: reporting the newest would call the whole board current on the
    // strength of one sweep.
    last_sweep: stalestSweep(meta),
    last_derive: Number(meta.last_derive ?? 0) || null,
    schema_version: Number(meta.schema_version ?? 0) || null,
    days: db.prepare('SELECT day, COUNT(*) n FROM job_events GROUP BY day ORDER BY day DESC LIMIT 60').all(),
  };
}

export { openDb };
