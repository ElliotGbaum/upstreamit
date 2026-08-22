#!/usr/bin/env node
/**
 * Static server for the live progress page.
 *
 * Exists only because `fetch('state.json')` from a `file://` page is blocked by
 * the same-origin policy, so the page cannot poll without an http origin.
 * Deliberately separate from the app server: this must stay up even while the
 * app is being rebuilt, since watching the build is the entire point.
 *
 *   node src/progress-server.mjs            # http://localhost:7788
 *   node src/progress-server.mjs --port=8080
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'progress');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const port = Number(
  process.argv.slice(2).find((a) => a.startsWith('--port='))?.split('=')[1] ?? 7788,
);

const server = createServer(async (req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');

  // Contain the served path inside ROOT — this is a dev server, but a traversal
  // bug here would expose the whole disk to anything on localhost.
  const target = normalize(join(ROOT, rel));
  if (!target.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    await stat(target);
    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': TYPES[extname(target)] ?? 'application/octet-stream',
      // The page polls state.json every 2s; a cached response would freeze it.
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    if (rel === 'state.json') {
      // The page renders a friendly "waiting" state for a well-formed empty doc.
      res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' });
      res.end(JSON.stringify({ started: Date.now(), updated: Date.now(), tasks: {}, log: [] }));
      return;
    }
    res.writeHead(404).end('not found');
  }
});

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(port, () => {
    console.log(`progress → http://localhost:${port}`);
  });
}
