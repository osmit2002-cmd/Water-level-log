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
  setValues(v) {
    if (v.length !== this.nr || v.some((row) => row.length !== this.nc)) throw new Error('setValues: size mismatch');
    if (this.r - 1 + this.nr > this.sh.maxRows) throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
    // Like Sheets: a leading ' only marks the cell as literal text (kept in .quoted for assertions) and is not stored.
    v = v.map((row) => row.map((x) => { if (typeof x === 'string' && x.charAt(0) === "'") { this.sh.quoted.add(x.slice(1)); return x.slice(1); } return x; }));
    v.forEach((row, i) => row.forEach((x, j) => { (this.sh.data[this.r - 1 + i] ??= [])[this.c - 1 + j] = x; }));
    this.sh.writes++;
    return this;
  }
  clearContent() { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) if (this.sh.data[this.r - 1 + i]) this.sh.data[this.r - 1 + i][this.c - 1 + j] = ''; this.sh.trim(); return this; }
  setNumberFormat(f) { this.sh.formats.push([this.c, f]); return this; }
}
export class FakeSheet {
  constructor(name) { this.name = name; this.data = []; this.formats = []; this.writes = 0; this.frozen = 0; this.maxRows = 1000; this.quoted = new Set(); }
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
  constructor() { this.sheets = new Map(); }
  getSheetByName(n) { return this.sheets.get(n) ?? null; }
  insertSheet(n) { const s = new FakeSheet(n); this.sheets.set(n, s); return s; }
}
export function fakeEnv({ team = 'TEAM-123', clock } = {}) {
  const store = new Map(team === null ? [] : [['TEAM_CODE', team]]);
  let locked = false;
  let t = Date.parse('2026-10-26T14:00:00Z');
  return {
    ss: new FakeSpreadsheet(),
    props: { getProperty: (k) => store.get(k) ?? null, setProperty: (k, v) => { store.set(k, v); } },
    lock: { waitLock: () => { if (locked) throw new Error('busy'); locked = true; }, releaseLock: () => { locked = false; } },
    now: clock ?? (() => new Date(t += 1000).toISOString()),
    _store: store,
    isLocked: () => locked
  };
}
/** Load Code.gs into a sandbox; returns its global functions. */
export function loadCodeGs(path = new URL('./Code.gs', import.meta.url)) {
  const ctx = vm.createContext({ JSON, Math, Number, String, Date, Array, Object, isFinite });
  vm.runInContext(readFileSync(path, 'utf8'), ctx, { filename: 'Code.gs' });
  return ctx;
}
