/**
 * Job Finder — the pieces of a card that both lists draw.
 *
 * `app.js` builds the search results and `account.js` builds the saved list,
 * and the two have always drawn the same row. What they could not share was a
 * function: `app.js` imports `account.js`, so anything the account layer needs
 * from the search page has to live outside both of them. This is that place.
 */

/**
 * The palette the company marks are drawn from.
 *
 * A fixed set of hues rather than `hash % 360`. An open hue wheel puts acid
 * yellows and muddy olives next to clean blues, and a column of two hundred
 * tiles is precisely where that shows; these ten sit at even spacing and all
 * hold up at the low saturation the stylesheet renders them at.
 */
const HUES = [222, 258, 288, 328, 6, 26, 44, 152, 176, 198];

/** Words that are never the interesting half of a company's name. */
const SUFFIX = /^(inc|llc|ltd|limited|corp|corporation|co|company|group|holdings|plc|gmbh|sa|ag|nv|bv|pbc|llp)$/i;

/**
 * The tile that stands in for a company logo.
 *
 * Every job board anchors a row with the employer's mark, and that mark is
 * what makes a company findable while you scroll past two hundred of them —
 * the name on its own is a line of text competing with the job title directly
 * above it, which is a fight it loses. We have no images (nothing populates
 * `companies.logo_url`), so this is the monogram every board falls back to
 * when an employer has none.
 *
 * The colour is derived from the name rather than stored, so the same employer
 * gets the same tile on every row and in every session with no lookup and no
 * schema change. Only the hue is set here; how light or saturated it is
 * belongs to the stylesheet, which is the half that knows about dark mode.
 */
export function companyMark(name) {
  const tile = document.createElement('div');
  tile.className = 'logo';
  // The company is written out in full on the line beside it. To a screen
  // reader the tile is decoration, not a second copy of the name.
  tile.setAttribute('aria-hidden', 'true');

  const clean = String(name ?? '').trim();
  const letters = clean && monogram(clean);
  if (!letters) {
    tile.classList.add('blank');
    return tile;
  }
  tile.textContent = letters;
  tile.style.setProperty('--h', String(HUES[hash(clean.toLowerCase()) % HUES.length]));
  return tile;
}

/**
 * Up to two letters for a name.
 *
 * Initials where there are two real words to take them from ("Asian Health
 * Services" → AH), the first two letters where there is only one ("Stripe" →
 * ST). A trailing `Inc` or `Group` is not a real word for this purpose: half
 * the corpus would come out as `-I` or `-G` if it were.
 */
function monogram(name) {
  const words = name
    .replace(/^(the|a|an)\s+/i, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (!words.length) return '';
  const second = words.find((w, i) => i > 0 && !SUFFIX.test(w));
  const letters = second ? words[0][0] + second[0] : words[0].slice(0, 2);
  return letters.toUpperCase();
}

/**
 * FNV-1a. Any stable hash would do — this one is four lines and spreads short
 * strings well, which is all a colour index asks of it.
 */
function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
