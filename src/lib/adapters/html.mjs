/**
 * HTML → plaintext, for the ATSes that publish only markup.
 *
 * Ashby hands us `descriptionPlain` and we store it verbatim. Greenhouse does
 * not, and neither do Rippling or Breezy — so this lives beside the registry
 * rather than inside one adapter. A second copy is how the two drift, and four
 * things downstream read the plaintext: the FTS5 description gate and the
 * skills, degree and visa derivations. A weak strip that leaves `</p>` glued to
 * the next sentence degrades all four silently.
 *
 * ## Decode exactly once
 *
 * Greenhouse's `content` is entity-escaped markup — `&lt;h2&gt;Who we are&lt;/h2&gt;`,
 * on 626 of 626 sampled jobs, never raw HTML. One decode turns it into HTML.
 * A second one corrupts it, and the corpus is full of the case that proves it:
 * 96.8% of payloads carry `&amp;amp;`, the correct single-escape of a literal
 * `&` in the prose. Decoding twice leaves a bare `&`, which then swallows the
 * next word as an entity. `decodeEntitiesOnce` is a single left-to-right pass
 * for exactly that reason — after it rewrites `&amp;` it resumes *after* the
 * semicolon, so `&amp;lt;` becomes `&lt;` and stops there.
 */

/** The named entities that actually occur in job descriptions, plus the ASCII five. */
const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', shy: '­',
  ndash: '–', mdash: '—', horbar: '―', minus: '−',
  lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„',
  laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›',
  hellip: '…', bull: '•', middot: '·', sdot: '⋅', dagger: '†', Dagger: '‡',
  copy: '©', reg: '®', trade: '™', sect: '§', para: '¶', deg: '°', permil: '‰',
  euro: '€', pound: '£', yen: '¥', cent: '¢', curren: '¤',
  plusmn: '±', times: '×', divide: '÷', frac12: '½', frac14: '¼', frac34: '¾',
  sup1: '¹', sup2: '²', sup3: '³', micro: 'µ', ordm: 'º', ordf: 'ª',
  larr: '←', rarr: '→', harr: '↔', uarr: '↑', darr: '↓',
  ne: '≠', le: '≤', ge: '≥', asymp: '≈', infin: '∞', radic: '√',
  check: '✓', star: '☆', hearts: '♥', diams: '♦', clubs: '♣', spades: '♠',
  eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à', acirc: 'â', ccedil: 'ç',
  uuml: 'ü', ouml: 'ö', auml: 'ä', szlig: 'ß', ntilde: 'ñ', aring: 'å',
  oslash: 'ø', aelig: 'æ', iacute: 'í', oacute: 'ó', uacute: 'ú', aacute: 'á',
};

// A numeric reference, or a name we know. An unknown name is left alone rather
// than dropped — `&foo;` in prose is prose, and guessing at it loses characters.
const ENTITY = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g;

/**
 * Decode HTML entities in a single left-to-right pass.
 *
 * Never call this in a loop until the output stops changing. That is the bug
 * this function exists to make impossible: `&amp;amp;` is a literal `&amp;` on
 * the page, and only one pass says so.
 */
export function decodeEntitiesOnce(input) {
  if (typeof input !== 'string' || !input.includes('&')) return input ?? '';
  return input.replace(ENTITY, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      // Surrogate halves are not characters; emitting one produces a lone
      // surrogate that breaks JSON round-tripping and SQLite storage.
      if (code >= 0xd800 && code <= 0xdfff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return Object.hasOwn(NAMED, body) ? NAMED[body] : match;
  });
}

// Bodies that are markup, not prose. Dropped whole — a stray `</script>` in a
// listing is far rarer than a tracking pixel's worth of JavaScript in one.
const VOID_BODIES = /<(script|style|head|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/**
 * One newline: a list item, a table row, a `<br>`.
 *
 * Deliberately single-spaced. Most of a job description is bulleted — the
 * requirements, the responsibilities, the benefits — and blank lines between
 * every bullet make the detail pane twice as long and half as readable. Only
 * the opening tag fires, so `<li>A</li><li>B</li>` yields one break between the
 * two rather than one from each side.
 */
const SINGLE_BREAK = /<\s*br\s*\/?\s*>|<\s*(li|tr|dt|dd)\b[^>]*>/gi;

/**
 * Two newlines: a paragraph-level boundary.
 *
 * Both the opening and the closing tag fire, because plenty of boards publish
 * markup with one and not the other. The doubling that causes is collapsed at
 * the end — that is what the 3+ → 2 rule is for.
 */
const DOUBLE_BREAK =
  /<\/?\s*(p|div|ul|ol|dl|h[1-6]|blockquote|section|article|header|footer|pre|figcaption|table|thead|tbody)\b[^>]*>/gi;

// Cells run together without a separator otherwise: "SalaryLocation".
const CELL_BREAK = /<\/?\s*(td|th)\b[^>]*>/gi;

// Closing tags whose opening partner already broke the line. Dropped outright
// so they do not add a second break.
const SPENT_CLOSERS = /<\/\s*(li|tr|dt|dd)\s*>/gi;

// Requires a tag-shaped body, so a bare `<` left in prose survives as prose.
const TAGS = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!\s*[a-zA-Z][^>]*>|<\/?\s*[a-zA-Z][a-zA-Z0-9-]*(?:\s[^>]*)?>/g;

/**
 * Markup → readable plaintext.
 *
 * Takes **already-decoded** HTML: `htmlToText(decodeEntitiesOnce(content))` for
 * Greenhouse, `htmlToText(raw)` for an ATS that publishes real markup. The
 * entity decode at the end is the *text's* decode, not a second pass over the
 * HTML — it is what turns the `&amp;` that correctly escaped a literal `&` in
 * the markup into the `&` a reader sees, and it happens after the tags are gone
 * so an escaped `&lt;p&gt;` in the prose can never become a tag.
 */
export function htmlToText(html) {
  if (typeof html !== 'string' || !html) return '';

  let text = html
    .replace(VOID_BODIES, ' ')
    .replace(SPENT_CLOSERS, '')
    .replace(CELL_BREAK, ' ')
    .replace(DOUBLE_BREAK, '\n\n')
    .replace(SINGLE_BREAK, '\n')
    .replace(TAGS, '');

  text = decodeEntitiesOnce(text);

  return text
    .replace(/\r\n?/g, '\n')
    // NBSP is a space to a reader and a distinct character to a keyword matcher.
    .replace(/ /g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
