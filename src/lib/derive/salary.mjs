/**
 * Compensation → annualised USD.
 *
 * Two things make this less mechanical than it looks.
 *
 * **The interval field lies.** 154 rows carry `interval = YEAR` with a value
 * under $1,000 — `$30.00–$50.00 YEAR` on a Senior Quality Inspector is an hourly
 * rate mislabelled at the source, and 54 more exceed $1M/yr. Multiplying those
 * by 1 and storing them would put a $62k/yr job in the "under $1k" bucket and a
 * rupee figure at $310M. So every result is checked for plausibility and, if it
 * fails, reinterpreted under the interval that makes it sane. If nothing does,
 * the job is `salary_known = 0` — "we looked and could not tell" — rather than
 * carrying a confidently wrong number into a filter.
 *
 * **Rates are static, and that is fine.** 86.5% of the jobs that publish a
 * figure publish it in USD; FX touches 13.5% of 37%, or ~5% of the board. A 10%
 * drift moves a €120k listing by €12k, which does not change whether it clears
 * a $100k floor. Refreshing these is a maintenance task, not a correctness one.
 */

/** Approximate mid-market rates, captured 2026-08. One unit -> USD. */
export const FX_AS_OF = '2026-08';
export const FX = {
  USD: 1, EUR: 1.09, GBP: 1.27, CAD: 0.73, AUD: 0.66, NZD: 0.61, CHF: 1.13,
  SEK: 0.095, NOK: 0.094, DKK: 0.146, PLN: 0.25, CZK: 0.043, HUF: 0.0028,
  RON: 0.22, BGN: 0.56, UAH: 0.024, TRY: 0.030, ILS: 0.27, AED: 0.27,
  SAR: 0.27, INR: 0.012, SGD: 0.74, HKD: 0.128, JPY: 0.0067, KRW: 0.00073,
  CNY: 0.14, TWD: 0.031, MYR: 0.22, IDR: 0.000062, THB: 0.028, PHP: 0.017,
  VND: 0.000039, BRL: 0.18, MXN: 0.050, ARS: 0.0011, CLP: 0.0011, COP: 0.00025,
  PEN: 0.27, UYU: 0.025, ZAR: 0.055, NGN: 0.00065, KES: 0.0077, EGP: 0.021,
  MAD: 0.10, RSD: 0.0093, HRK: 0.145, ISK: 0.0073, GEL: 0.37, AMD: 0.0026,
  KZT: 0.0021, MDL: 0.056, BAM: 0.56, MKD: 0.018, ALL: 0.011,
};

/**
 * Hours/periods per year. `NONE` is Ashby's "there is no usable figure here".
 *
 * BIWEEK and SEMI_MONTH are here for Lever, which publishes `bi-week-salary` and
 * `semi-month-salary` on 8 of 8,697 jobs. They are reachable only as a *stated*
 * interval — the fallback order below deliberately does not try them, so nothing
 * on any other ATS changes — and they exist because rare is not the same as safe
 * to get wrong: with no factor, a $3,000 fortnightly figure reads as implausible
 * under every interval the loop does try except MONTH, and the job would be
 * filed at $36k instead of $78k.
 */
const PER_YEAR = {
  YEAR: 1, HALF_YEAR: 2, QUARTER: 4, MONTH: 12, SEMI_MONTH: 24,
  BIWEEK: 26, WEEK: 52, DAY: 260, HOUR: 2080,
};

/** An annual salary a human could plausibly be paid, in USD. */
const FLOOR = 5_000;
const CEILING = 2_000_000;

const plausible = (usd) => usd != null && usd >= FLOOR && usd <= CEILING;

/**
 * Is the *whole* published range readable under one interval?
 *
 * Testing only one end is how `$200.00–$400000.00 YEAR` produced a salary of
 * $832,000,000. The min alone reads as an hourly rate — $200/hr is $416k/yr and
 * perfectly plausible — so the row was reinterpreted as hourly and the max went
 * with it, at 2,080 hours a year. 59 open postings carried a figure over $2M
 * for exactly this reason, and every one of them sat at the top of any list
 * ordered by pay.
 *
 * A range is only readable when both ends land in the plausible band under the
 * same interval and the bottom is not above the top. When no interval satisfies
 * all of that, the honest answer is the one this file already gives everywhere
 * else: `salary_known = 0`, we looked and could not tell.
 */
function readable(lo, hi) {
  if (lo != null && !plausible(lo)) return false;
  if (hi != null && !plausible(hi)) return false;
  if (lo != null && hi != null && lo > hi) return false;
  return lo != null || hi != null;
}

export function deriveSalary(job) {
  const min = num(job.comp_min);
  const max = num(job.comp_max);
  if (min == null && max == null) return blank('no-figure');

  const currency = (job.comp_currency || 'USD').toUpperCase();
  const rate = FX[currency];
  if (!rate) return blank(`unknown-currency:${currency}`);

  const stated = (job.comp_interval || '').toUpperCase();
  const anchor = min ?? max; // for the error message when nothing reads

  // Try the stated interval first, then every other one, cheapest lie first:
  // an hourly rate mislabelled YEAR is far commoner than the reverse.
  const order = [stated, 'HOUR', 'YEAR', 'MONTH', 'DAY', 'WEEK', 'HALF_YEAR', 'QUARTER'];
  for (const interval of order) {
    const factor = PER_YEAR[interval];
    if (!factor) continue;
    const lo = min == null ? null : min * rate * factor;
    const hi = max == null ? null : max * rate * factor;
    if (!readable(lo, hi)) continue;
    const src = interval === stated ? 'as-stated' : `reinterpreted:${stated || 'none'}->${interval}`;
    return {
      salary_min: lo == null ? null : Math.round(lo),
      salary_max: hi == null ? null : Math.round(hi),
      salary_known: 1,
      salary_src: src,
      currency,
    };
  }

  return blank(`implausible:${stated || 'none'}:${anchor}${currency}`);
}

function blank(src) {
  return { salary_min: null, salary_max: null, salary_known: 0, salary_src: src, currency: null };
}

function num(value) {
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
