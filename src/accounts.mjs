#!/usr/bin/env node
/**
 * Account administration, from the machine the database is on.
 *
 *   node src/accounts.mjs --list
 *   node src/accounts.mjs --passwd=elliot@example.com
 *   node src/accounts.mjs --delete=elliot@example.com
 *   node src/accounts.mjs --sessions=elliot@example.com   # sign them out everywhere
 *
 * This exists because there is no mail server. A hosted product resets a
 * password by emailing a link; this one is a local app with a SQLite file next
 * to it, so the equivalent authority is *having the file* — which is the same
 * authority that could read the database directly anyway. Pretending otherwise
 * would mean building a mailer to protect a secret that whoever runs this
 * command already has physical access to.
 *
 * The new password is read from the terminal with echo off, never from a flag:
 * an argument lands in shell history and in `ps` output for every other user on
 * the machine.
 */

import { createInterface } from 'node:readline';
import { stdin, stdout, argv, exit } from 'node:process';
import {
  openUsersDb,
  listUsers,
  findByEmail,
  setPassword,
  deleteUser,
  destroyAllSessions,
  identitiesFor,
} from './lib/users/store.mjs';
import { MIN_PASSWORD_LENGTH } from './lib/users/auth.mjs';

function parseArgs(args) {
  const out = { db: undefined };
  for (const arg of args.slice(2)) {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
    out[key] = value;
  }
  return out;
}

const stamp = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '—');

/** Read a line with the terminal's echo off, so the password is not on screen. */
function askSecret(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stdout, terminal: true });
    const onData = (char) => {
      // Re-write the prompt without the typed characters. readline echoes as it
      // goes; this keeps the line looking empty.
      if (![`\n`, `\r`, ``].includes(String(char))) stdout.write(`\x1B[2K\x1B[200D${prompt}`);
    };
    stdin.on('data', onData);
    rl.question(prompt, (answer) => {
      stdin.off('data', onData);
      rl.close();
      stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main() {
  const args = parseArgs(argv);
  const db = openUsersDb(args.db);

  if (args.list || Object.keys(args).length === 1) {
    const rows = listUsers(db);
    if (!rows.length) {
      console.log('\n  No accounts yet. One is created the first time someone signs up in the app.\n');
      return;
    }
    console.log(`\n  ${rows.length} account${rows.length === 1 ? '' : 's'}\n`);
    for (const row of rows) {
      const how = [row.password_hash ? 'password' : null, ...identitiesFor(db, row.id).map((i) => i.provider)]
        .filter(Boolean)
        .join(' + ');
      console.log(
        `  ${row.email.padEnd(34)} ${String(row.saved).padStart(4)} saved  ` +
          `${String(row.profiles).padStart(2)} profiles  joined ${stamp(row.created_at)}  seen ${stamp(row.last_seen_at)}  [${how || 'no sign-in method'}]`,
      );
    }
    console.log('');
    return;
  }

  if (args.passwd) {
    const user = findByEmail(db, args.passwd);
    if (!user) fail(`No account for ${args.passwd}`);
    const password = await askSecret(`New password for ${user.email}: `);
    if (password.length < MIN_PASSWORD_LENGTH) fail(`Too short — at least ${MIN_PASSWORD_LENGTH} characters.`);
    const again = await askSecret('Again: ');
    if (password !== again) fail('Those do not match.');
    await setPassword(db, user.id, password);
    console.log(`\n  Password set for ${user.email}. Every existing session has been signed out.\n`);
    return;
  }

  if (args.sessions) {
    const user = findByEmail(db, args.sessions);
    if (!user) fail(`No account for ${args.sessions}`);
    const dropped = destroyAllSessions(db, user.id);
    console.log(`\n  Signed ${user.email} out of ${dropped} session${dropped === 1 ? '' : 's'}.\n`);
    return;
  }

  if (args.delete) {
    const user = findByEmail(db, args.delete);
    if (!user) fail(`No account for ${args.delete}`);
    // Said out loud because it cannot be undone and the saved jobs are the part
    // that is not recoverable from anywhere else.
    const counts = db
      .prepare('SELECT COUNT(*) n FROM saved_jobs WHERE user_id = ?')
      .get(user.id).n;
    console.log(`\n  This deletes ${user.email}, ${counts} saved job${counts === 1 ? '' : 's'}, their lists and their profiles.`);
    const answer = await ask(`  Type the email to confirm: `);
    if (answer.trim().toLowerCase() !== user.email) fail('Not deleted.');
    deleteUser(db, user.id);
    console.log(`\n  Deleted ${user.email}.\n`);
    return;
  }

  console.log(`
  node src/accounts.mjs --list                    every account, with what it holds
  node src/accounts.mjs --passwd=<email>          set a password (prompted, not echoed)
  node src/accounts.mjs --sessions=<email>        sign that account out everywhere
  node src/accounts.mjs --delete=<email>          delete it and everything it holds
  node src/accounts.mjs --db=<path>               a users database somewhere else
`);
}

function ask(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function fail(message) {
  console.error(`\n  ${message}\n`);
  exit(1);
}

main().catch((err) => {
  console.error(err);
  exit(1);
});
