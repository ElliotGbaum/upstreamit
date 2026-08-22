/**
 * Ranking.
 *
 * Filtering alone is not enough. Elliot's tight funnel — NYC, in person, ≤2
 * years, 12 role keywords — still returns 221 jobs plus 232 worth a second
 * look, and a looser profile returns thousands. A list that long is read from
 * the top or not at all, so the order is the product.
 *
 * Every component is a 0..1 factor multiplied by a weight from the profile, so
 * the weighting is data the user can change rather than a constant in the code.
 * `explain` returns the breakdown because a ranked list nobody can interrogate
 * is a ranked list nobody trusts.
 */

/**
 * Recency. Exponential rather than a cliff: a 3-day-old posting should beat a
 * 30-day-old one, and a 100-day-old one should still be visible if it is a
 * better match on everything else. Half-life ~62 days, which puts the 34% of
 * postings older than 90 days at under 0.37 of a fresh one.
 */
function recencyFactor(ageDays) {
  if (ageDays == null) return 0.3; // no date published — neither fresh nor stale
  return Math.exp(-ageDays / 90);
}

/**
 * Salary, as a tiebreaker only.
 *
 * Deliberately weak, and never a filter: 8% of 0–1 year jobs pay above the
 * median 6–8 year job, the 2 and 3 year buckets invert, and only 37.2% of jobs
 * publish anything at all. Jobs with no figure score a neutral 0.35 rather than
 * 0, so a silent posting is not pushed below a poorly-paid loud one.
 */
function salaryFactor(job) {
  if (!job.salary_known) return 0.35;
  const top = job.salary_max ?? job.salary_min;
  if (top == null) return 0.35;
  const FLOOR = 60_000;
  const CEILING = 250_000;
  return Math.max(0, Math.min(1, (top - FLOOR) / (CEILING - FLOOR)));
}

/**
 * Whether the stated experience actually lands inside what the profile asked
 * for. A confirmed fit outranks an unknown one; an unknown outranks nothing,
 * because the aside list is ranked too.
 */
function yearsFitFactor(job, profile) {
  const capped = profile.max_years_experience != null || profile.min_years_experience != null;
  if (!capped) return 0.5;
  if (job.years_known !== 1 || job.min_years == null) return 0.4;
  const underCap = profile.max_years_experience == null || job.min_years <= profile.max_years_experience;
  const overFloor =
    profile.min_years_experience == null || (job.max_years ?? job.min_years) >= profile.min_years_experience;
  return underCap && overFloor ? 1 : 0;
}

/**
 * Score one job. `titleHits` and `descHits` come from the matcher so the terms
 * are counted exactly once, with the same word-boundary rules as the gate.
 */
export function scoreJob(job, profile, { titleHits = [], descHits = [] } = {}) {
  const w = profile.weights;
  const desc = Math.min(descHits.length, w.description_keyword_cap);

  const parts = {
    title: titleHits.length * w.title_keyword,
    description: desc * w.description_keyword,
    recency: recencyFactor(job.age_days) * w.recency,
    salary: salaryFactor(job) * w.salary,
    years: yearsFitFactor(job, profile) * w.years_fit,
    quality: (job.quality ?? 0) * w.quality,
  };

  let total = 0;
  for (const value of Object.values(parts)) total += value;
  return { score: Math.round(total * 100) / 100, parts };
}

/**
 * The one thing about a result the row cannot already show — which of the
 * reader's description keywords the posting actually matched.
 *
 * Everything else `explain` used to say is a chip a few pixels above it. A row
 * whose chips read `$251k–$310k · 10+ yrs · today` and whose line underneath
 * read `posted this week · $251k–$310k · 10+ yrs` was spending its widest,
 * most-read line restating the row it sits under. The description keywords are
 * the exception, and the reason this line still exists: they are buried in text
 * nobody has opened yet, so naming them is the only way a reader learns why a
 * posting cleared their description filter without clicking into it.
 *
 * Which means an empty array is the normal case — no description criteria, no
 * line — and both renderers already draw nothing when it comes back empty. The
 * numeric breakdown behind the ordering is `score_parts`, in the `i` panel.
 *
 * Six hits, then stop. The cap is a line-length rule, not a scoring one: past
 * six the line wraps and stops being scannable down a list of 200.
 */
export function explain({ descHits = [] } = {}) {
  if (!descHits.length) return [];
  return [`description: ${descHits.slice(0, 6).join(', ')}`];
}

/**
 * `$85k–$125k`, and `$1.6m` once a figure passes a million.
 *
 * The millions case is not hypothetical or vanity: figures published in PHP,
 * INR, KRW and IDR annualise into seven digits legitimately, and `$1945k` is a
 * number a reader has to stop and parse. It only became visible when a "highest
 * pay" sort existed to put those rows at the top of a page.
 */
export function salaryLabel(job) {
  if (!job.salary_known) return null;
  const k = (n) => (n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}m` : `$${Math.round(n / 1000)}k`);
  if (job.salary_min != null && job.salary_max != null && job.salary_min !== job.salary_max)
    return `${k(job.salary_min)}–${k(job.salary_max)}`;
  return k(job.salary_max ?? job.salary_min);
}

/**
 * Sort in place, highest score first. Ties break on recency then id, so the
 * order is stable across runs — a list that reshuffles between two identical
 * queries reads as broken even when it is not.
 */
export function sortByScore(rows) {
  return rows.sort((a, b) => b.score - a.score || tiebreak(a, b));
}

/** Recency, then id. The last word in every ordering, so all of them are stable. */
function tiebreak(a, b) {
  return (
    (a.job.age_days ?? 9999) - (b.job.age_days ?? 9999) ||
    (a.job.id < b.job.id ? -1 : a.job.id > b.job.id ? 1 : 0)
  );
}

/**
 * Compare two numbers with **absent always last**, whichever direction the
 * sort runs.
 *
 * This is the whole reason a sort control is safe to ship here. 62.8% of the
 * corpus publishes no salary and some boards publish no date; a naive
 * descending sort puts NULLs wherever the comparator happens to drop them, and
 * a naive ascending sort puts all 38,412 silent postings at the top of a list
 * headed "lowest pay" — which is a lie about them, and in practice a filter,
 * because nobody scrolls past 38,412 rows. Sinking them to the bottom keeps
 * them in the list and out of the answer, which is the same three-valued rule
 * every criterion follows.
 */
function nullsLast(a, b, direction) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return direction === 'desc' ? b - a : a - b;
}

const salaryTop = (job) => (job.salary_known ? (job.salary_max ?? job.salary_min) : null);
const salaryBottom = (job) => (job.salary_known ? (job.salary_min ?? job.salary_max) : null);

/**
 * One comparator per `SORTS` entry.
 *
 * Every one of them falls through to the score and then to `tiebreak`, so a
 * sort never has to invent an order for rows it cannot tell apart — "newest
 * first" on twenty jobs posted the same day is still the best-match order
 * inside that day, which is more useful than an arbitrary one.
 */
const SORTERS = {
  relevance: (a, b) => b.score - a.score,
  newest: (a, b) => nullsLast(a.job.age_days, b.job.age_days, 'asc') || b.score - a.score,
  oldest: (a, b) => nullsLast(a.job.age_days, b.job.age_days, 'desc') || b.score - a.score,
  'salary-high': (a, b) => nullsLast(salaryTop(a.job), salaryTop(b.job), 'desc') || b.score - a.score,
  'salary-low': (a, b) => nullsLast(salaryBottom(a.job), salaryBottom(b.job), 'asc') || b.score - a.score,
  quality: (a, b) => nullsLast(a.job.quality, b.job.quality, 'desc') || b.score - a.score,
  company: (a, b) =>
    String(a.job.company_name ?? a.job.company_slug ?? '').localeCompare(
      String(b.job.company_name ?? b.job.company_slug ?? ''),
      'en',
      { sensitivity: 'base' },
    ) || b.score - a.score,
};

/** Sort in place under one of `SORTS`. An unknown name falls back to the score. */
export function sortRows(rows, sort = 'relevance') {
  const compare = SORTERS[sort] ?? SORTERS.relevance;
  return rows.sort((a, b) => compare(a, b) || tiebreak(a, b));
}
