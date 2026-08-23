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
 * Where the free-text search term was found, as a 0..1 factor.
 *
 * The FTS index has always had three columns — title, company, body — and the
 * search has always queried all three at once and thrown the answer into an
 * unordered Set, which discards the only interesting thing about a match: which
 * column it landed in. Someone typing a company name into a search box means
 * the company, and the ranking should say so out loud rather than leaving them
 * to scroll past a hundred other employers who merely name-drop it.
 *
 * A body-only hit is deliberately worth a token 0.05 rather than 0. It is still
 * evidence — "we use Palantir Foundry" is a real reason a posting surfaced for
 * `palantir` — just the weakest kind, and it should sort above the nothing that
 * a job matching on no column at all would score. Since every row in a text
 * search matches *somewhere*, the practical effect is a flat floor: it lifts the
 * whole result set equally and changes no relative order among body-only hits.
 */
const TEXT_FIELD_FACTOR = { company: 1, title: 0.6, body: 0.05 };

function textFactor(hit) {
  return hit ? (TEXT_FIELD_FACTOR[hit] ?? 0) : 0;
}

/**
 * How much the search term narrows the corpus, 0..1 — rare terms near 1, words
 * half the postings contain near 0.
 *
 * Without this the column weighting has a failure mode that is worse than the
 * problem it fixes. `palantir` matches 1,568 of 337,487 postings and names
 * exactly one employer, so a company hit should dominate. `design` matches
 * 121,669 and the company hit is `Design Bridge and Partners` — 63 agency jobs
 * that would sit above 2,969 postings with Design in the *title*, which is
 * plainly not what the reader meant. The two cases are indistinguishable by
 * column alone and obvious by frequency, which is the same observation bm25
 * makes and the reason this is a log ratio rather than a threshold.
 *
 * `RARE` is where the scale tops out: a term matching 100 postings or fewer out
 * of 337,487 is as specific as this needs to measure, and everything rarer
 * clamps to 1 rather than running off into precision nobody can perceive.
 */
const RARE = 100;

export function textSpecificity(matches, corpus) {
  if (!matches || !corpus || matches >= corpus) return 0;
  const span = Math.log(corpus / RARE);
  if (!(span > 0)) return 1;
  return Math.max(0, Math.min(1, Math.log(corpus / matches) / span));
}

/**
 * Score one job. `titleHits` and `descHits` come from the matcher so the terms
 * are counted exactly once, with the same word-boundary rules as the gate.
 *
 * `textHit` is the strongest column the free-text term matched on, or null when
 * the search box is empty — which is why this stays a no-op for every profile
 * that does not use it: no text, no factor, no contribution. `textSpec` scales
 * that boost by how rare the term is, so a company-name hit on `palantir` is
 * decisive and one on `design` is a nudge.
 */
export function scoreJob(job, profile, { titleHits = [], descHits = [], textHit = null, textSpec = 1 } = {}) {
  const w = profile.weights;
  const desc = Math.min(descHits.length, w.description_keyword_cap);

  const parts = {
    text: textFactor(textHit) * textSpec * (w.text_match ?? 0),
    title: titleHits.length * w.title_keyword,
    description: desc * w.description_keyword,
    recency: recencyFactor(job.age_days) * w.recency,
    salary: salaryFactor(job) * w.salary,
    years: yearsFitFactor(job, profile) * w.years_fit,
    quality: (job.quality ?? 0) * w.quality,
  };

  // Summed by name rather than through `Object.values`, which allocated a
  // seven-element array for every scored row — one per job on an unfiltered
  // search, and the ranking pass runs over every candidate the scan kept.
  const total =
    parts.text + parts.title + parts.description + parts.recency + parts.salary + parts.years + parts.quality;
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

/**
 * The full comparator for a named sort: the sort's own rule, then the score,
 * then `tiebreak`. Total — `tiebreak` ends on the job id, which is unique — so
 * there is exactly one correct order and "the best k rows" is unambiguous.
 */
function comparatorFor(sort) {
  const compare = SORTERS[sort] ?? SORTERS.relevance;
  return (a, b) => compare(a, b) || tiebreak(a, b);
}

/** Sort in place under one of `SORTS`. An unknown name falls back to the score. */
export function sortRows(rows, sort = 'relevance') {
  return rows.sort(comparatorFor(sort));
}

/**
 * The best `k` rows, in order — without putting the other 337,000 in order too.
 *
 * A page of results is 200 rows and the corpus is a third of a million, so an
 * unfiltered search was spending a third of its time sorting rows that no
 * request would ever read. This keeps a max-heap of the best `k` seen so far,
 * worst at the root, so the common case — a row that does not make the page —
 * costs exactly one comparison and no writes. `k >= rows.length` falls through
 * to the ordinary sort, which is both the correct answer and the faster one.
 *
 * The result is identical to `sortRows(rows, sort).slice(0, k)`, and identical
 * rather than merely equivalent: `comparatorFor` is a total order, so there is
 * no set of tied rows for the two to disagree about.
 */
export function topRows(rows, sort = 'relevance', k = Infinity) {
  const compare = comparatorFor(sort);
  if (!(k > 0)) return [];
  if (!Number.isFinite(k) || k >= rows.length) return rows.sort(compare);

  const heap = []; // a max-heap under `compare`: heap[0] is the worst kept row
  const siftUp = (i) => {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (compare(heap[i], heap[parent]) <= 0) break;
      const swap = heap[parent];
      heap[parent] = heap[i];
      heap[i] = swap;
      i = parent;
    }
  };
  const siftDown = (i) => {
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let worst = i;
      if (left < heap.length && compare(heap[left], heap[worst]) > 0) worst = left;
      if (right < heap.length && compare(heap[right], heap[worst]) > 0) worst = right;
      if (worst === i) break;
      const swap = heap[worst];
      heap[worst] = heap[i];
      heap[i] = swap;
      i = worst;
    }
  };

  for (const row of rows) {
    if (heap.length < k) {
      heap.push(row);
      siftUp(heap.length - 1);
    } else if (compare(row, heap[0]) < 0) {
      heap[0] = row;
      siftDown(0);
    }
  }
  return heap.sort(compare);
}
