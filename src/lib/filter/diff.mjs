/**
 * "What's new since yesterday."
 *
 * The single most useful thing this project produces. A profile that returns
 * 276 jobs is worth reading once; re-reading it every morning is not. What
 * changes overnight is a handful of postings, and that handful is the output
 * that matters.
 *
 * Ashby publishes no `updatedAt`, so none of this can be a timestamp
 * comparison. It comes instead from `job_events`, which the sweep writes one
 * row per job per day it appeared, changed, reappeared or vanished — the reason
 * that table exists at all. `changed` is detected by the content hash the sweep
 * stores, since an edited posting is otherwise indistinguishable from an
 * untouched one.
 *
 * This returns id sets rather than jobs, so the caller runs them back through
 * the ordinary filter engine (`search(db, profile, { restrictTo })`). A diff
 * that reimplemented the criteria would drift from the filter it is a diff of.
 */

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` for a timestamp, in the same UTC form the sweep writes. */
export function day(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Resolve the many ways someone says "since when".
 *
 *   '2026-08-20'   an explicit day (inclusive)
 *   'yesterday'    the day before the newest sweep day, not before *today* —
 *                  a laptop that was asleep for a week should still show what
 *                  the last sweep found rather than an empty list
 *   'last-sweep'   the newest day in the event log
 *   '7d' / 7       N days back from the newest sweep day
 */
export function resolveSince(db, since) {
  const latest = db.prepare('SELECT MAX(day) d FROM job_events').get()?.d ?? day();

  if (since == null || since === '' || since === 'last-sweep') return { from: latest, latest };
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(since))) return { from: String(since), latest };

  const days = String(since) === 'yesterday' ? 1 : Number(String(since).replace(/d$/, ''));
  if (Number.isFinite(days)) {
    const base = Date.parse(`${latest}T00:00:00Z`);
    return { from: day(base - days * DAY_MS), latest };
  }
  throw new Error(`Cannot read "${since}" as a date — use YYYY-MM-DD, yesterday, last-sweep, or 7d`);
}

/**
 * Jobs that first showed up on or after `since`.
 *
 * `reappeared` counts as new on purpose: a role that was pulled and re-posted
 * is a live opening again, and burying it because its id is old would hide
 * exactly the postings that are actively being worked.
 */
export function newSince(db, since) {
  const { from, latest } = resolveSince(db, since);
  const rows = db
    .prepare(
      `SELECT DISTINCT job_id FROM job_events
       WHERE day >= ? AND event IN ('appeared', 'reappeared')`,
    )
    .all(from);
  return {
    ids: new Set(rows.map((r) => r.job_id)),
    from,
    latest,
    label: from === latest ? `on ${from}` : `since ${from}`,
  };
}

/** Jobs whose content hash moved — an edited posting, on an API with no `updatedAt`. */
export function changedSince(db, since) {
  const { from, latest } = resolveSince(db, since);
  const rows = db
    .prepare(`SELECT DISTINCT job_id FROM job_events WHERE day >= ? AND event = 'changed'`)
    .all(from);
  return { ids: new Set(rows.map((r) => r.job_id)), from, latest };
}

/**
 * Jobs that stopped being listed, on the days they stopped. Returned with their
 * stored row rather than an id set, because this is a history view: it answers
 * "what closed this week", which is a question about `job_events` and not about
 * the current corpus.
 *
 * `search` can now reach a closed job too — `include_unlisted` lifts the
 * `listed` criterion, and the index holds them. The two are different questions
 * and both are worth asking: this one is ordered by the day it went away, that
 * one ranks a closed posting beside the open ones it competes with.
 */
export function goneSince(db, since) {
  const { from, latest } = resolveSince(db, since);
  const rows = db
    .prepare(
      `SELECT j.id, j.title, j.company_name, j.url, j.d_metros, j.d_workplace, j.last_seen, e.day
       FROM job_events e JOIN jobs j ON j.id = e.job_id
       WHERE e.day >= ? AND e.event = 'disappeared' AND j.is_open = 0
       ORDER BY e.day DESC, j.company_name`,
    )
    .all(from);
  return { rows, from, latest };
}

const activityCache = new Map(); // `${limitDays}` -> { stamp, value }

/**
 * Per-day counts of every event kind — the shape of the corpus over time.
 *
 * Cached until a new event is logged. This is a `GROUP BY` over the whole event
 * table — 16 ms locally, ~70 ms on the deployed machine — and `/api/meta` asks
 * for it on every page load, in front of the first search. `MAX(rowid)` is an
 * index seek to the last row of an integer primary key and costs nothing, so
 * "has anything happened since?" is cheaper than answering again.
 */
export function activity(db, limitDays = 30) {
  const stamp = db.prepare('SELECT MAX(rowid) n FROM job_events').get()?.n ?? 0;
  const hit = activityCache.get(limitDays);
  if (hit && hit.stamp === stamp) return hit.value;

  const rows = db
    .prepare(
      `SELECT day, event, COUNT(*) n FROM job_events
       GROUP BY day, event ORDER BY day DESC LIMIT ?`,
    )
    .all(limitDays * 4);
  const byDay = new Map();
  for (const row of rows) {
    if (!byDay.has(row.day)) byDay.set(row.day, { day: row.day, appeared: 0, changed: 0, disappeared: 0, reappeared: 0 });
    byDay.get(row.day)[row.event] = row.n;
  }
  const value = [...byDay.values()].slice(0, limitDays);
  activityCache.set(limitDays, { stamp, value });
  return value;
}
