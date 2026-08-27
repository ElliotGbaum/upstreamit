/**
 * Favourites -> job tracker sync.
 *
 * Runs inside the tracker spreadsheet, on a timer. Every run it asks the app
 * for the jobs you have starred and writes the new ones in as rows.
 *
 * ---------------------------------------------------------------- install --
 *
 *   1. In the spreadsheet: Extensions -> Apps Script.
 *   2. Paste this whole file over whatever is in Code.gs, and Save.
 *   3. Mint a token on the machine the database is on:
 *          node src/accounts.mjs --sync-token=you@example.com
 *      Paste it into SYNC_TOKEN below. It is shown once.
 *   4. Run `syncFavourites` once by hand. Google will ask for permission the
 *      first time -- it needs to read your sheet and reach the app.
 *   5. Run `installTrigger` once. From then on it runs every ten minutes.
 *
 * ---------------------------------------------------- what it will not do --
 *
 * It never overwrites something you typed. That is the whole safety property,
 * and it is worth stating plainly because a sync that gets this wrong eats
 * work silently: you notice a week later that a note is gone, with nothing to
 * restore it from.
 *
 * The rule is a three-way comparison, not a two-way one. Alongside each row
 * the script keeps a note of what it last wrote there. On the next run a cell
 * is safe to update only if it still holds exactly that -- meaning nobody has
 * touched it since. The moment a cell differs from what the script last wrote,
 * the script has been overruled by a human and stops writing that cell for
 * good. Comparing only "app value" against "sheet value" cannot tell an edit
 * you made from an edit it made, which is how these things overwrite people.
 */

// ------------------------------------------------------------------ config --

/** Where the app lives. No trailing slash. */
var APP_URL = 'https://job-finder-ats.fly.dev';

/**
 * The read token from `--sync-token`. It can read your saved list and nothing
 * else: it cannot sign in, cannot change anything, and cannot reach the rest
 * of the account. Revoke it any time with `--revoke-sync`.
 *
 * If you would rather not keep it in the code, put it in Project Settings ->
 * Script Properties under the key SYNC_TOKEN and leave this blank.
 */
var SYNC_TOKEN = 'PASTE_YOUR_TOKEN_HERE';

/** Which tab to write to. Blank means the first one. */
var SHEET_NAME = '';

/** Optional tab to append a one-line record of each run to. Blank to skip. */
var LOG_SHEET_NAME = '';

/**
 * App status -> what your sheet calls it.
 *
 * Left side is the app's vocabulary and is fixed; right side is yours, so
 * change it to whatever you actually type in the App Status column.
 */
var STATUS_LABELS = {
  saved: 'To Apply',
  applied: 'Applied',
  interviewing: 'First Round',
  offer: 'Offer',
  rejected: 'Rejected',
};

/** Where each field goes, by column heading. A heading it cannot find is skipped. */
var COLUMNS = {
  company: 'Company',
  role: 'Role',
  notes: 'Notes',
  link: 'Job Link',
  where: 'Where?',
  ats: 'ATS',
  status: 'App Status',
};

/** What goes in the "Where?" column for a job that arrived this way. */
var SOURCE_LABEL = 'UpstreamIt';

/** The two bookkeeping columns, added at the far right. Safe to hide. */
var ID_HEADER = '_job_id';
var SYNCED_HEADER = '_last_synced';

// ------------------------------------------------------------------- entry --

function syncFavourites() {
  var token = SYNC_TOKEN;
  try {
    var stored = PropertiesService.getScriptProperties().getProperty('SYNC_TOKEN');
    if (stored) token = stored;
  } catch (e) {
    // Script Properties unavailable; the constant above is the only source.
  }
  if (!token || token === 'PASTE_YOUR_TOKEN_HERE') {
    throw new Error('No sync token. Run: node src/accounts.mjs --sync-token=you@example.com');
  }

  var payload = fetchSaved(token);
  var sheet = targetSheet();
  var layout = readLayout(sheet);
  var result = applyRows(sheet, layout, payload.saved);

  var summary =
    result.added + ' added, ' + result.updated + ' updated, ' +
    result.skipped + ' left alone (' + payload.saved.length + ' starred)';
  Logger.log(summary);
  writeLog(summary);
  return summary;
}

/** Create the ten-minute trigger. Running it twice will not make two. */
function installTrigger() {
  removeTrigger();
  ScriptApp.newTrigger('syncFavourites').timeBased().everyMinutes(10).create();
  Logger.log('Trigger installed: syncFavourites every 10 minutes.');
}

function removeTrigger() {
  var all = ScriptApp.getProjectTriggers();
  for (var i = 0; i < all.length; i++) {
    if (all[i].getHandlerFunction() === 'syncFavourites') ScriptApp.deleteTrigger(all[i]);
  }
}

// ------------------------------------------------------------------ fetch --

function fetchSaved(token) {
  var response = UrlFetchApp.fetch(APP_URL + '/api/export/saved', {
    method: 'get',
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true,
  });
  var code = response.getResponseCode();
  if (code === 401) throw new Error('The app did not recognise the sync token. Mint a new one.');
  if (code !== 200) throw new Error('The app answered ' + code + ': ' + response.getContentText().slice(0, 300));

  var payload = JSON.parse(response.getContentText());
  if (!payload || !payload.saved) throw new Error('The app answered with no saved list.');
  return payload;
}

// ------------------------------------------------------------------ sheet --

function targetSheet() {
  var book = SpreadsheetApp.getActiveSpreadsheet();
  if (!SHEET_NAME) return book.getSheets()[0];
  var sheet = book.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('No tab named "' + SHEET_NAME + '".');
  return sheet;
}

/**
 * Find the header row and map every heading to its column.
 *
 * Searched for rather than assumed, because the header is not always row 1 --
 * this sheet has a spacer above it -- and a hard-coded row number turns a
 * cosmetic tweak into a script that writes into the wrong cells.
 */
function readLayout(sheet) {
  var scan = Math.min(10, sheet.getLastRow() || 1);
  var width = Math.max(sheet.getLastColumn(), 1);
  var rows = sheet.getRange(1, 1, scan, width).getValues();

  var headerRow = -1;
  for (var r = 0; r < rows.length; r++) {
    var cells = rows[r].map(function (c) { return String(c).trim(); });
    if (cells.indexOf(COLUMNS.company) !== -1 && cells.indexOf(COLUMNS.role) !== -1) {
      headerRow = r + 1;
      break;
    }
  }
  if (headerRow === -1) {
    throw new Error('Could not find a header row containing "' + COLUMNS.company + '" and "' + COLUMNS.role + '".');
  }

  var headers = sheet.getRange(headerRow, 1, 1, width).getValues()[0]
    .map(function (c) { return String(c).trim(); });

  var index = {};
  for (var key in COLUMNS) {
    var at = headers.indexOf(COLUMNS[key]);
    if (at !== -1) index[key] = at + 1;
  }

  // The bookkeeping columns are ours to create if they are not there yet.
  index.jobId = ensureColumn(sheet, headers, headerRow, ID_HEADER);
  headers = sheet.getRange(headerRow, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0]
    .map(function (c) { return String(c).trim(); });
  index.synced = ensureColumn(sheet, headers, headerRow, SYNCED_HEADER);

  return { headerRow: headerRow, index: index };
}

function ensureColumn(sheet, headers, headerRow, name) {
  var at = headers.indexOf(name);
  if (at !== -1) return at + 1;
  var column = Math.max(sheet.getLastColumn(), headers.length) + 1;
  sheet.getRange(headerRow, column).setValue(name);
  return column;
}

// ------------------------------------------------------------------ write --

function applyRows(sheet, layout, saved) {
  var index = layout.index;
  var firstDataRow = layout.headerRow + 1;
  var lastRow = sheet.getLastRow();
  var width = sheet.getLastColumn();

  var existing = {};
  if (lastRow >= firstDataRow) {
    var block = sheet.getRange(firstDataRow, 1, lastRow - firstDataRow + 1, width).getValues();
    for (var r = 0; r < block.length; r++) {
      var id = String(block[r][index.jobId - 1] || '').trim();
      if (id) existing[id] = { row: firstDataRow + r, values: block[r] };
    }
  }

  var added = 0, updated = 0, skipped = 0;

  for (var i = 0; i < saved.length; i++) {
    var job = saved[i];
    var fields = shapeRow(job);
    var found = existing[job.job_id];

    if (!found) {
      appendRow(sheet, index, width, job, fields);
      added++;
      continue;
    }
    var touched = updateRow(sheet, index, found, fields);
    if (touched) updated++; else skipped++;
  }

  return { added: added, updated: updated, skipped: skipped };
}

/** The app's row, in this sheet's words. */
function shapeRow(job) {
  return {
    company: job.company || '',
    role: job.title || '',
    notes: job.note || '',
    link: job.url || '',
    where: SOURCE_LABEL,
    ats: job.ats ? job.ats.charAt(0).toUpperCase() + job.ats.slice(1) : '',
    status: STATUS_LABELS[job.status] || job.status || '',
  };
}

function appendRow(sheet, index, width, job, fields) {
  var row = sheet.getLastRow() + 1;
  var line = new Array(Math.max(width, index.synced));
  for (var k = 0; k < line.length; k++) line[k] = '';

  for (var key in fields) {
    if (index[key]) line[index[key] - 1] = fields[key];
  }
  line[index.jobId - 1] = job.job_id;
  line[index.synced - 1] = stamp(fields);

  sheet.getRange(row, 1, 1, line.length).setValues([line]);
}

/**
 * Update a row that is already there, cell by cell.
 *
 * A cell is written only when it is empty, or when it still holds exactly what
 * this script last put there. Anything else means you edited it, and an edit
 * you made outranks anything the app has to say.
 */
function updateRow(sheet, index, found, fields) {
  var previous = parseStamp(String(found.values[index.synced - 1] || ''));
  var touched = false;

  for (var key in fields) {
    if (!index[key]) continue;
    var current = String(found.values[index[key] - 1] || '').trim();
    var wanted = String(fields[key] || '');
    if (!wanted || current === wanted) continue;

    var mine = previous[key] !== undefined ? String(previous[key]) : null;
    var untouched = current === '' || (mine !== null && current === mine);
    if (!untouched) continue;

    sheet.getRange(found.row, index[key]).setValue(wanted);
    touched = true;
  }

  if (touched) sheet.getRange(found.row, index.synced).setValue(stamp(fields));
  return touched;
}

function stamp(fields) {
  return JSON.stringify(fields);
}

function parseStamp(text) {
  if (!text) return {};
  try {
    return JSON.parse(text) || {};
  } catch (e) {
    return {};
  }
}

function writeLog(summary) {
  if (!LOG_SHEET_NAME) return;
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOG_SHEET_NAME);
  if (!sheet) return;
  sheet.appendRow(['SYNC', new Date(), 'favourites', summary, '', '']);
}
