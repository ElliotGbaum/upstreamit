/**
 * The account routes — `/api/auth/*` and `/api/me/*`.
 *
 * This file is HTTP and nothing else: parse, authorize, call `store.mjs`,
 * serialize. Every rule about what an account *is* lives one layer down, which
 * is why there is no SQL here and no `res` down there.
 *
 * The shape of the feature, stated once so the code below reads as one idea:
 *
 *   **Signing in is optional, and nothing it adds is a precondition for
 *   anything that worked before.** What an account adds is memory — your
 *   filters when you come back, the jobs you starred, the ones you told it
 *   never to show you again, what you did about them. An anonymous visitor is
 *   not a degraded user; they are the default, and the app is theirs first.
 *
 *   One of those memories reaches back into the search: `hiddenFor` below hands
 *   `server.mjs` the ids this reader has hidden, and the engine leaves them out
 *   of the results and the counts. It is still the same search over the same
 *   corpus reading the same profile document — the account contributes a set of
 *   ids, never a criterion — and with no session there is no set.
 *
 * Authorization is one line, applied at one place: `/api/me/*` requires a
 * session, and every store call under it is scoped by that session's user id.
 * There is no route that takes a user id as a parameter, so there is nothing to
 * forge.
 */

import { json, readBody, redirect } from '../wire.mjs';
import { salaryLabel } from '../filter/rank.mjs';
import {
  UserError,
  openUsersDb,
  publicUser,
  createUser,
  verifyLogin,
  setPassword,
  getUser,
  updateProfileFields,
  upsertIdentity,
  identitiesFor,
  createSession,
  userForToken,
  destroySession,
  destroyAllSessions,
  putOAuthState,
  takeOAuthState,
  listUserProfiles,
  getUserProfile,
  putUserProfile,
  deleteUserProfile,
  getSetting,
  setSetting,
  listSaved,
  saveJob,
  unsaveJob,
  savedCounts,
  hideJob,
  unhideJob,
  listHidden,
  hiddenIds,
  hiddenCount,
  listsFor,
  createList,
  renameList,
  deleteList,
  addToList,
  removeFromList,
  listMembership,
  accountState,
} from './store.mjs';
import {
  SESSION_COOKIE,
  parseCookies,
  sessionCookie,
  clearedCookie,
  isSecureRequest,
  sameOrigin,
  rateLimiter,
  clientIp,
  MIN_PASSWORD_LENGTH,
} from './auth.mjs';
import { SESSION_TTL_MS, APPLICATION_STATUSES, STATUS_LABELS, SAFE_NAME } from './schema.mjs';
import { googleConfig, callbackUrl, pkce, newState, authUrl, exchangeCode, readIdToken } from './google.mjs';

/** The working filter document, saved under this key in `user_settings`. */
const WORKING_PROFILE = 'working_profile';

/**
 * Build the account layer.
 *
 * `jobsDb` is here for one job — turning a list of saved job ids into rows the
 * saved view can render. The account store deliberately cannot reach the
 * corpus, so the join happens at this layer, where both are in scope.
 */
export function createAccounts({ usersDb, jobsDb }) {
  const db = usersDb ?? openUsersDb();

  // Two limiters rather than one: a shared counter would let a signup flood
  // lock out logins, which is a denial of service with extra steps.
  const loginLimit = rateLimiter({ limit: 12, windowMs: 15 * 60 * 1000 });
  const signupLimit = rateLimiter({ limit: 6, windowMs: 60 * 60 * 1000 });

  const isMe = (path) => path === '/api/me' || path.startsWith('/api/me/');
  const ours = (path) => isMe(path) || path === '/api/auth' || path.startsWith('/api/auth/');

  /** The session behind this request, or null. Never throws; anonymous is normal. */
  function userFor(req) {
    try {
      return userForToken(db, parseCookies(req)[SESSION_COOKIE]);
    } catch {
      return null;
    }
  }

  /** Mints a session and returns the `Set-Cookie` header for it. */
  function startSession(req, user) {
    const { token } = createSession(db, user.id, { userAgent: req.headers['user-agent'] });
    return { 'set-cookie': sessionCookie(token, { maxAge: SESSION_TTL_MS, secure: isSecureRequest(req) }) };
  }

  /**
   * Hydrate saved rows against the live corpus.
   *
   * Three states, and the difference matters to someone tracking applications:
   * the job is still listed; the job is in the corpus but closed (`is_open: 0`,
   * "no longer listed"); or the job is not in the corpus at all, in which case
   * the snapshot taken at save time is all there is — and it is enough to read.
   */
  function hydrate(rows) {
    if (!rows.length || !jobsDb) return rows.map((row) => ({ ...row, job: null }));
    const live = new Map();
    // Chunked so a 900-job saved list cannot exceed SQLite's parameter limit.
    for (let i = 0; i < rows.length; i += 400) {
      const slice = rows.slice(i, i + 400).map((r) => r.job_id);
      const placeholders = slice.map(() => '?').join(',');
      for (const job of jobsDb
        .prepare(
          `SELECT id, title, company_name, company_slug, department, url, apply_url, is_open,
                  employment_type, posted_at, d_workplace, d_metros, d_seniority, d_job_function,
                  d_salary_known, d_salary_min, d_salary_max, d_age_days
           FROM jobs WHERE id IN (${placeholders})`,
        )
        .all(...slice)) {
        live.set(job.id, {
          id: job.id,
          title: job.title,
          company: job.company_name ?? job.company_slug,
          department: job.department,
          url: job.url,
          apply_url: job.apply_url,
          is_open: job.is_open === 1,
          employment_type: job.employment_type,
          posted_at: job.posted_at,
          workplace: job.d_workplace,
          metros: parseJsonList(job.d_metros),
          seniority: job.d_seniority,
          job_function: job.d_job_function,
          age_days: job.d_age_days,
          salary_label: salaryLabel({
            salary_known: job.d_salary_known,
            salary_min: job.d_salary_min,
            salary_max: job.d_salary_max,
          }),
        });
      }
    }
    return rows.map((row) => ({ ...row, job: live.get(row.job_id) ?? null }));
  }

  /**
   * Route the request, or return false so the caller carries on.
   *
   * Returning false rather than 404-ing is what keeps this module additive: it
   * sees `/api/auth/*` and `/api/me/*`, and every other route in the server is
   * untouched by the existence of accounts.
   */
  async function handle(req, res, path, url) {
    // `/api/me` and `/api/me/…`, never `/api/meta` — a `startsWith('/api/me')`
    // here quietly ate the corpus metadata route and answered "sign in to use
    // this" to a page that had asked how many jobs there were.
    if (!ours(path)) return false;

    // One CSRF check, covering every write in the module. `SameSite=Lax` is the
    // other half; neither is trusted alone.
    if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) {
      json(res, 403, { error: 'cross-origin write refused' });
      return true;
    }

    try {
      if (await authRoutes(req, res, path, url)) return true;
      if (await meRoutes(req, res, path, url)) return true;
      json(res, 404, { error: `no route for ${req.method} ${path}` });
    } catch (err) {
      if (err instanceof UserError) json(res, err.status, { error: err.message });
      else json(res, 500, { error: err.message });
    }
    return true;
  }

  // ------------------------------------------------------------------ auth --

  async function authRoutes(req, res, path, url) {
    if (path === '/api/auth/me' && req.method === 'GET') {
      const user = userFor(req);
      json(res, 200, {
        user: publicUser(user),
        identities: user ? identitiesFor(db, user.id) : [],
        google: Boolean(googleConfig()),
      });
      return true;
    }

    if (path === '/api/auth/signup' && req.method === 'POST') {
      const gate = signupLimit.take(clientIp(req));
      if (!gate.ok) {
        json(res, 429, { error: 'too many accounts created from here — try again later' });
        return true;
      }
      const body = await readBody(req, 10_000);
      const user = await createUser(db, {
        email: body.email,
        password: body.password,
        display_name: body.display_name,
      });
      const row = getUser(db, user.id);
      json(res, 201, { user }, startSession(req, row));
      return true;
    }

    if (path === '/api/auth/login' && req.method === 'POST') {
      const body = await readBody(req, 10_000);
      // Keyed by address as well as address+ip, so someone grinding one account
      // from many addresses is still stopped.
      const key = `${clientIp(req)}|${String(body.email ?? '').toLowerCase()}`;
      const gate = loginLimit.take(key);
      if (!gate.ok) {
        json(res, 429, {
          error: `too many attempts — try again in ${Math.ceil(gate.retryAfterMs / 60_000)} minutes`,
        });
        return true;
      }
      const row = await verifyLogin(db, body.email, body.password);
      if (!row) {
        // One message for both failures. "No such account" is an enumerator.
        json(res, 401, { error: 'that email and password do not match an account' });
        return true;
      }
      loginLimit.clear(key);
      json(res, 200, { user: publicUser(row) }, startSession(req, row));
      return true;
    }

    if (path === '/api/auth/logout' && req.method === 'POST') {
      destroySession(db, parseCookies(req)[SESSION_COOKIE]);
      json(res, 200, { user: null }, { 'set-cookie': clearedCookie({ secure: isSecureRequest(req) }) });
      return true;
    }

    if (path === '/api/auth/password' && req.method === 'POST') {
      const user = userFor(req);
      if (!user) {
        json(res, 401, { error: 'sign in first' });
        return true;
      }
      const body = await readBody(req, 10_000);
      // An account with a password must prove the old one. An account created
      // through Google has none, so setting the first one is allowed from an
      // already-authenticated session.
      if (user.password_hash) {
        const ok = await verifyLogin(db, user.email, body.current_password);
        if (!ok) {
          json(res, 403, { error: 'current password is wrong' });
          return true;
        }
      }
      await setPassword(db, user.id, body.new_password);
      // setPassword drops every session, including this one — hand back a fresh
      // cookie so changing a password does not silently sign you out.
      json(res, 200, { ok: true, min_length: MIN_PASSWORD_LENGTH }, startSession(req, user));
      return true;
    }

    if (path === '/api/auth/google/start' && req.method === 'GET') {
      const config = googleConfig();
      if (!config) {
        json(res, 501, { error: 'Google sign-in is not configured on this server' });
        return true;
      }
      const { verifier, challenge } = pkce();
      const state = newState();
      putOAuthState(db, { state, provider: 'google', verifier });
      redirect(
        res,
        authUrl({
          clientId: config.clientId,
          redirectUri: callbackUrl(req, config, { secure: isSecureRequest(req) }),
          state,
          challenge,
        }),
      );
      return true;
    }

    if (path === '/api/auth/google/callback' && req.method === 'GET') {
      const config = googleConfig();
      if (!config) {
        json(res, 501, { error: 'Google sign-in is not configured on this server' });
        return true;
      }
      // Errors come back to the page rather than as JSON: the browser is
      // following a redirect chain here, and a bare JSON error would strand it
      // on a white screen with no way back into the app. They land on the
      // sign-in screen, which is where the person was and where the form to try
      // again already is.
      const fail = (message) => redirect(res, `/signin?auth_error=${encodeURIComponent(message)}`);

      if (url.searchParams.get('error')) {
        fail(url.searchParams.get('error'));
        return true;
      }
      const saved = takeOAuthState(db, url.searchParams.get('state'));
      if (!saved) {
        fail('that sign-in link has expired — try again');
        return true;
      }
      const code = url.searchParams.get('code');
      if (!code) {
        fail('Google sent no authorization code');
        return true;
      }

      try {
        const tokens = await exchangeCode({
          code,
          verifier: saved.verifier,
          redirectUri: callbackUrl(req, config, { secure: isSecureRequest(req) }),
          config,
        });
        const claims = readIdToken(tokens.id_token, { clientId: config.clientId });
        const row = upsertIdentity(db, { provider: 'google', ...claims });
        res.writeHead(302, {
          location: '/',
          'cache-control': 'no-store',
          ...startSession(req, row),
        });
        res.end();
      } catch (err) {
        fail(err.message);
      }
      return true;
    }

    return false;
  }

  // -------------------------------------------------------------------- me --

  async function meRoutes(req, res, path, url) {
    if (!isMe(path)) return false;
    const user = userFor(req);
    if (!user) {
      json(res, 401, { error: 'sign in to use this' });
      return true;
    }
    const rest = path.slice('/api/me'.length) || '/';

    // Everything the page needs to draw the account, in one round trip.
    if (rest === '/' && req.method === 'GET') {
      json(res, 200, {
        user: publicUser(user),
        ...accountState(db, user.id),
        working_profile: getSetting(db, user.id, WORKING_PROFILE, null),
        statuses: APPLICATION_STATUSES.map((value) => ({ value, label: STATUS_LABELS[value] })),
      });
      return true;
    }

    if (rest === '/account' && req.method === 'PUT') {
      const body = await readBody(req, 10_000);
      json(res, 200, { user: updateProfileFields(db, user.id, { display_name: body.display_name }) });
      return true;
    }

    // Signing out everywhere. Worth having the moment sessions last 30 days.
    if (rest === '/sessions' && req.method === 'DELETE') {
      const dropped = destroyAllSessions(db, user.id);
      json(res, 200, { dropped }, { 'set-cookie': clearedCookie({ secure: isSecureRequest(req) }) });
      return true;
    }

    // ------------------------------------------------------- preferences --
    // The answer to "when you come back you don't re-enter all of them": the
    // live filter document, posted on a debounce and restored at boot. Kept
    // apart from named profiles on purpose — this is where you *are*, not a
    // search you decided to keep.
    if (rest === '/prefs' && req.method === 'GET') {
      json(res, 200, { profile: getSetting(db, user.id, WORKING_PROFILE, null) });
      return true;
    }
    if (rest === '/prefs' && req.method === 'PUT') {
      const body = await readBody(req);
      setSetting(db, user.id, WORKING_PROFILE, body.profile ?? null);
      json(res, 200, { ok: true });
      return true;
    }

    // ---------------------------------------------------------- profiles --
    if (rest === '/profiles' && req.method === 'GET') {
      json(res, 200, { profiles: listUserProfiles(db, user.id) });
      return true;
    }
    if (rest.startsWith('/profiles/')) {
      const name = rest.slice('/profiles/'.length);
      if (!SAFE_NAME.test(name)) {
        json(res, 400, { error: 'profile names are [a-z0-9._-], 1–64 chars' });
        return true;
      }
      if (req.method === 'GET') {
        const profile = getUserProfile(db, user.id, name);
        profile ? json(res, 200, profile) : json(res, 404, { error: 'no such profile' });
        return true;
      }
      if (req.method === 'PUT') {
        const body = await readBody(req);
        json(res, 200, { saved: name, profiles: putUserProfile(db, user.id, name, body) });
        return true;
      }
      if (req.method === 'DELETE') {
        const gone = deleteUserProfile(db, user.id, name);
        json(res, gone ? 200 : 404, gone
          ? { deleted: name, profiles: listUserProfiles(db, user.id) }
          : { error: 'no such profile' });
        return true;
      }
    }

    // ------------------------------------------------------- saved jobs --
    if (rest === '/saved' && req.method === 'GET') {
      const rows = listSaved(db, user.id, {
        status: url.searchParams.get('status'),
        listId: url.searchParams.get('list'),
      });
      json(res, 200, {
        saved: url.searchParams.get('hydrate') === '0' ? rows : hydrate(rows),
        counts: savedCounts(db, user.id),
        lists: listsFor(db, user.id),
        membership: listMembership(db, user.id),
      });
      return true;
    }
    if (rest.startsWith('/saved/')) {
      const jobId = rest.slice('/saved/'.length);
      if (req.method === 'PUT') {
        const body = await readBody(req, 50_000);
        const row = saveJob(db, user.id, jobId, body);
        json(res, 200, { saved: row, counts: savedCounts(db, user.id) });
        return true;
      }
      if (req.method === 'DELETE') {
        unsaveJob(db, user.id, jobId);
        json(res, 200, {
          removed: jobId,
          counts: savedCounts(db, user.id),
          membership: listMembership(db, user.id),
        });
        return true;
      }
    }

    // ------------------------------------------------------ hidden jobs --
    // The other half of the ★. A job hidden here is kept out of every search
    // this account runs — see the `exclude` set handed to the engine in
    // `server.mjs` — and this is the one screen it can still be read on, which
    // is what makes hiding a decision you can take back rather than a delete.
    if (rest === '/hidden' && req.method === 'GET') {
      const rows = listHidden(db, user.id);
      json(res, 200, {
        hidden: url.searchParams.get('hydrate') === '0' ? rows : hydrate(rows),
        count: rows.length,
      });
      return true;
    }
    if (rest.startsWith('/hidden/')) {
      const jobId = rest.slice('/hidden/'.length);
      if (req.method === 'PUT') {
        const body = await readBody(req, 50_000);
        const row = hideJob(db, user.id, jobId, body);
        json(res, 200, { hidden: row, count: hiddenCount(db, user.id) });
        return true;
      }
      if (req.method === 'DELETE') {
        unhideJob(db, user.id, jobId);
        json(res, 200, { restored: jobId, count: hiddenCount(db, user.id) });
        return true;
      }
    }

    // ------------------------------------------------------------- lists --
    if (rest === '/lists' && req.method === 'GET') {
      json(res, 200, { lists: listsFor(db, user.id) });
      return true;
    }
    if (rest === '/lists' && req.method === 'POST') {
      const body = await readBody(req, 10_000);
      const list = createList(db, user.id, body.name);
      json(res, 201, { list, lists: listsFor(db, user.id) });
      return true;
    }
    if (rest.startsWith('/lists/')) {
      // Matched rather than split on '/': the path arrives already decoded, so a
      // job id is the whole of the tail and a split would truncate any id with a
      // slash in it. Decoding it a second time would corrupt one containing '%'.
      const item = rest.match(/^\/lists\/([^/]+)\/items\/(.+)$/);
      const listId = item ? item[1] : rest.slice('/lists/'.length);
      const itemsWord = item ? 'items' : null;
      if (item) {
        const jobId = item[2];
        if (req.method === 'PUT') {
          const body = await readBody(req, 50_000);
          addToList(db, user.id, listId, jobId, body);
          json(res, 200, {
            lists: listsFor(db, user.id),
            membership: listMembership(db, user.id),
            counts: savedCounts(db, user.id),
          });
          return true;
        }
        if (req.method === 'DELETE') {
          removeFromList(db, user.id, listId, jobId);
          json(res, 200, { lists: listsFor(db, user.id), membership: listMembership(db, user.id) });
          return true;
        }
      }
      if (!itemsWord && req.method === 'PUT') {
        const body = await readBody(req, 10_000);
        renameList(db, user.id, listId, body.name);
        json(res, 200, { lists: listsFor(db, user.id) });
        return true;
      }
      if (!itemsWord && req.method === 'DELETE') {
        const gone = deleteList(db, user.id, listId);
        json(res, gone ? 200 : 404, gone
          ? { lists: listsFor(db, user.id), membership: listMembership(db, user.id) }
          : { error: 'no such list' });
        return true;
      }
    }

    return false;
  }

  return {
    db,
    handle,
    userFor,
    /**
     * The job ids this reader has hidden, or null for a stranger.
     *
     * The one thing the account layer hands *outwards* rather than serving.
     * `server.mjs` passes it to the search engine as an exclusion set, which is
     * the whole mechanism: the engine never learns what an account is, and the
     * search route stays a function of the profile document plus one set of
     * ids. Null and empty are both "change nothing", so a signed-out request is
     * byte-for-byte the search it always was.
     */
    hiddenFor: (user) => (user ? hiddenIds(db, user.id) : null),
    googleEnabled: () => Boolean(googleConfig()),
    close: () => db.close(),
  };
}

function parseJsonList(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
