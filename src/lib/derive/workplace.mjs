/**
 * Workplace type: onsite | hybrid | remote | unknown.
 *
 * The load-bearing fact, measured across the 61,213 Ashby jobs — the only ones
 * that carry a `workplaceType` enum at all:
 *
 *   OnSite  19,859   isRemote=0
 *   Remote  16,495   isRemote=1
 *   Hybrid  15,932   isRemote=1     <-- every hybrid job reports isRemote=true
 *   (null)   8,927   isRemote=null
 *
 * `isRemote` means "not fully onsite", not "remote". Filtering `isRemote=false`
 * to find in-person work silently discards all 15,932 hybrid jobs — 26% of the
 * Ashby board. `isRemote === false` ⟺ `workplaceType === 'OnSite'` exactly, so
 * the boolean carries nothing the enum lacks and is never consulted here except
 * as a last resort when the enum is missing.
 *
 * For the Ashby jobs with no enum, the fallback is the location text, defaulting
 * to in-person: of 724 nulls in the sampled set only 50 mentioned remote, and
 * null is a per-company setting more than a per-job one (25 of 356 boards left
 * it null on every posting). `d_workplace_src` records which rule fired so a
 * surprising answer can be traced instead of argued about.
 *
 * ## Greenhouse has no enum at all, and that changes how to read this column
 *
 * Measured 2026-08-22 over 204,485 Greenhouse jobs: this function returns
 *
 *   onsite   165,962   all of them via `default-has-metro` — a guess
 *   remote    31,634   via `location-text`
 *   unknown    6,889   `no-signal`
 *   hybrid         0   <-- not rare. **Impossible.**
 *
 * Greenhouse publishes no `workplaceType`, and only 0.5% of its location strings
 * mention "hybrid" against 31.2% mentioning "remote". So hybrid does not become
 * *wrong* on Greenhouse rows, it becomes *invisible*: a hybrid job with a named
 * office and no remote marker is indistinguishable here from a full-time office
 * job, and lands in `onsite`.
 *
 * Nothing about the rules below is wrong — a named place with no remote marker
 * really is the best available reading. But it means `d_workplace = 'onsite'`
 * answers two different questions depending on the ATS: on Ashby the employer
 * said so, on Greenhouse we inferred it. `d_workplace_src` is what tells those
 * apart, and `matchWorkplace` now reads it: a `default-has-metro` job can no
 * longer answer a hard `no` to "is this hybrid?", because nothing in the posting
 * answered that question either way. Corpus-wide all 15,932 hybrid jobs are
 * still Ashby jobs — the filter simply stops treating that as proof the
 * Greenhouse ones are not.
 */

/**
 * The one `src` below that reports an inference rather than a statement.
 *
 * Every other rule reads something the employer published — the enum, the
 * `isRemote` boolean, the word "remote" in the location string. This one fires
 * on an *absence*: a named place, and no remote marker anywhere. It is sound on
 * the axis it can see (the job is attached to an office, so it is not remote)
 * and blind on the one it cannot (five days there, or two?). 173,221 of 265,698
 * jobs land here, 165,962 of them Greenhouse.
 *
 * `matchWorkplace` imports this name so the filter can tell a guess from a
 * statement. Nothing else may branch on the string.
 */
export const GUESSED_ONSITE = 'default-has-metro';

const ENUM = {
  onsite: 'onsite', 'on-site': 'onsite', 'on site': 'onsite', office: 'onsite', inoffice: 'onsite',
  hybrid: 'hybrid', flexible: 'hybrid',
  remote: 'remote', virtual: 'remote', 'work from home': 'remote', anywhere: 'remote',
};

export function deriveWorkplace(job, location) {
  const raw = typeof job.raw_workplace === 'string' ? job.raw_workplace.trim().toLowerCase() : '';
  if (raw && ENUM[raw]) return { workplace: ENUM[raw], src: 'ats-enum' };
  if (raw) return { workplace: 'unknown', src: `ats-enum-unrecognised:${raw.slice(0, 24)}` };

  // No enum. The location string is the only remaining signal.
  if (location?.remoteHint) return { workplace: 'remote', src: 'location-text' };

  // `isRemote` without a `workplaceType` is rare but unambiguous in one
  // direction: false can only mean OnSite.
  if (job.raw_remote === 0) return { workplace: 'onsite', src: 'is-remote-false' };

  // A named physical place with no remote marker is an office job.
  if (location?.metros?.length) return { workplace: 'onsite', src: GUESSED_ONSITE };

  return { workplace: 'unknown', src: 'no-signal' };
}
