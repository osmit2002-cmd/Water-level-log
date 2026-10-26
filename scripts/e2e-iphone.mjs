// End-to-end check in Playwright WebKit with iPhone emulation.
// Usage: npm run build && (npx vite preview --port 4173 &) && node scripts/e2e-iphone.mjs [url]
// SHOTS=dir also writes iPhone-size screenshots.
import { webkit, devices } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:4173/';
const shots = process.env.SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
const snap = async (name) => { await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: `${shots}/${name}` }); };
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) process.exitCode = 1; };
const browser = await webkit.launch();
const ctx = await browser.newContext({ ...devices['iPhone 13'], acceptDownloads: true, colorScheme: 'light' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const external = [];
page.on('request', (r) => { if (!r.url().startsWith(new URL(url).origin) && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) external.push(r.url()); });

await page.goto(url);
await page.waitForSelector('text=Boreholes (0)');
ok(await page.isVisible('[data-testid=install-tip]'), 'Add to Home Screen tip shows on iPhone Safari (not standalone)');
await page.click('[data-testid=install-tip] button');
ok(!(await page.isVisible('[data-testid=install-tip]')), 'install tip can be dismissed');

// Add borehole
async function addBorehole(id, name, elev, td) {
  await page.goto(url + '#/');
  await page.click('[data-testid=add-borehole]');
  await page.fill('[data-testid=bh-id]', id);
  await page.fill('[data-testid=bh-name]', name);
  await page.fill('[data-testid=bh-elev]', elev);
  if (td) await page.fill('[data-testid=bh-td]', td);
  await page.click('[data-testid=bh-save]');
  await page.waitForSelector(`h2:has-text("${id}")`);
}
await addBorehole('MW-1', 'North pad', '1050.5', '80');
await addBorehole('MW-2', 'Refuse area', '987.25', '');
await page.goto(url + '#/');
ok((await page.$$('[data-testid=borehole-list] li')).length === 2, 'borehole list shows 2 boreholes');

// Add readings (one out of order, one dry, one >10 ft warning)
async function addReading(bh, depth, dt, status = 'ok', expectWarn = false) {
  await page.goto(url + `#/reading/new?bh=${bh}`);
  await page.waitForSelector('[data-testid=rd-save]');
  if (status !== 'ok') await page.click(`[data-testid=rd-status-${status}]`);
  if (status === 'ok') await page.fill('[data-testid=rd-depth]', depth);
  await page.fill('[data-testid=rd-dt]', dt);
  await page.click('[data-testid=rd-save]');
  if (expectWarn) {
    await page.waitForSelector('.warn[role=alert]');
    ok((await page.textContent('[data-testid=rd-save]')).includes('Save anyway'), `>10 ft change warns before saving (${depth})`);
    await page.click('[data-testid=rd-save]');
  }
  await page.waitForSelector('[data-testid=history]');
}
ok((await page.goto(url + '#/reading/new?bh=MW-1'), await page.getAttribute('[data-testid=rd-depth]', 'inputmode')) === 'decimal', 'depth uses the decimal keypad');
await page.fill('[data-testid=rd-depth]', '-1');
await page.click('[data-testid=rd-save]');
ok((await page.textContent('.error')).includes('negative'), 'negative depth is rejected');
await addReading('MW-1', '22.4', '2026-10-01T08:00');
await addReading('MW-1', '20.15', '2026-10-15T08:30');
await addReading('MW-1', '25', '2026-09-20T07:45'); // out of order
await addReading('MW-1', '', '2026-10-20T09:00', 'dry');
await addReading('MW-1', '19.9', '2026-10-25T10:00');
await addReading('MW-2', '5', '2026-10-01T08:00');
await addReading('MW-2', '17.5', '2026-10-20T08:00', 'ok', true);
await page.goto(url + '#/borehole/MW-1');
const hist = await page.textContent('[data-testid=history]');
ok(hist.includes('1030.60') && hist.includes('+0.25'), 'latest MW-1 change compares against previous valid reading, skipping the dry one (+0.25)');
ok(hist.includes('Dry'), 'dry reading listed without depth');
ok(hist.includes('+2.60'), 'out-of-order insert recomputes the change (+2.60 on 10-01)');
ok(await page.isVisible('[data-testid=trend-chart] svg'), 'trend chart renders');
if (shots) await snap("2-borehole-detail-chart.png");
await page.goto(url + '#/');
const list = await page.textContent('[data-testid=borehole-list]');
ok(list.includes('1030.60') && list.includes('969.75') && list.includes('-12.50'), 'list shows latest elevation and change per borehole');
if (shots) await snap("1-borehole-list.png");
await page.goto(url + '#/reading/new?bh=MW-1');
await page.fill('[data-testid=rd-depth]', '19.75');
await page.waitForSelector('[data-testid=rd-calc]');
if (shots) await snap("3-add-reading.png");

// Export CSV (download fallback since Linux WebKit has no file share)
await page.goto(url + '#/readings');
await page.selectOption('[data-testid=flt-bh]', 'MW-1');
await page.fill('[data-testid=flt-from]', '2026-10-01');
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid=export-csv]')]);
const name = dl.suggestedFilename();
ok(/^waterlevels_MW-1_\d{4}-\d{2}-\d{2}\.csv$/.test(name), `CSV filename ${name}`);
const csv = readFileSync(await dl.path(), 'utf8');
const lines = csv.replace(/^\uFEFF/, '').trim().split('\r\n');
ok(csv.startsWith('\uFEFF'), 'CSV has a UTF-8 BOM');
ok(lines[0].startsWith('borehole_id,reference_point,reference_elevation_ft,date,time,depth_to_water_ft'), 'CSV header order');
ok(lines.length === 5, `filtered CSV has 4 readings (${lines.length - 1})`);
ok(lines.some((l) => l.includes('2026-10-20,09:00,,,,80.00,,dry')), 'dry row exported with blank depth/elevation');

// Share path: stub navigator.share to confirm a File is passed when canShare allows it
await page.evaluate(() => { window.__shared = null; navigator.canShare = (d) => !!d.files; navigator.share = async (d) => { window.__shared = d.files.map((f) => [f.name, f.type, f.size]); }; });
await page.click('[data-testid=export-csv]');
await page.waitForFunction(() => window.__shared);
const shared = await page.evaluate(() => window.__shared);
ok(shared[0][0].startsWith('waterlevels_MW-1_') && shared[0][1] === 'text/csv', `iOS share sheet path receives the CSV File (${shared[0][0]})`);

// Units: meters
await page.goto(url + '#/settings');
await page.click('[data-testid=unit-m]');
await page.goto(url + '#/borehole/MW-1');
ok((await page.textContent('.facts')).includes('320.19 m'), 'meters setting converts display');
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
ok((await page.textContent('[data-testid=borehole-list]')).includes('1030.60'), 'offline reload shows stored data');
await page.goto(url + '#/reading/new?bh=MW-2');
await page.fill('[data-testid=rd-depth]', '17.25');
await page.click('[data-testid=rd-save]');
await page.waitForSelector('[data-testid=history]');
ok((await page.textContent('[data-testid=history]')).includes('+0.25'), 'can add a reading while offline');
await ctx.setOffline(false);

// Dark mode screenshot
if (shots) {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(url + '#/borehole/MW-1');
  await page.waitForSelector('[data-testid=trend-chart]');
  await snap("4-dark-mode-detail.png");
  await page.goto(url + '#/settings');
  await snap("5-dark-mode-data.png");
}
ok(external.length === 0, `no requests leave the app origin (${external.length})`);
ok(errors.length === 0, `no page errors ${errors.join(' | ')}`);
await browser.close();
