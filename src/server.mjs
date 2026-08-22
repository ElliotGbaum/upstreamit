#!/usr/bin/env node
/**
 * Phase 6 — the local app. Phase 7 — optional accounts.
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
 * **Signing in is optional and subtractive of nothing.** Every route below
 * behaves identically with no session: the corpus, the filters, the counts, the
 * descriptions and the apply links are the app, and they are anonymous. What an
 * account adds is *memory* — your filters when you come back, the jobs you
 * starred, and what you did about them — and it is all additive, served from a
 * second database (`data/users.db`) by `src/lib/users/`. Delete that file and
 * this is the Phase 6 server again.
 *
 * **Binds to 127.0.0.1 unless told otherwise.** The database holds a full copy
 * of 61,213 job descriptions and the API will happily serve any of them; that
 * is fine on a laptop and not fine on a café network, so exposing it is an
 * explicit flag rather than a default. Accounts raise the stakes of that flag
 * rather than lowering them — see the warning printed at startup.
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

import { createServer } from 'node:http';
import { readFile, stat, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDb } from './lib/db.mjs';
import {
  search,
  corpusMeta,
  getJob,
  getIndex,
  UNKNOWNABLE,
  UNKNOWN_POLICIES,
  SORTS,
  COMPANY_SIZE_BANDS,
  PAY_PERIODS,
  REMOTE_SCOPES,
} from './lib/filter/index.mjs';
import { newSince, changedSince, goneSince, activity } from './lib/filter/diff.mjs';
import { profilesVisibleTo, ownerOf, ownedBy, PROFILE_DIR } from './find.mjs';
import { json, readBody, CONTENT_TYPES as TYPES } from './lib/wire.mjs';
import { createAccounts } from './lib/users/routes.mjs';
import { openUsersDb } from './lib/users/store.mjs';
import { APPLICATION_STATUSES, STATUS_LABELS } from './lib/users/schema.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = join(ROOT, 'app');

/** Profile names become filenames. Anything outside this never touches a path. */
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

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
    const url = new URL(req.url, 'http://localhost');
    const path = decodeURIComponent(url.pathname);

    try {
      if (accounts && (await accounts.handle(req, res, path, url))) return;
      if (path.startsWith('/api/')) return await api(db, req, res, path, url, { accounts, sharedProfileWrites });
      return await serveStatic(res, path);
    } catch (err) {
      json(res, 500, { error: err.message });
    }
  };
}

async function api(db, req, res, path, url, { accounts, sharedProfileWrites }) {
  /**
   * Who is asking, as an email address, or null when nobody is signed in.
   *
   * The only thing the profile routes below need out of a session. A profile
   * document may name an `owner`; one that does is listed and served to that
   * address and to nobody else, so that the app boots a visitor into a starter
   * search rather than into a stranger's twelve keywords and one city. See
   * `ownerOf` in find.mjs for why this is a visibility rule and not a secret.
   */
  const viewer = accounts?.userFor(req)?.email ?? null;

  // ---------------------------------------------------------------- meta --
  // Everything the UI needs to draw its controls, all of it from the data. The
  // metro list is the registry the derive pass built from observed location
  // strings, so a corpus that grows a new city grows a new option with no code
  // change — that is the constraint that keeps other people's criteria
  // expressible, not just Elliot's.
  if (path === '/api/meta' && req.method === 'GET') {
    const index = getIndex(db);
    return json(res, 200, {
      ...corpusMeta(db),
      // Theirs first, then the ones that belong to everyone — the page boots
      // into `profiles[0]`, so this ordering *is* "sign in and your filters are
      // already there".
      profiles: profilesVisibleTo(viewer),
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
      activity: activity(db, 30),
      index: { jobs: index.jobs.length, built_ms: index.buildMs, generation: index.generation },
      // Same rule again, applied to the account controls: whether accounts
      // exist at all, whether Google is configured, and the status vocabulary
      // are served rather than hardcoded in the page.
      auth: {
        enabled: Boolean(accounts),
        google: Boolean(accounts?.googleEnabled()),
        statuses: APPLICATION_STATUSES.map((value) => ({ value, label: STATUS_LABELS[value] })),
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

    // "New since" reuses the whole engine by restricting the id set rather than
    // reimplementing the criteria, so the diff can never drift from the filter.
    if (body.since) {
      const since = body.changed ? changedSince(db, body.since) : newSince(db, body.since);
      opts.restrictTo = since.ids;
      const result = search(db, body.profile ?? {}, opts);
      return json(res, 200, { ...result, since: { from: since.from, latest: since.latest, pool: since.ids.size } });
    }
    return json(res, 200, search(db, body.profile ?? {}, opts));
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
    return json(res, 200, { profiles: profilesVisibleTo(viewer), dir: PROFILE_DIR, writable: sharedProfileWrites || Boolean(accounts) });
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
      return json(res, 200, { saved: file, profiles: profilesVisibleTo(viewer) });
    }
    if (req.method === 'DELETE') {
      try {
        await unlink(file);
      } catch {
        return json(res, 404, { error: 'no such profile' });
      }
      return json(res, 200, { deleted: file, profiles: profilesVisibleTo(viewer) });
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
};

async function serveStatic(res, path) {
  const clean = path.replace(/\/+$/, '') || '/';
  const rel = clean === '/' ? 'index.html' : (PAGES[clean] ?? path.replace(/^\/+/, ''));
  // Contain the served path inside APP_DIR. This is a local tool, but a
  // traversal bug here would hand the whole disk to anything on the machine.
  const target = normalize(join(APP_DIR, rel));
  if (!target.startsWith(APP_DIR)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    await stat(target);
    const body = await readFile(target);
    res.writeHead(200, { 'content-type': TYPES[extname(target)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
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

  server.listen(args.port, args.host, () => {
    const started = Date.now();
    const index = getIndex(db); // warm it now, so the first search is not the slow one
    console.log(`\n  Job Finder → http://${args.host}:${args.port}`);
    console.log(
      `  ${meta.open.toLocaleString('en-US')} open jobs · ${meta.companies.toLocaleString('en-US')} boards · ` +
        `${meta.metros.length.toLocaleString('en-US')} metros · index warm in ${Date.now() - started} ms`,
    );
    console.log(
      accounts
        ? `  accounts on · optional · ${accounts.googleEnabled() ? 'password or Google' : 'password only — see README for Google sign-in'}\n`
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
    void index;
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
