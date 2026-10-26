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

var MAX_ITEMS_ = 500;
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
  Tombstones: [['kind', 'Kind'], ['uid', 'UID'], ['deletedAt', 'Deleted At'], ['mergedInto', 'Merged Into'], ['rev', 'Rev']]
};
var NUMERIC_ = { refElevationFt: 1, depthFt: 1, waterElevationFt: 1, seq: 1, rev: 1 };

// ---------------- web entry points ----------------
function doPost(e) {
  return json_(handleRequest_(e && e.postData ? e.postData.contents : '', liveEnv_()));
}
function doGet(e) {
  var p = (e && e.parameter) || {};
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
function handleRequest_(text, env) {
  var req;
  try { req = JSON.parse(text || '{}'); } catch (err) { return { ok: false, error: 'Bad request' }; }
  if (!req || typeof req !== 'object') return { ok: false, error: 'Bad request' };
  var code = teamCode_(env.props);
  if (!code || code === 'CHANGE-ME') return { ok: false, error: 'The team code has not been set in the Apps Script yet' };
  if (!safeEq_(String(req.team || ''), code)) return { ok: false, error: 'Wrong team code' };
  if (req.op === 'ping') return { ok: true, message: 'Connected to the team sheet' };
  if (req.op !== 'push' && req.op !== 'pull') return { ok: false, error: 'Unknown operation' };
  try { env.lock.waitLock(25000); } catch (err) { return { ok: false, error: 'The sheet is busy, try again' }; }
  try {
    var db = loadAll_(env.ss);
    db.rev = maxRev_(db, env);
    var out = req.op === 'push' ? push_(db, req, env) : pull_(db, Number(req.since) || 0, env);
    if (req.op === 'push') saveAll_(db, env);
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
function toCell_(k, v) {
  if (v === undefined || v === null) return '';
  if (NUMERIC_[k]) return Number(v);
  var s = String(v);
  return /^[=+\-@']/.test(s) ? "'" + s : s; // never let a value become a formula
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
  var missing = cols.filter(function (c, i) { return idx[i] < 0; });
  if (missing.length) throw new Error('Sheet "' + name + '" is missing column ' + missing[0][1] + '. Do not rename or delete the header row.');
  var n = sh.getLastRow() - 1, rows = [];
  var vals = n > 0 ? sh.getRange(2, 1, n, head.length).getValues() : [];
  for (var r = 0; r < vals.length; r++) {
    var o = {};
    for (var c = 0; c < cols.length; c++) o[cols[c][0]] = fromCell_(cols[c][0], vals[r][idx[c]]);
    if (o.uid) rows.push(o);
  }
  return { sheet: sh, name: name, head: head, idx: idx, rows: rows, oldCount: n, dirty: false };
}
function saveTable_(t) {
  if (!t.dirty) return;
  var cols = COLS_[t.name], w = t.head.length;
  var out = t.rows.map(function (o) {
    var row = []; for (var i = 0; i < w; i++) row.push('');
    for (var c = 0; c < cols.length; c++) row[t.idx[c]] = toCell_(cols[c][0], o[cols[c][0]]);
    return row;
  });
  var sh = t.sheet, need = out.length + 1;
  if (sh.getMaxRows() < need) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows() + 100);
  if (t.oldCount > 0) sh.getRange(2, 1, t.oldCount, w).clearContent();
  if (out.length) {
    // Keep text columns as plain text on every write (new rows past the first format do not inherit it).
    for (var c = 0; c < cols.length; c++) if (!NUMERIC_[cols[c][0]]) sh.getRange(2, t.idx[c] + 1, out.length, 1).setNumberFormat('@');
    sh.getRange(2, 1, out.length, w).setValues(out);
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
function saveAll_(db, env) { saveTable_(db.B); saveTable_(db.R); saveTable_(db.T); env.props.setProperty('REV', String(db.rev || rev_(env))); }
function byUid_(rows) { var m = {}; for (var i = 0; i < rows.length; i++) m[rows[i].uid] = rows[i]; return m; }
function rev_(env) { return Number(env.props.getProperty('REV') || 0); }
function bump_(db, env) { db.rev = (db.rev || rev_(env)) + 1; return db.rev; }

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
function canon_(db, uid) {
  for (var i = 0; i < 20 && db.t[uid] && db.t[uid].mergedInto; i++) uid = db.t[uid].mergedInto;
  return uid;
}
function bKey_(b) { return [b.name, b.referencePoint, b.refElevationFt, b.flag, b.nameAt, b.referencePointAt, b.refElevationAt, b.flagAt].join('\u0001'); }

function cleanB_(x) {
  if (!x || typeof x.uid !== 'string' || !x.uid || typeof x.name !== 'string' || !x.name.trim() || typeof x.refElevationFt !== 'number' || !isFinite(x.refElevationFt)) return null;
  var s = function (v) { return v === undefined || v === null ? '' : String(v); };
  return { uid: x.uid, name: x.name.trim(), referencePoint: s(x.referencePoint), refElevationFt: x.refElevationFt, flag: s(x.flag),
    nameAt: s(x.nameAt), referencePointAt: s(x.referencePointAt), refElevationAt: s(x.refElevationAt), flagAt: s(x.flagAt), createdAt: s(x.createdAt), updatedAt: s(x.updatedAt) };
}
function cleanR_(x) {
  if (!x || typeof x.uid !== 'string' || !x.uid || typeof x.boreholeUid !== 'string' || typeof x.datetime !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(x.datetime)) return null;
  if (typeof x.depthFt !== 'number' || !isFinite(x.depthFt) || typeof x.refElevationFt !== 'number' || !isFinite(x.refElevationFt)) return null;
  var s = function (v) { return v === undefined || v === null ? '' : String(v); };
  return { uid: x.uid, displayId: s(x.displayId), boreholeUid: x.boreholeUid, datetime: x.datetime.slice(0, 16), userCode: s(x.userCode), seq: Number(x.seq) || 0,
    referencePoint: s(x.referencePoint), refElevationFt: x.refElevationFt, depthFt: x.depthFt, notes: s(x.notes), createdAt: s(x.createdAt), updatedAt: s(x.updatedAt) };
}
function readingRow_(r, bh) {
  return { displayId: r.displayId, boreholeName: bh.name, date: r.datetime.slice(0, 10), time: r.datetime.slice(11, 16), userCode: r.userCode,
    referencePoint: r.referencePoint, refElevationFt: r.refElevationFt, depthFt: r.depthFt, waterElevationFt: Math.round((r.refElevationFt - r.depthFt) * 1e6) / 1e6,
    notes: r.notes, createdAt: r.createdAt, updatedAt: r.updatedAt, uid: r.uid, boreholeUid: bh.uid, seq: r.seq };
}

function addTomb_(db, env, t) {
  var row = { kind: t.kind, uid: t.uid, deletedAt: t.deletedAt || env.now(), mergedInto: t.mergedInto || '', rev: bump_(db, env) };
  db.T.rows.push(row); db.t[t.uid] = row; db.T.dirty = true;
  return row;
}
function dropRow_(tbl, map, uid) {
  if (!map[uid]) return;
  tbl.rows = tbl.rows.filter(function (x) { return x.uid !== uid; }); delete map[uid]; tbl.dirty = true;
}
function putB_(db, env, b) {
  b.rev = bump_(db, env);
  if (!db.b[b.uid]) db.B.rows.push(b); else db.B.rows[db.B.rows.indexOf(db.b[b.uid])] = b;
  db.b[b.uid] = b; db.B.dirty = true;
}
function putR_(db, env, r) {
  r.rev = bump_(db, env);
  if (!db.r[r.uid]) db.R.rows.push(r); else db.R.rows[db.R.rows.indexOf(db.r[r.uid])] = r;
  db.r[r.uid] = r; db.R.dirty = true;
}
function liveClash_(db, name, notUid) {
  for (var i = 0; i < db.B.rows.length; i++) if (db.B.rows[i].uid !== notUid && sameName_(db.B.rows[i].name, name)) return db.B.rows[i];
  return null;
}
function relinkReadings_(db, env, fromUid, bh) {
  for (var i = 0; i < db.R.rows.length; i++) {
    var r = db.R.rows[i];
    if (r.boreholeUid === fromUid) { r.boreholeUid = bh.uid; r.boreholeName = bh.name; r.rev = bump_(db, env); db.R.dirty = true; }
    else if (r.boreholeUid === bh.uid && r.boreholeName !== bh.name) { r.boreholeName = bh.name; db.R.dirty = true; }
  }
}

function push_(db, req, env) {
  var acked = [], i;
  var T = req.tombstones || [], B = req.boreholes || [], R = req.readings || [];
  if (!(T instanceof Array) || !(B instanceof Array) || !(R instanceof Array)) throw new Error('Bad push');
  if (T.length + B.length + R.length > MAX_ITEMS_) throw new Error('Too many changes in one request');

  // 1. Deletes. A tombstone is permanent: nothing with that uid is ever stored again.
  for (i = 0; i < T.length; i++) {
    var t = T[i];
    if (!t || typeof t.uid !== 'string' || (t.kind !== 'borehole' && t.kind !== 'reading')) continue;
    if (!db.t[t.uid]) {
      addTomb_(db, env, { kind: t.kind, uid: t.uid, deletedAt: String(t.deletedAt || '') });
      if (t.kind === 'reading') dropRow_(db.R, db.r, t.uid);
      else {
        dropRow_(db.B, db.b, t.uid);
        var dead = db.R.rows.filter(function (r) { return r.boreholeUid === t.uid; });
        for (var j = 0; j < dead.length; j++) { addTomb_(db, env, { kind: 'reading', uid: dead[j].uid, deletedAt: t.deletedAt }); dropRow_(db.R, db.r, dead[j].uid); }
      }
    }
    acked.push('t:' + t.uid);
  }

  // 2. Boreholes: field-by-field newest wins; same name (any case) as another borehole => merge + flag.
  for (i = 0; i < B.length; i++) {
    var b = cleanB_(B[i]);
    if (!b) continue;
    var key = 'b:' + b.uid;
    var uid = canon_(db, b.uid);
    if (db.t[uid]) { acked.push(key); continue; } // deleted: never resurrect
    b.uid = uid;
    var cur = db.b[uid];
    var merged = cur ? mergeBorehole_(cur, b) : b;
    var clash = liveClash_(db, merged.name, uid);
    if (clash) {
      var keep = mergeBorehole_(clash, merged);
      keep.uid = clash.uid; keep.name = clash.name; keep.nameAt = clash.nameAt;
      keep.flag = 'Same Borehole Name was created on two phones; records merged ' + env.now().slice(0, 10) + '. Check the reference values.';
      keep.flagAt = env.now();
      putB_(db, env, keep);
      if (cur) dropRow_(db.B, db.b, uid);
      addTomb_(db, env, { kind: 'borehole', uid: uid, mergedInto: keep.uid });
      relinkReadings_(db, env, uid, keep);
    } else if (!cur || bKey_(cur) !== bKey_(merged)) {
      putB_(db, env, merged);
      relinkReadings_(db, env, '', merged);
    }
    acked.push(key);
  }

  // 3. Readings: insert, or newest edit wins for depth/notes. Reference values, date/time, code and number never change.
  for (i = 0; i < R.length; i++) {
    var r = cleanR_(R[i]);
    if (!r) continue;
    var rk = 'r:' + r.uid;
    if (db.t[r.uid]) { acked.push(rk); continue; }
    var bu = canon_(db, r.boreholeUid);
    if (db.t[bu]) { addTomb_(db, env, { kind: 'reading', uid: r.uid }); acked.push(rk); continue; } // its borehole was deleted
    var bh = db.b[bu];
    if (!bh) continue; // borehole not uploaded yet: leave it queued on the phone
    var old = db.r[r.uid];
    if (!old) putR_(db, env, readingRow_(r, bh));
    else if (r.updatedAt > old.updatedAt) {
      var upd = {}, k;
      for (k in old) upd[k] = old[k];
      upd.depthFt = r.depthFt; upd.notes = r.notes; upd.updatedAt = r.updatedAt;
      upd.waterElevationFt = Math.round((old.refElevationFt - r.depthFt) * 1e6) / 1e6;
      putR_(db, env, upd);
    }
    acked.push(rk);
  }
  return { ok: true, acked: acked };
}

function pull_(db, since, env) {
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
      return o;
    })
  };
}
