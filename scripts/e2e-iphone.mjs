// End-to-end check in Playwright WebKit with iPhone emulation.
// Usage: npm run build && (npx vite preview --port 4173 &) && node scripts/e2e-iphone.mjs [url]
// SHOTS=dir also writes iPhone-size screenshots.
import { webkit, devices } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { fakeEnv, loadCodeGs } from '../sync/apps-script/fake-sheet.mjs';

const url = process.argv[2] ?? 'http://localhost:4173/';
const origin = new URL(url).origin;
const shots = process.env.SHOTS;
// Mocked Apps Script web app: the real Code.gs runs in Node against an in-memory Sheet. Only this URL may leave the app origin.
const SCRIPT = 'https://script.google.com/macros/s/AKfyc-TEST/exec';
if (shots) mkdirSync(shots, { recursive: true });
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) process.exitCode = 1; };
const browser = await webkit.launch();
const ctxOpts = { ...devices['iPhone 13'], acceptDownloads: true, colorScheme: 'light', timezoneId: 'America/New_York' };
const ctx = await browser.newContext(ctxOpts);
const page = await ctx.newPage();
const snap = async (name, sel) => { await page.evaluate((q) => q ? document.querySelector(q).scrollIntoView({ block: 'start' }) : window.scrollTo(0, 0), sel); await page.screenshot({ path: `${shots}/${name}` }); };
const errors = [];
const external = [];
const watch = (p) => {
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('request', (r) => { const u = r.url(); if (!u.startsWith(origin) && !u.startsWith('blob:') && !u.startsWith('data:') && !u.startsWith(SCRIPT)) external.push(u); });
};
watch(page);
// Phone clock: 2026-10-26 09:15 in New York (13:15Z). Date/time must be stamped from this.
await page.clock.setFixedTime(new Date('2026-10-26T13:15:00Z'));

await page.goto(url);
await page.waitForSelector('text=Boreholes (0)');
ok(await page.isVisible('[data-testid=install-tip]'), 'Add to Home Screen tip shows on iPhone Safari (not standalone)');
await page.click('[data-testid=install-tip] button');
ok(!(await page.isVisible('[data-testid=install-tip]')), 'install tip can be dismissed');

async function addBorehole(name, elev, rp) {
  await page.goto(url + '#/');
  await page.click('[data-testid=add-borehole]');
  await page.fill('[data-testid=bh-name]', name);
  if (rp) await page.fill('[data-testid=bh-refpoint]', rp);
  await page.fill('[data-testid=bh-elev]', elev);
  await page.click('[data-testid=bh-save]');
  await page.waitForSelector(`h2:has-text("${name}")`);
}
ok((await page.goto(url + '#/new-borehole'), !(await page.$('[data-testid=bh-id]'))), 'borehole form has no separate ID field (Borehole Name only)');
await addBorehole('MW-1', '1050.5');
await addBorehole('MW-2', '987.25', 'collar');
await page.goto(url + '#/new-borehole');
await page.fill('[data-testid=bh-name]', 'mw-1');
await page.fill('[data-testid=bh-elev]', '1');
await page.click('[data-testid=bh-save]');
ok((await page.textContent('.error')).includes('already exists'), 'duplicate Borehole Name (case-insensitive) is rejected');
await page.goto(url + '#/');
ok((await page.$$('[data-testid=borehole-list] li')).length === 2, 'borehole list shows 2 boreholes');

// Reading form
await page.goto(url + '#/reading/new?bh=MW-1');
ok(await page.getAttribute('[data-testid=rd-depth]', 'inputmode') === 'decimal', 'depth uses the decimal keypad');
ok((await page.$$('input[type=datetime-local], input[type=date], input[type=time]')).length === 0, 'no manual date/time entry on the reading form');
ok((await page.textContent('[data-testid=rd-stamp]')).includes("phone's clock"), 'form says date/time come from the phone clock');
ok(!(await page.$('[data-testid^=rd-status]')) && !(await page.$('text=Reader')), 'no status or reader fields');
await page.click('[data-testid=rd-save]');
ok((await page.textContent('.error')).includes('Enter the depth'), 'depth is required');
await page.fill('[data-testid=rd-depth]', '-1');
await page.click('[data-testid=rd-save]');
ok((await page.textContent('.error')).includes('negative'), 'negative depth is rejected');

async function addReading(bh, depth, notes) {
  await page.goto(url + `#/reading/new?bh=${encodeURIComponent(bh)}`);
  await page.fill('[data-testid=rd-depth]', depth);
  if (notes) await page.fill('[data-testid=rd-notes]', notes);
  await page.click('[data-testid=rd-save]');
  await page.waitForSelector('[data-testid=history]');
}
// First save with no User Code set: the sheet asks for it and the typed reading survives.
await page.goto(url + '#/reading/new?bh=MW-1');
ok((await page.textContent('[data-testid=rd-code]')).includes('not set'), 'form says the User Code is not set yet');
await page.fill('[data-testid=rd-depth]', '22.4');
await page.fill('[data-testid=rd-notes]', '=SUM(A1)');
await page.click('[data-testid=rd-save]');
await page.waitForSelector('[data-testid=uc-sheet]');
ok(true, 'saving without a User Code opens the User Code sheet');
await page.click('[data-testid=uc-prompt-cancel]');
ok(!(await page.isVisible('[data-testid=uc-sheet]')) && await page.inputValue('[data-testid=rd-depth]') === '22.4' && await page.inputValue('[data-testid=rd-notes]') === '=SUM(A1)', 'cancel keeps the entered reading (depth and notes)');
ok(!(await page.isVisible('[data-testid=history]')), 'cancel stays on the form and saves nothing');
await page.click('[data-testid=rd-save]');
await page.fill('[data-testid=uc-prompt-input]', 'a.b');
await page.click('[data-testid=uc-prompt-save]');
ok((await page.textContent('[data-testid=uc-prompt-error]')).includes('letters'), 'invalid User Code is rejected in the sheet');
await page.fill('[data-testid=uc-prompt-input]', ' od-1 ');
if (shots) await page.screenshot({ path: `${shots}/2-user-code-prompt.png` });
await page.click('[data-testid=uc-prompt-save]');
await page.waitForSelector('[data-testid=history]');
ok((await page.textContent('[data-testid=history]')).includes('OD-1'), 'sheet saves the code (trimmed, uppercased) and completes the save with it');
await page.goto(url + '#/readings');
ok((await page.$$('[data-testid=readings-table] tbody tr')).length === 1, 'exactly one reading saved via the sheet');
await page.goto(url + '#/settings');
ok(await page.inputValue('[data-testid=uc-input]') === 'OD-1', 'code from the sheet is stored in Settings');
await page.goto(url + '#/reading/new?bh=MW-1');
ok((await page.textContent('[data-testid=rd-code]')).includes('OD-1'), 'form shows the code that will be stamped');
await page.clock.setFixedTime(new Date('2026-10-26T13:42:00Z'));
await addReading('MW-1', '20.15');
await addReading('MW-2', '5', 'pump, "off"');
await addReading('MW-1', '19.9');
const ids = () => page.$$eval('[data-testid=readings-table] tbody tr', (trs) => trs.map((t) => Number(t.dataset.readingId)).sort((a, b) => a - b));
await page.goto(url + '#/readings');
ok(JSON.stringify(await ids()) === '[1,2,3,4]', 'Reading IDs are sequential 1..4');
// Delete #4, add again -> #5 (never reused)
await page.goto(url + '#/reading/4');
page.once('dialog', (d) => d.accept());
await page.click('text=Delete reading');
await page.waitForSelector('[data-testid=history]');
await page.goto(url + '#/settings');
await page.fill('[data-testid=uc-input]', 'x'.repeat(21));
await page.click('[data-testid=uc-save]');
ok((await page.textContent('[data-testid=uc-msg]')).includes('20'), 'User Code longer than 20 characters is rejected');
await page.fill('[data-testid=uc-input]', 'jd_2');
await page.click('[data-testid=uc-save]');
ok((await page.textContent('[data-testid=uc-msg]')).includes('JD_2'), 'User Code can be changed in Settings (uppercased)');
await page.reload();
ok(await page.inputValue('[data-testid=uc-input]') === 'JD_2', 'User Code persists across reload');
if (shots) await snap('3-settings-user-code.png');
await addReading('MW-1', '19.75');
await page.goto(url + '#/readings');
ok(JSON.stringify(await ids()) === '[1,2,3,5]', 'deleted Reading ID 4 is not reused (new reading is #5)');

await page.goto(url + '#/borehole/MW-1');
const headers = await page.$$eval('[data-testid=history] th', (t) => t.map((x) => x.textContent));
ok(headers.join('|') === 'Reading ID|Borehole Name|Date|Time|User Code|Reference Point|Reference Elevation (ft)|Depth to Top of Water (ft)|Water Elevation (ft)|Notes', `history columns in order (${headers.join('|')})`);
const hist = await page.textContent('[data-testid=history]');
ok(hist.includes('2026-10-26') && hist.includes('09:15') && hist.includes('09:42'), 'date and time stamped from the phone clock (09:15, 09:42 local)');
ok(hist.includes('OD-1') && hist.includes('JD_2'), 'history shows each reading\'s User Code');
ok(hist.includes('1028.10') && hist.includes('1030.35') && hist.includes('1030.75'), 'water elevation = reference elevation − depth');
ok(!/change|dry|reader/i.test(hist), 'no change/status/reader in history');
ok(await page.isVisible('[data-testid=trend-chart] svg'), 'trend chart renders');
await page.goto(url + '#/reading/1');
ok((await page.textContent('[data-testid=rd-stamp]')).includes("can't be edited") && (await page.$$('input[type=datetime-local]')).length === 0, 'editing shows the recorded stamp read-only');
await page.fill('[data-testid=rd-depth]', '22.5');
await page.click('[data-testid=rd-save]');
await page.waitForSelector('[data-testid=history]');
ok((await page.textContent('[data-testid=history]')).includes('1028.00') && (await page.textContent('[data-testid=history]')).includes('09:15'), 'edit keeps Reading ID and original date/time');

// Reference snapshot + rename carries into readings
await page.goto(url + '#/borehole/MW-1/edit');
await page.fill('[data-testid=bh-name]', 'North Pad 1');
await page.fill('[data-testid=bh-elev]', '1051');
ok(await page.isVisible('[data-testid=bh-rename-note]'), 'rename warns it updates readings');
await page.click('[data-testid=bh-save]');
await page.waitForSelector('h2:has-text("North Pad 1")');
const hist2 = await page.textContent('[data-testid=history]');
ok((hist2.match(/North Pad 1/g) ?? []).length === 3 && !hist2.includes('MW-1'), `rename carries into all 3 of its readings`);
ok(hist2.includes('1050.50') && !hist2.includes('1051.00'), 'past readings keep their reference elevation snapshot');
await page.goto(url + '#/');
if (shots) await snap('1-borehole-list.png');
await page.goto(url + '#/reading/new?bh=North%20Pad%201');
await page.fill('[data-testid=rd-depth]', '19.60');
await page.fill('[data-testid=rd-notes]', 'after rain');
await page.waitForSelector('[data-testid=rd-calc]');
ok((await page.textContent('[data-testid=rd-calc]')).includes('1031.40'), 'live water elevation uses the current reference elevation');
await page.click('[data-testid=rd-save]');
await page.waitForSelector('[data-testid=history]');

// CSV with all columns
await page.goto(url + '#/readings');
await page.selectOption('[data-testid=flt-bh]', 'North Pad 1');
let [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid=export-csv]')]);
const name = dl.suggestedFilename();
ok(/^waterlevels_North-Pad-1_2026-10-26\.csv$/.test(name), `CSV filename ${name}`);
let csv = readFileSync(await dl.path(), 'utf8');
let lines = csv.replace(/^\uFEFF/, '').trim().split('\r\n');
ok(csv.startsWith('\uFEFF'), 'CSV has a UTF-8 BOM');
ok(lines[0] === 'Reading ID,Borehole Name,Date,Time,User Code,Reference Point,Reference Elevation (ft),Depth to Top of Water (ft),Water Elevation (ft),Notes', 'CSV header: 10 readable columns in order');
ok(lines.length === 5, `filtered CSV has 4 readings (${lines.length - 1})`);
ok(lines[1] === "OD-1-0001,North Pad 1,2026-10-26,09:15,OD-1,top of casing,1050.50,22.50,1028.00,'=SUM(A1)", `CSV row keeps its original User Code after edit + formula guard (${lines[1]})`);
ok(lines[4].startsWith('JD_2-0006,North Pad 1,2026-10-26,09:42,JD_2,top of casing,1051.00,19.60,1031.40,after rain'), 'new reading snapshots the new reference elevation');

// Settings: column toggles
await page.goto(url + '#/settings');
await page.click('[data-testid=col-time]');
await page.click('[data-testid=col-notes]');
await page.click('[data-testid=col-referencePoint]');
if (shots) await snap('5-report-columns.png', '[data-testid=columns]');
await page.reload();
ok(!(await page.isChecked('[data-testid=col-time]')) && await page.isChecked('[data-testid=col-date]'), 'column toggles persist across reload');
await page.goto(url + '#/readings');
[dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid=export-csv]')]);
lines = readFileSync(await dl.path(), 'utf8').replace(/^\uFEFF/, '').trim().split('\r\n');
ok(lines[0] === 'Reading ID,Borehole Name,Date,User Code,Reference Elevation (ft),Depth to Top of Water (ft),Water Elevation (ft)', `CSV only has columns switched on (${lines[0]})`);
ok(lines.some((l) => l === 'OD-1-0003,MW-2,2026-10-26,OD-1,987.25,5.00,982.25'), 'row values follow the toggled columns');
const tableHeads = await page.$$eval('[data-testid=readings-table] th', (t) => t.length);
ok(tableHeads === 7, `readings table shows the same 7 columns (${tableHeads})`);
await page.goto(url + '#/borehole/North%20Pad%201');
ok((await page.$$('[data-testid=history] th')).length === 7, 'history table follows the toggles');

// At least one column must stay on
await page.goto(url + '#/settings');
for (const c of ['readingId', 'boreholeName', 'date', 'userCode', 'refElevation', 'depth']) await page.click(`[data-testid=col-${c}]`);
ok(await page.isDisabled('[data-testid=col-waterElevation]'), 'last column on cannot be switched off');
await page.click('[data-testid=col-all]');
await page.click('[data-testid=col-userCode]');
await page.goto(url + '#/readings');
[dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid=export-csv]')]);
ok(!readFileSync(await dl.path(), 'utf8').includes('User Code'), 'User Code column has its own switch (off → not exported)');
await page.goto(url + '#/settings');
await page.click('[data-testid=col-userCode]');
ok((await page.$$('[data-testid=columns] input:checked')).length === 10, '"Turn all on" restores all 10 columns');

// Share path: stub navigator.share to confirm a File is passed when canShare allows it
await page.goto(url + '#/readings');
await page.evaluate(() => { window.__shared = null; navigator.canShare = (d) => !!d.files; navigator.share = async (d) => { window.__shared = d.files.map((f) => [f.name, f.type, f.size]); }; });
await page.click('[data-testid=export-csv]');
await page.waitForFunction(() => window.__shared);
const shared = await page.evaluate(() => window.__shared);
ok(shared[0][0] === 'waterlevels_all_2026-10-26.csv' && shared[0][1] === 'text/csv', `iOS share sheet path receives the CSV File (${shared[0][0]})`);

// Units: meters (reload drops the share stub)
await page.goto(url + '#/settings');
await page.reload();
await page.click('[data-testid=unit-m]');
ok((await page.textContent('[data-testid=columns]')).includes('Water Elevation (m)'), 'settings column labels switch to (m)');
await page.goto(url + '#/readings');
[dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid=export-csv]')]);
lines = readFileSync(await dl.path(), 'utf8').replace(/^\uFEFF/, '').trim().split('\r\n');
ok(lines[0].includes('Reference Elevation (m),Depth to Top of Water (m),Water Elevation (m)') && lines.some((l) => l.includes(',300.91,1.52,299.39,')), 'meters: (m) headers and converted values');
await page.goto(url + '#/settings');
await page.click('[data-testid=unit-ft]');

// Offline reload
await page.goto(url + '#/');
await page.evaluate(async () => { await navigator.serviceWorker.ready; });
await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 }).catch(() => {});
if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) await page.reload();
ok(await page.evaluate(() => !!navigator.serviceWorker.controller), 'service worker controls the page');
await ctx.setOffline(true);
await page.reload();
await page.waitForSelector('[data-testid=borehole-list] li');
ok((await page.textContent('[data-testid=borehole-list]')).includes('1031.40'), 'offline reload shows stored data');
await addReading('MW-2', '4.5');
ok((await page.textContent('[data-testid=history]')).includes('JD_2-0007'), 'can add a reading while offline (JD_2-0007)');
await ctx.setOffline(false);
if (shots) {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(url + '#/borehole/North%20Pad%201');
  await page.waitForSelector('[data-testid=trend-chart]');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.$eval('table', (t) => { let e = t.parentElement; while (e && e.scrollWidth <= e.clientWidth) e = e.parentElement; if (e) e.scrollLeft = 260; });
  await snap('4-history-user-code.png', '[data-testid=history]');
  await page.emulateMedia({ colorScheme: 'dark' });
  await snap('6-dark-mode-history.png');
}

// Migration: a device with v0.1.0 data (IndexedDB v1) upgrades in place
const ctx2 = await browser.newContext(ctxOpts);
const p2 = await ctx2.newPage();
watch(p2);
await p2.goto(url + 'manifest.webmanifest');
await p2.evaluate(() => new Promise((res, rej) => {
  const rq = indexedDB.open('water-level-log', 1);
  rq.onupgradeneeded = () => {
    const d = rq.result;
    d.createObjectStore('boreholes', { keyPath: 'id' });
    d.createObjectStore('readings', { keyPath: 'uid' }).createIndex('byBorehole', 'boreholeId');
  };
  rq.onsuccess = () => {
    const d = rq.result, tx = d.transaction(['boreholes', 'readings'], 'readwrite');
    tx.objectStore('boreholes').put({ id: 'MW-1', name: 'North pad', referencePoint: 'top of casing', refElevationFt: 1050.5, totalDepthFt: 80, lat: 1, lon: 2 });
    tx.objectStore('boreholes').put({ id: 'MW-2', name: 'MW-2', referencePoint: 'collar', refElevationFt: 987.25 });
    const r = tx.objectStore('readings');
    r.put({ uid: 'x1', boreholeId: 'MW-1', datetime: '2026-10-15T08:30', status: 'ok', depthFt: 20.15, refElevationFt: 1050.5, referencePoint: 'top of casing', reader: 'Odin', createdAt: 'b' });
    r.put({ uid: 'x2', boreholeId: 'MW-1', datetime: '2026-09-20T07:45', status: 'ok', depthFt: 25, refElevationFt: 1050.5, referencePoint: 'top of casing', notes: 'first', createdAt: 'c' });
    r.put({ uid: 'x3', boreholeId: 'MW-1', datetime: '2026-10-20T09:00', status: 'dry', refElevationFt: 1050.5, referencePoint: 'top of casing', createdAt: 'd' });
    r.put({ uid: 'x4', boreholeId: 'MW-2', datetime: '2026-10-01T08:00', status: 'ok', depthFt: 5, refElevationFt: 987.25, referencePoint: 'collar', createdAt: 'a' });
    tx.oncomplete = () => { d.close(); res(); };
    tx.onerror = () => rej(tx.error);
  };
  rq.onerror = () => rej(rq.error);
}));
await p2.goto(url);
await p2.waitForSelector('[data-testid=borehole-list] li');
const l2 = await p2.textContent('[data-testid=borehole-list]');
ok(l2.includes('North pad') && l2.includes('MW-2') && l2.includes('1030.35'), 'v1 IndexedDB data migrates on upgrade (names, latest level)');
await p2.goto(url + '#/readings');
const migCodes = await p2.$$eval('[data-testid=readings-table] tbody tr', (trs) => trs.map((t) => t.querySelectorAll('td')[4].textContent));
ok(migCodes.length === 3 && migCodes.every((c) => c === ''), 'migrated readings have a blank User Code');
const mig = await p2.$$eval('[data-testid=readings-table] tbody tr', (trs) => trs.map((t) => [...t.querySelectorAll('td')].slice(0, 3).map((c) => c.textContent).join(' ')));
ok(JSON.stringify(mig.reverse()) === JSON.stringify(['LEGACY-0001 North pad 2026-09-20', 'LEGACY-0002 MW-2 2026-10-01', 'LEGACY-0003 North pad 2026-10-15']), `migrated Reading IDs assigned by date/time, LEGACY- prefix (no User Code) (${mig.join(', ')})`);
await p2.goto(url + '#/reading/new?bh=MW-2');
await p2.fill('[data-testid=rd-depth]', '6');
await p2.click('[data-testid=rd-save]');
await p2.fill('[data-testid=uc-prompt-input]', 'NEW');
await p2.click('[data-testid=uc-prompt-save]');
await p2.waitForSelector('[data-testid=history]');
ok((await p2.textContent('[data-testid=history]')).includes('NEW-0004'), 'next reading after migration gets NEW-0004');
const arch = await p2.evaluate(() => new Promise((res) => { const rq = indexedDB.open('water-level-log'); rq.onsuccess = () => { const g = rq.result.transaction('meta').objectStore('meta').get('v1Archive'); g.onsuccess = () => { res(g.result?.value?.readings?.length); rq.result.close(); }; }; }));
ok(arch === 4, 'original v1 data (incl. the Dry entry) is kept in an archive record');
await ctx2.close();

// ---------- Sync through a (mocked) Google Sheet ----------
const gs = loadCodeGs();
const server = fakeEnv({ team: 'river-team-7' });
let serverDown = false;
let mangle = null; // test hook: corrupt a request body before the "sheet" sees it
const serve = async (route) => {
  const req = route.request();
  if (serverDown) return route.abort('internetdisconnected');
  if (req.method() !== 'POST') return route.fulfill({ status: 405, body: '' });
  const ct = req.headers()['content-type'] ?? '';
  const out = ct.startsWith('text/plain') ? gs.handleRequest_(mangle ? mangle(req.postData() ?? '') : (req.postData() ?? ''), server) : { ok: false, error: 'expected text/plain' };
  await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(out) });
};
const sheetRows = (n) => server.ss.getSheetByName(n)?.objects() ?? [];
const badge = (p) => p.getAttribute('[data-testid=sync-badge]', 'data-state').catch(() => null);
const waitBadge = (p, st) => p.waitForSelector(`[data-testid=sync-badge][data-state=${st}]`, { timeout: 15000 });
const rowIds = (p) => p.$$eval('[data-testid=readings-table] tbody tr', (trs) => trs.map((t) => t.querySelector('td').textContent).sort());
async function join(p, team) {
  await p.goto(url + '#/settings');
  await p.fill('[data-testid=sync-url]', SCRIPT);
  await p.fill('[data-testid=sync-team]', team);
  await p.click('[data-testid=sync-enable]');
  await p.waitForSelector('[data-testid=sync-msg]');
  return p.textContent('[data-testid=sync-msg]');
}
// Playwright cannot intercept fetches that pass through a service worker in WebKit, so the sync part runs
// without one (the offline/service-worker behaviour is checked above). Phone B blocks it from the start.
// Playwright cannot intercept fetches in a context that has had a service worker in WebKit, so phone A's
// data moves (via its own full backup) into a fresh context with service workers blocked.
await page.goto(url + '#/settings');
const [bk] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid=backup]')]);
const bkPath = await bk.path();
const lsA = await page.evaluate(() => JSON.stringify(localStorage));
const ctxA = await browser.newContext({ ...ctxOpts, serviceWorkers: 'block' });
await ctxA.addInitScript((s) => { if (!sessionStorage.getItem('wll-seeded')) { sessionStorage.setItem('wll-seeded', '1'); for (const [k, v] of Object.entries(JSON.parse(s))) localStorage.setItem(k, v); } }, lsA);
await ctxA.route((u) => u.href.startsWith(SCRIPT), serve);
const pa = await ctxA.newPage();
watch(pa);
await pa.goto(url + '#/settings');
pa.once('dialog', (d) => d.accept());
await pa.setInputFiles('[data-testid=restore]', bkPath);
await pa.waitForTimeout(1500);
ok(await pa.evaluate(() => !navigator.serviceWorker?.controller), 'sync tests: phone A data moved to a context without a service worker');
await pa.goto(url + '#/');
ok(await badge(pa) === null, 'no sync badge while sync is off');
await pa.goto(url + '#/settings');
if (shots) { await pa.evaluate(() => document.querySelector('[data-testid=sync-section]').scrollIntoView({ block: 'start' })); await pa.screenshot({ path: `${shots}/7-sync-settings-off.png` }); }
const wrongMsg = await join(pa, 'wrong');
ok(wrongMsg.includes('Wrong team code'), `wrong team code is refused and sync stays off (${wrongMsg})`);
ok(await pa.isVisible('[data-testid=sync-enable]'), 'sync still off after the refused code');
ok((await join(pa, 'river-team-7')).includes('Sync is on'), 'phone A joins with the team code');
await waitBadge(pa, 'synced');
ok((await pa.textContent('[data-testid=sync-badge]')) === 'All synced', 'badge: All synced');
const aCount = (await pa.evaluate(() => new Promise((res) => { const rq = indexedDB.open('water-level-log'); rq.onsuccess = () => { const g = rq.result.transaction('readings').objectStore('readings').count(); g.onsuccess = () => { res(g.result); rq.result.close(); }; }; })));
ok(sheetRows('Readings').length === aCount && sheetRows('Boreholes').length === 2, `existing data uploaded to the Sheet (${sheetRows('Readings').length} readings, ${sheetRows('Boreholes').length} boreholes)`);
ok(sheetRows('Readings').some((r) => r['Reading ID'] === 'OD-1-0001' && r['Borehole Name'] === 'North Pad 1' && r.Notes === '=SUM(A1)' && server.ss.getSheetByName('Readings').quoted.has('=SUM(A1)')), 'Sheet rows are readable (Reading ID, Borehole Name) and formula-guarded');
ok((await pa.textContent('[data-testid=sync-last]')) !== 'Never', `last synced time shown (${await pa.textContent('[data-testid=sync-last]')})`);
if (shots) { await pa.evaluate(() => document.querySelector('[data-testid=sync-section]').scrollIntoView({ block: 'start' })); await pa.screenshot({ path: `${shots}/8-sync-settings-on.png` }); }

// Phone B: a fresh phone joins and receives everything.
const ctx3 = await browser.newContext({ ...ctxOpts, serviceWorkers: 'block' });
const pb = await ctx3.newPage();
watch(pb);
await ctx3.route((u) => u.href.startsWith(SCRIPT), serve);
await pb.goto(url);
await pb.waitForSelector('text=Boreholes (0)');
ok((await join(pb, 'river-team-7')).includes('Sync is on'), 'phone B joins');
await waitBadge(pb, 'synced');
await pb.goto(url + '#/');
await pb.waitForSelector('[data-testid=borehole-list] li');
ok((await pb.textContent('[data-testid=borehole-list]')).includes('North Pad 1'), 'phone B received the boreholes');
await pa.goto(url + '#/readings'); await pb.goto(url + '#/readings');
ok(JSON.stringify(await rowIds(pa)) === JSON.stringify(await rowIds(pb)), `phone B received the same readings (${(await rowIds(pb)).length})`);

// Offline on phone B: the reading is queued, badge shows waiting, then syncs when back online.
await ctx3.setOffline(true);
serverDown = true;
await pb.goto(url + '#/reading/new?bh=MW-2');
await pb.fill('[data-testid=rd-depth]', '3.25');
await pb.click('[data-testid=rd-save]');
await pb.fill('[data-testid=uc-prompt-input]', 'BK');
await pb.click('[data-testid=uc-prompt-save]');
await pb.waitForSelector('[data-testid=history]');
await pb.waitForSelector('[data-testid=sync-badge]:has-text("1 waiting")', { timeout: 10000 });
ok(['offline', 'waiting', 'error'].includes(await badge(pb)), `offline save is queued: badge "${await pb.textContent('[data-testid=sync-badge]')}"`);
ok(!sheetRows('Readings').some((r) => r['Reading ID'] === 'BK-0001'), 'queued reading not on the Sheet yet');
if (shots) { await pb.evaluate(() => window.scrollTo(0, 0)); await pb.screenshot({ path: `${shots}/9-badge-waiting-offline.png` }); }
serverDown = false;
await ctx3.setOffline(false);
await pb.evaluate(() => window.dispatchEvent(new Event('online')));
await waitBadge(pb, 'synced');
ok(sheetRows('Readings').some((r) => r['Reading ID'] === 'BK-0001' && r['Borehole Name'] === 'MW-2' && r['User Code'] === 'BK'), 'back online: queued reading reaches the Sheet');
if (shots) { await pb.evaluate(() => window.scrollTo(0, 0)); await pb.screenshot({ path: `${shots}/10-badge-all-synced.png` }); }

// Phone A pulls it: both phones converge.
await pa.goto(url + '#/settings');
await pa.click('[data-testid=sync-now]');
await waitBadge(pa, 'synced');
await pa.goto(url + '#/readings'); await pb.goto(url + '#/readings');
const ra = await rowIds(pa), rb = await rowIds(pb);
ok(ra.includes('BK-0001') && JSON.stringify(ra) === JSON.stringify(rb), `two phones converge (${ra.length} readings each)`);

// Edit on A is visible on B (newest edit wins).
const bkLocal = await pa.$$eval('[data-testid=readings-table] tbody tr', (trs) => trs.find((t) => t.querySelector('td')?.textContent.trim() === 'BK-0001')?.dataset.readingId);
ok(!!bkLocal, `BK-0001 row found on phone A (${bkLocal})`);
await pa.goto(url + `#/reading/${bkLocal}`);
await pa.fill('[data-testid=rd-depth]', '3.5');
await pa.click('[data-testid=rd-save]');
await pa.waitForSelector('[data-testid=history]');
await pa.waitForSelector('[data-testid=sync-badge][data-state=synced]', { timeout: 15000 });
ok(sheetRows('Readings').find((r) => r['Reading ID'] === 'BK-0001')['Depth to Top of Water (ft)'] === 3.5, 'edit on phone A is pushed after the save (debounced)');

// Tombstone delete: A deletes BK-0001; B removes it on its next sync and it never comes back.
await pa.goto(url + `#/reading/${bkLocal}`);
pa.once('dialog', (d) => d.accept());
await pa.click('text=Delete reading');
await pa.waitForSelector('[data-testid=history]');
await waitBadge(pa, 'synced');
for (let i = 0; i < 30 && !sheetRows('Tombstones').length; i++) await pa.waitForTimeout(250);
ok(sheetRows('Tombstones').some((t) => t.Kind === 'reading') && !sheetRows('Readings').some((r) => r['Reading ID'] === 'BK-0001'), 'delete goes to the Sheet as a tombstone and the row is removed');
await pb.goto(url + '#/settings');
await pb.click('[data-testid=sync-now]');
await waitBadge(pb, 'synced');
await pb.goto(url + '#/readings');
ok(!(await rowIds(pb)).includes('BK-0001'), 'phone B: the deleted reading disappears');
await pb.goto(url + '#/settings'); await pb.click('[data-testid=sync-now]'); await waitBadge(pb, 'synced');
await pb.goto(url + '#/readings'); await pa.goto(url + '#/readings');
ok(!(await rowIds(pb)).includes('BK-0001') && JSON.stringify(await rowIds(pa)) === JSON.stringify(await rowIds(pb)), 'deleted reading does not come back; phones still match');

// Same borehole name created on both phones -> one borehole, flagged for checking.
await pa.goto(url + '#/new-borehole');
await pa.fill('[data-testid=bh-name]', 'MW-9'); await pa.fill('[data-testid=bh-elev]', '900'); await pa.click('[data-testid=bh-save]');
await pb.goto(url + '#/new-borehole');
await pb.fill('[data-testid=bh-name]', 'mw-9'); await pb.fill('[data-testid=bh-elev]', '901'); await pb.click('[data-testid=bh-save]');
for (const p of [pa, pb, pa, pb]) { await p.goto(url + '#/settings'); await p.click('[data-testid=sync-now]'); await waitBadge(p, 'synced'); }
await pb.goto(url + '#/');
await pb.waitForSelector('[data-testid=bh-flag-dot]');
ok((await pb.$$eval('[data-testid=borehole-list] strong', (s) => s.map((x) => x.textContent).filter((t) => /mw-9/i.test(t)))).length === 1, 'same-name boreholes merged into one');
await pb.click('[data-testid=borehole-list] a.card:has([data-testid=bh-flag-dot])');
await pb.waitForSelector('[data-testid=bh-flag]');
ok((await pb.textContent('[data-testid=bh-flag]')).includes('two phones'), 'merged borehole is flagged for checking');
if (shots) { await pb.evaluate(() => window.scrollTo(0, 0)); await pb.screenshot({ path: `${shots}/11-merged-borehole-flag.png` }); }
await pb.click('[data-testid=bh-flag-clear]');
await pb.waitForSelector('[data-testid=bh-flag]', { state: 'detached' });
await waitBadge(pb, 'synced').catch(() => {});
for (let i = 0; i < 40 && sheetRows('Boreholes').find((b) => /mw-9/i.test(b['Borehole Name']))['Check Flag']; i++) await pb.waitForTimeout(250);
ok(!sheetRows('Boreholes').find((b) => /mw-9/i.test(b['Borehole Name']))['Check Flag'], '"Mark checked" clears the flag on the Sheet');

// ---------- 0.4.1 hardening ----------
const snapP = async (p, name, sel) => { await p.evaluate((q) => document.querySelector(q)?.scrollIntoView({ block: 'start' }), sel); await p.screenshot({ path: `${shots}/${name}` }); };
const localId = async (p, disp) => { await p.goto(url + '#/readings'); return p.$$eval('[data-testid=readings-table] tbody tr', (trs, d) => trs.find((t) => t.querySelector('td')?.textContent.trim() === d)?.dataset.readingId, disp); };
const syncNow = async (p) => { await p.goto(url + '#/settings'); await p.click('[data-testid=sync-now]'); await waitBadge(p, 'synced'); };
// #3 A hand edit on the Sheet to another row survives the app's next sync (row upserts, not a full rewrite).
{
  const sh = server.ss.getSheetByName('Readings');
  const hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, hdr.length).getValues();
  const idCol = hdr.indexOf('Reading ID'), notesCol = hdr.indexOf('Notes');
  const ri = rows.findIndex((r) => r[idCol] !== 'OD-1-0001');
  var handId = rows[ri][idCol];
  sh.getRange(ri + 2, notesCol + 1, 1, 1).setValues([['checked by hand']]);
  sh.getRange(ri + 2, hdr.length + 1, 1, 1).setValues([['my own column']]);
}
// #6 Phone A opens OD-1-0001; phone B changes it and syncs; A's save shows the newer values and asks.
const aId = await localId(pa, 'OD-1-0001'), bId = await localId(pb, 'OD-1-0001');
await pa.goto(url + `#/reading/${aId}`);
await pa.waitForSelector('[data-testid=rd-depth]');
await pb.goto(url + `#/reading/${bId}`);
await pb.fill('[data-testid=rd-depth]', '4.25');
await pb.click('[data-testid=rd-save]');
await pb.waitForSelector('[data-testid=history]');
for (let i = 0; i < 40 && sheetRows('Readings').find((r) => r['Reading ID'] === 'OD-1-0001')['Depth to Top of Water (ft)'] !== 4.25; i++) await pb.waitForTimeout(250);
await pa.evaluate(() => window.dispatchEvent(new Event('online'))); // A syncs in the background while its form is open
await pa.waitForTimeout(2500);
await pa.fill('[data-testid=rd-notes]', 'mine');
await pa.click('[data-testid=rd-save]');
await pa.waitForSelector('[data-testid=rd-conflict]');
ok((await pa.textContent('[data-testid=rd-conflict-newer]')).includes('4.25'), '#6 stale edit form: save shows the newer values and asks');
if (shots) await snapP(pa, '13-edit-conflict.png', '[data-testid=rd-conflict]');
await pa.click('[data-testid=rd-conflict-mine]');
await pa.waitForSelector('[data-testid=history]');
for (let i = 0; i < 40 && sheetRows('Readings').find((r) => r['Reading ID'] === 'OD-1-0001').Notes !== 'mine'; i++) await pa.waitForTimeout(250);
ok(sheetRows('Readings').find((r) => r['Reading ID'] === 'OD-1-0001').Notes === 'mine', '#6 "Save mine anyway" overwrites after confirmation');
ok(sheetRows('Readings').find((r) => r['Reading ID'] === handId).Notes === 'checked by hand' && server.ss.getSheetByName('Readings').getRange(2, 1, server.ss.getSheetByName('Readings').getLastRow() - 1, server.ss.getSheetByName('Readings').getLastColumn()).getValues().some((r) => r.includes('my own column')), '#3 hand edits to other rows and extra columns survive a sync');
// #5 A change the Sheet rejects shows as "1 failed" with the reason; Retry and Discard work.
mangle = (b) => { const j = JSON.parse(b); for (const r of j.readings ?? []) if (r.depthFt === 7.77) r.datetime = 'not a date'; return JSON.stringify(j); };
const addOn = async (p, depth) => { await p.goto(url + '#/reading/new?bh=MW-2'); await p.fill('[data-testid=rd-depth]', depth); await p.click('[data-testid=rd-save]'); await p.waitForSelector('[data-testid=history]'); };
await addOn(pa, '7.77');
await pa.goto(url + '#/settings'); await pa.click('[data-testid=sync-now]');
await waitBadge(pa, 'failed');
ok((await pa.textContent('[data-testid=sync-badge]')).includes('1 failed') && (await pa.textContent('[data-testid=failed-reason]')).includes('date/time is not valid'), '#5 rejected change shows "1 failed" with the reason');
if (shots) await snapP(pa, '14-sync-failed.png', '[data-testid=sync-failed]');
mangle = null;
await pa.click('[data-testid=failed-retry]');
await waitBadge(pa, 'synced');
ok(sheetRows('Readings').some((r) => r['Depth to Top of Water (ft)'] === 7.77), '#5 Retry sends it again once fixed');
mangle = (b) => { const j = JSON.parse(b); for (const r of j.readings ?? []) if (r.depthFt === 8.88) r.datetime = 'not a date'; return JSON.stringify(j); };
await addOn(pa, '8.88');
await pa.goto(url + '#/settings'); await pa.click('[data-testid=sync-now]');
await waitBadge(pa, 'failed');
let asked = '';
pa.once('dialog', (d) => { asked = d.message(); d.dismiss(); });
await pa.click('[data-testid=failed-discard]');
await pa.waitForTimeout(300);
ok(asked.length > 0 && await badge(pa) === 'failed', '#5 Discard asks first; cancelling keeps it');
pa.once('dialog', (d) => d.accept());
await pa.click('[data-testid=failed-discard]');
await waitBadge(pa, 'synced');
const kept = await pa.evaluate(() => new Promise((res) => { const q = indexedDB.open('water-level-log'); setTimeout(() => res(-3), 3000); q.onsuccess = () => { try { const t = q.result.transaction('meta').objectStore('meta').get('discardedChanges'); t.onsuccess = () => res(t.result?.value?.length ?? 0); t.onerror = () => res(-1); } catch (e) { res(String(e)); } }; q.onerror = () => res(-1); }));
ok(kept === 1, `#5 discarded change is kept locally for the backup (${kept})`);
mangle = null;
await syncNow(pb);

// Error state: the team code is changed on the Sheet; this phone shows an error and keeps its changes.
server._store.set('TEAM_CODE', 'new-code-2027');
await pa.goto(url + '#/settings');
await pa.click('[data-testid=sync-now]');
await waitBadge(pa, 'error');
ok((await pa.textContent('[data-testid=sync-error]')).includes('Wrong team code'), 'error state shows the reason');
if (shots) await pa.screenshot({ path: `${shots}/12-badge-sync-error.png` });
pa.once('dialog', (d) => d.accept());
await pa.click('[data-testid=sync-off]');
await pa.waitForSelector('[data-testid=sync-enable]');
ok(await badge(pa) === null, 'turning sync off hides the badge');
ok((await join(pa, 'new-code-2027')).includes('Sync is on'), 're-join with the new team code');
await waitBadge(pa, 'synced');
await ctx3.close();

ok(external.length === 0, `no requests leave the app origin (${external.length})`);
ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
await browser.close();
