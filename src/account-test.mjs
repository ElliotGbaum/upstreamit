#!/usr/bin/env node
/**
 * Account-layer tests, for the half of `app/account.js` that is not a DOM.
 *
 *   node src/account-test.mjs
 *
 * The rest of the suite tests the server; this is the first file to test what
 * runs in the browser, and it can only do so because `app/account.js` has no
 * top-level side effects — importing it under Node touches neither `document`
 * nor `fetch`, so a stub can stand in for both.
 *
 * What is worth testing here is `fetchWithRetry`, and specifically the two
 * lines it must not cross. A request that never reached the server is retried,
 * because a connection the browser found already closed is not the reader's
 * mistake. A request the server *answered* is not, whatever the status said,
 * and neither is a POST — the one that creates a list, where sending twice
 * would mean two lists.
 */

import { fetchWithRetry } from '../app/account.js';

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed++;
  else failures.push(`${name}\n      got      ${a}\n      expected ${e}`);
}

/**
 * Stand in for the browser's `fetch` and record how often it was called.
 *
 * `answers` is read one call at a time. An entry that is an `Error` is thrown
 * the way `fetch` throws when the request never left — no response, no status,
 * nothing to read — and anything else is returned as the response.
 */
function stubFetch(answers) {
  const calls = [];
  globalThis.fetch = async (path, options) => {
    calls.push({ path, method: options?.method ?? 'GET' });
    const answer = answers[calls.length - 1];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return calls;
}

const dropped = () => new TypeError('Failed to fetch');
const answered = (status) => ({ status, ok: status < 400, json: async () => ({}) });

/**
 * Run the call and report either side of it, so a regression that throws where
 * it used to answer arrives as a failing check rather than as a stack trace
 * that takes the rest of the file down with it.
 */
async function tried(path, options) {
  try {
    return { res: await fetchWithRetry(path, options), error: null };
  } catch (err) {
    return { res: null, error: err };
  }
}

const savedFetch = globalThis.fetch;
const GAVE_UP = 'the site did not answer — check your connection and try again';

// -------------------------------------------- a request that never landed --
{
  const calls = stubFetch([dropped(), answered(200)]);
  const { res, error } = await tried('/api/me/hidden/x', { method: 'PUT', body: '{}' });
  check('a dropped PUT is sent again', calls.length, 2);
  check('and the second answer is the one returned', [error?.message ?? null, res?.status ?? null], [null, 200]);
  check('to the same path, by the same method', calls[1], { path: '/api/me/hidden/x', method: 'PUT' });
}

{
  const calls = stubFetch([dropped(), answered(200)]);
  const { error } = await tried('/api/me');
  check('a dropped GET is sent again too', [calls.length, error?.message ?? null], [2, null]);
}

{
  const calls = stubFetch([dropped(), answered(200)]);
  const { error } = await tried('/api/me/hidden/x', { method: 'DELETE' });
  check('and so is a dropped DELETE — undo has to survive the same blip', [calls.length, error?.message ?? null], [2, null]);
}

// ------------------------------------------------------- but only one more --
{
  const calls = stubFetch([dropped(), dropped(), answered(200)]);
  const { error } = await tried('/api/me/hidden/x', { method: 'PUT', body: '{}' });
  check('twice dropped is given up on, not retried forever', calls.length, 2);
  check('and says something a reader can act on', error?.message ?? null, GAVE_UP);
}

{
  const calls = stubFetch([dropped(), dropped()]);
  const { error } = await tried('/api/me');
  check('with the browser’s own words kept as the cause', error?.cause?.message ?? null, 'Failed to fetch');
  check('after two tries', calls.length, 2);
}

// ------------------------------- an answer is an answer, whatever it says --
{
  const calls = stubFetch([answered(500), answered(200)]);
  const { res } = await tried('/api/me/hidden/x', { method: 'PUT', body: '{}' });
  check('a 500 is the server answering, and is not retried', calls.length, 1);
  check('the error response comes back for request() to read', res?.status ?? null, 500);
}

{
  const calls = stubFetch([answered(401), answered(200)]);
  await tried('/api/me');
  check('nor is a 401 — a session that expired will not un-expire', calls.length, 1);
}

// ------------------------------------------------ POST is never sent twice --
{
  const calls = stubFetch([dropped(), answered(201)]);
  const { error } = await tried('/api/me/lists', { method: 'POST', body: '{"name":"reading"}' });
  check('a dropped POST is not sent again — it may have created the list', calls.length, 1);
  check('it fails with the same legible message', error?.message ?? null, GAVE_UP);
}

globalThis.fetch = savedFetch;

// --------------------------------------------------------------------- done --
if (failures.length) {
  console.error(`\n${failures.length} failing:\n`);
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  console.error(`${passed} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`✓ ${passed} in-browser account checks passed`);
