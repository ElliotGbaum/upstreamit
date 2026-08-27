/**
 * UpstreamIt — the account layer, in the browser.
 *
 * Everything in this file is additive. The page it decorates works with no
 * session at all: the corpus, the filters, the leave-one-out counts, the
 * descriptions and the apply links are the app, and they are anonymous. Signing
 * in adds *memory* — the filters you had last time, the jobs you starred, and
 * what you did about them — and it is the only thing it adds.
 *
 * Which is why every entry point here is written to be a no-op when signed out.
 * `starFor()` returns nothing, `decorateCard()` does nothing, `remember()`
 * returns immediately. `app.js` calls them unconditionally and never asks
 * whether anyone is signed in; there is one code path through the page, not two.
 *
 * The other rule this file follows is the page's existing one: **nothing is
 * ever inserted as HTML.** Job titles, company names and a user's own notes are
 * all set with `textContent`. The descriptions on this page come from thousands
 * of different companies and the notes come from whoever is typing; neither
 * gets to execute.
 */


const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n ?? 0).toLocaleString('en-US');

/**
 * Everything the account layer knows. Populated by `refresh()` from one
 * `/api/me` round trip, so the star on a card, the count in the header and the
 * saved view can never disagree with each other.
 */
const state = {
  enabled: false, // does this server have accounts at all
  user: null,
  statuses: [],
  saved: new Map(), // job_id → the saved row
  lists: [],
  membership: {}, // job_id → [list id]
  counts: { total: 0 },
  profiles: [], // this account's saved filter documents
  working: null, // the filter document this account was last using
  scope: { kind: 'all' }, // what the saved view is showing
  hiddenCount: 0, // jobs pressed × on; the rows themselves load with the screen
  // Set when a job stops being held back — brought back from Hidden, or moved
  // off Applied — and cleared when the search is re-run. The results on screen
  // were filtered by sets that no longer hold, and a job cannot put itself back
  // into a list it was excluded from before that list was counted.
  excludeStale: false,
};

/** Set by `init()`; how this module reaches the page's single `profile` object. */
let bridge = {
  getProfile: () => ({}),
  setProfile: () => {},
  onProfilesChanged: () => {},
  rerunSearch: () => {},
};

/**
 * A local copy of app.js's fetch wrapper.
 *
 * Deliberately not imported from there: app.js imports this file, and a cycle
 * between the two to share twelve lines of `fetch` would be a worse trade than
 * the twelve lines.
 */
async function request(path, options) {
  const res = await fetch(path, options);
  if (res.status === 204) return {};
  let body = {};
  try {
    body = await res.json();
  } catch {
    /* some errors have no body */
  }
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body;
}

const send = (path, method, payload) =>
  request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });

// ------------------------------------------------------------------- state --

export const account = {
  init,
  starFor,
  appliedFor,
  hideFor,
  openHidden,
  openApplied,
  decorateCard,
  detailPanel,
  remember,
  profileOptions,
  save,
  load,
  isOn,
  signedIn,
};

function isOn() {
  return state.enabled;
}
function signedIn() {
  return Boolean(state.user);
}

async function init({ meta, who, getProfile, setProfile, onProfilesChanged, rerunSearch }) {
  bridge = { getProfile, setProfile, onProfilesChanged, rerunSearch: rerunSearch ?? (() => {}) };
  state.enabled = Boolean(meta?.auth?.enabled);
  state.statuses = meta?.auth?.statuses ?? [];
  if (!state.enabled) return null;

  bindChrome();
  showCallbackError();

  try {
    // `who` is the answer to `/api/auth/me`, already in flight since the page
    // booted — the call does not depend on anything in `meta`, so it does not
    // wait for it. A caller that does not pass one asks here, as before.
    const answer = await (who ?? request('/api/auth/me'));
    if (answer?.user) await refresh();
  } catch {
    /* the account layer is optional; a page that cannot reach it still works */
  }
  drawChrome();
  // What the page should boot into: the filters this account was last using,
  // already in hand from the `/api/me` payload rather than a second round trip.
  return state.user ? (state.working ?? null) : null;
}

/** One round trip; everything the account draws comes out of it. */
async function refresh() {
  const me = await request('/api/me');
  state.user = me.user;
  state.statuses = me.statuses ?? state.statuses;
  state.saved = new Map((me.saved ?? []).map((row) => [row.job_id, row]));
  state.lists = me.lists ?? [];
  state.membership = me.membership ?? {};
  state.counts = me.counts ?? { total: 0 };
  state.profiles = me.profiles ?? [];
  state.working = me.working_profile ?? null;
  state.hiddenCount = me.hidden_count ?? 0;
  drawChrome();
  bridge.onProfilesChanged();
}

function forget() {
  state.user = null;
  state.saved = new Map();
  state.lists = [];
  state.membership = {};
  state.counts = { total: 0 };
  state.profiles = [];
  state.hiddenCount = 0;
  state.scope = { kind: 'all' };
  drawChrome();
  bridge.onProfilesChanged();
  showSaved(false);
  // Signing out has to take your marks off the page with it — a leftover
  // "applied" pill on a signed-out screen is someone else's business.
  document.querySelectorAll('.job .star, .job .applied-tick, .job .chip.status').forEach((node) => node.remove());
}

// ------------------------------------------------------------------ header --

function drawChrome() {
  if (!state.enabled) return;
  $('acct-anon').hidden = Boolean(state.user);
  $('acct-user').hidden = !state.user;
  if (!state.user) return;
  $('saved-count').textContent = fmt(state.counts.total);
  $('acct-name').textContent = state.user.display_name || state.user.email.split('@')[0];
  $('acct-email').textContent = state.user.email;
  $('acct-password').textContent = state.user.has_password ? 'Change password' : 'Set a password';
}

function bindChrome() {
  // A real link, so the screen behaves like one — middle-click, cmd-click and
  // "open in new tab" all work. The listener only leaves a breadcrumb behind;
  // the navigation is the browser's.
  $('signin').addEventListener('click', stashProfile);
  // The button says Saved, so it opens Saved — even when the last thing you
  // looked at on that screen was the hidden list.
  $('saved-toggle').onclick = () => {
    const opening = $('saved-view').hidden;
    if (opening && state.scope.kind === 'hidden') state.scope = { kind: 'all' };
    showSaved(opening);
  };
  $('saved-back').onclick = () => showSaved(false);

  const menu = $('acct-menu');
  $('acct-menu-btn').onclick = (event) => {
    event.stopPropagation();
    menu.hidden = !menu.hidden;
    $('acct-menu-btn').setAttribute('aria-expanded', String(!menu.hidden));
  };
  document.addEventListener('click', (event) => {
    if (!menu.hidden && !menu.contains(event.target)) menu.hidden = true;
  });

  /**
   * Signing out is a full navigation, for the same reason signing in is one.
   *
   * `forget()` alone clears what this module drew — the stars, the counts, the
   * account menu. It cannot clear what the *page* is holding, and after this
   * change the page may be holding something private: the filter document on
   * screen, and the profile list it booted from, can both include a profile
   * the server lists only to the account that just left. Tearing those down
   * field by field is a list nobody will remember to add to. Arriving at `/`
   * fresh re-asks `/api/meta` with no cookie, so the menu, the filters and the
   * search all come back as a stranger sees them, in agreement.
   */
  const signOut = async (leave) => {
    menu.hidden = true;
    try {
      await leave();
    } finally {
      forget();
      location.href = '/';
    }
  };
  $('acct-signout').onclick = () => signOut(() => send('/api/auth/logout', 'POST'));
  $('acct-signout-all').onclick = () => signOut(() => request('/api/me/sessions', { method: 'DELETE' }));
  $('acct-password').onclick = () => {
    menu.hidden = true;
    goToAuth('password');
  };
}

/**
 * An error from the Google callback arrives as a query parameter, and lands on
 * the sign-in screen where the form to try again is. This only catches a stale
 * link that still points the old message at the search page.
 */
function showCallbackError() {
  const params = new URLSearchParams(location.search);
  const error = params.get('auth_error');
  if (error) location.replace(`/signin?auth_error=${encodeURIComponent(error)}`);
}

// --------------------------------------------------------- the sign-in screen --

/**
 * Signing in is a screen — `/signin`, `/signup`, `/password` — and not a modal
 * over this one.
 *
 * A modal had no address, which left the OAuth callback nowhere to return to
 * and an error nowhere to land, and it made an account feel like an
 * interruption of the page rather than somewhere you went. Everything the
 * screen needs it reads from the server itself; the one thing it cannot is the
 * search on this page, so that travels in session storage.
 */
function goToAuth(mode = 'signin') {
  stashProfile();
  const path = { signup: '/signup', password: '/password' }[mode] ?? '/signin';
  const next = location.pathname + location.search;
  location.href = next === '/' ? path : `${path}?next=${encodeURIComponent(next)}`;
}

/**
 * The filters on screen, left where a brand-new account can pick them up.
 *
 * A new account has no remembered search and the one here is the one the person
 * just spent time building, so it becomes theirs — behaviour the old in-place
 * dialog got for free and a navigation has to carry.
 */
function stashProfile() {
  try {
    const profile = bridge.getProfile();
    if (profile && Object.keys(profile).length) sessionStorage.setItem('jf.pending-profile', JSON.stringify(profile));
  } catch {
    /* a lost draft is not worth blocking a sign-in over */
  }
}

// ------------------------------------------------- remembering the filters --

/**
 * Save the working filter document, on a debounce.
 *
 * This is the whole of "you don't have to re-enter them": every change to the
 * profile posts it here, and `init()` hands it back at boot. It is kept apart
 * from a *named* profile on purpose — this is where you are, not a search you
 * decided to keep.
 */
let rememberTimer = null;
function remember(profile, { now = false } = {}) {
  if (!state.user) return;
  clearTimeout(rememberTimer);
  const write = () => send('/api/me/prefs', 'PUT', { profile }).catch(() => {});
  if (now) write();
  else rememberTimer = setTimeout(write, 1200);
}

// ------------------------------------------------- one request at a time --

/**
 * The last request sent about each job, so the next one about the same job
 * goes after it.
 *
 * Every mark on a card is drawn before the server has answered — see
 * `toggleSave` — which means a second press can come while the first is still
 * on its way: hide, then Undo a moment later. Sent together, the two can be
 * handled in either order, and "hidden" would be the server's answer to a
 * pair of presses that meant "not hidden". Chaining them per job keeps the
 * server's record in the order the presses came. Requests about different
 * jobs do not wait on each other.
 */
const inFlight = new Map(); // job id → the promise of the last request about it

function afterPrevious(jobId, work) {
  const run = (inFlight.get(jobId) ?? Promise.resolve()).then(work, work);
  const settled = run.catch(() => {});
  inFlight.set(jobId, settled);
  settled.then(() => {
    if (inFlight.get(jobId) === settled) inFlight.delete(jobId);
  });
  return run;
}

// ------------------------------------------------------ the star on a card --

/**
 * The star: save a job, or take it back off the list.
 *
 * It sits on every result card and on every row of the saved view, and it means
 * the same thing in both places. On a result card it is the first of the three
 * decisions you can make about a job at a glance — keep it, apply to it, never
 * see it again — and it is the only one of the three that changes nothing about
 * what the search returns: a saved job stays exactly where it ranked, with the
 * star filled in so you can see which ones are yours.
 *
 * It once lived in the rank gutter alone, where `1☆ 2☆ 3☆` read as decoration
 * on the position number rather than as a control. It is back because a pair of
 * buttons in a cluster of their own reads as a pair of buttons.
 *
 * Handles the signed-out case rather than vanishing: a control that disappears
 * teaches nobody what an account is for.
 */
function starFor(row) {
  if (!state.enabled) return null;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'star';
  paintStar(button, row.id);
  button.onclick = (event) => {
    event.stopPropagation();
    if (!state.user) return goToAuth('signin');
    void toggleSave(row);
  };
  return button;
}

function paintStar(button, jobId) {
  const saved = state.saved.get(jobId);
  button.dataset.job = jobId;
  button.textContent = saved ? '★' : '☆';
  button.classList.toggle('on', Boolean(saved));
  button.title = saved
    ? `Saved${saved.status !== 'saved' ? ` · ${labelFor(saved.status)}` : ''} — click to remove`
    : state.user
      ? 'Save this job — it stays in your results, marked ★, and is listed under Saved'
      : 'Sign in to save jobs';
}

/**
 * Save or un-save: drawn first, sent second.
 *
 * The star fills in the instant it is pressed and the request goes out behind
 * it. It used to be the other way round — press, wait, paint — which put the
 * whole round trip, plus whatever the server happened to be busy with, between
 * the press and anything visibly happening. The trip is ~40 ms on a quiet
 * server; behind somebody's search it was a second or more, and a button that
 * does nothing for a second reads as a button that did not work. If the server
 * refuses, the star goes back to how it was and the page says so.
 *
 * Until the answer comes the row under the star is a stand-in with the fields
 * the star reads. The server's row replaces it — unless a later press has
 * already moved the star on, in which case that press's answer is the one
 * that counts, and this one leaves the star alone.
 */
async function toggleSave(row) {
  const jobId = row.id;
  const before = state.saved.get(jobId) ?? null;
  const placeholder = before ? null : provisionalSave(row);
  if (before) state.saved.delete(jobId);
  else state.saved.set(jobId, placeholder);
  state.counts = countsMoved(before ? before.status : 'saved', before ? -1 : 1);
  // Un-starring a job filed under a status that held it back puts it back in
  // your searches, and the list on screen was counted without it.
  if (before && hidesFromSearch(before.status)) state.excludeStale = true;
  drawChrome();
  repaintMarks(jobId);
  try {
    await afterPrevious(jobId, async () => {
      if (before) {
        const result = await request(`/api/me/saved/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
        state.counts = result.counts;
        state.membership = result.membership;
      } else {
        // The snapshot travels with the save so the row still reads correctly
        // if the posting is pulled from the board later.
        const result = await send(`/api/me/saved/${encodeURIComponent(jobId)}`, 'PUT', {
          title: row.title,
          company: row.company ?? row.company_name,
          url: row.url,
        });
        if (state.saved.get(jobId) === placeholder) state.saved.set(jobId, result.saved);
        state.counts = result.counts;
      }
    });
    drawChrome();
    repaintMarks(jobId);
    if (!$('saved-view').hidden) renderSaved();
  } catch (err) {
    // Undo only what this press drew. A later press's star stands.
    const untouched = before ? !state.saved.has(jobId) : state.saved.get(jobId) === placeholder;
    if (untouched) {
      if (before) state.saved.set(jobId, before);
      else state.saved.delete(jobId);
      state.counts = countsMoved(before ? before.status : 'saved', before ? 1 : -1);
      drawChrome();
      repaintMarks(jobId);
    }
    alert(`Could not save that: ${err.message}`);
  }
}

/** What the star reads while the server's own row is on its way. */
function provisionalSave(row) {
  const now = Date.now();
  return {
    job_id: row.id,
    status: 'saved',
    note: null,
    saved_at: now,
    updated_at: now,
    applied_at: null,
    title: row.title ?? null,
    company: row.company ?? row.company_name ?? null,
    url: row.url ?? null,
  };
}

/** The header's counts, moved by one, for the moment before the server's own arrive. */
function countsMoved(status, delta) {
  const counts = { ...state.counts };
  counts[status] = (counts[status] ?? 0) + delta;
  counts.total = (counts.total ?? 0) + delta;
  return counts;
}

/**
 * Take a job off the saved list entirely.
 *
 * Un-starring a job you had marked applied also un-marks it, so it is back in
 * your searches — which is why this reports a stale search the same way a
 * status change does.
 */
async function unsave(jobId) {
  const before = state.saved.get(jobId) ?? null;
  const result = await request(`/api/me/saved/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
  state.saved.delete(jobId);
  state.counts = result.counts;
  state.membership = result.membership;
  if (hidesFromSearch(before?.status)) state.excludeStale = true;
  drawChrome();
  repaintMarks(jobId);
}

/**
 * Write a status, and leave every copy of the job on screen in agreement.
 *
 * The single place a status is written: the ✓ on a card, the five-way control
 * inside an opened job and the same control on a saved row all come through
 * here, so the star, the header count and the saved view cannot end up telling
 * you different things about one job.
 *
 * Crossing into or out of a status that holds a job back marks the search
 * behind it stale — the list on screen was counted under a set that has just
 * changed, and no job can put itself back into a count it was left out of.
 */
async function setStatus(row, status) {
  const before = state.saved.get(row.id) ?? null;
  const result = await send(`/api/me/saved/${encodeURIComponent(row.id)}`, 'PUT', {
    status,
    title: row.title,
    company: row.company ?? row.company_name,
    url: row.url,
  });
  state.saved.set(row.id, result.saved);
  state.counts = result.counts;
  if (hidesFromSearch(before?.status) !== hidesFromSearch(status)) state.excludeStale = true;
  drawChrome();
  repaintMarks(row.id);
  return result.saved;
}

/** Both marks a card carries, on every copy of that job the page is showing. */
function repaintMarks(jobId) {
  const selector = `[data-job="${cssEscape(jobId)}"]`;
  document.querySelectorAll(`.star${selector}`).forEach((el) => paintStar(el, jobId));
  document.querySelectorAll(`.applied-tick${selector}`).forEach((el) => paintApplied(el, jobId));
}

/**
 * Does this status take the job out of your searches?
 *
 * The answer arrives with the vocabulary — `hides` on each status, out of the
 * server's `ACTED_ON` — rather than being a second list written out here, so
 * what the ✓ promises and what the engine actually subtracts are one rule. A
 * page that has not heard from the server yet knows of no such status, and the
 * ✓ is simply off.
 */
function hidesFromSearch(status) {
  return Boolean(status && state.statuses.find((s) => s.value === status)?.hides);
}

/** Has this job been applied to — or anything further along than applied? */
function markedApplied(jobId) {
  return hidesFromSearch(state.saved.get(jobId)?.status);
}

// ----------------------------------------------------- the ✓ on a card --

/**
 * "I applied to this."
 *
 * The third decision a card offers, and the one this page was missing: the star
 * says *keep this*, the × says *never show me this again*, and neither of them
 * is what you mean at the moment you finish an application. That job is not a
 * favourite and it is not a rejection — it is done, and a board that keeps
 * offering it back to you every morning is wrong in the same way as one that
 * keeps offering the job you turned down.
 *
 * So it behaves like the × where that is what it means, and like the star where
 * that is: the row leaves the list at once with a line naming it and an Undo,
 * and from the next search on the posting is subtracted before anything is
 * counted — but the job is *kept*, filed under Applied with the date on it,
 * because "did I ever apply to this" has to keep answering after the posting is
 * gone. Nothing is thrown away by pressing it.
 *
 * Pressing it on a job already marked takes the mark off and puts the job back
 * in your searches, which is the way back for the misclick you notice later
 * rather than at once.
 */
function appliedFor(row) {
  if (!state.enabled) return null;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'applied-tick';
  paintApplied(button, row.id);
  button.onclick = async (event) => {
    event.stopPropagation();
    if (!state.user) return goToAuth('signin');
    const card = button.closest('.job');
    // What to put back on Undo: the row as it stood before this click, or
    // nothing at all if the job was not saved. An undo that left a starred job
    // behind would be a second thing to undo.
    const before = state.saved.get(row.id) ?? null;
    const marked = markedApplied(row.id);
    button.disabled = true;
    try {
      await setStatus(row, marked ? 'saved' : 'applied');
      // Coming *off* applied leaves the card where it is. The row is in front
      // of you, and taking it away to announce that it is back in your results
      // would be the opposite of what the click asked for.
      if (marked || !card) button.disabled = false;
      else card.replaceWith(appliedNotice(row, card, button, before));
      if (!$('saved-view').hidden) void renderSaved();
    } catch (err) {
      button.disabled = false;
      alert(`Could not mark that applied: ${err.message}`);
    }
  };
  return button;
}

function paintApplied(button, jobId) {
  const on = markedApplied(jobId);
  button.dataset.job = jobId;
  button.textContent = '✓';
  button.classList.toggle('on', on);
  button.setAttribute('aria-label', on ? 'Applied — undo' : 'I applied to this');
  button.title = on
    ? `${labelFor(state.saved.get(jobId)?.status)} — click to put this job back in your searches`
    : state.user
      ? 'I applied to this — file it under Applied and keep it out of your searches'
      : 'Sign in to mark the jobs you have applied to';
}

/**
 * What stands in the list where a job you just applied to was.
 *
 * The card itself is kept, detached, and put back on Undo — the same trick the
 * × uses, and for the same reason: the restored row comes back with its rank,
 * its chips and its open/closed state, rather than being rebuilt from a second
 * copy of `jobCard` living in this file.
 */
function appliedNotice(row, card, button, before) {
  const notice = document.createElement('div');
  notice.className = 'job hidden-notice applied-notice';

  const said = document.createElement('span');
  said.className = 'said';
  const name = document.createElement('b');
  name.textContent = row.title ?? 'That job';
  said.append('Applied — ', name, ' is under Applied, and out of your searches from here on.');

  const undo = document.createElement('button');
  undo.type = 'button';
  undo.className = 'btn ghost';
  undo.textContent = 'Undo';
  undo.onclick = async (event) => {
    event.stopPropagation();
    undo.disabled = true;
    try {
      if (before) await setStatus(row, before.status);
      else await unsave(row.id);
      button.disabled = false;
      notice.replaceWith(card);
      if (!$('saved-view').hidden) void renderSaved();
    } catch (err) {
      undo.disabled = false;
      alert(`Could not undo that: ${err.message}`);
    }
  };

  notice.append(said, undo);
  return notice;
}

// ------------------------------------------------------ the × on a card --

/**
 * "Not interested." The last of the three marks on a card, and — with the ✓ —
 * one of the two that change what a search *returns* rather than what it says
 * about a job you keep. The two are not the same answer: the ✓ says you have
 * already done this one, the × says you never want it.
 *
 * Pressing it takes the card off the list at once, because a button called "do
 * not show me this again" that leaves the row sitting there has not done the
 * thing it says. What it leaves behind is a line naming the job and an Undo —
 * hiding by mistake is a click away from being fixed, and the line is also how
 * you learn where the job went. From the next search on it is simply not there:
 * the server subtracts it before counting (`opts.exclude` in server.mjs).
 */
function hideFor(row) {
  if (!state.enabled) return null;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'hide-x';
  button.textContent = '×';
  button.setAttribute('aria-label', 'Not interested — hide this job');
  button.title = state.user
    ? 'Not interested — hide this job from every future search'
    : 'Sign in to hide jobs you do not want to see again';
  button.onclick = (event) => {
    event.stopPropagation();
    if (!state.user) return goToAuth('signin');
    const card = button.closest('.job');
    // Off the list before the server has heard about it, for the reason
    // `toggleSave` gives: the press is the thing that happened, and the
    // round trip — or whatever the server is busy with — is not the user's
    // wait to sit through. If the server refuses, the card comes back.
    const notice = hiddenNotice(row, card);
    if (card) card.replaceWith(notice);
    state.hiddenCount += 1;
    drawChrome();
    afterPrevious(row.id, () =>
      send(`/api/me/hidden/${encodeURIComponent(row.id)}`, 'PUT', {
        // The snapshot travels with the ×, and it is load-bearing: a hidden job
        // is absent from every search, so this is the only copy of its title
        // the "hidden" screen will ever have to draw.
        title: row.title,
        company: row.company ?? row.company_name,
        url: row.url,
      }),
    ).then(
      (result) => {
        state.hiddenCount = result.count;
        drawChrome();
      },
      (err) => {
        state.hiddenCount = Math.max(0, state.hiddenCount - 1);
        drawChrome();
        if (card && notice.isConnected) notice.replaceWith(card);
        alert(`Could not hide that: ${err.message}`);
      },
    );
  };
  return button;
}

/**
 * What stands in the list where a hidden job was.
 *
 * The card itself is kept, detached, and put back on Undo — rebuilding one here
 * would mean a second copy of `jobCard` in this file, and this way the restored
 * row comes back with its rank, its chips and its open/closed state intact.
 */
function hiddenNotice(row, card) {
  const notice = document.createElement('div');
  notice.className = 'job hidden-notice';

  const said = document.createElement('span');
  said.className = 'said';
  const name = document.createElement('b');
  name.textContent = row.title ?? 'That job';
  said.append('Hidden — ', name, ' will stay out of your searches.');

  const undo = document.createElement('button');
  undo.type = 'button';
  undo.className = 'btn ghost';
  undo.textContent = 'Undo';
  undo.onclick = (event) => {
    event.stopPropagation();
    notice.replaceWith(card);
    state.hiddenCount = Math.max(0, state.hiddenCount - 1);
    drawChrome();
    afterPrevious(row.id, () => request(`/api/me/hidden/${encodeURIComponent(row.id)}`, { method: 'DELETE' })).then(
      (result) => {
        state.hiddenCount = result.count;
        drawChrome();
      },
      (err) => {
        state.hiddenCount += 1;
        drawChrome();
        if (card.isConnected) card.replaceWith(notice);
        alert(`Could not bring that back: ${err.message}`);
      },
    );
  };

  notice.append(said, undo);
  return notice;
}

/**
 * Called for every result card. Adds a pill if you have acted on the job.
 *
 * The star says a job is saved; this says what you did about it afterwards, and
 * only when there is something to say. A row reading "saved" next to a filled
 * star would be the same fact printed twice, so `saved` draws no pill — but
 * *applied* on a job you are scrolling past for the second time is the one
 * thing you would want the list to tell you without being asked.
 */
function decorateCard(row, { meta }) {
  if (!state.enabled) return;
  const saved = state.saved.get(row.id);
  if (saved && saved.status !== 'saved' && meta) {
    const chip = document.createElement('span');
    chip.className = 'chip status';
    chip.dataset.status = saved.status;
    chip.textContent = labelFor(saved.status).toLowerCase();
    meta.append(chip);
  }
}

// ------------------------------------------------- the tracker, in a detail --

/**
 * The status / note / lists block, shown inside an opened job.
 *
 * Signed out it is a single line explaining what an account would add, rather
 * than a hidden feature: the honest version of an upsell is one sentence and a
 * button.
 */
function detailPanel(job) {
  if (!state.enabled) return null;
  const wrap = document.createElement('div');
  wrap.className = 'tracker';

  if (!state.user) {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Sign in to save this job, note that you applied, and keep your filters. ';
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'btn ghost';
    link.textContent = 'Sign in';
    link.onclick = () => goToAuth('signin');
    hint.append(link);
    wrap.append(hint);
    return wrap;
  }

  const row = { id: job.id, title: job.title, company: job.company_display ?? job.company_name, url: job.url };
  wrap.append(statusRow(row), noteBox(row), listRow(row));
  return wrap;
}

/**
 * The five-way status control. Picking any of them saves the job if it wasn't.
 *
 * Four of the five hold the job back from your searches — everything from
 * `applied` on, which is the same rule the ✓ on a card follows, because they
 * are the same fact written two ways. `saved` is the one that leaves it in.
 */
function statusRow(row) {
  const line = document.createElement('div');
  line.className = 'track-line';
  const label = document.createElement('span');
  label.className = 'track-label';
  label.textContent = 'Status';
  const seg = document.createElement('div');
  seg.className = 'seg';

  const current = state.saved.get(row.id)?.status ?? null;
  for (const { value, label: text } of state.statuses) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    button.dataset.status = value;
    if (current === value) button.classList.add('on');
    button.onclick = async (event) => {
      event.stopPropagation();
      await setStatus(row, value);
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.status === value));
      if (!$('saved-view').hidden) renderSaved();
    };
    seg.append(button);
  }
  line.append(label, seg);
  return line;
}

function noteBox(row) {
  const line = document.createElement('div');
  line.className = 'track-line';
  const label = document.createElement('span');
  label.className = 'track-label';
  label.textContent = 'Note';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'note';
  input.placeholder = 'for yourself — “referred by Dana”, “apply before Friday”';
  input.value = state.saved.get(row.id)?.note ?? '';
  input.onclick = (event) => event.stopPropagation();

  let timer = null;
  const write = async () => {
    const result = await send(`/api/me/saved/${encodeURIComponent(row.id)}`, 'PUT', {
      note: input.value,
      title: row.title,
      company: row.company,
      url: row.url,
    });
    state.saved.set(row.id, result.saved);
    state.counts = result.counts;
    drawChrome();
    document.querySelectorAll(`.star[data-job="${cssEscape(row.id)}"]`).forEach((el) => paintStar(el, row.id));
  };
  input.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(write, 700);
  };
  input.onblur = () => {
    clearTimeout(timer);
    void write();
  };
  line.append(label, input);
  return line;
}

/** List membership as toggle chips, plus a "+ list" that creates one. */
function listRow(row) {
  const line = document.createElement('div');
  line.className = 'track-line';
  const label = document.createElement('span');
  label.className = 'track-label';
  label.textContent = 'Lists';
  const chips = document.createElement('div');
  chips.className = 'chips';

  const draw = () => {
    const mine = new Set(state.membership[row.id] ?? []);
    chips.replaceChildren(
      ...state.lists.map((list) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `chip toggle${mine.has(list.id) ? ' on' : ''}`;
        chip.textContent = list.name;
        chip.onclick = async (event) => {
          event.stopPropagation();
          const path = `/api/me/lists/${list.id}/items/${encodeURIComponent(row.id)}`;
          const result = mine.has(list.id)
            ? await request(path, { method: 'DELETE' })
            : await send(path, 'PUT', { title: row.title, company: row.company, url: row.url });
          state.lists = result.lists;
          state.membership = result.membership;
          if (result.counts) state.counts = result.counts;
          if (!state.saved.has(row.id)) await refresh();
          else drawChrome();
          draw();
          document.querySelectorAll(`.star[data-job="${cssEscape(row.id)}"]`).forEach((el) => paintStar(el, row.id));
          if (!$('saved-view').hidden) renderSaved();
        };
        return chip;
      }),
    );
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'chip toggle new';
    add.textContent = '+ list';
    add.onclick = async (event) => {
      event.stopPropagation();
      const name = prompt('Name this list — “dream jobs”, “apply this week”:');
      if (!name) return;
      try {
        const created = await send('/api/me/lists', 'POST', { name });
        state.lists = created.lists;
        await send(`/api/me/lists/${created.list.id}/items/${encodeURIComponent(row.id)}`, 'PUT', {
          title: row.title,
          company: row.company,
          url: row.url,
        });
        await refresh();
        draw();
        // A new list is also a new tab in the saved view's scope bar; redraw it
        // or the list exists everywhere except where you would go looking.
        if (!$('saved-view').hidden) void renderSaved();
      } catch (err) {
        alert(err.message);
      }
    };
    chips.append(add);
  };

  draw();
  line.append(label, chips);
  return line;
}

// -------------------------------------------------------------- saved view --

function showSaved(on) {
  $('saved-view').hidden = !on;
  $('search-view').hidden = on;
  document.body.classList.toggle('viewing-saved', on);
  $('saved-toggle').classList.toggle('on', on);
  if (on) return void renderSaved();
  // Back to a list that was filtered by sets which no longer hold. A job
  // brought back — from Hidden, or off Applied — cannot re-insert itself into
  // results it was excluded from before they were counted, so the search runs
  // again, and only when something actually changed: the ordinary trip in and
  // out of the saved view costs nothing.
  if (state.excludeStale) {
    state.excludeStale = false;
    bridge.rerunSearch();
  }
}

/** Open the hidden list directly — from the results line that counts them. */
function openHidden() {
  if (!state.user) return goToAuth('signin');
  state.scope = { kind: 'hidden' };
  showSaved(true);
}

/** And the applied list, from the other count on that line. */
function openApplied() {
  if (!state.user) return goToAuth('signin');
  state.scope = { kind: 'status', value: 'applied' };
  showSaved(true);
}

async function renderSaved() {
  if (!state.user) return;
  if (state.scope.kind === 'hidden') return renderHidden();
  sectionTitle('Saved');
  const params = new URLSearchParams();
  if (state.scope.kind === 'status') params.set('status', state.scope.value);
  if (state.scope.kind === 'list') params.set('list', state.scope.value);
  const data = await request(`/api/me/saved?${params}`);
  // A scoped request returns a subset, so it merges into what is already known
  // rather than replacing it — an unfiltered one is the full set and can.
  if (state.scope.kind === 'all') state.saved = new Map();
  for (const row of data.saved) state.saved.set(row.job_id, row);
  state.counts = data.counts;
  state.lists = data.lists;
  state.membership = data.membership;
  drawChrome();
  drawScopes();

  const rows = data.saved;
  $('saved-sub').textContent = rows.length
    ? `${fmt(rows.length)} ${state.scope.kind === 'all' ? 'saved' : 'shown'} · ${describeScope()}`
    : '';
  drawSavedRows(rows);
}

function describeScope() {
  if (state.scope.kind === 'status') return labelFor(state.scope.value).toLowerCase();
  if (state.scope.kind === 'list') return state.lists.find((l) => l.id === state.scope.value)?.name ?? 'list';
  return 'everything you starred';
}

/** The one heading over both screens; the scope bar decides which it names. */
function sectionTitle(text) {
  const node = $('saved-title');
  if (node) node.textContent = text;
}

// ------------------------------------------------------------- hidden view --

/**
 * The jobs you pressed × on, and the way back from each.
 *
 * It shares the saved view's frame and scope bar rather than being a screen of
 * its own, because it answers a question of the same shape — *which jobs have I
 * already made my mind up about* — and because a second full-page view with its
 * own toggle in the header would put a permanent button up there for a list
 * most people open twice.
 *
 * Rows are drawn from the snapshot taken at hide time, hydrated against the
 * corpus where the job is still there. That is not an optimisation: a hidden
 * job is by construction missing from every search, so the snapshot is the only
 * copy of its title this screen can have.
 */
async function renderHidden() {
  sectionTitle('Hidden');
  const data = await request('/api/me/hidden');
  state.hiddenCount = data.count;
  drawChrome();
  drawScopes();

  const rows = data.hidden;
  $('saved-sub').textContent = rows.length
    ? `${fmt(rows.length)} hidden · kept out of every search until you bring them back`
    : '';
  drawHiddenRows(rows);
}

function drawHiddenRows(rows) {
  const host = $('saved-results');
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const strong = document.createElement('b');
    strong.textContent = 'Nothing hidden';
    empty.append(
      strong,
      'Press × on a job in the results to hide it. It leaves the list at once and stays out of every ' +
        'search you run from then on — and it lands here, so hiding one is never the last word on it.',
    );
    host.replaceChildren(empty);
    return;
  }

  host.replaceChildren(
    ...rows.map((hidden) => {
      const live = hidden.job;
      const card = document.createElement('div');
      card.className = 'job saved-job hidden-job';

      const gutter = document.createElement('div');
      gutter.className = 'rank';

      const main = document.createElement('div');
      const heading = document.createElement('h4');
      const href = live?.url ?? hidden.url;
      const title = live?.title ?? hidden.title ?? hidden.job_id;
      if (href) {
        const link = document.createElement('a');
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = title;
        heading.append(link);
      } else {
        heading.textContent = title;
      }
      const company = document.createElement('div');
      company.className = 'co';
      const coName = live?.company ?? hidden.company;
      if (coName) {
        const strong = document.createElement('b');
        strong.textContent = coName;
        company.append(strong);
      }
      if (live?.department) {
        const dept = document.createElement('span');
        dept.className = 'dept';
        dept.textContent = coName ? ` · ${live.department}` : live.department;
        company.append(dept);
      }
      main.append(heading, company);

      const meta = document.createElement('div');
      meta.className = 'meta';
      for (const text of savedChips(hidden, live)) {
        const chip = document.createElement('span');
        chip.className = 'chip soft';
        chip.textContent = text;
        meta.append(chip);
      }
      // The same three states the saved view names. A hidden job can be pulled
      // from the board like any other, and bringing that one back would put
      // nothing in your results — worth knowing before you press the button.
      if (live && !live.is_open) meta.append(warnChip('no longer listed'));
      else if (!live) meta.append(warnChip('not in this corpus'));
      main.append(meta);

      const side = document.createElement('div');
      side.className = 'score';
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'btn';
      restore.textContent = 'Bring back';
      restore.title = 'Show this job in searches again';
      restore.onclick = async () => {
        restore.disabled = true;
        try {
          await request(`/api/me/hidden/${encodeURIComponent(hidden.job_id)}`, { method: 'DELETE' });
          // The results behind this screen were counted without it. Say so to
          // `showSaved`, which re-runs the search on the way back.
          state.excludeStale = true;
          await renderHidden();
        } catch (err) {
          restore.disabled = false;
          alert(`Could not bring that back: ${err.message}`);
        }
      };
      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = `hidden ${stamp(hidden.hidden_at)}`;
      side.append(restore, when);

      card.append(gutter, main, side);
      return card;
    }),
  );
}

function drawScopes() {
  const host = $('saved-scopes');
  const pill = (text, count, active, onclick, extra) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `scope${active ? ' on' : ''}`;
    const name = document.createElement('span');
    name.textContent = text;
    button.append(name);
    if (count != null) {
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = fmt(count);
      button.append(n);
    }
    button.onclick = onclick;
    if (extra) button.append(extra);
    return button;
  };

  const nodes = [
    pill('All', state.counts.total, state.scope.kind === 'all', () => {
      state.scope = { kind: 'all' };
      void renderSaved();
    }),
    ...state.statuses.map(({ value, label, hides }) => {
      const node = pill(label, state.counts[value] ?? 0, state.scope.kind === 'status' && state.scope.value === value, () => {
        state.scope = { kind: 'status', value };
        void renderSaved();
      });
      // The tabs from Applied on are also where those jobs went. Said on the
      // tab, because the count is the first place someone looks for a job that
      // has stopped turning up in their results.
      if (hides) node.title = `Jobs you marked ${label.toLowerCase()} — kept out of your searches. Set one back to Saved to see it in results again.`;
      return node;
    }),
  ];

  for (const list of state.lists) {
    const remove = document.createElement('span');
    remove.className = 'x';
    remove.textContent = '×';
    remove.title = `Delete the list “${list.name}” — the jobs stay saved`;
    remove.onclick = async (event) => {
      event.stopPropagation();
      if (!confirm(`Delete the list “${list.name}”? The jobs in it stay saved.`)) return;
      await request(`/api/me/lists/${list.id}`, { method: 'DELETE' });
      if (state.scope.kind === 'list' && state.scope.value === list.id) state.scope = { kind: 'all' };
      await refresh();
      void renderSaved();
    };
    nodes.push(
      pill(
        list.name,
        list.count,
        state.scope.kind === 'list' && state.scope.value === list.id,
        () => {
          state.scope = { kind: 'list', value: list.id };
          void renderSaved();
        },
        remove,
      ),
    );
  }

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'scope new';
  add.textContent = '+ new list';
  add.onclick = async () => {
    const name = prompt('Name this list — “dream jobs”, “apply this week”:');
    if (!name) return;
    try {
      await send('/api/me/lists', 'POST', { name });
      await refresh();
      void renderSaved();
    } catch (err) {
      alert(err.message);
    }
  };
  nodes.push(add);

  // Last, and set apart. Everything to its left is a way of slicing the jobs
  // you kept; this is the other pile entirely — the ones you turned down — and
  // it belongs on this screen because both answer "what have I already decided
  // about", but it is not one more status.
  const hidden = pill('Hidden', state.hiddenCount, state.scope.kind === 'hidden', () => {
    state.scope = { kind: 'hidden' };
    void renderSaved();
  });
  hidden.classList.add('hid');
  hidden.title = 'Jobs you pressed × on — kept out of your searches until you bring them back';
  nodes.push(hidden);

  host.replaceChildren(...nodes);
}

function drawSavedRows(rows) {
  const host = $('saved-results');
  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const strong = document.createElement('b');
    strong.textContent = state.counts.total ? 'Nothing here yet' : 'No saved jobs yet';
    empty.append(
      strong,
      state.counts.total
        ? 'Nothing is filed under this one. Pick another tab above.'
        : 'Open a job in the results and set its status — Saved, or Applied if you already did — and it lands here.',
    );
    host.replaceChildren(empty);
    return;
  }

  host.replaceChildren(
    ...rows.map((saved) => {
      const live = saved.job;
      const card = document.createElement('div');
      card.className = 'job saved-job';

      const gutter = document.createElement('div');
      gutter.className = 'rank';
      const star = starFor({ id: saved.job_id, title: saved.title, company: saved.company, url: saved.url });
      if (star) gutter.append(star);

      const main = document.createElement('div');
      const heading = document.createElement('h4');
      const href = live?.url ?? saved.url;
      const title = live?.title ?? saved.title ?? saved.job_id;
      if (href) {
        const link = document.createElement('a');
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = title;
        heading.append(link);
      } else {
        heading.textContent = title;
      }
      const company = document.createElement('div');
      company.className = 'co';
      // Company and department are separate elements so the stylesheet can give
      // the company real weight and leave the department as the quiet half.
      const coName = live?.company ?? saved.company;
      const coDept = live?.department;
      if (coName) {
        const strong = document.createElement('b');
        strong.textContent = coName;
        company.append(strong);
      }
      if (coDept) {
        const dept = document.createElement('span');
        dept.className = 'dept';
        dept.textContent = coName ? ` · ${coDept}` : coDept;
        company.append(dept);
      }
      main.append(heading, company);

      const meta = document.createElement('div');
      meta.className = 'meta';
      for (const text of savedChips(saved, live)) {
        const chip = document.createElement('span');
        chip.className = 'chip soft';
        chip.textContent = text;
        meta.append(chip);
      }
      // The three states a saved job can be in, said plainly. "Did I ever apply
      // to this" has to keep answering after the posting is gone.
      if (live && !live.is_open) meta.append(warnChip('no longer listed'));
      else if (!live) meta.append(warnChip('not in this corpus'));
      main.append(meta);

      const row = { id: saved.job_id, title, company: live?.company ?? saved.company, url: href };
      const tracker = document.createElement('div');
      tracker.className = 'tracker';
      tracker.append(statusRow(row), noteBox(row), listRow(row));
      main.append(tracker);

      const side = document.createElement('div');
      side.className = 'score';
      const status = document.createElement('b');
      status.textContent = labelFor(saved.status);
      side.append(status, saved.applied_at ? `applied ${stamp(saved.applied_at)}` : `saved ${stamp(saved.saved_at)}`);

      card.append(gutter, main, side);
      return card;
    }),
  );
}

function warnChip(text) {
  const chip = document.createElement('span');
  chip.className = 'chip warn';
  chip.textContent = text;
  return chip;
}

function savedChips(saved, live) {
  const chips = [];
  if (live?.metros?.length) chips.push(live.metros.join(' / '));
  if (live?.workplace && live.workplace !== 'unknown') chips.push(live.workplace);
  if (live?.salary_label) chips.push(live.salary_label);
  if (live?.seniority && live.seniority !== 'unknown') chips.push(live.seniority);
  if (live?.age_days != null) chips.push(live.age_days <= 1 ? 'today' : `${live.age_days}d`);
  return chips;
}

// ------------------------------------------------------- profiles, by name --

/**
 * This account's saved filter documents, for the header's profile menu.
 *
 * They are the same JSON as the shared `profiles/*.json` files — an account
 * changes where a profile lives, never what a profile is.
 */
function profileOptions() {
  return state.profiles;
}

/** Save a named profile to the account. Returns false when signed out. */
async function save(name, profile) {
  if (!state.user) return false;
  const result = await send(`/api/me/profiles/${encodeURIComponent(name)}`, 'PUT', profile);
  state.profiles = result.profiles;
  bridge.onProfilesChanged();
  return true;
}

function load(name) {
  return request(`/api/me/profiles/${encodeURIComponent(name)}`);
}

// ------------------------------------------------------------------ shared --

function labelFor(status) {
  return state.statuses.find((s) => s.value === status)?.label ?? status;
}

const stamp = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '');

/**
 * Job ids are `<ats>:<slug>:<native id>` and go into a quoted attribute
 * selector, so the two characters that can end the quoted string are the two
 * that need escaping. `CSS.escape` is for bare identifiers and would mangle
 * this one.
 */
function cssEscape(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}
