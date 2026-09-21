#!/usr/bin/env node
// Join the parts of a split upload back into one file, on the Fly machine.
//
//   node join-parts.mjs /data/jobs.db.new.gz /data/jobs-deploy.db.gz.part- 12
//
// `deploy/upload-db.sh` sends the archive as 256 MB parts because `fly sftp
// put` drops long transfers now and then — and a deploy restarting the machine
// under the session drops them every time — so a drop should cost one part,
// not the whole hour. The parts are named <prefix>000, <prefix>001, … and the
// count is given explicitly: exactly that many are joined, in order, a missing
// one is an error, and any other file with the prefix is a leftover from an
// earlier run and is deleted rather than appended. Each part is deleted as it
// is consumed. This runs over `fly ssh console -C`, which has no shell to
// redirect or glob with, hence a script rather than `cat a b > c`. Prints one
// JSON line on success.
import { createReadStream, createWriteStream, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

const [target, prefix, countArg] = process.argv.slice(2);
const count = Number(countArg);
if (!target || !prefix || !Number.isInteger(count) || count < 1) {
  console.error('usage: join-parts.mjs <target> <part prefix> <count>');
  process.exit(2);
}

const wanted = Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(3, '0')}`);
const missing = wanted.filter((p) => !existsSync(p));
if (missing.length) {
  console.error(`missing ${missing.length} part(s): ${missing.slice(0, 3).join(', ')}`);
  process.exit(1);
}
const dir = dirname(prefix);
const stem = basename(prefix);
const extras = readdirSync(dir)
  .filter((f) => f.startsWith(stem))
  .map((f) => join(dir, f))
  .filter((p) => !wanted.includes(p));
for (const p of extras) unlinkSync(p);

const out = createWriteStream(target);
let bytes = 0;
for (const p of wanted) {
  await pipeline(createReadStream(p), out, { end: false });
  bytes += statSync(p).size;
  unlinkSync(p);
}
await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
const size = statSync(target).size;
console.log(JSON.stringify({ parts: count, extras_removed: extras.length, bytes, size }));
process.exit(bytes === size ? 0 : 1);
