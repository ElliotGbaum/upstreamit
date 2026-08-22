/**
 * The common job schema.
 *
 * Every ATS adapter maps its own payload onto this one shape, so the sweeper, the
 * derivation pass, the query engine and the UI never learn that Ashby exists.
 * Designed once against four known API shapes (Ashby, Greenhouse, Lever,
 * SmartRecruiters) rather than retrofitted from Ashby's.
 *
 * Layering rules, both load-bearing:
 *
 *  1. **Raw vs derived.** Adapters fill only `raw_*` / passthrough fields. The
 *     derivation pass (`src/lib/derive/`) fills every `d_*` column. Query filters
 *     touch `d_*` columns exclusively — that is what makes it safe to improve the
 *     metro alias table later and re-derive in seconds instead of re-sweeping
 *     hundreds of thousands of boards.
 *
 *  2. **Three-valued everywhere.** Any attribute that can be absent is stored as
 *     NULL, never coerced to a default. 59% of jobs have no salary and 15% no
 *     workplace type; a filter that silently drops NULL throws away most of the
 *     market without saying so. `*_known` flags make "we looked and there was
 *     nothing there" explicit and cheap to filter on.
 */

/** ATS keys this project knows how to sweep. Order is display order. */
export const ATS_KEYS = [
  'ashby',
  'greenhouse',
  'lever',
  'workday',
  'smartrecruiters',
  'workable',
  'recruitee',
  'breezy',
  'pinpoint',
  'jobvite',
  'teamtailor',
  'personio',
  'rippling',
  'bamboohr',
  'icims',
  'paylocity',
  'jazzhr',
  'polymer',
  'dover',
  'gem',
];

export const EMPLOYMENT_TYPES = [
  'FullTime',
  'PartTime',
  'Contract',
  'Temporary',
  'Intern',
  'Volunteer',
  'Unknown',
];

export const WORKPLACE_TYPES = ['onsite', 'hybrid', 'remote', 'unknown'];

/** Ordered low → high. Comparisons rely on the index. */
export const SENIORITY_LEVELS = [
  'intern',
  'entry',
  'junior',
  'mid',
  'senior',
  'staff',
  'principal',
  'manager',
  'director',
  'executive',
  'unknown',
];

/** Coarse function buckets. `other` is a real answer, not a failure. */
export const JOB_FUNCTIONS = [
  'engineering',
  'data',
  'design',
  'product',
  'sales',
  'marketing',
  'customer-success',
  'operations',
  'finance',
  'legal',
  'people',
  'research',
  'security',
  'it',
  'healthcare',
  'education',
  'science',
  'manufacturing',
  'construction',
  'logistics',
  'hospitality',
  'retail',
  'nonprofit',
  'government',
  'media',
  'other',
];

/**
 * How often the published figure is paid. Straight from `comp_interval`, which
 * the adapter normalizes out of the ATS's own spelling ("1 YEAR", "6 MONTH").
 *
 * `NONE` is a real answer and not a missing one: the board published a
 * compensation block and said the figure is not on a recurring interval. A job
 * that published no compensation at all has NULL here, which is the unknown
 * every filter over this column has to answer `unknown` for.
 *
 * Measured on the open corpus: YEAR 20,231 · HOUR 1,901 · MONTH 599 · WEEK 50 ·
 * NONE 16 · DAY 3 · HALF_YEAR 1 · nothing published 38,412.
 *
 * SEMI_MONTH and BIWEEK arrived with Lever, which is the only ATS here that
 * publishes them, on well under 1% of its jobs. Ordered by period length like
 * the rest, so the facet reads as a ladder rather than in discovery order.
 */
export const PAY_PERIODS = [
  'YEAR', 'HALF_YEAR', 'MONTH', 'SEMI_MONTH', 'BIWEEK', 'WEEK', 'DAY', 'HOUR', 'NONE',
];

/**
 * How far a remote role reaches. Only ever set on remote jobs — 16,869 of the
 * 17,508 open remote postings carry one — so an onsite job's blank here is not
 * an unknown, it is the workplace field already having answered.
 *
 * `timezone` has never once occurred in the corpus. It stays in the vocabulary
 * because the boards that state a timezone restriction state it in prose, and
 * the day a derive pass reads that prose the column is already the right shape.
 */
export const REMOTE_SCOPES = ['worldwide', 'country', 'region', 'timezone'];

/**
 * Company size, as open roles rather than headcount.
 *
 * We do not know how many people work anywhere — no ATS publishes it and we
 * sweep no enrichment source. What we do know exactly is how many open postings
 * each company has, and it is the proxy every size filter in the survey is
 * really standing in for: whether you are applying to a three-person team or to
 * a machine that opens 900 roles at once.
 *
 * Labelled as what it measures, deliberately. Otta and Levels.fyi label these
 * buckets "Seed / Early / Mid-size", which is a claim about a company's stage
 * that this number cannot support — a 40-person agency hiring hard and a
 * 4,000-person enterprise trickling roles out land in the same bucket.
 *
 * Measured: 1 → 318 companies · 2–5 → 1,168 · 6–20 → 1,607 · 21–100 → 589 ·
 * 101–500 → 79 · 500+ → 3.
 */
export const COMPANY_SIZE_BANDS = [
  { value: '1', label: '1 open role', min: 1, max: 1 },
  { value: '2-5', label: '2–5 open roles', min: 2, max: 5 },
  { value: '6-20', label: '6–20 open roles', min: 6, max: 20 },
  { value: '21-100', label: '21–100 open roles', min: 21, max: 100 },
  { value: '101-500', label: '101–500 open roles', min: 101, max: 500 },
  { value: '500+', label: 'over 500 open roles', min: 501, max: Infinity },
];

/** Which band a company's open-role count falls in. Never null: 0 is not a company. */
export function companySizeBand(openRoles) {
  for (const band of COMPANY_SIZE_BANDS) {
    if (openRoles >= band.min && openRoles <= band.max) return band.value;
  }
  return COMPANY_SIZE_BANDS[COMPANY_SIZE_BANDS.length - 1].value;
}

export const SCHEMA_VERSION = 5;

/**
 * DDL. Written as one string so a fresh database is a single `exec`.
 *
 * Storage split: hot columns live in `jobs` (scanned for facet counts on every
 * keystroke), cold blobs live in `job_content` (fetched only for the rows on
 * screen). Descriptions average ~5 KB; keeping them out of `jobs` is the
 * difference between a 40 MB table scan and a 1.5 GB one.
 */
export const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ---------------------------------------------------------------- companies --
CREATE TABLE IF NOT EXISTS companies (
  id             TEXT PRIMARY KEY,       -- "<ats>:<slug>"
  ats            TEXT NOT NULL,
  slug           TEXT NOT NULL,
  name           TEXT,                   -- display name when the ATS exposes one
  name_source    TEXT,                   -- api | derived | slug
  board_url      TEXT,
  website        TEXT,
  logo_url       TEXT,
  job_count      INTEGER NOT NULL DEFAULT 0,
  hq_location    TEXT,
  first_seen     INTEGER NOT NULL,
  last_seen      INTEGER NOT NULL,
  last_swept     INTEGER,
  last_etag      TEXT,
  status         TEXT NOT NULL DEFAULT 'live',  -- live | empty | dead | error
  discovery      TEXT,                   -- source list / 'mutation' / 'directory'
  UNIQUE (ats, slug)
);
CREATE INDEX IF NOT EXISTS idx_companies_ats     ON companies(ats);
CREATE INDEX IF NOT EXISTS idx_companies_status  ON companies(status);
CREATE INDEX IF NOT EXISTS idx_companies_name    ON companies(name COLLATE NOCASE);

-- --------------------------------------------------------------------- jobs --
CREATE TABLE IF NOT EXISTS jobs (
  id                TEXT PRIMARY KEY,    -- "<ats>:<slug>:<native id>"
  ats               TEXT NOT NULL,
  company_id        TEXT NOT NULL,
  company_slug      TEXT NOT NULL,
  company_name      TEXT,
  native_id         TEXT,

  title             TEXT NOT NULL,
  title_norm        TEXT NOT NULL,       -- lowercased, whitespace-collapsed; match target
  department        TEXT,
  team              TEXT,

  employment_type   TEXT,                -- EMPLOYMENT_TYPES, NULL when unstated
  location_raw      TEXT,                -- primary location string, verbatim
  locations_all     TEXT,                -- JSON array: primary + secondary + structured
  country           TEXT,
  region            TEXT,
  city              TEXT,
  postal_code       TEXT,

  -- Raw remote signals, passed through untouched. Ashby's isRemote is true for
  -- every Hybrid job, so both are kept and the derive pass decides which wins.
  raw_workplace     TEXT,                -- the ATS's own enum, verbatim
  raw_remote        INTEGER,             -- 1 | 0 | NULL, verbatim

  posted_at         INTEGER,             -- epoch ms
  source_updated_at INTEGER,             -- epoch ms; only some ATSes expose this
  first_seen        INTEGER NOT NULL,
  last_seen         INTEGER NOT NULL,
  is_open           INTEGER NOT NULL DEFAULT 1,
  content_hash      TEXT,                -- change detection where updatedAt is absent

  url               TEXT,
  apply_url         TEXT,

  -- raw compensation as published
  comp_min          REAL,
  comp_max          REAL,
  comp_currency     TEXT,
  comp_interval     TEXT,                -- YEAR | MONTH | WEEK | DAY | HOUR | NONE
  comp_text         TEXT,                -- prose tier summary when that is all there is
  has_equity        INTEGER,

  -- ------------------------------------------------------------- derived ----
  d_workplace       TEXT,                -- onsite | hybrid | remote | unknown
  d_workplace_src   TEXT,                -- which signal decided it (audit trail)
  d_remote_scope    TEXT,                -- worldwide | country | region | timezone | NULL
  d_metros          TEXT,                -- JSON array of canonical metro ids
  d_countries       TEXT,                -- JSON array of ISO-ish country ids
  d_salary_min      INTEGER,             -- annualised USD
  d_salary_max      INTEGER,
  d_salary_known    INTEGER NOT NULL DEFAULT 0,
  d_salary_src      TEXT,                -- as-stated | reinterpreted:X->Y | why not
  d_min_years       REAL,
  d_max_years       REAL,
  d_years_known     INTEGER NOT NULL DEFAULT 0,
  d_seniority       TEXT NOT NULL DEFAULT 'unknown',
  d_seniority_src   TEXT,
  d_job_function    TEXT NOT NULL DEFAULT 'other',
  d_skills          TEXT,                -- JSON array of detected skills/tech
  d_visa            INTEGER,             -- 1 sponsors | 0 explicitly not | NULL unstated
  d_clearance       INTEGER,             -- 1 requires security clearance
  d_degree          TEXT,                -- none | bachelors | masters | phd | NULL
  d_age_days        INTEGER,             -- recomputed at derive time; cheap to filter
  d_quality         REAL,                -- 0..1 listing-completeness score
  d_derived_at      INTEGER,

  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_jobs_open        ON jobs(is_open);
CREATE INDEX IF NOT EXISTS idx_jobs_ats         ON jobs(ats, is_open);
CREATE INDEX IF NOT EXISTS idx_jobs_company     ON jobs(company_id);
CREATE INDEX IF NOT EXISTS idx_jobs_posted      ON jobs(posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_seniority   ON jobs(d_seniority);
CREATE INDEX IF NOT EXISTS idx_jobs_workplace   ON jobs(d_workplace);
CREATE INDEX IF NOT EXISTS idx_jobs_function    ON jobs(d_job_function);
CREATE INDEX IF NOT EXISTS idx_jobs_salary      ON jobs(d_salary_max);
CREATE INDEX IF NOT EXISTS idx_jobs_years       ON jobs(d_min_years);
CREATE INDEX IF NOT EXISTS idx_jobs_first_seen  ON jobs(first_seen DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_title_norm  ON jobs(title_norm);

-- Cold storage: descriptions. Split out so facet scans never touch them.
CREATE TABLE IF NOT EXISTS job_content (
  job_id           TEXT PRIMARY KEY,
  description_text TEXT,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

-- Many-to-many so metro facet counts are an index seek, not a JSON scan.
-- A job legitimately belongs to several metros (Ashby secondaryLocations).
CREATE TABLE IF NOT EXISTS job_metros (
  job_id TEXT NOT NULL,
  metro  TEXT NOT NULL,
  PRIMARY KEY (job_id, metro),
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_job_metros_metro ON job_metros(metro);

CREATE TABLE IF NOT EXISTS job_skills (
  job_id TEXT NOT NULL,
  skill  TEXT NOT NULL,
  PRIMARY KEY (job_id, skill),
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_job_skills_skill ON job_skills(skill);

-- Full-text over title + company + description. Contentless-external so the text
-- is not stored twice; rebuilt by the derive pass rather than by triggers, since
-- bulk sweeps insert far faster without per-row trigger overhead.
CREATE VIRTUAL TABLE IF NOT EXISTS jobs_fts USING fts5(
  title,
  company,
  body,
  content = '',
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TABLE IF NOT EXISTS jobs_fts_map (
  rowid  INTEGER PRIMARY KEY,
  job_id TEXT UNIQUE NOT NULL
);

-- ------------------------------------------------------------- discovery ----
-- Every slug ever tried, with its verdict, so mutation never re-probes a known
-- dead string and the hit rate of each generation strategy stays measurable.
CREATE TABLE IF NOT EXISTS slug_attempts (
  ats        TEXT NOT NULL,
  slug       TEXT NOT NULL,
  status     INTEGER,                 -- HTTP status of the probe
  verdict    TEXT NOT NULL,           -- live | dead | error
  strategy   TEXT,                    -- how the candidate was generated
  seed       TEXT,                    -- what it was generated from
  rank       INTEGER,                 -- 1..10 within its seed's guess list
  tried_at   INTEGER NOT NULL,
  PRIMARY KEY (ats, slug)
);
CREATE INDEX IF NOT EXISTS idx_attempts_verdict  ON slug_attempts(ats, verdict);
CREATE INDEX IF NOT EXISTS idx_attempts_strategy ON slug_attempts(strategy, verdict);

-- Canonical metro registry, built from observed location strings, not guessed.
CREATE TABLE IF NOT EXISTS metros (
  id        TEXT PRIMARY KEY,        -- "nyc"
  label     TEXT NOT NULL,           -- "New York City"
  country   TEXT,
  region    TEXT,
  lat       REAL,
  lon       REAL,
  job_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS metro_aliases (
  alias    TEXT PRIMARY KEY,         -- lowercased raw fragment
  metro_id TEXT NOT NULL,
  FOREIGN KEY (metro_id) REFERENCES metros(id) ON DELETE CASCADE
);

-- ----------------------------------------------------------------- history --
-- One row per job per sweep-day it appeared. Powers "new since yesterday" and
-- "this has been open 6 months", which mean very different things to an applicant.
CREATE TABLE IF NOT EXISTS job_events (
  job_id TEXT NOT NULL,
  day    TEXT NOT NULL,              -- YYYY-MM-DD
  event  TEXT NOT NULL,              -- appeared | changed | disappeared | reappeared
  PRIMARY KEY (job_id, day, event)
);
CREATE INDEX IF NOT EXISTS idx_job_events_day ON job_events(day, event);

CREATE TABLE IF NOT EXISTS sweeps (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ats        TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,
  boards     INTEGER DEFAULT 0,
  jobs_seen  INTEGER DEFAULT 0,
  jobs_new   INTEGER DEFAULT 0,
  jobs_gone  INTEGER DEFAULT 0,
  errors     INTEGER DEFAULT 0,
  bytes      INTEGER DEFAULT 0
);
`;

/** A blank job record — every adapter starts from this so no column is forgotten. */
export function blankJob() {
  return {
    id: null,
    ats: null,
    company_id: null,
    company_slug: null,
    company_name: null,
    native_id: null,
    title: null,
    title_norm: null,
    department: null,
    team: null,
    employment_type: null,
    location_raw: null,
    locations_all: [],
    country: null,
    region: null,
    city: null,
    postal_code: null,
    raw_workplace: null,
    raw_remote: null,
    posted_at: null,
    source_updated_at: null,
    url: null,
    apply_url: null,
    comp_min: null,
    comp_max: null,
    comp_currency: null,
    comp_interval: null,
    comp_text: null,
    has_equity: null,
    description_text: null,
  };
}

/** Whitespace-collapse + lowercase. The single normalization every matcher uses. */
export function normText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Stable, collision-free job id across ATSes. */
export function jobId(ats, slug, nativeId) {
  return `${ats}:${slug}:${nativeId}`;
}

export function companyId(ats, slug) {
  return `${ats}:${slug}`;
}
