#!/usr/bin/env node
/**
 * Reclaim the disk that a dropped column left behind.
 *
 *   node src/vacuum.mjs            # data/jobs.db
 *   node src/vacuum.mjs --db=x.db
 *
 * Two separate things are reclaimed here and they are not the same thing.
 *
 * **The WAL.** Every write since the last checkpoint lives in `jobs.db-wal`
 * rather than in the database, and a busy sweep can leave that file north of a
 * gigabyte. `wal_checkpoint(TRUNCATE)` folds it back in and resets it to zero.
 *
 * **Free pages.** `ALTER TABLE ... DROP COLUMN` marks the column's pages
 * reusable but does not return them: the file stays exactly as large as it was
 * and the space is spent on the next insert instead. `VACUUM` rewrites the
 * database without them, which is what actually shrinks the file.
 *
 * VACUUM needs the database to itself and builds its replacement alongside the
 * original, so leave roughly the current size free on disk and stop the server
 * first -- an open connection is what "database is locked" means here.
 */

import { statSync } from 'node:fs';
import { openDb, DEFAULT_DB_PATH } from './lib/db.mjs';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const path = arg('db', DEFAULT_DB_PATH);
const mb = (bytes) => (bytes / 1024 ** 2).toFixed(0).padStart(6);
const sizeOf = (p) => {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
};
const total = (p) => sizeOf(p) + sizeOf(`${p}-wal`) + sizeOf(`${p}-shm`);

const before = total(path);
console.log(`before ${mb(before)} MB`);

// Opening non-readonly runs `migrate()`, which is what drops any column listed
// in DROPPED_COLUMNS. The VACUUM below is then what the drop costs nothing
// without.
const db = openDb(path);

db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
console.log('checkpointed');

db.exec('VACUUM;');
console.log('vacuumed');

// Again, and this is the one that matters. VACUUM rebuilds every page in the
// database, and in WAL mode those writes land in the WAL like any others -- so
// the step that shrinks `jobs.db` leaves `jobs.db-wal` holding a full copy of
// it. Checkpointing only before the VACUUM measures a win the file does not
// have yet.
db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
console.log('checkpointed again');

db.close();

const after = total(path);
console.log(`after  ${mb(after)} MB`);
console.log(`freed  ${mb(before - after)} MB`);
