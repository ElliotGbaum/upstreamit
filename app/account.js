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
};

/** Set by `init()`; how this module reaches the page's single `profile` object. */
let bridge = { getProfile: () => ({}), setProfile: () => {}, onProfilesChanged: () => {} };

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

export const account = { init, starFor, decorateCard, detailPanel, remember, profileOptions, save, load, isOn, signedIn };

function isOn() {
  return state.enabled;
}
function signedIn() {
  return Boolean(state.user);
}

async function init({ meta, who, getProfile, setProfile, onProfilesChanged }) {
  bridge = { getProfile, setProfile, onProfilesChanged };
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
  drawChrome();
  bridge.onProfilesChanged();
  showSaved(false);
  // Signing out has to take your marks off the page with it — a leftover
  // "applied" pill on a signed-out screen is someone else's business.
  document.querySelectorAll('.job .star, .job .chip.status').forEach((node) => node.remove());
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
  $('saved-toggle').onclick = () => showSaved($('saved-view').hidden);
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

// ------------------------------------------------------ the star on a card --

/**
 * The star, which is now the saved view's own control: it is how a row leaves
 * this list. It came off the result cards, where it sat in the rank gutter and
 * read as an ornament on the position number — see `decorateCard`.
 *
 * It still handles the signed-out case, because the saved view is reachable
 * before a session exists and a control that vanishes teaches nobody what an
 * account is for.
 */
function starFor(row) {
  if (!state.enabled) return null;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'star';
  paintStar(button, row.id);
  button.onclick = async (event) => {
    event.stopPropagation();
    if (!state.user) return goToAuth('signin');
    button.disabled = true;
    try {
      await toggleSave(row);
      document.querySelectorAll(`.star[data-job="${cssEscape(row.id)}"]`).forEach((el) => paintStar(el, row.id));
      if (!$('saved-view').hidden) renderSaved();
    } catch (err) {
      alert(`Could not save that: ${err.message}`);
    } finally {
      button.disabled = false;
    }
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
      ? 'Save this job'
      : 'Sign in to save jobs';
}

async function toggleSave(row) {
  const jobId = row.id;
  if (state.saved.has(jobId)) {
    const result = await request(`/api/me/saved/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
    state.saved.delete(jobId);
    state.counts = result.counts;
    state.membership = result.membership;
  } else {
    // The snapshot travels with the save so the row still reads correctly if
    // the posting is pulled from the board later.
    const result = await send(`/api/me/saved/${encodeURIComponent(jobId)}`, 'PUT', {
      title: row.title,
      company: row.company ?? row.company_name,
      url: row.url,
    });
    state.saved.set(jobId, result.saved);
    state.counts = result.counts;
  }
  drawChrome();
}

/**
 * Called for every result card. Adds a pill if you have acted on the job.
 *
 * No star here. It used to sit in the rank gutter beside the position number,
 * where `1☆ 2☆ 3☆` read as decoration on the number rather than as a control
 * of its own. Saving now lives one click in, on the status row inside an opened
 * job, next to the rest of what an account remembers about it; the star is
 * still the control in the saved view, where un-starring is the whole point.
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

/** The five-way status control. Picking any of them saves the job if it wasn't. */
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
      const result = await send(`/api/me/saved/${encodeURIComponent(row.id)}`, 'PUT', {
        status: value,
        title: row.title,
        company: row.company,
        url: row.url,
      });
      state.saved.set(row.id, result.saved);
      state.counts = result.counts;
      drawChrome();
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.status === value));
      document.querySelectorAll(`.star[data-job="${cssEscape(row.id)}"]`).forEach((el) => paintStar(el, row.id));
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
  if (on) void renderSaved();
}

async function renderSaved() {
  if (!state.user) return;
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
    ...state.statuses.map(({ value, label }) =>
      pill(label, state.counts[value] ?? 0, state.scope.kind === 'status' && state.scope.value === value, () => {
        state.scope = { kind: 'status', value };
        void renderSaved();
      }),
    ),
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
