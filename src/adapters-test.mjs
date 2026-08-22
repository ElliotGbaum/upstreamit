#!/usr/bin/env node
/**
 * Adapter tests.
 *
 *   node src/adapters-test.mjs
 *
 * Same contract as `derive-test.mjs` and `filter-test.mjs`: no database, no
 * network, pure functions, milliseconds to run. Every fixture below is a real
 * shape observed on a live board, not an invented one.
 *
 * The cases that matter most are the ones that fail silently, because nothing
 * downstream can tell a mangled description from a badly-written one:
 *
 *  - The two entity-decode cases. A second decode pass looks harmless and
 *    corrupts 96.8% of Greenhouse payloads — the single easiest way to degrade
 *    the description gate and the skills, degree and visa derivations at once.
 *  - Lever's description assembly. `description` there is only the opening
 *    third of a posting; the requirements live in `lists[]`. Storing the field
 *    the obvious way leaves those same four derivations reading a coherent,
 *    populated, two-thirds-empty text.
 */

import { decodeEntitiesOnce, htmlToText } from './lib/adapters/html.mjs';
import { countryName } from './lib/adapters/iso-countries.mjs';
import { mapJob } from './lib/adapters/greenhouse.mjs';
import {
  mapJob as mapLeverJob,
  buildHtml as buildLeverHtml,
  employmentType as leverEmploymentType,
} from './lib/adapters/lever.mjs';

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed++;
  else failures.push(`${name}\n      got      ${a}\n      expected ${e}`);
}

// ------------------------------------------------------------- decode once --

check('decode: escaped markup becomes markup', decodeEntitiesOnce('&lt;h2&gt;Who we are&lt;/h2&gt;'), '<h2>Who we are</h2>');

// 1,104 of 1,140 sampled payloads carry `&amp;amp;` — the correct single-escape
// of a literal `&` in the prose. One pass yields `&amp;`, which renders as `&`.
// A second pass yields a bare `&`, which then swallows the next word.
check('decode: &amp;amp; decodes once, not twice', decodeEntitiesOnce('Fish &amp;amp; chips'), 'Fish &amp; chips');
check(
  'decode: decoding twice would corrupt it (this is the bug)',
  decodeEntitiesOnce(decodeEntitiesOnce('Fish &amp;amp; chips')),
  'Fish & chips',
);

// 2 of 1,140 are genuinely double-escaped — the posting displayed a literal
// `&lt;`. A single decode is right for those too.
check('decode: genuinely double-escaped stays escaped', decodeEntitiesOnce('&amp;lt;p&amp;gt;'), '&lt;p&gt;');

check('decode: numeric reference', decodeEntitiesOnce('caf&#233;'), 'café');
check('decode: hex reference', decodeEntitiesOnce('caf&#xe9;'), 'café');
check('decode: nbsp becomes a real space', decodeEntitiesOnce('a&nbsp;b'), 'a b');
check('decode: unknown entity is left alone', decodeEntitiesOnce('P&L; responsibility'), 'P&L; responsibility');
check('decode: a bare ampersand survives', decodeEntitiesOnce('R&D team'), 'R&D team');
check('decode: no ampersand is a fast path', decodeEntitiesOnce('plain text'), 'plain text');
check('decode: non-string is empty', decodeEntitiesOnce(null), '');
// A lone surrogate would break JSON round-tripping and SQLite storage.
check('decode: lone surrogate is refused', decodeEntitiesOnce('&#55296;'), '&#55296;');

// -------------------------------------------------------------- html→text --

check('text: paragraphs are blank-line separated', htmlToText('<p>One</p><p>Two</p>'), 'One\n\nTwo');
// Single-spaced on purpose: most of a description is bullets, and a blank
// line between each one doubles the length of the detail pane.
check('text: list items are single-spaced', htmlToText('<ul><li>A</li><li>B</li></ul>'), 'A\nB');
check('text: br is a line break', htmlToText('One<br>Two'), 'One\nTwo');
check('text: headings separate', htmlToText('<h2>Title</h2><p>Body</p>'), 'Title\n\nBody');
// The failure the plan called out: a weak strip glues `</p>` to the next
// sentence and the FTS gate then matches phrases that were never adjacent.
check('text: closing tags never glue words together', htmlToText('<p>ends here</p><p>starts here</p>'), 'ends here\n\nstarts here');
check('text: unclosed block tags still break', htmlToText('<div>One<div>Two'), 'One\n\nTwo');
check('text: script bodies are dropped', htmlToText('<p>Real</p><script>var x = 1;</script>'), 'Real');
check('text: style bodies are dropped', htmlToText('<style>.a{color:red}</style><p>Real</p>'), 'Real');
check('text: comments are dropped', htmlToText('<p>A</p><!-- hidden --><p>B</p>'), 'A\n\nB');
// Decoded *after* the tags are gone, so escaped markup in the prose can never
// become a tag.
check('text: entities decode after the strip', htmlToText('<p>Fish &amp; chips</p>'), 'Fish & chips');
check('text: escaped markup in prose stays text', htmlToText('<p>use &lt;div&gt; here</p>'), 'use <div> here');
check('text: nbsp collapses to a plain space', htmlToText('<p>a&nbsp;b</p>'), 'a b');
check('text: runs of blank lines collapse', htmlToText('<p>A</p><p></p><p></p><p>B</p>'), 'A\n\nB');
check('text: table cells do not run together', htmlToText('<table><tr><td>Salary</td><td>Location</td></tr></table>'), 'Salary Location');
check('text: a paragraph inside a list item still breaks', htmlToText('<li><p>A</p></li><li>B</li>'), 'A\n\nB');
check('text: a bare < in prose survives', htmlToText('<p>salary < 100k</p>'), 'salary < 100k');
check('text: empty input is empty', htmlToText(''), '');

// ------------------------------------------------------------ greenhouse --

/** A row shaped exactly like the board API returns one. */
const row = (overrides = {}) => ({
  id: 8130725,
  internal_job_id: 3520748,
  title: '  Account Executive  ',
  company_name: 'Stripe',
  location: { name: 'San Francisco' },
  offices: [{ id: 65234, name: 'US', location: null }],
  departments: [{ id: 336773, name: '1653 Startups - Account Executives (NA)' }],
  updated_at: '2026-08-19T14:02:07-04:00',
  first_published: '2026-08-01T09:00:00-04:00',
  absolute_url: 'https://stripe.com/jobs/search?gh_jid=8130725',
  content: '&lt;p&gt;Build things &amp;amp; ship them.&lt;/p&gt;',
  ...overrides,
});

{
  const j = mapJob(row(), 'stripe');
  check('gh: ats is literal', j.ats, 'greenhouse');
  check('gh: id is stable and namespaced', j.id, 'greenhouse:stripe:8130725');
  // `internal_job_id` is a different number on the same job; using it would
  // break every URL and every re-sweep.
  check('gh: native_id is `id`, not `internal_job_id`', j.native_id, '8130725');
  check('gh: title is trimmed', j.title, 'Account Executive');
  check('gh: company_name comes off the job', j.company_name, 'Stripe');
  check('gh: department is the raw internal string', j.department, '1653 Startups - Account Executives (NA)');
  check('gh: posted_at prefers first_published', j.posted_at, Date.parse('2026-08-01T09:00:00-04:00'));
  check('gh: source_updated_at is updated_at', j.source_updated_at, Date.parse('2026-08-19T14:02:07-04:00'));

  // Gotchas 3 and 4: Greenhouse publishes neither, and the adapter must not
  // invent them from the location string.
  check('gh: no employment type is published', j.employment_type, null);
  check('gh: no workplace enum is published', j.raw_workplace, null);
  check('gh: raw_remote is not synthesized', j.raw_remote, null);

  // Gotcha 1 and 2 together, on a real payload.
  check('gh: description_html is decoded exactly once', j.description_html, '<p>Build things &amp; ship them.</p>');
  check('gh: description_text is plain', j.description_text, 'Build things & ship them.');
}
{
  // A remote-sounding location is still not a workplace enum. `deriveWorkplace`
  // reads the string and records that it guessed; the adapter does not decide.
  const j = mapJob(row({ location: { name: 'Remote - US' } }), 'stripe');
  check('gh: remote in the location does not become an enum', j.raw_workplace, null);
  check('gh: location_raw is verbatim', j.location_raw, 'Remote - US');
}
{
  // Gotcha 6: the union of the location string, office names and office
  // locations, deduped. No comma-splitting — that is the derive pass's job.
  const j = mapJob(
    row({
      location: { name: 'New York, New York, United States' },
      offices: [
        { name: 'US', location: null },
        { name: 'NYC', location: 'New York, New York, United States' },
      ],
    }),
    'stripe',
  );
  check('gh: locations_all unions and dedupes', j.locations_all, ['New York, New York, United States', 'US', 'NYC']);
}
{
  // Gotcha 5, the one that would put every Greenhouse job in the $200k+ band.
  const j = mapJob(row({ pay_input_ranges: [{ min_cents: 8500000, max_cents: 10000000, currency_type: 'USD', title: 'Salary Range' }] }), 'x');
  check('gh: cents become dollars', [j.comp_min, j.comp_max], [85000, 100000]);
  check('gh: currency passes through', j.comp_currency, 'USD');
  check('gh: interval defaults to YEAR', j.comp_interval, 'YEAR');
  check('gh: comp_text is the range title', j.comp_text, 'Salary Range');
}
{
  const j = mapJob(row({ pay_input_ranges: [{ min_cents: 4500, max_cents: 6000, currency_type: 'USD', title: 'Hourly Pay Range' }] }), 'x');
  check('gh: an hourly title sets HOUR', j.comp_interval, 'HOUR');
  check('gh: hourly figures are still cents', [j.comp_min, j.comp_max], [45, 60]);
}
{
  // Several ranges per job, and they are not all base salary. A bonus range
  // read as pay puts a $10k figure where a $150k one belongs.
  const j = mapJob(
    row({
      pay_input_ranges: [
        { min_cents: 500000, max_cents: 1000000, currency_type: 'USD', title: 'Bonus Range' },
        { min_cents: 15000000, max_cents: 18000000, currency_type: 'USD', title: 'Zone 1 Pay Range' },
      ],
    }),
    'x',
  );
  check('gh: a bonus range is skipped for a real one', [j.comp_min, j.comp_max], [150000, 180000]);
}
{
  // OTE folds commission in. Usable, but never in preference to a base range on
  // the same job — and the array order is not reliably base-first.
  const j = mapJob(
    row({
      pay_input_ranges: [
        { min_cents: 20000000, max_cents: 24000000, currency_type: 'USD', title: 'OTE Range' },
        { min_cents: 12000000, max_cents: 14000000, currency_type: 'USD', title: 'Base Salary Range' },
      ],
    }),
    'x',
  );
  check('gh: base beats OTE regardless of order', j.comp_min, 120000);
}
{
  const j = mapJob(row({ pay_input_ranges: [{ min_cents: 20000000, max_cents: 24000000, currency_type: 'USD', title: 'OTE Range' }] }), 'x');
  check('gh: OTE alone is still better than no figure', j.comp_min, 200000);
}
{
  const j = mapJob(row({ pay_input_ranges: [{ min_cents: 500000, max_cents: 1000000, currency_type: 'USD', title: 'Signing Bonus' }] }), 'x');
  check('gh: a job with only a bonus range has no salary', j.comp_min, null);
}
{
  check('gh: no pay_transparency key means no salary', mapJob(row(), 'x').comp_min, null);
  check('gh: a row with no id is dropped', mapJob(row({ id: undefined }), 'x'), null);
  check('gh: a row with no title is dropped', mapJob(row({ title: '   ' }), 'x'), null);
  check('gh: a non-object is dropped', mapJob(null, 'x'), null);
}
{
  // `absolute_url` often points at the employer's own careers site; the hosted
  // board page is the uniform fallback for applying.
  const j = mapJob(row({ absolute_url: undefined }), 'stripe');
  check('gh: url falls back to the hosted board', j.url, 'https://job-boards.greenhouse.io/stripe');
  check('gh: apply_url falls back to the hosted job page', j.apply_url, 'https://job-boards.greenhouse.io/stripe/jobs/8130725');
}
{
  const j = mapJob(row({ first_published: null }), 'x');
  check('gh: posted_at falls back to updated_at', j.posted_at, Date.parse('2026-08-19T14:02:07-04:00'));
}

// ----------------------------------------------------------------- lever --

/**
 * A row shaped exactly like `api.lever.co/v0/postings/<slug>?mode=json` returns
 * one, down to the naked `<li>` run in `lists[].content` and the ISO country
 * code. Real HTML in `description`, not the escaped markup Greenhouse sends.
 */
const leverRow = (overrides = {}) => ({
  id: 'c9b80e4f-3588-4ce7-b735-88d84e0bba06',
  text: 'Director of Product Management',
  categories: {
    commitment: 'Full-time',
    department: 'Product',
    team: 'Product Management',
    location: 'Los Angeles',
    allLocations: ['Los Angeles'],
  },
  country: 'US',
  workplaceType: 'hybrid',
  createdAt: 1699661326937,
  hostedUrl: 'https://jobs.lever.co/adhoclabs/c9b80e4f-3588-4ce7-b735-88d84e0bba06',
  applyUrl: 'https://jobs.lever.co/adhoclabs/c9b80e4f-3588-4ce7-b735-88d84e0bba06/apply',
  description: '<div>Build things &amp; ship them.</div>',
  descriptionPlain: 'Build things & ship them.',
  lists: [{ text: 'Qualifications', content: '<li>Five years of it</li><li>A pulse</li>' }],
  additional: '<div>We are an equal opportunity employer.</div>',
  additionalPlain: 'We are an equal opportunity employer.',
  ...overrides,
});

{
  const j = mapLeverJob(leverRow(), 'adhoclabs');
  check('lv: ats is literal', j.ats, 'lever');
  check('lv: id is stable and namespaced', j.id, 'lever:adhoclabs:c9b80e4f-3588-4ce7-b735-88d84e0bba06');
  check('lv: title comes from `text`', j.title, 'Director of Product Management');
  check('lv: department and team are both published', [j.department, j.team], ['Product', 'Product Management']);
  // createdAt is already epoch ms, and there is no updated timestamp at all.
  check('lv: posted_at is createdAt verbatim', j.posted_at, 1699661326937);
  check('lv: no updated timestamp is published', j.source_updated_at, null);
  // No company name anywhere in this API — `fetchOrganization` gets it or nothing does.
  check('lv: company_name is not in the payload', j.company_name, null);
  check('lv: url is the hosted posting', j.url, 'https://jobs.lever.co/adhoclabs/c9b80e4f-3588-4ce7-b735-88d84e0bba06');
  check('lv: apply_url is the hosted apply page', j.apply_url, 'https://jobs.lever.co/adhoclabs/c9b80e4f-3588-4ce7-b735-88d84e0bba06/apply');
}

// --- the one that matters: `description` is only the opening third ----------
{
  const j = mapLeverJob(leverRow(), 'adhoclabs');
  // Storing `descriptionPlain` alone would drop the qualifications entirely —
  // 50.3% of the corpus by character, and the half that the skills, years,
  // degree and visa derivations read. It fails silently, which is why it is
  // pinned here.
  check(
    'lv: the whole posting is assembled, not just `description`',
    j.description_text,
    'Build things & ship them.\n\nQualifications\n\nFive years of it\nA pulse\n\nWe are an equal opportunity employer.',
  );
  check('lv: the qualifications survive into the text', /Five years of it/.test(j.description_text), true);
  check('lv: the closing survives into the text', /equal opportunity/.test(j.description_text), true);
}
{
  // `lists[].content` is a bare run of <li> with no <ul> and the heading is a
  // sibling field. Concatenated raw, the heading glues onto the first bullet.
  const html = buildLeverHtml(leverRow());
  check('lv: a heading is wrapped so it cannot glue to its first bullet', /<h3>Qualifications<\/h3><ul><li>/.test(html), true);
  check('lv: headings and bullets end up on separate lines', htmlToText(html).includes('Qualifications\n\nFive years of it'), true);
}
{
  // Lever sends real markup, the exact opposite of Greenhouse. Decoding first
  // would turn `&amp;` into a bare `&`, and a `&lt;p&gt;` written in the prose
  // into a tag. `htmlToText` decodes last, after the tags are gone.
  const j = mapLeverJob(leverRow({
    description: '<div>use &lt;div&gt; here, R&amp;D team</div>',
    lists: [],
    additional: null,
  }), 'x');
  check('lv: markup is not pre-decoded', j.description_text, 'use <div> here, R&D team');
}
{
  const j = mapLeverJob(leverRow({ lists: [], additional: null }), 'x');
  check('lv: a posting with no lists is still fine', j.description_text, 'Build things & ship them.');
  const k = mapLeverJob(leverRow({ description: null, lists: [], additional: null }), 'x');
  check('lv: a posting with no text at all is NULL, not empty string', k.description_text, null);
}
{
  const html = buildLeverHtml(leverRow({ lists: [{ text: '   ', content: '   ' }] }));
  check('lv: an empty list contributes nothing', /<h3>|<ul>/.test(html), false);
  const bare = buildLeverHtml(leverRow({ lists: [{ text: 'Benefits', content: '' }] }));
  check('lv: a heading with no bullets still renders', /<h3>Benefits<\/h3>/.test(bare), true);
}

// --- workplace: a real enum, and one value that must not be passed through --
{
  check('lv: hybrid passes through', mapLeverJob(leverRow(), 'x').raw_workplace, 'hybrid');
  check('lv: remote passes through', mapLeverJob(leverRow({ workplaceType: 'remote' }), 'x').raw_workplace, 'remote');
  check('lv: onsite passes through', mapLeverJob(leverRow({ workplaceType: 'onsite' }), 'x').raw_workplace, 'onsite');
  // The load-bearing one. Passed through, `deriveWorkplace` answers
  // `ats-enum-unrecognised:unspecified` and never consults the location text —
  // suppressing the fallback for exactly the jobs that have no enum to use.
  check('lv: `unspecified` becomes NULL, not an unrecognised enum', mapLeverJob(leverRow({ workplaceType: 'unspecified' }), 'x').raw_workplace, null);
  check('lv: an unknown enum value becomes NULL', mapLeverJob(leverRow({ workplaceType: 'flexible' }), 'x').raw_workplace, null);
  // Lever publishes no remote boolean; synthesizing one from the enum would
  // just restate the enum.
  check('lv: raw_remote is not synthesized', mapLeverJob(leverRow(), 'x').raw_remote, null);
}

// --- employment type: free text that only sometimes names one thing --------
{
  check('lv: a plain full-time value maps', leverEmploymentType('Full-time'), 'FullTime');
  check('lv: capitalisation does not matter', leverEmploymentType('FULL TIME'), 'FullTime');
  // A real value on 24 jobs; `[\s-]?` would miss it.
  check('lv: a stray space inside the word still maps', leverEmploymentType('Full- Time'), 'FullTime');
  check('lv: part time maps', leverEmploymentType('Part Time'), 'PartTime');
  check('lv: internship maps', leverEmploymentType('Internship'), 'Intern');
  // The commonest value in the whole corpus (3,462 jobs) and genuinely
  // ambiguous. A wrong `Contract` here would rule the job out of a filter that
  // a NULL leaves it in.
  check('lv: "Contract Full time" names two families and is refused', leverEmploymentType('Contract Full time'), null);
  check('lv: "Full-time or Part-time" is genuinely both', leverEmploymentType('Full-time or Part-time'), null);
  check('lv: "Temporary/Contract" is refused', leverEmploymentType('Temporary/Contract'), null);
  // Real answers, in a vocabulary this column does not have.
  check('lv: "Permanent" is not an employment type here', leverEmploymentType('Permanent'), null);
  check('lv: a non-English value is refused, not guessed', leverEmploymentType('正社員'), null);
  // Boards put a workplace in this field. It is not one.
  check('lv: "Remote" in the commitment field is not an employment type', leverEmploymentType('Remote'), null);
  check('lv: nothing published is NULL', leverEmploymentType(undefined), null);
  check('lv: an empty string is NULL', leverEmploymentType('   '), null);
  check('lv: it reaches the mapped job', mapLeverJob(leverRow(), 'x').employment_type, 'FullTime');
}

// --- country: an ISO code, which must never reach the location parser raw --
{
  // `parseFragment` reads a bare two-letter token as a US state or Canadian
  // province, because in a location string that is what it is. "DE" would
  // become Delaware on 805 jobs, "CA" California on 183, "NL" Newfoundland on 88.
  check('lv: an ISO code is expanded to a name', mapLeverJob(leverRow({ country: 'DE' }), 'x').country, 'Germany');
  check('lv: US expands too', mapLeverJob(leverRow(), 'x').country, 'United States');
  check('lv: CA is Canada, not California', mapLeverJob(leverRow({ country: 'CA' }), 'x').country, 'Canada');
  check('lv: NL is the Netherlands, not Newfoundland', mapLeverJob(leverRow({ country: 'NL' }), 'x').country, 'Netherlands');
  check('lv: no country is NULL', mapLeverJob(leverRow({ country: null }), 'x').country, null);
  // Falling back to the raw code would quietly reintroduce the whole bug for
  // whichever code was missing from the table.
  check('lv: an unknown code is NULL, never the bare code', countryName('XX'), null);
  check('lv: a name is not a code and is refused', countryName('United States'), null);
  // Lever publishes no structured address, so nothing is pre-parsed.
  const j = mapLeverJob(leverRow(), 'x');
  check('lv: there is no structured address', [j.city, j.region, j.postal_code], [null, null, null]);
}

// --- locations -------------------------------------------------------------
{
  const j = mapLeverJob(leverRow({
    categories: { location: 'Europe', allLocations: ['Europe', 'Lisbon', 'Madrid'] },
  }), 'x');
  check('lv: locations_all unions primary and all, primary first', j.locations_all, ['Europe', 'Lisbon', 'Madrid']);
  check('lv: location_raw is the primary, verbatim', j.location_raw, 'Europe');
  // No comma-splitting — "San Francisco, California" is one place, and
  // `parseFragment` already splits on every plausible separator.
  const k = mapLeverJob(leverRow({
    categories: { location: 'San Francisco, California', allLocations: ['San Francisco, California'] },
  }), 'x');
  check('lv: a comma is not a list separator', k.locations_all, ['San Francisco, California']);
}

// --- salary: plain units, not cents ----------------------------------------
{
  const j = mapLeverJob(leverRow({ salaryRange: { min: 100000, max: 200000, currency: 'USD', interval: 'per-year-salary' } }), 'x');
  // Greenhouse sends cents and needs a /100. Lever does not, and applying one
  // would be just as wrong in the other direction.
  check('lv: figures are plain units, not cents', [j.comp_min, j.comp_max], [100000, 200000]);
  check('lv: per-year-salary is YEAR', j.comp_interval, 'YEAR');
  check('lv: currency passes through', j.comp_currency, 'USD');
}
{
  const j = mapLeverJob(leverRow({ salaryRange: { min: 15, max: 15, currency: 'USD', interval: 'per-hour-wage' } }), 'x');
  check('lv: per-hour-wage is HOUR', j.comp_interval, 'HOUR');
  check('lv: an hourly figure is not scaled', [j.comp_min, j.comp_max], [15, 15]);
}
{
  // Why PER_YEAR gained BIWEEK and SEMI_MONTH: with no factor, $3,000
  // fortnightly reads as implausible under every interval `deriveSalary` tries
  // except MONTH, and the job is filed at $36k instead of $78k.
  check('lv: bi-week-salary is BIWEEK', mapLeverJob(leverRow({ salaryRange: { min: 3000, max: 3000, interval: 'bi-week-salary' } }), 'x').comp_interval, 'BIWEEK');
  check('lv: semi-month-salary is SEMI_MONTH', mapLeverJob(leverRow({ salaryRange: { min: 3000, max: 3000, interval: 'semi-month-salary' } }), 'x').comp_interval, 'SEMI_MONTH');
  check('lv: one-time is NONE, the same as Ashby spells it', mapLeverJob(leverRow({ salaryRange: { min: 5000, max: 5000, interval: 'one-time' } }), 'x').comp_interval, 'NONE');
  // An interval Lever adds later is unknown, not assumed annual; `deriveSalary`
  // reinterprets from the magnitude when this is NULL.
  check('lv: an unrecognised interval is NULL, not YEAR', mapLeverJob(leverRow({ salaryRange: { min: 1000, max: 2000, interval: 'per-fortnight' } }), 'x').comp_interval, null);
}
{
  const j = mapLeverJob(leverRow({ salaryRange: { min: 120000, currency: 'EUR', interval: 'per-year-salary' } }), 'x');
  check('lv: a one-ended range fills max from min', [j.comp_min, j.comp_max], [120000, 120000]);
  check('lv: a non-USD currency passes through', j.comp_currency, 'EUR');
  // 11 of 1,608 ranges carry no usable number. NULL reads as "published
  // nothing", which is true; 0 would read as "published zero".
  check('lv: a range with no usable figure is NULL', mapLeverJob(leverRow({ salaryRange: { min: 0, max: 0 } }), 'x').comp_min, null);
  check('lv: no salaryRange at all is NULL', mapLeverJob(leverRow(), 'x').comp_min, null);
  check('lv: prose compensation is kept when that is all there is', mapLeverJob(leverRow({ salaryDescriptionPlain: 'Competitive, plus equity' }), 'x').comp_text, 'Competitive, plus equity');
  // Lever has no equity field.
  check('lv: has_equity is not invented', mapLeverJob(leverRow(), 'x').has_equity, null);
}

// --- rows that should be dropped -------------------------------------------
{
  check('lv: a row with no id is dropped', mapLeverJob(leverRow({ id: undefined }), 'x'), null);
  check('lv: a row with no title is dropped', mapLeverJob(leverRow({ text: '   ' }), 'x'), null);
  check('lv: a non-object is dropped', mapLeverJob(null, 'x'), null);
}

// -------------------------------------------------------------------------- //

if (failures.length) {
  console.error(`\n✗ ${failures.length} adapter check(s) failed:\n`);
  for (const failure of failures) console.error(`  ${failure}\n`);
  process.exit(1);
}
console.log(`✓ ${passed} adapter checks passed`);
