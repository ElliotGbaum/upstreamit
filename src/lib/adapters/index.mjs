/**
 * Adapter registry.
 *
 * Each module in this directory exposes the same five things:
 *
 *   id           string
 *   label        string                      display name
 *   concurrency  number                      what this host tolerates
 *   boardUrl(slug) -> string                 human-facing careers page
 *   fetchBoard(slug) -> {
 *     ok, status, bytes, etag, name, url, jobs[]   // ok: true
 *     ok:false, status, error, dead                // dead:true means 404 — do not retry
 *   }
 *
 * `jobs[]` entries are the common schema from `../schema.mjs`. Nothing outside
 * this directory may know which ATS a job came from except to display a badge.
 *
 * Loaded lazily so a broken or half-written adapter can't take down a sweep of
 * a different ATS.
 *
 * Only adapters that exist are registered. This list once named eighteen ATSes
 * — every one worth an adapter someday — and the fourteen unwritten ones made
 * `--ats=smartrecruiters` print "Known: … smartrecruiters …" in the same
 * breath as failing to load it. Adding an ATS is the module plus one line
 * here; the wish-list lives in docs/pipeline.md, not in code that claims it.
 */

const MODULES = {
  ashby: () => import('./ashby.mjs'),
  greenhouse: () => import('./greenhouse.mjs'),
  lever: () => import('./lever.mjs'),
  workday: () => import('./workday.mjs'),
};

const cache = new Map();

export async function loadAdapter(ats) {
  if (cache.has(ats)) return cache.get(ats);
  const loader = MODULES[ats];
  if (!loader) return null;
  try {
    const mod = await loader();
    cache.set(ats, mod);
    return mod;
  } catch (err) {
    console.error(`adapter "${ats}" failed to load: ${err.message}`);
    cache.set(ats, null);
    return null;
  }
}

export const ADAPTER_IDS = Object.keys(MODULES);
