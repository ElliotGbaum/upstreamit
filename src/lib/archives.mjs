/**
 * Slug discovery from web archives.
 *
 * Every other source in sources.json is a list some other person maintains, which
 * caps our coverage at their diligence: most refresh monthly at best, several have
 * stopped, and none of them owes us anything. Common Crawl and the Wayback Machine
 * are not lists. They are archives of the open web that keep crawling whether or
 * not anybody curates them, so a board nobody has added to a list still turns up
 * once someone links to it. That is the gap they close — the boards that exist but
 * that no list-maintainer has noticed yet.
 *
 * Both are queried through the same CDX interface (a URL-prefix index over a set
 * of captures), which is why they share a module. What differs is what "new" means:
 *
 *  - Common Crawl publishes a fresh index roughly monthly, and each index covers
 *    only that crawl. So the unit of work is "crawls we have not read yet", and
 *    the bookmark is a crawl id.
 *  - Wayback is one continuous index. So the unit of work is "captures recorded
 *    since we last asked", and the bookmark is a date.
 *
 * Neither returns the whole population of boards on any single run: one Common
 * Crawl month holds roughly a third of the Ashby boards we already know about.
 * That is why both sources are declared `incremental: true` in sources.json — see
 * mergeStore in lib/slug-store.mjs for what that flag protects against.
 */

const COLLINFO_URL = 'https://index.commoncrawl.org/collinfo.json';
const CC_INDEX_BASE = 'https://index.commoncrawl.org';
const WAYBACK_CDX = 'https://web.archive.org/cdx/search/cdx';
const USER_AGENT = 'upstreamit/0.1 (slug sync)';

// How many unread Common Crawl indexes to pull in one run. Two covers a missed
// month without turning a first run into an hours-long backfill.
const DEFAULT_MAX_CRAWLS = 2;
const DEFAULT_WAYBACK_LIMIT = 200_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const DAY_MS = 86_400_000;

// How far back Wayback may be asked to look when the bookmark is missing. The
// CDX server's failure mode on a wide prefix is a 504 after a minute, and the
// window is what decides whether we get one: a query that reaches back further
// than this returns nothing at all, which is worse than a shorter one that
// returns something. So a lost bookmark costs a bounded re-read rather than a
// source that fails every morning until someone edits `since` by hand.
const DEFAULT_MAX_LOOKBACK_DAYS = 90;

/* -------------------------------------------------------------------------- */
/* Pure helpers — the parts worth testing, kept free of fetch and of the clock  */
/* -------------------------------------------------------------------------- */

/**
 * Which Common Crawl indexes to read.
 *
 * `collinfo` is published newest-first, so the crawls we have not seen are the
 * ones ahead of our bookmark. With a bookmark, take the *oldest* `max` of them:
 * the reader below finishes a crawl before advancing the bookmark past it, so
 * drawing from the old end means a backlog longer than `max` drains over
 * successive runs instead of the bookmark jumping the queue — taking the newest
 * first would strand every crawl in between behind it, permanently, since an
 * incremental source is never re-read.
 *
 * An unrecognised bookmark — a first run, or a crawl old enough to have dropped
 * out of the listing — leaves us without a floor, so there we take the newest
 * `max` rather than attempting the entire archive.
 */
export function pickCrawls(collinfo, { lastCrawlId = null, max = DEFAULT_MAX_CRAWLS } = {}) {
  const ids = (Array.isArray(collinfo) ? collinfo : []).map((entry) => entry?.id).filter(Boolean);
  if (ids.length === 0) return [];
  const bookmark = lastCrawlId ? ids.indexOf(lastCrawlId) : -1;
  if (bookmark === -1) return ids.slice(0, max);
  return ids.slice(0, bookmark).slice(-max);
}

/** One page of a Common Crawl index query, or the page count when `numPages`. */
export function commonCrawlUrl(crawlId, urlPattern, { page = null, numPages = false } = {}) {
  const params = new URLSearchParams({ url: urlPattern, output: 'json' });
  if (numPages) params.set('showNumPages', 'true');
  else if (page != null) params.set('page', String(page));
  return `${CC_INDEX_BASE}/${crawlId}-index?${params}`;
}

/**
 * Common Crawl answers in JSON Lines. Anything unparseable is skipped rather than
 * thrown: a page that ends mid-record, or the `{"error": "No Captures found"}`
 * the index returns for an empty pattern, should cost us that line and no more.
 */
export function parseCommonCrawlPage(body) {
  const urls = [];
  for (const line of String(body).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed);
      if (typeof record?.url === 'string') urls.push(record.url);
    } catch {
      continue;
    }
  }
  return urls;
}

/**
 * A Wayback CDX query.
 *
 * `collapse=urlkey` asks for one row per distinct URL instead of one per capture,
 * which is the difference between thousands of rows and hundreds of thousands.
 *
 * Deliberately unfiltered on status code, though captures of dead and mistyped
 * board URLs are archived alongside the real ones: adding `filter=statuscode:200`
 * makes the CDX server time out at 504 on a prefix this wide. Letting the junk
 * through costs nothing that matters — normalizeSlug drops what is not
 * slug-shaped, and probe-boards.mjs is what decides a board is live anyway.
 */
export function waybackUrl(urlPattern, { from = null, limit = DEFAULT_WAYBACK_LIMIT } = {}) {
  const params = new URLSearchParams({
    url: urlPattern,
    output: 'json',
    fl: 'original',
    collapse: 'urlkey',
    limit: String(limit),
  });
  if (from) params.set('from', from);
  return `${WAYBACK_CDX}?${params}`;
}

/** Wayback answers with an array of rows whose first row names the fields. */
export function parseWaybackRows(body) {
  const trimmed = String(body).trim();
  if (!trimmed) return [];
  let rows;
  try {
    rows = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!Array.isArray(rows) || rows.length === 0) return [];
  return rows
    .slice(1)
    .map((row) => (Array.isArray(row) ? row[0] : row))
    .filter((value) => typeof value === 'string' && value);
}

/** CDX bookmarks are plain YYYYMMDD. */
export function toCdxDate(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * Where the next run should start reading Wayback.
 *
 * One day behind this run rather than the run date itself: a capture recorded
 * later on the same day would otherwise land in the gap between the two queries
 * and never be read by either. Re-reading a day is nearly free — the slugs
 * dedupe — while a hole in the bookmark is permanent.
 */
export function nextWaybackFrom(date) {
  return toCdxDate(new Date(date.getTime() - DAY_MS));
}

/**
 * Where this run should start reading Wayback.
 *
 * The bookmark if we have one, the source's `since` seed if we do not, and in
 * either case no further back than the lookback floor. Both inputs are plain
 * YYYYMMDD, so the later of two dates is the greater string.
 *
 * The floor matters because the bookmark does not survive a GitHub Actions run
 * on its own — `data/sync-state.json` is gitignored, and the cache that carries
 * it between runs is best-effort. Without a floor, a lost bookmark means asking
 * for every capture since the `since` seed, a window that widens by a day every
 * day until the CDX server times out on it permanently.
 */
export function waybackFrom({
  bookmark = null,
  since = null,
  maxLookbackDays = DEFAULT_MAX_LOOKBACK_DAYS,
  now = new Date(),
} = {}) {
  const floor = toCdxDate(new Date(now.getTime() - maxLookbackDays * DAY_MS));
  const requested = bookmark ?? since ?? null;
  return requested && requested > floor ? requested : floor;
}

/* -------------------------------------------------------------------------- */
/* Transport                                                                    */
/* -------------------------------------------------------------------------- */

async function fetchText(url, { timeoutMs = DEFAULT_TIMEOUT_MS, retries = 2 } = {}) {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    // Both index servers shed load with a 503 rather than queueing, and both ask
    // callers to back off rather than give up. A pause and a retry is the
    // supported way through, not an error worth reporting.
    if (attempt > 0) await new Promise((done) => setTimeout(done, 2000 * attempt));

    try {
      const response = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: '*/*' },
        signal: AbortSignal.timeout(timeoutMs),
      });

      // The Common Crawl index answers 404 for a pattern it holds no captures
      // for. That is an empty result, not a failure.
      if (response.status === 404) return { ok: true, body: '' };

      if (response.status === 429 || response.status >= 500) {
        lastError = `HTTP ${response.status} ${response.statusText} for ${url}`;
        continue;
      }
      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status} ${response.statusText} for ${url}` };
      }
      return { ok: true, body: await response.text() };
    } catch (error) {
      lastError = `${error.name}: ${error.message} (${url})`;
    }
  }

  return { ok: false, error: lastError ?? `no response from ${url}` };
}

// One run asks for the crawl listing once, however many patterns it queries.
let collinfoPromise = null;

async function loadCollinfo() {
  collinfoPromise ??= (async () => {
    const result = await fetchText(COLLINFO_URL, { timeoutMs: 30_000 });
    if (!result.ok) return { ok: false, error: result.error };
    try {
      return { ok: true, crawls: JSON.parse(result.body) };
    } catch (error) {
      return { ok: false, error: `collinfo.json: invalid JSON — ${error.message}` };
    }
  })();
  return collinfoPromise;
}

/** Drop the memoized crawl listing. For tests, and for a long-lived process. */
export function resetArchiveCache() {
  collinfoPromise = null;
}

/* -------------------------------------------------------------------------- */
/* Loaders — the shape lib/fetch-source.mjs expects                             */
/* -------------------------------------------------------------------------- */

/**
 * Read every Common Crawl index published since our bookmark.
 *
 * Crawls are read oldest-first so the bookmark only ever advances over an index
 * we finished. If a page fails partway we keep what we have and leave the
 * bookmark where it was, and the next run picks that crawl up again.
 */
export async function loadCommonCrawl({ source, file, validators = {} }) {
  const { urlPattern } = file;
  if (!urlPattern) return { status: 'error', error: 'kind "commoncrawl" requires "urlPattern"' };

  const collinfo = await loadCollinfo();
  if (!collinfo.ok) return { status: 'error', error: collinfo.error };

  const crawls = pickCrawls(collinfo.crawls, {
    lastCrawlId: validators.crawlId ?? null,
    max: file.maxCrawls ?? source.maxCrawls ?? DEFAULT_MAX_CRAWLS,
  });
  // Nothing has been published since we last looked.
  if (crawls.length === 0) return { status: 'unchanged' };

  const urls = [];
  let bookmark = validators.crawlId ?? null;
  let failure = null;

  for (const crawlId of [...crawls].reverse()) {
    const pageCount = await fetchText(commonCrawlUrl(crawlId, urlPattern, { numPages: true }));
    if (!pageCount.ok) {
      failure = pageCount.error;
      break;
    }

    let pages = 0;
    try {
      pages = Number(JSON.parse(pageCount.body || '{}')?.pages ?? 0);
    } catch {
      pages = 0;
    }

    let complete = true;
    for (let page = 0; page < pages; page += 1) {
      const result = await fetchText(commonCrawlUrl(crawlId, urlPattern, { page }));
      if (!result.ok) {
        failure = result.error;
        complete = false;
        break;
      }
      urls.push(...parseCommonCrawlPage(result.body));
    }
    if (!complete) break;

    bookmark = crawlId;
  }

  // Nothing read and nothing to show for it: report it rather than silently
  // recording a successful empty run.
  if (failure && urls.length === 0) return { status: 'error', error: failure };

  // A partial read is safe — the bookmark did not advance, so the next run reads
  // the crawl again — but it is not obvious, and it moves the counts. Say so,
  // otherwise a short run looks exactly like a quiet month.
  if (failure) {
    console.warn(`  ! commoncrawl ${urlPattern}: partial read, bookmark held — ${failure}`);
  }

  return { status: 'ok', body: urls.join('\n'), validators: { crawlId: bookmark } };
}

/**
 * Read Wayback captures recorded since our bookmark.
 *
 * The CDX server is slow and moody on a prefix this wide: a successful answer
 * takes 15-40 seconds, and identical queries time out under any sustained rate
 * regardless of who you say you are. So the timeout is generous, the retry in
 * fetchText is doing real work rather than guarding a rare case, and the source
 * is declared `optional` in sources.json — a failed run must cost a day's
 * freshness, never the slugs this source has already contributed. The bookmark
 * only advances on success, so a bad day is re-read on the next one.
 */
export async function loadWayback({ source, file, validators = {} }) {
  const { urlPattern } = file;
  if (!urlPattern) return { status: 'error', error: 'kind "wayback" requires "urlPattern"' };

  const startedAt = new Date();
  const result = await fetchText(
    waybackUrl(urlPattern, {
      // `since` seeds the very first run; after that the bookmark takes over.
      // Either way the window is floored, so a bookmark lost between runs costs
      // a re-read of the last few months and not the whole archive.
      from: waybackFrom({
        bookmark: validators.from ?? null,
        since: file.since ?? null,
        maxLookbackDays: file.maxLookbackDays ?? source.maxLookbackDays ?? DEFAULT_MAX_LOOKBACK_DAYS,
        now: startedAt,
      }),
      limit: file.limit ?? source.limit ?? DEFAULT_WAYBACK_LIMIT,
    }),
    { timeoutMs: file.timeoutMs ?? 90_000 },
  );
  if (!result.ok) return { status: 'error', error: result.error };

  return {
    status: 'ok',
    body: parseWaybackRows(result.body).join('\n'),
    validators: { from: nextWaybackFrom(startedAt) },
  };
}
