#!/usr/bin/env node
/**
 * Archive slug discovery, and the store rule it depends on.
 *
 * Nothing here touches the network: the loaders are split so that everything
 * worth checking — which crawls to read, how a bookmark advances, what a reply
 * parses to — is a pure function over a fixture.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  commonCrawlUrl,
  nextWaybackFrom,
  parseCommonCrawlPage,
  parseWaybackRows,
  pickCrawls,
  toCdxDate,
  waybackUrl,
} from './lib/archives.mjs';
import { normalizeSlug } from './lib/normalize.mjs';
import { mergeStore } from './lib/slug-store.mjs';

// collinfo.json as Common Crawl publishes it: newest first.
const COLLINFO = [
  { id: 'CC-MAIN-2026-34' },
  { id: 'CC-MAIN-2026-30' },
  { id: 'CC-MAIN-2026-25' },
  { id: 'CC-MAIN-2026-21' },
];

test('pickCrawls takes the newest crawls when there is no bookmark', () => {
  assert.deepEqual(pickCrawls(COLLINFO, { lastCrawlId: null, max: 2 }), ['CC-MAIN-2026-34', 'CC-MAIN-2026-30']);
});

test('pickCrawls returns nothing when the newest crawl is already read', () => {
  assert.deepEqual(pickCrawls(COLLINFO, { lastCrawlId: 'CC-MAIN-2026-34' }), []);
});

test('pickCrawls catches up on every crawl published since the bookmark', () => {
  assert.deepEqual(pickCrawls(COLLINFO, { lastCrawlId: 'CC-MAIN-2026-25', max: 5 }), [
    'CC-MAIN-2026-34',
    'CC-MAIN-2026-30',
  ]);
});

test('pickCrawls caps catch-up at max, so a long gap cannot become an unbounded run', () => {
  assert.deepEqual(pickCrawls(COLLINFO, { lastCrawlId: 'CC-MAIN-2026-21', max: 1 }), ['CC-MAIN-2026-34']);
});

test('pickCrawls treats a bookmark that has aged out of the listing as no bookmark', () => {
  assert.deepEqual(pickCrawls(COLLINFO, { lastCrawlId: 'CC-MAIN-2019-01', max: 2 }), [
    'CC-MAIN-2026-34',
    'CC-MAIN-2026-30',
  ]);
});

test('pickCrawls tolerates an empty or malformed listing', () => {
  assert.deepEqual(pickCrawls([], {}), []);
  assert.deepEqual(pickCrawls(null, {}), []);
});

test('parseCommonCrawlPage reads JSON Lines and skips what it cannot use', () => {
  const body = [
    '{"url": "https://jobs.ashbyhq.com/lupapets/abc", "status": "200"}',
    '',
    'not json at all',
    '{"error": "No Captures found"}',
    '{"url": "https://jobs.ashbyhq.com/baseten/def", "status": "404"}',
  ].join('\n');
  assert.deepEqual(parseCommonCrawlPage(body), [
    'https://jobs.ashbyhq.com/lupapets/abc',
    'https://jobs.ashbyhq.com/baseten/def',
  ]);
});

test('parseCommonCrawlPage returns nothing for an empty body', () => {
  assert.deepEqual(parseCommonCrawlPage(''), []);
});

test('parseWaybackRows drops the header row that names the fields', () => {
  const body = JSON.stringify([
    ['original'],
    ['https://jobs.ashbyhq.com/lupapets'],
    ['https://jobs.lever.co/acme'],
  ]);
  assert.deepEqual(parseWaybackRows(body), ['https://jobs.ashbyhq.com/lupapets', 'https://jobs.lever.co/acme']);
});

test('parseWaybackRows survives an empty or malformed reply', () => {
  assert.deepEqual(parseWaybackRows(''), []);
  assert.deepEqual(parseWaybackRows('[]'), []);
  assert.deepEqual(parseWaybackRows('<html>503</html>'), []);
});

test('commonCrawlUrl asks for a page, or for the page count', () => {
  const page = commonCrawlUrl('CC-MAIN-2026-34', 'jobs.ashbyhq.com/*', { page: 2 });
  assert.match(page, /^https:\/\/index\.commoncrawl\.org\/CC-MAIN-2026-34-index\?/);
  assert.match(page, /url=jobs\.ashbyhq\.com%2F\*/);
  assert.match(page, /page=2/);

  const count = commonCrawlUrl('CC-MAIN-2026-34', 'jobs.ashbyhq.com/*', { numPages: true });
  assert.match(count, /showNumPages=true/);
  assert.ok(!/[?&]page=/.test(count), 'a page-count query must not also pin a page');
});

test('waybackUrl collapses to one row per URL and honours the bookmark', () => {
  const url = waybackUrl('jobs.ashbyhq.com*', { from: '20260811', limit: 500 });
  assert.match(url, /collapse=urlkey/);
  assert.match(url, /fl=original/);
  assert.match(url, /from=20260811/);
  assert.match(url, /limit=500/);
  // Costs a 504 from the CDX server on a prefix this wide; see waybackUrl.
  assert.ok(!url.includes('statuscode'));
});

test('waybackUrl omits the bookmark on a first run', () => {
  assert.ok(!waybackUrl('jobs.lever.co*', {}).includes('from='));
});

test('nextWaybackFrom rewinds a day so a same-day capture cannot fall in the gap', () => {
  assert.equal(nextWaybackFrom(new Date('2026-08-28T16:00:00Z')), '20260827');
  assert.equal(toCdxDate(new Date('2026-08-28T16:00:00Z')), '20260828');
});

test('nextWaybackFrom crosses a month boundary correctly', () => {
  assert.equal(nextWaybackFrom(new Date('2026-09-01T00:30:00Z')), '20260831');
});

/*
 * The archives read raw crawl URLs rather than a curated list, so they surface
 * paths no list would ever publish. A crawler hits /robots.txt on a host far more
 * often than it reaches any one board: in CC-MAIN-2026-34, every capture under
 * jobs.lever.co was robots.txt and nothing else.
 */
test('a well-known filename is not a company, however slug-shaped it looks', () => {
  assert.equal(normalizeSlug('https://jobs.lever.co/robots.txt', 'lever'), null);
  assert.equal(normalizeSlug('https://jobs.ashbyhq.com/sitemap.xml', 'ashby'), null);
  assert.equal(normalizeSlug('https://boards.greenhouse.io/favicon.ico', 'greenhouse'), null);
});

test('a real board on a regional host still normalizes', () => {
  assert.equal(normalizeSlug('https://jobs.eu.lever.co/mobileye', 'lever'), 'mobileye');
  assert.equal(normalizeSlug('https://job-boards.eu.greenhouse.io/acme', 'greenhouse'), 'acme');
  assert.equal(normalizeSlug('https://jobs.ashbyhq.com/lupapets/35155640', 'ashby'), 'lupapets');
});

/*
 * The rule the archives depend on. An incremental source answers "what is new",
 * so on the run after it finds a board it reports nothing — and without this,
 * the merge would read that silence as a retraction and delete the board.
 */
test('mergeStore keeps an incremental source’s claim when this run found nothing', () => {
  const previous = { lupapets: { sources: ['commoncrawl'], first_seen: 't0', last_seen: 't0' } };
  const merged = mergeStore({
    previous,
    observed: new Map(),
    carriedSources: new Set(),
    incrementalSources: new Set(['commoncrawl']),
    now: 't1',
  });
  assert.deepEqual(merged.slugs.lupapets.sources, ['commoncrawl']);
});

test('mergeStore still retracts a full-list source that stopped claiming a slug', () => {
  const previous = { gone: { sources: ['openroles'], first_seen: 't0', last_seen: 't0' } };
  const merged = mergeStore({
    previous,
    observed: new Map(),
    carriedSources: new Set(),
    incrementalSources: new Set(['commoncrawl']),
    now: 't1',
  });
  assert.deepEqual(merged.slugs.gone.sources, []);
});

test('mergeStore adds a slug an incremental source has just found', () => {
  const merged = mergeStore({
    previous: {},
    observed: new Map([['lupapets', new Set(['commoncrawl'])]]),
    carriedSources: new Set(),
    incrementalSources: new Set(['commoncrawl']),
    now: 't1',
  });
  assert.deepEqual(merged.slugs.lupapets.sources, ['commoncrawl']);
  assert.equal(merged.slugs.lupapets.first_seen, 't1');
});

test('mergeStore leaves a slug active while any one source still claims it', () => {
  const previous = { shared: { sources: ['openroles', 'commoncrawl'], first_seen: 't0', last_seen: 't0' } };
  const merged = mergeStore({
    previous,
    observed: new Map(),
    carriedSources: new Set(),
    incrementalSources: new Set(['commoncrawl']),
    now: 't1',
  });
  assert.deepEqual(merged.slugs.shared.sources, ['commoncrawl']);
});

test('mergeStore never prunes a slug an incremental source still vouches for', () => {
  const previous = { lupapets: { sources: ['commoncrawl'], first_seen: 't0', last_seen: '2020-01-01T00:00:00.000Z' } };
  const merged = mergeStore({
    previous,
    observed: new Map(),
    carriedSources: new Set(),
    incrementalSources: new Set(['commoncrawl']),
    now: 't1',
    pruneAfter: 1,
  });
  assert.deepEqual(merged.pruned, []);
  assert.ok('lupapets' in merged.slugs);
});
