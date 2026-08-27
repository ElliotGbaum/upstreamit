#!/usr/bin/env node
/**
 * Filter-engine tests.
 *
 *   node src/filter-test.mjs
 *
 * Same contract as `derive-test.mjs`: no database, no network, pure functions,
 * milliseconds to run. The cases here are the three-valued logic and the
 * leave-one-out facet rule, which are the two places where a plausible-looking
 * change quietly starts hiding jobs — and a filter that hides jobs without
 * saying so is worse than no filter, because you cannot tell.
 */

import {
  normalizeProfile,
  blankProfile,
  allowedSeniority,
  activeCriteria,
  UNKNOWNABLE,
} from './lib/filter/profile.mjs';
import { ownerOf, ownedBy, profilesVisibleTo, sortProfiles, listProfiles } from './find.mjs';
import {
  compileProfile,
  matchMetro,
  matchWorkplace,
  matchExperience,
  matchSalary,
  matchEmploymentType,
  matchPosted,
  matchJobFunction,
  matchSkills,
  matchCompany,
  matchVisa,
  matchClearance,
  matchDegree,
  matchTitle,
  matchDescription,
  evaluate,
  screen,
  classify,
  failedKeys,
  hits,
  compileTerms,
  CRITERIA,
} from './lib/filter/match.mjs';
import {
  matchRemoteScope,
  matchPayPeriod,
  matchCurrency,
  matchEquity,
  matchSalarySource,
  matchCompanySize,
  matchAts,
  matchSector,
} from './lib/filter/match.mjs';
import { scoreJob, sortByScore, sortRows, salaryLabel } from './lib/filter/rank.mjs';
import { ageBandsFor, AGE_BANDS, salaryLadder, SALARY_BANDS, textQuery } from './lib/filter/index.mjs';
import { companySizeBand } from './lib/schema.mjs';
import { fold } from './lib/derive/text.mjs';

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed++;
  else failures.push(`${name}\n      got      ${a}\n      expected ${e}`);
}

/** A job row shaped exactly like the in-memory index builds them. */
function job(overrides = {}) {
  const base = {
    id: 'ashby:acme:1',
    title: 'Implementation Specialist',
    company_name: 'Acme',
    company_slug: 'acme',
    employment_type: 'FullTime',
    workplace: 'hybrid',
    metros: ['nyc'],
    countries: ['us'],
    salary_min: null,
    salary_max: null,
    salary_known: 0,
    min_years: null,
    max_years: null,
    years_known: 0,
    seniority: 'unknown',
    job_function: 'customer-success',
    skills: [],
    visa: null,
    clearance: null,
    degree: null,
    remote_scope: null,
    pay_period: null,
    currency: null,
    equity: null,
    salary_src: null,
    company_size: '6-20',
    sector: null,
    title_norm: 'implementation specialist',
    age_days: 10,
    quality: 0.5,
    ...overrides,
  };
  base.tf = fold(base.title);
  return base;
}

/** A profile plus its compiled form, since every criterion needs both. */
function withProfile(input, descriptionIndex) {
  const { profile } = normalizeProfile(input);
  return [profile, compileProfile(profile, descriptionIndex)];
}

/**
 * The description gate's answer sets, which in production come from one FTS
 * query and a scan for bodies that never arrived. Here they are literals, which
 * is the point: the criterion itself is a pure set lookup and stays testable
 * without a database, like every other one in this file.
 */
function descriptionIndex(matched, missing = []) {
  return { descriptionIds: new Set(matched), missingDescriptions: new Set(missing) };
}

// ------------------------------------------------------------------ profile --

{
  const { profile, warnings } = normalizeProfile({});
  check('blank profile has no active criteria', activeCriteria(profile).length, 0);
  check('blank profile is silent', warnings, []);
  check('default metro policy includes unknowns', profile.unknowns.metro, 'include');
  check('default salary policy includes unknowns', profile.unknowns.salary, 'include');
  check('default degree policy includes unknowns', profile.unknowns.degree, 'include');
  // Was `separate` until the "worth a look" list was removed from the page.
  // Nothing may default to `separate` now: there is no second list to render
  // it, so those jobs would leave the page entirely.
  check('default experience policy includes unknowns', profile.unknowns.experience, 'include');
}
{
  const { profile, warnings } = normalizeProfile({
    workplace: ['onsite', 'wfh'],
    seniority: ['entry', 'wizard'],
    unknowns: { salary: 'maybe', nonsense: 'include' },
  });
  // A typo'd enum must be visible: silently returning zero jobs is exactly the
  // failure mode facet counts exist to prevent.
  check('invalid enum dropped', profile.workplace, ['onsite']);
  check('invalid seniority dropped', profile.seniority, ['entry']);
  check('invalid values warn', warnings.length, 4);
  check('bad policy falls back to the default', profile.unknowns.salary, 'include');
}
check(
  'unknown fields round-trip rather than being lost',
  normalizeProfile({ name: 'x', from_a_newer_ui: 42 }).profile.extra,
  { from_a_newer_ui: 42 },
);
check('limit is clamped', normalizeProfile({ limit: 99999 }).profile.limit, 5000);
check('string criterion is accepted as a one-element list', normalizeProfile({ metros: 'nyc' }).profile.metros, ['nyc']);
check('metros are lowercased', normalizeProfile({ metros: ['NYC'] }).profile.metros, ['nyc']);

// ---------------------------------------------------------- seniority bands --

check('no cap means the criterion is inactive', allowedSeniority(blankProfile()), null);
check('≤2 years admits entry and junior', [...allowedSeniority({ ...blankProfile(), max_years_experience: 2 })], ['entry', 'junior']);
// Regression: an internship is not an entry-level job, and `employment_type`
// does not always separate them — 437 jobs carry Intern as a type while others
// post internships as FullTime.
check('intern excluded by default', allowedSeniority({ ...blankProfile(), max_years_experience: 2 }).has('intern'), false);
check('intern included on request', allowedSeniority({ ...blankProfile(), max_years_experience: 2, include_intern: true }).has('intern'), true);
check('≤5 years admits mid and manager', [...allowedSeniority({ ...blankProfile(), max_years_experience: 5 })], ['entry', 'junior', 'mid', 'manager']);
check('an explicit list wins over the cap', [...allowedSeniority({ ...blankProfile(), max_years_experience: 2, seniority: ['staff'] })], ['staff']);
check('a floor rules out bands that top out below it', allowedSeniority({ ...blankProfile(), min_years_experience: 6 }).has('junior'), false);

// ------------------------------------------------------------------- metro --

{
  const [p, c] = withProfile({ metros: ['nyc'] });
  check('metro: in the metro', matchMetro(job({ metros: ['nyc'] }), p, c), 'match');
  check('metro: a different metro is a confident no', matchMetro(job({ metros: ['boston'] }), p, c), 'no');
  // Not the same thing: 15.9% of jobs have no location we could place, and
  // calling that "not New York" would be a guess dressed as an answer.
  check('metro: no location at all is unknown', matchMetro(job({ metros: [] }), p, c), 'unknown');
  check('metro: one of several counts', matchMetro(job({ metros: ['sf-bay', 'nyc'] }), p, c), 'match');
  check('metro: remote is excluded by default', matchMetro(job({ metros: [], workplace: 'remote' }), p, c), 'unknown');
}
{
  const [p, c] = withProfile({ metros: ['nyc'], remote_counts_as_match: true });
  check('metro: remote counts when asked', matchMetro(job({ metros: [], workplace: 'remote' }), p, c), 'match');
}
{
  const [p, c] = withProfile({ countries: ['us'] });
  check('country: match', matchMetro(job({ countries: ['us'] }), p, c), 'match');
  check('country: no', matchMetro(job({ countries: ['de'] }), p, c), 'no');
  check('country: unknown', matchMetro(job({ countries: [], metros: [] }), p, c), 'unknown');
}
check('metro: no criterion means everything matches', matchMetro(job(), ...withProfile({})), 'match');

// --------------------------------------------------------------- workplace --

{
  const [p, c] = withProfile({ workplace: ['onsite', 'hybrid'] });
  check('workplace: hybrid counts as in person', matchWorkplace(job({ workplace: 'hybrid' }), p, c), 'match');
  check('workplace: remote is a no', matchWorkplace(job({ workplace: 'remote' }), p, c), 'no');
  check('workplace: unknown stays unknown', matchWorkplace(job({ workplace: 'unknown' }), p, c), 'unknown');
}

// A guessed `onsite` — `default-has-metro`, two thirds of the corpus and every
// Greenhouse job with an office — answers each question differently, because
// the guess knows the job is not remote and cannot know whether it is hybrid.
{
  const guessed = job({ workplace: 'onsite', workplace_guessed: true });

  const [onsite, oc] = withProfile({ workplace: ['onsite'] });
  check('workplace: a guess still answers an onsite search', matchWorkplace(guessed, onsite, oc), 'match');

  // The regression this whole branch exists for: this used to be a silent `no`
  // on all 204,485 Greenhouse jobs.
  const [hybrid, hc] = withProfile({ workplace: ['hybrid'] });
  check('workplace: a guess cannot rule out hybrid', matchWorkplace(guessed, hybrid, hc), 'unknown');

  const [both, bc] = withProfile({ workplace: ['onsite', 'hybrid'] });
  check('workplace: asking for either takes the guess', matchWorkplace(guessed, both, bc), 'match');

  // Not silence: the posting named a place and never said remote.
  const [remote, rc] = withProfile({ workplace: ['remote'] });
  check('workplace: a named office is still a no for remote', matchWorkplace(guessed, remote, rc), 'no');

  // A stated hybrid is untouched by any of the above.
  check('workplace: a stated value ignores the guess path', matchWorkplace(job({ workplace: 'hybrid' }), hybrid, hc), 'match');
}

// -------------------------------------------------------------- experience --

{
  const [p, c] = withProfile({ max_years_experience: 2 });
  check('experience: 1 year matches', matchExperience(job({ years_known: 1, min_years: 1, seniority: 'entry' }), p, c), 'match');
  check('experience: 5 years does not', matchExperience(job({ years_known: 1, min_years: 5, seniority: 'mid' }), p, c), 'no');
  // Regression: the title is decisive even when the description happens to
  // state a small number. "Senior Engineer, 1+ years" is not an entry job.
  check('experience: a senior title outranks a small number', matchExperience(job({ years_known: 1, min_years: 1, seniority: 'senior' }), p, c), 'no');
  // And the reverse: a junior-sounding title with a big number is not entry.
  check('experience: stated years outrank a junior title', matchExperience(job({ years_known: 1, min_years: 8, seniority: 'entry' }), p, c), 'no');
  check('experience: title-only classification is enough', matchExperience(job({ years_known: 0, seniority: 'senior' }), p, c), 'no');
  check('experience: neither signal is unknown', matchExperience(job({ years_known: 0, seniority: 'unknown' }), p, c), 'unknown');
}
{
  const [p, c] = withProfile({ min_years_experience: 5 });
  check('experience: a range top can clear a floor', matchExperience(job({ years_known: 1, min_years: 2, max_years: 6, seniority: 'mid' }), p, c), 'match');
  check('experience: a bare 2 cannot', matchExperience(job({ years_known: 1, min_years: 2, max_years: null, seniority: 'mid' }), p, c), 'no');
}

// ------------------------------------------------------------------ salary --

{
  const [p, c] = withProfile({ salary_min: 100000 });
  // Compared against the top of the range: a $90–140k posting is a live answer
  // to a $100k search, and comparing on the bottom would drop it.
  check('salary: top of range clears the floor', matchSalary(job({ salary_known: 1, salary_min: 90000, salary_max: 140000 }), p, c), 'match');
  check('salary: below the floor', matchSalary(job({ salary_known: 1, salary_min: 60000, salary_max: 80000 }), p, c), 'no');
  check('salary: 62.8% publish nothing — unknown, not no', matchSalary(job({ salary_known: 0 }), p, c), 'unknown');
}

// ------------------------------------------------- employment type and age --

{
  const [p, c] = withProfile({ employment_type: ['FullTime'] });
  check('employment: match', matchEmploymentType(job(), p, c), 'match');
  check('employment: contract is a no', matchEmploymentType(job({ employment_type: 'Contract' }), p, c), 'no');
  check('employment: null is unknown', matchEmploymentType(job({ employment_type: null }), p, c), 'unknown');
}

// ------------------------------------------------------------------- ats --
//
// The one criterion that partitions the corpus: every job has exactly one ATS
// and it is never absent, so there is no `unknown` case to test — only that an
// empty list stays inactive and that a set list is an exact partition.
{
  const [p, c] = withProfile({});
  check('ats: empty list is inactive', matchAts(job({ ats: 'greenhouse' }), p, c), 'match');
}
{
  const [p, c] = withProfile({ ats: ['ashby'] });
  check('ats: match', matchAts(job({ ats: 'ashby' }), p, c), 'match');
  check('ats: a different ats is a no', matchAts(job({ ats: 'greenhouse' }), p, c), 'no');
}
{
  const [p, c] = withProfile({ ats: ['ashby', 'greenhouse'] });
  check('ats: both selected matches either', matchAts(job({ ats: 'greenhouse' }), p, c), 'match');
  check('ats: still excludes a third', matchAts(job({ ats: 'lever' }), p, c), 'no');
}
{
  // A typo'd ATS must be visible for the same reason a typo'd metro is: it
  // would otherwise silently return zero jobs.
  const { profile, warnings } = normalizeProfile({ ats: ['ashby', 'nonsense'] });
  check('ats: invalid value dropped', profile.ats, ['ashby']);
  check('ats: invalid value warns', warnings.length, 1);
  check('ats: shows up as an active criterion', activeCriteria(profile).some((a) => a.key === 'ats'), true);
}
{
  // Leave-one-out: a job that fails only on `ats` names exactly that criterion,
  // which is what makes "how many more jobs if I also allow Greenhouse" a
  // countable question rather than a second query.
  check(
    'ats: a job one ats away names that criterion',
    failedKeys({ ats: 'no', metro: 'match', salary: 'match' }, {}),
    ['ats'],
  );
}
{
  const [p, c] = withProfile({ posted_within_days: 30 });
  check('posted: fresh', matchPosted(job({ age_days: 3 }), p, c), 'match');
  check('posted: stale', matchPosted(job({ age_days: 400 }), p, c), 'no');
  check('posted: undated', matchPosted(job({ age_days: null }), p, c), 'unknown');
}
// A cap the presets do not cover gets a band of its own, so the panel can put a
// count beside the number in force rather than beside the four it is not.
{
  const bands = (input) => ageBandsFor(normalizeProfile(input).profile).map(([label, max]) => [label, max]);
  check('age bands: no cap is the presets', bands({}), AGE_BANDS);
  check('age bands: a preset cap adds nothing', bands({ posted_within_days: 90 }), AGE_BANDS);
  check('age bands: a cap of their own', bands({ posted_within_days: 45 }).at(-1), ['≤45 days', 45]);
  check('age bands: one day reads as one day', bands({ posted_within_days: 1 }).at(-1), ['≤1 day', 1]);
  check('age bands: no duplicate band', bands({ posted_within_days: 45 }).length, AGE_BANDS.length + 1);
}

// ------------------------------------------------------------ definite bits --

{
  const [p, c] = withProfile({ job_functions: ['customer-success'] });
  check('job function: match', matchJobFunction(job(), p, c), 'match');
  check('job function: no', matchJobFunction(job({ job_function: 'engineering' }), p, c), 'no');
  // `other` is deriveJobFunction's fallback when neither title nor department hit a
  // rule — 7.1% of the corpus. It means "unclassifiable", not "a job in the
  // other bucket", so a job-function filter must not spend it as a confident no.
  check('job function: unclassifiable is unknown', matchJobFunction(job({ job_function: 'other' }), p, c), 'unknown');
  check('job function: missing is unknown', matchJobFunction(job({ job_function: null }), p, c), 'unknown');
}
{
  const [p, c] = withProfile({ job_functions: ['other'] });
  check('job function: asking for other makes it an answer', matchJobFunction(job({ job_function: 'other' }), p, c), 'match');
}
{
  const [p, c] = withProfile({ skills: ['python', 'sql'], skills_match: 'all' });
  check('skills: all required', matchSkills(job({ skills: ['python'] }), p, c), 'no');
  check('skills: all present', matchSkills(job({ skills: ['python', 'sql', 'aws'] }), p, c), 'match');
}
{
  const [p, c] = withProfile({ skills: ['python', 'sql'] });
  check('skills: any is the default', matchSkills(job({ skills: ['sql'] }), p, c), 'match');
  // 28.4% of descriptions name none of the ~200 tracked terms. That is silence,
  // not a statement that the job doesn't use SQL.
  check('skills: a description naming none is unknown', matchSkills(job({ skills: [] }), p, c), 'unknown');
  check('skills: naming others is a real no', matchSkills(job({ skills: ['excel'] }), p, c), 'no');
}
{
  const [p, c] = withProfile({ companies: ['acme'] });
  check('company: allow-list by slug', matchCompany(job(), p, c), 'match');
  check('company: outside the allow-list', matchCompany(job({ company_slug: 'other', company_name: 'Other' }), p, c), 'no');
}
{
  const [p, c] = withProfile({ exclude_clearance: true, exclude_visa_refusal: true });
  check('clearance: an explicit clearance posting is excluded', matchClearance(job({ clearance: 1 }), p, c), 'no');
  // 98.5% of postings never mention a clearance, and that silence is exactly
  // what "drop clearance jobs" wants kept — so this criterion is never unknown.
  check('clearance: silence is kept', matchClearance(job({ clearance: null }), p, c), 'match');
  check('visa: explicit refusal excluded', matchVisa(job({ visa: 0 }), p, c), 'no');
  // Most postings say nothing about sponsorship. Silence is not a refusal.
  check('visa: silence is kept under exclude_visa_refusal', matchVisa(job({ visa: null }), p, c), 'match');
}
{
  const [p, c] = withProfile({ requires_visa_sponsorship: true });
  // Regression: this used to be a hard `no`, which discarded the 96.8% of jobs
  // that never raise the subject. It is the policy's call now, not the gate's.
  check('visa: silence under a sponsorship requirement is unknown', matchVisa(job({ visa: null }), p, c), 'unknown');
  check('visa: explicit yes passes', matchVisa(job({ visa: 1 }), p, c), 'match');
  check('visa: explicit no still fails', matchVisa(job({ visa: 0 }), p, c), 'no');
}
{
  const [p, c] = withProfile({ degree: ['bachelors'] });
  check('degree: stated and asked for', matchDegree(job({ degree: 'bachelors' }), p, c), 'match');
  check('degree: stated and different', matchDegree(job({ degree: 'phd' }), p, c), 'no');
  // Regression: 75.6% of postings state no degree — more than state no salary.
  // As a hard `no` this collapsed the shipped NYC profile from 221 to 32.
  check('degree: unstated is unknown', matchDegree(job({ degree: null }), p, c), 'unknown');
}
{
  const [p, c] = withProfile({});
  check('visa: inactive without either flag', matchVisa(job({ visa: 0 }), p, c), 'match');
  check('clearance: inactive without the flag', matchClearance(job({ clearance: 1 }), p, c), 'match');
  check('degree: inactive without a list', matchDegree(job({ degree: null }), p, c), 'match');
}

// -------------------------------------------------------------- title gate --

{
  const [p, c] = withProfile({ title_keywords: ['ai', 'product'] });
  check('title: word-boundary hit', matchTitle(job({ title: 'AI Deployment Strategist' }), p, c), ['ai']);
  // Regression: substring matching on `ai` returns 355 title hits instead of
  // 263 — the extras are Paid, Supply Chain, Mountain View.
  check('title: Paid does not contain ai', matchTitle(job({ title: 'Paid Social Account Director' }), p, c), null);
  check('title: two keywords both counted', matchTitle(job({ title: 'AI Product Lead' }), p, c), ['ai', 'product']);
}
{
  const [p, c] = withProfile({ title_keywords: ['ai', 'product'], title_match: 'all' });
  check('title: all mode needs every keyword', matchTitle(job({ title: 'AI Strategist' }), p, c), null);
  check('title: all mode satisfied', matchTitle(job({ title: 'AI Product Lead' }), p, c), ['ai', 'product']);
}
{
  const [p, c] = withProfile({ title_keywords: ['analyst'], exclude_title_keywords: ['senior'] });
  check('title: exclusion beats inclusion', matchTitle(job({ title: 'Senior Analyst' }), p, c), null);
  check('title: exclusion applies with no include list', matchTitle(job({ title: 'Senior Analyst' }), ...withProfile({ exclude_title_keywords: ['senior'] })), null);
}
check('title: no keywords means no gate', matchTitle(job({ title: 'Anything At All' }), ...withProfile({})), []);

// -------------------------------------------------------- description gate --

{
  const [p, c] = withProfile({ description_keywords: ['consulting'] }, descriptionIndex(['a']));
  check('description: in the answer set', matchDescription(job({ id: 'a' }), p, c), 'match');
  check('description: searched and not there is a no', matchDescription(job({ id: 'b' }), p, c), 'no');
}
{
  // The invariant this whole engine rests on, applied to the one criterion whose
  // evidence lives outside the in-memory index: a body that never arrived is
  // silence, and silence goes to the unknown policy rather than to `no`.
  const [p, c] = withProfile({ description_keywords: ['consulting'] }, descriptionIndex([], ['b']));
  check('description: no text to search is unknown', matchDescription(job({ id: 'b' }), p, c), 'unknown');
  check('description: unknownable, so it is on the roster', blankProfile().unknowns.description, 'include');
}
{
  // `search()` supplies the sets; anything else that compiles a profile — the
  // tests above, a caller that only wants the enum criteria — gets an inactive
  // gate. Guessing `no` here would filter on evidence nobody gathered.
  const [p, c] = withProfile({ description_keywords: ['consulting'] });
  check('description: no answer set means no gate', matchDescription(job(), p, c), 'match');
}
check(
  'description: no keywords means no gate',
  matchDescription(job(), ...withProfile({}, descriptionIndex([]))),
  'match',
);
{
  const { profile } = normalizeProfile({ description_keywords: ['a'], description_match: 'every' });
  check('description: an unknown match mode falls back to any', profile.description_match, 'any');
  check('description: the gate is an active criterion', activeCriteria(profile).some((x) => x.key === 'description'), true);
}
check('compiled terms are deduped and folded', compileTerms(['AI', 'ai', ' Ai ']).length, 1);
check('hits returns terms in list order', hits(fold('Product AI Analyst'), compileTerms(['analyst', 'ai'])), ['analyst', 'ai']);

// ------------------------------------------------- the roster is exhaustive --

// These three guard the invariant the whole engine rests on: a criterion may
// rule a job out on evidence, never on the absence of it. Each of them failed
// before `degree`, `visa`, `skills` and `job_function` were added to the roster.
{
  const defaults = blankProfile().unknowns;
  const roster = UNKNOWNABLE.map((u) => u.key).sort();
  check('roster: every unknownable criterion has a default policy', Object.keys(defaults).sort(), roster);

  const excluded = Object.entries(defaults).filter(([, v]) => v === 'exclude').map(([k]) => k);
  check('roster: nothing defaults to exclude', excluded, []);

  // The page renders one result list. A `separate` default would route jobs
  // into an aside bucket nothing draws, which reads as them being filtered out.
  // The policy stays valid for saved profiles and the CLI; it is just not a default.
  const separated = Object.entries(defaults).filter(([, v]) => v === 'separate').map(([k]) => k);
  check('roster: nothing defaults to separate', separated, []);

  // A criterion that can answer `unknown` but has no roster entry has no policy
  // either, and `failedKeys` falls back to `include` for it — which is the safe
  // direction, but it means the UI draws no control and the user cannot see or
  // change it. Three criteria are deliberately absent, each for its own reason:
  //
  //   clearance     never answers unknown — silence is what "drop clearance
  //                 postings" wants kept, so there is nothing for a policy to do
  //   company       an allow-list of names; a job either is one of them or isn't
  //   company_size  counted from the corpus itself, so it is known for every job
  //                 that exists. 100% coverage, no silence, no policy.
  //   ats           `jobs.ats` is NOT NULL and the adapter writes it as a
  //                 literal, so this is the one criterion where nothing is ever
  //                 unknown by construction rather than by measurement.
  const criteria = CRITERIA.map((x) => x.key);
  const missing = criteria.filter((k) => !roster.includes(k));
  check(
    'roster: only never-unknown criteria are off it',
    missing.sort(),
    ['ats', 'clearance', 'company', 'company_size', 'flags'].filter((k) => criteria.includes(k)).sort(),
  );
}

// ---------------------------------------------------- three-valued policies --

const verdicts = { metro: 'match', workplace: 'match', experience: 'unknown', salary: 'unknown' };
check('policy: separate sends it aside', classify(verdicts, { experience: 'separate', salary: 'include' }), 'aside');
check('policy: include keeps it in the main list', classify(verdicts, { experience: 'include', salary: 'include' }), 'in');
check('policy: exclude drops it', classify(verdicts, { experience: 'exclude', salary: 'include' }), 'out');
check('policy: a confident no always wins', classify({ metro: 'no', experience: 'unknown' }, { experience: 'include' }), 'out');
// Without the "unknown on at least one separate criterion" clause the aside
// list would be a copy of the result list.
check('policy: all-match never goes aside', classify({ metro: 'match' }, { metro: 'separate' }), 'in');

// ---------------------------------------------------- leave-one-out facets --

check(
  'facets: a job one criterion away names that criterion',
  failedKeys({ metro: 'no', workplace: 'match', salary: 'match' }, {}),
  ['metro'],
);
check(
  'facets: an unknown under an exclude policy also fails',
  failedKeys({ metro: 'unknown', workplace: 'match' }, { metro: 'exclude' }),
  ['metro'],
);
check(
  'facets: the same unknown under include does not',
  failedKeys({ metro: 'unknown', workplace: 'match' }, { metro: 'include' }),
  [],
);
check(
  'facets: two failures means it counts nowhere',
  failedKeys({ metro: 'no', workplace: 'no' }, {}).length,
  2,
);

// ---------------------------------------------------------------- evaluate --

{
  const [p, c] = withProfile({
    title_keywords: ['implementation'],
    metros: ['nyc'],
    workplace: ['onsite', 'hybrid'],
    max_years_experience: 2,
  });
  const result = evaluate(job(), p, c);
  check('evaluate: title hits surface for ranking', result.titleHits, ['implementation']);
  check('evaluate: an unclassifiable job is unknown, not dropped', result.verdicts.experience, 'unknown');
  check('evaluate: the title gate short-circuits', evaluate(job({ title: 'Chef de Partie' }), p, c), null);
}

// ------------------------------------------------------------------ screen --
//
// `screen` is the fused form the corpus scan actually runs: one pass that stops
// asking as soon as two criteria have failed. `evaluate` + `failedKeys` +
// `classify` are the plain three-step version, and they are what every check
// above pins down. This block is the bridge between them — it asserts the fast
// path answers exactly what the readable path answers, across every criterion,
// every policy and both sides of the early-exit, so an edit to one that forgets
// the other fails here rather than silently changing what the site returns.

{
  const JOBS = [
    job(),
    job({ metros: ['sf-bay'], countries: ['us'] }),
    job({ metros: [], countries: [] }),
    job({ workplace: 'remote', remote_scope: 'worldwide', metros: [] }),
    job({ workplace: 'unknown' }),
    job({ salary_known: 1, salary_min: 90_000, salary_max: 140_000, salary_src: 'as-stated', pay_period: 'YEAR', currency: 'USD' }),
    job({ seniority: 'senior', min_years: 8, max_years: 12, years_known: 1 }),
    job({ seniority: 'entry', min_years: 0, max_years: 1, years_known: 1, age_days: 2 }),
    job({ employment_type: null, job_function: 'other', age_days: null }),
    job({ skills: ['python', 'sql'], degree: 'bachelors', visa: 1, clearance: 1, equity: 1 }),
    job({ title: 'Chef de Partie', title_norm: 'chef de partie' }),
    job({ ats: 'lever', company_size: '501-2000', currency: 'EUR', pay_period: 'HOUR' }),
  ];

  const PROFILES = [
    {},
    { metros: ['nyc'] },
    { metros: ['nyc'], workplace: ['onsite'] },
    { title_keywords: ['implementation'] },
    { exclude_title_keywords: ['chef'] },
    { salary_min: 100_000, seniority: ['mid', 'senior'] },
    { salary_min: 100_000, unknowns: { salary: 'exclude' } },
    { salary_min: 100_000, unknowns: { salary: 'separate' } },
    { metros: ['sf-bay'], salary_min: 200_000, workplace: ['remote'], unknowns: { metro: 'separate', salary: 'separate', workplace: 'exclude' } },
    { skills: ['python'], skills_match: 'all', degree: ['bachelors'] },
    { exclude_clearance: true, requires_equity: true, requires_visa_sponsorship: true },
    { posted_within_days: 7, company_size: ['6-20'], employment_type: ['FullTime'] },
    { ats: ['lever'], currencies: ['EUR'], pay_period: ['HOUR'], job_functions: ['engineering'] },
    { max_years_experience: 2, salary_stated_only: true, exclude_skills: ['php'] },
    { metros: ['nyc'], workplace: ['remote'], salary_min: 300_000, posted_within_days: 1, unknowns: { metro: 'exclude', workplace: 'exclude', salary: 'exclude', posted: 'exclude' } },
  ];

  const out = {};
  let agree = 0;
  const disagree = [];

  for (const input of PROFILES) {
    const [p, c] = withProfile(input);
    for (const row of JOBS) {
      const plain = evaluate(row, p, c);
      const gated = screen(row, p, c, out);

      // The title gate, first and identically.
      if (!plain || !gated) {
        if (Boolean(plain) === Boolean(gated)) agree++;
        else disagree.push(`title gate disagrees on ${row.title} / ${JSON.stringify(input)}`);
        continue;
      }

      const failed = failedKeys(plain.verdicts, p.unknowns, c.activeKeys);
      const bucket = classify(plain.verdicts, p.unknowns, c.activeKeys);
      const unknownOn = Object.entries(plain.verdicts).filter(([, v]) => v === 'unknown').map(([k]) => k);

      // Only what the scan reads is compared, because only that has to match:
      // past two failures `screen` stops early and its `failures` is a floor of
      // 2 rather than the exact count, which is all the caller ever asks of it.
      const same =
        JSON.stringify(plain.titleHits) === JSON.stringify(out.titleHits) &&
        (failed.length > 1 ? out.failures > 1 : out.failures === failed.length) &&
        (failed.length === 1 ? out.failedKey === failed[0] : out.failedKey === null) &&
        (failed.length ? out.bucket === null : out.bucket === bucket) &&
        (failed.length ? true : JSON.stringify(unknownOn) === JSON.stringify(out.unknownOn ?? []));

      if (same) agree++;
      else
        disagree.push(
          `${row.title} / ${JSON.stringify(input)}\n` +
            `      plain  failed=${JSON.stringify(failed)} bucket=${bucket} unknownOn=${JSON.stringify(unknownOn)}\n` +
            `      screen failures=${out.failures} failedKey=${out.failedKey} bucket=${out.bucket} unknownOn=${JSON.stringify(out.unknownOn)}`,
        );
    }
  }

  check('screen: agrees with evaluate+failedKeys+classify on every case', disagree, []);
  check('screen: the comparison actually ran', agree > 150, true);
}

// ----------------------------------------------------------------- ranking --

{
  const p = normalizeProfile({ max_years_experience: 2 }).profile;
  const two = scoreJob(job({ age_days: 1 }), p, { titleHits: ['ai', 'product'] }).score;
  const one = scoreJob(job({ age_days: 1 }), p, { titleHits: ['ai'] }).score;
  check('rank: more title keywords scores higher', two > one, true);

  const fresh = scoreJob(job({ age_days: 1 }), p, { titleHits: ['ai'] }).score;
  const stale = scoreJob(job({ age_days: 400 }), p, { titleHits: ['ai'] }).score;
  check('rank: fresher scores higher', fresh > stale, true);

  // Description hits are worth a fraction of a title hit, and capped — 93.2% of
  // jobs match at least one keyword somewhere in ~5 KB of prose.
  const manyDesc = scoreJob(job(), p, { titleHits: [], descHits: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] }).score;
  const cappedDesc = scoreJob(job(), p, { titleHits: [], descHits: ['a', 'b', 'c', 'd', 'e', 'f'] }).score;
  check('rank: description hits are capped', manyDesc, cappedDesc);
  const oneTitle = scoreJob(job(), p, { titleHits: ['ai'] }).score;
  check('rank: one title hit beats six description hits', oneTitle > cappedDesc, true);

  const known = scoreJob(job({ years_known: 1, min_years: 1, seniority: 'entry' }), p, { titleHits: ['ai'] }).score;
  const unknown = scoreJob(job({ years_known: 0, seniority: 'unknown' }), p, { titleHits: ['ai'] }).score;
  check('rank: a confirmed years fit outranks an unknown one', known > unknown, true);
}
{
  const rows = [
    { job: job({ id: 'b', age_days: 30 }), score: 10 },
    { job: job({ id: 'a', age_days: 5 }), score: 10 },
    { job: job({ id: 'c', age_days: 1 }), score: 20 },
  ];
  check('rank: sorted by score, then recency', sortByScore(rows).map((r) => r.job.id), ['c', 'a', 'b']);
}
// -------------------------------------------------- the filters added later --
// Every one of these is a criterion over a column that was already in the
// database and had no way to reach it. The cases that matter are the same ones
// that mattered for the original thirteen: what each returns when the posting
// said nothing.
{
  const [p, c] = withProfile({ remote_scope: ['worldwide'] });
  check('remote scope: a match', matchRemoteScope(job({ workplace: 'remote', remote_scope: 'worldwide' }), p, c), 'match');
  check('remote scope: a different reach', matchRemoteScope(job({ workplace: 'remote', remote_scope: 'country' }), p, c), 'no');
  // The one place a blank is a confident no rather than a silence: an onsite
  // job has already answered, via the workplace field.
  check('remote scope: an onsite job is a no, not an unknown', matchRemoteScope(job({ workplace: 'onsite' }), p, c), 'no');
  check('remote scope: a remote job that never said is unknown', matchRemoteScope(job({ workplace: 'remote' }), p, c), 'unknown');
  check('remote scope: workplace unknown too is unknown', matchRemoteScope(job({ workplace: 'unknown' }), p, c), 'unknown');
  const [inactive, ic] = withProfile({});
  check('remote scope: inactive criterion matches everything', matchRemoteScope(job({ workplace: 'onsite' }), inactive, ic), 'match');
}
{
  const [p, c] = withProfile({ pay_period: ['hour'] });
  check('pay period: lowercase input is accepted', p.pay_period, ['HOUR']);
  check('pay period: a match', matchPayPeriod(job({ pay_period: 'HOUR' }), p, c), 'match');
  check('pay period: a salaried job', matchPayPeriod(job({ pay_period: 'YEAR' }), p, c), 'no');
  check('pay period: nothing published is unknown', matchPayPeriod(job(), p, c), 'unknown');
}
{
  const [p, c] = withProfile({ currencies: ['eur'] });
  check('currency: uppercased', p.currencies, ['EUR']);
  check('currency: a match', matchCurrency(job({ currency: 'EUR' }), p, c), 'match');
  check('currency: another currency', matchCurrency(job({ currency: 'USD' }), p, c), 'no');
  check('currency: nothing published is unknown', matchCurrency(job(), p, c), 'unknown');
  check('currency: a bad code is dropped with a warning', normalizeProfile({ currencies: ['EUR', 'euros'] }).profile.currencies, ['EUR']);
}
{
  const [p, c] = withProfile({ requires_equity: true });
  check('equity: a match', matchEquity(job({ equity: 1 }), p, c), 'match');
  // Ashby writes 1 or nothing — no posting in the corpus says "no equity" — so
  // answering `no` here would be inventing an answer nobody gave.
  check('equity: silence is unknown and never a no', matchEquity(job({ equity: null }), p, c), 'unknown');
  check('equity: never a no even for a 0', matchEquity(job({ equity: 0 }), p, c), 'unknown');
}
{
  const [p, c] = withProfile({ salary_stated_only: true });
  check('pay source: as published', matchSalarySource(job({ salary_known: 1, salary_src: 'as-stated' }), p, c), 'match');
  check('pay source: reinterpreted', matchSalarySource(job({ salary_known: 1, salary_src: 'reinterpreted:YEAR->HOUR' }), p, c), 'no');
  check('pay source: no figure at all is unknown', matchSalarySource(job({ salary_known: 0 }), p, c), 'unknown');
}
{
  const [p, c] = withProfile({ company_size: ['6-20'] });
  check('company size: a match', matchCompanySize(job(), p, c), 'match');
  check('company size: another band', matchCompanySize(job({ company_size: '500+' }), p, c), 'no');
  check('company size: bands are contiguous', [1, 2, 5, 6, 20, 21, 100, 101, 500, 501, 9999].map(companySizeBand),
    ['1', '2-5', '2-5', '6-20', '6-20', '21-100', '21-100', '101-500', '101-500', '500+', '500+']);
}
// What the company does — the one column a model wrote. Three things pinned
// here: a company nobody has read is unknown and not a no; `other` is unknown
// unless asked for by name; and the exclusion fires only on a company the
// model placed. "Not finance" must never drop the bank whose postings did not
// say it was one — that would be the largest silent exclusion in the engine,
// because the unread share is every board the pass has not reached.
{
  const [p, c] = withProfile({ sectors: ['fintech'] });
  check('sector: a match', matchSector(job({ sector: 'fintech' }), p, c), 'match');
  check('sector: another sector is a no', matchSector(job({ sector: 'healthcare' }), p, c), 'no');
  check('sector: a company nobody has read is unknown', matchSector(job(), p, c), 'unknown');
  check('sector: "other" is unknown, not a no', matchSector(job({ sector: 'other' }), p, c), 'unknown');
  const [po, co] = withProfile({ sectors: ['other'] });
  check('sector: unless "other" is what was asked for', matchSector(job({ sector: 'other' }), po, co), 'match');

  const [px, cx] = withProfile({ exclude_sectors: ['financial-services'] });
  check('exclude sector: fires on evidence', matchSector(job({ sector: 'financial-services' }), px, cx), 'no');
  check('exclude sector: not on a different sector', matchSector(job({ sector: 'fintech' }), px, cx), 'match');
  check('exclude sector: never on silence', matchSector(job(), px, cx), 'match');
  check('exclude sector: nor on "other"', matchSector(job({ sector: 'other' }), px, cx), 'match');
  const [pb, cb] = withProfile({ sectors: ['fintech', 'financial-services'], exclude_sectors: ['financial-services'] });
  check('exclude sector: outranks an inclusion', matchSector(job({ sector: 'financial-services' }), pb, cb), 'no');

  const asked = CRITERIA.find((x) => x.key === 'sector').asked;
  check('sector: an exclusion alone is a live criterion', asked(px, cx), true);
  check('sector: nothing asked is inactive', asked(...withProfile({})), false);
  check('sector: is on the unknown roster', UNKNOWNABLE.some((u) => u.key === 'sector'), true);
  check('sector: and defaults to keeping the silent ones', UNKNOWNABLE.find((u) => u.key === 'sector').default, 'include');

  // The profile side: the vocabulary is the schema's, and a value outside it
  // is dropped out loud rather than stored as a criterion that matches nothing.
  const { profile, warnings } = normalizeProfile({ sectors: ['fintech', 'vibes'], exclude_sectors: ['FINANCE'] });
  check('sector: an unknown value is dropped', profile.sectors, ['fintech']);
  check('sector: and named', warnings.some((w) => w.includes('vibes')), true);
  check('sector: exclusions are validated the same way', [profile.exclude_sectors, warnings.some((w) => w.includes('FINANCE'))], [[], true]);
  check('sector: both halves are active criteria', activeCriteria(normalizeProfile({ sectors: ['ai'], exclude_sectors: ['gaming'] }).profile).filter((a) => a.key === 'sector').length, 2);
}

{
  // The negative half of the skills panel. An exclusion outranks an inclusion,
  // and cannot fire on a posting that named no skills at all.
  const [p, c] = withProfile({ skills: ['python'], exclude_skills: ['php'] });
  check('skill exclusions: named the one you avoid', matchSkills(job({ skills: ['python', 'php'] }), p, c), 'no');
  check('skill exclusions: named only the one you want', matchSkills(job({ skills: ['python'] }), p, c), 'match');
  check('skill exclusions: cannot fire on silence', matchSkills(job({ skills: [] }), p, c), 'unknown');
}

// ------------------------------------------------------------------- sorts --
{
  const rows = [
    { job: job({ id: 'a', age_days: 40, salary_known: 1, salary_min: 90_000, salary_max: 110_000, quality: 0.4 }), score: 5 },
    { job: job({ id: 'b', age_days: 2, salary_known: 0, quality: 0.9 }), score: 5 },
    { job: job({ id: 'c', age_days: 400, salary_known: 1, salary_min: 200_000, salary_max: 240_000, quality: 0.6 }), score: 5 },
  ];
  const order = (sort) => sortRows([...rows], sort).map((r) => r.job.id);
  check('sort: newest', order('newest'), ['b', 'a', 'c']);
  check('sort: oldest', order('oldest'), ['c', 'a', 'b']);
  check('sort: most complete', order('quality'), ['b', 'c', 'a']);
  // The rule that makes a sort control safe to ship: a job with no published
  // figure sinks under either direction, and stays in the list.
  check('sort: highest pay puts the silent job last', order('salary-high'), ['c', 'a', 'b']);
  check('sort: lowest pay also puts the silent job last', order('salary-low'), ['a', 'c', 'b']);
  check('sort: an unknown name falls back to the score', order('nonsense').length, 3);
  check('sort: an unknown name is rejected in the profile', normalizeProfile({ sort: 'nonsense' }).profile.sort, 'relevance');
  check('sort: a real name survives', normalizeProfile({ sort: 'newest' }).profile.sort, 'newest');
}

// ---------------------------------------------------------- salary ladder --
{
  check('ladder: too few figures falls back to the fixed bands', salaryLadder([1, 2, 3]), SALARY_BANDS);
  const many = Array.from({ length: 200 }, (_, i) => 50_000 + i * 1_000);
  const ladder = salaryLadder(many);
  check('ladder: unknown is always the first rung', ladder[0][0], 'unknown');
  check('ladder: rungs are contiguous', ladder.slice(1).every(([, lo], i, a) => i === 0 || lo === a[i - 1][2]), true);
  check('ladder: the last rung is open-ended', ladder[ladder.length - 1][2], Infinity);
  // A result set where every figure is the same number cannot be cut into
  // quintiles, so it keeps the fixed ladder rather than printing four bands
  // with the same label.
  check('ladder: one repeated figure falls back', salaryLadder(Array(200).fill(120_000)), SALARY_BANDS);
}

check('salary label: a range', salaryLabel({ salary_known: 1, salary_min: 85000, salary_max: 125000 }), '$85k–$125k');
check('salary label: millions read as millions', salaryLabel({ salary_known: 1, salary_min: 1_591_000, salary_max: 1_945_000 }), '$1.6m–$1.9m');
check('salary label: a single figure', salaryLabel({ salary_known: 1, salary_min: 90000, salary_max: 90000 }), '$90k');
check('salary label: nothing published', salaryLabel({ salary_known: 0 }), null);

// ------------------------------------------------------- the search box --
/**
 * FTS5 matches whole tokens, so a search box that hands it what was typed
 * answers "no such company" to every prefix of a company it has jobs from —
 * `afterque` found nothing until the `ry` arrived. These are the two halves of
 * the fix: half-typed words become prefixes, and a query written *at* FTS5 is
 * still left exactly as written.
 */
{
  check('search: a half-typed word becomes a prefix', textQuery('afterque'), '"afterque"*');
  check('search: so does a whole one — nothing narrows on the last letter', textQuery('afterquery'), '"afterquery"*');
  check('search: every word gets one, joined by AND', textQuery('data eng'), '"data"* AND "eng"*');
  check('search: punctuation splits words the way the index split them', textQuery('react-native'), '"react"* AND "native"*');

  // A one- or two-letter prefix matches 341,582 of 341,589 documents in 1.5 s.
  // It is not a filter, it is a full scan with a wildcard on it — and `go` is
  // a language, not the first half of `governance`.
  check('search: short words stay exact', textQuery('go'), '"go"');
  check('search: including the ones inside a longer query', textQuery('ai jobs'), '"ai" AND "jobs"*');
  check('search: c++ is the word c, not FTS syntax', textQuery('c++'), '"c"');

  // Someone who reached for FTS5 syntax meant it. Widening `"staff engineer"`
  // into a prefix search would hand back the narrow result they asked to avoid.
  check('search: a quoted phrase is left alone', textQuery('"staff engineer"'), '"staff engineer"');
  check('search: a column filter is left alone', textQuery('company:(stripe OR block)'), 'company:(stripe OR block)');
  check('search: an operator is left alone', textQuery('data NOT analyst'), 'data NOT analyst');
  // Lowercase `and` is not an FTS5 operator — it is a word someone typed.
  check('search: a lowercase and is just a word', textQuery('research and development'), '"research"* AND "and"* AND "development"*');

  check('search: an empty box is an empty query', textQuery('   '), '');
  check('search: an apostrophe splits a word, as it does in the index', textQuery("o'neill"), '"o" AND "neill"*');
}

// ------------------------------------------------------- whose profile is it --
/**
 * The `owner` field, which decides what a visitor's first screen is.
 *
 * Two properties here are load-bearing and neither is obvious from the name.
 * The first is that an *absent* owner means everyone's, not nobody's — the same
 * three-valued instinct as the rest of this file, applied to a document rather
 * than a job: a blank field is not a claim. The second is the **ordering**.
 * The app boots into `profiles[0]`, so "yours first" is not presentation; it is
 * the whole of "sign in and your filters are already there", and a sort that
 * quietly stopped putting them first would look fine on screen and silently
 * hand every visitor a stranger's job search again.
 */
{
  check('owner: absent means everyone\'s', ownerOf({ name: 'starter' }), null);
  check('owner: blank is not a claim', ownerOf({ owner: '   ' }), null);
  check('owner: normalized on the way out', ownerOf({ owner: '  Someone@Example.COM ' }), 'someone@example.com');

  check('owned by: an unowned profile is everyone\'s', ownedBy(null, 'someone@example.com'), true);
  check('owned by: including a signed-out visitor', ownedBy(null, null), true);
  check('owned by: address case does not matter', ownedBy('someone@example.com', 'SOMEONE@Example.com'), true);
  check('owned by: a different address is not the owner', ownedBy('someone@example.com', 'other@example.com'), false);
  // The one that keeps a private profile private on a server nobody signed in
  // to: no session must never read as "no owner to satisfy".
  check('owned by: signed out is not the owner', ownedBy('someone@example.com', null), false);

  const all = [
    { name: 'hers', owner: 'someone@example.com' },
    { name: 'starter', owner: null },
    { name: 'his', owner: 'other@example.com' },
  ];
  const names = (email) => profilesVisibleTo(email, all).map((p) => p.name);
  check('visible: signed out sees only the unowned ones', names(null), ['starter']);
  check('visible: a stranger sees only the unowned ones', names('nobody@example.com'), ['starter']);
  check('visible: an owner sees theirs, and theirs is first', names('someone@example.com'), ['hers', 'starter']);
  check('visible: and still not the other owner\'s', names('someone@example.com').includes('his'), false);

  // The starter is declared, not the accident of which filename sorts first.
  // It was an accident once: a shared profile saved under a name that sorted
  // before the starter's became what every stranger opened on, with nothing
  // failing to say so.
  const byName = (rows) => rows.map((p) => p.name);
  check(
    'starter: sorts first regardless of filename',
    byName(sortProfiles([{ name: 'aaa' }, { name: 'zzz', starter: true }, { name: 'mmm' }])),
    ['zzz', 'aaa', 'mmm'],
  );
  check(
    'starter: the rest stay in name order',
    byName(sortProfiles([{ name: 'b' }, { name: 'a' }, { name: 's', starter: true }])),
    ['s', 'a', 'b'],
  );
  const untouched = [{ name: 'b' }, { name: 'a' }];
  sortProfiles(untouched);
  check('starter: sorting does not reorder its input', byName(untouched), ['b', 'a']);
  const withStarter = [
    { name: 'a-lever-only', owner: null },
    { name: 'recent-openings', owner: null, starter: true },
    { name: 'hers', owner: 'someone@example.com' },
  ];
  check(
    'starter: a stranger sees the starter first',
    byName(profilesVisibleTo('nobody@example.com', withStarter)),
    ['recent-openings', 'a-lever-only'],
  );
  check(
    'starter: signed out, likewise',
    byName(profilesVisibleTo(null, withStarter)),
    ['recent-openings', 'a-lever-only'],
  );
  check(
    'starter: an owner still boots into their own, and the starter comes next',
    byName(profilesVisibleTo('someone@example.com', withStarter)),
    ['hers', 'recent-openings', 'a-lever-only'],
  );
  // And the shipped directory, which is where this went wrong: the first
  // profile a stranger sees must be the one whose notes say it is the starter.
  const shipped = profilesVisibleTo(null);
  check('starter: the shipped starter is recent-openings', shipped[0]?.name, 'recent-openings');
  check('starter: and it is flagged as such', shipped[0]?.starter, true);
  check('starter: listProfiles exposes the flag on every row', listProfiles().every((p) => typeof p.starter === 'boolean'), true);
  check('starter: exactly one shipped profile is the starter', listProfiles().filter((p) => p.starter).length, 1);
}

// --------------------------------------------------------------------- done --
if (failures.length) {
  console.error(`\n${failures.length} failing:\n`);
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  console.error(`${passed} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`✓ ${passed} filter checks passed`);
