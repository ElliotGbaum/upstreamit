#!/usr/bin/env node
/**
 * Step 1 of the pipeline: pull ATS company slugs from every configured source,
 * normalize them, deduplicate across sources, and write a canonical per-ATS store.
 *
 *   node src/sync-slugs.mjs                 # sync everything
 *   node src/sync-slugs.mjs --ats=ashby     # one ATS only
 *   node src/sync-slugs.mjs --check         # report drift, write nothing (exit 1 if changed)
 *   node src/sync-slugs.mjs --dry-run       # do the work, write nothing
 *   node src/sync-slugs.mjs --force         # ignore ETags, re-download everything
 *   node src/sync-slugs.mjs --sources=a,b   # limit to specific source ids
 *   node src/sync-slugs.mjs --prune-after=60  # drop slugs absent from all sources for 60+ days
 *       (deliberately manual, run by nobody on a schedule: a retracted record
 *       keeps its first_seen and stops a dead slug being re-added as new, so
 *       the tracked-vs-active gap in the report is provenance, not cruft)
 *
 * Output:
 *   data/slugs/<ats>.json   canonical store, slug -> { sources, first_seen, last_seen }
 *   data/slugs/<ats>.txt    flat newline list of active slugs (for piping into the sweeper)
 *   data/sync-state.json    ETag / Last-Modified validators, so re-runs are cheap
 *   data/sync-report.md     human-readable diff of the latest run
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describeOrigin, fetchLastCommit, loadFile, parseSlugFile } from './lib/fetch-source.mjs';
import { normalizeSlug } from './lib/normalize.mjs';
import { diffStore, mergeStore, unreadSourceCarry } from './lib/slug-store.mjs';

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SLUG_DIR = join(ROOT, 'data', 'slugs');
const STATE_PATH = join(ROOT, 'data', 'sync-state.json');
const REPORT_PATH = join(ROOT, 'data', 'sync-report.md');

const options = parseArgs(process.argv.slice(2));
const runAt = new Date().toISOString();

const summary = await main();
process.exit(summary.exitCode);

async function main() {
  const registry = JSON.parse(await readFile(join(ROOT, 'sources.json'), 'utf8'));
  const state = await readJson(STATE_PATH, { files: {} });
  const token = await resolveGithubToken();

  // `enabled: false` is an edit to the registry and means "this source no longer
  // speaks for anything", so its claims are allowed to lapse. `--sources` is a
  // CLI convenience meaning "only run these now", which is a different thing
  // entirely — see the carry-over seeded below.
  const enabled = registry.sources.filter((source) => source.enabled !== false);
  const sources = enabled.filter((source) => !options.sources || options.sources.includes(source.id));

  if (sources.length === 0) {
    console.error('No sources selected. Check sources.json and --sources.');
    return { exitCode: 1 };
  }

  // Sources that report only what is new rather than the full population, so a
  // slug's absence from their reply must never retract an earlier claim.
  const incrementalSources = new Set(sources.filter((source) => source.incremental).map((source) => source.id));

  // atsKey -> Map<slug, Set<sourceId>>  — this run's observed truth.
  const observed = new Map();
  // Sources whose contribution we could not refresh; their prior claims must be preserved.
  const carriedOver = new Map(); // atsKey -> Set<sourceId>
  const fileResults = [];

  // A source `--sources` left out was not read, and a source that was not read
  // has said nothing — which is not the same as having stopped claiming its
  // slugs. Without this, `--sources=wayback` writes a store containing only what
  // Wayback happened to return, silently retracting the tens of thousands of
  // slugs every other source stands behind. Same rule as a 304 or a failed
  // fetch, for the same reason: only a source we actually re-read gets its
  // claims recomputed.
  for (const { ats, sourceId } of unreadSourceCarry(enabled, sources)) {
    addCarryOver(carriedOver, ats, sourceId);
  }

  for (const source of sources) {
    for (const file of source.files) {
      if (options.ats && file.ats !== options.ats) continue;

      const origin = describeOrigin(source, file);
      const stateKey = `${source.id}:${file.ats}:${file.path ?? file.url ?? file.urlPattern}`;
      const validators = options.force ? {} : (state.files[stateKey]?.validators ?? {});

      const result = await loadFile({ source, file, validators, rootDir: ROOT });

      if (result.status === 'unchanged') {
        fileResults.push({ source, file, origin, status: 'unchanged', stateKey });
        addCarryOver(carriedOver, file.ats, source.id);
        continue;
      }

      if (result.status === 'error') {
        const severity = source.optional ? 'skipped' : 'error';
        fileResults.push({ source, file, origin, status: severity, error: result.error, stateKey });
        addCarryOver(carriedOver, file.ats, source.id);
        continue;
      }

      let rawCandidates;
      try {
        rawCandidates = parseSlugFile(result.body, file);
      } catch (error) {
        fileResults.push({ source, file, origin, status: 'error', error: error.message, stateKey });
        addCarryOver(carriedOver, file.ats, source.id);
        continue;
      }

      const accepted = new Set();
      let rejected = 0;
      for (const candidate of rawCandidates) {
        const slug = normalizeSlug(candidate, file.ats);
        if (slug) accepted.add(slug);
        else rejected += 1;
      }

      const bucket = mapGet(observed, file.ats, () => new Map());
      for (const slug of accepted) mapGet(bucket, slug, () => new Set()).add(source.id);

      const commit =
        source.kind === 'github-raw'
          ? await fetchLastCommit({ repo: source.repo, branch: source.branch, path: file.path, token })
          : null;

      fileResults.push({
        source,
        file,
        origin,
        status: 'fetched',
        stateKey,
        raw: rawCandidates.length,
        accepted: accepted.size,
        rejected,
        commit,
        validators: result.validators,
      });
    }
  }

  const atsKeys = [...new Set(fileResults.map((entry) => entry.file.ats))].sort();
  const diffs = [];

  for (const ats of atsKeys) {
    const storePath = join(SLUG_DIR, `${ats}.json`);
    const previous = await readJson(storePath, { ats, slugs: {} });
    const carried = carriedOver.get(ats) ?? new Set();
    const merged = mergeStore({
      previous: previous.slugs ?? {},
      observed: observed.get(ats) ?? new Map(),
      carriedSources: carried,
      incrementalSources,
      now: runAt,
      pruneAfter: options.pruneAfter ?? null,
    });

    const diff = diffStore(previous.slugs ?? {}, merged.slugs, ats);
    diff.pruned = merged.pruned;
    diffs.push(diff);

    if (!options.dryRun && !options.check) {
      await mkdir(SLUG_DIR, { recursive: true });
      const activeSlugs = Object.entries(merged.slugs)
        .filter(([, record]) => record.sources.length > 0)
        .map(([slug]) => slug)
        .sort();

      await writeFile(
        storePath,
        `${JSON.stringify(
          {
            ats,
            generated_at: runAt,
            active_count: activeSlugs.length,
            total_count: Object.keys(merged.slugs).length,
            source_ids: [...new Set(Object.values(merged.slugs).flatMap((r) => r.sources))].sort(),
            slugs: sortObject(merged.slugs),
          },
          null,
          2,
        )}\n`,
      );
      await writeFile(join(SLUG_DIR, `${ats}.txt`), activeSlugs.length ? `${activeSlugs.join('\n')}\n` : '');
    }
  }

  if (!options.dryRun && !options.check) {
    for (const entry of fileResults) {
      if (entry.status === 'fetched') {
        state.files[entry.stateKey] = {
          validators: entry.validators,
          last_fetched: runAt,
          last_count: entry.accepted,
          origin: entry.origin,
        };
      }
    }
    state.last_run = runAt;
    await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
  }

  const report = renderReport({ fileResults, diffs, atsKeys });
  if (!options.dryRun && !options.check) await writeFile(REPORT_PATH, report);

  printConsole({ fileResults, diffs });

  const hardErrors = fileResults.filter((entry) => entry.status === 'error');
  const changed = diffs.some((diff) => diff.added.length || diff.removed.length);

  if (hardErrors.length) return { exitCode: 1 };
  if (options.check && changed) return { exitCode: 1 };
  return { exitCode: 0 };
}

function renderReport({ fileResults, diffs, atsKeys }) {
  const lines = [`# Slug sync report`, '', `Run: ${runAt}`, ''];

  lines.push('## Sources', '');
  lines.push('| Source | ATS | Status | Accepted | Rejected | Upstream commit |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const entry of fileResults) {
    const commit = entry.commit ? `\`${entry.commit.sha}\` ${entry.commit.date?.slice(0, 10) ?? ''}` : '—';
    lines.push(
      `| ${entry.source.id} | ${entry.file.ats} | ${entry.status}${entry.error ? ` — ${entry.error}` : ''} | ` +
        `${entry.accepted ?? '—'} | ${entry.rejected ?? '—'} | ${commit} |`,
    );
  }

  lines.push('', '## Store', '');
  lines.push('| ATS | Active slugs | Added | Removed | Tracked total |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const diff of diffs) {
    lines.push(`| ${diff.ats} | ${diff.active} | +${diff.added.length} | -${diff.removed.length} | ${diff.total} |`);
  }

  for (const diff of diffs) {
    const contributors = Object.entries(diff.perSource);
    if (contributors.length === 0) continue;
    lines.push('', `### ${diff.ats} — contribution by source`, '');
    lines.push('| Source | Slugs | Unique to this source |');
    lines.push('| --- | --- | --- |');
    for (const [sourceId, counts] of contributors.sort((a, b) => b[1].total - a[1].total)) {
      lines.push(`| ${sourceId} | ${counts.total} | ${counts.unique} |`);
    }
    if (diff.added.length) lines.push('', `Added: ${preview(diff.added)}`);
    if (diff.removed.length) lines.push('', `Removed: ${preview(diff.removed)}`);
    if (diff.pruned.length) lines.push('', `Pruned: ${preview(diff.pruned)}`);
  }

  void atsKeys;
  return `${lines.join('\n')}\n`;
}

function printConsole({ fileResults, diffs }) {
  const mode = options.check ? ' [check]' : options.dryRun ? ' [dry-run]' : '';
  console.log(`\nSlug sync${mode} — ${runAt}\n`);

  for (const entry of fileResults) {
    const icon = { fetched: '✓', unchanged: '·', skipped: '~', error: '✗' }[entry.status];
    const detail =
      entry.status === 'fetched'
        ? `${entry.accepted} slugs${entry.rejected ? ` (${entry.rejected} rejected)` : ''}`
        : entry.status === 'unchanged'
          ? 'not modified upstream'
          : (entry.error ?? '');
    console.log(`  ${icon} ${entry.source.id.padEnd(12)} ${entry.file.ats.padEnd(14)} ${detail}`);
  }

  console.log('');
  for (const diff of diffs) {
    const delta = [];
    if (diff.added.length) delta.push(`+${diff.added.length}`);
    if (diff.removed.length) delta.push(`-${diff.removed.length}`);
    if (diff.pruned.length) delta.push(`pruned ${diff.pruned.length}`);
    console.log(
      `  ${diff.ats.padEnd(14)} ${String(diff.active).padStart(6)} active` +
        (delta.length ? `   ${delta.join(' ')}` : ''),
    );
  }

  const errors = fileResults.filter((entry) => entry.status === 'error');
  if (errors.length) {
    console.log(`\n${errors.length} source(s) failed:`);
    for (const entry of errors) console.log(`  ✗ ${entry.source.id} ${entry.file.ats}: ${entry.error}`);
  }
  console.log('');
}

function preview(list, limit = 20) {
  const shown = list.slice(0, limit).join(', ');
  return list.length > limit ? `${shown}, … (${list.length} total)` : shown;
}

function parseArgs(argv) {
  const parsed = { dryRun: false, check: false, force: false, ats: null, sources: null, pruneAfter: null };
  for (const arg of argv) {
    if (arg === '--dry-run') parsed.dryRun = true;
    else if (arg === '--check') parsed.check = true;
    else if (arg === '--force') parsed.force = true;
    else if (arg.startsWith('--ats=')) parsed.ats = arg.slice(6);
    else if (arg.startsWith('--sources=')) parsed.sources = arg.slice(10).split(',').filter(Boolean);
    else if (arg.startsWith('--prune-after=')) parsed.pruneAfter = Number(arg.slice(14));
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return parsed;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

/** GitHub token is optional — it only enriches commit provenance in the report. */
async function resolveGithubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], { timeout: 5000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Record that a source's contribution for this ATS could not be re-read this run
 * (304 unchanged, or a fetch failure). Its previous claims are then preserved rather
 * than treated as deletions — otherwise one upstream hiccup would look like
 * thousands of companies disappearing.
 */
function addCarryOver(carriedOver, ats, sourceId) {
  mapGet(carriedOver, ats, () => new Set()).add(sourceId);
}

function mapGet(map, key, create) {
  if (!map.has(key)) map.set(key, create());
  return map.get(key);
}

function sortObject(object) {
  return Object.fromEntries(Object.entries(object).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
