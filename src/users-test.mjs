#!/usr/bin/env node
/**
 * Account tests.
 *
 *   node src/users-test.mjs
 *
 * Unlike `derive-test.mjs` and `filter-test.mjs` this one does touch a
 * database — accounts are storage, and testing storage without it would only
 * test the parts that were never going to break. It uses a throwaway file in
 * the OS temp directory, so it never sees `data/users.db` and leaves nothing
 * behind.
 *
 * The cases here are the ones where a plausible-looking change quietly breaks
 * something a user would only notice much later: a wrong password that returns
 * faster than a wrong address (an account enumerator), a note wiped by clicking
 * the star twice, `applied_at` cleared by moving a job back to "saved", a
 * Google account inheriting a stranger's saved jobs because the address was
 * asserted but not verified, and a password change that leaves old sessions
 * alive.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openUsersDb,
  createUser,
  findByEmail,
  verifyLogin,
  setPassword,
  getUser,
  publicUser,
  createSession,
  userForToken,
  destroySession,
  upsertIdentity,
  identitiesFor,
  putUserProfile,
  getUserProfile,
  listUserProfiles,
  deleteUserProfile,
  getSetting,
  setSetting,
  saveJob,
  getSaved,
  listSaved,
  unsaveJob,
  savedCounts,
  hideJob,
  unhideJob,
  getHidden,
  listHidden,
  hiddenIds,
  hiddenCount,
  createList,
  listsFor,
  addToList,
  removeFromList,
  deleteList,
  listMembership,
  accountState,
  UserError,
} from './lib/users/store.mjs';
import {
  hashPassword,
  verifyPassword,
  sessionCookie,
  clearedCookie,
  sameOrigin,
  rateLimiter,
  validEmail,
  normalizeEmail,
} from './lib/users/auth.mjs';
import { readIdToken } from './lib/users/google.mjs';

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed++;
  else failures.push(`${name}\n      got      ${a}\n      expected ${e}`);
}

/** Runs `fn` and reports the thrown message, or `null` if it did not throw. */
async function throws(fn) {
  try {
    await fn();
    return null;
  } catch (err) {
    return err instanceof UserError ? err.message : `unexpected: ${err.message}`;
  }
}

const dir = mkdtempSync(join(tmpdir(), 'jobfinder-users-'));
const db = openUsersDb(join(dir, 'users.db'));

try {
  // ------------------------------------------------------------ passwords --
  {
    const hash = await hashPassword('correct horse battery');
    check('password: verifies', await verifyPassword('correct horse battery', hash), true);
    check('password: rejects the wrong one', await verifyPassword('correct horse batteryy', hash), false);
    check('password: two hashes of one password differ (salted)', hash === (await hashPassword('correct horse battery')), false);
    check('password: a malformed hash is a failure, not a crash', await verifyPassword('x', 'nonsense'), false);
    check('password: no password on the account is a failure, not a pass', await verifyPassword('x', null), false);
    check('password: too short is refused', (await throws(() => hashPassword('short'))) !== null, true);
    check('email: normalized', normalizeEmail('  Elliot@Example.COM '), 'elliot@example.com');
    check('email: validated', [validEmail('a@b.co'), validEmail('nope'), validEmail('a b@c.d')], [true, false, false]);
  }

  // --------------------------------------------------------------- signup --
  const elliot = await createUser(db, { email: 'Elliot@Example.com', password: 'a-good-password', display_name: 'Elliot' });
  check('signup: email is lowercased', elliot.email, 'elliot@example.com');
  check('signup: never returns a hash', Object.keys(elliot).includes('password_hash'), false);
  check(
    'signup: the same address twice is refused',
    await throws(() => createUser(db, { email: 'elliot@example.com', password: 'another-password' })),
    'an account with that email already exists',
  );
  check(
    'signup: a bad address is refused',
    await throws(() => createUser(db, { email: 'not-an-email', password: 'a-good-password' })),
    'that does not look like an email address',
  );

  // ---------------------------------------------------------------- login --
  check('login: correct password', (await verifyLogin(db, 'elliot@example.com', 'a-good-password'))?.id, elliot.id);
  check('login: wrong password', await verifyLogin(db, 'elliot@example.com', 'nope'), null);
  check('login: unknown address', await verifyLogin(db, 'nobody@example.com', 'a-good-password'), null);
  check('login: address case does not matter', (await verifyLogin(db, 'ELLIOT@example.com', 'a-good-password'))?.id, elliot.id);

  // ------------------------------------------------------------- sessions --
  {
    const { token } = createSession(db, elliot.id, { userAgent: 'test' });
    check('session: resolves to its user', userForToken(db, token)?.id, elliot.id);
    check('session: a forged token resolves to nobody', userForToken(db, 'made-up'), null);
    check('session: an empty token resolves to nobody', userForToken(db, ''), null);

    const expired = createSession(db, elliot.id, { ttlMs: -1 });
    check('session: an expired one resolves to nobody', userForToken(db, expired.token), null);

    check('session: logout invalidates it', [destroySession(db, token), userForToken(db, token)], [true, null]);
  }
  {
    // A password change must not leave a stolen session working.
    const { token } = createSession(db, elliot.id);
    await setPassword(db, elliot.id, 'a-different-password');
    check('password change: every existing session is dropped', userForToken(db, token), null);
    check('password change: the new password works', (await verifyLogin(db, 'elliot@example.com', 'a-different-password'))?.id, elliot.id);
    check('password change: the old one does not', await verifyLogin(db, 'elliot@example.com', 'a-good-password'), null);
  }

  // ------------------------------------------------------------- cookies --
  {
    const cookie = sessionCookie('tok', { maxAge: 1000, secure: false });
    check('cookie: httpOnly', cookie.includes('HttpOnly'), true);
    check('cookie: SameSite=Lax', cookie.includes('SameSite=Lax'), true);
    check('cookie: no Secure flag over plain http, or the browser drops it', cookie.includes('Secure'), false);
    check('cookie: Secure over https', sessionCookie('tok', { maxAge: 1000, secure: true }).includes('Secure'), true);
    check('cookie: logout expires it immediately', clearedCookie().includes('Max-Age=0'), true);
  }

  // ---------------------------------------------------------------- csrf --
  {
    const req = (headers) => ({ headers });
    check('csrf: same origin passes', sameOrigin(req({ origin: 'http://localhost:7799', host: 'localhost:7799' })), true);
    check('csrf: another origin is refused', sameOrigin(req({ origin: 'http://evil.example', host: 'localhost:7799' })), false);
    check('csrf: no Origin header (curl, the CLI) passes', sameOrigin(req({ host: 'localhost:7799' })), true);
    check('csrf: a malformed Origin is refused', sameOrigin(req({ origin: '://', host: 'localhost:7799' })), false);
  }

  // --------------------------------------------------------- rate limiter --
  {
    const limiter = rateLimiter({ limit: 3, windowMs: 1000 });
    const results = [1, 2, 3, 4].map(() => limiter.take('k', 1000).ok);
    check('rate limit: allows the limit, then stops', results, [true, true, true, false]);
    limiter.clear('k');
    check('rate limit: a success clears the counter', limiter.take('k', 1000).ok, true);
    check('rate limit: the window expires', limiter.take('k', 99_000).ok, true);
  }

  // ----------------------------------------------------------- identities --
  {
    check(
      'google: an unverified address cannot claim an account',
      await throws(() =>
        upsertIdentity(db, { provider: 'google', subject: 'g-1', email: 'elliot@example.com', email_verified: false }),
      ),
      'google has not verified that address, so it cannot be used to sign in',
    );
    const linked = upsertIdentity(db, {
      provider: 'google',
      subject: 'g-1',
      email: 'Elliot@example.com',
      email_verified: true,
      display_name: 'Elliot G',
    });
    check('google: a verified address links to the existing account', linked.id, elliot.id);
    check('google: signing in again finds the same account', upsertIdentity(db, { provider: 'google', subject: 'g-1', email: 'elliot@example.com', email_verified: true }).id, elliot.id);
    check('google: the link is recorded once', identitiesFor(db, elliot.id).length, 1);

    const fresh = upsertIdentity(db, { provider: 'google', subject: 'g-2', email: 'new@example.com', email_verified: true });
    check('google: an unknown address creates an account', fresh.email, 'new@example.com');
    check('google: that account has no password to guess', publicUser(fresh).has_password, false);
    check('google: and cannot be logged into with one', await verifyLogin(db, 'new@example.com', ''), null);
  }

  // ------------------------------------------------------------ id tokens --
  {
    const token = (claims) =>
      ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');
    const base = { iss: 'https://accounts.google.com', aud: 'client-1', sub: '42', exp: 2_000_000_000, email: 'x@y.z', email_verified: true };
    check('id_token: read', readIdToken(token(base), { clientId: 'client-1', now: 1_000 }).subject, '42');
    check(
      'id_token: issued for another client is refused',
      (await throws(() => readIdToken(token(base), { clientId: 'other', now: 1_000 }))) ?? 'no throw',
      'unexpected: id_token was issued for a different client',
    );
    check(
      'id_token: expired is refused',
      (await throws(() => readIdToken(token({ ...base, exp: 1 }), { clientId: 'client-1' }))) ?? 'no throw',
      'unexpected: id_token has expired',
    );
    check(
      'id_token: a forged issuer is refused',
      (await throws(() => readIdToken(token({ ...base, iss: 'https://evil.example' }), { clientId: 'client-1' }))) ?? 'no throw',
      'unexpected: unexpected issuer https://evil.example',
    );
    check(
      'id_token: email_verified as the string "true" still counts',
      readIdToken(token({ ...base, email_verified: 'true' }), { clientId: 'client-1', now: 1_000 }).email_verified,
      true,
    );
  }

  // -------------------------------------------------------------- profiles --
  {
    const doc = { label: 'NYC entry level', metros: ['nyc'], max_years_experience: 3 };
    putUserProfile(db, elliot.id, 'nyc', doc);
    check('profile: round-trips verbatim', getUserProfile(db, elliot.id, 'nyc'), doc);
    check('profile: listed with its label', listUserProfiles(db, elliot.id).map((p) => [p.name, p.label]), [['nyc', 'NYC entry level']]);
    putUserProfile(db, elliot.id, 'nyc', { ...doc, max_years_experience: 5 });
    check('profile: saving again replaces it', getUserProfile(db, elliot.id, 'nyc').max_years_experience, 5);
    check('profile: a path is not a name', await throws(() => putUserProfile(db, elliot.id, '../escape', doc)), 'profile names are [a-z0-9._-], 1–64 chars');
    check('profile: another user cannot read it', getUserProfile(db, 'u_someone-else', 'nyc'), null);
    check('profile: deleted', [deleteUserProfile(db, elliot.id, 'nyc'), getUserProfile(db, elliot.id, 'nyc')], [true, null]);
  }

  // ----------------------------------------------------- working profile --
  {
    check('prefs: absent until set', getSetting(db, elliot.id, 'working_profile'), null);
    setSetting(db, elliot.id, 'working_profile', { metros: ['nyc'], title_keywords: ['solutions'] });
    check('prefs: come back as posted', getSetting(db, elliot.id, 'working_profile'), { metros: ['nyc'], title_keywords: ['solutions'] });
    setSetting(db, elliot.id, 'working_profile', { metros: [] });
    check('prefs: overwritten, not merged', getSetting(db, elliot.id, 'working_profile'), { metros: [] });
  }

  // ----------------------------------------------------------- saved jobs --
  const JOB = 'ashby:acme:job-1';
  {
    const row = saveJob(db, elliot.id, JOB, { title: 'Solutions Engineer', company: 'Acme', url: 'https://acme.example/1' });
    check('save: defaults to "saved"', row.status, 'saved');
    check('save: applied_at stays null until you apply', row.applied_at, null);
    check('save: keeps the snapshot', [row.title, row.company], ['Solutions Engineer', 'Acme']);

    saveJob(db, elliot.id, JOB, { note: 'referred by Dana' });
    check('save: a note is kept', getSaved(db, elliot.id, JOB).note, 'referred by Dana');
    saveJob(db, elliot.id, JOB, {});
    check('save: starring again does not wipe the note', getSaved(db, elliot.id, JOB).note, 'referred by Dana');
    check('save: nor the snapshot', getSaved(db, elliot.id, JOB).title, 'Solutions Engineer');

    const applied = saveJob(db, elliot.id, JOB, { status: 'applied' }, 5_000);
    check('save: applying stamps applied_at', applied.applied_at, 5_000);
    const interviewing = saveJob(db, elliot.id, JOB, { status: 'interviewing' }, 9_000);
    check('save: a later stage does not restamp it', interviewing.applied_at, 5_000);
    const back = saveJob(db, elliot.id, JOB, { status: 'saved' }, 11_000);
    check('save: moving it back does not erase that you applied', back.applied_at, 5_000);
    check('save: an unknown status is refused', await throws(() => saveJob(db, elliot.id, JOB, { status: 'ghosted' })), 'status must be one of saved, applied, interviewing, offer, rejected');

    saveJob(db, elliot.id, JOB, { note: '' });
    check('save: a note can be cleared', getSaved(db, elliot.id, JOB).note, '');

    saveJob(db, elliot.id, 'ashby:acme:job-2', { status: 'applied', title: 'PM' });
    check('save: counts by status', savedCounts(db, elliot.id), { saved: 1, applied: 1, interviewing: 0, offer: 0, rejected: 0, total: 2 });
    check('save: listing by status', listSaved(db, elliot.id, { status: 'applied' }).map((r) => r.job_id), ['ashby:acme:job-2']);
    check('save: another user sees none of it', listSaved(db, 'u_someone-else').length, 0);
  }

  // ---------------------------------------------------------- hidden jobs --
  // The cases that matter are the ones where hiding stops being reversible:
  // a snapshot lost (leaving a row the un-hide page cannot draw), a timestamp
  // restamped (so the list no longer reads newest-first), or the hidden set
  // leaking across accounts — which would be one person's × deciding what
  // somebody else is allowed to see.
  {
    const HID = 'greenhouse:globex:job-9';
    const row = hideJob(db, elliot.id, HID, { title: 'Night Shift QA', company: 'Globex', url: 'https://globex.example/9' }, 1_000);
    check('hide: keeps the snapshot', [row.title, row.company, row.url], ['Night Shift QA', 'Globex', 'https://globex.example/9']);
    check('hide: stamps when', row.hidden_at, 1_000);

    hideJob(db, elliot.id, HID, {}, 7_000);
    check('hide: hiding it twice keeps the first timestamp', getHidden(db, elliot.id, HID).hidden_at, 1_000);
    check('hide: and does not wipe the snapshot', getHidden(db, elliot.id, HID).title, 'Night Shift QA');
    check('hide: it is one row, not two', hiddenCount(db, elliot.id), 1);

    hideJob(db, elliot.id, 'lever:initech:job-3', { title: 'Cobol Wrangler' }, 9_000);
    check('hide: newest first', listHidden(db, elliot.id).map((r) => r.job_id), ['lever:initech:job-3', HID]);
    check('hide: the engine gets a set of ids', [...hiddenIds(db, elliot.id)].sort(), ['greenhouse:globex:job-9', 'lever:initech:job-3']);
    check('hide: another account is not touched by it', hiddenIds(db, 'u_someone-else').size, 0);
    check('hide: a bad job id is refused', await throws(() => hideJob(db, elliot.id, '')), 'bad job id');

    // Hiding and saving answer different questions, so neither disturbs the
    // other: being rejected from a job you applied to is exactly when you
    // would want it out of your results and still in your history.
    hideJob(db, elliot.id, JOB, { title: 'Solutions Engineer' }, 10_000);
    check('hide: a saved job stays saved when hidden', getSaved(db, elliot.id, JOB)?.status, 'saved');
    check('hide: and stays in the saved counts', savedCounts(db, elliot.id).total, 2);
    unhideJob(db, elliot.id, JOB);

    check('unhide: it comes back', unhideJob(db, elliot.id, HID), true);
    check('unhide: it is gone from the list', hiddenIds(db, elliot.id).has(HID), false);
    check('unhide: twice is not an error', unhideJob(db, elliot.id, HID), false);
    check('unhide: the saved row it never touched is still there', getSaved(db, elliot.id, JOB)?.title, 'Solutions Engineer');
    unhideJob(db, elliot.id, 'lever:initech:job-3');
    check('unhide: back to nothing hidden', hiddenCount(db, elliot.id), 0);
  }

  // ---------------------------------------------------------------- lists --
  {
    const list = createList(db, elliot.id, 'apply this week');
    check('list: created', [list.name, list.count], ['apply this week', 0]);
    check('list: the same name twice is refused', await throws(() => createList(db, elliot.id, 'apply this week')), 'you already have a list with that name');
    check('list: a nameless list is refused', await throws(() => createList(db, elliot.id, '   ')), 'a list needs a name');

    addToList(db, elliot.id, list.id, JOB);
    check('list: membership is reported per job', listMembership(db, elliot.id)[JOB], [list.id]);
    check('list: the count follows', listsFor(db, elliot.id)[0].count, 1);

    // Filing an unsaved job into a list saves it — a list member with no saved
    // row would have no status, no note and nothing to render.
    addToList(db, elliot.id, list.id, 'ashby:acme:job-3', { title: 'Analyst' });
    check('list: filing an unsaved job saves it too', getSaved(db, elliot.id, 'ashby:acme:job-3')?.status, 'saved');
    check('list: and it reads back through the list', listSaved(db, elliot.id, { listId: list.id }).map((r) => r.job_id).sort(), ['ashby:acme:job-3', JOB].sort());

    check("list: another user cannot add to it", await throws(() => addToList(db, 'u_someone-else', list.id, JOB)), 'no such list');
    check("list: nor remove from it", await throws(() => removeFromList(db, 'u_someone-else', list.id, JOB)), 'no such list');
    check("list: nor delete it", deleteList(db, 'u_someone-else', list.id), false);

    unsaveJob(db, elliot.id, 'ashby:acme:job-3');
    check('unsave: also drops it from every list', listSaved(db, elliot.id, { listId: list.id }).map((r) => r.job_id), [JOB]);
    check('unsave: and from the membership map', listMembership(db, elliot.id)['ashby:acme:job-3'], undefined);

    removeFromList(db, elliot.id, list.id, JOB);
    check('list: removing an item leaves the job saved', getSaved(db, elliot.id, JOB)?.status, 'saved');

    deleteList(db, elliot.id, list.id);
    check('list: deleting it leaves the jobs saved', [listsFor(db, elliot.id).length, savedCounts(db, elliot.id).total], [0, 2]);
  }

  // ----------------------------------------------------------- one payload --
  {
    const state = accountState(db, elliot.id);
    check('account state: everything the page needs, in one shape', Object.keys(state).sort(), ['counts', 'hidden_count', 'lists', 'membership', 'profiles', 'saved']);
    // A count, not the rows. The hidden list is read on one screen; carrying it
    // into every page load would be the largest thing in this payload for
    // somebody who has been using the × for a month.
    check('account state: hidden jobs arrive as a number', typeof state.hidden_count, 'number');
    check('account state: carries no secret', JSON.stringify(state).includes('scrypt$'), false);
  }

  // ------------------------------------------------- deletion is complete --
  {
    const doomed = await createUser(db, { email: 'temp@example.com', password: 'a-good-password' });
    saveJob(db, doomed.id, JOB, { title: 'x' });
    const list = createList(db, doomed.id, 'temp');
    addToList(db, doomed.id, list.id, JOB);
    putUserProfile(db, doomed.id, 'temp', { metros: ['nyc'] });
    hideJob(db, doomed.id, 'ashby:acme:job-7', { title: 'x' });
    db.prepare('DELETE FROM users WHERE id = ?').run(doomed.id);
    check('delete: takes the saved jobs with it', listSaved(db, doomed.id).length, 0);
    check('delete: takes the hidden jobs with it', listHidden(db, doomed.id).length, 0);
    check('delete: takes the lists with it', listsFor(db, doomed.id).length, 0);
    check('delete: takes the profiles with it', listUserProfiles(db, doomed.id).length, 0);
    check('delete: leaves other accounts alone', findByEmail(db, 'elliot@example.com')?.id, elliot.id);
    check('delete: and the corpus knows nothing about any of it', getUser(db, doomed.id), null);
  }
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} failing:\n`);
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  console.error(`${passed} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`✓ ${passed} account checks passed`);
