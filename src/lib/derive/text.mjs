/**
 * Text helpers shared by every derivation.
 *
 * The one rule that matters here: **matching is word-boundary, never substring.**
 * Measured on the 4,760-job sample, substring matching on `ai` returns 355 title
 * hits instead of 263 — the extras are `P-ai-d Social`, `Supply Ch-ai-n`,
 * `Mount-ai-n View`. `specialist` as a substring drags in Spanish `Especialista`.
 * That is a 35% false-positive rate on a single keyword, so it is not a preference.
 *
 * `\b` alone cannot express this: JS word boundaries sit between `+` and a space,
 * so /\bc\+\+\b/ never matches "c++ developer". Terms whose edges are
 * non-word characters get lookaround guards instead — see `termPattern`.
 */

/** Unicode dashes, quotes and spaces that break naive regexes. Seen in real postings. */
const DASHES = /[‐‑‒–—―−]/g;
const QUOTES = /[‘’‛′]/g;
const DQUOTES = /[“”″]/g;
const SPACES = /[  -​  　]/g;

/**
 * Fold a raw string into the form every matcher expects: ASCII dashes and
 * quotes, collapsed whitespace, lowercase. Accents are stripped so `Zürich`
 * and `Zurich`, `Bogotá` and `Bogota` are the same place.
 */
export function fold(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(SPACES, ' ')
    .replace(DASHES, '-')
    .replace(QUOTES, "'")
    .replace(DQUOTES, '"')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * `fold`, except line breaks survive as `\n`.
 *
 * `fold` collapses every run of whitespace to a single space, which is right
 * for a title or a location string and wrong for a description: it destroys
 * the only evidence of layout the plaintext still carries. A description is
 * mostly bulleted, and "the claim starts its own line" is the difference
 * between a requirement and a clause inside a marketing sentence — see
 * `extractYears`, where a bullet is trusted without a keyword and the same
 * words mid-paragraph are not.
 *
 * Horizontal whitespace still collapses, blank lines still cap at one, and the
 * output is otherwise character-for-character what `fold` produces, so a
 * pattern written against one works unchanged against the other.
 */
export function foldLines(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(SPACES, ' ')
    .replace(DASHES, '-')
    .replace(QUOTES, "'")
    .replace(DQUOTES, '"')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .toLowerCase();
}

/** URL-safe id from arbitrary text. `São Paulo` -> `sao-paulo`. */
export function slugify(value) {
  return fold(value)
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const WORD_EDGE = /[a-z0-9]/;

/**
 * Escape a term and wrap it so it only matches as a whole word.
 *
 * Uses lookaround rather than `\b` because half of these terms end in a
 * non-word character: `c++`, `.net`, `node.js`, `f#`. For those, `\b` either
 * matches inside a longer token or refuses to match at all.
 */
export function termPattern(term) {
  const folded = fold(term);
  const escaped = folded.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const left = WORD_EDGE.test(folded[0]) ? '(?<![a-z0-9])' : '(?<![^\\s(,/|])';
  const right = WORD_EDGE.test(folded[folded.length - 1]) ? '(?![a-z0-9])' : '(?![^\\s),./|])';
  return `${left}${escaped}${right}`;
}

/**
 * Compile many terms into one alternation.
 *
 * One pass over a 5 KB description instead of one pass per term: already at 61k
 * jobs × ~200 skill terms that was the difference between seconds and minutes,
 * and the corpus is several times that size now.
 * Longest-first so `machine learning` wins over `learning`.
 */
export function termRegex(terms, flags = 'g') {
  const sorted = [...new Set(terms.map(fold))].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!sorted.length) return null;
  return new RegExp(sorted.map(termPattern).join('|'), flags);
}

/** Whole-word test for a single term against already-folded text. */
export function hasTerm(foldedText, term) {
  if (!foldedText) return false;
  return new RegExp(termPattern(term)).test(foldedText);
}

/**
 * Which of `terms` appear in `foldedText`, deduped, in the order given.
 * Returns the matched terms rather than a count — the UI shows *which*
 * keywords hit, and ranking by number of distinct keywords is what separates
 * `AI Deployment Strategist` from `Product Designer`.
 */
export function matchedTerms(foldedText, terms) {
  if (!foldedText) return [];
  const out = [];
  for (const term of terms) if (hasTerm(foldedText, term)) out.push(term);
  return out;
}

/** Number words that appear in experience requirements. "two years of experience". */
const NUMBER_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20,
};

export function parseNumber(token) {
  if (token == null) return null;
  const text = String(token).trim().toLowerCase();
  if (text in NUMBER_WORDS) return NUMBER_WORDS[text];
  const num = Number.parseFloat(text.replace(/,/g, ''));
  return Number.isFinite(num) ? num : null;
}

export const NUMBER_WORD_ALT = Object.keys(NUMBER_WORDS).join('|');
