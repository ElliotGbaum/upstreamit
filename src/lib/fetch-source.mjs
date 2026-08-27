/**
 * Loading and parsing upstream slug files.
 *
 * Transport is decoupled from parsing: a source declares a `kind`
 * (github-raw | http | file) and a `format` (how to read the bytes). Any origin
 * that can hand us bytes works — a GitHub repo, a plain URL, a gist, an S3 object,
 * a CSV you exported from a paid tech-lookup service and dropped in data/manual/.
 *
 * We poll rather than receive webhooks: GitHub only lets a repo *owner* register a
 * webhook, and we don't own these repos. Conditional requests (If-None-Match /
 * If-Modified-Since) make a no-change poll nearly free — a 304 costs no bandwidth.
 */

import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const RAW_BASE = 'https://raw.githubusercontent.com';
const API_BASE = 'https://api.github.com';
const USER_AGENT = 'upstreamit/0.1 (slug sync)';

/**
 * Resolve a source+file pair to a human-readable origin, for logs and reports.
 */
export function describeOrigin(source, file) {
  switch (source.kind) {
    case 'github-raw':
      return `${RAW_BASE}/${source.repo}/${source.branch ?? 'main'}/${file.path}`;
    case 'http':
      return file.url;
    case 'file':
      return `file://${file.path}`;
    default:
      return `<unknown kind: ${source.kind}>`;
  }
}

/**
 * Fetch one upstream file, skipping the download when the origin says nothing changed.
 * @returns {{status:'ok', body:string, validators:object}|{status:'unchanged'}|{status:'error', error:string}}
 */
export async function loadFile({ source, file, validators = {}, rootDir }) {
  switch (source.kind) {
    case 'github-raw':
      return httpLoad(describeOrigin(source, file), validators, file.headers ?? source.headers);
    case 'http':
      return httpLoad(file.url, validators, file.headers ?? source.headers);
    case 'file':
      return localLoad(resolve(rootDir, file.path), validators);
    default:
      return { status: 'error', error: `unknown source kind "${source.kind}"` };
  }
}

async function httpLoad(url, validators, extraHeaders) {
  const headers = { 'user-agent': USER_AGENT, accept: '*/*', ...(extraHeaders ?? {}) };
  if (validators.etag) headers['if-none-match'] = validators.etag;
  else if (validators.lastModified) headers['if-modified-since'] = validators.lastModified;

  // Allow secrets in headers to be referenced as ${ENV_VAR} in sources.json,
  // so a source needing an API key never puts the key in the repo.
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') headers[key] = expandEnv(value);
  }

  try {
    const response = await fetch(url, { headers, redirect: 'follow' });

    if (response.status === 304) return { status: 'unchanged' };
    if (!response.ok) {
      return { status: 'error', error: `HTTP ${response.status} ${response.statusText} for ${url}` };
    }

    return {
      status: 'ok',
      body: await response.text(),
      validators: {
        etag: response.headers.get('etag') ?? null,
        lastModified: response.headers.get('last-modified') ?? null,
      },
    };
  } catch (error) {
    return { status: 'error', error: `${error.name}: ${error.message} (${url})` };
  }
}

async function localLoad(absolutePath, validators) {
  try {
    const info = await stat(absolutePath);
    const stamp = `${info.size}:${info.mtimeMs}`;
    if (validators.stamp === stamp) return { status: 'unchanged' };
    return {
      status: 'ok',
      body: await readFile(absolutePath, 'utf8'),
      validators: { stamp },
    };
  } catch (error) {
    return { status: 'error', error: `${error.code ?? error.name}: ${absolutePath}` };
  }
}

function expandEnv(value) {
  return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? '');
}

/**
 * Last commit touching a specific path in a GitHub repo. Best-effort provenance:
 * it tells us how fresh a source actually is, which is the difference between a
 * live dataset and an abandoned one. Never fatal.
 */
export async function fetchLastCommit({ repo, branch = 'main', path, token }) {
  const url = `${API_BASE}/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&path=${encodeURIComponent(path)}&per_page=1`;
  const headers = {
    'user-agent': USER_AGENT,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };
  if (token) headers.authorization = `Bearer ${token}`;

  try {
    const response = await fetch(url, { headers });
    if (!response.ok) return null;
    const commit = (await response.json())?.[0];
    if (!commit) return null;
    return {
      sha: commit.sha?.slice(0, 7) ?? null,
      date: commit.commit?.committer?.date ?? commit.commit?.author?.date ?? null,
      message: (commit.commit?.message ?? '').split('\n')[0].slice(0, 120),
    };
  } catch {
    return null;
  }
}

/**
 * Turn a raw file body into an array of raw (un-normalized) slug candidates.
 * Formats are declared per-file in sources.json so adding a source with an odd
 * shape is config, not code.
 */
export function parseSlugFile(body, file) {
  const { format, path, url } = file;
  const label = path ?? url ?? '<source>';

  switch (format) {
    case 'json-array': {
      const data = selectPath(jsonParse(body, label), file.jsonPath, label);
      if (!Array.isArray(data)) throw new Error(`${label}: expected a JSON array, got ${typeName(data)}`);
      // Tolerate an array of objects where a bare array was declared.
      return data.map((entry) => (typeof entry === 'string' ? entry : pickSlugish(entry)));
    }

    case 'json-objects': {
      const data = selectPath(jsonParse(body, label), file.jsonPath, label);
      const all = Array.isArray(data) ? data : Object.values(data ?? {});
      const key = file.slugKey;
      if (!key) throw new Error(`${label}: format "json-objects" requires "slugKey"`);

      const records = file.where ? all.filter((record) => matchesWhere(record, file.where)) : all;

      // A record's slug field may itself be a list (e.g. one company with several
      // board URLs across different ATSes) — flatten so each entry is considered.
      return records.flatMap((record) => {
        if (!record || typeof record !== 'object') return [null];
        const value = record[key];
        return Array.isArray(value) ? value : [value];
      });
    }

    case 'json-keys': {
      const data = selectPath(jsonParse(body, label), file.jsonPath, label);
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error(`${label}: expected a JSON object, got ${typeName(data)}`);
      }
      return Object.keys(data);
    }

    case 'text-lines':
      return body
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'));

    case 'csv': {
      const { column, where } = file;
      if (column === undefined) throw new Error(`${label}: format "csv" requires "column"`);
      const rows = parseCsv(body);
      if (rows.length === 0) return [];
      const header = rows[0];
      const index = typeof column === 'number' ? column : header.indexOf(column);
      if (index < 0) {
        throw new Error(`${label}: CSV column "${column}" not found in header [${header.join(', ')}]`);
      }

      // A single upstream file often mixes every ATS in one table; `where` selects
      // the rows belonging to the ATS this file entry is declared for.
      let selected = rows.slice(1);
      if (where) {
        for (const name of Object.keys(where)) {
          if (!header.includes(name)) {
            throw new Error(`${label}: filter column "${name}" not found in header [${header.join(', ')}]`);
          }
        }
        selected = selected.filter((row) =>
          matchesWhere(Object.fromEntries(header.map((name, i) => [name, row[i]])), where),
        );
      }

      return selected.map((row) => row[index]);
    }

    case 'regex-scrape': {
      // For HTML/XML/source-code origins (sitemaps, search result pages, a slug
      // list hardcoded in a script) where slugs are embedded rather than published.
      if (!file.pattern) throw new Error(`${label}: format "regex-scrape" requires "pattern"`);
      const scope = sliceBetween(body, file.between, label);
      const matches = scope.matchAll(new RegExp(file.pattern, file.flags ?? 'gi'));
      return [...matches].map((match) => match[1] ?? match[0]);
    }

    default:
      throw new Error(`${label}: unknown format "${format}"`);
  }
}

/**
 * Row/record filter shared by the csv and json-objects formats. A `where` value may
 * be a scalar, a list of accepted scalars, or `{not: <scalar|list>}` to exclude —
 * enough to slice a mixed-ATS table or drop entries an upstream already marked dead.
 * Comparison is case-insensitive string equality; upstream casing is inconsistent.
 */
function matchesWhere(record, where) {
  if (!record || typeof record !== 'object') return false;
  return Object.entries(where).every(([field, expected]) => {
    const actual = String(record[field] ?? '').toLowerCase();
    if (expected && typeof expected === 'object' && !Array.isArray(expected) && 'not' in expected) {
      return !toLowerSet(expected.not).has(actual);
    }
    return toLowerSet(expected).has(actual);
  });
}

function toLowerSet(expected) {
  return new Set((Array.isArray(expected) ? expected : [expected]).map((value) => String(value).toLowerCase()));
}

/** Walk a dotted path ("data.companies") into a parsed body. */
function selectPath(data, jsonPath, label) {
  if (!jsonPath) return data;
  let cursor = data;
  for (const segment of jsonPath.split('.')) {
    if (cursor == null) throw new Error(`${label}: jsonPath "${jsonPath}" missing at "${segment}"`);
    cursor = cursor[segment];
  }
  return cursor;
}

function jsonParse(body, label) {
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`${label}: invalid JSON — ${error.message}`);
  }
}

// Common key names upstream sources use when they publish objects instead of strings.
const SLUGISH_KEYS = ['slug', 'token', 'board_token', 'boardToken', 'company', 'name', 'id', 'url'];

function pickSlugish(entry) {
  if (!entry || typeof entry !== 'object') return null;
  for (const key of SLUGISH_KEYS) {
    if (typeof entry[key] === 'string') return entry[key];
  }
  return null;
}

/**
 * RFC 4180 CSV parse. Full-document rather than line-by-line because real upstream
 * files embed JSON blobs in quoted fields, and those can contain both commas and
 * newlines — splitting on newlines first would corrupt them.
 */
function parseCsv(body) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let sawContent = false;

  const endField = () => {
    row.push(field.trim());
    field = '';
  };
  const endRow = () => {
    endField();
    if (sawContent) rows.push(row);
    row = [];
    sawContent = false;
  };

  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];

    if (inQuotes) {
      if (char === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      sawContent = true;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      sawContent = true;
    } else if (char === ',') {
      endField();
      sawContent = true;
    } else if (char === '\n') {
      endRow();
    } else if (char !== '\r') {
      field += char;
      sawContent = true;
    }
  }
  endRow();

  return rows;
}

/** Narrow a body to the region between two literal markers, for regex-scrape. */
function sliceBetween(body, between, label) {
  if (!between) return body;
  const [startMarker, endMarker] = between;
  const start = body.indexOf(startMarker);
  if (start < 0) throw new Error(`${label}: start marker ${JSON.stringify(startMarker)} not found`);
  const from = start + startMarker.length;
  const end = endMarker ? body.indexOf(endMarker, from) : -1;
  return end < 0 ? body.slice(from) : body.slice(from, end);
}

function typeName(value) {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}
