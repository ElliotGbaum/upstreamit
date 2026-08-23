/**
 * "Describe your search" — the box at the top of the filter rail.
 *
 * Type or dictate a sentence, and the forty controls below it fill themselves
 * in. The server does the interpreting (`src/lib/interpret.mjs`); this file is
 * the box, the microphone, and — the part that matters most — what happens
 * after the answer arrives.
 *
 * **The answer is shown, never just applied.** Every criterion it set is listed
 * in the page's own words, anything it could not place is named out loud, and
 * Undo puts back exactly the filters that were there a second ago. That is the
 * whole difference between a feature you can trust with a search you spent ten
 * minutes on and one you have to check by hand afterwards — and it is why the
 * server returns a diff rather than just a profile.
 *
 * **Dictation is the browser's, not ours.** `SpeechRecognition` is built into
 * Chrome, Edge and Safari, so speaking costs nothing, needs no key and adds no
 * dependency. It is also, in Chrome, a round trip to Google's servers — which
 * is a surprising thing for a tool whose entire pitch is that it runs on your
 * laptop, so the hint under the button says so rather than leaving it implied.
 * The button is not drawn at all in a browser without the API.
 */

const $ = (id) => document.getElementById(id);

/** Chrome and Edge ship it prefixed; Safari 16+ and Firefox 133+ unprefixed. */
const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;

export function installAiBox({ meta, getProfile, setProfile }) {
  const card = $('ai-card');
  if (!card) return;

  // Switched off in the markup. Nothing to install — no listeners, no
  // microphone, and no setup-error message drawn into a card nobody can see.
  // Remove the `hidden` attribute in app/index.html to turn it back on.
  if (card.hidden) return;

  const box = $('ai-text');
  const go = $('ai-go');
  const mic = $('ai-mic');
  const out = $('ai-out');
  const note = $('ai-note');

  const ai = meta?.ai ?? {};

  /** Nobody can use it: leave the card, say why, and stop. */
  const shut = (message, { warn = false } = {}) => {
    box.disabled = true;
    go.hidden = true;
    mic.hidden = true;
    note.textContent = message;
    note.classList.toggle('warn-note', warn);
  };

  // No key configured. An operator's problem, not a visitor's, so it gets the
  // sentence that fixes it. A control that is present but silently dead is the
  // version that wastes somebody's afternoon.
  if (!ai.enabled) {
    shut(`Not set up yet — ${ai.setup ?? 'no API key configured'}.`, { warn: true });
    return;
  }

  // Configured, but not for whoever is reading. This is the one thing in the
  // app behind an account — it spends real money per press — so signed out the
  // card explains that and offers the way in, rather than failing on click. The
  // placeholder stays visible through the disabled box on purpose: what it does
  // is the reason to sign in, so it should be readable before you do.
  if (!ai.usable) {
    shut(ai.blocked ?? 'Sign in to use this.');
    // ...and the way in, but only where there is one. A server started with
    // `--no-accounts` has no sign-in screen, so offering the button there would
    // send somebody to a door that does not open — the message already says
    // that this one is the operator's decision and not theirs to fix.
    if (meta?.auth?.enabled) {
      const link = document.createElement('a');
      link.className = 'btn primary';
      link.href = '/signin';
      link.textContent = 'Sign in';
      link.title = 'Free, optional everywhere else in this app — and it keeps your filters and saved jobs';
      go.after(link);
    }
    return;
  }

  note.textContent = Recognition
    ? 'Type it or press Speak. Dictation is your browser’s — in Chrome that sends the audio to Google.'
    : 'Type it in plain language — a sentence is enough.';

  // The server refuses anything longer, so the box should not accept it either.
  if (ai.max_text) box.maxLength = ai.max_text;

  // ------------------------------------------------------------- dictation --

  if (!Recognition) {
    mic.hidden = true;
  } else {
    let listening = null;
    mic.onclick = () => {
      if (listening) {
        listening.stop();
        return;
      }
      const rec = new Recognition();
      rec.lang = navigator.language || 'en-US';
      // Continuous with interim results: someone describing a job search pauses
      // to think, and the default one-phrase-then-stop cuts them off mid-sentence.
      rec.continuous = true;
      rec.interimResults = true;

      // Where the committed text ends and the live guess begins. Without this
      // the interim words are appended and then appended again when they settle.
      const settled = box.value ? `${box.value.trim()} ` : '';

      rec.onresult = (event) => {
        let done = '';
        let saying = '';
        for (let i = 0; i < event.results.length; i++) {
          const result = event.results[i];
          if (result.isFinal) done += result[0].transcript;
          else saying += result[0].transcript;
        }
        box.value = (settled + done + saying).replace(/\s+/g, ' ').trimStart();
      };
      rec.onerror = (event) => {
        stop();
        // `no-speech` and `aborted` are someone changing their mind, not faults.
        if (event.error === 'no-speech' || event.error === 'aborted') return;
        note.textContent =
          event.error === 'not-allowed'
            ? 'The browser blocked the microphone — allow it for this page and press Speak again.'
            : `Dictation stopped: ${event.error}.`;
      };
      rec.onend = () => stop();

      const stop = () => {
        listening = null;
        mic.classList.remove('on');
        mic.textContent = '● Speak';
      };

      listening = rec;
      mic.classList.add('on');
      mic.textContent = '■ Stop';
      rec.start();
    };
  }

  // ---------------------------------------------------------------- submit --

  /** The filters as they were before the last interpretation. Null until there is one. */
  let previous = null;

  async function submit() {
    const text = box.value.trim();
    if (!text) {
      box.focus();
      return;
    }
    const before = structuredClone(getProfile());
    go.disabled = true;
    go.textContent = 'Reading…';
    out.replaceChildren(line('working', 'Working out what you mean…'));

    try {
      const res = await fetch('/api/interpret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, profile: before }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? res.statusText);

      previous = before;
      setProfile(data.profile);
      drawResult(data);
    } catch (err) {
      // Shown here and nowhere else. The page's warning banner is for a search
      // that failed; this failed before a search happened, and the person is
      // looking at the button they just pressed.
      out.replaceChildren(line('bad', err.message));
    } finally {
      go.disabled = false;
      go.textContent = 'Set my filters';
    }
  }

  go.onclick = submit;
  // Enter submits, shift-Enter is a newline — the convention every message box
  // on the internet has taught people, and this is a message box.
  box.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  });

  // ---------------------------------------------------------------- result --

  function drawResult(data) {
    const host = document.createElement('div');
    host.className = 'ai-result';

    if (data.summary) host.append(line('said', data.summary));

    // What it actually did, in the same words the chips and the panels use. A
    // summary is the model's account of itself; this is the engine's.
    const list = document.createElement('ul');
    list.className = 'ai-changes';
    for (const change of data.changes?.added ?? []) list.append(changeItem(change, 'add'));
    for (const change of data.changes?.removed ?? []) list.append(changeItem(change, 'del'));
    if (list.children.length) host.append(list);
    else host.append(line('quiet', 'Nothing changed — the filters already said that.'));

    for (const warning of data.warnings ?? []) host.append(line('warn', warning));
    for (const missed of data.not_understood ?? []) {
      host.append(line('quiet', `Couldn’t filter on that: ${missed}`));
    }

    if (previous) {
      const undo = document.createElement('button');
      undo.type = 'button';
      undo.className = 'btn ghost ai-undo';
      undo.textContent = '↩ Undo — put my filters back';
      undo.onclick = () => {
        setProfile(structuredClone(previous));
        previous = null;
        out.replaceChildren(line('quiet', 'Put back.'));
      };
      host.append(undo);
    }

    out.replaceChildren(host);
  }

  const line = (kind, text) => {
    const el = document.createElement('p');
    el.className = `ai-line ${kind}`;
    el.textContent = text;
    return el;
  };

  const changeItem = (text, kind) => {
    const el = document.createElement('li');
    el.className = kind;
    el.textContent = text;
    return el;
  };
}
