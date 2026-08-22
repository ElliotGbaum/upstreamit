/**
 * Seniority. No ATS publishes it, so it is inferred.
 *
 * Order of operations, chosen by measured yield rather than taste:
 *
 *   1. **Title rule-out.** `Senior` / `Staff` / `Principal` / `Lead` / `Director`
 *      / `Intern` are decisive when present — but 42.9% of titles carry no
 *      seniority word at all, so this cannot be the only rule. "Software
 *      Engineer" is both the entry-level title and the eight-year title.
 *   2. **Years extracted from the description.** Parseable on 59% of postings and
 *      the single best signal. Needs a context guard or it reads "the last 15
 *      years building great products" out of company boilerplate.
 *   3. **Entry-ish title words** as the fallback (`Intern`, `Junior`, `New Grad`,
 *      `Associate`, `I`/`II` suffixes).
 *
 * Together these classify ~85%. The remaining ~15% stay `unknown`, which is a
 * third state and never a silent drop — the whole point of `d_years_known`.
 *
 * Explicit phrases were tested and are near-worthless: "entry level" appears in
 * 0.2% of descriptions, "new grad" 0.3%, "no experience required" 0.0%.
 * Salary is a real but unusable proxy — 8% of 0–1 year jobs pay above the median
 * 6–8 year job — so it is a tiebreaker at ranking time, never a classifier.
 */

import { fold, foldLines, NUMBER_WORD_ALT, parseNumber } from './text.mjs';

/** Decisive title markers, checked in this order — `Senior Staff` is staff. */
const TITLE_RULES = [
  { level: 'intern', re: /\b(?:intern|internship|co-?op|trainee|apprentice|working student|werkstudent|praktikum)\b/ },
  { level: 'executive', re: /\b(?:chief|c[teofm]o|cxo|founder|co-?founder|partner|general manager|gm|svp|evp|senior vice president|executive vice president)\b/ },
  { level: 'director', re: /\b(?:director|head of|vp|vice president)\b/ },
  { level: 'manager', re: /\b(?:manager|mgr|supervisor|team lead(?:er)?|people lead)\b/ },
  // `architect` is deliberately absent. It reads as principal-level in
  // engineering but `Solutions Architect` is an ordinary mid-level GTM title —
  // 538 such postings here carry no other seniority word, and calling them
  // principal would hide the exact roles a solutions-profile search wants.
  // `Principal Architect` still matches on `principal`.
  { level: 'principal', re: /\b(?:principal|distinguished|fellow)\b/ },
  { level: 'staff', re: /\b(?:staff|senior staff)\b/ },
  // Bare `Lead` — `Lead Engineer`, `Lead Designer` — is an IC-or-team-lead
  // ambiguity that no title convention settles. It lands in `senior` because
  // the only thing the filter needs from it is decisive: it is not entry level.
  { level: 'senior', re: /\b(?:senior|snr|sr\.?|lead|experienced|expert)\b/ },
  { level: 'entry', re: /\b(?:junior|jr\.?|entry[- ]level|new grad(?:uate)?|graduate|associate|assistant)\b/ },
];

/**
 * Roman-numeral and digit levels only count as seniority when they are a
 * trailing rank, not part of a name: `Engineer II` yes, `Type 2 Diabetes
 * Specialist` and `Series A` no. Checked separately so the broad alternations
 * above stay readable.
 */
const RANK_SUFFIX = /\b(?:level\s*)?(i{1,3}|iv|v|[1-5])\b\s*$/;
const RANK_LEVEL = { i: 'entry', '1': 'entry', ii: 'entry', '2': 'entry', iii: 'senior', '3': 'senior', iv: 'senior', '4': 'senior', v: 'staff', '5': 'staff' };

/** `Manager` inside these phrases is the job's subject, not its rank. */
const FALSE_MANAGER = /\b(?:account manager|customer success manager|product manager|program manager|project manager|partner manager|community manager|social media manager|content manager|category manager|brand manager|marketing manager|campaign manager|portfolio manager|relationship manager|success manager|engagement manager|implementation manager|deployment manager|office manager|case manager|asset manager|fund manager)\b/;

export function seniorityFromTitle(title) {
  const t = fold(title);
  if (!t) return null;

  for (const rule of TITLE_RULES) {
    if (!rule.re.test(t)) continue;
    if (rule.level === 'manager' && FALSE_MANAGER.test(t)) continue;
    return { level: rule.level, src: `title:${rule.level}` };
  }

  const rank = t.match(RANK_SUFFIX);
  if (rank) {
    const level = RANK_LEVEL[rank[1]];
    if (level) return { level, src: `title:rank-${rank[1]}` };
  }
  return null;
}

/**
 * Years-of-experience patterns, all seen in real postings:
 *   `5+ years`  `3–7+ years`  `3 - 5+ years`  `at least 2 years`
 *   `minimum of 5 years`  `2 to 4 years`  `two years`  `5 yrs`  `5+ YOE`
 */
const YEARS_RE = new RegExp(
  String.raw`(?:^|[^a-z0-9])` +
    String.raw`(?:(?:at least|minimum(?: of)?|min\.?|over|more than|upwards of|>=?)\s*)?` +
    String.raw`(\d{1,2}(?:\.\d)?|${NUMBER_WORD_ALT})` +
    String.raw`\s*(?:\+\s*)?` +
    String.raw`(?:(?:-|to|–|—|or)\s*(\d{1,2})\s*(?:\+\s*)?)?` +
    String.raw`(?:\+\s*)?` +
    String.raw`(?:years?|yrs?\.?|yoe)\b`,
  'gi',
);

/** The match only counts as a requirement if one of these sits near it. */
const CONTEXT_RE = /experien|background|professional|track record|hands[- ]on|working (?:in|with|as)|in the (?:industry|field|space)|expertise|practicing|practice|building|career|history of|proven|relevant|minimum|required|requirement|qualification/;

/** Kills company boilerplate: "for the last 15 years we have…", "20 years in business". */
const ANTI_CONTEXT = /\b(?:founded|since|for (?:the )?(?:last|past)|over the (?:last|past)|in business|anniversary|history|company|we have been|has been|our \w+ of|celebrating)\b/;

/**
 * What the number counts, when it is not experience.
 *
 * Checked on the text immediately after the match, so it is about the noun the
 * figure attaches to rather than the paragraph it sits in. This is not a
 * refinement — without it the corpus contains 3,315 jobs whose experience
 * requirement is read off an *age* requirement, because "must be 18 years of
 * age" is filed under a heading called `Minimum Qualifications` and both
 * `minimum` and `qualification` are trusted by `CONTEXT_RE`. The result is an
 * hourly retail job labelled `staff` at 21 years, and 721 of them are ≤2-year
 * jobs that a years cap then excludes — the failure is silent and it runs
 * against the exact roles an entry-level search is for.
 *
 * `of employment` and `of service` are tenure: "after 5 years of service" is a
 * sabbatical in the benefits list, never a requirement.
 */
const NOT_EXPERIENCE =
  /^['’]?\s*(?:of age\b|(?:or|and)\s+(?:older|above|over|up)\b|older\b|old\b|of (?:continuous )?service\b|continuous service\b|of employment\b|ago\b|in a row\b|running\b)/;

/**
 * The company's age, not the candidate's experience.
 *
 * `ANTI_CONTEXT` catches the past-tense forms — "for the last 15 years we have"
 * — and misses the present-tense boast, which is the one every "About us"
 * paragraph is written in: "with over 40 years of experience", "a cybersecurity
 * forerunner with more than 30 years", "proven success: nearly 20 years serving
 * local communities". `experience` sits right there in the sentence, so
 * `CONTEXT_RE` trusts it and the strictest-wins collapse then prefers it over
 * whatever the posting actually asked for. 1,718 jobs read their requirement
 * off one of these.
 *
 * Tested against the words immediately before the figure, never the paragraph:
 * `with` and `for` on their own precede real requirements ("field experience
 * for at least 4 years") and only the qualified forms are decisive. `up to N
 * years` is deliberately absent — "up to 2 years of relevant work experience"
 * is a real ceiling on a real entry-level job, which is exactly the row a years
 * cap exists to find.
 *
 * Measured over 215 distinct phrasings, one is a genuine requirement — "MD or
 * DO with more than 2 years", 9 jobs. Those fall to `unknown`, which is a third
 * state and never a silent drop, so they stay in the results either way.
 */
const COMPANY_TENURE =
  /(?:\b(?:with|for)\s+(?:over|more than|upwards of|nearly|almost)|\b(?:backed by|legacy of|tenure of|(?:build(?:ing)?|built) (?:on|upon|from))(?:\s+(?:over|more than|upwards of|nearly|almost))?|\b(?:nearly|almost|every)|\bin (?:just|under|less than|only))$/;

/**
 * A claim that begins its own line is a requirement bullet.
 *
 * `CONTEXT_RE` is a vocabulary check, and a vocabulary can only ever list the
 * ways people have already been observed to write it. The Pallet posting that
 * exposed this says `6+ years in customer-facing roles` under a heading called
 * `What You'll Bring` — no `experience`, no `required`, nothing on the list, so
 * the figure was found and then discarded and the job read as `? experience` to
 * someone filtering for two years or less.
 *
 * Layout answers what vocabulary cannot. A number at the head of a bullet is
 * the posting's own statement that this is a requirement, whatever nouns
 * follow it, and it is evidence `fold` used to throw away before anything could
 * look at it. Measured over the corpus it recovers 7,774 jobs that state their
 * requirement plainly and currently show nothing — 2,747 of them Ashby, which
 * is what settles that this was never a Greenhouse-specific defect — and
 * corrects 925 more where a smaller surviving figure was winning `collapseYears`
 * because the larger one had been dropped.
 *
 * Precision holds because `NOT_EXPERIENCE` runs first: about a fifth of the
 * lines this would otherwise admit are `18 years of age`.
 */
const BULLET_PREFIX = /^[\s>*•‣▪●◦⁃∙·o-]*$/;

/**
 * Every credible "N years of experience" claim in a description.
 * @returns {Array<{min:number,max:number|null,index:number}>}
 */
export function extractYears(description) {
  // Line breaks are load-bearing here — see `BULLET_PREFIX`. Everything else
  // about this text is what `fold` would have produced.
  const text = foldLines(description);
  if (!text) return [];
  const out = [];
  YEARS_RE.lastIndex = 0;
  let match;
  while ((match = YEARS_RE.exec(text)) !== null) {
    const min = parseNumber(match[1]);
    const max = parseNumber(match[2]);
    if (min == null || min > 40) continue;

    // Window around the match: enough to catch "of experience" trailing it and
    // "we have been building for" leading it, without spanning a paragraph.
    const before = text.slice(Math.max(0, match.index - 60), match.index);
    const after = text.slice(match.index, match.index + match[0].length + 70);
    if (ANTI_CONTEXT.test(before)) continue;

    // What the figure counts, before what surrounds it. An age is not an
    // experience requirement however qualified the heading above it was.
    if (NOT_EXPERIENCE.test(after.slice(match[0].length))) continue;

    // `YEARS_RE` swallows `over` and `more than`, so the qualifier is put back
    // before the prefix is judged: `with` alone is ambiguous, `with over` is not.
    const qualified = /(?:^|[^a-z])(?:over|more than|upwards of)\s/.test(match[0]);
    const lead = before.trimEnd();
    if (COMPANY_TENURE.test(qualified ? `${lead} over` : lead)) continue;

    // `(?:^|[^a-z0-9])` ate one separator, so the figure itself starts one
    // character in unless the match is at the very start of the description.
    const numberAt = match.index === 0 ? 0 : match.index + 1;
    const lineAt = text.lastIndexOf('\n', numberAt - 1) + 1;
    const startsLine = BULLET_PREFIX.test(text.slice(lineAt, numberAt));

    if (!startsLine && !CONTEXT_RE.test(after) && !CONTEXT_RE.test(before)) continue;

    out.push({ min, max: max != null && max >= min ? max : null, index: match.index });
  }
  return out;
}

/**
 * Collapse the claims into one requirement.
 *
 * **Strictest wins.** A posting saying "5+ years in sales" and "1+ year with
 * Salesforce" is a five-year job; taking the smallest would file it under entry
 * level and put a senior role in front of someone filtering for ≤2 years. The
 * inclusive reading is the wrong default here because the cost is asymmetric —
 * a missed junior job is invisible, a flood of senior ones makes the list
 * useless. Measured over an 8,744-job slice of the real corpus: 15.8% of
 * postings state more than one figure, those disagree 82.5% of the time, and
 * the median gap is 3 years. Choosing strict moves 267 jobs out of the "≤2
 * years" bucket — 23% of everything the lenient rule would have put there.
 */
export function collapseYears(claims) {
  if (!claims.length) return { min: null, max: null, known: 0 };
  const strictest = claims.reduce((a, b) => (b.min > a.min ? b : a));
  return { min: strictest.min, max: strictest.max, known: 1 };
}

/** Years -> band. Boundaries follow the measured distribution, not round numbers. */
export function seniorityFromYears(min) {
  if (min == null) return null;
  if (min <= 1) return 'entry';
  if (min <= 2) return 'junior';
  if (min <= 5) return 'mid';
  if (min <= 8) return 'senior';
  return 'staff';
}

export function deriveSeniority(job, description) {
  const claims = extractYears(description);
  const years = collapseYears(claims);

  const byTitle = seniorityFromTitle(job.title);
  if (byTitle) return { ...years, seniority: byTitle.level, src: byTitle.src };

  const byYears = seniorityFromYears(years.min);
  if (byYears) return { ...years, seniority: byYears, src: `years:${years.min}` };

  return { ...years, seniority: 'unknown', src: 'no-signal' };
}
