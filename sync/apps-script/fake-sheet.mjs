// In-memory stand-ins for SpreadsheetApp / PropertiesService / LockService, used by unit tests and the e2e mock
// endpoint. They implement only what Code.gs calls. Loading Code.gs runs the real server logic in Node.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

class FakeRange {
  constructor(sh, r, c, nr, nc) { Object.assign(this, { sh, r, c, nr, nc }); }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) row.push(this.sh.data[this.r - 1 + i]?.[this.c - 1 + j] ?? ''); out.push(row); }
    return out;
  }
  /** Like Sheets: '' unless the cell holds a formula. */
  getFormulas() {
    const out = [];
    for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) row.push(this.sh.formulas.get(`${this.r + i},${this.c + j}`) ?? ''); out.push(row); }
    return out;
  }
  setValues(v) {
    if (v.length !== this.nr || v.some((row) => row.length !== this.nc)) throw new Error('setValues: size mismatch');
    const ss = this.sh.ss;
    if (ss && ss.failAfter != null && ss.failAfter-- <= 0) { ss.failAfter = null; throw new Error('Exceeded maximum execution time'); }
    if (this.r - 1 + this.nr > this.sh.maxRows) throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
    // Like Sheets: a leading ' only marks the cell as literal text (kept in .quoted for assertions) and is not stored.
    // A string starting with = becomes a formula (its value here is "#FORMULA").
    v.forEach((row, i) => row.forEach((x, j) => {
      const key = `${this.r + i},${this.c + j}`;
      this.sh.formulas.delete(key);
      if (typeof x === 'string' && x.charAt(0) === "'") { this.sh.quoted.add(x.slice(1)); x = x.slice(1); }
      else if (typeof x === 'string' && x.charAt(0) === '=') { this.sh.formulas.set(key, x); x = '#FORMULA'; }
      (this.sh.data[this.r - 1 + i] ??= [])[this.c - 1 + j] = x;
    }));
    this.sh.rowsWritten += v.length;
    this.sh.writes++;
    return this;
  }
  clearContent() { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) if (this.sh.data[this.r - 1 + i]) this.sh.data[this.r - 1 + i][this.c - 1 + j] = ''; this.sh.trim(); return this; }
  setNumberFormat(f) { this.sh.formats.push([this.c, f]); return this; }
  setFontWeight() { return this; }
  createFilter() { this.sh.filter = { range: [this.r, this.c, this.nr, this.nc], remove: () => { this.sh.filter = null; } }; return this.sh.filter; }
  protect() { const p = { desc: '', warn: false, setDescription(d) { p.desc = d; return p; }, setWarningOnly(w) { p.warn = w; return p; } }; this.sh.protections.push(p); return p; }
}
export class FakeSheet {
  constructor(name) { this.name = name; this.data = []; this.formats = []; this.writes = 0; this.frozen = 0; this.maxRows = 1000; this.quoted = new Set(); this.formulas = new Map(); this.rowsWritten = 0; this.hiddenCols = []; this.protections = []; this.filter = null; this.hidden = false; }
  getName() { return this.name; }
  setName(n) { if (this.ss) { this.ss.sheets.delete(this.name); this.ss.sheets.set(n, this); } this.name = n; return this; }
  getSheetId() { return this.id ?? 0; }
  hideSheet() { this.hidden = true; }
  hideColumns(c, n) { this.hiddenCols.push([c, n]); }
  getFilter() { return this.filter; }
  /** Like Sheets: the rows below move up; a sheet keeps at least one row below a frozen header. */
  deleteRow(r) {
    if (this.maxRows <= this.frozen + 1) throw new Error("You can't delete all the rows on the sheet.");
    this.data.splice(r - 1, 1); this.maxRows--;
    const f = new Map();
    for (const [k, v] of this.formulas) { const [rr, cc] = k.split(',').map(Number); if (rr !== r) f.set(`${rr > r ? rr - 1 : rr},${cc}`, v); }
    this.formulas = f; this.deletes = (this.deletes ?? 0) + 1;
  }
  copyTo(ss) {
    const c = new FakeSheet(`Copy of ${this.name}`); c.ss = ss; c.data = this.data.map((r) => [...r]); c.formulas = new Map(this.formulas);
    ss.sheets.set(c.name, c); return c;
  }
  trim() { while (this.data.length && this.data[this.data.length - 1].every((x) => x === '' || x == null)) this.data.pop(); }
  getLastRow() { this.trim(); return this.data.length; }
  getLastColumn() { return Math.max(0, ...this.data.map((r) => r.length)); }
  getMaxRows() { return this.maxRows; }
  insertRowsAfter(after, n) { if (after > this.maxRows) throw new Error('bad row'); this.maxRows += n; return this; }
  getRange(r, c, nr = 1, nc = 1) { return new FakeRange(this, r, c, nr, nc); }
  setFrozenRows(n) { this.frozen = n; }
  /** Header + rows as objects keyed by header text (for assertions). */
  objects() { const [h, ...rows] = this.data; return rows.map((r) => Object.fromEntries(h.map((k, i) => [k, r[i] ?? '']))); }
}
export class FakeSpreadsheet {
  constructor() { this.sheets = new Map(); /** Test hook: the Nth setValues from now throws (simulated timeout). */ this.failAfter = null; }
  getSheetByName(n) { return this.sheets.get(n) ?? null; }
  insertSheet(n) { const s = new FakeSheet(n); s.ss = this; s.id = this.sheets.size + 1; this.sheets.set(n, s); return s; }
}
/** Stand-in for the Advanced Sheets "Tables" calls (env.tables in Code.gs). */
export function fakeTables() {
  const t = { list: [], calls: [],
    find: (sh) => t.list.find((x) => x.sheet === sh) ?? null,
    add: (sh, rows, cols, props) => { t.calls.push('add'); t.list.push({ sheet: sh, tableId: 't1', props, range: { endRowIndex: rows, endColumnIndex: cols } }); },
    resize: (sh, x, rows, cols) => { t.calls.push('resize'); x.range = { endRowIndex: rows, endColumnIndex: cols }; } };
  return t;
}
export function fakeEnv({ team = 'TEAM-123', clock, tables } = {}) {
  const store = new Map(team === null ? [] : [['TEAM_CODE', team]]);
  let locked = false;
  let t = Date.parse('2026-10-26T14:00:00Z');
  return {
    ss: new FakeSpreadsheet(),
    props: { getProperty: (k) => store.get(k) ?? null, setProperty: (k, v) => { store.set(k, v); }, setProperties: (o) => { for (const k in o) store.set(k, o[k]); } },
    lock: { waitLock: () => { if (locked) throw new Error('busy'); locked = true; }, releaseLock: () => { locked = false; } },
    now: clock ?? (() => new Date(t += 1000).toISOString()),
    _store: store,
    tables: tables ?? null,
    isLocked: () => locked
  };
}
/** Load Code.gs into a sandbox; returns its global functions. */
export function loadCodeGs(path = new URL('./Code.gs', import.meta.url)) {
  const ctx = vm.createContext({ JSON, Math, Number, String, Date, Array, Object, isFinite });
  vm.runInContext(readFileSync(path, 'utf8'), ctx, { filename: 'Code.gs' });
  return ctx;
}
