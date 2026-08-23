/**
 * The three things every HTTP handler in this project needs: send JSON, read a
 * capped JSON body, redirect.
 *
 * Extracted from `server.mjs` when the account routes arrived and needed the
 * same helpers — a second copy would have been two places to get the body cap
 * wrong.
 */

export const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  // Served as its own type on purpose: Chrome ignores a manifest handed back as
  // application/json, so the install prompt and the home-screen icon depend on
  // this line rather than on the file being present.
  '.webmanifest': 'application/manifest+json',
};

export function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': CONTENT_TYPES['.json'],
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

export function redirect(res, location, headers = {}) {
  res.writeHead(302, { location, 'cache-control': 'no-store', ...headers });
  res.end();
}

/**
 * Read a JSON request body, capped.
 *
 * The cap is not a formality: without it, one request can hold as much memory
 * as it likes, and the bodies this server accepts are a filter document and a
 * note. Anything larger is a mistake or an attack, and both deserve the same
 * answer.
 */
export async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
