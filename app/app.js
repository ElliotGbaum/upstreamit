/**
 * Job Finder — the local app.
 *
 * The whole page is a view over one object: `profile`. Every control reads from
 * it and writes back to it, and any change re-posts it to `/api/search`. That
 * is deliberate and it is the constraint the project set for itself — the UI
 * has no criteria of its own, so anything expressible here is expressible in a
 * saved JSON profile and on the command line, and someone else's search is a
 * different document rather than a different build.
 *
 * The other rule: **every control carries a count**, and the count is
 * leave-one-out — how many jobs you would get if you also ticked this box, with
 * the rest of your filters still applied. With 61,213 jobs, a user who picks
 * four criteria blind and lands on zero results has no way to tell which one
 * was too narrow. The counts are what make it a tool instead of a guessing game.
 */

import { account } from './account.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n ?? 0).toLocaleString('en-US');

/** Everything the server told us about the corpus. Populated once at boot. */
let meta = null;
/** The live filter document. The single source of truth for the whole page. */
let profile = {};
/** The most recent search response, kept so re-renders don't need a round trip. */
let last = null;
let openJobId = null;
/** Which card has its ranking breakdown open. Independent of `openJobId`. */
let openWhyId = null;
let searchToken = 0;
/**
 * How many rows a page of results holds — the first draw and every "load more"
 * after it. The list is paged rather than whole because the ranking is the
 * point: the top of a 3,000-row match set is the answer, and the tail is there
 * for whoever disagrees with the ranking.
 */
const PAGE = 200;

// ---------------------------------------------------------------- plumbing --

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = (await res.json()).error ?? message;
    } catch {
      /* not JSON */
    }
    throw new Error(message);
  }
  return res.json();
}

/**
 * Debounced search. Typing in a keyword box should not fire a query per
 * keystroke, but ticking a checkbox should feel immediate — so the delay is
 * short and the response is discarded if a newer one has been issued.
 */
let searchTimer = null;
function runSearch({ delay = 140 } = {}) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const token = ++searchToken;
    $('loading').classList.add('on');
    try {
      const body = { profile, limit: PAGE };
      const since = $('since').value;
      if (since) body.since = since;
      const result = await api('/api/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (token !== searchToken) return; // a newer query already answered
      last = result;
      render();
      // Signed in, the filters on screen are remembered here — one debounced
      // write per settled change, so coming back tomorrow opens on this search
      // rather than on a blank one. A no-op for everyone else.
      account.remember(profile);
    } catch (err) {
      showWarnings([`search failed: ${err.message}`]);
    } finally {
      if (token === searchToken) $('loading').classList.remove('on');
    }
  }, delay);
}

// ------------------------------------------------------------------- chips --

/**
 * A list-of-strings control. Enter or comma commits, the × removes.
 * Used for every free-text list in the profile, so they all behave the same.
 */
function chipList(inputId, chipsId, field, { negative = false } = {}) {
  const input = $(inputId);
  const wrap = $(chipsId);

  const draw = () => {
    const values = profile[field] ?? [];
    wrap.replaceChildren(
      ...values.map((value) => {
        const chip = document.createElement('span');
        chip.className = `chip${negative ? ' neg' : ''}`;
        chip.append(value);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.title = `remove ${value}`;
        remove.textContent = '×';
        remove.onclick = () => {
          profile[field] = profile[field].filter((v) => v !== value);
          draw();
          syncBadges();
          runSearch({ delay: 0 });
        };
        chip.append(remove);
        return chip;
      }),
    );
  };

  const commit = () => {
    const parts = input.value.split(',').map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return;
    const set = new Set(profile[field] ?? []);
    for (const part of parts) set.add(part);
    profile[field] = [...set];
    input.value = '';
    draw();
    syncBadges();
    runSearch({ delay: 0 });
  };

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Backspace' && !input.value && profile[field]?.length) {
      profile[field] = profile[field].slice(0, -1);
      draw();
      syncBadges();
      runSearch({ delay: 0 });
    }
  });
  input.addEventListener('blur', commit);

  return draw;
}

// ------------------------------------------------------------ option lists --

/**
 * A facet control: checkboxes with live counts.
 *
 * `values` is the full universe of options; `counts` comes from the last search
 * and is leave-one-out. An option with no count is still drawn (dimmed) when it
 * is selected or when the universe is short — vanishing options make a filter
 * feel broken, and "Boston (0)" is a more useful answer than no Boston at all.
 */
function optionList(containerId, field, { search: searchId = null, universe = null, cap = 40, ordered = false, selectAll = false } = {}) {
  const container = $(containerId);
  const searchInput = searchId ? $(searchId) : null;
  // Typing in the search box re-draws from the *last* facet rather than from
  // nothing. Redrawing with an empty facet would blank every count — and, for
  // the lists whose options come only from the facet, blank the list itself.
  let lastFacet = [];
  if (searchInput) searchInput.addEventListener('input', () => draw(lastFacet));

  function draw(facet = []) {
    lastFacet = facet;
    const selected = new Set(profile[field] ?? []);
    const counts = new Map(facet.map((row) => [row.value, row]));

    let rows;
    if (universe) {
      rows = universe().map((option) => ({
        value: option.value,
        label: option.label ?? option.value,
        count: counts.get(option.value)?.count ?? 0,
      }));
    } else {
      rows = facet.map((row) => ({
        value: row.value,
        label: row.label ?? row.value,
        count: row.count,
      }));
    }
    // Selected first, then by count. A ticked box must never scroll out of view
    // just because ticking it shrank its own count.
    //
    // Unless the list has an order of its own. Company sizes sorted by count
    // read `21–100 · 6–20 · 101–500 · 2–5 · 500+ · 1` — a list of sizes in no
    // size order, which looks like a bug rather than a ranking. Degrees, pay
    // periods and remote reach are the same: short, fixed lists where the
    // sequence is part of the meaning, and short enough that nothing a user
    // ticks can scroll away.
    if (!ordered) {
      rows.sort(
        (a, b) => Number(selected.has(b.value)) - Number(selected.has(a.value)) || b.count - a.count,
      );
    }

    const needle = searchInput?.value.trim().toLowerCase();
    if (needle) rows = rows.filter((r) => String(r.label).toLowerCase().includes(needle) || String(r.value).toLowerCase().includes(needle));

    const shown = rows.slice(0, cap);
    const hidden = rows.length - shown.length;

    // Ticking every box by hand is fine for two options and absurd for sixty,
    // so the short fixed lists get one box that does it. It is deliberately
    // *not* a shortcut for "no filter": an empty field already means every
    // board, and this writes the boards out by name, which is what a saved
    // profile has to say if it is to keep meaning the same thing after a new
    // ATS is swept. Kept in sync by hand rather than by redrawing, because a
    // redraw would take the focus off the box you just clicked.
    let allBox = null;
    const refreshAll = () => {
      if (!allBox) return;
      const on = new Set(profile[field] ?? []);
      const hit = shown.filter((row) => on.has(row.value)).length;
      allBox.checked = shown.length > 0 && hit === shown.length;
      allBox.indeterminate = hit > 0 && hit < shown.length;
    };

    container.replaceChildren(
      ...shown.map((row) => {
        const label = document.createElement('label');
        label.className = `opt${row.count ? '' : ' zero'}${selected.has(row.value) ? ' on' : ''}`;

        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = selected.has(row.value);
        box.onchange = () => {
          const next = new Set(profile[field] ?? []);
          box.checked ? next.add(row.value) : next.delete(row.value);
          profile[field] = [...next];
          refreshAll();
          syncBadges();
          runSearch({ delay: 0 });
        };
        const text = document.createElement('span');
        text.className = 'lbl';
        text.textContent = row.label;
        text.title = row.value;
        const count = document.createElement('span');
        count.className = 'n';
        count.textContent = fmt(row.count);
        label.append(box, text, count);
        return label;
      }),
    );
    if (selectAll && shown.length > 1) {
      const label = document.createElement('label');
      label.className = 'opt all';
      allBox = document.createElement('input');
      allBox.type = 'checkbox';
      allBox.onchange = () => {
        const next = new Set(profile[field] ?? []);
        for (const row of shown) (allBox.checked ? next.add(row.value) : next.delete(row.value));
        profile[field] = [...next];
        allBox.indeterminate = false;
        for (const box of container.querySelectorAll('.opt:not(.all) input[type=checkbox]')) {
          box.checked = allBox.checked;
        }
        for (const opt of container.querySelectorAll('.opt:not(.all)')) {
          opt.classList.toggle('on', allBox.checked);
        }
        syncBadges();
        runSearch({ delay: 0 });
      };
      const text = document.createElement('span');
      text.className = 'lbl';
      text.textContent = typeof selectAll === 'string' ? selectAll : 'Select all';
      label.append(allBox, text);
      container.prepend(label);
      refreshAll();
    }
    if (hidden > 0) {
      const more = document.createElement('div');
      more.className = 'more';
      more.textContent = searchInput
        ? `…${fmt(hidden)} more — type above to find one`
        : `…${fmt(hidden)} more, all smaller than these`;
      container.append(more);
    }
  }

  return draw;
}

// ---------------------------------------------------------------- rendering --

const drawTitleChips = chipList('title-input', 'title-chips', 'title_keywords');
const drawDescChips = chipList('desc-input', 'desc-chips', 'description_keywords');
const drawExTitleChips = chipList('extitle-input', 'extitle-chips', 'exclude_title_keywords', { negative: true });
const drawExDescChips = chipList('exdesc-input', 'exdesc-chips', 'exclude_description_keywords', { negative: true });
const drawExSkillChips = chipList('exskill-input', 'exskill-chips', 'exclude_skills', { negative: true });

// Labels come from the adapter registry rather than the raw column, so the
// panel reads "Ashby / Greenhouse" and not "ashby / greenhouse". The universe is
// whatever `corpusMeta.ats` reports — an ATS with no swept jobs draws no row.
const ATS_LABELS = { ashby: 'Ashby', greenhouse: 'Greenhouse', lever: 'Lever' };
const atsLabel = (id) => ATS_LABELS[id] ?? id;
const drawAts = optionList('ats-options', 'ats', {
  selectAll: 'All boards',
  universe: () => (meta?.ats ?? []).map((row) => ({ value: row.value, label: atsLabel(row.value) })),
});

const drawMetros = optionList('metro-options', 'metros', { search: 'metro-search', cap: 60 });
// Countries sit under the same criterion as metros and share its leave-one-out
// counts. A profile can ask for either or both, and without this control the UI
// would express less than a saved profile can — the one thing the design does
// not allow. No search box of its own: there are ~100 of them and the list is
// capped by count, so the top 20 is already the useful part.
const drawCountries = optionList('country-options', 'countries', { cap: 20 });
const drawWorkplace = optionList('workplace-options', 'workplace', {
  universe: () => ['onsite', 'hybrid', 'remote'].map((v) => ({ value: v, label: v })),
});
// `unknown` is deliberately not in this universe, for the same reason it is not
// in `workplace`'s above: it is not a band anyone can ask for, it is the absence
// of both signals. A tick-box for it would be a filter ruling jobs out on a
// blank field — and it never even worked, since `matchExperience` answers
// UNKNOWN for those jobs before it consults the allow-list, and `readProfile`
// strips `unknown` out of `seniority` on the way in. What governs them is the
// `experience` unknown policy, which keeps them. The count still matters, so it
// is printed under the list as a caption rather than offered as a control.
const drawSeniorityOptions = optionList('seniority-options', 'seniority', {
  universe: () =>
    ['intern', 'entry', 'junior', 'mid', 'senior', 'staff', 'principal', 'manager', 'director', 'executive'].map(
      (v) => ({ value: v, label: v }),
    ),
});

function drawSeniority(facet = []) {
  drawSeniorityOptions(facet);
  const note = $('seniority-unknown');
  if (!note) return;
  const n = facet.find((row) => row.value === 'unknown')?.count ?? 0;
  note.textContent = n
    ? `${fmt(n)} state no band and no years. Nothing here can rule them out — see “When a posting doesn't say”.`
    : '';
}
const drawEmployment = optionList('employment-options', 'employment_type');
const drawJobFunction = optionList('function-options', 'job_functions', { cap: 30 });
const drawSkills = optionList('skill-options', 'skills', { search: 'skill-search', cap: 60 });

// Only remote postings carry a reach, so the universe comes from the schema
// rather than from the facet — `timezone` has never once occurred in the corpus
// and an option that only exists when a job already has it can never be the
// thing you notice is missing.
const drawRemoteScope = optionList('remote-scope-options', 'remote_scope', {
  ordered: true,
  universe: () => (meta?.remote_scopes ?? []).map((v) => ({ value: v, label: REMOTE_SCOPE_LABELS[v] ?? v })),
});
const drawPayPeriod = optionList('pay-period-options', 'pay_period', {
  ordered: true,
  universe: () => (meta?.pay_periods ?? []).map((v) => ({ value: v, label: PAY_PERIOD_LABELS[v] ?? v })),
});
// No universe: the corpus carries 40-odd currencies today and grows one every
// time a board in a new country is swept, so the list is whatever came back.
const drawCurrency = optionList('currency-options', 'currencies', { cap: 20 });
// The allow-list, picked by name off the result set rather than typed as a
// slug. `companies` accepts either, so a profile written by hand still loads.
const drawCompanies = optionList('company-options', 'companies', { search: 'company-search', cap: 60 });
const drawCompanySize = optionList('company-size-options', 'company_size', {
  ordered: true,
  universe: () => meta?.company_sizes ?? [],
});
const drawDegree = optionList('degree-options', 'degree', {
  ordered: true,
  universe: () => DEGREE_LEVELS.map((d) => ({ value: d.value, label: d.label })),
});

/** How the schema spells them, and how a person says them. */
const PAY_PERIOD_LABELS = {
  YEAR: 'per year', HALF_YEAR: 'per half-year', MONTH: 'per month', WEEK: 'per week',
  DAY: 'per day', HOUR: 'per hour', NONE: 'no interval given',
};
const REMOTE_SCOPE_LABELS = {
  worldwide: 'anywhere in the world', country: 'within one country',
  region: 'within one region', timezone: 'within a timezone band',
};
const DEGREE_LEVELS = [
  { value: 'none', label: 'says no degree needed' },
  { value: 'bachelors', label: "bachelor's" },
  { value: 'masters', label: "master's" },
  { value: 'phd', label: 'doctorate' },
];

/** The caps the panel offers as one click. Any other number is typed. */
const AGE_PRESETS = [
  ['≤7 days', 7],
  ['≤30 days', 30],
  ['≤90 days', 90],
  ['≤180 days', 180],
];
const AGE_PRESET_LABELS = new Set(['any age', ...AGE_PRESETS.map(([label]) => label)]);
// Mirrors `ageBandLabel` in the engine: it is how the row the server counted
// for this cap is found again, and `unknown` — the undated jobs, which are not
// a cap anyone can pick — must not be mistaken for it.
const ageLabel = (days) => `≤${days} day${days === 1 ? '' : 's'}`;

/**
 * Date posted: four preset caps, and a row you type your own into.
 *
 * `posted_within_days` is a number, not a choice of four, and a profile written
 * by hand has always been free to say 45 — so without this row the panel could
 * express less than the file it edits, and a 45 loaded from disk had to light
 * up one of the presets, which said something the filter was not doing.
 *
 * Two details the shape of this function comes from. The custom row is markup
 * in the page rather than something drawn here, and the presets are inserted
 * *before* it, because the search fires 300 ms into typing and a row rebuilt
 * under the cursor takes the focus with it. And its count is left blank until
 * the server has counted that band — the facets in hand are from the previous
 * cap, so the only honest thing to show for a number typed a moment ago is
 * nothing.
 */
function drawAges(rows, current) {
  const container = $('age-options');
  const customRow = $('age-custom');
  const input = $('age-days');

  for (const row of [...container.children]) if (row !== customRow) row.remove();
  container.prepend(
    ...rows
      .filter((row) => AGE_PRESET_LABELS.has(row.value))
      .map((row) => {
        const label = document.createElement('label');
        const on = row.value === current;
        label.className = `opt${row.count ? '' : ' zero'}${on ? ' on' : ''}`;
        const box = document.createElement('input');
        box.type = 'radio';
        box.name = 'age-options';
        box.checked = on;
        box.onchange = () => setPostedDays(AGE_PRESETS.find(([name]) => name === row.value)?.[1] ?? null);
        const text = document.createElement('span');
        text.className = 'lbl';
        text.textContent = row.value;
        const count = document.createElement('span');
        count.className = 'n';
        count.textContent = fmt(row.count);
        label.append(box, text, count);
        return label;
      }),
  );

  const days = customAgeDays();
  const counted = days == null ? null : rows.find((row) => row.value === ageLabel(days));
  customRow.className = `opt${counted && !counted.count ? ' zero' : ''}${days == null ? '' : ' on'}`;
  $('age-custom-radio').checked = days != null;
  $('age-custom-count').textContent = counted ? fmt(counted.count) : '';
  // Never overwrite the box someone is mid-number in: the redraw arrives while
  // they are still typing, and `45` on its way to `450` would be pushed back.
  if (document.activeElement !== input) input.value = days ?? '';
}

/** Apply a cap and search, from either half of the control. */
function setPostedDays(days, { delay = 0 } = {}) {
  profile.posted_within_days = days;
  syncBadges();
  drawAges(last?.facets?.age_band ?? [], currentAgeBand());
  runSearch({ delay });
}

/**
 * Salary is shown as a distribution, not as clickable bands.
 *
 * The bands are disjoint ranges (`$120–160k`) while the criterion is a floor
 * (`>= $120k`), so a band that filtered would mean something different from
 * what its own label says. The number inputs above are the control; this is the
 * readout that tells you what a floor would cost — including the 62.8% with no
 * figure at all, which is the number that actually decides whether to set one.
 */
function drawSalaryBands(rows) {
  const container = $('salary-options');
  container.replaceChildren(
    ...rows.map((row) => {
      const line = document.createElement('div');
      line.className = `opt${row.count ? '' : ' zero'}`;
      line.style.cursor = 'default';
      const text = document.createElement('span');
      text.className = 'lbl';
      text.textContent = row.value === 'unknown' ? 'no figure published' : row.value;
      const count = document.createElement('span');
      count.className = 'n';
      count.textContent = fmt(row.count);
      line.append(text, count);
      return line;
    }),
  );
}

/**
 * A checkbox that is its own one-row option list: label on the left, the count
 * it is worth on the right.
 *
 * Four of the controls on this page are a single boolean rather than a choice
 * from a list — equity, pay-as-published, the two visa flags, clearance — and
 * every one of them still owes the reader a number. Without it "drop roles
 * needing a security clearance" is a leap of faith; with it, it is 896.
 */
function drawToggle(boxId, countId, on, count) {
  const box = $(boxId);
  if (!box) return;
  box.checked = Boolean(on);
  box.closest('.opt')?.classList.toggle('on', Boolean(on));
  box.closest('.opt')?.classList.toggle('zero', !count);
  const cell = $(countId);
  if (cell) cell.textContent = count == null ? '' : fmt(count);
}

/** One facet row's count by value, 0 when this search returned none of them. */
const facetCount = (rows, value) => rows?.find((r) => r.value === value)?.count ?? 0;

/**
 * The unknown-answer panel — the one control on this page with no equivalent
 * anywhere in the sixty-board survey.
 *
 * Eleven criteria, each with a measured silent share and a choice about it. The
 * closest anything else gets is a single checkbox on a single criterion:
 * Adzuna's `salary_include_unknown`, Glassdoor's `includeNoSalaryJobs`,
 * Himalayas' "Include jobs without salary". Wellfound has two. We have eleven,
 * and the cost of each choice is printed beside it.
 *
 * **`separate` is not offered here, only honoured.** It routes jobs into a
 * second "worth a look" list, and this page draws one result list — so a policy
 * the page cannot render must not be a policy the page can set. A profile
 * loaded from disk with `separate` on it shows the button, lit, so the state is
 * visible and can be moved off; it just cannot be arrived at from here.
 */
const POLICY_LABELS = { include: 'keep', exclude: 'drop', separate: 'set aside' };
const POLICY_TITLES = {
  include: 'Silent postings stay in the results. The default, on every criterion.',
  exclude: 'Silent postings are filtered out — a filter ruling jobs out on a blank field.',
  separate: 'Routes them to a second list this page does not draw. Set in a saved profile, not here.',
};

function drawUnknownPolicies() {
  const host = $('unknown-policies');
  if (!host) return;
  const policies = profile.unknowns ?? {};
  host.replaceChildren(
    ...(meta?.unknowns ?? []).map((u) => {
      const current = policies[u.key] ?? u.default ?? 'include';
      const row = document.createElement('div');
      row.className = `policy${current === 'include' ? '' : ' changed'}`;

      const key = document.createElement('div');
      key.className = 'k';
      key.textContent = u.label;

      const share = document.createElement('div');
      share.className = 'share';
      share.textContent = `${(u.share * 100).toFixed(1)}%`;
      share.title = `${u.detail} — measured across the whole corpus`;

      const seg = document.createElement('div');
      seg.className = 'seg';
      const choices = current === 'separate' ? ['include', 'exclude', 'separate'] : ['include', 'exclude'];
      for (const value of choices) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = POLICY_LABELS[value];
        button.title = POLICY_TITLES[value];
        if (current === value) button.className = 'on';
        button.onclick = () => {
          profile.unknowns = { ...policies, [u.key]: value };
          drawUnknownPolicies();
          syncBadges();
          runSearch({ delay: 0 });
        };
        seg.append(button);
      }

      const note = document.createElement('div');
      note.className = 'note-line';
      note.textContent = u.detail;

      row.append(key, share, seg, note);
      return row;
    }),
  );
}

/** How many criteria are set to something other than what the engine defaults to. */
function changedPolicies() {
  const policies = profile.unknowns ?? {};
  return (meta?.unknowns ?? []).filter((u) => (policies[u.key] ?? u.default) !== (u.default ?? 'include')).length;
}

/**
 * Redraw every facet control from the last search.
 *
 * Split out of `render` because clearing a panel has to un-tick its boxes on
 * the click, not when the round trip comes back — a checkbox that stays lit
 * after you cleared the panel reads as a button that did not work.
 */
function drawFacets() {
  const facets = last?.facets ?? {};
  drawAts(facets.ats ?? []);
  drawMetros(facets.metro ?? []);
  drawCountries(facets.country ?? []);
  drawWorkplace(facets.workplace ?? []);
  drawSeniority(facets.seniority ?? []);
  drawEmployment(facets.employment_type ?? []);
  drawJobFunction(facets.job_function ?? []);
  drawSkills(facets.skill ?? []);
  drawAges(facets.age_band ?? [], currentAgeBand());
  drawSalaryBands(facets.salary_band ?? []);
  drawRemoteScope(facets.remote_scope ?? []);
  drawPayPeriod(facets.pay_period ?? []);
  drawCurrency(facets.currency ?? []);
  drawCompanies(facets.company ?? []);
  drawCompanySize(facets.company_size ?? []);
  drawDegree(facets.degree ?? []);

  drawToggle('requires-equity', 'equity-count', profile.requires_equity, facetCount(facets.equity, 'yes'));
  drawToggle('salary-stated', 'stated-count', profile.salary_stated_only, facetCount(facets.salary_source, 'as-stated'));
  drawToggle('visa-sponsors', 'visa-sponsors-count', profile.requires_visa_sponsorship, facetCount(facets.visa, 'sponsors'));
  drawToggle('visa-no-refusal', 'visa-refusal-count', profile.exclude_visa_refusal, facetCount(facets.visa, 'will not sponsor'));
  drawToggle('exclude-clearance', 'clearance-count', profile.exclude_clearance, facetCount(facets.clearance, 'requires clearance'));

  drawUnknownPolicies();
  $('metro-count').textContent = fmt(meta?.metros.length ?? 0);
}

function render() {
  if (!last) return;
  drawFunnel(last.funnel, last.since);
  showWarnings(last.warnings);

  drawFacets();

  drawResultsSub();
  drawJobs($('results'), last.results, 'Nothing matches yet', 'Loosen a criterion — the counts beside each control say how many jobs it would add back.');
  drawMore();

  $('footer').textContent =
    `${fmt(meta?.open)} open jobs from ${fmt(meta?.boards_live)} live boards · ` +
    `swept ${stamp(meta?.last_sweep)} · derived ${stamp(meta?.last_derive)} · ` +
    `filters read derived columns only, so improving a rule is a re-derive, never a re-sweep`;
  syncBadges();
}

/**
 * The line above the results, and the one place the icon gets explained.
 *
 * A hint printed once at the top of a list of 200 costs one line; the same hint
 * as a visible label on every row costs 200 and reads as clutter, which is what
 * the word `why?` on every card turned out to be.
 */
function drawResultsSub() {
  const sub = $('results-sub');
  // The fold is named, never silent. A count that drops from 453 to 291 with no
  // explanation is indistinguishable from a filter that went wrong.
  const folded = last.funnel?.folded
    ? ` · ${fmt(last.funnel.folded)} duplicate posting${last.funnel.folded === 1 ? '' : 's'} folded in`
    : '';
  sub.replaceChildren(
    `${fmt(last.total)} matching · showing ${fmt(last.results.length)} · ${last.stats.ms} ms${folded}`,
  );
  if (!last.results.length) return;
  const hint = document.createElement('span');
  hint.className = 'sub-hint';
  const glyph = document.createElement('span');
  glyph.className = 'why-i';
  glyph.textContent = 'i';
  hint.append(' · ', glyph, ' on a row says why it ranks there');
  sub.append(hint);
}

/**
 * The foot of the list: how many matches are still below it, and the button
 * that asks for the next page. Nothing at all once the list is whole.
 */
function drawMore() {
  const host = $('results-more');
  const remaining = (last?.total ?? 0) - (last?.results.length ?? 0);
  if (remaining <= 0) return host.replaceChildren();

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn';
  button.textContent = remaining > PAGE ? `Load ${fmt(PAGE)} more` : `Load the last ${fmt(remaining)}`;
  button.onclick = () => void loadMore(button);

  host.replaceChildren(button);
  // How many are left, but only when the button has not already said so.
  if (remaining > PAGE) {
    const note = document.createElement('span');
    note.className = 'more-note';
    note.textContent = `${fmt(remaining)} more below this page`;
    host.append(note);
  }
}

/**
 * The next page. It appends rather than re-renders, so the card you have open
 * and the place you had scrolled to survive it, and it asks the server to skip
 * the facet counts — those describe the whole match set, not this slice, and
 * they are the expensive half of a search.
 */
async function loadMore(button) {
  const token = searchToken; // a filter change while this is in flight voids it
  const start = last.results.length;
  button.disabled = true;
  button.textContent = 'Loading…';
  try {
    const body = { profile, limit: PAGE, offset: start, facets: false };
    const since = $('since').value;
    if (since) body.since = since;
    const page = await api('/api/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (token !== searchToken) return; // a newer search already redrew the list

    last.results.push(...page.results);
    last.total = page.total;
    $('results').append(...page.results.map((row, i) => jobCard(row, start + i)));
    drawResultsSub();
    drawMore();

    // The offset counts into a list the server re-ranks per request, so a sweep
    // that landed between the two pages would quietly shift the rows under it.
    // Say so rather than paste on a page that no longer lines up.
    if (page.stats.generation !== last.stats.generation) {
      showWarnings([
        ...(last.warnings ?? []),
        'the corpus was refreshed while you were reading — re-run the search for an exact list',
      ]);
    }
  } catch (err) {
    showWarnings([`could not load more: ${err.message}`]);
    drawMore();
  }
}

/** The preset in force, `any age` for no cap, or null when the cap is theirs. */
function currentAgeBand() {
  const days = profile.posted_within_days;
  if (days == null) return 'any age';
  return AGE_PRESETS.find(([, max]) => max === days)?.[0] ?? null;
}

/** The cap in the box: whatever is set, unless a preset already owns it. */
function customAgeDays() {
  return currentAgeBand() === null ? profile.posted_within_days : null;
}

function drawFunnel(funnel, since) {
  const steps = [
    ['open jobs', funnel.open_jobs, ''],
    ...(since ? [[`first seen ${since.from} +`, funnel.considered, '']] : []),
    ['matched', funnel.matched, 'hit'],
  ];
  $('funnel').replaceChildren(
    ...steps.map(([label, value, cls]) => {
      const step = document.createElement('div');
      step.className = `step ${cls}`;
      step.innerHTML = `<div class="v">${fmt(value)}</div><div class="l"></div>`;
      step.querySelector('.l').textContent = label;
      return step;
    }),
  );
}

function showWarnings(warnings = []) {
  $('warnings').replaceChildren(
    ...warnings.map((text) => {
      const div = document.createElement('div');
      div.className = 'notice';
      div.textContent = text;
      return div;
    }),
  );
}

function drawJobs(host, rows, emptyTitle, emptyBody) {
  if (!rows.length) {
    if (!emptyTitle) return host.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'empty';
    const strong = document.createElement('b');
    strong.textContent = emptyTitle;
    empty.append(strong, emptyBody);
    return host.replaceChildren(empty);
  }

  host.replaceChildren(...rows.map((row, i) => jobCard(row, i)));
}

/**
 * One row of the list.
 *
 * Split out of `drawJobs` because "load more" appends to a list that is already
 * on screen: rebuilding all of it would throw away the open card and the scroll
 * position to redraw 200 rows that did not change.
 */
function jobCard(row, i) {
  const card = document.createElement('div');
  card.className = `job${openJobId === row.id ? ' open' : ''}`;
  card.onclick = (event) => {
    if (event.target.closest('a, .detail, .rank-why, .why-i')) return;
    toggleDetail(card, row);
  };

  const rank = document.createElement('div');
  rank.className = 'rank';
  rank.textContent = i + 1;

  const main = document.createElement('div');
  const heading = document.createElement('h4');
  const link = document.createElement('a');
  link.href = row.url ?? '#';
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = row.title;
  heading.append(link);
  const company = document.createElement('div');
  company.className = 'co';
  // Company and department are separate elements so the stylesheet can lift
  // the company out of the grey and leave the department as the quiet half.
  const coName = row.company;
  const coDept = row.department;
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

  const metaRow = document.createElement('div');
  metaRow.className = 'meta';
  for (const text of jobChips(row)) {
    const chip = document.createElement('span');
    chip.className = 'chip soft';
    chip.textContent = text;
    metaRow.append(chip);
  }
  for (const key of row.unknown_on ?? []) {
    const chip = document.createElement('span');
    chip.className = 'chip soft';
    chip.style.opacity = '.7';
    chip.textContent = `? ${key}`;
    chip.title = `We could not determine ${key} for this posting.`;
    metaRow.append(chip);
  }
  main.append(metaRow);
  // A pill when you have already done something about this job. Draws
  // nothing at all when the server has no accounts.
  account.decorateCard(row, { meta: metaRow });

  if (row.why?.length) {
    const why = document.createElement('div');
    why.className = 'why';
    why.textContent = row.why.join('  ·  ');
    main.append(why);
  }

  // What used to be the score. One icon, not a word: `why?` written out
  // 200 times built a column of text down the right edge that competed with
  // the titles for attention, and the question only ever gets asked of one
  // row at a time. See `rankPanel` for what it opens.
  const whyBtn = document.createElement('button');
  whyBtn.type = 'button';
  whyBtn.className = `why-i${openWhyId === row.id ? ' on' : ''}`;
  whyBtn.textContent = 'i';
  paintWhyButton(whyBtn, i + 1, openWhyId === row.id);
  whyBtn.onclick = (event) => {
    event.stopPropagation();
    toggleWhy(card, row, i + 1);
  };

  card.append(rank, main, whyBtn);
  // Order matters: the breakdown belongs above the description, not under
  // 5 KB of it.
  if (openWhyId === row.id) card.append(rankPanel(row, i + 1));
  if (openJobId === row.id) void renderDetail(card, row);
  return card;
}

function jobChips(row) {
  const chips = [];
  // With the fold on, the places are the union across every copy of this
  // posting — which is the information the fold would otherwise have thrown
  // away, and usually the only thing that differed between the copies.
  const places = row.duplicate_metros?.length ? row.duplicate_metros : row.metros;
  if (places?.length) chips.push(places.slice(0, 4).join(' / ') + (places.length > 4 ? ` +${places.length - 4}` : ''));
  if (row.duplicates) chips.push(`posted ${row.duplicates + 1}×`);
  // A question mark on the guessed ones. Two thirds of the corpus reads
  // `onsite` because it named an office and never said otherwise, which is a
  // different claim from an employer ticking OnSite — and this chip is the only
  // place a row says so before you open it.
  if (row.workplace) chips.push(row.workplace_guessed ? `${row.workplace}?` : row.workplace);
  if (row.remote_scope) chips.push(REMOTE_SCOPE_LABELS[row.remote_scope] ?? row.remote_scope);
  if (row.salary_label) chips.push(row.salary_label + (row.pay_period === 'HOUR' ? ' (hourly)' : ''));
  if (row.currency && row.currency !== 'USD') chips.push(row.currency);
  if (row.equity) chips.push('equity');
  if (row.years_known) chips.push(`${row.min_years}${row.max_years ? `–${row.max_years}` : '+'} yrs`);
  else if (row.seniority && row.seniority !== 'unknown') chips.push(row.seniority);
  if (row.employment_type && row.employment_type !== 'FullTime') chips.push(row.employment_type);
  if (row.age_days != null) chips.push(row.age_days <= 1 ? 'today' : `${row.age_days}d`);
  // Last, and the only chip that is not a fact about the job: which board the
  // posting was swept from. It carried a `via` prefix while the ATS name was
  // the newest thing on the row; the chip row's own shape turned out to say it
  // better — nothing else in a run of pills is a company, so a bare `Ashby`
  // last in the row never reads as one, and the preposition was a word of
  // scaffolding on every result.
  if (row.ats) chips.push(atsLabel(row.ats));
  return chips;
}

// -------------------------------------------------------- why it ranked --

/**
 * The icon says nothing on its own, so its whole label lives in the tooltip and
 * the accessible name — and both name the rank, because "why is this third?" is
 * the question being answered and it is a different question per row.
 */
function paintWhyButton(button, position, open) {
  button.dataset.position = position;
  const label = open ? `Hide why this job ranks #${position}` : `Why does this job rank #${position}?`;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-expanded', open ? 'true' : 'false');
}

/**
 * Open or close one card's ranking breakdown. One at a time, like the detail.
 */
function toggleWhy(card, row, position) {
  const button = card.querySelector('.why-i');
  const existing = card.querySelector('.rank-why');
  if (existing) {
    existing.remove();
    openWhyId = null;
    button.classList.remove('on');
    paintWhyButton(button, position, false);
    return;
  }
  document.querySelectorAll('.rank-why').forEach((node) => node.remove());
  document.querySelectorAll('.why-i.on').forEach((node) => {
    node.classList.remove('on');
    paintWhyButton(node, Number(node.dataset.position), false);
  });
  openWhyId = row.id;
  button.classList.add('on');
  paintWhyButton(button, position, true);
  // Above the description if one is already open, so the two read in the order
  // you asked for them.
  card.insertBefore(rankPanel(row, position), card.querySelector('.detail'));
}

/**
 * Why one job is where it is in the list.
 *
 * This replaced the score. The card used to print it raw — `57`, `50`, `47` —
 * and a bare number answered nothing: it has no units and no ceiling, so there
 * was no way to tell whether 57 was good, and two rows three points apart look
 * meaningfully different when they are not. What anyone actually wants from a
 * ranked list is the reason for the order, and that does not fit in a corner of
 * a card, so it moved behind a click.
 *
 * Everything drawn here is arithmetic the server already did. `score_parts` is
 * the weighted contribution of each component and the profile carries the
 * weights, so the bars are the numbers that did the sorting rather than a
 * second, prettier scoring rule that could drift away from it.
 */
function rankPanel(row, position) {
  const panel = document.createElement('div');
  panel.className = 'rank-why';

  const head = document.createElement('div');
  head.className = 'head';
  const strong = document.createElement('b');
  strong.textContent = `Ranked #${position} of ${fmt(last?.total ?? 0)}`;
  head.append(
    strong,
    ` · ${Number(row.score ?? 0).toFixed(1)} points. Each weight below is a field in your profile, ` +
      `not a constant in the code — change one and the whole list re-sorts.`,
  );
  panel.append(head);

  for (const part of rankBreakdown(row)) {
    const line = document.createElement('div');
    // A component the profile has switched off is drawn, not hidden: knowing
    // that description keywords contributed nothing *because you set none* is
    // the useful half of the answer.
    line.className = `part${part.max > 0 ? '' : ' off'}`;

    const key = document.createElement('div');
    key.className = 'k';
    key.textContent = part.label;

    const meter = document.createElement('div');
    meter.className = 'meter';
    const fill = document.createElement('i');
    const share = part.max > 0 ? Math.max(0, Math.min(1, part.got / part.max)) : 0;
    fill.style.width = `${(share * 100).toFixed(1)}%`;
    meter.append(fill);

    const num = document.createElement('div');
    num.className = 'n';
    num.textContent = part.max > 0 ? `${part.got.toFixed(1)} of ${part.max.toFixed(0)}` : 'off';

    const note = document.createElement('div');
    note.className = 'txt';
    note.textContent = part.note;

    line.append(key, meter, num, note);
    panel.append(line);
  }

  const foot = document.createElement('div');
  foot.className = 'foot';
  foot.textContent =
    'Ties break on recency, then on id, so two identical searches always come back in the same order. ' +
    'Nothing here decided whether this job is in the list — that was the filters. This is only the order.';
  panel.append(foot);
  return panel;
}

/**
 * The score, component by component.
 *
 * Fixed order rather than sorted by contribution, for the same reason the
 * one-line `why` under each title fixes its order: these get compared between
 * jobs, and rows that move around between two cards are much harder to read
 * against each other than rows that are always in the same place.
 */
function rankBreakdown(row) {
  const p = last?.profile ?? {};
  const w = p.weights ?? {};
  const parts = row.score_parts ?? {};
  const titleTerms = p.title_keywords ?? [];
  const descTerms = p.description_keywords ?? [];
  const titleHits = row.title_hits ?? [];
  const descHits = row.description_hits ?? [];
  const cap = w.description_keyword_cap ?? 0;

  const out = [];

  out.push({
    label: 'title words',
    got: parts.title ?? 0,
    max: titleTerms.length * (w.title_keyword ?? 0),
    note: !titleTerms.length
      ? 'No title keywords set, so this counts for nothing on any job.'
      : titleHits.length
        ? `${titleHits.length} of your ${titleTerms.length} title keywords are in this title — ` +
          `${titleHits.join(', ')}. Worth ${w.title_keyword} each, the heaviest thing in the ranking: ` +
          `it is what separates a title that is three-quarters your search from one that clipped a single word.`
        : `None of your ${titleTerms.length} title keywords are in this title, so it got here on something else.`,
  });

  out.push({
    label: 'description',
    got: parts.description ?? 0,
    max: Math.min(descTerms.length, cap) * (w.description_keyword ?? 0),
    note: !descTerms.length
      ? 'No description keywords set.'
      : descHits.length
        ? `${descHits.length} of your ${descTerms.length} description keywords are in the body` +
          `${descHits.length > cap ? `, and the first ${cap} count` : ''} — ${descHits.slice(0, 10).join(', ')}. ` +
          `Worth ${w.description_keyword} each: a word buried in 5 KB of prose says far less about a job ` +
          `than the same word in its title.`
        : `None of your ${descTerms.length} description keywords are in the body.`,
  });

  const age = row.age_days;
  out.push({
    label: 'freshness',
    got: parts.recency ?? 0,
    max: w.recency ?? 0,
    note:
      age == null
        ? 'This board publishes no date for the posting. It scores 30% of a fresh one — not rewarded, ' +
          'not punished, for something it never said.'
        : age <= 1
          ? 'Posted today, which is the full weight.'
          : `Posted ${fmt(age)} days ago. Freshness decays smoothly instead of falling off a cliff — it halves ` +
            `roughly every 62 days, so an old posting that matches well is still worth seeing.`,
  });

  out.push({
    label: 'salary',
    got: parts.salary ?? 0,
    max: w.salary ?? 0,
    note: row.salary_known
      ? `${row.salary_label} published, scored against a $60k–$250k band. A tiebreaker only: it is the ` +
        `lightest signal here, and salary is never used to rule a job out.`
      : 'No figure published — around 37% of postings publish one at all, so a silent listing scores a ' +
        'neutral 0.35 rather than zero and is not pushed below a loudly underpaid one.',
  });

  const capped = p.max_years_experience != null || p.min_years_experience != null;
  const asked = [
    p.min_years_experience != null ? `at least ${p.min_years_experience}` : null,
    p.max_years_experience != null ? `at most ${p.max_years_experience}` : null,
  ]
    .filter(Boolean)
    .join(' and ');
  const stated = row.years_known ? `${row.min_years}${row.max_years ? `–${row.max_years}` : '+'} years` : null;
  out.push({
    label: 'experience',
    got: parts.years ?? 0,
    max: w.years_fit ?? 0,
    note: !capped
      ? 'No experience range set, so every job scores the same here and this changed nothing about the order.'
      : stated
        ? `States ${stated}; you asked for ${asked}. ` +
          ((parts.years ?? 0) > 0
            ? 'A confirmed fit, which is the full weight.'
            : 'That lands outside your range, so this component is zero.')
        : `Says nothing about years. Scored under a confirmed fit and over a miss: a posting is never ruled ` +
          `out for a field it left blank, only ranked below the ones that filled it in.`,
  });

  const filled = Math.round((row.quality ?? 0) * 8);
  out.push({
    label: 'completeness',
    got: parts.quality ?? 0,
    max: w.quality ?? 0,
    note:
      `This posting states ${filled} of the 8 things a filter can read: salary, years, workplace, location, ` +
      `employment type, department, a posting date, and a description with real text in it. Completeness, ` +
      `not desirability — it breaks ties between equal matches and never excludes anything.`,
  });

  return out;
}

async function toggleDetail(card, row) {
  const existing = card.querySelector('.detail');
  if (existing) {
    existing.remove();
    card.classList.remove('open');
    openJobId = null;
    return;
  }
  document.querySelectorAll('.detail').forEach((node) => node.remove());
  document.querySelectorAll('.job.open').forEach((node) => node.classList.remove('open'));
  openJobId = row.id;
  card.classList.add('open');
  await renderDetail(card, row);
}

async function renderDetail(card, row) {
  if (card.querySelector('.detail')) return;
  const detail = document.createElement('div');
  detail.className = 'detail';
  detail.textContent = 'loading…';
  card.append(detail);

  let job;
  try {
    job = await api(`/api/job/${encodeURIComponent(row.id)}`);
  } catch (err) {
    detail.textContent = `could not load: ${err.message}`;
    return;
  }

  detail.replaceChildren();

  const actions = document.createElement('div');
  actions.className = 'actions';
  for (const [label, href] of [['Open posting ↗', job.url], ['Apply ↗', job.apply_url]]) {
    if (!href) continue;
    const link = document.createElement('a');
    link.className = 'btn primary';
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = label;
    actions.append(link);
  }
  detail.append(actions);

  // Status, note and lists — the account's half of a job. Null when signed out
  // on a server with no accounts; a one-line explanation when signed out on one
  // that has them.
  const tracker = account.detailPanel(job);
  if (tracker) detail.append(tracker);

  // The audit trail. `d_*_src` records which signal decided each derived value,
  // which is the difference between a filter you can debug and one you have to
  // trust.
  const kv = document.createElement('dl');
  kv.className = 'kv';
  const facts = [
    ['location (raw)', job.location_raw],
    ['all locations', (job.locations_all ?? []).join(' | ')],
    ['metros', (job.d_metros ?? []).join(', ')],
    ['workplace', `${job.d_workplace} — ${job.d_workplace_src ?? ''}`],
    ['seniority', `${job.d_seniority} — ${job.d_seniority_src ?? ''}`],
    ['salary', job.salary_label ? `${job.salary_label} — ${job.d_salary_src}` : (job.d_salary_src ?? 'none')],
    ['years', job.d_years_known ? `${job.d_min_years}${job.d_max_years ? `–${job.d_max_years}` : '+'}` : 'not stated'],
    ['employment', job.employment_type],
    ['department', job.d_job_function],
    ['skills', (job.d_skills ?? []).join(', ')],
    ['degree', job.d_degree],
    ['visa', job.d_visa === 1 ? 'sponsors' : job.d_visa === 0 ? 'explicitly does not' : 'not stated'],
    ['posted', job.posted_at ? new Date(job.posted_at).toISOString().slice(0, 10) : 'not stated'],
    ['first seen', job.first_seen ? new Date(job.first_seen).toISOString().slice(0, 10) : ''],
    ['listing quality', job.d_quality],
    ['board', job.board_url ?? job.company_slug],
    ['company name', `${job.company_display ?? ''} (${job.name_source ?? '?'})`],
  ];
  for (const [key, value] of facts) {
    if (value == null || value === '') continue;
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.textContent = String(value);
    kv.append(dt, dd);
  }
  detail.append(kv);

  const desc = document.createElement('div');
  desc.className = 'desc';
  // Plain text, never the ATS's HTML: this page renders untrusted third-party
  // markup from 4,297 different companies, and `textContent` is the one way to
  // be sure none of it executes.
  desc.textContent = job.description_text ?? '(no description)';
  detail.append(desc);
}

const stamp = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '—');

/**
 * What each filter panel on the left owns.
 *
 * One table, two readers: the badge counts the criteria in `fields`, and the
 * panel's "clear" wipes those *and* the `quiet` settings that only mean
 * something alongside them (require-all, remote-counts, include-interns).
 * Deriving both from the same list is what stops a panel from showing a count
 * its own clear button cannot take down.
 */
const PANELS = {
  ats: { badge: 'n-ats', fields: ['ats'] },
  text: { badge: null, fields: ['text'] },
  title: { badge: 'n-title', fields: ['title_keywords'], quiet: ['title_match'] },
  description: { badge: 'n-desc', fields: ['description_keywords'], quiet: ['description_match'] },
  exclude: { badge: 'n-exclude', fields: ['exclude_title_keywords'] },
  'exclude-description': { badge: 'n-exdesc', fields: ['exclude_description_keywords'] },
  metro: { badge: 'n-metro', fields: ['metros', 'countries'], quiet: ['remote_counts_as_match'] },
  workplace: { badge: 'n-workplace', fields: ['workplace', 'remote_scope'] },
  experience: {
    badge: 'n-experience',
    fields: ['seniority', 'max_years_experience', 'min_years_experience'],
    quiet: ['include_intern'],
  },
  salary: {
    badge: 'n-salary',
    fields: ['salary_min', 'salary_max', 'pay_period', 'currencies', 'requires_equity', 'salary_stated_only'],
  },
  posted: { badge: 'n-posted', fields: ['posted_within_days'] },
  'employment-type': { badge: 'n-employment-type', fields: ['employment_type'] },
  'job-function': { badge: 'n-job-function', fields: ['job_functions'] },
  skills: { badge: 'n-skills', fields: ['skills', 'exclude_skills'] },
  company: { badge: 'n-company', fields: ['companies', 'company_size'] },
  requirements: {
    badge: 'n-requirements',
    fields: ['degree', 'requires_visa_sponsorship', 'exclude_visa_refusal', 'exclude_clearance'],
  },
  // Policies rather than criteria, so the count is "how many did you move off
  // the default" and clearing the panel puts all eleven back. `unknowns` is one
  // object, not a field per criterion, which is why it is cleared rather than
  // counted.
  unknowns: { badge: 'n-unknowns', fields: [], quiet: ['unknowns'], custom: () => changedPolicies() },
};

/**
 * A list field holds one criterion per entry; a scalar holds one, or none.
 *
 * `false` is none. Half the criteria added since this was written are a single
 * boolean — equity, pay-as-published, the visa flags, clearance — and an unticked
 * box is not a criterion someone set. Without this line every panel holding one
 * would show a permanent badge and a clear button that clears nothing.
 */
const fieldCount = (value) =>
  Array.isArray(value) ? value.length : value === false || value == null || value === '' ? 0 : 1;

const panelCount = (panel) =>
  panel.custom ? panel.custom() : panel.fields.reduce((n, f) => n + fieldCount(profile[f]), 0);

/** The clear buttons, made once in `bindControls` and kept for `syncBadges`. */
const panelClears = new Map();

/**
 * Empty one panel — the "clear" beside its count.
 *
 * Deletes the keys rather than nulling them, so a cleared panel leaves the
 * profile looking exactly as it would have if you had never touched it.
 */
function clearPanel(name) {
  const panel = PANELS[name];
  if (!panel || !panelCount(panel)) return;
  for (const field of [...panel.fields, ...(panel.quiet ?? [])]) delete profile[field];
  fillControls();
  drawFacets();
  runSearch({ delay: 0 });
}

/** Push the sort and fold controls back from the profile. Both are presentation. */
function fillToolbar() {
  const sort = $('sort');
  if (sort && sort.options.length) sort.value = profile.sort ?? 'relevance';
  $('collapse').checked = Boolean(profile.collapse_duplicates);
}

/** The per-panel count badges — how many criteria each collapsed card holds. */
function syncBadges() {
  for (const [name, panel] of Object.entries(PANELS)) {
    const count = panelCount(panel);
    const badge = panel.badge ? $(panel.badge) : null;
    if (badge) {
      badge.textContent = count;
      badge.style.display = count ? '' : 'none';
    }
    // Nothing set, nothing to clear: the button is not there to be aimed at.
    const clear = panelClears.get(name);
    if (clear) clear.hidden = !count;
  }
}

// ------------------------------------------------------------------- forms --

/** Push the profile object into every control. Runs on load and on profile switch. */
function fillControls() {
  $('text').value = profile.text ?? '';
  $('title-all').checked = profile.title_match === 'all';
  $('desc-all').checked = profile.description_match === 'all';
  $('remote-counts').checked = Boolean(profile.remote_counts_as_match);
  $('include-intern').checked = Boolean(profile.include_intern);
  $('max-years').value = profile.max_years_experience ?? '';
  $('min-years').value = profile.min_years_experience ?? '';
  $('salary-min').value = profile.salary_min ?? '';
  $('salary-max').value = profile.salary_max ?? '';
  $('age-days').value = customAgeDays() ?? '';
  drawTitleChips();
  drawDescChips();
  drawExTitleChips();
  drawExDescChips();
  drawExSkillChips();
  fillToolbar();
  // Drawn from the profile with no counts yet: the search that would supply
  // them has not run. `drawFacets` fills the numbers in when it comes back.
  drawToggle('requires-equity', 'equity-count', profile.requires_equity, null);
  drawToggle('salary-stated', 'stated-count', profile.salary_stated_only, null);
  drawToggle('visa-sponsors', 'visa-sponsors-count', profile.requires_visa_sponsorship, null);
  drawToggle('visa-no-refusal', 'visa-refusal-count', profile.exclude_visa_refusal, null);
  drawToggle('exclude-clearance', 'clearance-count', profile.exclude_clearance, null);
  drawUnknownPolicies();
  syncBadges();
}

function bindControls() {
  const number = (id, field) =>
    $(id).addEventListener('input', () => {
      const value = $(id).value.trim();
      profile[field] = value === '' ? null : Number(value);
      syncBadges();
      runSearch({ delay: 300 });
    });
  number('max-years', 'max_years_experience');
  number('min-years', 'min_years_experience');
  number('salary-min', 'salary_min');
  number('salary-max', 'salary_max');

  // The typed cap. It applies on a 300 ms pause like the other number boxes,
  // but the tick moves to this row on the keystroke — waiting for the round
  // trip to un-tick "≤90 days" while you are typing 45 shows two answers at
  // once. An empty box is no cap at all, which is "any age", not zero days.
  $('age-days').addEventListener('input', () => {
    const value = $('age-days').value.trim();
    const days = value === '' ? null : Number(value);
    setPostedDays(Number.isFinite(days) ? days : null, { delay: 300 });
  });
  // Picking the row itself with nothing in the box is a request to type one.
  $('age-custom-radio').addEventListener('change', () => {
    const value = $('age-days').value.trim();
    if (value === '') {
      drawAges(last?.facets?.age_band ?? [], currentAgeBand());
      $('age-days').focus();
      return;
    }
    setPostedDays(Number(value));
  });

  $('text').addEventListener('input', () => {
    profile.text = $('text').value.trim();
    runSearch({ delay: 320 });
  });
  $('title-all').addEventListener('change', () => {
    profile.title_match = $('title-all').checked ? 'all' : 'any';
    runSearch({ delay: 0 });
  });
  $('desc-all').addEventListener('change', () => {
    profile.description_match = $('desc-all').checked ? 'all' : 'any';
    runSearch({ delay: 0 });
  });
  $('remote-counts').addEventListener('change', () => {
    profile.remote_counts_as_match = $('remote-counts').checked;
    runSearch({ delay: 0 });
  });
  $('include-intern').addEventListener('change', () => {
    profile.include_intern = $('include-intern').checked;
    runSearch({ delay: 0 });
  });
  $('since').addEventListener('change', () => runSearch({ delay: 0 }));

  // The single-boolean criteria. One table rather than five near-identical
  // listeners, so a sixth is a line of data — the same reason `PANELS` is a
  // table and `CRITERIA` is a table.
  for (const [id, field] of [
    ['requires-equity', 'requires_equity'],
    ['salary-stated', 'salary_stated_only'],
    ['visa-sponsors', 'requires_visa_sponsorship'],
    ['visa-no-refusal', 'exclude_visa_refusal'],
    ['exclude-clearance', 'exclude_clearance'],
  ]) {
    $(id).addEventListener('change', () => {
      // Unticked is `false`, not `null`: the engine reads a false the same way
      // it reads an absent field, and a `false` on disk says "I looked at this
      // and decided no", which is worth keeping in a saved document.
      profile[field] = $(id).checked;
      $(id).closest('.opt')?.classList.toggle('on', $(id).checked);
      syncBadges();
      runSearch({ delay: 0 });
    });
  }

  // Sort and fold. Neither is a criterion — they change what the same match set
  // looks like, not which jobs are in it — but both live in the profile,
  // because a saved search that forgets it was sorted by pay is a saved search
  // you have to set up twice.
  $('sort').addEventListener('change', () => {
    profile.sort = $('sort').value;
    runSearch({ delay: 0 });
  });
  $('collapse').addEventListener('change', () => {
    profile.collapse_duplicates = $('collapse').checked;
    runSearch({ delay: 0 });
  });

  // Collapsible panels, remembered across reloads — someone who never uses the
  // skills facet should not have to scroll past it every session.
  for (const card of document.querySelectorAll('.card[data-panel]')) {
    const name = card.dataset.panel;
    const key = `panel:${name}`;
    const stored = safeGet(key);
    if (stored === 'open') card.classList.remove('collapsed');
    if (stored === 'closed') card.classList.add('collapsed');
    const head = card.querySelector('h3');

    // Every panel clears in one click. Removing eight keywords one × at a time
    // is eight searches and eight redraws to get back to where you started.
    if (PANELS[name]) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'clear';
      clear.textContent = 'clear';
      clear.title = `Clear this panel — ${head.firstChild.textContent.trim().toLowerCase()}`;
      clear.hidden = true;
      clear.onclick = (event) => {
        event.stopPropagation(); // the header itself collapses the panel
        clearPanel(name);
      };
      head.insertBefore(clear, head.querySelector('.caret'));
      panelClears.set(name, clear);
    }

    head.onclick = () => {
      card.classList.toggle('collapsed');
      safeSet(key, card.classList.contains('collapsed') ? 'closed' : 'open');
    };
  }

  $('theme').onclick = () => {
    const now = document.documentElement.getAttribute('data-theme');
    const next = now === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    safeSet('theme', next);
  };
  const savedTheme = safeGet('theme');
  if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);

  $('reset').onclick = () => {
    // Reset to the engine's defaults, not to a copy of them kept here.
    profile = {
      name: 'untitled',
      unknowns: Object.fromEntries((meta?.unknowns ?? []).map((u) => [u.key, u.default ?? 'include'])),
    };
    $('profile-select').value = '';
    fillControls();
    runSearch({ delay: 0 });
  };

  $('save').onclick = async () => {
    const suggested = profile.name && profile.name !== 'untitled' ? profile.name : 'my-search';
    const name = prompt('Save this profile as (letters, numbers, - and _):', suggested);
    if (!name) return;
    profile.name = name;
    try {
      // Signed in, it goes to your account and nobody else sees it. Signed out,
      // it is written to `profiles/<name>.json` exactly as before — the file the
      // CLI and the daily run read. Same document either way.
      if (await account.save(name, profile)) {
        fillProfileSelect(`mine:${name}`);
        return;
      }
      const result = await api(`/api/profiles/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(profile),
      });
      meta.profiles = result.profiles;
      fillProfileSelect(`shared:${name}`);
    } catch (err) {
      showWarnings([`could not save: ${err.message}`]);
    }
  };

  $('profile-select').addEventListener('change', async (event) => {
    const value = event.target.value;
    if (!value) return;
    const owner = value.slice(0, value.indexOf(':'));
    const name = value.slice(value.indexOf(':') + 1);
    try {
      profile = owner === 'mine' ? await account.load(name) : await api(`/api/profiles/${encodeURIComponent(name)}`);
      fillControls();
      runSearch({ delay: 0 });
    } catch (err) {
      showWarnings([`could not load ${name}: ${err.message}`]);
    }
  });
}

/** localStorage is a convenience here, and it throws in some privacy modes. */
function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* nothing to do — the page works without it */
  }
}

/**
 * The profile menu, holding both kinds of profile.
 *
 * A profile saved to an account and a profile saved to `profiles/*.json` are
 * the same document — an account changes where one lives, never what one is —
 * so they sit in one menu, grouped by whose they are. The value carries the
 * owner (`mine:` / `shared:`) because two profiles may share a name.
 */
function fillProfileSelect(selected) {
  const select = $('profile-select');
  select.replaceChildren();
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = '— profile —';
  select.append(blank);

  const group = (label, rows, prefix) => {
    if (!rows?.length) return;
    const optgroup = document.createElement('optgroup');
    optgroup.label = label;
    for (const p of rows) {
      const option = document.createElement('option');
      option.value = `${prefix}:${p.name}`;
      option.textContent = p.label ?? p.name;
      option.title = p.notes ?? '';
      optgroup.append(option);
    }
    select.append(optgroup);
  };
  // A file-backed profile can also be yours: a `profiles/*.json` document that
  // names an `owner` is listed by the server only to that account, so it goes
  // under "Yours" beside the ones saved to the account itself. Both load
  // through `shared:` / `mine:` as before — the prefix says which store the
  // document lives in, and this grouping says whose it is.
  const files = meta.profiles ?? [];
  const mineOnDisk = files.filter((p) => p.owner);
  const everyones = files.filter((p) => !p.owner);

  // Yours first: on a page showing both, the ones you wrote are the ones you
  // came for.
  group('Yours', account.profileOptions(), 'mine');
  group('Yours', mineOnDisk, 'shared');
  group(account.signedIn() || mineOnDisk.length ? 'Shared with everyone' : 'Profiles', everyones, 'shared');

  if (selected) select.value = selected;
}

// -------------------------------------------------------------------- boot --

async function boot() {
  bindControls();
  try {
    meta = await api('/api/meta');
  } catch (err) {
    showWarnings([`could not reach the server: ${err.message}`]);
    return;
  }

  $('corpus').textContent =
    `${fmt(meta.open)} jobs · ${fmt(meta.boards_live)} companies`;

  // The sort menu is generated from what the engine says it can sort by, not
  // from a list kept here — the same rule as the metro dropdown and the unknown
  // policies. A menu written separately from the engine will eventually promise
  // an order the engine does not implement.
  $('sort').replaceChildren(
    ...(meta.sorts ?? []).map((option) => {
      const el = document.createElement('option');
      el.value = option.value;
      el.textContent = option.label;
      el.title = option.detail ?? '';
      return el;
    }),
  );

  // The account layer, when the server has one. It hands back the filter
  // document this account was last using — the whole of "you don't have to
  // re-enter them" — and null for everyone else, who boot exactly as before.
  let remembered = null;
  try {
    remembered = await account.init({
      meta,
      getProfile: () => profile,
      setProfile: (next) => {
        profile = next;
        fillControls();
        runSearch({ delay: 0 });
      },
      onProfilesChanged: () => fillProfileSelect($('profile-select').value),
    });
  } catch (err) {
    // An account layer that fails to load must not take the search with it.
    showWarnings([`accounts unavailable: ${err.message}`]);
  }

  fillProfileSelect(null);

  if (remembered && Object.keys(remembered).length) {
    profile = remembered;
    // A remembered document keeps the name of the profile it was built from,
    // so the menu can still say which search this is. Without this the filters
    // come back correctly under a menu reading "— profile —", which is the one
    // control on the page contradicting the twelve chips beside it.
    const select = $('profile-select');
    const wanted = new Set([`mine:${remembered.name}`, `shared:${remembered.name}`]);
    const option = remembered.name && [...select.options].find((o) => wanted.has(o.value));
    if (option) select.value = option.value;
  } else {
    // Boot into the first profile the server listed, so the page opens on a
    // real search rather than the whole corpus in no particular order.
    //
    // *Which* profile that is, is the server's answer and not this page's: the
    // list arrives with the ones you own first and the ones that belong to
    // everyone after, so a signed-in owner boots into their own criteria
    // without touching a control, and everybody else boots into the neutral
    // starter. This used to be `profiles[0]` too — but the list was unfiltered,
    // and the first entry was one person's NYC entry-level search, which every
    // visitor then had to notice and un-tick before the corpus was theirs.
    const first = meta.profiles?.[0];
    if (first) {
      try {
        profile = await api(`/api/profiles/${encodeURIComponent(first.name)}`);
        $('profile-select').value = `shared:${first.name}`;
      } catch {
        profile = {};
      }
    }
  }
  fillControls();
  runSearch({ delay: 0 });
}

boot();
