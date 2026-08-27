#!/usr/bin/env node
/**
 * Company-sector tests.
 *
 *   node src/enrich-test.mjs
 *
 * Same contract as the rest: no network, no API key, no jobs.db. `enrich.mjs`
 * is split at the one seam worth splitting it at — `classifyCompany` makes the
 * call, and everything either side of it is pure: what the model is shown
 * (`dossier`) and what is stored from what it said (`readVerdict`).
 *
 * Two of the checks are the reason this file exists.
 *
 * **A low confidence stores no sector.** The filter reads `companies.sector`
 * as evidence, and "not finance" rules a company out on it. A guess in that
 * column is therefore the one thing worse than a blank — the blank stays in
 * every search by default; the guess removes jobs — so the verdict reader has
 * to drop it, and this is where that is pinned.
 *
 * **The vocabulary is the schema's.** The tool's enum, the prompt's list and
 * the stored value all have to be `SECTORS`, or a bucket added to the schema
 * is one the model is never offered and a bucket the model invents is one the
 * facet cannot draw.
 */

import {
  aboutOffset,
  excerpt,
  dossier,
  readVerdict,
  estimateCost,
  systemPrompt,
  SECTOR_TOOL,
  DOSSIER_BUDGET,
  MAX_TITLES,
  MAX_DESCRIPTIONS,
  BLURB_MAX,
  DEFAULT_ENRICH_MODEL,
} from './lib/enrich.mjs';
import { SECTORS, SECTOR_VALUES } from './lib/schema.mjs';

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed++;
  else failures.push(`${name}\n      got      ${a}\n      expected ${e}`);
}

// ------------------------------------------------------------- vocabulary --
{
  check('sectors: every value is a kebab-case id', SECTOR_VALUES.every((v) => /^[a-z][a-z-]*[a-z]$/.test(v)), true);
  check('sectors: no duplicates', new Set(SECTOR_VALUES).size, SECTOR_VALUES.length);
  check('sectors: every bucket carries a label and a hint', SECTORS.every((s) => s.label && s.hint), true);
  check('sectors: "other" is a real answer on the list', SECTOR_VALUES.includes('other'), true);
  // Both halves of the finance question have to be there, because they are
  // the whole reason the vocabulary is not one "finance" bucket.
  check('sectors: fintech and financial-services are distinct', [SECTOR_VALUES.includes('fintech'), SECTOR_VALUES.includes('financial-services')], [true, true]);

  const props = SECTOR_TOOL.input_schema.properties;
  check('tool: the enum is the schema list, not a copy', props.sector.enum, SECTOR_VALUES);
  check('tool: every hint reaches the model', SECTORS.every((s) => props.sector.description.includes(s.hint)), true);
  check('tool: confidence is required', SECTOR_TOOL.input_schema.required.includes('confidence'), true);
  check('tool: the description says company, not role', /employer|company/i.test(SECTOR_TOOL.description), true);
  // The prompt is cached across a run, which only works if it is the same
  // bytes every time. Two calls, one string.
  check('prompt: is fixed text', systemPrompt(), systemPrompt());
  check('prompt: no clock in it', /\d{4}-\d{2}-\d{2}/.test(systemPrompt()), false);
  check('prompt: names the rule that matters', systemPrompt().includes('classify the COMPANY, never the job'), true);
}

// ---------------------------------------------------------------- excerpt --
{
  const posting =
    'Job Title: Technical Specialist\nFLSA Status: Exempt\n\nSummary\nYou will do things.\n\n' +
    'About Acme\nAcme builds payment rails for marketplaces in forty countries.\n\nBenefits\nDental.';

  check('about: finds the company heading', posting.slice(aboutOffset(posting, 'Acme')).startsWith('About Acme'), true);
  check('about: or a generic one', 'Role\nStuff.\n\nWho we are\nA hospital.'.slice(aboutOffset('Role\nStuff.\n\nWho we are\nA hospital.', 'X')).startsWith('Who we are'), true);
  check('about: the heading must own its line', aboutOffset('We talk about us a lot here.\nThen more.', 'X'), 0);
  check('about: nothing found is the top', aboutOffset('Just a role description.', 'Acme'), 0);
  check('about: a one-letter name is not a heading', aboutOffset('About a role that exists.\nMore.', 'a'), 0);
  check('about: a name with regex characters is safe', aboutOffset('About C++ Inc.\nWe do C.', 'C++ Inc.'), 0);
  check('about: empty text', aboutOffset('', 'Acme'), 0);

  const cut = excerpt(posting, 'Acme', 40);
  check('excerpt: starts at the heading and is capped', [cut.startsWith('About Acme'), cut.length <= 40], [true, true]);
  check('excerpt: folds runs of blank lines', excerpt('a\n\n\n\n\nb', 'x').includes('\n\n\n'), false);
}

// ---------------------------------------------------------------- dossier --
{
  const company = { name: 'Acme', slug: 'acme', website: 'https://acme.com', board_url: 'https://jobs.ashbyhq.com/acme' };
  const text = dossier(company, ['Underwriter', 'underwriter ', 'Claims Adjuster'], ['About Acme\nAcme insures small fleets. '.padEnd(400, 'x')]);

  check('dossier: names the company', text.startsWith('Company: Acme'), true);
  check('dossier: the website wins over the board url', [text.includes('Website: https://acme.com'), text.includes('Board: ')], [true, false]);
  check('dossier: titles are distinct, case-insensitively, and in order', text.includes('Open roles: Underwriter; Claims Adjuster'), true);
  check('dossier: the posting is in', text.includes('Acme insures small fleets'), true);

  const noSite = dossier({ name: 'Acme', slug: 'acme', board_url: 'https://jobs.ashbyhq.com/acme' });
  check('dossier: the board url stands in for a missing website', noSite.includes('Board: https://jobs.ashbyhq.com/acme'), true);
  check('dossier: a nameless board is named by its slug', dossier({ slug: 'acme' }).startsWith('Company: acme'), true);

  // The cap. A board with 900 roles costs the same call as one with two.
  const many = Array.from({ length: 300 }, (_, i) => `Role ${i}`);
  const long = Array.from({ length: 10 }, (_, i) => `About us\nCompany number ${i}. `.padEnd(5000, `${i}`));
  const big = dossier(company, many, long);
  check('dossier: stays inside the budget', big.length <= DOSSIER_BUDGET + 200, true);
  check('dossier: titles are capped and the tail is counted', big.includes(`Role ${MAX_TITLES - 1}`) && !big.includes(`Role ${MAX_TITLES};`) && big.includes(`and ${300 - MAX_TITLES} more`), true);
  check('dossier: at most three postings', (big.match(/--- from a posting ---/g) ?? []).length <= MAX_DESCRIPTIONS, true);

  // Three copies of one boilerplate are one posting's worth of evidence.
  const same = 'About us\nWe make widgets for the widget-curious. '.padEnd(600, 'w');
  const dupes = dossier(company, [], [same, same, same, 'Who we are\nA different company paragraph entirely. '.padEnd(600, 'q')]);
  check('dossier: duplicate excerpts collapse', (dupes.match(/--- from a posting ---/g) ?? []).length, 2);
  check('dossier: a posting too short to say anything is skipped', dossier(company, [], ['tiny']).includes('from a posting'), false);
  check('dossier: nothing to read is still a dossier', dossier(company), 'Company: Acme\nBoard slug: acme\nWebsite: https://acme.com');
}

// ---------------------------------------------------------------- verdict --
{
  const ok = readVerdict({ sector: 'fintech', blurb: '  Payments infrastructure for marketplaces ', confidence: 'high' });
  check('verdict: a confident answer is stored', ok.sector, 'fintech');
  check('verdict: the blurb is trimmed and ends in a full stop', ok.blurb, 'Payments infrastructure for marketplaces.');
  check('verdict: confidence rides along', ok.confidence, 'high');

  check('verdict: medium is still an answer', readVerdict({ sector: 'healthcare', blurb: 'x', confidence: 'medium' }).sector, 'healthcare');

  // The check this file exists for.
  const low = readVerdict({ sector: 'fintech', blurb: 'Probably a bank of some kind.', confidence: 'low' });
  check('verdict: a low confidence stores NO sector', low.sector, null);
  check('verdict: but keeps the sentence', low.blurb, 'Probably a bank of some kind.');
  check('verdict: a missing confidence reads as low', readVerdict({ sector: 'fintech', blurb: 'x' }).sector, null);
  check('verdict: nonsense confidence reads as low', readVerdict({ sector: 'fintech', blurb: 'x', confidence: 'very' }).sector, null);

  // The vocabulary is the schema's, and nothing else gets through.
  check('verdict: an invented bucket is not stored', readVerdict({ sector: 'consulting', blurb: 'x', confidence: 'high' }).sector, null);
  check('verdict: case and whitespace are forgiven', readVerdict({ sector: ' Fintech ', blurb: 'x', confidence: 'high' }).sector, 'fintech');
  check('verdict: "other" is stored as other', readVerdict({ sector: 'other', blurb: 'x', confidence: 'high' }).sector, 'other');
  check('verdict: no input at all', readVerdict(), { sector: null, blurb: null, confidence: 'low' });
  check('verdict: a blank blurb is null, not ""', readVerdict({ sector: 'ai', blurb: '   ', confidence: 'high' }).blurb, null);

  // What lands on a card.
  check('verdict: quotes are stripped', readVerdict({ blurb: '"Makes rockets."', confidence: 'high', sector: 'aerospace-defense' }).blurb, 'Makes rockets.');
  check('verdict: whitespace is folded', readVerdict({ blurb: 'Makes\n\n  rockets', confidence: 'high', sector: 'other' }).blurb, 'Makes rockets.');
  const long = readVerdict({ blurb: 'word '.repeat(80), confidence: 'high', sector: 'other' }).blurb;
  check('verdict: a long blurb is cut at a word with an ellipsis', [long.length <= BLURB_MAX + 1, long.endsWith('…'), long.includes('word …')], [true, true, false]);
  check('verdict: an existing terminal mark is kept', readVerdict({ blurb: 'Is it a bank?', confidence: 'high', sector: 'other' }).blurb, 'Is it a bank?');
}

// ------------------------------------------------------------------- cost --
{
  check('cost: the default model is priced', typeof estimateCost(DEFAULT_ENRICH_MODEL, { input: 1_000_000 }), 'number');
  check('cost: a million input tokens on the default is a dollar', estimateCost(DEFAULT_ENRICH_MODEL, { input: 1_000_000 }), 1);
  check('cost: cached input is a tenth', estimateCost(DEFAULT_ENRICH_MODEL, { cached: 1_000_000 }), 0.1);
  check('cost: output is priced separately', estimateCost(DEFAULT_ENRICH_MODEL, { output: 1_000_000 }), 5);
  check('cost: an unpriced model prints nothing rather than a wrong number', estimateCost('claude-mystery-9', { input: 10 }), null);
  check('cost: nothing spent is nothing', estimateCost(DEFAULT_ENRICH_MODEL), 0);
}

// ------------------------------------------------------------------- done --
if (failures.length) {
  console.error(`\n${failures.length} failing:\n`);
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  console.error(`${passed} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`✓ ${passed} enrich checks passed`);
