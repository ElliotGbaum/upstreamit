/**
 * The methodology page.
 *
 * Two jobs, both small. It builds the table of contents from the headings that
 * are actually in the document — a section added to methodology.html grows a
 * row here with no second edit, which is the same rule the app's own controls
 * follow — and it fills in the handful of figures the page claims are read from
 * the corpus rather than typed into the prose.
 *
 * The page is complete and readable with this file absent or failed. Everything
 * it touches is either additive (the nav) or already carries a printed fallback
 * (the stat row is `hidden` until there are real numbers to put in it).
 */

const $ = (id) => document.getElementById(id);

const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '—');
const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '—');

// ---------------------------------------------------------------------- toc
const heads = [...document.querySelectorAll('.prose h2[id]')];
const toc = $('toc');

if (heads.length) {
  const title = document.createElement('h2');
  title.textContent = 'On this page';
  toc.append(title);
  for (const head of heads) {
    const link = document.createElement('a');
    link.href = `#${head.id}`;
    // The heading's own words, not a second shorter label kept in a list
    // somewhere: two names for one section is one name going stale.
    link.textContent = head.textContent;
    link.dataset.for = head.id;
    toc.append(link);
  }
}

/**
 * Which section is being read.
 *
 * The rule is "the last heading that has crossed the top of the screen", which
 * is what a reader means by where they are — and not "whichever heading is
 * intersecting", which flickers between two entries whenever a short section
 * fits on screen whole.
 */
function markCurrent() {
  const line = 100;
  let here = heads[0];
  for (const head of heads) {
    if (head.getBoundingClientRect().top <= line) here = head;
  }
  // The foot of the document never scrolls a final short section past the line,
  // so at the bottom the last heading is the answer whatever the maths says.
  if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 4) {
    here = heads[heads.length - 1];
  }
  for (const link of toc.querySelectorAll('a')) {
    link.classList.toggle('here', link.dataset.for === here?.id);
  }
}

if (heads.length) {
  markCurrent();
  addEventListener('scroll', markCurrent, { passive: true });
  addEventListener('resize', markCurrent, { passive: true });
}

// -------------------------------------------------------------- live stats
/**
 * The same endpoint the search page and the sign-in page read, for the same
 * reason: a number about the corpus should come from the corpus. A page that
 * prints "337,888 open jobs" into its own HTML is telling you about the day it
 * was written.
 */
try {
  const meta = await fetch('/api/meta').then((r) => (r.ok ? r.json() : null));
  if (meta) {
    $('s-open').textContent = fmt(meta.open);
    $('s-boards').textContent = fmt(meta.boards_live);
    // The corpus is as fresh as its stalest board, which is what the server
    // reports here — not the most recent sweep of any one of them.
    $('s-swept').textContent = day(meta.last_sweep);
    $('s-derived').textContent = day(meta.last_derive);
    $('statline').hidden = false;

    // How far the company read has got, as a share of open jobs — the unit the
    // filter works in — and the same share the other way up for the silent
    // table. Both left as the printed dash on a server that has never run it.
    if (typeof meta.jobs_with_sector === 'number' && meta.open) {
      const share = meta.jobs_with_sector / meta.open;
      $('s-sector-jobs').textContent = `${(share * 100).toFixed(1)}%`;
      $('s-sector-boards').textContent = fmt(meta.sectors_read);
      $('s-sector-silent').textContent = `${((1 - share) * 100).toFixed(1)}%`;
    }

    // The list of ATSes is filled in where the sentence about it is, not in the
    // stat row: it is a claim the prose makes, so it should be the corpus that
    // answers it. The written-out fallback in the HTML is today's answer, so the
    // sentence reads correctly with this file absent — but the day a fourth
    // adapter lands, the served list is the one on screen.
    const boards = (meta.ats ?? []).map((row) => row.value[0].toUpperCase() + row.value.slice(1)).sort();
    if (boards.length) {
      $('s-ats').textContent =
        boards.length === 1 ? boards[0] : `${boards.slice(0, -1).join(', ')} and ${boards.at(-1)}`;
    }
  }
} catch {
  // Leave the row hidden. The document does not depend on it.
}
