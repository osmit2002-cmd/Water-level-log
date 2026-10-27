/**
 * Water Level Log: team sync server (Google Apps Script web app bound to a Google Sheet).
 * Setup: see SETUP-GOOGLE-SHEET.md. Paste this whole file into Extensions > Apps Script > Code.gs.
 */

// =====================================================================================
//  TEAM CODE: every phone must enter exactly this code in Settings > Sync.
//  If it leaks, change it here (or in the TEAM_CODE Script Property, which overrides this
//  line), then click Deploy > Manage deployments > Edit > Version: New version > Deploy.
//  Then enter the new code on each phone.
// =====================================================================================
var TEAM_CODE = 'CHANGE-ME';
// =====================================================================================

// One request may carry at most this many changes. The app sends 100 per request, which keeps every request
// to a few seconds, far below the 6-minute Apps Script limit.
var MAX_ITEMS_ = 250;
// Scattered row writes are grouped into runs of consecutive rows; past this many runs one block is written instead.
var MAX_RUNS_ = 40;
var COLS_ = {
  Boreholes: [
    ['name', 'Borehole Name'], ['referencePoint', 'Reference Point'], ['refElevationFt', 'Reference Elevation (ft)'], ['flag', 'Check Flag'],
    ['nameAt', 'Name Updated At'], ['referencePointAt', 'Reference Point Updated At'], ['refElevationAt', 'Reference Elevation Updated At'], ['flagAt', 'Flag Updated At'],
    ['createdAt', 'Created At'], ['updatedAt', 'Updated At'], ['uid', 'Borehole UID'], ['rev', 'Rev']
  ],
  // 0.6.0: one reading per row. The first 10 columns are the readable table (Odin may edit or delete rows);
  // the columns from Created At on are the sync columns (hidden, protected with a warning).
  Readings: [
    ['num', 'Reading ID'], ['boreholeName', 'Borehole Name'], ['date', 'Date'], ['time', 'Time'],
    ['depthFt', 'Depth to Top of Water (ft)'], ['waterElevationFt', 'Water Elevation (ft)'],
    ['referencePoint', 'Reference Point'], ['refElevationFt', 'Reference Elevation (ft)'], ['notes', 'Notes'], ['userCode', 'User Code'],
    ['createdAt', 'Created At'], ['updatedAt', 'Updated At'], ['uid', 'Reading UID'], ['boreholeUid', 'Borehole UID'], ['seq', 'Seq'],
    ['oldId', 'Old Reading ID'], ['rev', 'Rev']
  ],
  Tombstones: [['kind', 'Kind'], ['uid', 'UID'], ['deletedAt', 'Deleted At'], ['mergedInto', 'Merged Into'], ['rev', 'Rev'], ['restoredAt', 'Restored At'], ['source', 'Source']]
};
// Columns added after 0.4.0: added to an existing sheet's header instead of failing.
var OPTIONAL_ = { restoredAt: 1, source: 1, oldId: 1 };
var NUMERIC_ = { num: 1, refElevationFt: 1, depthFt: 1, waterElevationFt: 1, seq: 1, rev: 1 };
var READING_VISIBLE_ = 10; // Reading ID .. User Code
// What the Sync Index remembers about each reading row, to spot edits made by hand in the sheet.
var SNAP_ = ['num', 'boreholeName', 'date', 'time', 'depthFt', 'waterElevationFt', 'referencePoint', 'refElevationFt', 'notes', 'userCode',
  'createdAt', 'boreholeUid', 'seq', 'oldId'];
// Changed by hand => put back (the server owns them).
var SERVER_OWNED_ = ['num', 'createdAt', 'boreholeUid', 'seq', 'oldId'];
var LAYOUT_ = 6; // sheet layout version (Script Property LAYOUT); 6 = the 0.6.0 Readings table
var INDEX_ = 'Sync Index';
var TABLE_NAME_ = 'WaterReadings';
var TZ_ = null; // the spreadsheet's time zone (set by liveEnv_)

// ---------------- web entry points ----------------
function doPost(e) {
  return json_(handleRequest_(e && e.postData ? e.postData.contents : '', liveEnv_()));
}
function doGet(e) {
  // Only a health check: data is never served over GET, so the team code never has to go in a URL.
  return json_({ ok: true, message: 'Water Level Log sync is running. Enter this URL and the team code in the app.' });
}
function liveEnv_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  TZ_ = ss.getSpreadsheetTimeZone();
  return { ss: ss, props: PropertiesService.getScriptProperties(), lock: LockService.getScriptLock(), now: function () { return new Date().toISOString(); },
    tables: liveTables_(ss) };
}
/**
 * Google Sheets "Tables" (Format > Convert to table) through the Advanced Sheets service. Returns null if that
 * service is not turned on (Services > + > Google Sheets API); the sheet then gets a filter + banding instead.
 */
function liveTables_(ss) {
  if (typeof Sheets === 'undefined' || !Sheets.Spreadsheets) return null;
  var id = ss.getId();
  var range = function (sh, rows, cols) { return { sheetId: sh.getSheetId(), startRowIndex: 0, endRowIndex: rows, startColumnIndex: 0, endColumnIndex: cols }; };
  return {
    find: function (sh) {
      var res = Sheets.Spreadsheets.get(id, { fields: 'sheets(properties(sheetId),tables(tableId,name,range))' });
      var sid = sh.getSheetId(), all = res.sheets || [];
      for (var i = 0; i < all.length; i++) if (all[i].properties.sheetId === sid) return (all[i].tables || [])[0] || null;
      return null;
    },
    add: function (sh, rows, cols, columnProperties) {
      Sheets.Spreadsheets.batchUpdate({ requests: [{ addTable: { table: { name: TABLE_NAME_, range: range(sh, rows, cols), columnProperties: columnProperties } } }] }, id);
    },
    resize: function (sh, t, rows, cols) {
      Sheets.Spreadsheets.batchUpdate({ requests: [{ updateTable: { table: { tableId: t.tableId, range: range(sh, rows, cols) }, fields: 'range' } }] }, id);
    }
  };
}

// ---------------- menu (for Odin, in the sheet) ----------------
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Water Level Log')
    .addItem('Apply my sheet edits now', 'applySheetEditsNow')
    .addItem('Set up / repair the Readings table', 'setupReadingsTable')
    .addToUi();
}
/** Picks up rows edited or deleted by hand now (phones also trigger this on every sync). */
function applySheetEditsNow() { return maintenance_(liveEnv_(), false); }
/** One-time 0.6.0 migration (also runs by itself on the first sync after the update); safe to run again. */
function setupReadingsTable() { return maintenance_(liveEnv_(), true); }
function maintenance_(env, relayout) {
  env.lock.waitLock(25000);
  try {
    var msg = '';
    if (needsLayout_(env)) { msg = migrate_(env); relayout = false; }
    var db = openDb_(env);
    reconcile_(db, env);
    saveAll_(db, env);
    if (relayout) msg = migrate_(env);
    return (msg || 'Sheet edits applied.') + (env.notice ? ' ' + env.notice : '');
  } finally { env.lock.releaseLock(); }
}
function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// ---------------- request handling (unit-tested with a fake Sheet) ----------------
function teamCode_(props) {
  var p = props.getProperty('TEAM_CODE');
  return String(p || TEAM_CODE || '');
}
function safeEq_(a, b) {
  if (a.length !== b.length) return false;
  var d = 0;
  for (var i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
/**
 * A push is applied in two phases under the script lock: first every change is validated and applied to an
 * in-memory copy (nothing written yet), then only the changed rows are written, and the revision counter is
 * stored last. Every change is keyed by UUID, so if a request dies half way (timeout, quota) the phone's retry
 * re-applies the same changes and ends in the same state.
 */
function handleRequest_(text, env) {
  var req;
  try { req = JSON.parse(text || '{}'); } catch (err) { return { ok: false, error: 'Bad request' }; }
  if (!req || typeof req !== 'object') return { ok: false, error: 'Bad request' };
  var code = teamCode_(env.props);
  if (!code || code === 'CHANGE-ME') return { ok: false, error: 'The team code has not been set in the Apps Script yet' };
  if (!safeEq_(String(req.team || ''), code)) return { ok: false, error: 'Wrong team code' };
  if (req.op === 'ping') return { ok: true, message: 'Connected to the team sheet' };
  if (req.op !== 'push' && req.op !== 'pull') return { ok: false, error: 'Unknown operation' };
  if (req.op === 'push') {
    var n = (req.tombstones || []).length + (req.boreholes || []).length + (req.readings || []).length;
    if (!(n <= MAX_ITEMS_)) return { ok: false, error: 'Too many changes in one request (max ' + MAX_ITEMS_ + ')' };
  }
  try { env.lock.waitLock(25000); } catch (err) { return { ok: false, error: 'The sheet is busy, try again' }; }
  try {
    if (needsLayout_(env)) migrate_(env); // first request after the 0.6.0 update: build the Readings table
    var db = openDb_(env);
    reconcile_(db, env); // rows edited or deleted by hand in the sheet, before any phone change is applied
    var out = req.op === 'push' ? push_(db, req, env) : null;
    saveAll_(db, env);
    return out || pull_(db, Number(req.since) || 0);
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  } finally {
    env.lock.releaseLock();
  }
}

function openDb_(env) {
  var db = loadAll_(env.ss);
  db.rev = maxRev_(db, env);
  db.numMax = Number(env.props.getProperty('NUM_MAX') || 0);
  for (var i = 0; i < db.R.rows.length; i++) if (db.R.rows[i].num > db.numMax) db.numMax = db.R.rows[i].num;
  return db;
}
function saveAll_(db, env) {
  saveTable_(db.B, env); saveTable_(db.T, env); saveTable_(db.R, env); // boreholes first: a cut-off write never leaves readings without their borehole
  indexAfterSave_(db);
  saveIndex_(env.ss, db.L);
  env.props.setProperty('NUM_MAX', String(db.numMax));
  env.props.setProperty('REV', String(db.rev)); // last: the batch is complete
}

// ---------------- sheet <-> objects ----------------
function sheetFor_(ss, name) {
  var sh = ss.getSheetByName(name);
  var cols = COLS_[name];
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() < 1) {
    sh.getRange(1, 1, 1, cols.length).setValues([cols.map(function (c) { return c[1]; })]);
    sh.setFrozenRows(1);
    // Text format so Sheets does not turn dates, times, codes or notes into numbers/dates/formulas.
    for (var i = 0; i < cols.length; i++) if (!NUMERIC_[cols[i][0]]) sh.getRange(1, i + 1, sh.getMaxRows(), 1).setNumberFormat('@');
  }
  return sh;
}
function guard_(s) { return /^[=+\-@']/.test(s) ? "'" + s : s; } // never let a text value become a formula
function toCell_(k, v) {
  if (v === undefined || v === null) return '';
  if (NUMERIC_[k]) return v === '' ? '' : Number(v);
  return guard_(String(v));
}
function fromCell_(k, v) {
  if (NUMERIC_[k]) return v === '' || v === null || v === undefined ? null : Number(v);
  // A date or time typed by hand into a cell that is not text arrives as a Date: read it in the sheet's time zone.
  if (v instanceof Date) return k === 'date' ? fmtLocal_(v, 'yyyy-MM-dd') : k === 'time' ? fmtLocal_(v, 'HH:mm') : v.toISOString();
  return String(v === undefined || v === null ? '' : v); // Sheets drops the leading ' that toCell_ adds
}
function fmtLocal_(d, f) {
  if (TZ_ && typeof Utilities !== 'undefined') return Utilities.formatDate(d, TZ_, f);
  var p = function (n) { return (n < 10 ? '0' : '') + n; };
  return f === 'HH:mm' ? p(d.getHours()) + ':' + p(d.getMinutes()) : d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function loadTable_(ss, name) {
  var sh = sheetFor_(ss, name), cols = COLS_[name];
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  var idx = cols.map(function (c) { return head.indexOf(c[1]); });
  var missing = cols.filter(function (c, i) { return idx[i] < 0 && !OPTIONAL_[c[0]]; });
  if (missing.length) throw new Error('Sheet "' + name + '" is missing column ' + missing[0][1] + '. Do not rename or delete the header row.');
  var last = sh.getLastRow(), rows = [], seen = {}, dups = 0, dupUids = [];
  var vals = last > 1 ? sh.getRange(2, 1, last - 1, head.length).getValues() : [];
  for (var r = 0; r < vals.length; r++) {
    var o = {};
    for (var c = 0; c < cols.length; c++) o[cols[c][0]] = idx[c] < 0 ? '' : fromCell_(cols[c][0], vals[r][idx[c]]);
    // A copied row (same UID twice) is ignored: the first one is the reading.
    if (o.uid && !seen[o.uid]) { seen[o.uid] = 1; o._row = r + 2; rows.push(o); } else if (o.uid) { dups++; if (dupUids.indexOf(o.uid) < 0) dupUids.push(o.uid); }
  }
  return { sheet: sh, name: name, head: head, idx: idx, rows: rows, last: last, dups: dups, dupUids: dupUids, dirty: {}, cleared: [] };
}
/**
 * Write only the rows that changed (and append new ones); other rows, and columns that are not ours, are untouched.
 * Deleted records lose their whole row (0.6.0; before, the row was blanked). Before writing or deleting a row, its
 * UID cell is checked: if someone sorted, inserted or deleted rows meanwhile, nothing is written and the phone retries.
 */
function saveTable_(t, env) {
  var cols = COLS_[t.name], sh = t.sheet, uid, i, c;
  var writes = {}, rowsToWrite = [], appended = [];
  for (uid in t.dirty) {
    var o = t.dirty[uid];
    if (!o._row) { o._row = ++t.last; appended.push(o._row); }
    writes[o._row] = o;
  }
  for (var k in writes) rowsToWrite.push(Number(k));
  if (!rowsToWrite.length && !t.cleared.length) return;
  var uidCol = t.idx[colIndex_(t.name, 'uid')];
  var check = function (row, want) {
    var got = String(sh.getRange(row, uidCol + 1).getValues()[0][0]);
    if (got !== want) throw new Error('The sheet was changed while syncing (row ' + row + '). Nothing was lost; sync again.');
  };
  for (i = 0; i < t.cleared.length; i++) check(t.cleared[i].row, t.cleared[i].uid);
  if (rowsToWrite.length) {
    // Columns added in a newer version go at the end of the header.
    var add = [];
    for (c = 0; c < cols.length; c++) if (t.idx[c] < 0) { t.idx[c] = t.head.length + add.length; add.push(cols[c][1]); }
    if (add.length) { sh.getRange(1, t.head.length + 1, 1, add.length).setValues([add]); t.head = t.head.concat(add); }
    rowsToWrite.sort(function (a, b) { return a - b; });
    var need = rowsToWrite[rowsToWrite.length - 1];
    if (sh.getMaxRows() < need) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows() + 100);
    var c0 = Math.min.apply(null, t.idx), c1 = Math.max.apply(null, t.idx), w = c1 - c0 + 1;
    if (appended.length) {
      // New rows do not always inherit the header's text format: set it on the appended block.
      for (c = 0; c < cols.length; c++) if (!NUMERIC_[cols[c][0]]) sh.getRange(appended[0], t.idx[c] + 1, appended.length, 1).setNumberFormat('@');
    }
    var runs = [], a = rowsToWrite[0], b = a;
    for (i = 1; i < rowsToWrite.length; i++) {
      if (rowsToWrite[i] === b + 1) b = rowsToWrite[i]; else { runs.push([a, b]); a = b = rowsToWrite[i]; }
    }
    runs.push([a, b]);
    if (runs.length > MAX_RUNS_) runs = [[rowsToWrite[0], rowsToWrite[rowsToWrite.length - 1]]];
    for (var q = 0; q < runs.length; q++) {
      var r0 = runs[q][0], n = runs[q][1] - r0 + 1;
      var rg = sh.getRange(r0, c0 + 1, n, w);
      var vals = rg.getValues(), fx = rg.getFormulas(), out = [];
      for (i = 0; i < n; i++) {
        var row = [];
        // Cells we do not own keep their formula, or their value (text guarded so it stays text).
        for (c = 0; c < w; c++) row.push(fx[i][c] ? fx[i][c] : typeof vals[i][c] === 'string' ? guard_(vals[i][c]) : vals[i][c]);
        if (Object.prototype.hasOwnProperty.call(writes, r0 + i)) {
          var obj = writes[r0 + i];
          if (appended.indexOf(r0 + i) < 0 && String(vals[i][uidCol - c0]) !== obj.uid) {
            throw new Error('The sheet was changed while syncing (row ' + (r0 + i) + '). Nothing was lost; sync again.');
          }
          for (c = 0; c < cols.length; c++) row[t.idx[c] - c0] = toCell_(cols[c][0], obj[cols[c][0]]);
        }
        out.push(row);
      }
      rg.setValues(out);
    }
    if (appended.length && t.name === 'Readings' && env) growTable_(env, sh, t.last, t.head.length);
  }
  // Deletes last, bottom up, so the row numbers above stay right.
  var del = t.cleared.slice().sort(function (x, y) { return y.row - x.row; });
  for (i = 0; i < del.length; i++) {
    try {
      if (sh.getMaxRows() <= 2) throw new Error('last row');
      sh.deleteRow(del[i].row);
    } catch (err) { // a sheet must keep one row below the header: blank it instead
      sh.getRange(del[i].row, 1, 1, sh.getLastColumn()).clearContent();
    }
  }
  t.cleared = [];
}
function colIndex_(name, key) { for (var i = 0; i < COLS_[name].length; i++) if (COLS_[name][i][0] === key) return i; return -1; }
/** Rows appended below a Google Sheets Table do not join it by themselves: stretch the table over them. */
function growTable_(env, sh, lastRow, nCols) {
  if (!env.tables) return;
  try {
    var t = env.tables.find(sh);
    if (t && (t.range.endRowIndex < lastRow || t.range.endColumnIndex < nCols)) env.tables.resize(sh, t, Math.max(lastRow, t.range.endRowIndex), Math.max(nCols, t.range.endColumnIndex));
  } catch (err) { /* cosmetic: the rows are saved either way */ }
}
function loadAll_(ss) {
  var db = { B: loadTable_(ss, 'Boreholes'), R: loadTable_(ss, 'Readings'), T: loadTable_(ss, 'Tombstones'), L: loadIndex_(ss) };
  db.b = byUid_(db.B.rows); db.r = byUid_(db.R.rows); db.t = byUid_(db.T.rows);
  return db;
}
/** Current revision: never lower than any row's Rev (e.g. if the sheet was copied without its Script Properties). */
function maxRev_(db, env) {
  var m = rev_(env), all = db.B.rows.concat(db.R.rows, db.T.rows);
  for (var i = 0; i < all.length; i++) if (Number(all[i].rev) > m) m = Number(all[i].rev);
  return m;
}
function byUid_(rows) { var m = {}; for (var i = 0; i < rows.length; i++) m[rows[i].uid] = rows[i]; return m; }
function rev_(env) { return Number(env.props.getProperty('REV') || 0); }
function bump_(db) { db.rev = (db.rev || 0) + 1; return db.rev; }

// ---------------- merge rules (same as the app's src/sync/merge.ts) ----------------
var BFIELDS_ = [['name', 'nameAt'], ['referencePoint', 'referencePointAt'], ['refElevationFt', 'refElevationAt'], ['flag', 'flagAt']];
function mergeBorehole_(a, b) {
  var out = {}, k;
  for (k in a) out[k] = a[k];
  for (var i = 0; i < BFIELDS_.length; i++) {
    var f = BFIELDS_[i][0], at = BFIELDS_[i][1], ta = a[at] || '', tb = b[at] || '';
    if (tb > ta || (tb === ta && String(b[f]) > String(a[f]))) { out[f] = b[f]; out[at] = tb; }
  }
  out.createdAt = a.createdAt < b.createdAt ? (a.createdAt || b.createdAt) : (b.createdAt || a.createdAt);
  out.updatedAt = a.updatedAt > b.updatedAt ? a.updatedAt : b.updatedAt;
  return out;
}
function sameName_(a, b) { return String(a).trim().toLowerCase() === String(b).trim().toLowerCase(); }
/** Follow "merged into" links (merges are permanent redirects, never undone). */
function canon_(db, uid) {
  for (var i = 0; i < 20 && db.t[uid] && db.t[uid].mergedInto; i++) uid = db.t[uid].mergedInto;
  return uid;
}
/** An active delete (not a merge, not undone). */
function dead_(db, uid) { var t = db.t[uid]; return t && !t.mergedInto && !t.restoredAt ? t : null; }
function bKey_(b) { return [b.name, b.referencePoint, b.refElevationFt, b.flag, b.nameAt, b.referencePointAt, b.refElevationAt, b.flagAt].join('\u0001'); }
/** A time just after `iso` (or now, if later): used so a restore always sorts after the delete it undoes. */
function after_(iso, env) {
  var now = env.now(), t = Date.parse(iso || '');
  if (!isFinite(t)) return now;
  var a = new Date(t + 1).toISOString();
  return a > now ? a : now;
}

var DT_ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
function whyB_(x) {
  if (!x || typeof x !== 'object') return 'Not a borehole record';
  if (typeof x.uid !== 'string' || !x.uid) return 'Borehole has no ID';
  if (typeof x.name !== 'string' || !x.name.trim()) return 'Borehole Name is empty';
  if (typeof x.refElevationFt !== 'number' || !isFinite(x.refElevationFt)) return 'Reference Elevation is not a number';
  return '';
}
function cleanB_(x) {
  var s = function (v) { return v === undefined || v === null ? '' : String(v); };
  return { uid: x.uid, name: x.name.trim(), referencePoint: s(x.referencePoint), refElevationFt: x.refElevationFt, flag: s(x.flag),
    nameAt: s(x.nameAt), referencePointAt: s(x.referencePointAt), refElevationAt: s(x.refElevationAt), flagAt: s(x.flagAt), createdAt: s(x.createdAt), updatedAt: s(x.updatedAt) };
}
function whyR_(x) {
  if (!x || typeof x !== 'object') return 'Not a reading record';
  if (typeof x.uid !== 'string' || !x.uid) return 'Reading has no ID';
  if (typeof x.boreholeUid !== 'string' || !x.boreholeUid) return 'Reading has no borehole';
  if (typeof x.datetime !== 'string' || !DT_.test(x.datetime)) return 'Reading date/time is not valid';
  if (typeof x.depthFt !== 'number' || !isFinite(x.depthFt)) return 'Depth is not a number';
  if (x.depthFt < 0) return 'Depth is negative';
  if (typeof x.refElevationFt !== 'number' || !isFinite(x.refElevationFt)) return 'Reference Elevation is not a number';
  return '';
}
function cleanR_(x) {
  var s = function (v) { return v === undefined || v === null ? '' : String(v); };
  return { uid: x.uid, num: Number(x.num) > 0 && Math.floor(x.num) === Number(x.num) ? Number(x.num) : 0, boreholeUid: x.boreholeUid, datetime: x.datetime.slice(0, 16), userCode: s(x.userCode), seq: Number(x.seq) || 0,
    referencePoint: s(x.referencePoint), refElevationFt: x.refElevationFt, depthFt: x.depthFt, notes: s(x.notes), createdAt: s(x.createdAt), updatedAt: s(x.updatedAt) };
}
function readingRow_(r, bh) {
  return { num: r.num, oldId: '', boreholeName: bh.name, date: r.datetime.slice(0, 10), time: r.datetime.slice(11, 16), userCode: r.userCode,
    referencePoint: r.referencePoint, refElevationFt: r.refElevationFt, depthFt: r.depthFt, waterElevationFt: Math.round((r.refElevationFt - r.depthFt) * 1e6) / 1e6,
    notes: r.notes, createdAt: r.createdAt, updatedAt: r.updatedAt, uid: r.uid, boreholeUid: bh.uid, seq: r.seq };
}

// ---------------- in-memory changes (written by saveTable_) ----------------
function put_(tbl, map, o, db) {
  o.rev = bump_(db);
  var cur = map[o.uid];
  if (cur) { o._row = cur._row; tbl.rows[tbl.rows.indexOf(cur)] = o; } else tbl.rows.push(o);
  map[o.uid] = o; tbl.dirty[o.uid] = o;
  if (tbl.name === 'Readings') { (tbl.written = tbl.written || {})[o.uid] = o; if (tbl.removed) delete tbl.removed[o.uid]; }
}
function putB_(db, b) { put_(db.B, db.b, b, db); }
function putR_(db, r) { put_(db.R, db.r, r, db); }
function putT_(db, t) { put_(db.T, db.t, t, db); }
/** Remove a row's data (the row is blanked; other columns and rows are left alone). */
function clearRow_(tbl, map, uid) {
  var cur = map[uid];
  if (!cur) return;
  tbl.rows.splice(tbl.rows.indexOf(cur), 1); delete map[uid]; delete tbl.dirty[uid];
  if (tbl.name === 'Readings') { (tbl.removed = tbl.removed || {})[uid] = 1; if (tbl.written) delete tbl.written[uid]; }
  if (cur._row) tbl.cleared.push({ row: cur._row, uid: uid });
}
function addTomb_(db, env, t) {
  putT_(db, { kind: t.kind, uid: t.uid, deletedAt: t.deletedAt || env.now(), mergedInto: t.mergedInto || '', restoredAt: '', source: t.source || '' });
}
/** Mark a delete as undone (kept for the record; phones then accept the record again because it is newer than the delete). */
function restoreTomb_(db, env, uid) {
  var t = db.t[uid], o = {}, k;
  for (k in t) o[k] = t[k];
  o.restoredAt = env.now();
  putT_(db, o);
}
function copy_(x) { var o = {}, k; for (k in x) o[k] = x[k]; return o; }
function flagB_(db, env, uid, text, at) {
  var b = db.b[uid];
  if (!b) return;
  var nb = copy_(b), when = at || env.now();
  nb.flag = text; nb.flagAt = when; (env.flagged = env.flagged || {})[uid] = 1; if (when > nb.updatedAt) nb.updatedAt = when;
  putB_(db, nb);
}
function liveClash_(db, name, notUid) {
  for (var i = 0; i < db.B.rows.length; i++) if (db.B.rows[i].uid !== notUid && sameName_(db.B.rows[i].name, name)) return db.B.rows[i];
  return null;
}
function relinkReadings_(db, fromUid, bh) {
  var rows = db.R.rows.slice();
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.boreholeUid === fromUid || (r.boreholeUid === bh.uid && r.boreholeName !== bh.name)) {
      var n = copy_(r); n.boreholeUid = bh.uid; n.boreholeName = bh.name;
      if (r.boreholeUid === fromUid) putR_(db, n); else { db.R.dirty[n.uid] = n; (db.R.written = db.R.written || {})[n.uid] = n; n._row = r._row; db.R.rows[db.R.rows.indexOf(r)] = n; db.r[n.uid] = n; }
    }
  }
}
function liveReadingsOf_(db, buid) { return db.R.rows.filter(function (r) { return r.boreholeUid === buid && db.r[r.uid] === r && !dead_(db, r.uid); }); }

function push_(db, req, env) {
  var acked = [], rejected = [], held = [], i;
  var T = req.tombstones || [], B = req.boreholes || [], R = req.readings || [];
  if (!(T instanceof Array) || !(B instanceof Array) || !(R instanceof Array)) throw new Error('Bad push');
  var day = env.now().slice(0, 10);

  // 0. Validate everything first. Invalid items are rejected with a reason (the phone shows them as failed).
  var tombs = [], bhs = [], rds = [];
  for (i = 0; i < T.length; i++) {
    var t = T[i];
    if (!t || typeof t.uid !== 'string' || !t.uid || (t.kind !== 'borehole' && t.kind !== 'reading')) rejected.push({ key: 't:' + (t && t.uid), reason: 'Not a valid delete' });
    else tombs.push({ kind: t.kind, uid: t.uid, deletedAt: String(t.deletedAt || '') || env.now() });
  }
  for (i = 0; i < B.length; i++) { var wb = whyB_(B[i]); if (wb) rejected.push({ key: 'b:' + (B[i] && B[i].uid), reason: wb }); else bhs.push(cleanB_(B[i])); }
  for (i = 0; i < R.length; i++) { var wr = whyR_(R[i]); if (wr) rejected.push({ key: 'r:' + (R[i] && R[i].uid), reason: wr }); else rds.push(cleanR_(R[i])); }

  // 1. Deletes, readings before boreholes. A delete loses to an edit made after it (the record is kept and flagged).
  tombs.sort(function (a, b) { return (a.kind === 'reading' ? 0 : 1) - (b.kind === 'reading' ? 0 : 1); });
  for (i = 0; i < tombs.length; i++) {
    var tb = tombs[i];
    acked.push('t:' + tb.uid);
    if (dead_(db, tb.uid)) { // already deleted; finish a delete cut off by a time-out (tombstone written, row not yet blanked)
      if (tb.kind === 'reading' && db.r[tb.uid]) clearRow_(db.R, db.r, tb.uid);
      else if (tb.kind === 'borehole' && db.b[tb.uid] && !liveReadingsOf_(db, tb.uid).length) clearRow_(db.B, db.b, tb.uid);
      continue;
    }
    if (db.t[tb.uid] && db.t[tb.uid].mergedInto) continue;
    if (tb.kind === 'reading') {
      var cr = db.r[tb.uid];
      if (cr && cr.updatedAt > tb.deletedAt) {
        flagB_(db, env, cr.boreholeUid, 'Reading ' + cr.num + ' was deleted on a phone but edited later on another; it was kept ' + day + '. Delete it again if it is not wanted.');
        putR_(db, copy_(cr));
        continue;
      }
      addTomb_(db, env, tb); clearRow_(db.R, db.r, tb.uid);
    } else {
      var cb = db.b[tb.uid];
      if (!cb) { addTomb_(db, env, tb); continue; }
      var left = liveReadingsOf_(db, tb.uid);
      if (cb.updatedAt > tb.deletedAt || left.length) {
        // Never delete readings implicitly: readings the deleting phone had not seen keep the borehole alive.
        flagB_(db, env, tb.uid, left.length
          ? 'Deleted on a phone, but ' + left.length + ' reading(s) that phone had not seen were kept ' + day + '. Check them, and delete the borehole again if it is not wanted.'
          : 'Deleted on a phone but edited later on another; it was kept ' + day + '. Delete it again if it is not wanted.', after_(tb.deletedAt, env));
        for (var j = 0; j < left.length; j++) putR_(db, copy_(left[j])); // so the deleting phone gets them back
        continue;
      }
      addTomb_(db, env, tb); clearRow_(db.B, db.b, tb.uid);
    }
  }

  // 2. Boreholes: field-by-field newest wins; same name (any case) as another borehole => merge + flag.
  for (i = 0; i < bhs.length; i++) {
    var b = bhs[i], key = 'b:' + b.uid;
    var uid = canon_(db, b.uid);
    var gone = dead_(db, uid);
    if (gone) {
      if (!(b.updatedAt > gone.deletedAt)) { acked.push(key); continue; } // the delete is newer: it wins
      restoreTomb_(db, env, uid); // edited after the delete: bring it back, flagged
      if (!(b.flagAt > gone.deletedAt)) { b.flag = 'Deleted on a phone but edited later on another; it was kept ' + day + '. Delete it again if it is not wanted.'; b.flagAt = after_(gone.deletedAt, env); }
    }
    b.uid = uid;
    var cur = db.b[uid];
    var merged = cur ? mergeBorehole_(cur, b) : b;
    var clash = liveClash_(db, merged.name, uid);
    if (clash) {
      var keep = mergeBorehole_(clash, merged);
      keep.uid = clash.uid; keep.name = clash.name; keep.nameAt = clash.nameAt;
      keep.flag = 'Same Borehole Name was created on two phones; records merged ' + day + '. Check the reference values.';
      keep.flagAt = env.now();
      putB_(db, keep);
      if (cur) clearRow_(db.B, db.b, uid);
      addTomb_(db, env, { kind: 'borehole', uid: uid, mergedInto: keep.uid });
      relinkReadings_(db, uid, keep);
    } else if (!cur || bKey_(cur) !== bKey_(merged)) {
      putB_(db, merged);
      relinkReadings_(db, '', merged);
    }
    acked.push(key);
  }

  // 3. Readings: insert (the sheet gives it the next Reading ID), or newest edit wins for depth/notes. Reference values,
  // date/time, code and number never change from a phone (they can be corrected by hand in the sheet).
  // Lowest provisional number first, so a phone's numbers keep their order.
  rds = rds.slice().sort(function (a, b) { return (a.num || 1e15) - (b.num || 1e15); });
  for (i = 0; i < rds.length; i++) {
    var r = rds[i], rk = 'r:' + r.uid;
    var rgone = dead_(db, r.uid), restored = false;
    if (rgone && rgone.source === 'sheet') {
      // Deleted by hand in the sheet: final. A phone's queued edit never brings it back. Re-send the delete to that phone.
      putT_(db, copy_(rgone)); acked.push(rk); continue;
    }
    if (rgone && !(r.updatedAt > rgone.deletedAt)) { acked.push(rk); continue; }
    var bu = canon_(db, r.boreholeUid);
    if (dead_(db, bu)) { held.push({ key: rk, reason: 'Its borehole was deleted on another phone; this phone will restore it' }); continue; }
    var bh = db.b[bu];
    if (!bh) { held.push({ key: rk, reason: 'Its borehole has not been uploaded yet' }); continue; }
    if (rgone) { restoreTomb_(db, env, r.uid); restored = true; } // only once the row will really be stored
    var old = db.r[r.uid];
    if (!old) {
      var row = readingRow_(r, bh);
      // Reading IDs are one sequence for the whole sheet, handed out here in arrival order (never reused). A reading the
      // sheet restores keeps the number the phone knew if it is free.
      // A phone's provisional number above every number ever handed out is kept (so the first phone to sync, and a phone
      // nobody raced, keeps the numbers it shows); anything else gets the next number.
      // (A restored reading always gets a new number: its old one may have been someone else's deleted number.)
      if (!restored && r.num > db.numMax && r.num <= db.numMax + rds.length) row.num = db.numMax = r.num;
      else row.num = ++db.numMax;
      putR_(db, row);
    }
    else if (r.updatedAt > old.updatedAt) {
      var upd = copy_(old);
      upd.depthFt = r.depthFt; upd.notes = r.notes; upd.updatedAt = r.updatedAt;
      upd.waterElevationFt = Math.round((old.refElevationFt - r.depthFt) * 1e6) / 1e6;
      putR_(db, upd);
    }
    if (restored) flagB_(db, env, bh.uid, 'Reading ' + db.r[r.uid].num + ' was deleted on a phone but edited later on another; it was kept ' + day + '. Delete it again if it is not wanted.');
    acked.push(rk);
  }
  return { ok: true, acked: acked, rejected: rejected, held: held };
}

function pull_(db, since) {
  var after = function (x) { return Number(x.rev) > since; };
  return {
    ok: true,
    cursor: db.rev,
    numMax: db.numMax,
    boreholes: db.B.rows.filter(after).map(function (b) {
      return { uid: b.uid, name: b.name, referencePoint: b.referencePoint, refElevationFt: b.refElevationFt, flag: b.flag || '', nameAt: b.nameAt, referencePointAt: b.referencePointAt,
        refElevationAt: b.refElevationAt, flagAt: b.flagAt, createdAt: b.createdAt, updatedAt: b.updatedAt };
    }),
    readings: db.R.rows.filter(after).map(function (r) {
      return { uid: r.uid, num: r.num, displayId: r.num ? String(r.num) : '', boreholeUid: r.boreholeUid, boreholeName: r.boreholeName, datetime: r.date + 'T' + r.time, userCode: r.userCode, seq: r.seq,
        referencePoint: r.referencePoint, refElevationFt: r.refElevationFt, depthFt: r.depthFt, notes: r.notes, createdAt: r.createdAt, updatedAt: r.updatedAt };
    }),
    tombstones: db.T.rows.filter(after).map(function (t) {
      var o = { uid: t.uid, kind: t.kind, deletedAt: t.deletedAt };
      if (t.mergedInto) o.mergedInto = t.mergedInto;
      if (t.restoredAt) o.restoredAt = t.restoredAt;
      if (t.source === 'sheet') o.final = true; // deleted by hand in the sheet: phones delete it even if they edited it
      return o;
    })
  };
}


// ---------------- 0.6.0: hand edits and deletes in the sheet ----------------
/**
 * The Sync Index (a hidden tab) holds, per reading UID, a snapshot of the row as this script last wrote it. Every
 * request compares the sheet with it first:
 * - a row whose UID is gone was deleted by hand => a "sheet" tombstone (final: phones delete it, even if they edited it);
 * - a row that differs was edited by hand => checked, Updated At = now, Rev bumped, so phones get the change;
 * - a row back after its delete (undo / version history) => the delete is undone.
 */
function snap_(o) {
  return JSON.stringify(SNAP_.map(function (k) { var v = o[k]; return v === undefined || v === null ? '' : typeof v === 'number' ? (isFinite(v) ? Math.round(v * 1e6) / 1e6 : 'NaN') : v; }));
}
function loadIndex_(ss) {
  var sh = ss.getSheetByName(INDEX_), map = {};
  if (sh && sh.getLastRow() > 1) {
    var v = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
    for (var i = 0; i < v.length; i++) if (v[i][0]) map[String(v[i][0])] = String(v[i][1]);
  }
  return { sheet: sh, map: map, changed: false };
}
function saveIndex_(ss, L) {
  if (!L.changed) return;
  var sh = L.sheet || (L.sheet = ss.insertSheet(INDEX_));
  if (sh.hideSheet) sh.hideSheet();
  var rows = [['Reading UID', 'Snapshot (do not edit: used to spot hand edits in Readings)']];
  for (var k in L.map) rows.push([k, L.map[k]]);
  var last = sh.getLastRow();
  if (sh.getMaxRows() < rows.length) sh.insertRowsAfter(sh.getMaxRows(), rows.length - sh.getMaxRows() + 100);
  if (last > rows.length) sh.getRange(rows.length + 1, 1, last - rows.length, 2).clearContent();
  sh.getRange(1, 1, sh.getMaxRows(), 2).setNumberFormat('@');
  sh.getRange(1, 1, rows.length, 2).setValues(rows.map(function (r) { return [guard_(r[0]), guard_(r[1])]; }));
  L.changed = false;
}
/** After the Readings rows are written: remember what was written, forget deleted rows. */
function indexAfterSave_(db) {
  var L = db.L, k;
  for (k in db.R.written || {}) { L.map[k] = snap_(db.R.written[k]); L.changed = true; }
  for (k in db.R.removed || {}) { delete L.map[k]; L.changed = true; }
  db.R.written = {}; db.R.removed = {};
}
var SYNC_ONLY_ = { uid: 1, boreholeUid: 1, seq: 1, rev: 1, createdAt: 1, updatedAt: 1 };
function needsLayout_(env) { return Number(env.props.getProperty('LAYOUT') || 0) < LAYOUT_; }

function reconcile_(db, env) {
  env.flagged = {}; env.notice = '';
  var L = db.L, day = env.now().slice(0, 10), seen = {}, uid, i;
  var rows = db.R.rows.slice();
  for (i = 0; i < rows.length; i++) {
    var r = rows[i]; uid = r.uid; seen[uid] = 1;
    var prev = L.map[uid], gone = dead_(db, uid);
    if (prev === undefined) {
      // Deleted on a phone, yet a row with its UID is still here: a leftover copy of the row. The phone's delete stands.
      if (gone && gone.source !== 'sheet') { clearRow_(db.R, db.r, uid); continue; }
      if (gone) { // deleted by hand, and now the row is back (Edit > Undo or version history): undo the delete
        restoreTomb_(db, env, uid);
        var back = copy_(r); back.updatedAt = after_(gone.deletedAt, env);
        fixRow_(back); putR_(db, back);
      } else { L.map[uid] = snap_(r); L.changed = true; } // first run, or written by an older version: adopt as is
      continue;
    }
    if (gone) { clearRow_(db.R, db.r, uid); continue; } // a delete cut off by a time-out: finish it
    if (prev !== snap_(r)) handEdit_(db, env, r, JSON.parse(prev), day);
  }
  // A UID twice means rows were copied, or shifted under a write: a missing UID then may not be a real delete.
  // Deletes wait (the readings stay on the phones) until the duplicate is gone.
  // One note per borehole listing its copied readings; written only when the text changes, never over a note made
  // earlier in this request, and cleared once the copies are gone.
  var notes = {}, COPIED = 'Row copied (Reading ', bu;
  for (i = 0; i < db.R.dupUids.length; i++) {
    var cr = db.r[db.R.dupUids[i]];
    if (cr) (notes[cr.boreholeUid] = notes[cr.boreholeUid] || []).push(cr.num);
  }
  for (bu in db.b) {
    var b = db.b[bu], want = notes[bu] ? COPIED + notes[bu].sort(function (x, y) { return x - y; }).join(', ') + '): deleting rows by hand is paused until the copy is removed.' : '';
    if (env.flagged && env.flagged[bu]) continue;
    if (want && b.flag !== want) flagB_(db, env, bu, want);
    else if (!want && String(b.flag || '').indexOf(COPIED) === 0) flagB_(db, env, bu, '');
  }
  if (db.R.dups) {
    env.notice = 'A reading row appears twice (same Reading UID). Deleting rows by hand is paused until the copy is removed.';
    return;
  }
  for (uid in L.map) {
    if (seen[uid]) continue;
    delete L.map[uid]; L.changed = true;
    if (!dead_(db, uid)) addTomb_(db, env, { kind: 'reading', uid: uid, deletedAt: env.now(), source: 'sheet' });
  }
}
function dayFirst_(env) {
  if (env.dayFirst === undefined) {
    var loc = '';
    try { loc = env.ss.getSpreadsheetLocale ? String(env.ss.getSpreadsheetLocale()) : ''; } catch (err) { loc = ''; }
    env.dayFirst = !!loc && !/^(en_US|en_PH|es_US|en_CA|fil)/i.test(loc);
  }
  return env.dayFirst;
}
function round6_(x) { return Math.round(x * 1e6) / 1e6; }
function fixRow_(n) { n.waterElevationFt = round6_(n.refElevationFt - n.depthFt); }
function okNum_(v) { return typeof v === 'number' && isFinite(v); }
/** YYYY-MM-DD, or a/b/YYYY read in the spreadsheet's own order (month first only for US-style locales). */
function normDate_(v, dayFirst) {
  var s = String(v).trim(), m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s), y, mo, d;
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = /^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})$/.exec(s))) { y = +m[3]; mo = dayFirst ? +m[2] : +m[1]; d = dayFirst ? +m[1] : +m[2]; }
  else return '';
  var t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return '';
  return t.toISOString().slice(0, 10);
}
function normTime_(v) {
  var m = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]\.?m\.?)?$/i.exec(String(v).trim());
  if (!m) return '';
  var h = +m[1], mi = +m[2];
  if (m[3]) { if (h < 1 || h > 12) return ''; h = h % 12 + (/^p/i.test(m[3]) ? 12 : 0); }
  if (h > 23 || mi > 59) return '';
  return (h < 10 ? '0' : '') + h + ':' + m[2];
}
/** Apply one row edited by hand. Invalid or server-owned changes are put back, and the borehole is flagged. */
function handEdit_(db, env, r, prevArr, day) {
  var p = {}, i, k;
  for (i = 0; i < SNAP_.length; i++) p[SNAP_[i]] = prevArr[i];
  var n = copy_(r), bad = [];
  var was = function (key) { var v = r[key]; v = v === undefined || v === null ? '' : typeof v === 'number' ? (isFinite(v) ? Math.round(v * 1e6) / 1e6 : 'NaN') : v; return JSON.stringify(v) !== JSON.stringify(p[key]); };
  var back = function (key, why) { n[key] = p[key] === '' && NUMERIC_[key] ? null : p[key]; if (why) bad.push(why); };
  for (i = 0; i < SERVER_OWNED_.length; i++) {
    k = SERVER_OWNED_[i];
    if (was(k)) back(k, k === 'num' ? 'Reading ID (it cannot be changed)' : 'a hidden sync column');
  }
  if (was('boreholeName')) {
    var to = liveClash_(db, String(r.boreholeName), '');
    if (to) { n.boreholeUid = to.uid; n.boreholeName = to.name; } // moved to another borehole
    else back('boreholeName', 'Borehole Name (there is no borehole called "' + r.boreholeName + '")');
  }
  if (was('date')) { var d = normDate_(r.date, dayFirst_(env)); if (d) n.date = d; else back('date', 'Date (use YYYY-MM-DD)'); }
  if (was('time')) { var tm = normTime_(r.time); if (tm) n.time = tm; else back('time', 'Time (use HH:MM)'); }
  if (was('referencePoint')) n.referencePoint = String(r.referencePoint);
  if (was('notes')) n.notes = String(r.notes);
  if (was('userCode')) n.userCode = String(r.userCode).trim();
  if (was('refElevationFt') && !okNum_(r.refElevationFt)) back('refElevationFt', 'Reference Elevation (not a number)');
  if (was('depthFt')) { if (!okNum_(r.depthFt) || r.depthFt < 0) back('depthFt', 'Depth (not a number of feet, 0 or more)'); }
  else if (was('waterElevationFt')) {
    // Only Water Elevation was changed: keep it by working out the depth from it.
    var dd = okNum_(r.waterElevationFt) && okNum_(n.refElevationFt) ? round6_(n.refElevationFt - r.waterElevationFt) : -1;
    if (dd >= 0) n.depthFt = dd; else back('waterElevationFt', 'Water Elevation (it must be a number at or below the Reference Elevation)');
  }
  fixRow_(n);
  n.updatedAt = after_(r.updatedAt, env);
  putR_(db, n);
  if (bad.length) flagB_(db, env, n.boreholeUid, 'Reading ' + n.num + ': a sheet edit was put back (' + bad.join('; ') + ') ' + day + '.');
}

// ---------------- 0.6.0: one-time move to the Readings table ----------------
/**
 * Rewrites the Readings tab as a table: one reading per row, readable columns first, sync columns hidden. A copy of the
 * old tab is kept ("Readings before 0.6.0 ..."). Reading IDs become one number for the whole sheet (1, 2, 3 ... in
 * date order); the old ID (OD-0007) moves to the hidden Old Reading ID column. Nothing is matched by Reading ID, so
 * phones keep syncing by UID. Every reading's Rev is bumped so phones get the new numbers. Safe to run again: valid
 * numbers are kept.
 */
function migrate_(env) {
  var ss = env.ss, cols = COLS_.Readings, i, c;
  var sh = ss.getSheetByName('Readings');
  if (!sh || sh.getLastRow() < 1) sh = sheetFor_(ss, 'Readings');
  // Crash safety: the live tab is cleared only after its copy exists and MIGRATING names that copy. If a run stops
  // half-way (time-out, quota), the next run reads from the copy again, never from the half-written tab.
  var pending = env.props.getProperty('MIGRATING') || '', src = pending ? ss.getSheetByName(pending) : null;
  if (!src) { src = sh; pending = ''; }
  var liveLastRow = sh.getLastRow(), liveLastCol = sh.getLastColumn();
  var lastCol = src.getLastColumn(), last = src.getLastRow();
  var head = src.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  var idx = cols.map(function (x) { return head.indexOf(x[1]); });
  var missing = cols.filter(function (x, j) { return idx[j] < 0 && !OPTIONAL_[x[0]]; });
  if (missing.length) throw new Error('Sheet "Readings" is missing column ' + missing[0][1] + '. Do not rename or delete the header row.');
  var data = last > 1 ? src.getRange(2, 1, last - 1, lastCol).getValues() : [];
  var fx = last > 1 ? src.getRange(2, 1, last - 1, lastCol).getFormulas() : [];
  var foreign = [];
  for (c = 0; c < lastCol; c++) if (idx.indexOf(c) < 0) foreign.push(c);
  var keepCell = function (row, f, cc) { return f[cc] ? f[cc] : typeof row[cc] === 'string' ? guard_(row[cc]) : row[cc]; };
  var recs = [], others = [], seen = {}, iNum = colIndex_('Readings', 'num'), iOld = colIndex_('Readings', 'oldId');
  for (i = 0; i < data.length; i++) {
    var row = data[i];
    if (row.every(function (v) { return v === '' || v === null; })) continue; // a blanked (deleted) row from before 0.6.0
    var o = {};
    for (c = 0; c < cols.length; c++) o[cols[c][0]] = idx[c] < 0 ? '' : fromCell_(cols[c][0], row[idx[c]]);
    var raw = String(row[idx[iNum]]).trim();
    if (!/^\d+$/.test(raw)) { if (!o.oldId) o.oldId = raw; o.num = null; }
    var extra = foreign.map(function (cc) { return keepCell(row, fx[i], cc); });
    if (o.uid && !seen[o.uid]) { seen[o.uid] = 1; recs.push({ o: o, extra: extra }); }
    else {
      // Not a reading (no UID, or a copy of one): kept for Odin, but its sync columns are blanked so it can never pass
      // for the reading it was copied from.
      var ours = cols.map(function (x, j) { return idx[j] < 0 || SYNC_ONLY_[x[0]] ? '' : keepCell(row, fx[i], idx[j]); });
      if (o.uid) ours[colIndex_('Readings', 'notes')] = 'Copied row, not synced. ' + (o.notes || '');
      others.push({ ours: ours, extra: extra });
    }
  }
  // First run: number everything 1..N in date order. Once numbers have been handed out (NUM_MAX set), never renumber:
  // valid unique numbers stay, and only a missing/invalid/duplicate one gets the next number.
  var numMax = Number(env.props.getProperty('NUM_MAX') || 0), settled = numMax > 0;
  var key = function (x) { return [x.o.date, x.o.time, x.o.createdAt, x.o.uid].join('\u0001'); };
  var byDate = function (a, b) { return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0; };
  var nums = {}, ok = function (n) { return n > 0 && Math.floor(n) === n; };
  recs.sort(byDate);
  for (i = 0; i < recs.length; i++) {
    var nn = recs[i].o.num;
    if (settled && ok(nn) && !nums[nn]) { nums[nn] = 1; if (nn > numMax) numMax = nn; } else recs[i].o.num = null;
  }
  var rev = rev_(env);
  for (i = 0; i < recs.length; i++) if (Number(recs[i].o.rev) > rev) rev = Number(recs[i].o.rev);
  if (recs.length) rev++;
  for (i = 0; i < recs.length; i++) {
    var ro = recs[i].o;
    if (!ro.num) ro.num = ++numMax;
    ro.rev = rev;
  }
  recs.sort(function (a, b) { return a.o.num - b.o.num; });
  var out = [cols.map(function (x) { return x[1]; }).concat(foreign.map(function (cc) { return head[cc]; }))];
  for (i = 0; i < recs.length; i++) out.push(cols.map(function (x) { return toCell_(x[0], recs[i].o[x[0]]); }).concat(recs[i].extra));
  for (i = 0; i < others.length; i++) out.push(others[i].ours.concat(others[i].extra));
  var width = out[0].length;

  var stamp = env.now().slice(0, 16).replace('T', ' ').replace(':', '.');
  var backup = pending;
  if (!pending && last > 1) {
    backup = 'Readings before 0.6.0 ' + stamp;
    var bk = sh.copyTo(ss);
    bk.setName(ss.getSheetByName(backup) ? backup + ' (' + Math.random().toString(36).slice(2, 6) + ')' : backup);
    backup = bk.getName();
    env.props.setProperty('MIGRATING', backup);
  }
  sh.getRange(1, 1, Math.max(liveLastRow, 1), Math.max(liveLastCol, 1)).clearContent();
  if (sh.getMaxRows() < out.length + 1) sh.insertRowsAfter(sh.getMaxRows(), out.length + 1 - sh.getMaxRows() + 100);
  // Whole numbers for Reading ID / Seq / Rev, decimals for feet, plain text for the rest (so 0.5.0 text formats go).
  for (c = 0; c < cols.length; c++) {
    var k0 = cols[c][0];
    sh.getRange(1, c + 1, sh.getMaxRows(), 1).setNumberFormat(!NUMERIC_[k0] ? '@' : k0 === 'num' || k0 === 'seq' || k0 === 'rev' ? '0' : '0.00####');
  }
  sh.getRange(1, 1, out.length, width).setValues(out);

  // Check: every reading is still there, with the same values.
  var check = loadTable_(ss, 'Readings');
  if (check.rows.length !== recs.length) {
    throw new Error('Setup check failed: ' + recs.length + ' readings before, ' + check.rows.length + ' after. The original is in tab "' + backup + '".');
  }
  var how = layoutReadings_(env, sh, out.length, cols.length);
  // The index starts from the migrated rows: later hand edits are measured against these.
  var L = loadIndex_(ss);
  L.map = {};
  for (i = 0; i < check.rows.length; i++) L.map[check.rows[i].uid] = snap_(check.rows[i]);
  L.changed = true;
  saveIndex_(ss, L);
  // All at once, so a stop here can never leave "numbered" without "laid out" (or the reverse).
  var fin = { NUM_MAX: String(numMax), LAYOUT: String(LAYOUT_), MIGRATING: '' };
  if (rev > rev_(env)) fin.REV = String(rev);
  if (env.props.setProperties) env.props.setProperties(fin); else for (var fk in fin) env.props.setProperty(fk, fin[fk]);
  return 'Readings table ready: ' + recs.length + ' readings' + (others.length ? ' (+' + others.length + ' rows without a Reading UID or copied, kept at the bottom, not synced)' : '') +
    (backup ? '. Old tab kept as "' + backup + '"' : '') + '. Formatting: ' + how + '.';
}
/** Header, frozen row, hidden + warning-protected sync columns, and a real Table if the Sheets API service is on. */
function layoutReadings_(env, sh, rows, nCols) {
  var h = READING_VISIBLE_, how = '';
  sh.setFrozenRows(1);
  try { sh.getRange(1, 1, 1, nCols).setFontWeight('bold'); } catch (err) { /* cosmetic */ }
  if (env.tables) {
    try {
      var t = env.tables.find(sh);
      if (!t) {
        var f = sh.getFilter && sh.getFilter();
        if (f) f.remove(); // a table cannot overlap a basic filter
        env.tables.add(sh, Math.max(rows, 2), nCols, COLS_.Readings.map(function (x, j) {
          return { columnIndex: j, columnName: x[1], columnType: NUMERIC_[x[0]] ? 'DOUBLE' : 'TEXT' };
        }));
      } else env.tables.resize(sh, t, Math.max(rows, t.range.endRowIndex, 2), Math.max(nCols, t.range.endColumnIndex));
      how = 'Google Sheets table "' + TABLE_NAME_ + '"';
    } catch (err) { how = 'filter (the table could not be made: ' + (err && err.message || err) + ')'; }
  } else how = 'filter (turn on Services > Google Sheets API for a real table, then run Set up again)';
  if (how.indexOf('filter') === 0) {
    try { if (!sh.getFilter()) sh.getRange(1, 1, sh.getMaxRows(), nCols).createFilter(); } catch (err) { /* cosmetic */ }
    try { sh.getRange(1, 1, sh.getMaxRows(), nCols).applyRowBanding(); } catch (err) { /* already banded */ }
  }
  try { sh.hideColumns(h + 1, nCols - h); } catch (err) { /* cosmetic */ }
  try {
    var ps = sh.getProtections ? sh.getProtections(SpreadsheetApp.ProtectionType.RANGE) : [];
    var has = false;
    for (var i = 0; i < ps.length; i++) if (ps[i].getDescription() === 'Water Level Log sync columns') has = true;
    if (!has) sh.getRange(1, h + 1, sh.getMaxRows(), nCols - h).protect().setDescription('Water Level Log sync columns').setWarningOnly(true);
  } catch (err) { /* cosmetic */ }
  return how;
}
