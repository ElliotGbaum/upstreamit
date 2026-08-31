/**
 * Say what you want in a sentence; get the filters set for you.
 *
 * Every control on the left rail writes one field of the filter profile, and
 * there are forty of them. That is the right shape for someone who already
 * knows the corpus and the wrong shape for the first ten minutes: "entry-level
 * ops or solutions roles in NYC, nothing needing a clearance, and I'll take
 * remote" is one sentence and eleven controls, spread over six panels, two of
 * which are collapsed by default. This module is the bridge — free text in, a
 * complete filter profile out.
 *
 * Four rules shape it, and each one is a thing that would otherwise go wrong.
 *
 * **1. The vocabulary is generated, never written down here.** The tool schema
 * below is built from `schema.mjs`'s enums, `SKILL_TERMS`, and the live corpus,
 * exactly as `/api/meta` builds the page's dropdowns. A second hand-kept list of
 * job functions would drift from the first one the day someone adds a function,
 * and the failure mode is silent: the model confidently returns a value the
 * engine has never heard of and the search comes back empty with no error.
 *
 * **2. A filter may only rule a job out on evidence.** That is the rule the
 * whole project is built on — 74.2% of postings publish no salary, 61.6% never
 * mention a degree — and it is the rule a language model is most likely to
 * break, because "at least $120k" reads like an instruction to drop everything
 * that does not say $120k. So the unknown policies are not exposed as a free
 * field. The model gets one narrow list, `exclude_when_unstated`, and the prompt
 * tells it that filling that list in without being asked is an error.
 *
 * **3. Places are a served list plus a free-text tail.** The metro registry is
 * 24,576 rows and cannot be an enum, but its top is: the 200 busiest metros are
 * served as ids to pick from — 60.3% of every placed job for 4 KB of prompt —
 * and everything else is free text that `resolvePlaces` matches exactly. That
 * split is the model doing the half it is good at ("the Bay Area" is `sf-bay`)
 * and a string comparison doing the half it can be trusted with. It used to be
 * free text alone with `LIKE` fallbacks, which on a registry built from raw
 * location strings found *something* for every word: `Germany` became a two-job
 * metro labelled "Germany Berlin". Anything that does not resolve comes back in
 * `unresolved` and is shown — a place we do not have is a sentence on screen,
 * never a filter that quietly matches nothing.
 *
 * **4. The output is a document, not an action.** Everything the model returns
 * goes through `normalizeProfile`, the same coercion the CLI and the file
 * loader use, so an invalid enum is dropped with a warning rather than saved.
 * The caller gets back the profile, a plain-English summary, and a diff against
 * what was on screen — and keeps the old profile so Undo is one click. Nothing
 * here writes to a file or runs a search.
 *
 * Dormant with no API key, exactly like Google sign-in: `aiConfig().enabled` is
 * false, `/api/meta` says so, and the page does not draw the box. The app is
 * unchanged for anyone who never configures it.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ATS_KEYS,
  COMPANY_SIZE_BANDS,
  EMPLOYMENT_TYPES,
  JOB_FUNCTIONS,
  PAY_PERIODS,
  REMOTE_SCOPES,
  SECTORS,
  SENIORITY_LEVELS,
  WORKPLACE_TYPES,
} from './schema.mjs';
import { SKILL_TERMS } from './derive/signals.mjs';
import { countryName } from './adapters/iso-countries.mjs';
import { UNKNOWNABLE, SORTS, activeCriteria, normalizeProfile } from './filter/profile.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG_FILE = join(ROOT, 'config', 'anthropic.json');

/**
 * An environment variable, treating blank as absent.
 *
 * Not fussiness. `.env` ships as a template with `ANTHROPIC_API_KEY=` and two
 * commented-out lines under it, and `process.loadEnvFile` sets a blank name to
 * the empty string rather than leaving it unset — so `??`, which only falls
 * through on null and undefined, would read that empty string as an answer.
 * Three things would have gone wrong the first time somebody uncommented a line
 * and left it blank: a key in `config/anthropic.json` would be shadowed by the
 * blank one and the feature would report itself unconfigured; the model would
 * become `''`; and `Number('')` is `0`, which is the value that turns the
 * spending cap **off**. The last one is the reason this exists — a config typo
 * must not silently uncap the only route here that spends money.
 */
const envText = (name) => {
  const raw = process.env[name];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
};

const envNumber = (name, fallback) => {
  const raw = envText(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

/** The model. One line, so changing it is one edit and it is visible in /api/meta. */
export const DEFAULT_MODEL = 'claude-opus-5';

/** How much text we will read. A dictated paragraph is welcome; a pasted resume is not. */
export const MAX_TEXT = 4000;

/**
 * How many metros the model gets to choose from by id.
 *
 * 200 covers 60.3% of every placed job in 4 KB of prompt; 300 buys 3.7 more
 * points for half again as much, and 100 gives up 7. Everywhere else — a small
 * city, a US state, a country — goes through `places` as free text and is
 * resolved against the whole registry.
 */
export const METRO_OPTIONS = 200;

/**
 * How many interpretations one person gets per hour.
 *
 * This is the only route in the project that spends money, and it is the only
 * one whose worst case is a bill rather than a slow page. On a laptop that does
 * not matter; on the deployed copy the route is open to anyone with an account,
 * and "anyone with an account" on a public sign-up is anyone.
 *
 * **5 is deliberately tight.** It was 30 — comfortably more than anyone would
 * use in a sitting — and it is now a number you can actually reach: describing
 * a search, reading what it set, and rewording it twice is four. That is the
 * trade being made on purpose. The failure it is sized against is not a person
 * being slightly inconvenienced, it is an unattended bill on somebody else's
 * key, and the inconvenience is one line in `.env` away from gone while the
 * bill is not. Someone who hits it has the whole filter rail still in front of
 * them, which is what the refusal below says.
 *
 * A sliding window in memory, deliberately: it resets on restart, and that is
 * the correct trade for a limiter whose job is to cap a runaway, not to bill
 * accurately. `ANTHROPIC_CALLS_PER_HOUR` raises or lowers it; `0` turns it off.
 */
export const CALLS_PER_HOUR = envNumber('ANTHROPIC_CALLS_PER_HOUR', 5);

const calls = new Map();

/**
 * May this caller spend another API call? Returns null to allow, or the sentence
 * to refuse them with.
 *
 * `who` is an account's email where there is one and the socket's address where
 * there is not, so one person's runaway cannot spend everybody else's budget —
 * and so the limit on a laptop, where every request is 127.0.0.1, is still a
 * limit rather than a per-visitor allowance nobody is enforcing.
 *
 * Called from inside `interpret`, immediately before the API call and *after*
 * every pre-flight check has had its chance to throw. That placement is the
 * whole design: a call is counted when it is about to be spent, so somebody
 * discovering their key is mistyped does not burn an hour's budget on four
 * `401`s, and nothing that never reached the API is ever charged for.
 */
export function rateLimit(who, now = Date.now()) {
  if (!Number.isFinite(CALLS_PER_HOUR) || CALLS_PER_HOUR <= 0) return null;
  const hour = 3600_000;
  const key = String(who ?? 'anonymous');
  const recent = (calls.get(key) ?? []).filter((at) => now - at < hour);

  if (recent.length >= CALLS_PER_HOUR) {
    const freeIn = Math.ceil((hour - (now - recent[0])) / 60_000);
    calls.set(key, recent);
    // Both counts are pluralised. `CALLS_PER_HOUR` is configurable and somebody
    // will set it to 1 — "that is 1 searches described in an hour" is the kind
    // of sentence that makes a careful tool look careless, and it only appears
    // at a setting nobody tests with.
    const searches = CALLS_PER_HOUR === 1 ? '1 search' : `${CALLS_PER_HOUR} searches`;
    const minutes = freeIn === 1 ? '1 minute' : `${freeIn} minutes`;
    return `that is ${searches} described in an hour, which is the cap — the next one is free in about ${minutes}. The filters below all still work.`;
  }

  recent.push(now);
  calls.set(key, recent);

  // The map is keyed by caller and never otherwise pruned, so a server that has
  // seen ten thousand addresses would hold ten thousand arrays forever. Cheap to
  // sweep here, where we are already walking one of them.
  if (calls.size > 1000) {
    for (const [id, at] of calls) if (!at.some((t) => now - t < hour)) calls.delete(id);
  }
  return null;
}

/**
 * Give a call back.
 *
 * The cap has to be taken *before* the API call, because that is the only place
 * it can prevent anything. But some of the ways that call fails cost nothing —
 * a rejected key, a model this key cannot reach, a machine with no network — and
 * charging for those turns "you mistyped your key" into "you mistyped your key
 * and are now locked out for an hour", which is the worst moment to be locked
 * out. Those get the call back; anything that reached the model and produced
 * tokens does not.
 */
export function refund(who) {
  const key = String(who ?? 'anonymous');
  const recent = calls.get(key);
  if (recent?.length) recent.pop();
}

/** Did this failure cost anything? The four that provably did not. */
export function wasFree(err, Anthropic) {
  return (
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError ||
    err instanceof Anthropic.NotFoundError ||
    err instanceof Anthropic.APIConnectionError
  );
}

/**
 * Credentials, from the environment or `config/anthropic.json`.
 *
 * `.env` at the project root arrives here as the environment: `lib/env.mjs`
 * loads it before the server imports this module, and a variable the shell
 * already set wins over the file, so nothing below has to know which of the
 * three it came from.
 *
 * Same shape and same precedence as `googleConfig()` — env first, file second,
 * dormant when neither is there. The key itself never leaves this module: what
 * the API serves is `enabled`, the model name, and where it found the key, so
 * the page can say "set ANTHROPIC_API_KEY" instead of failing on click.
 */
export function aiConfig() {
  let file = {};
  if (existsSync(CONFIG_FILE)) {
    try {
      file = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    } catch {
      /* a malformed config is the same as no config, and says so in /api/meta */
    }
  }
  // Blank counts as absent at every step — see `envText`. A `.env` with the
  // template's empty `ANTHROPIC_API_KEY=` still lets `config/anthropic.json`
  // answer, which is the precedence anybody would expect and the opposite of
  // what `??` alone would do.
  const fileKey = typeof file.api_key === 'string' && file.api_key.trim() ? file.api_key.trim() : null;
  const envKey = envText('ANTHROPIC_API_KEY');
  const apiKey = envKey ?? fileKey;

  const fileModel = typeof file.model === 'string' && file.model.trim() ? file.model.trim() : null;

  return {
    apiKey,
    enabled: Boolean(apiKey),
    model: envText('ANTHROPIC_MODEL') ?? fileModel ?? DEFAULT_MODEL,
    source: envKey ? 'ANTHROPIC_API_KEY' : apiKey ? CONFIG_FILE : null,
    configFile: CONFIG_FILE,
  };
}

/**
 * What `/api/meta` publishes. Never the key.
 *
 * Three separate questions, because the page has three different things to say
 * and conflating them into one boolean is how a control ends up dead with no
 * explanation:
 *
 *   `enabled`  — is there an API key at all? An operator question. `setup` is
 *                the answer when there isn't.
 *   `usable`   — may *this* visitor press the button? A visitor question.
 *   `blocked`  — the sentence to show them when the answer is no.
 *
 * The second and third exist because this is the one thing in the app that is
 * behind an account. Everything else — every job, every filter, every count,
 * every description and apply link — is anonymous and stays that way. This
 * route spends real money on somebody's API key, so it is the one place where
 * "who is asking" has to have an answer.
 */
export function aiMeta({ accounts = false, signedIn = false } = {}) {
  const config = aiConfig();
  const usable = config.enabled && accounts && signedIn;

  // Ordered most-fundamental first, so a server with no key and no accounts
  // reports the key — the thing its operator has to fix — rather than telling a
  // visitor to sign in to a feature that would not work if they did.
  const blocked = config.enabled
    ? !accounts
      ? 'accounts are switched off on this server, and describing a search needs one'
      : !signedIn
        ? 'Describing a search uses an API key, so it is the one thing here that needs an account. Everything else works signed out.'
        : null
    : null;

  return {
    enabled: config.enabled,
    model: config.enabled ? config.model : null,
    // The instruction, not an error: this is the one thing a person needs to do
    // to turn the feature on, and the page shows it rather than hiding the box
    // with no explanation.
    setup: config.enabled
      ? null
      : `put ANTHROPIC_API_KEY=sk-ant-... in the project's .env, set it in the environment, or put {"api_key": "sk-ant-..."} in ${CONFIG_FILE}`,
    requires_account: true,
    usable,
    blocked,
    max_text: MAX_TEXT,
  };
}

// ------------------------------------------------------------- vocabulary --

/**
 * The closed lists the model is allowed to choose from, read off the schema and
 * the corpus rather than restated here.
 *
 * `metros` is the `METRO_OPTIONS` busiest, served to the tool schema as a
 * closed enum the model must pick ids from — only free-text `places` reach
 * `resolvePlaces` and the whole registry. `countries` is the sample: every
 * country with an open job, there for shape rather than as the allowed set.
 * Sending all 24,576 metros would be a 700 KB prompt to answer "NYC".
 */
// Per database, so two corpora in one process cannot read each other's answer,
// and weak so a closed one does not pin its vocabulary in memory.
const vocabCache = new WeakMap();
export function vocabulary(db) {
  // Keyed on the open-job count, which changes on every sweep and costs 7 ms to
  // read off the index it already has. The countries query below is the only
  // expensive thing in this module that is not the model call — see there.
  const generation = db.prepare('SELECT COUNT(*) n FROM jobs WHERE is_open = 1').get().n;
  const hit = vocabCache.get(db);
  if (hit?.generation === generation) return hit.vocab;

  const vocab = {
    ats: db.prepare('SELECT ats AS value, SUM(is_open) AS count FROM jobs GROUP BY ats HAVING count > 0 ORDER BY count DESC').all(),
    // The 200 busiest, which is 60.3% of every placed job for 4 KB of prompt.
    // These are served to the model as a closed list it picks ids from, and
    // that is the whole reason place resolution works at all: the registry is
    // 24,576 rows built from observed location strings, and its tail is
    // "Narnia" (2 jobs), "Field" (2,985) and one company's own name (4,985).
    // A model choosing from the top of that list cannot land on any of them;
    // a string match against all of it lands on them constantly.
    metros: db.prepare(`SELECT id, label, country FROM metros ORDER BY job_count DESC LIMIT ${METRO_OPTIONS}`).all(),
    // `d_countries` is a JSON array — a job can be in more than one — so this
    // walks it with `json_each` rather than reading a column. 188 ms over the
    // full corpus, which is why it is cached above and not why it is written
    // this way: the cheap version, `SELECT DISTINCT country FROM metros`, is
    // 2 ms and wrong by two countries. Those two exist only as remote roles,
    // which carry a country and no metro, and a person in one of them asking
    // for their own country would be told we have never heard of it.
    countries: db
      .prepare("SELECT DISTINCT value AS code FROM jobs, json_each(jobs.d_countries) WHERE jobs.is_open = 1 AND value != '' ORDER BY value")
      .all()
      .map((r) => r.code),
  };
  vocabCache.set(db, { generation, vocab });
  return vocab;
}

/**
 * Free-text place names onto metro ids and country codes — the tail only.
 *
 * The 200 places most people mean arrive already resolved, as ids the model
 * picked off the served list. What reaches here is everything else: a country,
 * a small city, a state, a misheard word from a dictation.
 *
 * **Exact matches only, and that is the fix rather than the limitation.** This
 * function used to fall back to `LIKE 'name%'` and then `LIKE '%name%'`, which
 * on a 24,576-row registry built from raw location strings is not fuzzy
 * matching, it is a random walk: `Germany` resolved to a metro called "Germany
 * Berlin" (13 jobs) instead of the country, and every unrecognised word found
 * *something*. Two passes went and the results got better, because the job they
 * were doing — knowing that "the Bay Area" is San Francisco — belongs to the
 * model, which does it correctly, and not to a string comparison, which cannot.
 *
 * The one liberty taken is a trailing qualifier: "Austin, Texas" and "Austin"
 * are the same request, and dropping everything after the comma is a rule with
 * one reading. Anything still unmatched comes back in `unresolved`, is named in
 * a warning, and sets no filter at all — never a criterion that quietly matches
 * nothing.
 */
export function resolvePlaces(db, names = []) {
  const metros = [];
  const countries = [];
  const unresolved = [];

  const byId = db.prepare('SELECT id, label FROM metros WHERE id = ?');
  const byLabel = db.prepare('SELECT id, label FROM metros WHERE lower(label) = ? ORDER BY job_count DESC LIMIT 1');

  // The corpus's own country list, in both directions. A code we have never
  // swept is not an answer, however valid it is as ISO-3166.
  const known = new Set(vocabulary(db).countries);
  const nameToCode = new Map();
  for (const code of known) {
    const name = countryName(code);
    if (name) nameToCode.set(name.toLowerCase(), code);
  }
  // The two spellings ISO does not give us and everybody uses.
  if (known.has('gb')) {
    nameToCode.set('uk', 'gb');
    nameToCode.set('united kingdom', 'gb');
    nameToCode.set('england', 'gb');
  }
  if (known.has('us')) {
    for (const alias of ['usa', 'us', 'america', 'united states', 'the united states']) nameToCode.set(alias, 'us');
  }

  const resolved = { metros, countries, unresolved };
  for (const raw of names) {
    const name = String(raw ?? '').trim();
    if (!name) continue;

    // "the Bay Area" and "Bay Area"; "Austin, Texas" and "Austin". Both spellings
    // are tried, longest first, so a metro genuinely labelled with a comma still
    // wins over its own prefix.
    const base = name.toLowerCase().replace(/^the\s+/, '').replace(/\s+/g, ' ');
    const spellings = [base];
    const comma = base.indexOf(',');
    if (comma > 0) spellings.push(base.slice(0, comma).trim());

    // A country before a metro. The registry contains rows labelled "Germany"
    // and "Ireland" — location strings that named a country and nothing else —
    // and matching those instead of the country filter would search two jobs
    // where the person asked for eleven thousand.
    let hit = false;
    for (const key of spellings) {
      if (known.has(key) && key.length === 2) { countries.push(key); hit = true; break; }
      const code = nameToCode.get(key);
      if (code) { countries.push(code); hit = true; break; }
    }
    if (hit) continue;

    for (const key of spellings) {
      const id = byId.get(key);
      if (id) { metros.push(id.id); hit = true; break; }
      const label = byLabel.get(key);
      if (label) { metros.push(label.id); hit = true; break; }
    }
    if (hit) continue;

    unresolved.push(name);
  }

  resolved.metros = [...new Set(metros)];
  resolved.countries = [...new Set(countries)];
  return resolved;
}

// ------------------------------------------------------------------- tool --

const enumArray = (values, description) => ({
  type: 'array',
  items: { type: 'string', enum: values },
  description,
});

const stringArray = (description) => ({ type: 'array', items: { type: 'string' }, description });

/**
 * The one tool the model may call, generated from the vocabulary.
 *
 * It is deliberately *not* a mirror of `blankProfile()`. Three fields differ,
 * and each difference is a place where handing the model the profile's own
 * shape would let it do something the profile allows and this feature should
 * not:
 *
 *   `places` replaces `metros` + `countries`   — see resolvePlaces above.
 *   `exclude_when_unstated` replaces `unknowns` — a list it must be asked for,
 *                                                 not a policy per criterion it
 *                                                 can quietly set to `exclude`.
 *   `not_understood` has no counterpart at all  — the field that lets it say a
 *                                                 request cannot be expressed
 *                                                 here, instead of guessing.
 *
 * `weights`, `limit` and `text` are not exposed. The first two are not things
 * anybody describes in a sentence, and the third is a raw FTS5 query that would
 * duplicate the keyword gates with worse ranking.
 */
export function filterTool(vocab) {
  const workplaces = WORKPLACE_TYPES.filter((w) => w !== 'unknown');
  const seniorities = SENIORITY_LEVELS.filter((s) => s !== 'unknown');
  const employment = EMPLOYMENT_TYPES.filter((t) => t !== 'Unknown');

  return {
    name: 'set_filters',
    description:
      'Set the job-search filters that match what the person described. Call this exactly once. ' +
      'Include every criterion the search should have when you are done — this replaces the current ' +
      'filters rather than adding to them, so re-state the ones they are keeping. Omit any field they ' +
      'said nothing about; an omitted field is "no opinion", which is what leaves the widest search.',
    input_schema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description:
            'One to three sentences, addressed to the person, in plain language: what you understood ' +
            'them to want and what you set. Name any judgement call you made. No JSON, no field names.',
        },
        label: { type: 'string', description: 'A short name for this search, at most 40 characters. e.g. "NYC entry-level ops".' },

        title_keywords: stringArray(
          'Words that should appear in the JOB TITLE. Single words or short phrases, lowercase. ' +
          'These both narrow the search and rank it, so favour the words that would really be in the ' +
          'title of a job they want — "solutions", "implementation", "analyst" — over generic ones.',
        ),
        title_match: { type: 'string', enum: ['any', 'all'], description: 'Default "any". Use "all" only if they were explicit that every word must appear.' },
        description_keywords: stringArray('Words that should appear in the job DESCRIPTION but not necessarily the title.'),
        description_match: { type: 'string', enum: ['any', 'all'], description: 'Default "any".' },
        exclude_title_keywords: stringArray('Drop any job whose TITLE contains one of these. e.g. "senior", "intern", "director".'),
        exclude_description_keywords: stringArray('Drop any job whose DESCRIPTION contains one of these. e.g. "unpaid", "commission only".'),

        // Place is two fields because the registry is two things: 200 metros
        // anybody would name, and a 24,000-row tail. The first is a list to
        // pick from, which is exact; the second is free text, which is not.
        metros: enumArray(
          vocab.metros.map((m) => m.id),
          'The metro areas they want to work in, as ids from this list — this is where nearly every ' +
          'answer belongs, so look here first and use `places` only for somewhere not on it. ' +
          'A region or a state means the metros in it: "the Bay Area" is sf-bay, "Texas" is austin, ' +
          'dallas, houston and san-antonio if those are here. The list, id = place:\n' +
          vocab.metros.map((m) => `${m.id} = ${m.label}`).join(', '),
        ),
        places: stringArray(
          'Anywhere NOT on the metro list above — a whole country ("Germany", "Japan"), or a smaller ' +
          'city. Write it the way they said it. These are matched by name against the full registry, ' +
          'and anything that does not match is reported back to them rather than quietly applied, so ' +
          'a guess here costs nothing. Do not repeat a place you already gave as a metro id.',
        ),
        remote_counts_as_match: {
          type: 'boolean',
          description:
            'True when they named a city AND would also take a remote role. Remote jobs carry no metro, ' +
            'so without this a city filter excludes every remote job by construction.',
        },
        workplace: enumArray(workplaces, 'Onsite / hybrid / remote. Only when they said.'),
        remote_scope: enumArray(REMOTE_SCOPES, 'How far a remote role reaches. Only set alongside remote.'),

        employment_type: enumArray(employment, 'Only when they said. Two thirds of postings publish no employment type at all.'),
        job_functions: enumArray(JOB_FUNCTIONS, 'The department a role sits in. Prefer one or two; this is a coarse bucket, not a job title.'),
        skills: enumArray(SKILL_TERMS, 'Tools and technologies named in the description. Only from this list — it is the whole vocabulary the corpus extracts.'),
        skills_match: { type: 'string', enum: ['any', 'all'], description: 'Default "any".' },
        exclude_skills: enumArray(SKILL_TERMS, 'Rule a job out for naming these.'),

        seniority: enumArray(seniorities, 'An explicit band. Prefer max_years_experience when they described themselves in years.'),
        max_years_experience: { type: 'number', description: 'Most years of experience the role should ask for. "entry level" is about 2, "new grad" 0 or 1.' },
        min_years_experience: { type: 'number', description: 'Fewest years — for someone experienced who does not want junior roles.' },
        include_intern: { type: 'boolean', description: 'True only if they want internships. An internship is a different thing from an entry-level job.' },

        salary_min: { type: 'number', description: 'Annual figure, in the currency they named or USD. Convert "80k" to 80000 and hourly rates to an annual figure.' },
        salary_max: { type: 'number', description: 'Rarely wanted. Only when they said they do not want roles above a figure.' },
        pay_period: enumArray(PAY_PERIODS, 'How the pay is quoted. Set HOUR when they asked for hourly work.'),
        currencies: stringArray('ISO-4217 codes, three letters, e.g. "USD", "EUR". Only when they named a currency.'),
        requires_equity: { type: 'boolean', description: 'Keep only postings with an equity component. 96.7% publish none, so this is a very narrow gate.' },
        salary_stated_only: { type: 'boolean', description: 'Keep only pay figures the employer published as stated, not estimates.' },

        posted_within_days: { type: 'number', description: 'Freshness. "this week" is 7, "recent" is about 30.' },

        requires_visa_sponsorship: { type: 'boolean', description: 'True only when they need sponsorship. 94.4% of postings never raise the subject, so this is a narrow gate — prefer exclude_visa_refusal.' },
        exclude_visa_refusal: { type: 'boolean', description: 'Drop postings that say outright they will not sponsor. The wide, safe version of the above.' },
        exclude_clearance: { type: 'boolean', description: 'Drop roles requiring a security clearance.' },
        degree: enumArray(['none', 'bachelors', 'masters', 'phd'], 'The degree the posting asks for. Use "none" for someone without one.'),

        ats: enumArray(vocab.ats.map((a) => a.value), 'Which applicant-tracking systems to draw from. Only when they named one.'),
        companies: stringArray('An allow-list of company names or slugs. Only when they named specific employers.'),
        company_size: enumArray(
          COMPANY_SIZE_BANDS.map((b) => b.value),
          `How many roles the company has open here, as a proxy for size: ${COMPANY_SIZE_BANDS.map((b) => `${b.value} = ${b.label}`).join(', ')}. ` +
          'It is not headcount and cannot be — no ATS publishes that.',
        ),
        // The company's industry, read off its own postings. The exclusion is
        // the half people ask for in words — "not finance", "no defense" —
        // and it is safe to set: it drops only companies known to be in the
        // sector, never ones nobody has read.
        sectors: enumArray(
          SECTORS.map((s) => s.value),
          'The industry the COMPANY is in, when they said they want to work in one. Not the job\'s ' +
          'department — that is job_functions. ' + SECTORS.map((s) => `${s.value} = ${s.label}`).join(', '),
        ),
        exclude_sectors: enumArray(
          SECTORS.map((s) => s.value),
          'Industries they said they do NOT want to work in — "not finance" is financial-services and ' +
          'fintech, "nothing in defense" is aerospace-defense. Same ids as sectors.',
        ),

        sort: { type: 'string', enum: SORTS.map((s) => s.value), description: `Result order. ${SORTS.map((s) => `${s.value} = ${s.detail}`).join('; ')}.` },
        collapse_duplicates: { type: 'boolean', description: 'One row per company+title instead of the same role once per city.' },

        exclude_when_unstated: enumArray(
          UNKNOWNABLE.map((u) => u.key),
          'THE ONE FIELD TO LEAVE EMPTY UNLESS ASKED. Criteria where a posting that says nothing should be ' +
          'DROPPED rather than kept. Only list a criterion here if the person explicitly said they do not ' +
          'want postings that stay silent on it — "only show me jobs that post a salary" is the kind of ' +
          'sentence that earns an entry. Wanting a high salary is not.',
        ),
        not_understood: stringArray(
          'Anything they asked for that these filters cannot express — company culture, interview process, ' +
          'a specific manager, "good work-life balance". Say it here rather than approximating it with ' +
          'keywords. This is shown to them.',
        ),
      },
      required: ['summary'],
    },
  };
}

/**
 * The system prompt.
 *
 * Everything numeric in it is measured, and it is in here for one reason: a
 * model asked to honour "at least $150k" with no idea that 74.2% of postings
 * publish no figure will write a filter that silently discards three quarters
 * of the market. The shares are what make "leave the silent ones in" an obvious
 * decision rather than a rule it has to be talked into.
 */
export function systemPrompt(vocab, corpus) {
  const shares = UNKNOWNABLE.filter((u) => u.share >= 0.1)
    .map((u) => `${u.label} ${Math.round(u.share * 100)}%`)
    .join(' · ');

  return [
    'You turn a job-seeker\'s own words into search filters for a job board built directly on company',
    `applicant-tracking systems: ${corpus.open.toLocaleString('en-US')} open jobs from ${corpus.boards_live.toLocaleString('en-US')} companies`,
    `across ${vocab.ats.map((a) => a.value).join(', ')}. You do this by calling set_filters exactly once.`,
    '',
    'THE RULE THAT MATTERS MOST. These are raw postings, not a curated board, and most of them leave',
    `most fields blank. Share of postings that say nothing at all: ${shares}.`,
    'A filter here may rule a job out because the posting SAYS something that fails it — never because the',
    'posting is silent. Silence is the employer\'s omission, not the job\'s answer. So: someone who wants',
    '$150k gets salary_min: 150000, and the jobs that published no figure stay in their results. Leave',
    'exclude_when_unstated empty unless they told you in so many words to drop the ones that do not say.',
    '',
    'HOW TO READ A REQUEST.',
    '- Set only what they actually said or clearly implied. An unset field is not a gap to fill in; it is',
    '  the widest and usually the right answer. Four confident criteria beat twelve guessed ones.',
    '- "entry level" means max_years_experience about 2, not seniority: ["entry"] — a quarter of postings',
    '  carry no seniority band at all but do state years, and the years cap reads both signals.',
    '- Keywords are the sharpest tool here. Put the words that would be in the TITLE of a job they want in',
    '  title_keywords, and words that would only be in the body in description_keywords. Both gate and rank.',
    '- If they named a city and would also take remote, set remote_counts_as_match — otherwise the city',
    '  filter drops every remote job, because remote jobs carry no city.',
    '- Do not invent an exclusion they did not ask for. exclude_title_keywords: ["senior"] is right for',
    '  someone who said "junior roles" and wrong for someone who just did not mention seniority.',
    '- If part of what they want cannot be expressed — culture, team size, "somewhere I can grow" — put it',
    '  in not_understood. Do not approximate it with keywords that will quietly narrow their search.',
    '',
    'THE SUMMARY is for a person who has never seen this app. Write it to them, in their own vocabulary,',
    'saying what you understood and what you set. Name the judgement calls. Do not mention field names,',
    'JSON, or the word "filter profile". Two sentences is usually right.',
  ].join('\n');
}

// ------------------------------------------------------------------- call --

/**
 * The Anthropic client, loaded only when someone actually uses the feature.
 *
 * A dynamic import rather than a top-level one because this project has no
 * other dependency and boots with no install step, and that should stay true
 * for the people who never turn this on. A missing package is a sentence in the
 * UI telling them to run `npm install`, not a server that will not start.
 */
let clientPromise = null;
async function anthropic(apiKey) {
  if (!clientPromise) {
    clientPromise = import('@anthropic-ai/sdk')
      .then(({ default: Anthropic }) => ({ client: new Anthropic({ apiKey }), Anthropic }))
      .catch((err) => {
        clientPromise = null;
        throw new Error(
          `the Anthropic SDK is not installed — run "npm install" in this project (${err.message})`,
        );
      });
  }
  return clientPromise;
}

/**
 * An API failure as a sentence somebody can act on.
 *
 * Without this the page renders the SDK's own string, and what that looks like
 * to the person who mistyped their key is `401 {"type":"error","error":
 * {"type":"authentication_error","message":"API key is invalid."},"request_id":
 * null}` — every fact needed to fix it, arranged so that none of them is
 * legible. The typed classes are what make the mapping safe: matching on the
 * message text would break the first time a wording changed, and matching on
 * the status code alone cannot tell a key that is wrong from one that is merely
 * not allowed to use this model.
 */
export function explain(err, Anthropic, model) {
  if (err instanceof Anthropic.AuthenticationError) {
    return 'that API key was rejected — check ANTHROPIC_API_KEY, or the key in config/anthropic.json';
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return `that API key is not allowed to use ${model} — check the key's workspace, or set ANTHROPIC_MODEL to one it can reach`;
  }
  if (err instanceof Anthropic.NotFoundError) {
    return `no model called "${model}" — set ANTHROPIC_MODEL to one your key can reach`;
  }
  if (err instanceof Anthropic.RateLimitError) {
    return 'the API is rate-limiting this key right now — wait a moment and press it again';
  }
  if (err instanceof Anthropic.BadRequestError) {
    // The one class here that usually means *this project* is wrong rather than
    // somebody's configuration, so it keeps the API's own words: they are what
    // a bug report needs.
    return `the request was refused: ${err.error?.error?.message ?? err.message}`;
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return "could not reach the Anthropic API — check this machine's internet connection";
  }
  if (err instanceof Anthropic.InternalServerError) {
    return 'the API had a server error — that one is not yours; try again in a moment';
  }
  return err.message;
}

/**
 * Free text in, a filter profile out.
 *
 * `current` is the profile on screen. It goes into the prompt as context so
 * "make that remote too" has something to refer to, but the model still returns
 * a complete set rather than a patch: a half-stated answer merged into whatever
 * happened to be on screen is the version nobody can predict or explain, and
 * this one can be shown as a diff and undone in a click.
 *
 * `who` identifies the caller for the per-hour cap — see `rateLimit`.
 *
 * @returns {Promise<{profile: object, summary: string, changes: object,
 *                    warnings: string[], unresolved: string[], not_understood: string[],
 *                    usage: object}>}
 */
export async function interpret(db, { text, current = {}, corpus, who = null }) {
  const config = aiConfig();
  if (!config.enabled) throw new Error(aiMeta().setup);

  const said = String(text ?? '').trim();
  if (!said) throw new Error('nothing to interpret — describe the job you are looking for');
  if (said.length > MAX_TEXT) throw new Error(`that is ${said.length} characters; the limit is ${MAX_TEXT}`);

  const vocab = vocabulary(db);
  const tool = filterTool(vocab);
  const { client, Anthropic } = await anthropic(config.apiKey);

  // What is on screen now, in the words the page itself would use for it. The
  // engine's own `activeCriteria` rather than a dump of the JSON: it is shorter,
  // it is already prose, and it can never describe a criterion the engine does
  // not implement.
  const before = normalizeProfile(current).profile;
  const standing = activeCriteria(before);
  const context = standing.length
    ? `Filters currently on their screen, which your answer replaces in full:\n${standing.map((c) => `- ${c.summary}`).join('\n')}`
    : 'Their screen has no filters set beyond the defaults.';

  // Everything that could refuse this request for free has now had its turn.
  // The next line is the one that spends money, so this is where the cap is.
  const refusal = rateLimit(who);
  if (refusal) {
    const err = new Error(refusal);
    err.rateLimited = true;
    throw err;
  }

  let response;
  try {
    response = await client.messages.create({
      model: config.model,
      max_tokens: 16000,
      // Adaptive thinking, at medium effort. This is an extraction task against
      // a schema rather than a reasoning one, and it sits in front of a person
      // waiting on a text box — but it is not trivial either: "I'm a career
      // changer, two years of ops, want to move into AI implementation work"
      // is four fields and a judgement call about which two.
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      system: systemPrompt(vocab, corpus),
      tools: [tool],
      // `auto` rather than forcing the tool: forced tool choice and extended
      // thinking have historically not been combinable, and a run that 400s on
      // a parameter combination is a worse failure than the one forcing it
      // would prevent. The prompt says "call set_filters exactly once" three
      // times over, and the no-tool-call case below is handled rather than
      // assumed away.
      tool_choice: { type: 'auto' },
      messages: [
        {
          role: 'user',
          content: `${context}\n\nWhat they said they are looking for:\n"""\n${said}\n"""`,
        },
      ],
    });
  } catch (err) {
    if (wasFree(err, Anthropic)) refund(who);
    throw new Error(explain(err, Anthropic, config.model));
  }

  if (response.stop_reason === 'refusal') {
    throw new Error('the model declined to answer that. Try describing the job itself.');
  }

  const call = response.content.find((block) => block.type === 'tool_use' && block.name === 'set_filters');
  if (!call) {
    // It answered in prose instead of calling the tool. Show what it said — it
    // is usually a question about an ambiguous request, which is useful.
    const spoke = response.content.find((block) => block.type === 'text')?.text?.trim();
    throw new Error(spoke || 'no filters came back — try saying it a different way');
  }

  const built = buildProfile(db, call.input, before);
  return {
    ...built,
    summary: String(call.input.summary ?? '').trim(),
    not_understood: (call.input.not_understood ?? []).map(String).filter(Boolean),
    usage: {
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
    },
  };
}

// ------------------------------------------------------------------ build --

/**
 * Tool input onto a filter profile.
 *
 * Split out from `interpret` because it is the half worth testing, and it does
 * not need a key or a network to run: given the object the model would have
 * returned, this is exactly the document the app would have loaded.
 */
export function buildProfile(db, input = {}, before = {}) {
  const places = resolvePlaces(db, input.places ?? []);

  // Start from nothing, not from `before`. The model was asked for the complete
  // set and told that it replaces what is on screen, so anything carried over
  // silently here would be a criterion nobody can see the origin of.
  const draft = {
    name: 'described',
    label: input.label ? String(input.label).slice(0, 60) : 'Described in words',
    notes: input.summary ? String(input.summary) : null,

    title_keywords: input.title_keywords,
    title_match: input.title_match,
    description_keywords: input.description_keywords,
    description_match: input.description_match,
    exclude_title_keywords: input.exclude_title_keywords,
    exclude_description_keywords: input.exclude_description_keywords,

    // The ids the model picked plus whatever its free text resolved to. Both
    // go through `normalizeProfile`, which lowercases them; an id that is not a
    // real metro survives that and simply matches nothing, which is why the
    // list it picks from is generated from the registry rather than recalled.
    metros: [...new Set([...(input.metros ?? []), ...places.metros])],
    countries: places.countries,
    remote_counts_as_match: input.remote_counts_as_match,

    workplace: input.workplace,
    remote_scope: input.remote_scope,
    employment_type: input.employment_type,
    job_functions: input.job_functions,
    skills: input.skills,
    skills_match: input.skills_match,
    exclude_skills: input.exclude_skills,

    seniority: input.seniority,
    max_years_experience: input.max_years_experience,
    min_years_experience: input.min_years_experience,
    include_intern: input.include_intern,

    salary_min: input.salary_min,
    salary_max: input.salary_max,
    pay_period: input.pay_period,
    currencies: input.currencies,
    requires_equity: input.requires_equity,
    salary_stated_only: input.salary_stated_only,

    posted_within_days: input.posted_within_days,

    requires_visa_sponsorship: input.requires_visa_sponsorship,
    exclude_visa_refusal: input.exclude_visa_refusal,
    exclude_clearance: input.exclude_clearance,
    degree: input.degree,

    ats: input.ats,
    companies: input.companies,
    company_size: input.company_size,
    sectors: input.sectors,
    exclude_sectors: input.exclude_sectors,

    sort: input.sort,
    collapse_duplicates: input.collapse_duplicates,
  };

  // `undefined` means "said nothing about it", and `normalizeProfile` would
  // read it as an explicit blank. Dropping the keys is what makes an omitted
  // field indistinguishable from a field nobody ever wrote.
  for (const [key, value] of Object.entries(draft)) if (value === undefined) delete draft[key];

  // The unknown policies, built the only way this feature is allowed to build
  // them: everything on its default, and `exclude` only for the criteria named
  // in the one field the prompt tells the model to leave empty.
  const asked = new Set((input.exclude_when_unstated ?? []).filter((key) => UNKNOWNABLE.some((u) => u.key === key)));
  draft.unknowns = Object.fromEntries(UNKNOWNABLE.map((u) => [u.key, asked.has(u.key) ? 'exclude' : u.default]));

  const { profile, warnings } = normalizeProfile(draft);
  if (places.unresolved.length) {
    warnings.push(
      `could not find ${places.unresolved.length === 1 ? 'a place' : 'places'} called ${places.unresolved.join(', ')} — ` +
        'the location filter was left off for that; pick it by hand in Location if it is there under another name',
    );
  }

  return { profile, warnings, unresolved: places.unresolved, changes: diffCriteria(before, profile) };
}

/**
 * What changed, in the page's own words.
 *
 * Built from `activeCriteria` on both sides rather than from the raw fields,
 * because that function is already the answer to "how does this app describe a
 * criterion" and a second phrasing here would drift from the chips on screen.
 * Keyed by criterion so a changed salary floor reads as one changed line rather
 * than as a removal and an addition.
 */
export function diffCriteria(before, after) {
  const summarize = (p) => {
    const map = new Map();
    for (const c of activeCriteria(normalizeProfile(p).profile)) {
      map.set(`${c.key}:${c.summary}`, c);
    }
    return map;
  };
  const was = summarize(before);
  const now = summarize(after);

  const added = [...now.values()].filter((c) => !was.has(`${c.key}:${c.summary}`)).map((c) => c.summary);
  const removed = [...was.values()].filter((c) => !now.has(`${c.key}:${c.summary}`)).map((c) => c.summary);
  return { added, removed };
}
