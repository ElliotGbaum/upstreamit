/**
 * The merge rules behind the canonical per-ATS slug store.
 *
 * These decide when a slug is in the store, when a source's claim on it stands,
 * and when it goes away — which is the part of the sync that is easy to get
 * subtly wrong and expensive to notice, because the damage shows up as boards
 * quietly vanishing from the sweep rather than as an error. They live here
 * rather than in sync-slugs.mjs so they can be tested without a network, a
 * clock, or the CLI around them.
 */

/**
 * Merge this run's observations into the existing store.
 *
 * A source that returned 304 or errored keeps whatever it previously claimed —
 * otherwise a single upstream hiccup would look like thousands of deletions.
 * Only sources we actually re-read get their claims recomputed.
 *
 * @param {object}              previous            prior store: slug -> record
 * @param {Map<string,Set>}     observed            this run: slug -> source ids
 * @param {Set<string>}         carriedSources      sources we could not re-read
 * @param {Set<string>}         incrementalSources  sources that report only what is new
 * @param {string}              now                 ISO timestamp for this run
 * @param {number|null}         pruneAfter          days; null disables pruning
 */
export function mergeStore({
  previous,
  observed,
  carriedSources,
  incrementalSources = new Set(),
  now,
  pruneAfter = null,
}) {
  // A Map, not an object literal: real slugs collide with Object.prototype keys
  // ("constructor", "tostring"), and a plain-object lookup would silently return
  // the inherited function instead of undefined.
  const slugs = new Map();
  const pruned = [];

  // Carry forward prior records, keeping only source attributions we can still vouch for.
  for (const [slug, record] of Object.entries(previous)) {
    const keptSources = (record.sources ?? []).filter(
      (sourceId) =>
        carriedSources.has(sourceId) ||
        // An incremental source answers "what is new", not "what exists", so a
        // slug missing from this run's reply is not evidence the board is gone —
        // it is evidence the board is not new. Recomputing its claims would
        // delete every board it has ever found on the very next run.
        incrementalSources.has(sourceId) ||
        observed.get(slug)?.has(sourceId),
    );
    slugs.set(slug, {
      sources: keptSources,
      first_seen: record.first_seen ?? now,
      last_seen: keptSources.length ? now : (record.last_seen ?? now),
    });
  }

  // Fold in what we saw this run.
  for (const [slug, sourceIds] of observed) {
    const record = slugs.get(slug) ?? { sources: [], first_seen: now, last_seen: now };
    record.sources = [...new Set([...record.sources, ...sourceIds])].sort();
    record.last_seen = now;
    slugs.set(slug, record);
  }

  if (pruneAfter != null) {
    const cutoff = Date.now() - pruneAfter * 86_400_000;
    for (const [slug, record] of slugs) {
      if (record.sources.length === 0 && Date.parse(record.last_seen) < cutoff) {
        pruned.push(slug);
        slugs.delete(slug);
      }
    }
  }

  return { slugs: Object.fromEntries(slugs), pruned };
}

/**
 * Which (ats, source) pairs this run never read, and must therefore carry.
 *
 * `--sources` narrows what a run fetches, not what the store is allowed to
 * believe. Every enabled source the run skipped is returned here so it can be
 * carried exactly like a source that answered 304, because the two are the same
 * situation: no new evidence either way.
 *
 * @param {Array<object>} enabledSources  every source the registry has enabled
 * @param {Array<object>} readSources     the subset this run is actually reading
 */
export function unreadSourceCarry(enabledSources, readSources) {
  const read = new Set(readSources.map((source) => source.id));
  const carry = [];
  for (const source of enabledSources) {
    if (read.has(source.id)) continue;
    for (const file of source.files ?? []) {
      if (file.ats) carry.push({ ats: file.ats, sourceId: source.id });
    }
  }
  return carry;
}

/** Compare two stores for the run report: what became active, what fell out. */
export function diffStore(previous, next, ats) {
  const wasActive = new Set(
    Object.entries(previous)
      .filter(([, record]) => (record.sources ?? []).length > 0)
      .map(([slug]) => slug),
  );
  const isActive = new Set(
    Object.entries(next)
      .filter(([, record]) => record.sources.length > 0)
      .map(([slug]) => slug),
  );

  const perSource = {};
  for (const [slug, record] of Object.entries(next)) {
    for (const sourceId of record.sources) {
      perSource[sourceId] ??= { total: 0, unique: 0 };
      perSource[sourceId].total += 1;
      if (record.sources.length === 1) perSource[sourceId].unique += 1;
    }
    void slug;
  }

  return {
    ats,
    added: [...isActive].filter((slug) => !wasActive.has(slug)).sort(),
    removed: [...wasActive].filter((slug) => !isActive.has(slug)).sort(),
    active: isActive.size,
    total: Object.keys(next).length,
    perSource,
    pruned: [],
  };
}
