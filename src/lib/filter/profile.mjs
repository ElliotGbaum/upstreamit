/**
 * The filter profile — a portable JSON document describing what someone wants.
 *
 * This is the contract between the UI, the CLI and the query engine, and it is
 * the reason none of them contain a criterion of their own: a form posts one of
 * these, `find.mjs` reads one off disk, and the daily run iterates a directory
 * of them. Elliot's criteria are `profiles/nyc-entry-level.json` — a document,
 * not a branch in the code.
 *
 * Two rules shape every field below.
 *
 * **1. Three outcomes per criterion, never two.** Match / no-match / *unknown*.
 * Measured on the full corpus: 24.9% of jobs have no seniority signal, 62.8% no
 * salary, 15.9% no metro, 1.1% no workplace. A binary filter throws those away
 * silently, which for a salary floor means discarding most of the market without
 * saying so. Every criterion that can be unknown therefore carries a policy in
 * `unknowns`: `include`, `exclude`, or `separate` (a second "worth a look" list).
 *
 * **2. Filters read derived columns only.** Every field here maps onto a `d_*`
 * column or a normalized enum, never onto raw ATS JSON. That is what makes
 * improving the NYC alias table a 50-second re-derive instead of a re-sweep.
 *
 * Unset means inactive. `metros: []` is "any metro", not "no metros" — an empty
 * criterion is skipped entirely, including its unknown policy.
 */

import {
  ATS_KEYS,
  COMPANY_SIZE_BANDS,
  EMPLOYMENT_TYPES,
  JOB_FUNCTIONS,
  PAY_PERIODS,
  REMOTE_SCOPES,
  SECTOR_VALUES,
  SENIORITY_LEVELS,
  WORKPLACE_TYPES,
} from '../schema.mjs';

/** What to do with rows a criterion cannot decide. */
export const UNKNOWN_POLICIES = ['include', 'exclude', 'separate'];

/**
 * Criteria that can come back unknown.
 *
 * Served to the UI so the include/exclude/separate controls are generated from
 * this list rather than duplicated in the page — the same rule the metro
 * dropdown follows. `share` is measured over the full open corpus (how and when
 * is noted above `UNKNOWNABLE`), sorted worst-first, and printed next to each
 * control on purpose: `exclude` on salary silently discards most of the market,
 * and the number is the only thing standing between someone and that choice.
 *
 * Every criterion whose column can be absent belongs on this list. `degree`,
 * `visa`, `skills` and `job_function` were missing from it and were therefore hard
 * `no`s on silence — a degree filter dropped 75.6% of the corpus for never
 * mentioning school. The rule is now uniform: a criterion may only rule a job
 * out on evidence, never on the absence of it.
 */
/**
 * The default policy per criterion — the single source of truth for it.
 * `blankProfile` spreads this, `UNKNOWNABLE` publishes it to the UI, and the
 * page's Reset button restores it, so none of the three can drift.
 *
 * Nothing defaults to `exclude`. A filter may rule a job out because the posting
 * says something that fails it, never because the posting is silent — silence is
 * the company's omission, not the job's answer, and on every field here the
 * silent share is large — on the Ashby-only corpus it read 96.8% on sponsorship,
 * 75.6% on degree, 62.8% on salary, 28.4% on skills, 15.9% on location; the
 * current figures are in `UNKNOWNABLE` below.
 *
 * `metro` used to default to `exclude`, on the theory that a location filter
 * admitting unplaceable jobs is not a location filter. Measured on the shipped
 * NYC profile it costs 27 extra rows, not the flood the theory predicted — the
 * other criteria remove almost all of them anyway. Those rows arrive tagged
 * `? metro` in the UI, and `exclude` is still a field away in a saved profile.
 *
 * `experience` used to default to `separate`, which sorted the 24.9% with no
 * seniority signal into a "worth a look" list rather than interleaving them
 * with jobs that matched the years asked for. That list, and the panel that
 * controlled it, were removed from the page; a default of `separate` with no
 * second list to render it would have dropped those jobs off the page
 * altogether. `separate` itself is still a valid policy the engine honours for
 * saved profiles and the CLI — it is simply no longer anyone's default.
 */
const DEFAULT_UNKNOWN_POLICIES = {
  metro: 'include',
  description: 'include',
  workplace: 'include',
  experience: 'include',
  salary: 'include',
  employment_type: 'include',
  posted: 'include',
  job_function: 'include',
  skills: 'include',
  degree: 'include',
  visa: 'include',
  pay_period: 'include',
  currency: 'include',
  equity: 'include',
  remote_scope: 'include',
  salary_source: 'include',
  sector: 'include',
};

// Re-measured 2026-08-22 over the full 337,487-job Ashby + Greenhouse + Lever
// corpus, by activating one criterion at a time and counting the jobs the engine
// itself answers `unknown` for. That is the number this column means: what the
// `exclude` policy would drop.
//
// Measuring it that way corrected one that had been wrong rather than stale.
// `remote_scope` read **0.831**, which is the share of jobs carrying no
// `d_remote_scope` value at all — but `matchRemoteScope` answers `no` for a job
// that is placed and not remote, not `unknown`. Only a remote job that never
// said how far it reaches, or a job with no workplace signal at all, is unknown
// here: **0.036**. The old figure overstated the cost of excluding by 23×.
//
// `job type` moved for a real reason: Lever publishes an employment type on
// 72.5% of its jobs where Greenhouse publishes none, so unknown fell 77.0% →
// 66.4%. Re-measure these after any sweep that adds an ATS, and measure them
// through the match functions — a stale share reads as measured and is worse
// than no number, and a share measured a different way than the filter decides
// is worse still.
export const UNKNOWNABLE = [
  { key: 'equity', label: 'equity', detail: 'no equity component published', share: 0.967 },
  { key: 'visa', label: 'sponsorship', detail: 'nothing said about visa sponsorship', share: 0.944 },
  { key: 'remote_scope', label: 'remote reach', detail: 'a remote role that never said how far it reaches', share: 0.036 },
  // The single biggest change from adding Greenhouse, and the one most likely
  // to be read as a typo: it was genuinely 0.0% when Ashby was the whole corpus,
  // because Ashby publishes `employmentType` on every job. Greenhouse publishes
  // it on none — the key exists in the payload and is populated 0 times out of
  // 1,140 sampled. Lever pulled it back from 77.0% to 66.4% by publishing a
  // usable type on 72.5% of its jobs. `exclude` still discards two thirds of
  // the market.
  { key: 'employment_type', label: 'job type', detail: 'no employment type published', share: 0.664 },
  { key: 'salary', label: 'salary', detail: 'no compensation published', share: 0.742 },
  { key: 'pay_period', label: 'pay period', detail: 'no compensation published, so no interval either', share: 0.741 },
  { key: 'currency', label: 'currency', detail: 'no compensation published, so no currency either', share: 0.741 },
  { key: 'salary_source', label: 'pay as published', detail: 'no figure to have published as-stated', share: 0.742 },
  { key: 'degree', label: 'degree', detail: 'no degree requirement stated', share: 0.616 },
  { key: 'skills', label: 'skills', detail: 'description names none of the tracked skills', share: 0.424 },
  { key: 'experience', label: 'seniority', detail: 'no title band and no years stated', share: 0.279 },
  { key: 'job_function', label: 'job function', detail: 'title and department match no function rule', share: 0.193 },
  // A fact about the company, not the posting, and the one share here that
  // moves with a pass nobody has to re-sweep for: it is the open jobs at
  // companies the enrich pass has not read, or read and would not commit on.
  // Measured 2026-08-27 after the first run, which read the 671 biggest
  // boards before the API account ran out of credit; every further run
  // lowers it. The methodology page reads the live figure off /api/meta.
  { key: 'sector', label: 'sector', detail: "the company's postings did not say what it does, or nobody has read them yet", share: 0.470 },
  { key: 'metro', label: 'location', detail: 'no location string we could place', share: 0.127 },
  // The one share here that is a floor rather than a figure, and the comment is
  // load-bearing for anyone about to "fix" the number. 2.3% is the jobs with no
  // workplace signal at all. Ask for **hybrid** and 51.7% more join them:
  // 174,537 jobs are `onsite` by the `default-has-metro` guess rather than by
  // the employer saying so, and Greenhouse — 165,962 of those — publishes no
  // workplace field on any posting, so it can never say hybrid. `matchWorkplace`
  // answers `unknown` for those on a hybrid search and `match` on an onsite one,
  // which is exactly why no single share fits in this slot.
  //
  // The guessed share fell from 65.2% because Lever states a workplace on 98.0%
  // of its jobs — only 1,316 of its 71,789 land in the guess.
  { key: 'workplace', label: 'workplace', detail: 'no onsite / hybrid / remote signal — plus 51.7% more when you ask for hybrid, which Greenhouse never states', share: 0.023 },
  // 758 jobs of 337,487 whose body never arrived. The roster entry was
  // never optional: a description keyword gate with no text to search must
  // answer `unknown`, not `no`.
  { key: 'description', label: 'description', detail: 'no description text to search', share: 0.0022 },
  { key: 'posted', label: 'posted date', detail: 'no publication date', share: 0.0 },
  // `default` is served alongside the label so the page's Reset button restores
  // exactly what the engine would apply. It used to hardcode its own copy of
  // two policies, which is how Reset kept re-arming `metro: exclude` after the
  // default had moved to `include`.
].map((u) => ({ ...u, default: DEFAULT_UNKNOWN_POLICIES[u.key] }));

/**
 * Ranking weights.
 *
 * Title-keyword count dominates deliberately: it is what separates
 * `AI Deployment Strategist` (3 keywords) from `Product Designer` (1), and on
 * real titles that ordering is the one that reads correctly. Description hits
 * are worth a fraction of a title hit and are capped: a word that appears once
 * in 5 KB of prose says far less about a job than the same word in its title,
 * and past the third or fourth hit it says nothing new. Both lists gate as well
 * as score, but the gate is a yes/no and this is the ordering.
 *
 * `text_match` is the largest weight in the table because free-text search is
 * the one input where the reader has said, in their own words, what they are
 * looking for. It was worth nothing at all until now: `profile.text` produced
 * an id set that gated the corpus and then took no part in the ordering, so a
 * job *at* Palantir and a job whose description mentions Palantir Foundry once
 * in paragraph nine scored identically on the thing that was actually typed.
 * Searching `palantir` put the first real Palantir posting at rank 137 of 1,568
 * — past the 200 rows the page draws for 306 of its 308 openings. The weight
 * has to clear the ~17-point spread the other components produce on a corpus
 * scan, or a company-name hit still loses to a fresher posting elsewhere.
 */
export const DEFAULT_WEIGHTS = {
  text_match: 30,
  title_keyword: 10,
  description_keyword: 1.5,
  description_keyword_cap: 6,
  recency: 8,
  salary: 4,
  years_fit: 5,
  quality: 3,
};

/**
 * The orders a result list can come back in.
 *
 * There was no sort control at all until now, which put this project in company
 * with ZipRecruiter, Monster, CareerBuilder and Talent.com — none of which have
 * one either. `relevance` is still the default and still the good answer: it is
 * the weighted score, and the weights are fields in the profile rather than
 * constants in the code.
 *
 * The other six exist because a score is an opinion, and someone who disagrees
 * with the opinion needs a way to say so. Each one names the column it reads so
 * the menu cannot promise an order the engine does not implement.
 *
 * **Every sort keeps the jobs that cannot answer it.** Sorting by salary with
 * 62.8% of the corpus publishing nothing must not become a salary filter that
 * nobody asked for, so the silent rows sink to the bottom of the list and stay
 * in it — the same rule the criteria follow, applied to the ordering.
 */
export const SORTS = [
  { value: 'relevance', label: 'best match', detail: 'the weighted score — title keywords, then freshness, then the rest' },
  { value: 'newest', label: 'newest first', detail: 'youngest posting first; undated postings last' },
  { value: 'oldest', label: 'oldest first', detail: 'the ones that have been open longest; undated postings last' },
  { value: 'salary-high', label: 'highest pay', detail: 'top of the published range, descending; unpublished pay last' },
  { value: 'salary-low', label: 'lowest pay', detail: 'bottom of the published range, ascending; unpublished pay last' },
  { value: 'quality', label: 'most complete', detail: 'how many of the eight filterable fields the posting actually filled in' },
  { value: 'company', label: 'company A–Z', detail: 'alphabetical, then by score inside each company' },
];

/**
 * A blank profile. Every consumer starts here so a field added later cannot be
 * silently missing on an older saved document.
 */
export function blankProfile() {
  return {
    name: 'untitled',
    label: null,
    notes: null,

    // --- keywords ---------------------------------------------------------
    // Two gates, one on each half of a posting. The title gate is the cheap one
    // and runs first; the description gate runs in FTS5 because that is where
    // the prose lives. Both lists also feed the score, so a keyword someone adds
    // to narrow the pool also orders what survives — `title_keyword` is worth
    // ~7x a description hit, and description hits are capped. See DEFAULT_WEIGHTS.
    //
    // Description keywords used to score without gating, on a measurement that
    // said 93.2% of jobs match at least one of a typical list — a gate that
    // removes 7% of the corpus is not a gate. That number does not hold for a
    // real list: measured at 61k open jobs, the shipped profile's five terms were
    // in 35.8% of descriptions, against 29.5% of titles for its twelve title terms.
    // The two lists are comparable filters, so both of them gate, and
    // `description_match: 'all'` is how you tighten this one.
    title_keywords: [],
    title_match: 'any', // any | all
    description_keywords: [],
    description_match: 'any', // any | all
    exclude_title_keywords: [],
    exclude_description_keywords: [],
    text: '', // free FTS5 query over title + company + description

    // --- source -----------------------------------------------------------
    // Which applicant-tracking systems to draw from. Empty is every one, like
    // every other list here. This is the only criterion that can never answer
    // `unknown` — see `matchAts` — so it carries no entry in `unknowns`.
    ats: [],

    // --- listing status ---------------------------------------------------
    // Whether to include postings the board has stopped listing.
    //
    // A job leaves its board and the next sweep marks it `is_open = 0`; its
    // public page then renders "Job not found" for anyone who follows the link.
    // 43,834 of the 1,109,140 jobs in the corpus are in that state today
    // (workday 15,153 · greenhouse 14,559 · ashby 8,886 · lever 5,236), and
    // until now they were not merely excluded but unreachable — the index held
    // open jobs only, so no profile could ask for one.
    //
    // Default false, because a dead link is the worst thing a job board can
    // hand someone. `true` is for the reader who wants them anyway: a company
    // that just closed a role is a company that was hiring for it last week,
    // and that is a reason to write to them rather than a reason to hide.
    // Results carry `listed: false` so the page can say which ones they are —
    // an unlabelled dead link would be the same failure with extra steps.
    //
    // This is the only criterion whose default makes it *active*, which is why
    // it reads as a positive ("also include") rather than as a filter to set.
    include_unlisted: false,

    // --- companies --------------------------------------------------------
    companies: [], // allow-list, slug or display name
    // What the company does — its industry, read off its own postings by the
    // enrich pass and stored on `companies.sector`. Not the job's function: a
    // data engineer at a bank is `financial-services` here and `data` there.
    // The exclusion is the half most people want ("not finance"), and it is
    // the same evidence read the other way: it fires on a company whose
    // sector is known and listed, never on one nobody has read.
    sectors: [], // subset of SECTOR_VALUES
    exclude_sectors: [],
    // Company size measured in open roles, because headcount is not a field any
    // ATS publishes. See COMPANY_SIZE_BANDS for why it is labelled as what it
    // measures rather than as a funding stage.
    company_size: [],

    // --- place ------------------------------------------------------------
    metros: [],
    countries: [],
    // Remote roles carry a country and a scope but no metro, so a metro filter
    // excludes them by construction. This is the one flag that changes that.
    remote_counts_as_match: false,

    // --- shape of the job -------------------------------------------------
    workplace: [], // subset of WORKPLACE_TYPES minus 'unknown'
    // How far a remote role reaches — worldwide, one country, one region. Only
    // remote postings carry one, so this narrows remote rather than replacing
    // the workplace filter.
    remote_scope: [], // subset of REMOTE_SCOPES
    employment_type: [], // subset of EMPLOYMENT_TYPES
    job_functions: [], // subset of JOB_FUNCTIONS
    skills: [], // any-of, matched against d_skills
    skills_match: 'any', // any | all
    // The negative half. Stack Overflow Jobs paired `tl` (tech you like) with
    // `td` (tech you dislike) and no live board has copied it; Otta weights
    // technologies NEGATIVE, which is the same instinct. One extra field.
    exclude_skills: [],

    // --- seniority --------------------------------------------------------
    // `seniority` is the explicit allow-list. When it is empty, the years cap
    // derives one — see `allowedSeniority` for why both signals are consulted.
    seniority: [],
    max_years_experience: null,
    min_years_experience: null,
    include_intern: false,

    // --- money and freshness ---------------------------------------------
    salary_min: null,
    salary_max: null,
    posted_within_days: null,
    // The rest of the compensation block, all of it already in the database and
    // none of it previously reachable. `pay_period` is the one that matters
    // most: 1,901 open jobs are priced hourly and were invisible as a class.
    pay_period: [], // subset of PAY_PERIODS
    currencies: [], // ISO-4217-ish codes as the board published them
    requires_equity: false, // true keeps only postings with an equity component
    // Glassdoor badges every figure "Employer Est." or "Glassdoor Est." and
    // offers no way to filter on it; Indeed, ZipRecruiter, SimplyHired, Adzuna,
    // Talent.com and Monster all impute estimates and none let you exclude
    // them. We record the provenance in `d_salary_src`, so we can.
    salary_stated_only: false,

    // --- description-derived flags ---------------------------------------
    // null = don't care. true/false = require that answer.
    requires_visa_sponsorship: null, // true keeps only jobs that say they sponsor
    exclude_visa_refusal: false, // true drops jobs that say they will not
    exclude_clearance: false, // security clearance postings
    degree: [], // none | bachelors | masters | phd

    unknowns: { ...DEFAULT_UNKNOWN_POLICIES },

    // --- presentation -----------------------------------------------------
    // Not criteria: these change what the same match set looks like, not which
    // jobs are in it. They live in the profile anyway because the profile is
    // the whole of what a saved search is, and a saved search that forgets it
    // was sorted by pay is a saved search someone has to set up twice.
    sort: 'relevance',
    // 3,049 company+title pairs account for 10,164 open postings — 16.6% of the
    // corpus, one role posted once per city. LinkedIn and Indeed both drown in
    // this; CareerBuilder's `ExcludeNational` is the only prior art and it is
    // retired. Here it is a GROUP BY over the ranked list.
    collapse_duplicates: false,

    weights: { ...DEFAULT_WEIGHTS },
    limit: 100,
  };
}

/** Lower bound in years for each seniority band. Mirrors `seniorityFromYears`. */
const BAND_FLOOR = {
  intern: 0,
  entry: 0,
  junior: 2,
  mid: 3,
  senior: 6,
  staff: 9,
  principal: 10,
  manager: 5,
  director: 8,
  executive: 10,
};

/**
 * The seniority levels a years cap admits.
 *
 * Both signals have to be consulted because they cover different jobs. A
 * quarter of postings state no years at all but do carry `Senior` in the title;
 * conversely `Solutions Analyst` carries no title marker but says "6+ years" in
 * the body. Filtering on years alone lets every senior-titled posting with a
 * silent description through; filtering on the band alone lets `Associate
 * Consultant, 8+ years` through. The engine requires both to agree.
 *
 * `intern` is excluded unless asked for: an internship is a different thing
 * from an entry-level job, and `employment_type` does not always say so — 437
 * jobs carry `Intern` as their type while others post internships as FullTime.
 */
export function allowedSeniority(profile) {
  if (profile.seniority?.length) return new Set(profile.seniority);
  const max = profile.max_years_experience;
  const min = profile.min_years_experience;
  if (max == null && min == null) return null; // criterion inactive

  const out = new Set();
  for (const level of SENIORITY_LEVELS) {
    if (level === 'unknown') continue;
    if (level === 'intern' && !profile.include_intern) continue;
    const floor = BAND_FLOOR[level] ?? 0;
    if (max != null && floor > max) continue;
    // A `min` cap rules out bands that top out below it. `entry` tops out at 1,
    // `junior` at 2, `mid` at 5 — anything whose ceiling is under the floor the
    // user asked for cannot satisfy it.
    if (min != null && BAND_CEILING[level] != null && BAND_CEILING[level] < min) continue;
    out.add(level);
  }
  return out;
}

const BAND_CEILING = { intern: 1, entry: 1, junior: 2, mid: 5, senior: 8 };

const asArray = (value) =>
  value == null ? [] : Array.isArray(value) ? value.filter((v) => v != null && v !== '') : [value];

const asStrings = (value) => asArray(value).map((v) => String(v).trim()).filter(Boolean);

const asNumber = (value) => {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const oneOf = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

const subsetOf = (value, allowed) => {
  const set = new Set(allowed);
  return [...new Set(asStrings(value))].filter((v) => set.has(v));
};

/**
 * Coerce anything profile-shaped into a complete, valid profile.
 *
 * Unknown keys survive into `extra` rather than being dropped, so a document
 * saved by a newer UI round-trips through an older CLI without losing fields.
 * Invalid enum members are dropped with a note in `warnings` — a typo'd metro
 * silently returning zero jobs is exactly the failure the facet counts exist to
 * prevent, so it says so out loud instead.
 */
export function normalizeProfile(input = {}) {
  const base = blankProfile();
  const warnings = [];
  const known = new Set(Object.keys(base));

  const drop = (field, given, kept) => {
    const lost = given.filter((v) => !kept.includes(v));
    if (lost.length) warnings.push(`${field}: ignored unknown value${lost.length > 1 ? 's' : ''} ${lost.join(', ')}`);
  };

  const profile = { ...base };

  profile.name = String(input.name ?? base.name).trim() || 'untitled';
  profile.label = input.label ? String(input.label) : null;
  profile.notes = input.notes ? String(input.notes) : null;

  profile.title_keywords = asStrings(input.title_keywords);
  profile.title_match = oneOf(input.title_match, ['any', 'all'], 'any');
  profile.description_keywords = asStrings(input.description_keywords);
  profile.description_match = oneOf(input.description_match, ['any', 'all'], 'any');
  profile.exclude_title_keywords = asStrings(input.exclude_title_keywords ?? input.exclude_keywords);
  profile.exclude_description_keywords = asStrings(input.exclude_description_keywords);
  profile.text = input.text ? String(input.text).trim() : '';

  profile.ats = subsetOf(input.ats, ATS_KEYS);
  drop('ats', asStrings(input.ats), profile.ats);

  profile.include_unlisted = Boolean(input.include_unlisted);

  profile.companies = asStrings(input.companies);
  // The company exclusion list was removed. A profile saved with one says so
  // rather than losing the entries silently.
  if (asStrings(input.exclude_companies).length) {
    warnings.push('exclude_companies: the company exclusion filter was removed; these entries are ignored');
  }

  profile.company_size = subsetOf(input.company_size, COMPANY_SIZE_BANDS.map((b) => b.value));
  drop('company_size', asStrings(input.company_size), profile.company_size);

  profile.sectors = subsetOf(input.sectors, SECTOR_VALUES);
  drop('sectors', asStrings(input.sectors), profile.sectors);
  profile.exclude_sectors = subsetOf(input.exclude_sectors, SECTOR_VALUES);
  drop('exclude_sectors', asStrings(input.exclude_sectors), profile.exclude_sectors);

  profile.metros = asStrings(input.metros).map((m) => m.toLowerCase());
  profile.countries = asStrings(input.countries).map((c) => c.toLowerCase());
  profile.remote_counts_as_match = Boolean(input.remote_counts_as_match);

  const workplaces = WORKPLACE_TYPES.filter((w) => w !== 'unknown');
  profile.workplace = subsetOf(input.workplace, workplaces);
  drop('workplace', asStrings(input.workplace), profile.workplace);

  profile.remote_scope = subsetOf(input.remote_scope, REMOTE_SCOPES);
  drop('remote_scope', asStrings(input.remote_scope), profile.remote_scope);

  // `Unknown` is filtered out for the same reason `seniority` filters out its
  // own: it is the absence of a value, not a value. `matchEmploymentType`
  // answers UNKNOWN before it ever consults this list, so asking for it could
  // only ever match nothing.
  profile.employment_type = subsetOf(
    input.employment_type,
    EMPLOYMENT_TYPES.filter((t) => t !== 'Unknown'),
  );
  drop('employment_type', asStrings(input.employment_type), profile.employment_type);

  // `families` is what this field was called before it was renamed to the
  // standard term; a profile saved under the old name still loads.
  const rawFunctions = input.job_functions ?? input.families;
  profile.job_functions = subsetOf(rawFunctions, JOB_FUNCTIONS);
  drop('job_functions', asStrings(rawFunctions), profile.job_functions);

  profile.skills = asStrings(input.skills).map((s) => s.toLowerCase());
  profile.skills_match = oneOf(input.skills_match, ['any', 'all'], 'any');
  profile.exclude_skills = asStrings(input.exclude_skills).map((s) => s.toLowerCase());

  profile.seniority = subsetOf(input.seniority, SENIORITY_LEVELS.filter((s) => s !== 'unknown'));
  drop('seniority', asStrings(input.seniority), profile.seniority);

  profile.max_years_experience = asNumber(input.max_years_experience);
  profile.min_years_experience = asNumber(input.min_years_experience);
  profile.include_intern = Boolean(input.include_intern);

  profile.salary_min = asNumber(input.salary_min);
  profile.salary_max = asNumber(input.salary_max);
  profile.posted_within_days = asNumber(input.posted_within_days);

  profile.pay_period = subsetOf(
    asStrings(input.pay_period).map((v) => v.toUpperCase()),
    PAY_PERIODS,
  );
  drop('pay_period', asStrings(input.pay_period).map((v) => v.toUpperCase()), profile.pay_period);

  // Currencies are not an enum here. The corpus carries 40-odd codes today and
  // grows one every time a board in a new country is swept, so validating
  // against a snapshot of that list would reject tomorrow's real answer. The
  // shape is checked instead — three letters, as ISO 4217 writes them.
  const currencies = asStrings(input.currencies).map((v) => v.toUpperCase());
  profile.currencies = currencies.filter((v) => /^[A-Z]{3}$/.test(v));
  drop('currencies', currencies, profile.currencies);

  profile.requires_equity = Boolean(input.requires_equity);
  profile.salary_stated_only = Boolean(input.salary_stated_only);

  profile.requires_visa_sponsorship =
    input.requires_visa_sponsorship == null ? null : Boolean(input.requires_visa_sponsorship);
  profile.exclude_visa_refusal = Boolean(input.exclude_visa_refusal);
  profile.exclude_clearance = Boolean(input.exclude_clearance);
  profile.degree = subsetOf(input.degree, ['none', 'bachelors', 'masters', 'phd']);

  profile.unknowns = { ...base.unknowns };
  for (const [key, value] of Object.entries(input.unknowns ?? {})) {
    if (!(key in base.unknowns)) {
      warnings.push(`unknowns: ignored unknown criterion "${key}"`);
      continue;
    }
    if (!UNKNOWN_POLICIES.includes(value)) {
      warnings.push(`unknowns.${key}: "${value}" is not one of ${UNKNOWN_POLICIES.join(' / ')}`);
      continue;
    }
    profile.unknowns[key] = value;
  }

  profile.weights = { ...DEFAULT_WEIGHTS };
  for (const [key, value] of Object.entries(input.weights ?? {})) {
    const n = asNumber(value);
    if (key in DEFAULT_WEIGHTS && n != null) profile.weights[key] = n;
  }

  profile.sort = oneOf(input.sort, SORTS.map((s) => s.value), base.sort);
  if (input.sort != null && profile.sort !== input.sort) {
    warnings.push(`sort: "${input.sort}" is not one of ${SORTS.map((s) => s.value).join(' / ')} — using ${profile.sort}`);
  }
  profile.collapse_duplicates = Boolean(input.collapse_duplicates);

  profile.limit = Math.max(1, Math.min(asNumber(input.limit) ?? base.limit, 5000));

  const extra = {};
  for (const [key, value] of Object.entries(input)) if (!known.has(key)) extra[key] = value;
  if (Object.keys(extra).length) profile.extra = extra;

  return { profile, warnings };
}

/** How a pay interval reads in a sentence. The UI's labels, for the CLI's summary. */
const PAY_PERIOD_PHRASE = {
  YEAR: 'per year', HALF_YEAR: 'per half-year', MONTH: 'per month', WEEK: 'per week',
  DAY: 'per day', HOUR: 'per hour', NONE: 'on no stated interval',
};

/** Which criteria this profile actually constrains. Drives the UI's "active" chips. */
export function activeCriteria(profile) {
  const active = [];
  const push = (key, summary) => active.push({ key, summary });

  if (profile.title_keywords.length)
    push('title_keywords', `title matches ${profile.title_match === 'all' ? 'all of' : 'any of'} ${profile.title_keywords.length} keyword${profile.title_keywords.length > 1 ? 's' : ''}`);
  if (profile.description_keywords.length)
    push('description', `description matches ${profile.description_match === 'all' ? 'all of' : 'any of'} ${profile.description_keywords.length} keyword${profile.description_keywords.length > 1 ? 's' : ''}`);
  if (profile.text) push('text', `full text: ${profile.text}`);
  if (profile.metros.length) push('metros', `metro in ${profile.metros.join(', ')}`);
  if (profile.countries.length) push('countries', `country in ${profile.countries.join(', ')}`);
  if (profile.workplace.length) push('workplace', profile.workplace.join(' / '));
  if (profile.remote_scope.length) push('remote_scope', `remote reach: ${profile.remote_scope.join(' / ')}`);
  if (profile.employment_type.length) push('employment_type', profile.employment_type.join(' / '));
  if (profile.job_functions.length) push('job_functions', profile.job_functions.join(' / '));
  if (profile.skills.length) push('skills', `${profile.skills_match} of: ${profile.skills.join(', ')}`);
  if (profile.exclude_skills.length) push('exclude_skills', `not: ${profile.exclude_skills.join(', ')}`);
  if (profile.seniority.length) push('experience', `seniority in ${profile.seniority.join(', ')}`);
  else if (profile.max_years_experience != null) push('experience', `≤ ${profile.max_years_experience} yrs experience`);
  else if (profile.min_years_experience != null) push('experience', `≥ ${profile.min_years_experience} yrs experience`);
  if (profile.salary_min != null) push('salary', `≥ $${Math.round(profile.salary_min).toLocaleString('en-US')}`);
  if (profile.salary_max != null) push('salary', `≤ $${Math.round(profile.salary_max).toLocaleString('en-US')}`);
  if (profile.pay_period.length)
    push('pay_period', `paid ${profile.pay_period.map((v) => PAY_PERIOD_PHRASE[v] ?? v).join(' / ')}`);
  if (profile.currencies.length) push('currency', `paid in ${profile.currencies.join(' / ')}`);
  if (profile.requires_equity) push('equity', 'offers equity');
  if (profile.salary_stated_only) push('salary_source', 'pay published as stated');
  if (profile.posted_within_days != null) push('posted', `posted within ${profile.posted_within_days} days`);
  if (profile.ats.length) push('ats', `from ${profile.ats.join(' / ')}`);
  // The one chip raised by a field being *true* rather than by a list being
  // non-empty: the default already filters these out, so what is worth saying
  // out loud is that the default has been lifted.
  if (profile.include_unlisted) push('include_unlisted', 'including jobs no longer listed');
  if (profile.companies.length) push('companies', `${profile.companies.length} companies only`);
  if (profile.company_size.length) push('company_size', `company posts ${profile.company_size.join(' / ')} roles`);
  if (profile.sectors.length) push('sector', `company in ${profile.sectors.join(' / ')}`);
  if (profile.exclude_sectors.length) push('sector', `company not in ${profile.exclude_sectors.join(' / ')}`);
  if (profile.exclude_title_keywords.length) push('exclude_title_keywords', `${profile.exclude_title_keywords.length} title exclusions`);
  if (profile.exclude_description_keywords.length) push('exclude_description_keywords', `${profile.exclude_description_keywords.length} description exclusions`);
  if (profile.exclude_clearance) push('clearance', 'no security clearance');
  if (profile.exclude_visa_refusal) push('visa', 'not "we do not sponsor"');
  if (profile.requires_visa_sponsorship) push('visa', 'sponsors visas');
  if (profile.degree.length) push('degree', profile.degree.join(' / '));
  return active;
}
