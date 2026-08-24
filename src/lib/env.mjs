/**
 * Reads `.env` at the project root into `process.env`, if there is one.
 *
 * Import this first, for its side effect, from anything that reads a secret out
 * of the environment:
 *
 *   import './lib/env.mjs';
 *
 * **A real environment variable still wins.** `process.loadEnvFile()` fills in
 * names that are not already set and leaves the ones that are alone, which is
 * the precedence every other config in this project already uses: environment
 * first, file second, dormant when neither is there. So `.env` is the laptop
 * convenience — one file, survives closing the terminal — and the deployed copy
 * keeps working exactly as docs/deploy.md describes, where `fly secrets set`
 * puts the key in the real environment and no `.env` is shipped at all.
 *
 * The path is resolved from this file rather than the working directory, so
 * `node src/server.mjs` finds the same `.env` whether it was started from the
 * project root, from a launchd job, or from anywhere else.
 *
 * Missing or malformed, it does nothing. A key that is not there is not an
 * error here: `aiConfig()` in interpret.mjs reports the feature as off and the
 * page says how to turn it on, which is a better answer than a crash at boot
 * for a server whose other routes do not need a key.
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

try {
  process.loadEnvFile(join(ROOT, '.env'));
} catch {
  /* no .env, or an unreadable one — the environment is whatever the shell set */
}
