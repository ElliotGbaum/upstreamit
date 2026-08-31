#!/usr/bin/env node
/**
 * The local app, and optional accounts.
 *
 *   node src/server.mjs                  # http://localhost:7799
 *   node src/server.mjs --port=8080
 *   node src/server.mjs --host=0.0.0.0   # opt in to the network, see below
 *   node src/server.mjs --no-accounts    # run exactly as it did before accounts
 *   node src/server.mjs --users-db=/tmp/x.db   # accounts somewhere else
 *
 * Serves `app/` and a small JSON API over the filter engine. Still local first:
 * a page reading `data/jobs.db` needs no hosting and no account, and the profile
 * it posts is the same portable JSON document the CLI and the daily run read.
 *
 * **Signing in is optional, and one route is the exception.** Every route below
 * but one behaves identically with no session: the corpus, the filters, the
 * counts, the descriptions and the apply links are the app, and they are
 * anonymous. What an account adds is *memory* — your filters when you come
 * back, the jobs you starred, the ones you told it never to show you again, and
 * what you did about them — and that part is all additive, served from a second
 * database (`data/users.db`) by `src/lib/users/`. Delete that file and this is
 * the anonymous server again.
 *
 * `POST /api/search` is the one route where "additive" means something subtler
 * than "unchanged": signed in, the ids you have hidden and the ones you have
 * applied to are subtracted from the result set before it is counted. That is
 * still the same engine reading the same profile document — the account
 * contributes sets of ids, not criteria — and signed out there are no sets and
 * nothing is subtracted.
 *
 * The exception is `POST /api/interpret`, which requires one. It is the only
 * route here that spends real money — an API call on somebody's key, every time
 * it is pressed — and that makes "who is asking" a question that has to have an
 * answer: an anonymous caller cannot be capped, cannot be told they have hit
 * their limit, and cannot be told apart from a script. Every *other* thing an
 * account touches stays additive, including the search that route produces.
 *
 * **Binds to 127.0.0.1 unless told otherwise.** The database holds a full copy
 * of every job description in the corpus and the API will happily serve any of
 * them; that is fine on a laptop and not fine on a café network, so exposing
 * it is an explicit flag rather than a default. Accounts raise the stakes of
 * that flag rather than lowering them — see the warning printed at startup.
 *
 * The one piece of shared state here is profile *files*. `PUT /api/profiles/:name`
 * writes `profiles/<name>.json`, which is why the name is checked against a
 * strict pattern rather than being trusted into a path join — and why, once the
 * server is reachable from off the machine, writing one requires a session.
 *
 * Not all of them are shared. A profile document may name an **`owner`**, and
 * an owned one is listed and served to that address alone; to everyone else it
 * 404s. That exists because the app boots into the first profile this server
 * lists, and for a while that was one person's NYC entry-level search — twelve
 * title keywords and a two-year cap, handed to every visitor as though it were
 * the corpus's own opinion of a good job. Owner-first ordering turns the same
 * mechanism into the good version of itself: sign in and your filters are
 * already there, sign out and you get the starter profile, which is nobody's.
 */

// First, for the side effect: `.env` into the environment before anything
// below reads a key out of it. See lib/env.mjs — a real variable wins.
import './lib/env.mjs';
import { createServer } from 'node:http';
import { readFile, stat, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join, dirname, extname, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDb } from './lib/db.mjs';
import {
  search,
  searchYielding,
  corpusMeta,
  getJob,
  getIndex,
  UNKNOWNABLE,
  UNKNOWN_POLICIES,
  SORTS,
  COMPANY_SIZE_BANDS,
  PAY_PERIODS,
  REMOTE_SCOPES,
  SECTORS,
} from './lib/filter/index.mjs';
import { newSince, changedSince, goneSince, activity } from './lib/filter/diff.mjs';
import { profilesVisibleTo, ownerOf, ownedBy, listProfiles, PROFILE_DIR } from './find.mjs';
import { json, readBody, CONTENT_TYPES as TYPES } from './lib/wire.mjs';
import { interpret, aiMeta, CALLS_PER_HOUR } from './lib/interpret.mjs';
import { createAccounts } from './lib/users/routes.mjs';
import { isSecureRequest, sameOrigin } from './lib/users/auth.mjs';
import { openUsersDb } from './lib/users/store.mjs';
import { statusVocabulary } from './lib/users/schema.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = join(ROOT, 'app');

/** Profile names become filenames. Anything outside this never touches a path. */
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * The document the page opens on: the first profile this viewer can see.
 *
 * Same choice `/api/meta` publishes as `profiles[0]`, made in one place so the
 * name and the document cannot disagree. A file that has gone missing or gone
 * malformed since it was listed returns null rather than throwing — the page
 * falls back to fetching it by name, and a broken starter profile should not
 * take the whole meta call down with it.
 */
async function bootProfile(profiles) {
  const first = profiles[0];
  if (!first?.path) return null;
  try {
    return JSON.parse(await readFile(first.path, 'utf8'));
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const args = { port: 7799, host: '127.0.0.1', db: undefined, usersDb: undefined, open: false, accounts: true };
  for (const arg of argv.slice(2)) {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
    if (key === 'port') args.port = Number(value);
    else if (key === 'host') args.host = value;
    else if (key === 'db') args.db = value;
    else if (key === 'users-db') args.usersDb = value;
    else if (key === 'open') args.open = value !== 'false';
    else if (key === 'accounts') args.accounts = value !== 'false';
    else if (key === 'no-accounts') args.accounts = false;
  }
  return args;
}

const isLoopback = (host) => host === '127.0.0.1' || host === 'localhost' || host === '::1';

/**
 * @param {object} db                 the corpus
 * @param {object} [options.accounts] the account layer, or null to run without one
 * @param {boolean} [options.sharedProfileWrites] may an anonymous request write
 *   a file into `profiles/`? True on a loopback bind, where the answer has
 *   always been yes and there is nobody else on the socket. False once the
 *   server is reachable from off the machine: the shared directory is every
 *   visitor's, and an unauthenticated stranger should not be able to overwrite
 *   the profile the daily run reads.
 */
export function createApp(db, { accounts = null, sharedProfileWrites = true } = {}) {
  return async function handle(req, res) {
    securityHeaders(req, res);

    const url = new URL(req.url, 'http://localhost');
    let path;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      // `/%E0` is not a path. Left uncaught, the URIError rejects this async
      // handler and Node treats that as fatal: one request took the whole
      // process down.
      return json(res, 400, { error: 'malformed path' });
    }

    if (redirectFromWww(req, res, url)) return;

    // The same-origin refusal for every /api write, not only the account
    // module's. The account layer keeps its own copy — it is a public entry
    // point exercised directly by tests — but /api/interpret (the one route
    // that spends the Anthropic key) and the shared-profile writes routed by
    // api() had none, and SameSite=Lax alone is exactly the single layer the
    // auth module's header says not to trust. Requests without an Origin
    // (curl, the CLI, the Sheet exporter) pass, as sameOrigin documents.
    if (path.startsWith('/api/') && req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) {
      return json(res, 403, { error: 'cross-origin write refused' });
    }

    try {
      if (accounts && (await accounts.handle(req, res, path, url))) return;
      if (path.startsWith('/api/')) return await api(db, req, res, path, url, { accounts, sharedProfileWrites });
      return await serveStatic(req, res, path);
    } catch (err) {
      // A status-carrying throw is an answer, not an accident: readBody's 400
      // and 413 land here from routes whose own try blocks sit below the body
      // read. Everything else is genuinely unexpected — log it, because a 500
      // on the deployed machine used to leave no trace in `fly logs` at all,
      // and say something fixed rather than err.message, which for a
      // filesystem failure is an absolute server path.
      if (Number.isInteger(err?.status) && err.status < 500) {
        return json(res, err.status, { error: err.message });
      }
      console.error(`${req.method} ${path} →`, err);
      json(res, 500, { error: 'something went wrong on this side; it has been logged' });
    }
  };
}

/**
 * What the pages are allowed to load, as an inventory rather than a wish.
 *
 * Same-origin scripts, styles and fetches; the two Google Fonts hosts; images
 * from here or inlined as `data:`. Nothing in `app/` uses an inline `<script>`,
 * an inline `<style>` or a `style=""` attribute — the one `innerHTML` in app.js
 * builds class-only markup — so the policy carries no `'unsafe-inline'`, which
 * is the clause that would let a script smuggled into a job description run.
 * Google sign-in is a top-level navigation to accounts.google.com and back
 * (users/routes.mjs), which no directive governs, so it needs no source here;
 * the sign-in form itself submits over fetch, so `form-action` stays at 'self'.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

/**
 * The headers every response carries, whatever route produced it.
 *
 * Set on `res` before any route runs, so a JSON error, a 304, a redirect and a
 * document all get the same set without each handler having to remember them:
 * Node merges headers set this way with whatever a route later hands to
 * `writeHead`. The policy goes out on every response rather than only on HTML
 * for the same reason — a browser applies it only to something it renders as
 * a document, it costs a few hundred bytes on a JSON body, and deciding "is
 * this a document" up here would mean duplicating the routing below.
 *
 * HSTS only when the request actually arrived over TLS — on Fly that is the
 * `x-forwarded-proto` the proxy adds, which `isSecureRequest` reads — and never
 * on plain `http://localhost`, where a year-long "this host is https-only"
 * would break the local server in every browser that had seen it.
 */
function securityHeaders(req, res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('content-security-policy', CONTENT_SECURITY_POLICY);
  if (isSecureRequest(req)) res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
}

/**
 * Send `www.example.com` to the bare `example.com`, permanently.
 *
 * Both names point at this one app — the custom domain puts `www` and the apex
 * on the same Fly addresses — so without this the site answers to two hostnames
 * that a browser treats as unrelated origins. Cookies are why that matters:
 * `sessionCookie` sets no `Domain` attribute (users/auth.mjs), which makes the
 * session host-only, so a sign-in at `www.` simply is not there at the apex. A
 * visitor would be signed out by following a link that differs by four
 * characters, and `sameOrigin` would then reject the POST that tried to fix it.
 *
 * Written against the `Host` we were actually reached on rather than a domain
 * in a constant: it survives the domain changing, and every host without the
 * prefix — `upstreamit.io`, `job-finder-ats.fly.dev`, `localhost:8080` — falls through
 * untouched.
 *
 * @returns {boolean} true when a redirect was sent and the caller must stop.
 */
function redirectFromWww(req, res, url) {
  const host = req.headers.host;
  if (!host?.startsWith('www.')) return false;
  const apex = host.slice(4);
  if (!apex) return false; // a bare `www.` Host is malformed; serve it normally

  // `url.pathname`, not the decoded `path`: Location carries the encoded form,
  // and re-encoding a decoded path is how a literal `%2F` turns into a `/`.
  const target = `${isSecureRequest(req) ? 'https' : 'http'}://${apex}${url.pathname}${url.search}`;

  // 308 rather than 301 for a body-carrying method: 301 permits a client to
  // retry a POST as a GET, which would drop a sign-in silently. 301 stays for
  // plain navigation, which is all that realistically arrives here.
  //
  // `no-cache` because a permanent redirect is otherwise permanent in every
  // visitor's browser forever. If this site ever wants `www` to be the
  // canonical name instead, the old rule and the new one meet in a redirect
  // loop that only a manual cache clear breaks. Revalidating costs one request
  // on a hostname almost nobody types any more.
  res.writeHead(req.method === 'GET' || req.method === 'HEAD' ? 301 : 308, {
    location: target,
    'cache-control': 'no-cache',
  });
  res.end();
  return true;
}

async function api(db, req, res, path, url, { accounts, sharedProfileWrites }) {
  /**
   * Who is asking. The session behind this request, or null for a stranger.
   *
   * Read once here and used by three routes, all of them additively: the
   * profile routes serve an owned document to its owner alone, `/api/interpret`
   * needs somebody to bill and cap, and the search excludes the jobs this
   * reader has hidden or applied to. Signed out, all three are what they always
   * were.
   *
   * `viewer` is the address, which is what a profile's `owner` field holds. See
   * `ownerOf` in find.mjs for why that is a visibility rule and not a secret.
   */
  const reader = accounts?.userFor(req) ?? null;
  const viewer = reader?.email ?? null;

  // ---------------------------------------------------------------- meta --
  // Everything the UI needs to draw its controls, all of it from the data. The
  // metro list is the registry the derive pass built from observed location
  // strings, so a corpus that grows a new city grows a new option with no code
  // change — that is the constraint that keeps other people's criteria
  // expressible, not just Elliot's.
  if (path === '/api/meta' && req.method === 'GET') {
    const index = getIndex(db);
    const profiles = profilesVisibleTo(viewer);
    return json(res, 200, {
      ...corpusMeta(db),
      // Theirs first, then the ones that belong to everyone — the page boots
      // into `profiles[0]`, so this ordering *is* "sign in and your filters are
      // already there".
      profiles,
      // And the document itself, not just its name.
      //
      // The page boots into `profiles[0]` and used to go and fetch it, which
      // put a whole round trip between "the page knows what to search for" and
      // "the page asks". Nothing in that trip was undecided — this route
      // already chose which profile it is, and `listProfiles` already read and
      // parsed the file to find out who owns it. Sending it costs a kilobyte
      // and removes a wait in front of the first search, which is the wait a
      // visitor actually sees.
      boot_profile: await bootProfile(profiles),
      // The unknown-policy controls are generated from this, not duplicated in
      // the page — the same rule the metro dropdown follows.
      unknowns: UNKNOWNABLE,
      unknown_policies: UNKNOWN_POLICIES,
      // The same rule for every closed vocabulary the page draws a control
      // from: served, not duplicated in the JavaScript. A value added to the
      // schema grows an option here with no second edit, which is how the
      // metro dropdown has always worked and why it has never gone stale.
      sorts: SORTS,
      company_sizes: COMPANY_SIZE_BANDS.map(({ value, label }) => ({ value, label })),
      pay_periods: PAY_PERIODS,
      remote_scopes: REMOTE_SCOPES,
      // What a company can be, for the sector panel. Served with the label
      // the model chose by, so the panel and the prompt cannot disagree.
      sectors: SECTORS.map(({ value, label }) => ({ value, label })),
      activity: activity(db, 30),
      index: { jobs: index.jobs.length, built_ms: index.buildMs, generation: index.generation },
      // Same rule again, applied to the account controls: whether accounts
      // exist at all, whether Google is configured, and the status vocabulary
      // are served rather than hardcoded in the page.
      auth: {
        enabled: Boolean(accounts),
        google: Boolean(accounts?.googleEnabled()),
        statuses: statusVocabulary(),
      },
      // And again for "describe it in words". Dormant with no API key, and the
      // page reads it to decide what to draw — the same shape as `auth` above,
      // for the same reason: a control that is there but cannot work is worse
      // than no control.
      //
      // Unlike everything else on this page it is answered *per viewer*, not
      // per corpus: it is the one feature behind an account, so whether it can
      // be used is a fact about who is asking. See `aiMeta`.
      ai: {
        ...aiMeta({ accounts: Boolean(accounts), signedIn: Boolean(viewer) }),
        calls_per_hour: CALLS_PER_HOUR,
      },
    });
  }

  // -------------------------------------------------------------- search --
  if (path === '/api/search' && req.method === 'POST') {
    const body = await readBody(req);
    const opts = {};
    if (body.limit != null) opts.limit = Number(body.limit);
    if (body.offset != null) opts.offset = Number(body.offset);
    if (body.facets === false) opts.facets = false;

    // The jobs this reader has already answered — pressed × on, or applied to —
    // kept out of the results and out of the counts. It is the one per-account
    // thing the search knows about, and it is sets of ids rather than criteria
    // on purpose: a profile is a portable document describing a *kind* of job,
    // and "not this one" is a fact about a person. Keeping it here means the
    // same profile file still means the same thing on the command line, in the
    // daily run, and in somebody else's copy.
    //
    // Signed out both are null and the engine takes the branch it always took.
    //
    // The second set is the jobs this reader has applied to. It is held back
    // for the same reason and by the same mechanism, and kept apart from the
    // first because the results line names which one held a job back and each
    // count links to the screen that has the way out of it.
    if (accounts && reader) {
      opts.exclude = accounts.hiddenFor(reader);
      opts.excludeApplied = accounts.appliedFor(reader);
    }

    // "New since" reuses the whole engine by restricting the id set rather than
    // reimplementing the criteria, so the diff can never drift from the filter.
    if (body.since) {
      const since = body.changed ? changedSince(db, body.since) : newSince(db, body.since);
      opts.restrictTo = since.ids;
      const result = await searchYielding(db, body.profile ?? {}, opts);
      return json(res, 200, { ...result, since: { from: since.from, latest: since.latest, pool: since.ids.size } });
    }
    return json(res, 200, await searchYielding(db, body.profile ?? {}, opts));
  }

  // ----------------------------------------------------------- interpret --
  // Free text — typed or dictated — into a complete filter profile. Returns the
  // document and a plain-English account of it; it does not save anything and
  // does not run the search. The page applies what comes back, shows the diff,
  // and keeps the old profile so Undo is one click.
  //
  // **The one route in this project that requires an account**, and the only
  // exception to "accounts are optional and subtractive of nothing". Every other
  // route behaves identically signed out: the corpus, the filters, the counts,
  // the descriptions and the apply links are the app, and they are anonymous.
  //
  // This one spends real money on somebody's API key every time it is pressed,
  // which makes "who is asking" a question that has to have an answer — an
  // anonymous caller cannot be capped, cannot be told they have reached their
  // limit, and cannot be distinguished from a script. It was gated on the bind
  // address instead, which protected the deployed copy and left the laptop open;
  // the bind address is a fact about the socket, and the thing worth knowing here
  // is a fact about the person.
  //
  // Note that this refuses *before* reading the body: a request that will not be
  // served should not first be allowed to send a megabyte.
  if (path === '/api/interpret' && req.method === 'POST') {
    if (!accounts) {
      return json(res, 401, {
        error: 'accounts are switched off on this server (--no-accounts), and describing a search needs one',
      });
    }
    if (!viewer) {
      return json(res, 401, {
        error: 'sign in to describe a search — it uses an API key, so it is the one thing here that needs an account',
      });
    }
    const body = await readBody(req);
    try {
      const result = await interpret(db, {
        text: body.text,
        current: body.profile ?? {},
        corpus: corpusMeta(db),
        // The account, always — the gate above guarantees there is one. That is
        // what makes the cap a cap: a per-socket limit is one NAT away from
        // being shared by an office, and one browser restart away from being
        // reset. The cap itself is applied inside `interpret`, at the line that
        // spends.
        who: viewer,
      });
      return json(res, 200, result);
    } catch (err) {
      // 400, not 500: everything this can throw is about the request or the
      // configuration — no key, no package, nothing typed, a refusal — and each
      // one is a sentence the page shows verbatim. The cap is the one that has
      // its own code, because a client should be able to tell "come back later"
      // from "this will never work".
      return json(res, err.rateLimited ? 429 : 400, { error: err.message });
    }
  }

  // ----------------------------------------------------------------- job --
  if (path.startsWith('/api/job/') && req.method === 'GET') {
    const job = getJob(db, path.slice('/api/job/'.length));
    return job ? json(res, 200, job) : json(res, 404, { error: 'no such job' });
  }

  // ------------------------------------------------------------ profiles --
  // The file-backed profiles — the ones the CLI and the daily run read. An
  // account's own profiles live at `/api/me/profiles/*` instead.
  //
  // Most of these belong to everyone: they are the worked examples the app
  // boots into, and they stay readable signed in or not. One of them does not.
  // A profile that names an `owner` is one person's job search — their
  // keywords, their city, their seniority — and serving it to every visitor
  // as the default made a personal document look like the corpus's own opinion
  // of what a good job is. Owned profiles are listed and served to their owner
  // and 404 for everybody else.
  if (path === '/api/profiles' && req.method === 'GET') {
    return json(res, 200, { profiles: profilesVisibleTo(viewer), writable: sharedProfileWrites || Boolean(accounts) });
  }
  if (path.startsWith('/api/profiles/')) {
    const name = path.slice('/api/profiles/'.length);
    if (!SAFE_NAME.test(name)) return json(res, 400, { error: 'profile names are [a-z0-9._-], 1–64 chars' });
    const file = join(PROFILE_DIR, `${name.replace(/\.json$/, '')}.json`);

    // Read it once, up front: every method below needs to know who owns the
    // document already on disk before it decides anything.
    let existing = null;
    try {
      existing = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      /* no such profile, or an unreadable one — both are "nothing here yet" */
    }
    const owner = ownerOf(existing);

    // Somebody else's. **404, not 403**, and for all three methods: a refusal
    // that distinguishes "not here" from "not yours" still tells a stranger
    // that this address has a saved search under this name, which is the thing
    // being kept to one account in the first place.
    if (owner && !ownedBy(owner, viewer)) return json(res, 404, { error: 'no such profile' });

    if (req.method === 'GET') {
      return existing ? json(res, 200, existing) : json(res, 404, { error: 'no such profile' });
    }

    // Writing to the shared directory: always allowed on a loopback bind, and
    // otherwise only for a signed-in visitor. Anonymous *reading* is untouched.
    if (req.method === 'PUT' || req.method === 'DELETE') {
      if (!sharedProfileWrites && !accounts?.userFor(req)) {
        return json(res, 401, {
          error: 'this server is reachable from the network — sign in to change a shared profile, or save it to your account',
        });
      }
    }

    if (req.method === 'PUT') {
      const body = await readBody(req);
      // You may only sign your own name to a profile. Without this, anyone
      // could drop a document into the shared directory that only somebody
      // else can see — a write nobody but its claimed owner can undo.
      const claimed = ownerOf(body);
      if (claimed && !ownedBy(claimed, viewer)) {
        return json(res, 403, {
          error: viewer
            ? `a profile can only be owned by the account saving it (${viewer})`
            : 'sign in as that address to save a profile owned by it',
        });
      }
      await mkdir(PROFILE_DIR, { recursive: true });
      // Saved as posted, not as normalized: a profile is a document someone
      // wrote, and rewriting their file with every default filled in would make
      // it unreadable and impossible to diff.
      await writeFile(file, `${JSON.stringify(body, null, 2)}\n`);
      // The name, not the file: the app never read the path, and the account
      // route's equivalent already answers with the bare name. An absolute
      // path in a JSON body is the server's filesystem layout, published.
      return json(res, 200, { saved: name.replace(/\.json$/, ''), profiles: profilesVisibleTo(viewer) });
    }
    if (req.method === 'DELETE') {
      try {
        await unlink(file);
      } catch {
        return json(res, 404, { error: 'no such profile' });
      }
      return json(res, 200, { deleted: name.replace(/\.json$/, ''), profiles: profilesVisibleTo(viewer) });
    }
  }

  // ------------------------------------------------------------- what's new --
  if (path === '/api/gone' && req.method === 'GET') {
    return json(res, 200, goneSince(db, url.searchParams.get('since') ?? '7d'));
  }

  return json(res, 404, { error: `no route for ${req.method} ${path}` });
}

/**
 * The screens that are not files.
 *
 * Signing in used to be a modal over the search page. It is its own screen now,
 * which means it needs its own address: something the OAuth callback can come
 * back to, an error can land on, and a person can bookmark or reload. All three
 * render the same document — auth.html reads the mode off the path.
 */
const PAGES = {
  '/signin': 'auth.html',
  '/signup': 'auth.html',
  '/password': 'auth.html',
  // The same reasoning, for a document rather than a flow. How the corpus is
  // built is the thing a stranger has to be able to check before they trust a
  // count on the search page, so it needs an address they can link someone
  // else to — not a panel that only exists once you are already inside the app.
  '/methodology': 'methodology.html',
};

/**
 * Files that sit in app/ but are not part of the app.
 *
 * landing.html is the marketing page. The code is kept deliberately — it is
 * worth more than the time it would take to write again — but nothing should
 * be able to reach it, so the static handler refuses it where it lies rather
 * than the file being moved or deleted.
 *
 * Lowercased on both sides on purpose: macOS filesystems are case-insensitive,
 * so `/LANDING.HTML` opens exactly the file `/landing.html` does, and a check
 * that compared verbatim would be one shift key away from useless. Matched on
 * the resolved path, after normalize(), so `/./landing.html` and friends
 * collapse to the same string.
 */
const PRIVATE = new Set([join(APP_DIR, 'landing.html').toLowerCase()]);

async function serveStatic(req, res, path) {
  const clean = path.replace(/\/+$/, '') || '/';
  const rel = clean === '/' ? 'index.html' : (PAGES[clean] ?? path.replace(/^\/+/, ''));
  // Contain the served path inside APP_DIR. This is a local tool, but a
  // traversal bug here would hand the whole disk to anything on the machine.
  const target = normalize(join(APP_DIR, rel));
  // The separator matters: a bare prefix test also passes siblings that share
  // the name's spelling — ../app.bak/secret normalizes to /app/app.bak/secret,
  // which startsWith('/app/app'). No such sibling exists today; the check
  // should not depend on that staying true.
  if (target !== APP_DIR && !target.startsWith(APP_DIR + sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  // 404 rather than 403: a 403 confirms the file is there. This answers the
  // way any other absent path answers, so the page is simply not on this
  // server as far as anything asking can tell.
  if (PRIVATE.has(target.toLowerCase())) {
    res.writeHead(404).end('not found');
    return;
  }
  try {
    const info = await stat(target);
    const entry = await staticEntry(target, info);
    const type = TYPES[extname(target)] ?? 'application/octet-stream';

    // `no-cache` is not `no-store`: it means "you may keep this, ask me before
    // you use it". The browser then sends the tag back and gets 304 and an
    // empty body instead of the file — app.js alone is 87 KB, and it had been
    // arriving in full on every single page load and every navigation between
    // the app and the sign-in pages.
    //
    // Not `immutable`, and not a max-age: these filenames carry no content
    // hash, so a cached copy the browser is allowed to *use* without asking is
    // a deploy that some visitors never see. Revalidation costs one small
    // round trip and can never serve yesterday's app.
    const headers = { 'content-type': type, 'cache-control': 'no-cache', etag: entry.etag };

    if (holdsTag(req, entry.etag)) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, { ...headers, 'content-length': entry.body.length });
    res.end(entry.body);
  } catch {
    res.writeHead(404).end('not found');
  }
}

/**
 * The app's files, held in memory with a tag, re-read when they change on disk.
 *
 * `app/` is eight small files that every page load asks for, and in the
 * container they are baked into the image and cannot change at all. Reading
 * them off the disk per request bought nothing; keeping them costs ~200 KB.
 *
 * The tag is the file's size and modification time, not a hash of its contents:
 * it only has to change when the file does, and `stat` is the call this already
 * makes to find out whether the file exists.
 */
const staticCache = new Map(); // absolute path -> { key, etag, body }

async function staticEntry(target, info) {
  const key = `${info.size}-${info.mtimeMs}`;
  const hit = staticCache.get(target);
  if (hit && hit.key === key) return hit;
  const entry = { key, etag: `W/"${info.size.toString(36)}-${Math.round(info.mtimeMs).toString(36)}"`, body: await readFile(target) };
  staticCache.set(target, entry);
  return entry;
}

/**
 * Is the browser already holding this version?
 *
 * `If-None-Match` may list several tags, and an intermediary is allowed to hand
 * back a tag it has weakened, so this compares over the list with the `W/`
 * prefix stripped from both sides — the weak comparison the spec specifies for
 * a GET, and the one that keeps a 304 working through Fly's proxy.
 */
function holdsTag(req, etag) {
  const header = req.headers['if-none-match'];
  if (!header) return false;
  const bare = (tag) => tag.trim().replace(/^W\//, '');
  const wanted = bare(etag);
  return header.split(',').some((tag) => bare(tag) === wanted);
}

/**
 * Search once with every profile in `profiles/`, and say how many ran.
 *
 * The result is thrown away; what it leaves behind is the page cache. A file
 * that will not parse is skipped rather than fatal — it is the page's problem
 * when someone picks it, not a reason the server should fail to start.
 */
async function warmProfiles(db) {
  let warmed = 0;
  for (const profile of listProfiles()) {
    try {
      search(db, JSON.parse(await readFile(profile.path, 'utf8')), { limit: 1, facets: false });
      warmed++;
    } catch {
      /* skipped */
    }
  }
  return warmed;
}

async function main() {
  const args = parseArgs(process.argv);
  const db = openDb(args.db);
  const meta = corpusMeta(db);

  if (!meta.derived) {
    console.error('No derived jobs in the database — run `npm run sweep && npm run derive` first.');
    process.exit(1);
  }

  const accounts = args.accounts
    ? createAccounts({ jobsDb: db, usersDb: args.usersDb ? openUsersDb(args.usersDb) : undefined })
    : null;
  const loopback = isLoopback(args.host);
  const server = createServer(createApp(db, { accounts, sharedProfileWrites: loopback }));

  // Warm the index **before** opening the port, not after.
  //
  // Building it is one synchronous pass over every open row — 3 seconds on a
  // laptop and ~20 on the deployed machine — and synchronous means the event
  // loop is held for the whole of it. Warming inside the `listen` callback
  // therefore did not avoid the wait, it hid it: the port was already open, so
  // Fly had already started sending real traffic, and the first visitors after
  // a deploy sat through the build with a page that appeared to be hanging.
  //
  // Doing it first costs the same seconds against startup, where the platform
  // is already waiting for the port and nobody is watching a blank screen.
  const started = Date.now();
  getIndex(db);
  const warmMs = Date.now() - started;

  // Then run each listed profile once, for the same reason. The index is the
  // open rows; a search also reads the full-text index and the descriptions
  // of the rows it ranks, and on first touch those come off the volume — which
  // on the deployed machine is slow enough that a cold search is seconds where
  // a warm one is one. The page boots into a listed profile, so this is the
  // exact search the first visitor after a deploy is about to ask for; paying
  // for it here means they get the warm answer, not the cold one.
  const warming = Date.now();
  const warmed = await warmProfiles(db);
  const warmedMs = Date.now() - warming;

  server.listen(args.port, args.host, () => {
    console.log(`\n  UpstreamIt → http://${args.host}:${args.port}`);
    console.log(
      `  ${meta.open.toLocaleString('en-US')} open jobs · ${meta.companies.toLocaleString('en-US')} boards · ` +
        `${meta.metros_total.toLocaleString('en-US')} metros · index warm in ${warmMs} ms · ` +
        `${warmed} profile${warmed === 1 ? '' : 's'} warm in ${warmedMs} ms`,
    );
    console.log(
      accounts
        ? `  accounts on · optional · ${accounts.googleEnabled() ? 'password or Google' : 'password only — see docs/app-and-accounts.md for Google sign-in'}\n`
        : '  accounts off — --no-accounts\n',
    );
    if (!loopback) {
      console.log(`  ! bound to ${args.host} — this serves every job description in the database to anyone who can reach it`);
      if (accounts) {
        // Said plainly because it is the one thing about this that can hurt
        // someone: a password over plain HTTP is a password in the clear, and
        // the session cookie that follows it is a bearer token in the clear.
        console.log('  ! and accepts passwords over plain HTTP — put TLS in front of it, or use --no-accounts, before exposing it\n');
      } else {
        console.log('');
      }
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
