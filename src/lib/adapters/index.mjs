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
 */

const MODULES = {
  ashby: () => import('./ashby.mjs'),
  greenhouse: () => import('./greenhouse.mjs'),
  lever: () => import('./lever.mjs'),
  smartrecruiters: () => import('./smartrecruiters.mjs'),
  workable: () => import('./workable.mjs'),
  recruitee: () => import('./recruitee.mjs'),
  breezy: () => import('./breezy.mjs'),
  pinpoint: () => import('./pinpoint.mjs'),
  rippling: () => import('./rippling.mjs'),
  jazzhr: () => import('./jazzhr.mjs'),
  teamtailor: () => import('./teamtailor.mjs'),
  personio: () => import('./personio.mjs'),
  workday: () => import('./workday.mjs'),
  bamboohr: () => import('./bamboohr.mjs'),
  jobvite: () => import('./jobvite.mjs'),
  paylocity: () => import('./paylocity.mjs'),
  polymer: () => import('./polymer.mjs'),
  dover: () => import('./dover.mjs'),
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

/** Adapter ids that actually resolve right now. */
export async function availableAdapters() {
  const out = [];
  for (const key of Object.keys(MODULES)) {
    if (await loadAdapter(key)) out.push(key);
  }
  return out;
}

export const ADAPTER_IDS = Object.keys(MODULES);
