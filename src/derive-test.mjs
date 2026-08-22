#!/usr/bin/env node
/**
 * Derivation tests.
 *
 *   node src/derive-test.mjs
 *
 * Every case here is a real string from the swept corpus or a bug that was
 * actually shipped and caught — `Baden-Wurttemberg` shattering into phantom
 * `baden` and `wurttemberg` metros, `Solutions Architect` classified as
 * principal, `Singapore, SG` losing its metro to the country table. The point
 * is that improving a rule later cannot silently reintroduce one of them.
 *
 * No database and no network: these are pure functions, so the suite runs in
 * milliseconds and can be run before every re-derive.
 */

import { parseFragment, deriveLocation } from './lib/derive/location.mjs';
import { deriveWorkplace } from './lib/derive/workplace.mjs';
import { deriveSalary } from './lib/derive/salary.mjs';
import { extractYears, collapseYears, seniorityFromTitle } from './lib/derive/seniority.mjs';
import { deriveJobFunction } from './lib/derive/job-function.mjs';
import { deriveSignals } from './lib/derive/signals.mjs';
import { fold, hasTerm } from './lib/derive/text.mjs';

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed++;
  else failures.push(`${name}\n      got      ${a}\n      expected ${e}`);
}

const metrosOf = (s) => [...parseFragment(s).metros].sort();
const countriesOf = (s) => [...parseFragment(s).countries].sort();

// ------------------------------------------------------------------ matching --
check('word-boundary: paid !~ ai', hasTerm(fold('Paid Social Account Director'), 'ai'), false);
check('word-boundary: supply chain !~ ai', hasTerm(fold('Supply Chain Manager'), 'ai'), false);
check('word-boundary: AI/ML ~ ai', hasTerm(fold('AI/ML Engineer'), 'ai'), true);
check('word-boundary: (AI) ~ ai', hasTerm(fold('Engineer (AI)'), 'ai'), true);
check('word-boundary: Especialista !~ specialist', hasTerm(fold('Especialista de Producto'), 'specialist'), false);
check('word-boundary: Geotechnical !~ technical', hasTerm(fold('Geotechnical Engineer'), 'technical'), false);
check('word-boundary: JavaScript !~ java', hasTerm(fold('JavaScript Engineer'), 'java'), false);
check('punctuation term: c++', hasTerm(fold('Senior C++ Developer'), 'c++'), true);
check('punctuation term: .net', hasTerm(fold('.NET Engineer'), '.net'), true);

// ------------------------------------------------------------------ location --
check('plain city', metrosOf('New York City'), ['nyc']);
check('city + state', metrosOf('New York, NY'), ['nyc']);
check('borough', metrosOf('Brooklyn, NY'), ['nyc']);
check('two metros in one string', metrosOf('NYC | SF'), ['nyc', 'sf-bay']);
check('decorator stripped', metrosOf('San Francisco Office'), ['sf-bay']);
check('preposition stripped', metrosOf('In person in New York City'), ['nyc']);
check('slash-separated cities', metrosOf('Metzingen / Riederich'), ['stuttgart']);
check('country-first ordering', metrosOf('United States, New York, New York City'), ['nyc']);
check('abbreviated DC', metrosOf('Washington D.C, New York'), ['dc', 'nyc']);
// Regression: replacing every hyphen split these into `baden`/`wurttemberg` and `ile`.
check('hyphenated region survives', metrosOf('Riederich, Baden-Wurttemberg, Germany'), ['stuttgart']);
check('hyphenated French region survives', metrosOf('Paris, Île-de-France, France'), ['paris']);
check('hyphenated city survives', metrosOf('Boulogne-Billancourt, France'), ['paris']);
// Regression: `newark` is NYC-metro, `newark, ca` is Bay Area.
check('same name, two metros (NJ)', metrosOf('Newark, NJ'), ['nyc']);
check('same name, two metros (CA)', metrosOf('Newark, CA'), ['sf-bay']);
// Regression: city-states were consumed by the country table and lost their metro.
check('city-state keeps metro', metrosOf('Singapore, SG'), ['singapore']);
check('city-state bare', metrosOf('Hong Kong'), ['hong-kong']);
check('country only, no metro', metrosOf('United States'), []);
check('supranational, no metro', metrosOf('Europe'), []);
check('bare remote, no metro', metrosOf('Remote'), []);
check('remote + country scope', countriesOf('Remote - US'), ['us']);
check('remote flag set', parseFragment('Remote - US').remote, true);
check('remote + city keeps city', metrosOf('New York - Remote'), ['nyc']);
// Regression: ISO2 codes resolved to nothing; `CA` must stay California.
check('ISO2 country code', countriesOf('Seoul, KR'), ['kr']);
check('CA is California, not Canada', metrosOf('San Francisco, CA'), ['sf-bay']);
check('explicit Canada', countriesOf('Toronto, ON, Canada'), ['ca']);
// Regression: an address line minted `pangyo-software-dream-center` as a metro.
check('facility name rejected', metrosOf('Pangyo Software Dream Center'), []);
check('street address rejected', metrosOf('829 Boston Post Road'), []);
check('four-word city allowed', metrosOf('Ho Chi Minh City'), ['ho-chi-minh-city']);
check('street abbreviation not overblocked', metrosOf('St Louis, MO'), ['st-louis']);
check('unions across all signals', deriveLocation({
  locations_all: '["Remote","Brooklyn, NY"]', location_raw: 'Remote', city: 'NYC', region: 'NY',
}).metros, ['nyc']);

// ----------------------------------------------------------------- workplace --
const noLoc = { metros: [], remoteHint: false };
check('enum wins', deriveWorkplace({ raw_workplace: 'Hybrid', raw_remote: 1 }, noLoc).workplace, 'hybrid');
// Regression: isRemote is true on every Hybrid job, so it must never decide.
check('isRemote=true does not mean remote', deriveWorkplace({ raw_workplace: 'Hybrid', raw_remote: 1 }, noLoc).workplace, 'hybrid');
check('null enum + remote text', deriveWorkplace({ raw_workplace: null, raw_remote: null }, { metros: [], remoteHint: true }).workplace, 'remote');
check('null enum + a real place', deriveWorkplace({ raw_workplace: null, raw_remote: null }, { metros: ['nyc'], remoteHint: false }).workplace, 'onsite');
check('null enum, no signal', deriveWorkplace({ raw_workplace: null, raw_remote: null }, noLoc).workplace, 'unknown');

// -------------------------------------------------------------------- salary --
const sal = (o) => { const r = deriveSalary(o); return [r.salary_min, r.salary_max, r.salary_known]; };
check('annual as stated', sal({ comp_min: 250000, comp_max: 300000, comp_currency: 'USD', comp_interval: 'YEAR' }), [250000, 300000, 1]);
check('hourly annualised', sal({ comp_min: 42, comp_max: 55, comp_currency: 'USD', comp_interval: 'HOUR' }), [87360, 114400, 1]);
check('monthly EUR annualised', sal({ comp_min: 9000, comp_max: 12000, comp_currency: 'EUR', comp_interval: 'MONTH' }), [117720, 156960, 1]);
// Regression: the interval field lies on 154 rows.
check('mislabelled hourly repaired', sal({ comp_min: 30, comp_max: 50, comp_currency: 'USD', comp_interval: 'YEAR' }), [62400, 104000, 1]);
check('absurd figure refused', sal({ comp_min: 310000000, comp_max: null, comp_currency: 'USD', comp_interval: 'YEAR' }), [null, null, 0]);
check('$1/yr refused', sal({ comp_min: 1, comp_max: 1, comp_currency: 'USD', comp_interval: 'YEAR' }), [null, null, 0]);
check('no figure', sal({ comp_min: null, comp_max: null, comp_currency: null, comp_interval: 'NONE' }), [null, null, 0]);
// Regression: plausibility used to be tested on the bottom of the range only.
// `$200.00–$400000.00 YEAR` read its min as an hourly rate — $200/hr is $416k
// and perfectly sane — then annualised the max the same way, producing a
// salary of $832,000,000. 59 open postings carried a figure over $2M for this
// reason and every one of them sat at the top of any list ordered by pay.
// A range only reads if the *whole* range reads.
check('mixed range refused', sal({ comp_min: 200, comp_max: 400000, comp_currency: 'USD', comp_interval: 'YEAR' }), [null, null, 0]);
check('inverted range refused', sal({ comp_min: 200000, comp_max: 90000, comp_currency: 'USD', comp_interval: 'YEAR' }), [null, null, 0]);
check('a sane range still reads under the same rule', sal({ comp_min: 60, comp_max: 90, comp_currency: 'USD', comp_interval: 'YEAR' }), [124800, 187200, 1]);

// ----------------------------------------------------------------- seniority --
check('senior title', seniorityFromTitle('Senior Software Engineer')?.level, 'senior');
check('bare Lead is not entry', seniorityFromTitle('Lead Engineer')?.level, 'senior');
check('team lead is a manager', seniorityFromTitle('Team Lead, Support')?.level, 'manager');
check('rank suffix', seniorityFromTitle('Engineer II')?.level, 'entry');
check('no marker', seniorityFromTitle('Software Engineer'), null);
// Regression: `architect` read as principal, hiding ordinary GTM roles.
check('Solutions Architect is not principal', seniorityFromTitle('Solutions Architect'), null);
check('Principal Architect still principal', seniorityFromTitle('Principal Architect')?.level, 'principal');
// Regression: `Account Manager` is not a people manager.
check('account manager is not a manager', seniorityFromTitle('Account Manager'), null);
check('engineering manager is', seniorityFromTitle('Engineering Manager')?.level, 'manager');
check('rank digit not matched mid-title', seniorityFromTitle('Type 2 Diabetes Specialist'), null);

const yrs = (s) => collapseYears(extractYears(s));
check('plus form', yrs('5+ years of experience in sales').min, 5);
check('range with en dash', yrs('3–7+ years of SaaS sales experience').min, 3);
check('minimum-of form', yrs('Minimum of 5 years of experience required').min, 5);
check('number word', yrs('At least two years of relevant experience').min, 2);
// Regression: company boilerplate read as a requirement.
check('boilerplate ignored', yrs('We have been building products for the last 15 years.').known, 0);
check('no context, no match', yrs('The 5 years since our founding').known, 0);
// Strictest-wins: measured to move 23% of the "<=2 years" bucket.
check('strictest of several claims', yrs('5+ years of experience in sales. 1+ year of experience with Salesforce.').min, 5);

// An age is not an experience requirement, however qualified the heading above
// it. Read as experience this is a `staff` job at 21 years; it is entry-level
// retail, and a years cap was excluding 721 such jobs.
check('age is not experience', yrs('Minimum Qualifications:\n- Must be 18 years of age or older.').known, 0);
check('age with a real claim beside it', yrs('Must be 21 years of age. 2+ years of experience in retail.').min, 2);
check('tenure is not experience', yrs('Sabbatical after 5 years of service. Requires relevant background.').known, 0);
check('years ago is not experience', yrs('Our required rebuild shipped 6 years ago.').known, 0);

// A claim that starts its own line is a requirement bullet, whatever nouns
// follow it — the case `CONTEXT_RE` alone cannot reach. Recovers 7,774 jobs.
check('bullet needs no keyword', yrs("What You'll Bring\n6+ years in customer-facing roles (Product, Consulting)").min, 6);
check('dashed bullet', yrs('- 3 - 5+ years in a technical, customer-facing role').min, 3);
check('bullet range keeps its ceiling', yrs('• 2-4 years in a quantitative or analytical role').max, 4);
// The bullet rule is about line starts only: the same words mid-sentence are
// still boilerplate, so it must not reopen what ANTI_CONTEXT closed.
check('mid-sentence is still not a bullet', yrs('We spent 15 years in customer-facing roles.').known, 0);
check('bullet age still rejected', yrs('- 18 years of age with a high school diploma').known, 0);
// `or` sits between the figure and the noun, so the bare-word forms miss it.
check('21 years or older', yrs('Hiring requirements\n- Must be 21 years or older\n- Must pass a background check').known, 0);
check('18 years and up', yrs('Requirements: 18 years and up.').known, 0);

// Present-tense company boast. `experience` sits in the sentence, so CONTEXT_RE
// trusts it and strictest-wins then prefers it over the real requirement.
check('with over N years is the company', yrs('A cybersecurity forerunner with more than 30 years of experience.').known, 0);
check('for over N years is the company', yrs('Leader in the industry for over 40 years of proven expertise.').known, 0);
check('nearly N years is the company', yrs('Proven success: nearly 20 years serving local communities.').known, 0);
check('company boast loses to the real requirement',
  yrs('We have served customers with over 40 years of experience.\n- 3+ years of experience in sales').min, 3);
// `with`/`for` unqualified still precede real requirements, and an entry-level
// ceiling is exactly the row a years cap exists to find.
check('for at least N years still counts', yrs('Field experience for at least 4 years required').min, 4);
check('up to N years is a real ceiling', yrs('- Up to 2 years of relevant work experience').min, 2);
// `backed by` and `building on` carry the boast with or without a qualifier.
check('building on N years', yrs('An investment firm building on more than 30 years of investing experience.').known, 0);
check('backed by N years', yrs('We are backed by 30 years of infrastructure and proven expertise.').known, 0);
check("possessive years' of age", yrs("Cashiers must be 16 years' of age to apply, per requirements.").known, 0);

// -------------------------------------------------------------- job function --
check('job function: engineering', deriveJobFunction({ title: 'Software Engineer' }), 'engineering');
check('job function: implementation is CS', deriveJobFunction({ title: 'Implementation Specialist' }), 'customer-success');
check('job function: deployment is CS', deriveJobFunction({ title: 'AI Deployment Strategist' }), 'customer-success');
check('job function: sales', deriveJobFunction({ title: 'Account Executive' }), 'sales');
check('job function: healthcare', deriveJobFunction({ title: 'Registered Nurse' }), 'healthcare');
check('job function: falls back to department', deriveJobFunction({ title: 'Team Member', department: 'Marketing' }), 'marketing');

// ------------------------------------------------------------------- signals --
const sig = (text) => deriveSignals({}, text, { salary_known: 0, years_known: 0, workplace: 'unknown', metros: [] });
check('visa: refusal', sig('We are unable to provide visa sponsorship.').visa, 0);
check('visa: refusal, other phrasing', sig('We do not offer sponsorship at this time.').visa, 0);
check('visa: offered', sig('Visa sponsorship is available.').visa, 1);
// Regression: a `not` in the previous sentence flipped the answer.
check('visa: sentence-bounded', sig('This role is not remote. Sponsorship is available.').visa, 1);
check('clearance', sig('Requires an active TS/SCI clearance.').clearance, 1);
check('degree: bachelors', sig("Bachelor's degree required.").degree, 'bachelors');
check('degree: phd beats bachelors', sig("PhD or Bachelor's degree").degree, 'phd');
check('skills deduped and sorted', sig('We use Python, python, and PostgreSQL.').skills, ['postgresql', 'python']);

// --------------------------------------------------------------------- done --
if (failures.length) {
  console.error(`\n${failures.length} failing:\n`);
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  console.error(`${passed} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`✓ ${passed} derivation checks passed`);
