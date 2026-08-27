/**
 * Shared HTTP layer for every ATS sweep and probe.
 *
 * Three things every caller needs and nobody should re-implement:
 *   - an explicit User-Agent (Cloudflare 403s `Python-urllib/*`, and a bare fetch
 *     UA has been flaky against a couple of the smaller ATS hosts)
 *   - retry with backoff that distinguishes "try again" (429/5xx/network) from
 *     "this is the answer" (404 means the board does not exist — never retry it)
 *   - a bounded worker pool, because the hosts differ enormously in tolerance:
 *     api.ashbyhq.com took 7,951 requests at concurrency 10 with zero 429s, while
 *     jobs.ashbyhq.com rate-limits within a few dozen.
 */

export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36 UpstreamIt/1.0';

const DEFAULT_HEADERS = {
  'user-agent': USER_AGENT,
  accept: 'application/json, text/plain, */*',
  'accept-language': 'en-US,en;q=0.9',
  'accept-encoding': 'gzip, deflate, br',
};

/** Statuses worth a second attempt. 404/401/403 are answers, not failures. */
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch + timeout + retry. Never throws on an HTTP status — returns the response.
 * Throws only when every attempt failed at the network level.
 *
 * @param {string} url
 * @param {{method?:string, headers?:object, body?:string, timeoutMs?:number,
 *          retries?:number, baseDelayMs?:number, signal?:AbortSignal}} [opts]
 */
export async function request(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    // Only a string body is accepted, because a stream cannot be replayed and
    // every request here is retryable by design.
    body = undefined,
    timeoutMs = 30_000,
    retries = 3,
    baseDelayMs = 400,
  } = opts;

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: { ...DEFAULT_HEADERS, ...headers },
        ...(body === undefined ? {} : { body }),
        signal: controller.signal,
        redirect: 'follow',
      });
      clearTimeout(timer);

      if (RETRYABLE.has(res.status) && attempt < retries) {
        // Honour Retry-After when the server bothers to send one.
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 30_000)
          : backoff(baseDelayMs, attempt);
        await sleep(wait);
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      if (attempt < retries) {
        await sleep(backoff(baseDelayMs, attempt));
        continue;
      }
    }
  }
  throw lastError ?? new Error(`request failed: ${url}`);
}

// Exponential with full jitter — avoids a thundering herd when a host briefly wobbles.
function backoff(base, attempt) {
  const ceiling = Math.min(base * 2 ** attempt, 20_000);
  return Math.floor(Math.random() * ceiling) + base;
}

/**
 * GET and parse JSON. Returns `{ ok, status, data, error, etag, bytes }`.
 *
 * A 304 comes back as `{ ok: false, notModified: true, status: 304 }` and is an
 * **answer**, not a failure — "nothing changed since the ETag you sent". A
 * caller that sends `If-None-Match` must branch on `notModified` before it
 * branches on `ok`, the same way `dead` (404) already means "do not retry"
 * rather than "something went wrong". Lumping it in with the errors is how a
 * conditional sweep would mark every unchanged board as failed.
 */
export async function getJson(url, opts = {}) {
  let res;
  try {
    res = await request(url, opts);
  } catch (err) {
    return { ok: false, status: 0, data: null, error: String(err?.message ?? err), bytes: 0 };
  }
  if (res.status === 304) {
    await res.arrayBuffer().catch(() => {});
    return {
      ok: false,
      notModified: true,
      status: 304,
      data: null,
      etag: res.headers.get('etag'),
      bytes: 0,
    };
  }
  if (!res.ok) {
    // Drain so the socket can be reused.
    await res.arrayBuffer().catch(() => {});
    return { ok: false, status: res.status, data: null, error: `HTTP ${res.status}`, bytes: 0 };
  }
  const text = await res.text();
  try {
    return {
      ok: true,
      status: res.status,
      data: JSON.parse(text),
      etag: res.headers.get('etag'),
      bytes: text.length,
    };
  } catch (err) {
    return {
      ok: false,
      status: res.status,
      data: null,
      error: `bad JSON (${text.slice(0, 80)})`,
      bytes: text.length,
    };
  }
}

/** GET raw text. Same result shape, `data` is the string. */
export async function getText(url, opts = {}) {
  let res;
  try {
    res = await request(url, opts);
  } catch (err) {
    return { ok: false, status: 0, data: null, error: String(err?.message ?? err), bytes: 0 };
  }
  if (!res.ok) {
    await res.arrayBuffer().catch(() => {});
    return { ok: false, status: res.status, data: null, error: `HTTP ${res.status}`, bytes: 0 };
  }
  const text = await res.text();
  return { ok: true, status: res.status, data: text, etag: res.headers.get('etag'), bytes: text.length };
}

/**
 * Bounded worker pool. Runs `worker(item, index)` over `items` with at most
 * `concurrency` in flight, preserving input order in the result array.
 * A worker that throws yields `{ error }` rather than killing the run.
 */
export async function pool(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : [...items];
  const results = new Array(list.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(concurrency, list.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= list.length) return;
      try {
        results[index] = await worker(list[index], index);
      } catch (err) {
        results[index] = { error: String(err?.message ?? err) };
      }
    }
  });

  await Promise.all(runners);
  return results;
}
