#!/usr/bin/env node
/**
 * "Describe your search" tests.
 *
 *   node src/interpret-test.mjs
 *
 * Same contract as the other three: no network, no API key, no jobs.db, and
 * milliseconds to run. That is possible because `interpret.mjs` is split at the
 * one seam worth splitting it at — `interpret()` makes the API call, and
 * `buildProfile()` turns whatever came back into a filter document. Everything
 * that can be wrong in a way that matters lives in the second half.
 *
 * Two of the checks below are the reason this file exists at all.
 *
 * **The unknown-policy rule.** A filter here may rule a job out on what a
 * posting says, never on what it leaves blank, and a language model handed a
 * salary floor will reach for `exclude` on silence unless something stops it.
 * The prompt asks; this asserts. `exclude` may only ever appear for a criterion
 * named in `exclude_when_unstated`, and the first test would fail loudly if a
 * later refactor let any other path set one.
 *
 * **Place resolution.** The metro registry is 24,576 rows and the model writes
 * free text at it, so the failure mode is a filter that matches nothing and
 * says nothing. Every place that does not resolve has to come back named, in
 * `unresolved` and in a warning — a silent empty metro list would be the exact
 * bug the facet counts exist to prevent, reintroduced through a side door.
 */

import { DatabaseSync } from 'node:sqlite';
import {
  buildProfile,
  diffCriteria,
  explain,
  rateLimit,
  refund,
  wasFree,
  CALLS_PER_HOUR,
  filterTool,
  resolvePlaces,
  vocabulary,
  aiConfig,
  aiMeta,
  MAX_TEXT,
} from './lib/interpret.mjs';
import { DEFAULT_MODEL } from './lib/interpret.mjs';
import { UNKNOWNABLE } from './lib/filter/profile.mjs';
import { JOB_FUNCTIONS, WORKPLACE_TYPES, SENIORITY_LEVELS, EMPLOYMENT_TYPES } from './lib/schema.mjs';
import { SKILL_TERMS } from './lib/derive/signals.mjs';

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed++;
  else failures.push(`${name}\n      got      ${a}\n      expected ${e}`);
}

/**
 * A corpus, in memory: eight metros and four jobs. Enough for every resolution
 * path — exact id, exact label, prefix, contains, country code, country name —
 * without a 4.5 GB file or a sweep.
 */
function corpus() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE metros (id TEXT PRIMARY KEY, label TEXT NOT NULL, country TEXT, job_count INTEGER DEFAULT 0);
    CREATE TABLE jobs (id TEXT PRIMARY KEY, ats TEXT, is_open INTEGER, d_countries TEXT);
  `);
  const metro = db.prepare('INSERT INTO metros (id, label, country, job_count) VALUES (?, ?, ?, ?)');
  metro.run('nyc', 'New York City', 'us', 9000);
  metro.run('sf-bay', 'San Francisco Bay Area', 'us', 8000);
  metro.run('portland-or', 'Portland', 'us', 900);
  metro.run('portland-me', 'Portland, Maine', 'us', 40);
  metro.run('london', 'London', 'gb', 3000);
  metro.run('berlin', 'Berlin', 'de', 1200);
  metro.run('boston', 'Boston', 'us', 2200);
  metro.run('toronto', 'Toronto', 'ca', 800);
  metro.run('austin', 'Austin', 'us', 5000);
  // The decoy, and it is a real row in the real registry: a posting whose whole
  // location string was "Germany". Two jobs. A country filter is eleven thousand.
  metro.run('germany', 'Germany', 'de', 2);

  // `d_countries` is a JSON array in the real schema, because a job can be in
  // more than one. The fixture matches it exactly — a scalar here would let a
  // query that cannot read the real column pass.
  const job = db.prepare('INSERT INTO jobs (id, ats, is_open, d_countries) VALUES (?, ?, ?, ?)');
  job.run('ashby:a:1', 'ashby', 1, '["us"]');
  job.run('greenhouse:b:1', 'greenhouse', 1, '["gb"]');
  job.run('lever:c:1', 'lever', 1, '["de","at"]'); // two countries, one job
  job.run('lever:c:2', 'lever', 0, '["fr"]'); // closed — its country is not in the vocabulary
  return db;
}

const db = corpus();

// ------------------------------------------------------------ vocabulary --
{
  const vocab = vocabulary(db);
  check('vocabulary: only ATSes with open jobs', vocab.ats.map((a) => a.value).sort(), ['ashby', 'greenhouse', 'lever']);
  check('vocabulary: countries come from open jobs only', vocab.countries, ['at', 'de', 'gb', 'us']);
  check('vocabulary: metros are the busiest first', vocab.metros[0].id, 'nyc');
}

// --------------------------------------------------------------- places --
{
  const one = (name) => resolvePlaces(db, [name]);

  check('place: an exact metro id', one('nyc').metros, ['nyc']);
  check('place: an exact label, any case', one('New York City').metros, ['nyc']);
  check('place: a label the model wrote lowercase', one('san francisco bay area').metros, ['sf-bay']);
  // Strictness, which is the fix rather than a shortcoming: on the real
  // registry a prefix pass turned every unrecognised word into some 2-job metro
  // nobody meant. Knowing that "Berl" is Berlin is the model's job, and it does
  // it by picking the id off the list the tool serves.
  check('place: a prefix does not resolve', one('Berl').metros, []);
  check('place: and is named instead', one('Berl').unresolved, ['Berl']);

  // The bug this whole pass exists for. The registry contains a metro labelled
  // "Germany" with two jobs in it; the country has thousands. Country first.
  check('place: a country beats a metro of the same name', one('Germany'), { metros: [], countries: ['de'], unresolved: [] });

  // "Austin, Texas" and "Austin" are one request.
  check('place: a trailing region qualifier is dropped', one('Austin, Texas').metros, ['austin']);
  check('place: as is a leading "the"', one('the Bay Area').unresolved, ['the Bay Area']);
  // The busy one, not the first one inserted: someone typing "Portland" means
  // the Portland with 900 open roles, and the resolved label is on screen if
  // they meant the other.
  check('place: ambiguous resolves to the busier metro', one('Portland').metros, ['portland-or']);
  check('place: a two-letter country code in the corpus', one('de').countries, ['de']);
  check('place: a country by name', one('Germany').countries, ['de']);
  check('place: UK is a country, not a metro', one('UK').countries, ['gb']);
  check('place: the United States by any of its names', one('USA').countries, ['us']);

  // A country with no open jobs is not an answer. Resolving `fr` here would
  // build a filter that can only ever return nothing.
  check('place: a country with no open jobs is unresolved', one('France').unresolved, ['France']);
  check('place: and sets no filter', one('France').countries, []);

  check('place: nonsense comes back named', one('Wakanda').unresolved, ['Wakanda']);
  check('place: several at once', resolvePlaces(db, ['nyc', 'London', 'Atlantis']), {
    metros: ['nyc', 'london'],
    countries: [],
    unresolved: ['Atlantis'],
  });
  check('place: duplicates collapse', resolvePlaces(db, ['nyc', 'New York City']).metros, ['nyc']);
}

// ------------------------------------------------- the unknown-policy rule --
{
  // The whole point. A model that sets a salary floor, a degree, a workplace and
  // a date must not have quietly turned any of them into "drop the postings that
  // stay silent" — that one substitution discards 74.2% of the corpus on salary
  // alone, and it does it without a word on screen.
  const { profile } = buildProfile(db, {
    summary: 'x',
    salary_min: 150000,
    degree: ['bachelors'],
    workplace: ['hybrid'],
    posted_within_days: 30,
    places: ['nyc'],
  });
  const excluded = Object.entries(profile.unknowns).filter(([, policy]) => policy !== 'include');
  check('unknowns: nothing is excluded when nobody asked', excluded, []);
  check('unknowns: every criterion carries a policy', Object.keys(profile.unknowns).length, UNKNOWNABLE.length);

  // And the other half: when it IS asked for, it lands on that criterion and
  // on no other.
  const asked = buildProfile(db, { summary: 'x', salary_min: 150000, exclude_when_unstated: ['salary'] }).profile;
  check('unknowns: an explicit ask is honoured', asked.unknowns.salary, 'exclude');
  check('unknowns: and does not spread', asked.unknowns.degree, 'include');
  check(
    'unknowns: exactly one moved',
    Object.values(asked.unknowns).filter((p) => p === 'exclude').length,
    1,
  );

  // A criterion that is not on the roster cannot be excluded through this door.
  const bogus = buildProfile(db, { summary: 'x', exclude_when_unstated: ['vibes', 'salary'] }).profile;
  check('unknowns: an unknown criterion name is ignored', Object.values(bogus.unknowns).filter((p) => p === 'exclude').length, 1);
}

// -------------------------------------------------------------- building --
{
  const { profile, warnings, unresolved, changes } = buildProfile(db, {
    summary: 'Entry-level operations roles in New York, remote is fine.',
    label: 'NYC entry-level ops',
    title_keywords: ['operations', 'analyst'],
    places: ['New York City', 'Narnia'],
    remote_counts_as_match: true,
    max_years_experience: 2,
    job_functions: ['operations'],
    exclude_title_keywords: ['senior'],
  });

  check('build: keywords survive', profile.title_keywords, ['operations', 'analyst']);
  check('build: the place resolved', profile.metros, ['nyc']);
  check('build: and the one that did not is named', unresolved, ['Narnia']);
  check('build: as a warning, not a silence', warnings.some((w) => w.includes('Narnia')), true);
  check('build: remote flag', profile.remote_counts_as_match, true);
  check('build: years cap', profile.max_years_experience, 2);
  check('build: the summary is kept as the notes', profile.notes.startsWith('Entry-level'), true);
  check('build: the label is kept', profile.label, 'NYC entry-level ops');

  // Everything not mentioned stays empty. An unset criterion is the widest
  // answer, and filling one in on the model's behalf is how a search silently
  // narrows past what anybody asked for.
  check('build: unmentioned lists stay empty', [profile.skills, profile.ats, profile.companies, profile.degree], [[], [], [], []]);
  check('build: unmentioned numbers stay null', [profile.salary_min, profile.posted_within_days, profile.min_years_experience], [null, null, null]);
  check('build: unmentioned booleans stay false', [profile.requires_equity, profile.exclude_clearance, profile.include_intern], [false, false, false]);
  check('build: and a null tri-state stays null', profile.requires_visa_sponsorship, null);

  check('build: the diff lists what was added', changes.added.includes('metro in nyc'), true);
  check('build: and nothing was removed from an empty start', changes.removed, []);
}

// A value the engine has never heard of is dropped, and says so. This is the
// path that catches a model inventing `job_functions: ["consulting"]` — plausible,
// not in the vocabulary, and a silent zero-result search if it went through.
{
  const { profile, warnings } = buildProfile(db, {
    summary: 'x',
    job_functions: ['operations', 'consulting'],
    workplace: ['hybrid', 'underwater'],
    seniority: ['entry', 'wizard'],
  });
  check('invalid: the good values survive', [profile.job_functions, profile.workplace, profile.seniority], [['operations'], ['hybrid'], ['entry']]);
  check('invalid: each drop is reported', warnings.length >= 3, true);
  check('invalid: and names the value', warnings.some((w) => w.includes('consulting')), true);
}

// ------------------------------------------------------------------ diff --
{
  const before = { metros: ['nyc'], salary_min: 100000, title_keywords: ['analyst'] };
  const after = { metros: ['nyc'], salary_min: 150000, title_keywords: ['analyst'], workplace: ['remote'] };
  const { added, removed } = diffCriteria(before, after);
  check('diff: a new criterion is an addition', added.includes('remote'), true);
  check('diff: a changed one is both sides', [added.some((s) => s.includes('150,000')), removed.some((s) => s.includes('100,000'))], [true, true]);
  check('diff: an unchanged one is neither', [...added, ...removed].some((s) => s.includes('nyc')), false);
  check('diff: identical profiles differ in nothing', diffCriteria(before, before), { added: [], removed: [] });
}

// ------------------------------------------------------------------ tool --
// The vocabulary the model chooses from is generated from the schema, not
// written out a second time here. These checks are what would catch the day
// somebody adds a job function to `schema.mjs` and this feature keeps offering
// yesterday's list — the drift is invisible at runtime, because the model just
// picks something else and the search still "works".
{
  const tool = filterTool(vocabulary(db));
  const props = tool.input_schema.properties;
  const enumOf = (field) => props[field].items.enum;

  check('tool: job functions come from the schema', enumOf('job_functions'), JOB_FUNCTIONS);
  check('tool: workplace drops "unknown"', enumOf('workplace'), WORKPLACE_TYPES.filter((w) => w !== 'unknown'));
  check('tool: seniority drops "unknown"', enumOf('seniority'), SENIORITY_LEVELS.filter((s) => s !== 'unknown'));
  check('tool: employment type drops "Unknown"', enumOf('employment_type'), EMPLOYMENT_TYPES.filter((t) => t !== 'Unknown'));
  check('tool: skills are the derive pass\'s own vocabulary', enumOf('skills'), SKILL_TERMS);
  check('tool: the ATS list is read off the corpus', enumOf('ats').sort(), ['ashby', 'greenhouse', 'lever']);
  check('tool: the unknown roster generates its own field', enumOf('exclude_when_unstated'), UNKNOWNABLE.map((u) => u.key));

  // Places are free text on purpose — 24,576 metros is not an enum.
  check('tool: places take free text', props.places.items.enum, undefined);
  // The three fields with no counterpart in the profile, each of which is a
  // deliberate narrowing of what the model is allowed to do.
  check('tool: there is a place to say "I could not"', Boolean(props.not_understood), true);
  check('tool: and no raw unknowns object to set', props.unknowns, undefined);
  // Metros ARE a field, and an enum: the model picks ids off the served list
  // for the 200 places anybody names, and `places` free text covers the tail.
  check('tool: metros are an enum read off the registry, busiest first', enumOf('metros').slice(0, 3), ['nyc', 'sf-bay', 'austin']);
  check('tool: the list is in the description so the model can read the labels', props.metros.description.includes('nyc = New York City'), true);
  check('tool: countries are not a field — they only ever come from free text', props.countries, undefined);
  check('tool: only the summary is required', tool.input_schema.required, ['summary']);
}

// ------------------------------------------------------------------ meta --
{
  const meta = aiMeta({ accounts: true, signedIn: true });
  check('meta: the text cap is published', meta.max_text, MAX_TEXT);
  // Whether a key happens to be set on this machine is not the test; that the
  // page is told exactly one of "here is the model" or "here is how to turn it
  // on" is.
  check('meta: setup instructions appear exactly when it is off', meta.enabled === (meta.setup === null), true);
  check('meta: a model is named exactly when it is on', meta.enabled === (meta.model !== null), true);
  check('meta: the key itself is never published', Object.keys(meta).includes('apiKey'), false);
  check('meta: and it says out loud that it needs an account', meta.requires_account, true);
}

// ------------------------------------------------- who may use it, and why --
// This is the one feature in the project behind an account, so the page has to
// be able to tell three different "no"s apart: nobody can use this (no key),
// nobody here can use this (accounts off), and *you* cannot use this yet (not
// signed in). Collapsing them into one boolean is how a control ends up dead
// with no explanation — which is the failure this whole block exists to prevent.
{
  const keyed = aiMeta({ accounts: true, signedIn: true }).enabled;

  const state = (opts) => {
    const m = aiMeta(opts);
    return { usable: m.usable, blocked: m.blocked === null ? null : 'said something' };
  };

  check('gate: signed in with accounts on is the only usable state',
    state({ accounts: true, signedIn: true }), { usable: keyed, blocked: null });
  check('gate: signed out is not usable', state({ accounts: true, signedIn: false }).usable, false);
  check('gate: accounts off is not usable', state({ accounts: false, signedIn: true }).usable, false);
  check('gate: and the default — no arguments at all — is not usable',
    aiMeta().usable, false);

  if (keyed) {
    // Only assertable on a machine that has a key configured; without one the
    // key is the answer to every question and `blocked` is correctly silent.
    check('gate: signed out is told what to do about it',
      aiMeta({ accounts: true, signedIn: false }).blocked.includes('account'), true);
    check('gate: and told the rest of the app is unaffected',
      aiMeta({ accounts: true, signedIn: false }).blocked.includes('signed out'), true);
    check('gate: accounts-off names the reason it cannot be fixed by signing in',
      aiMeta({ accounts: false, signedIn: false }).blocked.includes('switched off'), true);
  } else {
    // No key on this machine: the operator's problem outranks the visitor's, so
    // `setup` is the sentence and `blocked` stays quiet rather than sending
    // somebody to sign in to a feature that would not work if they did.
    check('gate: with no key, the key is the answer and not "sign in"',
      [aiMeta({ accounts: true, signedIn: false }).blocked, aiMeta({ accounts: true, signedIn: true }).blocked],
      [null, null]);
    check('gate: and the setup line is what is published instead',
      aiMeta({ accounts: true, signedIn: false }).setup.includes('ANTHROPIC_API_KEY'), true);
  }
}

// ---------------------------------------------------------------- errors --
// The failure text is as user-facing as the summary is, and the whole reason it
// exists is that the SDK's own string for a mistyped key is
// `401 {"type":"error","error":{...}}`. Stand-in classes rather than the real
// ones: `explain` branches on `instanceof` against the namespace it is handed,
// so this tests the mapping without making a dependency-free test suite import
// the SDK — and it is the mapping, not the SDK, that can be wrong.
{
  const NS = {};
  for (const name of [
    'AuthenticationError', 'PermissionDeniedError', 'NotFoundError',
    'RateLimitError', 'BadRequestError', 'APIConnectionError', 'InternalServerError',
  ]) NS[name] = class extends Error {};

  const said = (Cls, extra = {}) => explain(Object.assign(new NS[Cls]('raw sdk noise'), extra), NS, 'claude-opus-5');

  check('error: a bad key names the variable to fix', said('AuthenticationError').includes('ANTHROPIC_API_KEY'), true);
  check('error: a forbidden model names the model', said('PermissionDeniedError').includes('claude-opus-5'), true);
  check('error: a missing model too', said('NotFoundError').includes('claude-opus-5'), true);
  check('error: a rate limit says to wait', said('RateLimitError').includes('wait'), true);
  check('error: no connection says where to look', said('APIConnectionError').includes('internet'), true);
  check('error: a server error says it is not yours', said('InternalServerError').includes('not yours'), true);

  // The one class that usually means this project is wrong rather than somebody's
  // configuration, so it keeps the API's own words — they are what a bug report needs.
  check(
    'error: a bad request keeps the API\'s own words',
    said('BadRequestError', { error: { error: { message: 'tools.0.input_schema: unknown field' } } }),
    'the request was refused: tools.0.input_schema: unknown field',
  );

  // Anything unrecognised passes through rather than being swallowed.
  check('error: an unknown failure is passed through', explain(new Error('socket hang up'), NS, 'm'), 'socket hang up');
  // And none of them leak a key, however the error was constructed.
  check(
    'error: no message can carry a key',
    ['AuthenticationError', 'RateLimitError', 'NotFoundError'].some((c) => said(c).includes('sk-ant')),
    false,
  );
}

// ------------------------------------------------------------ rate limit --
// The only route in this project that spends money, and on the deployed copy it
// is open to anyone who signs up for an account. The cap is not about fairness;
// it is about the difference between a bad afternoon and a bad bill.
{
  const t0 = 1_700_000_000_000;
  const spend = (who, n, at = t0) => {
    let last = null;
    for (let i = 0; i < n; i++) last = rateLimit(who, at + i);
    return last;
  };

  check('rate: the first call through is allowed', rateLimit('a@example.com', t0), null);
  check('rate: so is everything up to the cap', spend('b@example.com', CALLS_PER_HOUR), null);
  check('rate: the one after it is not', typeof spend('b@example.com', CALLS_PER_HOUR + 1), 'string');
  check('rate: and the refusal says when', spend('b@example.com', CALLS_PER_HOUR + 1).includes('free in about'), true);
  // Both counts pluralise. The cap is configurable, so somebody will set it to
  // 1, and "1 searches" only ever shows up at a setting nobody tests with.
  check('rate: the message reads correctly at the default',
    spend('p@example.com', CALLS_PER_HOUR + 1).includes(CALLS_PER_HOUR === 1 ? '1 search described' : `${CALLS_PER_HOUR} searches described`), true);
  check('rate: no "1 searches" and no "searchses" at any setting',
    /1 searches|searchses|\b0 minutes\b/.test(spend('q@example.com', CALLS_PER_HOUR + 1)), false);
  // The point of keying it per caller: one person's runaway is not everybody's.
  check('rate: a different caller has their own budget', rateLimit('c@example.com', t0), null);
  // A sliding window, not a bucket that never drains.
  check('rate: an hour later the window has moved on', rateLimit('b@example.com', t0 + 3_600_001), null);

  // A failure that cost nothing gives the call back. Without this, mistyping a
  // key locks you out for an hour at the exact moment you are trying to fix it.
  const NS2 = {};
  for (const n of ['AuthenticationError', 'PermissionDeniedError', 'NotFoundError',
                   'APIConnectionError', 'RateLimitError', 'BadRequestError', 'InternalServerError']) {
    NS2[n] = class extends Error {};
  }
  check('refund: a rejected key cost nothing', wasFree(new NS2.AuthenticationError(), NS2), true);
  check('refund: an unreachable API cost nothing', wasFree(new NS2.APIConnectionError(), NS2), true);
  check('refund: a model this key cannot reach cost nothing', wasFree(new NS2.PermissionDeniedError(), NS2), true);
  // These reached the model. They are not free and are not refunded.
  check('refund: a rate limit at the API is not refunded here', wasFree(new NS2.RateLimitError(), NS2), false);
  check('refund: nor is a refused request', wasFree(new NS2.BadRequestError(), NS2), false);
  check('refund: nor an unrecognised failure', wasFree(new Error('socket hang up'), NS2), false);

  // And the refund actually restores the call.
  spend('d@example.com', CALLS_PER_HOUR, t0);
  check('refund: at the cap, one back is one available', (refund('d@example.com'), rateLimit('d@example.com', t0)), null);
}

// ------------------------------------------------------------ blank config --
// `.env` ships as a template — `ANTHROPIC_API_KEY=` with nothing after it and
// two commented lines under it — and `process.loadEnvFile` sets a blank name to
// the empty string rather than leaving it unset. Every one of these would have
// been wrong under a bare `??`, and the last is the one that matters: `Number('')`
// is `0`, and `0` is the value that turns the spending cap OFF.
{
  const saved = {
    key: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL,
    cap: process.env.ANTHROPIC_CALLS_PER_HOUR,
  };
  const set = (env) => {
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL']) delete process.env[k];
    Object.assign(process.env, env);
    return aiConfig();
  };

  check('blank: an empty key is not a key', set({ ANTHROPIC_API_KEY: '' }).enabled, false);
  check('blank: nor is whitespace', set({ ANTHROPIC_API_KEY: '   ' }).enabled, false);
  check('blank: a real one is', set({ ANTHROPIC_API_KEY: 'sk-ant-test' }).enabled, true);
  check('blank: and is trimmed', set({ ANTHROPIC_API_KEY: '  sk-ant-test\n' }).apiKey, 'sk-ant-test');
  check('blank: an empty model falls back to the default',
    set({ ANTHROPIC_API_KEY: 'sk-ant-test', ANTHROPIC_MODEL: '' }).model, DEFAULT_MODEL);
  check('blank: a real model override is honoured',
    set({ ANTHROPIC_API_KEY: 'sk-ant-test', ANTHROPIC_MODEL: 'claude-sonnet-5' }).model, 'claude-sonnet-5');

  // The cap is read at module load, so this one has to re-import to see a
  // different environment. Worth the awkwardness: it is the assertion that a
  // blank line in a config file cannot silently uncap the route that spends.
  const capWith = async (value) => {
    if (value === null) delete process.env.ANTHROPIC_CALLS_PER_HOUR;
    else process.env.ANTHROPIC_CALLS_PER_HOUR = value;
    const fresh = await import(`./lib/interpret.mjs?blank=${encodeURIComponent(String(value))}`);
    return fresh.CALLS_PER_HOUR;
  };
  check('blank: an empty cap is the default, NOT zero', await capWith(''), 5);
  check('blank: and so is nonsense', await capWith('lots'), 5);
  check('blank: an explicit 0 still turns the cap off', await capWith('0'), 0);
  check('blank: a real number is honoured', await capWith('5'), 5);

  for (const [name, value] of [['ANTHROPIC_API_KEY', saved.key], ['ANTHROPIC_MODEL', saved.model], ['ANTHROPIC_CALLS_PER_HOUR', saved.cap]]) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

// --------------------------------------------------------------------- done --
if (failures.length) {
  console.error(`\n${failures.length} failing:\n`);
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  console.error(`${passed} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`✓ ${passed} interpret checks passed`);
