#!/usr/bin/env node
// Check a freshly unpacked database on the Fly volume before it goes live.
//
//   node verify-db.mjs /data/jobs.db.new
//
// `deploy/upload-db.sh` puts this file on the volume next to the database and
// runs it there over `fly ssh console`, so it uses nothing but node itself —
// the image has no sqlite3 binary. It prints one JSON line,
//
//   {"bytes":…,"quick_check":"ok","jobs":…,"open":…}
//
// and exits non-zero when the file is not a sound database. The caller
// compares `bytes` and `open` with the copy it uploaded, because the two ways
// an upload goes wrong — `fly sftp put` cutting the transfer short, and
// `fly ssh console -C` swallowing a gunzip failure — both leave a file that
// is shorter than it should be, and a short database still opens.
import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const path = process.argv[2];
if (!path) {
  console.error('usage: verify-db.mjs <database>');
  process.exit(2);
}

let out;
try {
  const bytes = statSync(path).size;
  const db = new DatabaseSync(path, { readOnly: true });
  const quick_check = Object.values(db.prepare('PRAGMA quick_check').get())[0];
  const jobs = db.prepare('SELECT COUNT(*) n FROM jobs').get().n;
  const open = db.prepare('SELECT COUNT(*) n FROM jobs WHERE is_open = 1').get().n;
  db.close();
  out = { bytes, quick_check, jobs, open };
} catch (err) {
  out = { error: err.message };
}
console.log(JSON.stringify(out));
process.exit(out.quick_check === 'ok' ? 0 : 1);
