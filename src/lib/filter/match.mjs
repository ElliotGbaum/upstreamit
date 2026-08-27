/**
 * Criteria evaluation — the part of the filter that has opinions.
 *
 * Every criterion is a pure function of one job row and one profile, and every
 * one of them returns **three** values, not two:
 *
 *   `'match'`    the job satisfies it
 *   `'no'`       the job contradicts it — we know, and the answer is no
 *   `'unknown'`  the data does not say
 *
 * That third value is the whole design. 24.9% of jobs have no seniority signal,
 * 62.8% publish no salary, 15.9% have no location we could place. A boolean
 * predicate folds those into `'no'` and hides most of the market; here the
 * profile's `unknowns` policy decides what happens to them, per criterion, and
 * the UI shows the choice.
 *
 * No database and no I/O in this file — that is what makes the whole filter
 * testable in milliseconds against fixture rows, the same way the derivations
 * are.
 */

import { fold, termPattern, termRegex } from '../derive/text.mjs';
import { allowedSeniority } from './profile.mjs';

const MATCH = 'match';
const NO = 'no';
const UNKNOWN = 'unknown';

/**
 * Compile a keyword list once per query rather than once per job.
 *
 * `hasTerm` builds a RegExp on every call, which is fine for the derive pass
 * (one call per job per rule) and not fine here (13 keywords × 61k titles =
 * 800k compilations, measured at 336 ms versus 40 ms cached — and the corpus is
 * several times that size now).
 */
export function compileTerms(terms) {
  return [...new Set((terms ?? []).map((t) => fold(t)).filter(Boolean))].map((term) => ({
    term,
    re: new RegExp(termPattern(term)),
  }));
}

/**
 * One regex that matches if *any* of `terms` does.
 *
 * A cheap gate in front of `hits`. The title pass runs over every open job in
 * the corpus, so a twelve-keyword profile was twelve regex passes over 337,487
 * titles to answer a question that is `no` for four titles in five. One
 * alternation answers it in a single pass, and the per-term loop only runs for
 * the rows that survived — which is also the only place the *matched terms*
 * are needed, because ranking is by how many distinct keywords hit.
 *
 * Not `g`: a global regex carries `lastIndex` between `.test()` calls and would
 * skip rows at random.
 */
export function anyTerm(terms) {
  return termRegex(terms ?? [], '');
}

/** Which compiled terms hit this already-folded text, in list order. */
export function hits(foldedText, compiled) {
  if (!foldedText || !compiled.length) return [];
  const out = [];
  for (const { term, re } of compiled) if (re.test(foldedText)) out.push(term);
  return out;
}

/**
 * Everything a query needs precomputed once: compiled keyword lists, the
 * seniority allow-list, and lookup sets for the enum criteria.
 *
 * `index` carries the two id sets the description gate needs, because that one
 * criterion cannot be answered from a hot column — the prose lives in SQLite and
 * the gate is an FTS5 query over it. `search()` supplies them; a caller that
 * doesn't leaves the gate inactive rather than guessing (see `matchDescription`).
 */
export function compileProfile(profile, index = {}) {
  const c = {
    descriptionIds: index.descriptionIds ?? null,
    missingDescriptions: index.missingDescriptions ?? null,
    title: compileTerms(profile.title_keywords),
    description: compileTerms(profile.description_keywords),
    excludeTitle: compileTerms(profile.exclude_title_keywords),
    // The same two lists as one alternation each, for the title gate's
    // prefilter. Built here so they are compiled once per query, not per job.
    titleAny: anyTerm(profile.title_keywords),
    excludeTitleAny: anyTerm(profile.exclude_title_keywords),
    excludeDescription: compileTerms(profile.exclude_description_keywords),
    seniority: allowedSeniority(profile),
    metros: new Set(profile.metros),
    countries: new Set(profile.countries),
    workplace: new Set(profile.workplace),
    employmentType: new Set(profile.employment_type),
    job_functions: new Set(profile.job_functions),
    skills: new Set(profile.skills),
    excludeSkills: new Set(profile.exclude_skills),
    degree: new Set(profile.degree),
    remoteScope: new Set(profile.remote_scope),
    payPeriod: new Set(profile.pay_period),
    currencies: new Set(profile.currencies),
    companySize: new Set(profile.company_size),
    sectors: new Set(profile.sectors),
    excludeSectors: new Set(profile.exclude_sectors),
    companies: new Set(profile.companies.map((c) => c.toLowerCase())),
    ats: new Set(profile.ats),
  };

  // The criteria this profile actually asked about, decided once here rather
  // than re-decided inside every match function 337,000 times. See `CRITERIA`.
  //
  // Deferred to the bottom because each `asked` reads the compiled sets above
  // it — and it has to be non-enumerable-by-accident-proof only in the sense
  // that nothing downstream iterates `c`; every reader names its field.
  c.active = CRITERIA.filter((criterion) => criterion.asked(profile, c));
  c.activeKeys = c.active.map((criterion) => criterion.key);
  return c;
}

// ---------------------------------------------------------------- criteria --

/**
 * Place. A job is in a metro when the derive pass put it there — `job_metros`
 * unions the primary location string, `secondaryLocations` and the structured
 * address, because the primary string alone finds only 64% of a metro's jobs.
 *
 * Remote roles have a country and a scope but no metro, so a metro filter
 * excludes them by construction. `remote_counts_as_match` is the flag that
 * changes that, and it is a flag rather than a default because "remote — US"
 * and "in an office in New York" are answers to different questions.
 */
export function matchMetro(job, profile, c) {
  if (!c.metros.size && !c.countries.size) return MATCH;

  if (profile.remote_counts_as_match && job.workplace === 'remote') {
    if (!c.countries.size) return MATCH;
    if (!job.countries.length) return UNKNOWN;
    return job.countries.some((x) => c.countries.has(x)) ? MATCH : NO;
  }

  if (c.metros.size) {
    if (job.metros.some((m) => c.metros.has(m))) return MATCH;
    // No metro at all is genuinely unknown. A metro that simply isn't the one
    // asked for is a confident no.
    if (!job.metros.length) return c.countries.size ? checkCountry(job, c) : UNKNOWN;
    if (!c.countries.size) return NO;
  }
  return checkCountry(job, c);
}

function checkCountry(job, c) {
  if (!c.countries.size) return NO;
  if (!job.countries.length) return UNKNOWN;
  return job.countries.some((x) => c.countries.has(x)) ? MATCH : NO;
}

/**
 * Onsite / hybrid / remote, from `workplaceType` — never from `isRemote`, which
 * is `true` on every one of Ashby's 15,932 hybrid jobs and carries no
 * information the enum lacks.
 *
 * ## The guessed half of this column
 *
 * 174,537 of 337,487 jobs carry no enum and were called `onsite` by
 * `deriveWorkplace`'s last rule — a named office, no remote marker. 165,962 of
 * them are Greenhouse, which publishes no workplace field at all; Lever, which
 * publishes one on 98.0% of its jobs, contributes 1,316. That guess is
 * sound on one axis and blind on the other:
 *
 *   is it remote?      answered. The posting names a place and never says
 *                      remote, the same evidence `matchRemoteScope` leans on.
 *   onsite or hybrid?  **not answered, and not answerable.** 0.5% of Greenhouse
 *                      location strings say "hybrid" against 26% of the Ashby
 *                      corpus being explicitly Hybrid — so a hybrid Greenhouse
 *                      job is not rare here, it is invisible, indistinguishable
 *                      from a five-day office job.
 *
 * So a guess answers `unknown` to the hybrid question instead of `no`. Before
 * this, ticking Hybrid returned zero of the 204,485 Greenhouse jobs with no
 * warning anywhere on the page — a filter ruling jobs out on a blank field,
 * which is the one thing this engine may not do. They now come back tagged
 * `? workplace` and the policy control can still drop them in one click.
 *
 * Ticking Onsite still matches a guess outright: it is the best available
 * reading, it is what the row already displays, and a hybrid job surfaced by an
 * onsite search is a job at an office you asked about — a far cheaper error
 * than the silent deletion above. A remote-only search still rules it out,
 * because there the posting did answer.
 */
export function matchWorkplace(job, profile, c) {
  if (!c.workplace.size) return MATCH;
  if (job.workplace === 'unknown' || !job.workplace) return UNKNOWN;
  if (job.workplace_guessed) {
    if (c.workplace.has('onsite')) return MATCH;
    if (c.workplace.has('hybrid')) return UNKNOWN;
    return NO; // remote asked for, an office named: evidence, not silence
  }
  return c.workplace.has(job.workplace) ? MATCH : NO;
}

/**
 * Seniority, from the band and the stated years together.
 *
 * Both have to agree because they fail in opposite directions. Years alone lets
 * `Senior Engineer` through whenever the description happens not to state a
 * number — and 42.9% of titles carry no seniority word while 44.1% of
 * descriptions state no years, so the silent half is large either way. The band
 * alone lets `Associate Consultant — 8+ years required` through.
 *
 * Unknown means *neither* signal fired: no title marker and no parseable years.
 * That is 24.9% of the corpus, and it is why the shipped profile sends them to
 * a separate list rather than dropping them.
 */
export function matchExperience(job, profile, c) {
  if (!c.seniority) return MATCH;

  const bandKnown = job.seniority && job.seniority !== 'unknown';
  const yearsKnown = job.years_known === 1 && job.min_years != null;
  if (!bandKnown && !yearsKnown) return UNKNOWN;

  if (bandKnown && !c.seniority.has(job.seniority)) return NO;
  if (yearsKnown) {
    if (profile.max_years_experience != null && job.min_years > profile.max_years_experience) return NO;
    if (profile.min_years_experience != null) {
      // The top of the stated range is what can satisfy a floor: "2–6 years"
      // clears a 5-year minimum, "2 years" does not.
      const top = job.max_years ?? job.min_years;
      if (top < profile.min_years_experience) return NO;
    }
  }
  return MATCH;
}

/**
 * Salary floor, against the annualised USD figures the derive pass produced.
 *
 * Compared against the **top** of the published range, because that is what the
 * range is offering; comparing against the bottom would drop a $90–140k posting
 * from a $100k search. 62.8% of jobs publish nothing, which is why the default
 * policy for this criterion is `include` — a silently-applied floor is the
 * single most destructive thing this filter could do.
 */
export function matchSalary(job, profile, c) {
  if (profile.salary_min == null && profile.salary_max == null) return MATCH;
  if (!job.salary_known) return UNKNOWN;
  const top = job.salary_max ?? job.salary_min;
  const bottom = job.salary_min ?? job.salary_max;
  if (profile.salary_min != null && (top == null || top < profile.salary_min)) return NO;
  if (profile.salary_max != null && (bottom == null || bottom > profile.salary_max)) return NO;
  return MATCH;
}

export function matchEmploymentType(job, profile, c) {
  if (!c.employmentType.size) return MATCH;
  if (!job.employment_type) return UNKNOWN;
  return c.employmentType.has(job.employment_type) ? MATCH : NO;
}

/**
 * Which applicant-tracking system the posting came from.
 *
 * **The one criterion that can never answer `unknown`.** Every job has an `ats`:
 * the column is `NOT NULL`, the adapter sets it to a literal, and nothing else
 * can write it. So this does not join `UNKNOWNABLE` and gets no
 * include/exclude/separate control — which is consistent with the project rule
 * rather than an exception to it. The rule is that a criterion may only rule a
 * job out on published evidence, and here the evidence is always present.
 *
 * **It is a real criterion, not a display badge.** The cheaper implementation —
 * filtering the row set before evaluation — was rejected: it would make the ATS
 * counts the only ones in the UI that lie. "How many more jobs would I get if I
 * also allowed Greenhouse" is the same set-size question every other facet
 * answers, and leave-one-out counting only works for criteria that live in this
 * table.
 *
 * It also earns its keep on data quality. Greenhouse publishes no workplace enum
 * and no employment type at all, so a Greenhouse `onsite` is a guess from having
 * a metro while an Ashby `onsite` is the employer's own statement. This control
 * is how that difference becomes visible instead of silently averaged.
 */
export function matchAts(job, profile, c) {
  if (!c.ats.size) return MATCH;
  return c.ats.has(job.ats) ? MATCH : NO;
}

/**
 * Age. 4.8% of live postings are over a year old and 34% are over 90 days, so
 * this removes real noise rather than trimming an edge case.
 */
export function matchPosted(job, profile, c) {
  if (profile.posted_within_days == null) return MATCH;
  if (job.age_days == null) return UNKNOWN;
  return job.age_days <= profile.posted_within_days ? MATCH : NO;
}

/**
 * Job function, from the title and then the department.
 *
 * `other` is the fallback `deriveJobFunction` returns when neither the title nor
 * the department matched any rule — 7.1% of the corpus — so it means "we could
 * not classify this", not "this job is in the other bucket". A function filter
 * that read it as a definite answer would drop 4,338 jobs for not being
 * classifiable, the same mistake as dropping a job for not publishing a salary.
 *
 * Asking for `other` explicitly is the one case where it *is* the answer: then
 * the user has said they want the unclassifiable pile, so it matches.
 */
export function matchJobFunction(job, profile, c) {
  if (!c.job_functions.size) return MATCH;
  if (c.job_functions.has(job.job_function)) return MATCH;
  if (!job.job_function || job.job_function === 'other') return UNKNOWN;
  return NO;
}

/**
 * Skills, matched against the terms `deriveSignals` found in the description.
 *
 * An empty skill list is unknown, not a no. 28.4% of postings mention none of
 * the ~200 terms the derive pass looks for — a two-paragraph listing that never
 * names a tool has not told us it doesn't use SQL, it has told us nothing. A job
 * that *does* name skills and doesn't name the ones asked for is a real no,
 * because that is the strongest signal this data can carry.
 *
 * `exclude_skills` is the same evidence read the other way, and it is checked
 * first because an exclusion outranks an inclusion: a posting that names both
 * Python and PHP, when you asked for Python and asked not to see PHP, has told
 * you something and the something is PHP. It cannot fire on silence — a listing
 * that names no skills has not named the one you are avoiding, so it falls
 * through to the positive test instead of being ruled out on a blank field.
 *
 * Stack Overflow Jobs paired `tl` (tech you like) with `td` (tech you dislike)
 * and has been dead since March 2022; no live board has copied it. Otta weights
 * technologies `NEGATIVE`, which is the same instinct behind a different door.
 */
export function matchSkills(job, profile, c) {
  if (c.excludeSkills.size && job.skills.some((s) => c.excludeSkills.has(s))) return NO;
  if (!c.skills.size) return MATCH;
  if (!job.skills.length) return UNKNOWN;
  const has = (s) => job.skills.includes(s);
  const ok = profile.skills_match === 'all' ? [...c.skills].every(has) : [...c.skills].some(has);
  return ok ? MATCH : NO;
}

/**
 * The description gate.
 *
 * The keyword test itself already happened, in FTS5, over the 296 MB of prose
 * that deliberately never enters the in-memory index — `c.descriptionIds` is the
 * answer set and this is a lookup. Doing it that way is what lets the gate run
 * on the whole corpus for ~60 ms and, more importantly, run *before* the facet
 * tally: a description filter applied after the fact would make every
 * leave-one-out count a small lie, the same reason description exclusions have
 * always run in FTS.
 *
 * Two things follow from FTS being the matcher rather than the word-boundary
 * regex the ranking pass uses. It is slightly broader on hyphenated terms —
 * `client-facing` is a two-token phrase there, so `client facing` also matches —
 * measured at 4 extra jobs in 2,932 on the shipped list, with nothing the regex
 * found that FTS missed. That is the safe direction: the gate never drops a job
 * the score would have credited.
 *
 * A job with no description text to search answers `unknown`, never `no`. There
 * is nothing to find in a body that never arrived, and ruling a job out for a
 * blank field is the one thing no criterion here is allowed to do.
 */
export function matchDescription(job, profile, c) {
  if (!profile.description_keywords.length) return MATCH;
  // No answer set: the caller never ran the query, so there is no evidence to
  // rule anyone out on. Inactive, not a silent no.
  if (!c.descriptionIds) return MATCH;
  if (c.missingDescriptions?.has(job.id)) return UNKNOWN;
  return c.descriptionIds.has(job.id) ? MATCH : NO;
}

export function matchCompany(job, profile, c) {
  if (!c.companies.size) return MATCH;
  const slug = job.company_slug?.toLowerCase();
  const name = job.company_name?.toLowerCase();
  return c.companies.has(slug) || c.companies.has(name) ? MATCH : NO;
}

/**
 * Sponsorship, from the description. 1 sponsors, 0 explicitly does not, NULL
 * unstated — and 96.8% of postings are NULL, the sparsest field in the corpus.
 *
 * The two flags ask opposite questions of that silence and both are useful.
 * `exclude_visa_refusal` drops only the explicit refusals, so silence is a
 * match: a posting that never mentions visas has not refused you. Silence under
 * `requires_visa_sponsorship` is genuinely unknown and goes to the policy —
 * making it a hard `no` would discard 59,242 jobs for not raising the subject,
 * which is the single most destructive filter in the engine.
 */
export function matchVisa(job, profile, c) {
  const wantsSponsorship = profile.requires_visa_sponsorship === true;
  if (!wantsSponsorship && !profile.exclude_visa_refusal) return MATCH;
  if (job.visa === 0) return NO; // an explicit refusal fails either flag
  if (!wantsSponsorship) return MATCH; // exclude_visa_refusal alone: only 0 is a no
  return job.visa === 1 ? MATCH : UNKNOWN;
}

/**
 * Security clearance. Never unknown, and deliberately so: `deriveSignals` sets
 * this to 1 when the description names a clearance and leaves it NULL otherwise,
 * and the only filter over it is "drop clearance postings". Silence is the
 * answer that filter wants — a listing that never mentions TS/SCI is not asking
 * for one — so there is nothing here for an unknown policy to decide.
 */
export function matchClearance(job, profile, c) {
  if (!profile.exclude_clearance) return MATCH;
  return job.clearance === 1 ? NO : MATCH;
}

/**
 * Degree requirement, from the description.
 *
 * 75.6% of postings state none — more than state no salary — so this is the
 * criterion where treating silence as a no did the most damage. Measured on the
 * shipped NYC profile, `--degree=bachelors` took 221 matches down to 32. Only 19
 * of those 189 lost jobs asked for a degree other than the one requested; the
 * other 170 were lost for never mentioning school at all.
 */
export function matchDegree(job, profile, c) {
  if (!c.degree.size) return MATCH;
  if (!job.degree) return UNKNOWN;
  return c.degree.has(job.degree) ? MATCH : NO;
}

/**
 * How far a remote role reaches: worldwide, one country, one region.
 *
 * `d_remote_scope` is only ever set on remote postings — 16,869 of the 17,508
 * open remote jobs carry one, and no onsite or hybrid job ever does. So the
 * blank means two different things depending on the job beside it, and this is
 * the one criterion where that distinction has to be drawn explicitly:
 *
 *   an onsite or hybrid job     a confident **no**. Nothing is missing; the
 *                               workplace field already answered, and a role
 *                               you go to an office for does not reach anywhere.
 *   a remote job with no scope  **unknown** — 639 of them. It is remote and it
 *                               never said how far, which is a silence.
 *   workplace unknown too       **unknown**, for the same reason.
 *
 * Getting that wrong in the other direction would be the familiar failure: read
 * every blank as unknown and an `include` policy quietly hands back all 43,705
 * onsite jobs under a filter labelled "remote — worldwide".
 */
export function matchRemoteScope(job, profile, c) {
  if (!c.remoteScope.size) return MATCH;
  if (job.remote_scope) return c.remoteScope.has(job.remote_scope) ? MATCH : NO;
  const placed = job.workplace && job.workplace !== 'unknown';
  return placed && job.workplace !== 'remote' ? NO : UNKNOWN;
}

/**
 * How often the published figure is paid.
 *
 * 1,901 open jobs are priced hourly and were invisible as a class until this
 * existed: an hourly rate and a salary are different offers, and the annualised
 * USD figure the salary filter compares against hides which one you are looking
 * at. 62.8% of postings publish no compensation block at all and answer
 * `unknown` here for the same reason they answer it for salary.
 */
export function matchPayPeriod(job, profile, c) {
  if (!c.payPeriod.size) return MATCH;
  if (!job.pay_period) return UNKNOWN;
  return c.payPeriod.has(job.pay_period) ? MATCH : NO;
}

/**
 * The currency the board published, as published — never the annualised USD the
 * derive pass computed from it.
 *
 * USD 19,722 · EUR 1,196 · CAD 733 · GBP 726, and a long tail. The point is not
 * arithmetic, it is jurisdiction: a job quoted in PLN is a job in Poland
 * whatever its location string says.
 */
export function matchCurrency(job, profile, c) {
  if (!c.currencies.size) return MATCH;
  if (!job.currency) return UNKNOWN;
  return c.currencies.has(job.currency) ? MATCH : NO;
}

/**
 * Equity, from the compensation block.
 *
 * **This criterion can never answer `no`,** and that is a property of the data
 * rather than a decision here: Ashby's `summaryComponents` names an equity
 * component or it does not, so the adapter can only ever write 1 or NULL. There
 * are 10,996 postings that say yes and 50,217 that say nothing; there is not one
 * posting anywhere in the corpus that says "no equity". Returning NO on the
 * silent 82% would be inventing an answer no board gave.
 */
export function matchEquity(job, profile, c) {
  if (!profile.requires_equity) return MATCH;
  return job.equity === 1 ? MATCH : UNKNOWN;
}

/**
 * Pay as the employer published it, versus pay we had to reinterpret.
 *
 * `d_salary_src` records how each figure was arrived at: `as-stated` on 22,577
 * postings, and on ~220 more something the derive pass had to fix — a board
 * that labelled an hourly rate `YEAR`, a currency we hold no rate for, a
 * "salary" of $1. Those are the rows where the number on the card is our
 * arithmetic rather than the company's offer.
 *
 * No board in the survey has this filter. Glassdoor badges every figure
 * "Employer Est." or "Glassdoor Est." on the card and gives you no way to act
 * on the badge; Indeed, ZipRecruiter, SimplyHired, Adzuna, Talent.com, Monster
 * and The Ladders all impute estimates and none of them let you exclude one.
 *
 * A posting that published no figure is `unknown`, not `no`: it did not fail to
 * state its pay honestly, it declined to state it.
 */
export function matchSalarySource(job, profile, c) {
  if (!profile.salary_stated_only) return MATCH;
  if (!job.salary_known) return UNKNOWN;
  return job.salary_src === 'as-stated' ? MATCH : NO;
}

/**
 * Company size, counted in open roles rather than in people.
 *
 * Never unknown. Every job belongs to exactly one company and every company's
 * open postings are countable, so this is the one new criterion with 100%
 * coverage and no policy to set. What it cannot tell you is headcount — see
 * `COMPANY_SIZE_BANDS` for why it is labelled as the thing it actually counts.
 */
export function matchCompanySize(job, profile, c) {
  if (!c.companySize.size) return MATCH;
  return c.companySize.has(job.company_size) ? MATCH : NO;
}

/**
 * What the company does, read off its postings by the enrich pass.
 *
 * A fact about the employer rather than the posting — every job at a company
 * carries the company's answer — and the one column here that a pass other
 * than derive writes. NULL is the ordinary state for a company nobody has read
 * yet, and for one whose postings never said: both are `unknown`, and the
 * `sector` policy decides, `include` by default like everything else.
 *
 * `other` is unknown too, unless asked for by name — the same reading
 * `matchJobFunction` gives its own `other`: it means "fits no bucket", not
 * "is in the other bucket", and a filter that dropped it for not being
 * classifiable would be ruling on a blank.
 *
 * The exclusion is checked first and cannot fire on silence, exactly as
 * `exclude_skills` cannot: "not finance" drops a company we *know* is a bank,
 * and leaves in the one nobody has read, because that one has not been shown
 * to be a bank. Excluding it would be the failure this engine exists not to
 * have — and it would be the largest one, since the unread share is every
 * company the pass has not reached.
 */
export function matchSector(job, profile, c) {
  const known = job.sector && job.sector !== 'other';
  if (c.excludeSectors.size && known && c.excludeSectors.has(job.sector)) return NO;
  if (!c.sectors.size) return MATCH;
  if (job.sector && c.sectors.has(job.sector)) return MATCH;
  if (!known) return UNKNOWN;
  return NO;
}

/**
 * The title gate.
 *
 * Word-boundary, always. Substring matching on `ai` returns 355 title hits
 * instead of 263 — the extras are `P-ai-d Social`, `Supply Ch-ai-n`,
 * `Mount-ai-n View`; `specialist` drags in Spanish `Especialista`; `technical`
 * pulls `Geotechnical Engineer`. A 35% false-positive rate on one keyword is
 * not a stylistic preference.
 *
 * Returns the matched terms rather than a boolean, because ranking by *how
 * many distinct keywords hit* is what puts `AI Deployment Strategist` above
 * `Product Designer`, and the UI shows which ones.
 */
export function matchTitle(job, profile, c) {
  // Both gates ask the one-regex question first and only fall through to the
  // per-term loop when the answer is yes -- see `anyTerm`. A caller that
  // compiled a profile before those fields existed still works: the fallback is
  // the old per-term pass, which is the same answer, only slower.
  const excludeAny = c.excludeTitleAny ?? (c.excludeTitle.length ? anyTerm(c.excludeTitle.map((t) => t.term)) : null);
  if (excludeAny && excludeAny.test(job.tf)) return null;
  if (!c.title.length) return [];

  const includeAny = c.titleAny ?? anyTerm(c.title.map((t) => t.term));
  // `all` mode needs every keyword, so one hit proves nothing and the loop has
  // to run anyway -- but `any` mode, the default, is answered outright.
  if (profile.title_match !== 'all' && includeAny && !includeAny.test(job.tf)) return null;

  const matched = hits(job.tf, c.title);
  if (profile.title_match === 'all') return matched.length === c.title.length ? matched : null;
  return matched.length ? matched : null;
}

/**
 * Every criterion, in one table.
 *
 * One table rather than a hand-written conjunction is what makes leave-one-out
 * facet counting possible: "how many jobs would I get if I also picked Boston"
 * is the same question as "how many jobs fail on nothing except `metro`", and
 * that is a set operation over this list rather than six near-duplicate queries.
 */
/**
 * Every criterion, in one table.
 *
 * Each row carries its `test` and, beside it, the question **"did the profile
 * ask this at all?"** — `asked`. Every `test` above opens with a guard that
 * returns `MATCH` when its criterion is unconfigured, and `asked` is that same
 * guard, negated, lifted out of the per-job loop. They are written next to each
 * other so the pair cannot drift: change a guard, change the line below it.
 *
 * That lifting is the difference between a query that runs and one that hangs.
 * A profile configures a handful of these; the other fifteen answer `MATCH` for
 * every job in the corpus, and the loop was calling them anyway — twenty calls
 * and a twenty-key object per job, 6.7M calls on an unfiltered search, all of
 * them to be told nothing. `compileProfile` now keeps only the rows a profile
 * actually asked for, and the unfiltered case does no per-criterion work at all.
 */
export const CRITERIA = [
  { key: 'ats', test: matchAts, asked: (p, c) => c.ats.size > 0 },
  { key: 'description', test: matchDescription, asked: (p) => p.description_keywords.length > 0 },
  { key: 'metro', test: matchMetro, asked: (p, c) => c.metros.size > 0 || c.countries.size > 0 },
  { key: 'workplace', test: matchWorkplace, asked: (p, c) => c.workplace.size > 0 },
  // `c.seniority` is null exactly when neither a band nor a years bound was
  // given — see `allowedSeniority`, which folds the years into the band set.
  { key: 'experience', test: matchExperience, asked: (p, c) => Boolean(c.seniority) },
  { key: 'salary', test: matchSalary, asked: (p) => p.salary_min != null || p.salary_max != null },
  { key: 'employment_type', test: matchEmploymentType, asked: (p, c) => c.employmentType.size > 0 },
  { key: 'posted', test: matchPosted, asked: (p) => p.posted_within_days != null },
  { key: 'job_function', test: matchJobFunction, asked: (p, c) => c.job_functions.size > 0 },
  // Both halves: `matchSkills` answers the exclusions before it checks whether
  // anything was asked for, so a profile with only exclusions is still active.
  { key: 'skills', test: matchSkills, asked: (p, c) => c.skills.size > 0 || c.excludeSkills.size > 0 },
  { key: 'company', test: matchCompany, asked: (p, c) => c.companies.size > 0 },
  { key: 'company_size', test: matchCompanySize, asked: (p, c) => c.companySize.size > 0 },
  // Both halves, as for skills: an exclusion alone is a live criterion.
  { key: 'sector', test: matchSector, asked: (p, c) => c.sectors.size > 0 || c.excludeSectors.size > 0 },
  { key: 'remote_scope', test: matchRemoteScope, asked: (p, c) => c.remoteScope.size > 0 },
  { key: 'pay_period', test: matchPayPeriod, asked: (p, c) => c.payPeriod.size > 0 },
  { key: 'currency', test: matchCurrency, asked: (p, c) => c.currencies.size > 0 },
  { key: 'equity', test: matchEquity, asked: (p) => Boolean(p.requires_equity) },
  { key: 'salary_source', test: matchSalarySource, asked: (p) => Boolean(p.salary_stated_only) },
  { key: 'visa', test: matchVisa, asked: (p) => p.requires_visa_sponsorship === true || Boolean(p.exclude_visa_refusal) },
  { key: 'clearance', test: matchClearance, asked: (p) => Boolean(p.exclude_clearance) },
  { key: 'degree', test: matchDegree, asked: (p, c) => c.degree.size > 0 },
];

/** The criterion keys, in table order. Hoisted so the hot loops never rebuild it. */
export const CRITERIA_KEYS = CRITERIA.map((c) => c.key);

/**
 * Evaluate every criterion. Returns the verdict map plus the matched title
 * keywords, or `null` when the title gate ruled the job out — the gate is
 * checked first because it is the cheapest way to discard most of the corpus,
 * and because a job whose title the user never asked for has no facet to count.
 */
export function evaluate(job, profile, c) {
  const titleHits = matchTitle(job, profile, c);
  if (titleHits === null) return null;

  // Only the criteria the profile asked about. An unasked one is `MATCH` for
  // every job by construction (that is what `asked` encodes), and leaving it
  // out of the map is not a missing answer: `failedKeys` and `classify` both
  // already skip `undefined`, and they are handed the same key list. A profile
  // that asks nothing therefore allocates one empty object per job instead of a
  // twenty-key one, which is most of what the unfiltered scan used to cost.
  const active = c.active ?? CRITERIA;
  const verdicts = {};
  for (const { key, test } of active) verdicts[key] = test(job, profile, c);
  return { titleHits, verdicts };
}

/**
 * The whole per-job decision in one pass, and the only version of it the scan
 * runs.
 *
 * `evaluate`, `failedKeys` and `classify` below compute the same three answers
 * in three readable steps, and they remain the reference — `filter-test.mjs`
 * asserts this function agrees with them on every criterion and every policy,
 * so the fused copy cannot drift from the plain one. What the fused copy can do
 * is **stop early**, and that is the point:
 *
 *   two failures and the job is finished. It is excluded whatever the
 *   remaining criteria say, and it is excluded from every facet too, because a
 *   leave-one-out count only ever counts a job whose *only* obstacle is the
 *   dimension being counted. The third criterion's answer cannot change the
 *   outcome and neither can the twentieth, so they are not asked.
 *
 * On a filtered search most of the corpus fails early and is dropped after two
 * or three tests instead of twenty.
 *
 * Results are written into the caller's `out` object rather than returned in a
 * fresh one: this runs once per job in the corpus, and an object per job is the
 * allocation that shows up as a GC pause. Returns false when the title gate
 * ruled the job out, in which case `out` is untouched.
 *
 * @param {object} out  filled with `titleHits`, `failures`, `failedKey`
 *   (the single failing criterion, or null when there is not exactly one),
 *   `bucket` ('in' | 'aside', or null when the job failed), and `unknownOn`
 *   (the criteria this job is silent on, or null — only meaningful when it
 *   passed, which is the only case anything reads it).
 */
export function screen(job, profile, c, out) {
  const titleHits = matchTitle(job, profile, c);
  if (titleHits === null) return false;

  const unknowns = profile.unknowns;
  const active = c.active ?? CRITERIA;
  let failures = 0;
  let failedKey = null;
  let separate = false;
  let unknownOn = null;

  for (let i = 0; i < active.length; i++) {
    const criterion = active[i];
    const verdict = criterion.test(job, profile, c);
    if (verdict === MATCH) continue;

    if (verdict === NO) {
      failedKey = criterion.key;
      if (++failures > 1) break;
      continue;
    }

    // UNKNOWN, and the profile's policy decides what that costs.
    const policy = unknowns[criterion.key] ?? 'include';
    if (policy === 'exclude') {
      failedKey = criterion.key;
      if (++failures > 1) break;
      continue;
    }
    if (policy === 'separate') separate = true;
    (unknownOn ??= []).push(criterion.key);
  }

  out.titleHits = titleHits;
  out.failures = failures;
  // Exactly one, or nothing: `failedKey` still holds the second failure after an
  // early break, and a job with two of them is one for no facet to count.
  out.failedKey = failures === 1 ? failedKey : null;
  out.bucket = failures ? null : separate ? 'aside' : 'in';
  out.unknownOn = unknownOn;
  return true;
}

/**
 * Which criteria would exclude this job, given the profile's unknown policies.
 *
 * Empty means it belongs in the results (or the aside list). Exactly one entry
 * means it is one relaxed criterion away, which is what a facet count is for.
 */
export function failedKeys(verdicts, unknowns, keys = CRITERIA_KEYS) {
  const failed = [];
  // Over `CRITERIA_KEYS` rather than `Object.entries(verdicts)`: this runs once
  // per job that clears the title gate, and entries allocated a twenty-element
  // array of two-element arrays each time -- 1.2M throwaway arrays per query on
  // the current corpus, and the GC bill to go with them.
  for (const key of keys) {
    const verdict = verdicts[key];
    if (verdict === undefined || verdict === MATCH) continue;
    if (verdict === NO) failed.push(key);
    else if ((unknowns[key] ?? 'include') === 'exclude') failed.push(key);
  }
  return failed;
}

/**
 * Apply the unknown policies to a verdict map.
 *
 * @returns {'in'|'aside'|'out'}
 *   `in`    — belongs in the result list
 *   `aside` — matches everything except that it is unknown on a criterion the
 *             profile marked `separate`; the "worth a look" pile
 *   `out`   — filtered
 *
 * The `aside` rule is deliberately narrow: a job qualifies only if every
 * non-separate criterion is satisfied under its own policy *and* it is unknown
 * on at least one separate criterion. Without that last clause the aside list
 * would be a copy of the result list.
 */
export function classify(verdicts, unknowns, keys = CRITERIA_KEYS) {
  let anySeparateUnknown = false;

  for (const key of keys) {
    const verdict = verdicts[key];
    if (verdict === undefined || verdict === MATCH) continue;
    const policy = unknowns[key] ?? 'include';
    if (verdict === NO) return 'out';
    // verdict === UNKNOWN
    if (policy === 'exclude') return 'out';
    if (policy === 'separate') anySeparateUnknown = true;
  }
  return anySeparateUnknown ? 'aside' : 'in';
}

export { MATCH, NO, UNKNOWN };
