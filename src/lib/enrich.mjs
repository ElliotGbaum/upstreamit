/**
 * What a company does, read off its own postings.
 *
 * No ATS says what a company is. The posting says what the *job* is, and the
 * derive pass turns that into a function, a seniority and a salary — but "is
 * this a bank or a payments startup", "is it a hospital or a devtools company",
 * is a fact about the employer that the schema had nowhere to put and no rule
 * could read. It is also the fact most people check by hand before they apply:
 * somebody scanning two hundred results opens LinkedIn on every third one to
 * find out what the company actually does.
 *
 * The evidence is already in the database. Nearly every description carries an
 * "about us" paragraph, and the titles a company has open say a lot on their
 * own — a board full of underwriters and claims adjusters is an insurer whatever
 * the paragraph says. So this module builds a short dossier per company from
 * what the sweep already stored, and asks a model to name the sector and write
 * one sentence. One call per company, not per job: 17,000 companies is a
 * one-off of tens of dollars; 967,000 jobs would be the same answer 57 times
 * over at 57 times the price.
 *
 * Four rules, each of which is a thing that would otherwise go wrong.
 *
 * **1. The vocabulary is `SECTORS`, generated into the tool and the prompt.**
 * Same reason `interpret.mjs` builds its tool from the schema: a second list
 * written here would drift from the one the filter reads, and the failure is
 * silent — a bucket the engine has never heard of is a facet row nobody can
 * tick. `readVerdict` refuses anything outside the list a second time, after
 * the API's own enum check, because a stored value that is not in the list is
 * a criterion that quietly matches nothing.
 *
 * **2. Unsure is a real answer and it is stored as NULL.** The model is asked
 * for a confidence, and a low one drops the sector rather than keeping a guess.
 * A guess in this column is worse than a blank: the blank goes to the unknown
 * policy and stays in every search by default, the guess rules jobs in and out.
 *
 * **3. The company, not the role.** A data engineer at a bank is
 * `financial-services` here and `data` in `d_job_function`. The prompt says so
 * three times, because a model reading a job posting will reach for the job.
 *
 * **4. Split at the seam worth testing.** `dossier` and `readVerdict` are pure
 * and run in the test suite with no key and no network; `classifyCompany` is
 * the one function that spends money, and it is thirty lines.
 *
 * Dormant with no API key, like everything else that spends here — `aiConfig()`
 * in interpret.mjs is the one place the key is read, and this reuses it.
 */

import { SECTORS, SECTOR_VALUES } from './schema.mjs';
import { aiConfig, explain } from './interpret.mjs';

/**
 * The model that reads companies.
 *
 * Deliberately not the one "describe your search" uses. That route sits in
 * front of a person waiting on a text box and runs five times an hour at most;
 * this one runs seventeen thousand times in a night and asks a much narrower
 * question — which of thirty buckets, and one sentence. Haiku answers it well
 * and at a fifth of the price. `ANTHROPIC_ENRICH_MODEL` overrides it, and the
 * cost line the script prints is what to read before choosing a bigger one.
 */
export const DEFAULT_ENRICH_MODEL = 'claude-haiku-4-5';

const envText = (name) => {
  const raw = process.env[name];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
};

export function enrichModel() {
  return envText('ANTHROPIC_ENRICH_MODEL') ?? DEFAULT_ENRICH_MODEL;
}

/**
 * Published list prices, dollars per million tokens, for the estimate the
 * script prints. An estimate: the API bills what it bills, and a model not on
 * this list prints no figure rather than a wrong one. Cached reads of the
 * system prompt are charged at a tenth of the input rate and are counted
 * separately by the script.
 */
export const PRICES = {
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
};

export function estimateCost(model, { input = 0, output = 0, cached = 0 } = {}) {
  const price = PRICES[model];
  if (!price) return null;
  return (input * price.input + cached * price.input * 0.1 + output * price.output) / 1_000_000;
}

// ---------------------------------------------------------------- dossier --

/** How much of a company we show the model. Characters, not tokens; ~4 to 1. */
export const DOSSIER_BUDGET = 6000;
/** At most this many postings' prose, and this many titles, per company. */
export const MAX_DESCRIPTIONS = 3;
export const MAX_TITLES = 14;
/** From each posting: the paragraph that introduces the company, or the top. */
export const EXCERPT_CHARS = 1500;

/**
 * Where a posting starts talking about the company rather than the role.
 *
 * Most descriptions carry a paragraph headed "About Acme", "Who we are", "Our
 * mission" — usually first, sometimes last, occasionally in the middle after
 * the responsibilities. That paragraph is the whole reason this feature is
 * cheap: it is the company describing itself, and reading 1,500 characters
 * from there beats reading the first 1,500 of a posting that opens with "Job
 * Title: Technical Specialist / FLSA Status: Exempt".
 *
 * The company name is matched only when it is a real word — a one-letter slug
 * would turn "About a role" into a heading.
 */
export function aboutOffset(text, name) {
  if (!text) return 0;
  const safe = name && name.length >= 3 ? name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : null;
  const heads = [
    safe ? `about ${safe}` : null,
    'about us', 'about the company', 'about the team', 'who we are', 'our mission',
    'company overview', 'the company', 'our story', 'what we do', 'why join',
  ].filter(Boolean);
  // A heading is the phrase at the start of a line, on its own or followed by
  // punctuation — "About Acme:" — never mid-sentence, where "about us" is just
  // English.
  const re = new RegExp(`(^|\\n)[ \\t]*(?:${heads.join('|')})[ \\t]*[:\\-–—]?[ \\t]*(?:\\n|$)`, 'i');
  const hit = re.exec(text);
  // The offset of the heading itself, not of the newline that precedes it.
  return hit ? hit.index + hit[1].length : 0;
}

/** One posting's contribution: the about-paragraph excerpt, whitespace folded. */
export function excerpt(text, name, chars = EXCERPT_CHARS) {
  if (!text) return '';
  const start = aboutOffset(text, name);
  const slice = text.slice(start, start + chars);
  return slice.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * The text the model reads for one company.
 *
 * Titles first, because they are the cheapest and often the most decisive
 * signal; then up to three postings' about-excerpts, distinct by their first
 * two hundred characters so three copies of the same boilerplate do not crowd
 * out a different one. Trimmed to `DOSSIER_BUDGET` so a company with 900 open
 * roles costs the same call as one with two.
 *
 * @param {object} company  `{ name, slug, website, board_url }`
 * @param {string[]} titles  open titles, most recent first
 * @param {string[]} descriptions  open postings' prose, most recent first
 */
export function dossier(company, titles = [], descriptions = []) {
  const name = (company.name ?? '').trim() || company.slug || 'unknown';
  const lines = [`Company: ${name}`];
  if (company.slug && company.slug !== name) lines.push(`Board slug: ${company.slug}`);
  if (company.website) lines.push(`Website: ${company.website}`);
  else if (company.board_url) lines.push(`Board: ${company.board_url}`);

  const seenTitles = new Set();
  const distinct = [];
  for (const t of titles) {
    const key = String(t ?? '').trim().toLowerCase();
    if (!key || seenTitles.has(key)) continue;
    seenTitles.add(key);
    distinct.push(String(t).trim());
  }
  if (distinct.length) {
    const shown = distinct.slice(0, MAX_TITLES);
    const more = distinct.length > shown.length ? ` (and ${distinct.length - shown.length} more)` : '';
    lines.push(`Open roles: ${shown.join('; ')}${more}`);
  }

  let used = lines.join('\n').length;
  const seenText = new Set();
  let n = 0;
  for (const text of descriptions) {
    if (n >= MAX_DESCRIPTIONS || used >= DOSSIER_BUDGET) break;
    const cut = excerpt(text, name);
    if (cut.length < 80) continue;
    const key = cut.slice(0, 200).toLowerCase();
    if (seenText.has(key)) continue;
    seenText.add(key);
    const room = DOSSIER_BUDGET - used;
    const piece = cut.length > room ? cut.slice(0, room) : cut;
    lines.push('', `--- from a posting ---`, piece);
    used += piece.length + 24;
    n++;
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------- tool --

/** The one tool the model may call. The enum is the schema's list, not a copy. */
export const SECTOR_TOOL = {
  name: 'describe_company',
  description:
    'Record what this company does. Call it exactly once, for the company the postings belong to — ' +
    'the employer, never the role being advertised.',
  input_schema: {
    type: 'object',
    properties: {
      blurb: {
        type: 'string',
        description:
          'One sentence, under 140 characters, plain language, present tense, saying what the company ' +
          'makes or does and for whom. No marketing adjectives, no "leading", no "innovative". Do not ' +
          'start with the company name. e.g. "Payments infrastructure for online marketplaces." or ' +
          '"Regional hospital network in the US Midwest."',
      },
      sector: {
        type: 'string',
        enum: SECTOR_VALUES,
        description:
          'The one bucket the COMPANY belongs to. ' +
          SECTORS.map((s) => `${s.value}: ${s.hint}`).join(' · '),
      },
      confidence: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description:
          'high: the postings say plainly what the company does. medium: inferred from titles and ' +
          'context but not stated. low: the postings do not really say — a low answer is discarded, ' +
          'so use it rather than guess.',
      },
    },
    required: ['blurb', 'sector', 'confidence'],
  },
};

/**
 * The system prompt. Fixed text, on purpose: it is marked cacheable, and a
 * byte that varied per company would throw the cache away. Whether it *is*
 * cached is the model's call — each has a minimum prefix length below which
 * the marker is a no-op, and on Haiku this prompt is under it (measured: 0
 * cached tokens over 40 calls). The cost line in the report is the number to
 * read; the marker costs nothing when it does nothing.
 */
export function systemPrompt() {
  return [
    'You read a few of a company\'s own job postings and say what the company does, by calling',
    'describe_company exactly once.',
    '',
    'THE RULE THAT MATTERS MOST: classify the COMPANY, never the job. The postings are for one role',
    'or a handful; the company is the employer behind all of them. A bank hiring a data engineer is',
    'banking, investing & insurance, not data & analytics. A hospital hiring a software developer is',
    'healthcare providers & services. A staffing agency advertising a client\'s role is HR, recruiting',
    '& staffing. Read the "about us" text and the whole list of open roles together: the roles say',
    'what kind of organisation this is even when the prose does not.',
    '',
    'PICKING THE BUCKET.',
    '- Prefer the specific bucket over the general one. "business software" is for B2B software that',
    '  fits nothing more specific; fintech, health technology, HR tech, developer tools, cybersecurity,',
    '  marketing tech and data & analytics each come first when they fit.',
    '- fintech is a technology company whose product is money; banking, investing & insurance is a',
    '  financial institution. A neobank is fintech. A hedge fund is banking, investing & insurance.',
    '- AI & machine learning is for companies whose product is the model or the AI itself. A company',
    '  that "uses AI" to sell something else belongs with the something else.',
    '- "something else" is for a company that genuinely fits no bucket. It is not a way to avoid',
    '  choosing.',
    '- If the postings do not say what the company does and the titles do not make it clear, set',
    '  confidence to low. A low answer is thrown away, which is the right outcome; a confident guess',
    '  would be stored and used to rule jobs in and out.',
    '',
    'THE BLURB is one plain sentence a job-seeker can read in a list: what the company makes or does',
    'and for whom. Present tense, no adjectives of praise, no mission-statement language, no company',
    'name at the start, under 140 characters. The postings may be in any language; write the blurb',
    'in English.',
  ].join('\n');
}

// ---------------------------------------------------------------- verdict --

/** How long a blurb is allowed to be on a card. Longer ones are cut at a word. */
export const BLURB_MAX = 180;

/**
 * Tool input onto what gets stored. Pure, and the half worth testing.
 *
 * Returns `{ sector, blurb, confidence }`, with `sector` null for anything the
 * filter must treat as unknown: a low confidence, a value outside `SECTORS`, a
 * missing field. The blurb survives a low confidence — "we could not tell" is
 * a worse line on a card than the model's best sentence, and the blurb rules
 * nothing in or out.
 */
export function readVerdict(input = {}) {
  const confidence = ['high', 'medium', 'low'].includes(input.confidence) ? input.confidence : 'low';
  const raw = typeof input.sector === 'string' ? input.sector.trim().toLowerCase() : null;
  const sector = raw && SECTOR_VALUES.includes(raw) && confidence !== 'low' ? raw : null;

  let blurb = typeof input.blurb === 'string' ? input.blurb.replace(/\s+/g, ' ').trim() : '';
  // Quotes and a stray leading label both happen; neither belongs on a card.
  blurb = blurb.replace(/^["'“”]+|["'“”]+$/g, '').replace(/^blurb:\s*/i, '').trim();
  if (blurb.length > BLURB_MAX) {
    const cut = blurb.slice(0, BLURB_MAX);
    blurb = `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 60)).replace(/[,;:\-–—]$/, '')}…`;
  }
  if (blurb && !/[.!?…]$/.test(blurb)) blurb += '.';

  return { sector, blurb: blurb || null, confidence };
}

// ------------------------------------------------------------------- call --

/**
 * Models that think by default cannot be forced onto a tool — the two features
 * have historically not combined — so the tool is forced only where forcing is
 * safe and left to `auto` elsewhere, with the no-call case handled as unsure
 * rather than assumed away.
 */
const thinksByDefault = (model) => /opus-5|fable|mythos|sonnet-5/.test(model);

let clientPromise = null;
async function anthropic(apiKey) {
  if (!clientPromise) {
    clientPromise = import('@anthropic-ai/sdk')
      .then(({ default: Anthropic }) => ({
        // A bulk job, so it waits out a rate limit rather than failing on it:
        // five retries with the SDK's backoff is a couple of minutes of
        // patience per call, which is the right trade for something unattended.
        client: new Anthropic({ apiKey, maxRetries: 5 }),
        Anthropic,
      }))
      .catch((err) => {
        clientPromise = null;
        throw new Error(`the Anthropic SDK is not installed — run "npm install" in this project (${err.message})`);
      });
  }
  return clientPromise;
}

/**
 * One company, one call.
 *
 * @returns {Promise<{verdict: object|null, usage: object, note: string|null}>}
 *   `verdict` null means the model declined or answered in prose — stored as
 *   read-and-unsure by the caller, so it is not re-spent on tomorrow.
 * @throws with a sentence from `explain` on an API failure. The caller decides
 *   whether the failure is one worth continuing past.
 */
export async function classifyCompany(text, { model = enrichModel(), config = aiConfig() } = {}) {
  if (!config.enabled) throw new Error('no API key — set ANTHROPIC_API_KEY in .env');
  const { client, Anthropic } = await anthropic(config.apiKey);

  let response;
  try {
    response = await client.messages.create({
      model,
      max_tokens: 400,
      system: [{ type: 'text', text: systemPrompt(), cache_control: { type: 'ephemeral' } }],
      tools: [SECTOR_TOOL],
      tool_choice: thinksByDefault(model) ? { type: 'auto' } : { type: 'tool', name: SECTOR_TOOL.name },
      messages: [{ role: 'user', content: text }],
    });
  } catch (err) {
    const wrapped = new Error(explain(err, Anthropic, model));
    // The caller reads these to decide whether to keep going: a rejected key
    // fails every call and should stop the run; a rate limit is the SDK's to
    // wait out; anything else is one company's problem.
    wrapped.fatal =
      err instanceof Anthropic.AuthenticationError ||
      err instanceof Anthropic.PermissionDeniedError ||
      err instanceof Anthropic.NotFoundError;
    throw wrapped;
  }

  const usage = {
    input: response.usage?.input_tokens ?? 0,
    output: response.usage?.output_tokens ?? 0,
    cached: response.usage?.cache_read_input_tokens ?? 0,
    cache_written: response.usage?.cache_creation_input_tokens ?? 0,
  };

  if (response.stop_reason === 'refusal') return { verdict: null, usage, note: 'declined' };
  const call = response.content.find((b) => b.type === 'tool_use' && b.name === SECTOR_TOOL.name);
  if (!call) return { verdict: null, usage, note: 'no tool call' };
  return { verdict: readVerdict(call.input), usage, note: null };
}
