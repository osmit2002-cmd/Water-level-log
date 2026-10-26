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
  Readings: [
    ['displayId', 'Reading ID'], ['boreholeName', 'Borehole Name'], ['date', 'Date'], ['time', 'Time'], ['userCode', 'User Code'],
    ['referencePoint', 'Reference Point'], ['refElevationFt', 'Reference Elevation (ft)'], ['depthFt', 'Depth to Top of Water (ft)'],
    ['waterElevationFt', 'Water Elevation (ft)'], ['notes', 'Notes'], ['createdAt', 'Created At'], ['updatedAt', 'Updated At'],
    ['uid', 'Reading UID'], ['boreholeUid', 'Borehole UID'], ['seq', 'Seq'], ['rev', 'Rev']
  ],
  Tombstones: [['kind', 'Kind'], ['uid', 'UID'], ['deletedAt', 'Deleted At'], ['mergedInto', 'Merged Into'], ['rev', 'Rev'], ['restoredAt', 'Restored At']]
};
// Columns added after 0.4.0: added to an existing sheet's header instead of failing.
var OPTIONAL_ = { restoredAt: 1 };
var NUMERIC_ = { refElevationFt: 1, depthFt: 1, waterElevationFt: 1, seq: 1, rev: 1 };

// ---------------- web entry points ----------------
function doPost(e) {
  return json_(handleRequest_(e && e.postData ? e.postData.contents : '', liveEnv_()));
}
function doGet(e) {
  // Only a health check: data is never served over GET, so the team code never has to go in a URL.
  return json_({ ok: true, message: 'Water Level Log sync is running. Enter this URL and the team code in the app.' });
}
function liveEnv_() {
  return { ss: SpreadsheetApp.getActiveSpreadsheet(), props: PropertiesService.getScriptProperties(), lock: LockService.getScriptLock(), now: function () { return new Date().toISOString(); } };
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
    var db = loadAll_(env.ss);
    db.rev = maxRev_(db, env);
    if (req.op === 'pull') return pull_(db, Number(req.since) || 0);
    var out = push_(db, req, env);
    saveTable_(db.B); saveTable_(db.T); saveTable_(db.R); // boreholes first: a cut-off write never leaves readings without their borehole
    env.props.setProperty('REV', String(db.rev)); // last: the batch is complete
    return out;
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  } finally {
    env.lock.releaseLock();
  }
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
  if (NUMERIC_[k]) return v === '' || v === null ? null : Number(v);
  if (v instanceof Date) return k === 'date' ? v.toISOString().slice(0, 10) : v.toISOString();
  return String(v === undefined || v === null ? '' : v); // Sheets drops the leading ' that toCell_ adds
}
function loadTable_(ss, name) {
  var sh = sheetFor_(ss, name), cols = COLS_[name];
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  var idx = cols.map(function (c) { return head.indexOf(c[1]); });
  var missing = cols.filter(function (c, i) { return idx[i] < 0 && !OPTIONAL_[c[0]]; });
  if (missing.length) throw new Error('Sheet "' + name + '" is missing column ' + missing[0][1] + '. Do not rename or delete the header row.');
  var last = sh.getLastRow(), rows = [];
  var vals = last > 1 ? sh.getRange(2, 1, last - 1, head.length).getValues() : [];
  for (var r = 0; r < vals.length; r++) {
    var o = {};
    for (var c = 0; c < cols.length; c++) o[cols[c][0]] = idx[c] < 0 ? '' : fromCell_(cols[c][0], vals[r][idx[c]]);
    if (o.uid) { o._row = r + 2; rows.push(o); }
  }
  return { sheet: sh, name: name, head: head, idx: idx, rows: rows, last: last, dirty: {}, cleared: [] };
}
/** Write only the rows that changed (and append new ones); other rows, and columns that are not ours, are untouched. */
function saveTable_(t) {
  var cols = COLS_[t.name], sh = t.sheet, uid, i, c;
  var writes = {}, rowsToWrite = [], appended = [];
  for (i = 0; i < t.cleared.length; i++) writes[t.cleared[i]] = null;
  for (uid in t.dirty) {
    var o = t.dirty[uid];
    if (!o._row) { o._row = ++t.last; appended.push(o._row); }
    writes[o._row] = o;
  }
  for (var k in writes) rowsToWrite.push(Number(k));
  if (!rowsToWrite.length) return;
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
        for (c = 0; c < cols.length; c++) row[t.idx[c] - c0] = obj ? toCell_(cols[c][0], obj[cols[c][0]]) : '';
      }
      out.push(row);
    }
    rg.setValues(out);
  }
}
function loadAll_(ss) {
  var db = { B: loadTable_(ss, 'Boreholes'), R: loadTable_(ss, 'Readings'), T: loadTable_(ss, 'Tombstones') };
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
  return { uid: x.uid, displayId: s(x.displayId), boreholeUid: x.boreholeUid, datetime: x.datetime.slice(0, 16), userCode: s(x.userCode), seq: Number(x.seq) || 0,
    referencePoint: s(x.referencePoint), refElevationFt: x.refElevationFt, depthFt: x.depthFt, notes: s(x.notes), createdAt: s(x.createdAt), updatedAt: s(x.updatedAt) };
}
function readingRow_(r, bh) {
  return { displayId: r.displayId, boreholeName: bh.name, date: r.datetime.slice(0, 10), time: r.datetime.slice(11, 16), userCode: r.userCode,
    referencePoint: r.referencePoint, refElevationFt: r.refElevationFt, depthFt: r.depthFt, waterElevationFt: Math.round((r.refElevationFt - r.depthFt) * 1e6) / 1e6,
    notes: r.notes, createdAt: r.createdAt, updatedAt: r.updatedAt, uid: r.uid, boreholeUid: bh.uid, seq: r.seq };
}

// ---------------- in-memory changes (written by saveTable_) ----------------
function put_(tbl, map, o, db) {
  o.rev = bump_(db);
  var cur = map[o.uid];
  if (cur) { o._row = cur._row; tbl.rows[tbl.rows.indexOf(cur)] = o; } else tbl.rows.push(o);
  map[o.uid] = o; tbl.dirty[o.uid] = o;
}
function putB_(db, b) { put_(db.B, db.b, b, db); }
function putR_(db, r) { put_(db.R, db.r, r, db); }
function putT_(db, t) { put_(db.T, db.t, t, db); }
/** Remove a row's data (the row is blanked; other columns and rows are left alone). */
function clearRow_(tbl, map, uid) {
  var cur = map[uid];
  if (!cur) return;
  tbl.rows.splice(tbl.rows.indexOf(cur), 1); delete map[uid]; delete tbl.dirty[uid];
  if (cur._row) tbl.cleared.push(cur._row);
}
function addTomb_(db, env, t) {
  putT_(db, { kind: t.kind, uid: t.uid, deletedAt: t.deletedAt || env.now(), mergedInto: t.mergedInto || '', restoredAt: '' });
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
  nb.flag = text; nb.flagAt = when; if (when > nb.updatedAt) nb.updatedAt = when;
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
      if (r.boreholeUid === fromUid) putR_(db, n); else { db.R.dirty[n.uid] = n; n._row = r._row; db.R.rows[db.R.rows.indexOf(r)] = n; db.r[n.uid] = n; }
    }
  }
}
function liveReadingsOf_(db, buid) { return db.R.rows.filter(function (r) { return r.boreholeUid === buid; }); }

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
    if (dead_(db, tb.uid) || (db.t[tb.uid] && db.t[tb.uid].mergedInto)) continue;
    if (tb.kind === 'reading') {
      var cr = db.r[tb.uid];
      if (cr && cr.updatedAt > tb.deletedAt) {
        flagB_(db, env, cr.boreholeUid, 'Reading ' + cr.displayId + ' was deleted on a phone but edited later on another; it was kept ' + day + '. Delete it again if it is not wanted.');
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

  // 3. Readings: insert, or newest edit wins for depth/notes. Reference values, date/time, code and number never change.
  for (i = 0; i < rds.length; i++) {
    var r = rds[i], rk = 'r:' + r.uid;
    var rgone = dead_(db, r.uid), restored = false;
    if (rgone && !(r.updatedAt > rgone.deletedAt)) { acked.push(rk); continue; }
    var bu = canon_(db, r.boreholeUid);
    if (dead_(db, bu)) { held.push({ key: rk, reason: 'Its borehole was deleted on another phone; this phone will restore it' }); continue; }
    var bh = db.b[bu];
    if (!bh) { held.push({ key: rk, reason: 'Its borehole has not been uploaded yet' }); continue; }
    if (rgone) { restoreTomb_(db, env, r.uid); restored = true; } // only once the row will really be stored
    var old = db.r[r.uid];
    if (!old) putR_(db, readingRow_(r, bh));
    else if (r.updatedAt > old.updatedAt) {
      var upd = copy_(old);
      upd.depthFt = r.depthFt; upd.notes = r.notes; upd.updatedAt = r.updatedAt;
      upd.waterElevationFt = Math.round((old.refElevationFt - r.depthFt) * 1e6) / 1e6;
      putR_(db, upd);
    }
    if (restored) flagB_(db, env, bh.uid, 'Reading ' + r.displayId + ' was deleted on a phone but edited later on another; it was kept ' + day + '. Delete it again if it is not wanted.');
    acked.push(rk);
  }
  return { ok: true, acked: acked, rejected: rejected, held: held };
}

function pull_(db, since) {
  var after = function (x) { return Number(x.rev) > since; };
  return {
    ok: true,
    cursor: db.rev,
    boreholes: db.B.rows.filter(after).map(function (b) {
      return { uid: b.uid, name: b.name, referencePoint: b.referencePoint, refElevationFt: b.refElevationFt, flag: b.flag || '', nameAt: b.nameAt, referencePointAt: b.referencePointAt,
        refElevationAt: b.refElevationAt, flagAt: b.flagAt, createdAt: b.createdAt, updatedAt: b.updatedAt };
    }),
    readings: db.R.rows.filter(after).map(function (r) {
      return { uid: r.uid, displayId: r.displayId, boreholeUid: r.boreholeUid, boreholeName: r.boreholeName, datetime: r.date + 'T' + r.time, userCode: r.userCode, seq: r.seq,
        referencePoint: r.referencePoint, refElevationFt: r.refElevationFt, depthFt: r.depthFt, notes: r.notes, createdAt: r.createdAt, updatedAt: r.updatedAt };
    }),
    tombstones: db.T.rows.filter(after).map(function (t) {
      var o = { uid: t.uid, kind: t.kind, deletedAt: t.deletedAt };
      if (t.mergedInto) o.mergedInto = t.mergedInto;
      if (t.restoredAt) o.restoredAt = t.restoredAt;
      return o;
    })
  };
}
