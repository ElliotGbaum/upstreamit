/**
 * Live progress bus.
 *
 * Every long-running script writes its state here; `progress/index.html` polls the
 * resulting JSON so the build can be watched while it runs. Deliberately dumb: a
 * single JSON file, atomic-replaced, no server, no dependencies. Concurrent writers
 * are fine because each owns a distinct `task` key and writes are read-modify-write
 * under a short retry loop.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PROGRESS_FILE = join(ROOT, 'progress', 'state.json');

function readState() {
  try {
    return JSON.parse(readFileSync(PROGRESS_FILE, 'utf8'));
  } catch {
    return { started: Date.now(), updated: Date.now(), tasks: {}, log: [] };
  }
}

function writeState(state) {
  mkdirSync(dirname(PROGRESS_FILE), { recursive: true });
  const tmp = `${PROGRESS_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, PROGRESS_FILE);
}

/**
 * Merge a patch into one task's entry. Returns the merged entry.
 * @param {string} task   Stable key, e.g. "sweep:ashby".
 * @param {object} patch  Any of: label, status, done, total, note, extra{}.
 */
export function report(task, patch) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const state = readState();
      const prev = state.tasks[task] ?? { task, started: Date.now() };
      const next = { ...prev, ...patch, task, updated: Date.now() };
      if (patch.status === 'done' || patch.status === 'error') next.finished = Date.now();
      state.tasks[task] = next;
      state.updated = Date.now();
      writeState(state);
      return next;
    } catch {
      // Another writer won the rename race; retry.
    }
  }
  return null;
}

/** Append a human-readable milestone to the shared log (last 400 kept). */
export function logEvent(message, level = 'info') {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const state = readState();
      state.log = [...(state.log ?? []), { at: Date.now(), level, message }].slice(-400);
      state.updated = Date.now();
      writeState(state);
      return;
    } catch {
      /* retry */
    }
  }
}

/** Record a headline number the progress page shows as a stat tile. */
export function setStat(key, value, label) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const state = readState();
      state.stats = { ...(state.stats ?? {}), [key]: { value, label, at: Date.now() } };
      state.updated = Date.now();
      writeState(state);
      return;
    } catch {
      /* retry */
    }
  }
}

/**
 * Throttled progress reporter — call freely inside a hot loop; it only writes
 * every `intervalMs`. Always flush with `.done()`.
 */
export function ticker(task, label, total, intervalMs = 1200) {
  let done = 0;
  let last = 0;
  let extra = {};
  report(task, { label, status: 'running', done: 0, total });
  return {
    tick(n = 1, patch) {
      done += n;
      if (patch) extra = { ...extra, ...patch };
      const now = Date.now();
      if (now - last >= intervalMs) {
        last = now;
        report(task, { done, total, status: 'running', ...extra });
      }
    },
    set(patch) {
      extra = { ...extra, ...patch };
    },
    done(note) {
      report(task, { done, total, status: 'done', note, ...extra });
    },
    fail(note) {
      report(task, { done, total, status: 'error', note, ...extra });
    },
  };
}
