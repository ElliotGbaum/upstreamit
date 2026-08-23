/**
 * Job Finder — the account screens.
 *
 * Sign in, create an account, change a password: three modes of one form, at
 * three addresses (`/signin`, `/signup`, `/password`), all rendering auth.html.
 *
 * They are a *screen* rather than a modal over the search page, and that is a
 * behavioural choice before it is a visual one. A screen has an address, which
 * is what an OAuth redirect needs to come back to and what an error needs to
 * land on; it can be linked, bookmarked and reloaded; and it has room to say
 * what an account is for next to the two fields that create one.
 *
 * The rule the rest of the app follows holds here too: **nothing is inserted as
 * HTML.** Every message on this page — including the ones the server writes —
 * is set with `textContent`.
 */

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n ?? 0).toLocaleString('en-US');

/**
 * Where a successful sign-in lands. Same-origin paths only: this value arrives
 * in the query string, so an unchecked `location.href = next` is an open
 * redirect with a sign-in form in front of it.
 */
function safeNext(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

const params = new URLSearchParams(location.search);
const next = safeNext(params.get('next'));

/** `/signup` → signup, `/password` → password, anything else → signin. */
function modeFromPath(path = location.pathname) {
  const clean = path.replace(/\/+$/, '');
  if (clean === '/signup') return 'signup';
  if (clean === '/password') return 'password';
  return 'signin';
}

const COPY = {
  signin: {
    title: 'Sign in · UpstreamIt',
    head: 'Welcome back',
    sub: 'Sign in to pick up your filters and your saved jobs.',
    submit: 'Sign in',
    switch: ['New here?', 'Create an account', 'signup'],
  },
  signup: {
    title: 'Create an account · UpstreamIt',
    head: 'Create an account',
    sub: "Store your filters and the jobs you're applying to",
    submit: 'Create account',
    switch: ['Already have one?', 'Sign in', 'signin'],
  },
  password: {
    title: 'Change your password · UpstreamIt',
    head: 'Change your password',
    sub: 'Every other session signs out when you do this.',
    submit: 'Change password',
  },
};

let mode = modeFromPath();
let user = null;
let googleOn = false;

// ------------------------------------------------------------------ chrome --

for (const tab of document.querySelectorAll('.tabs button')) {
  tab.onclick = () => setMode(tab.dataset.mode, { push: true });
}
// The tabs swap the form in place, so the browser's back button has to swap it
// back rather than reload a screen the person has already typed into.
addEventListener('popstate', () => setMode(modeFromPath()));

for (const peek of document.querySelectorAll('.peek')) {
  peek.onclick = () => {
    const input = $(peek.dataset.for);
    const shown = input.type === 'text';
    input.type = shown ? 'password' : 'text';
    peek.textContent = shown ? 'show' : 'hide';
    peek.setAttribute('aria-label', shown ? 'Show password' : 'Hide password');
    input.focus();
  };
}

// A password field that silently takes capitals is the oldest sign-in bug there
// is; the field can simply say so. Bound to this one field because that is
// where the warning is drawn — a notice under the wrong box explains nothing.
{
  const input = $('password');
  const check = (event) => {
    if (typeof event.getModifierState === 'function') $('caps').hidden = !event.getModifierState('CapsLock');
  };
  input.addEventListener('keyup', check);
  input.addEventListener('keydown', check);
  input.addEventListener('blur', () => {
    $('caps').hidden = true;
  });
}

$('password').addEventListener('input', () => {
  $('rule').classList.toggle('met', $('password').value.length >= 8);
  clearError('password');
});
$('email').addEventListener('input', () => clearError('email'));
$('confirm').addEventListener('input', () => clearError('confirm'));
$('current').addEventListener('input', () => clearError('current'));

$('google').onclick = () => {
  // A full navigation, not fetch: the OAuth handshake is a redirect chain
  // through accounts.google.com and back, which XHR cannot follow.
  location.href = '/api/auth/google/start';
};

// ------------------------------------------------------------------- modes --

function setMode(nextMode, { push = false, focus = true, keepMessages = false } = {}) {
  mode = nextMode;
  const copy = COPY[mode];
  const account = mode === 'password';

  document.title = copy.title;
  $('head').textContent = copy.head;
  $('sub').textContent = copy.sub;
  $('submit-label').textContent = copy.submit;

  $('tabs').hidden = account;
  $('tab-signin').setAttribute('aria-selected', String(mode === 'signin'));
  $('tab-signup').setAttribute('aria-selected', String(mode === 'signup'));

  $('f-email').hidden = account;
  $('f-current').hidden = !account || !user?.has_password;
  $('f-confirm').hidden = !account;
  $('l-password').textContent = account ? 'New password' : 'Password';
  $('password').autocomplete = mode === 'signin' ? 'current-password' : 'new-password';
  $('rule').hidden = mode === 'signin';
  $('rule').classList.toggle('met', $('password').value.length >= 8);

  // Google is an alternative to this form, not to a password change.
  $('google').hidden = account || !googleOn;
  $('or').hidden = account || !googleOn;
  // Nor is "browse without an account" an offer worth making to someone who is
  // signed in and standing on their own account settings.
  $('skip').parentElement.hidden = account;

  drawSwitch();
  drawPitch();
  // A redraw for late-arriving server facts must not wipe a message the person
  // is reading — the Google callback's error is on screen before boot returns.
  if (!keepMessages) {
    clearError();
    $('done').hidden = true;
  }

  if (push) {
    const query = location.search;
    history.pushState(null, '', (mode === 'signup' ? '/signup' : '/signin') + query);
  }

  if (!focus) return;
  const first = account ? ($('f-current').hidden ? $('password') : $('current')) : $('email');
  first.focus({ preventScroll: true });
}

/** The line under the button that offers the other mode. */
function drawSwitch() {
  const host = $('switch');
  host.replaceChildren();
  const copy = COPY[mode];
  if (!copy.switch) {
    const back = document.createElement('a');
    back.href = '/';
    back.textContent = '← Back to search';
    host.append(back);
    return;
  }
  const [lead, label, target] = copy.switch;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'link';
  button.textContent = label;
  button.onclick = () => setMode(target, { push: true });
  host.append(`${lead} `, button);
}

/** The headline on the left half, which follows the mode. */
function drawPitch() {
  const h = $('pitch-h');
  h.replaceChildren();
  const em = document.createElement('em');
  if (mode === 'signup') {
    em.textContent = 'once.';
    h.append('Build your search ', em);
  } else if (mode === 'password') {
    em.textContent = 'yours.';
    h.append('Keep the account ', em);
  } else {
    em.textContent = 'kept.';
    h.append('Your search, ', em);
  }
}

// ------------------------------------------------------------------ errors --

function clearError(field) {
  if (field) {
    $(`f-${field}`).classList.remove('bad');
    $(`e-${field}`).hidden = true;
    return;
  }
  for (const name of ['email', 'password', 'current', 'confirm']) {
    $(`f-${name}`).classList.remove('bad');
    $(`e-${name}`).hidden = true;
  }
  $('error').hidden = true;
}

function fieldError(field, message) {
  $(`f-${field}`).classList.add('bad');
  const box = $(`e-${field}`);
  box.textContent = message;
  box.hidden = false;
}

function formError(message) {
  const box = $('error');
  // The API's messages are written lowercase, for a log and for a CLI. In a
  // banner under a field they are a sentence, so they get a capital.
  box.textContent = message ? message.charAt(0).toUpperCase() + message.slice(1) : '';
  box.hidden = !message;
  if (message) box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ------------------------------------------------------------------- wire --

async function send(path, payload) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let body = {};
  try {
    body = await res.json();
  } catch {
    /* some errors have no body */
  }
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body;
}

// ------------------------------------------------------------------ submit --

$('form').onsubmit = async (event) => {
  event.preventDefault();
  clearError();
  if (!validate()) return;

  const submit = $('submit');
  submit.disabled = true;
  submit.classList.add('busy');
  try {
    if (mode === 'password') {
      await send('/api/auth/password', {
        current_password: $('current').value || null,
        new_password: $('password').value,
      });
      return finishPassword();
    }

    const email = $('email').value.trim();
    const password = $('password').value;
    if (mode === 'signup') {
      await send('/api/auth/signup', { email, password });
      await claimPendingProfile();
    } else {
      await send('/api/auth/login', { email, password });
    }
    // A full navigation rather than a fetch-and-stay: the app boots from
    // `/api/me`, so arriving at it fresh is how the account's filters, saved
    // jobs and counts all appear at once and in agreement.
    location.href = next;
  } catch (err) {
    formError(err.message);
    submit.disabled = false;
    submit.classList.remove('busy');
  }
};

function validate() {
  const password = $('password').value;

  if (mode !== 'password') {
    const email = $('email').value.trim();
    if (!email) return fail('email', 'Enter your email address.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('email', 'That does not look like an email address.');
  }
  if (mode === 'password' && !$('f-current').hidden && !$('current').value) {
    return fail('current', 'Enter your current password.');
  }
  if (!password) return fail('password', 'Enter a password.');
  if (mode !== 'signin' && password.length < 8) return fail('password', 'At least 8 characters.');
  if (mode === 'password' && $('confirm').value !== password) {
    return fail('confirm', 'The two passwords do not match.');
  }
  return true;
}

function fail(field, message) {
  fieldError(field, message);
  $(field).focus();
  return false;
}

/**
 * The filters someone built before they had an account.
 *
 * A new account has no remembered search, and the one on screen is the one the
 * person just spent time on — so the header stashes it on the way here and the
 * new account adopts it. It used to happen in place, because signing up used to
 * happen in place; the stash is what survives the navigation.
 */
async function claimPendingProfile() {
  let raw = null;
  try {
    raw = sessionStorage.getItem('jf.pending-profile');
    sessionStorage.removeItem('jf.pending-profile');
  } catch {
    return;
  }
  if (!raw) return;
  try {
    const profile = JSON.parse(raw);
    if (profile && Object.keys(profile).length) {
      await fetch('/api/me/prefs', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile }),
      });
    }
  } catch {
    /* a lost draft profile is not worth failing a sign-up over */
  }
}

function finishPassword() {
  const submit = $('submit');
  submit.disabled = true;
  submit.classList.remove('busy');
  $('form').reset();
  // `reset()` empties the fields; the requirement line is drawn from them and
  // has to be told, or it stays green over an empty box.
  $('rule').classList.remove('met');
  $('caps').hidden = true;
  $('done').textContent = 'Password changed. Every other session has been signed out.';
  $('done').hidden = false;
  const host = $('switch');
  host.replaceChildren();
  const back = document.createElement('a');
  back.href = '/';
  back.textContent = 'Back to search →';
  host.append(back);
}

// -------------------------------------------------------------------- boot --

// The form is live on the first tick, before anything has been asked of the
// server. Waiting on `/api/meta` to draw it would leave the tabs and the fields
// inert for as long as that round trip takes — a stretch during which the
// screen looks finished and is not, and anything typed into it is lost.
setMode(mode);

const callbackError = params.get('auth_error');
if (callbackError) {
  formError(`Google sign-in did not complete: ${callbackError}`);
  // Show it once. A reload should not replay a stale message.
  const clean = new URLSearchParams(location.search);
  clean.delete('auth_error');
  history.replaceState(null, '', location.pathname + (clean.toString() ? `?${clean}` : ''));
}

async function boot() {
  // The left half's numbers and whether Google is configured both come from the
  // same place the search page reads them from — served, never hardcoded.
  const [meta, who] = await Promise.all([
    fetch('/api/meta').then((r) => r.json()).catch(() => null),
    fetch('/api/auth/me').then((r) => r.json()).catch(() => null),
  ]);

  googleOn = Boolean(meta?.auth?.google ?? who?.google);
  user = who?.user ?? null;

  if (meta) {
    $('stat-jobs').textContent = fmt(meta.open);
    $('stat-boards').textContent = fmt(meta.boards_live);
    $('stat-swept').textContent = meta.last_sweep ? new Date(meta.last_sweep).toISOString().slice(0, 10) : '—';
    $('stats').hidden = false;
  }

  // A server built with `--no-accounts` has no sign-in to offer, and saying so
  // is better than a form whose every submission 404s.
  if (meta?.auth && !meta.auth.enabled) return unavailable();

  // Changing a password needs a session; signing in when you already have one
  // is a no-op you should not have to discover by filling the form in.
  if (mode === 'password' && !user) return void location.replace('/signin?next=%2Fpassword');
  if (mode !== 'password' && user) return void location.replace(next);

  // Redraw for what only the server knew: the Google button, and whether this
  // account has a password to confirm before it changes one. Never the focus —
  // by now the cursor may be three characters into a field.
  setMode(mode, { focus: false, keepMessages: true });
}

function unavailable() {
  $('tabs').hidden = true;
  $('form').hidden = true;
  $('google').hidden = true;
  $('or').hidden = true;
  $('head').textContent = 'Accounts are off on this server';
  $('sub').textContent =
    'It was started with --no-accounts. Every job, filter and count still works — there is just nothing to sign in to.';
  $('switch').replaceChildren();
  const back = document.createElement('a');
  back.href = '/';
  back.textContent = '← Back to search';
  $('switch').append(back);
}

void boot();
