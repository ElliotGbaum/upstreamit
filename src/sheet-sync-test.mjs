#!/usr/bin/env node
/**
 * Tests for `integrations/sheet-sync.gs`.
 *
 *   node src/sheet-sync-test.mjs
 *
 * That file runs on Google's servers, not here, which is exactly why it is
 * worth testing here: there is no way to watch it work, no log to read, and
 * the failure it is most likely to have is silent. It writes into a
 * spreadsheet that is the only record of months of applications, and a merge
 * rule that is subtly wrong does not throw — it quietly replaces a note you
 * wrote with one the app generated, and you find out weeks later with nothing
 * to restore from.
 *
 * So the property under test is not "does it sync". It is: a cell a human has
 * typed in is never written to. Cases 4, 5 and 7 below are the whole point;
 * the rest are there to prove the script still does its job while obeying it.
 *
 * The Google globals (SpreadsheetApp, UrlFetchApp, PropertiesService) are
 * stubbed and the script is run in a `vm` context, so this stays inside the
 * suite's promise: no network, no key, about a second.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
    return;
  }
  failures.push(`${name}\n      got  ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`);
}

/** The smallest fake of a Sheets range that the script actually exercises. */
function makeSheet(grid) {
  const g = grid.map((r) => r.slice());
  const pad = (row, n) => {
    while (row.length < n) row.push('');
  };
  return {
    _g: g,
    getLastRow: () => g.length,
    getLastColumn: () => Math.max(...g.map((r) => r.length)),
    getRange(row, col, nRows = 1, nCols = 1) {
      return {
        getValues() {
          const out = [];
          for (let r = row; r < row + nRows; r++) {
            while (g.length < r) g.push([]);
            const src = g[r - 1] || [];
            const line = [];
            for (let c = col; c < col + nCols; c++) line.push(src[c - 1] ?? '');
            out.push(line);
          }
          return out;
        },
        setValues(vals) {
          for (let r = 0; r < vals.length; r++) {
            while (g.length < row + r) g.push([]);
            const dst = g[row + r - 1];
            pad(dst, col + vals[r].length - 1);
            for (let c = 0; c < vals[r].length; c++) dst[col + c - 1] = vals[r][c];
          }
        },
        setValue(v) {
          while (g.length < row) g.push([]);
          pad(g[row - 1], col);
          g[row - 1][col - 1] = v;
        },
      };
    },
    appendRow(vals) {
      g.push(vals.slice());
    },
  };
}

// A tracker shaped like the real one: a spacer row above the headers, a spacer
// below them, and one row that was typed by hand long before any of this ran.
const sheet = makeSheet([
  ['', '', '', '', '', '', '', '', '', '', ''],
  ['Company', 'Role', 'Notes', 'Job Link', 'Company Size', 'Reqs', 'Where?', 'Outreach', 'ATS', 'App Status', 'Email Status'],
  ['', '', '', '', '', '', '', '', '', '', ''],
  ['Palantir', 'Deployment Strategist', 'hand-written note', '', 'Public', 'Entry Level', 'Friend', 'Rayan', '', 'Applied', ''],
]);

let payload = { saved: [] };
const sandbox = {
  console,
  Logger: { log: () => {} },
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
  SpreadsheetApp: {
    getActiveSpreadsheet: () => ({ getSheets: () => [sheet], getSheetByName: () => null }),
  },
  UrlFetchApp: {
    fetch: () => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify(payload) }),
  },
  ScriptApp: { getProjectTriggers: () => [] },
};
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, 'integrations', 'sheet-sync.gs'), 'utf8'), sandbox);
vm.runInContext("SYNC_TOKEN = 'test-token';", sandbox);

const run = (saved) => {
  payload = { saved };
  return vm.runInContext('syncFavourites()', sandbox);
};
const rowFor = (company) => sheet._g.find((r) => r[0] === company);
const col = (name) => sheet._g[1].indexOf(name);

const JOB = {
  job_id: 'ashby:acme:j1',
  ats: 'ashby',
  company: 'Acme',
  title: 'FDE',
  url: 'https://acme.test/1',
  status: 'saved',
  note: '',
  listed: true,
};

// -------------------------------------------------------- a new favourite --
check('new: one row appended', run([JOB]), '1 added, 0 updated, 0 left alone (1 starred)');
check('new: company', rowFor('Acme')[col('Company')], 'Acme');
check('new: role', rowFor('Acme')[col('Role')], 'FDE');
check('new: link', rowFor('Acme')[col('Job Link')], 'https://acme.test/1');
check('new: ats title-cased for the sheet', rowFor('Acme')[col('ATS')], 'Ashby');
check('new: status in the sheet vocabulary', rowFor('Acme')[col('App Status')], 'To Apply');
check('new: says where it came from', rowFor('Acme')[col('Where?')], 'UpstreamIt');

// The run is a poll, so it sees every job again every ten minutes. Seeing one
// twice must be a no-op, or the sheet grows a duplicate every ten minutes.
check('repeat: writes nothing', run([JOB]), '0 added, 0 updated, 1 left alone (1 starred)');
check('repeat: no second row', sheet._g.filter((r) => r[0] === 'Acme').length, 1);

// ------------------------------------------------------------ the merge --
check('advance: app moves it on, sheet follows', run([{ ...JOB, status: 'applied' }]), '0 added, 1 updated, 0 left alone (1 starred)');
check('advance: App Status updated', rowFor('Acme')[col('App Status')], 'Applied');

// The three that matter.
rowFor('Acme')[col('App Status')] = 'First Round';
check('yours wins: a hand-edited status is not overwritten', run([{ ...JOB, status: 'rejected' }]), '0 added, 0 updated, 1 left alone (1 starred)');
check('yours wins: the value you typed survives', rowFor('Acme')[col('App Status')], 'First Round');

rowFor('Acme')[col('Notes')] = 'my own note';
check('yours wins: a hand-written note is not overwritten', run([{ ...JOB, status: 'rejected', note: 'app note' }]), '0 added, 0 updated, 1 left alone (1 starred)');
check('yours wins: the note you wrote survives', rowFor('Acme')[col('Notes')], 'my own note');

// A cell you cleared is a cell you have no opinion about, so filling it is
// help rather than interference.
rowFor('Acme')[col('Job Link')] = '';
check('blank: an empty cell is filled', run([{ ...JOB, status: 'rejected' }]), '0 added, 1 updated, 0 left alone (1 starred)');
check('blank: filled with the right thing', rowFor('Acme')[col('Job Link')], 'https://acme.test/1');

// A row this script never created has no bookkeeping stamp, and must be
// invisible to it forever.
check('untouched: a row you typed keeps its note', rowFor('Palantir')[col('Notes')], 'hand-written note');
check('untouched: a row you typed keeps its status', rowFor('Palantir')[col('App Status')], 'Applied');

if (failures.length) {
  console.error(`\n${failures.length} failing:\n`);
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  console.error(`${passed} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`✓ ${passed} sheet-sync checks passed`);
