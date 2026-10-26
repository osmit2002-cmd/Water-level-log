# Water Level Log

Offline borehole water-level log for iPhone (and any modern browser). Install it to the Home Screen from Safari and it works with no signal. Data is saved on the phone first (IndexedDB). With **team sync (0.4.0, optional, off by default)**, it is also shared with a Google Sheet that you own. With sync off, the app makes no network calls with your data.

## Features
- **Boreholes:** Borehole Name, Reference Point (top of casing, collar, …) and Reference Elevation. The name is the borehole's one identifier and must be unique (not case-sensitive). It can be renamed, and the rename carries into all of that borehole's readings. Deleting a borehole removes its readings after a confirm.
- **Readings:** pick the borehole and enter the **depth to top of water** (required, 2 decimals, not negative) and optional notes. The **date and time are taken from the phone's clock when you tap Save**; there is no date/time field. Editing a reading keeps its original date and time.
  - **User Code (0.3.0):** each reading records who took it. Set the code once per phone in Settings → User Code (up to 20 letters, numbers, `-` or `_`; saved in capitals). If none is set, the first Save opens a sheet asking for it; the code is saved to Settings and the reading is then saved, nothing typed is lost (Cancel returns to the form). Editing a reading keeps its original code. Readings from before 0.3.0 (including migrated and restored v1/v2 data) have a blank code. Restoring a backup keeps this phone's code. The CSV gets a `User Code` column after Time, with its own switch in Report columns (on by default).
  - **Reading ID:** a sequential number (1, 2, 3, …) assigned at save. Deleted IDs are never reused.
  - Water Elevation = Reference Elevation − Depth to top of water.
  - Each reading stores the Reference Point and Reference Elevation in use when it was taken, so editing a borehole later never rewrites history.
- **Views:** borehole list (latest water elevation), borehole detail (history table and SVG trend chart), all readings (borehole and date-range filters).
- **Settings → Report columns:** one switch per column. All are on by default and the choice is saved on the device. They control the CSV export and the readings/history tables. At least one column must stay on, and "Turn all on" resets them.
- **Units:** feet (default) or meters. Data is stored in feet and converted for display, entry and export.
- **CSV export:** UTF-8 BOM, RFC 4180 quoting, and a guard against formula injection in text cells. The filename is `waterlevels_<borehole|all>_<YYYY-MM-DD>.csv`. On iPhone it opens the share sheet ("Save to Files"); elsewhere it downloads.
  Columns, in this order (the enabled ones only):
  `Reading ID, Borehole Name, Date, Time, User Code, Reference Point, Reference Elevation (ft), Depth to Top of Water (ft), Water Elevation (ft), Notes`. In meters the headers end in `(m)`.
- **Boreholes CSV export and import** (Settings): `Borehole Name, Reference Point, Reference Elevation (ft)` (or `(m)`). Name and elevation are required. Rows are upserted by name and bad rows are listed with line numbers.
- **JSON backup and restore:** `water-level-log-backup` version 4, validated before use, with a confirm before it replaces all data. Version-2 backups (0.2.0) restore with a blank User Code on every reading. Version-1 backups from 0.1.0 are converted:
  - The Borehole Name is the old name, or the old ID if there was no name.
  - Reading IDs are assigned in date/time order.
  - Change, status, reader, total depth, location, lat/long and borehole notes are dropped. Dry / No-reading entries have no depth, so they are skipped, and the confirm says how many.

  iOS can clear website storage, so save a backup to Files regularly. The app also requests persistent storage.
- **Upgrading from 0.1.0:** data already on the phone is migrated the same way the first time 0.2.0 or later opens. The untouched 0.1.0 records are also kept in an internal archive record.
- **Field-ready:** high-contrast "Sunlight" light theme, dark mode (follows the system or can be set), large touch targets, decimal keypad, safe-area insets, and an Add to Home Screen tip in iOS Safari.

## Team sync (0.4.0)
Several phones share one borehole list and one pool of readings through **a Google Sheet plus a small Apps Script web app** (`sync/apps-script/Code.gs`). To set it up, follow **[SETUP-GOOGLE-SHEET.md](SETUP-GOOGLE-SHEET.md)** (about 10 minutes, no coding). For a possible OneDrive/Excel back end, see [ONEDRIVE-EXCEL-NOTES.md](ONEDRIVE-EXCEL-NOTES.md).

- **Joining:** Settings → Sync → web app URL + team code → *Turn on sync*. Everything already on the phone is uploaded. Settings → Sync also shows the status and last synced time, and has *Sync now* and *Turn off sync*.
- **Offline-first:** every save goes to the phone and into an outbox, which is sent on app open, when signal returns, every 90 s while open, about 2 s after a save, and on *Sync now*. Items leave the outbox only after the Sheet confirms them. Sends are idempotent (keyed by UUID), so a retry after a dropped connection is harmless. The header badge shows **All synced**, **N waiting**, **Offline · N waiting** or **Sync error**; tap it to open Settings.
- **IDs:** every borehole and reading has a random UUID. The **Reading ID** shown and exported is now `USERCODE-0001` (User Code + this phone's running number), which is unique across phones as long as each phone has its own User Code. Readings saved before 0.3.0 have no User Code, so they show as **`LEGACY-0001`** etc. using their old number. Two phones that both had pre-0.3.0 data can therefore both show e.g. `LEGACY-0003`. They are still distinct records (different UUIDs; the Sheet keeps both), but the display IDs repeat.
- **Conflicts:** borehole fields (name, reference point, reference elevation, check flag) and reading fields each carry an *updated at* time. When two phones change the same field, the **later edit wins, field by field**, and different fields edited on two phones both survive. *Caveat:* times come from each phone's clock, so a phone whose clock is wrong can win (or lose) wrongly. Keep phones on automatic date & time.
- **Reference values are snapshots:** a reading keeps the reference point/elevation it was taken with. Editing a borehole never changes existing readings, locally or on the Sheet.
- **Same borehole name on two phones** (not case-sensitive, e.g. `MW-9` and `mw-9` created offline): they merge into one borehole and their readings move to it. The borehole gets a ⚑ flag ("Check the reference values") until someone taps **Mark checked**.
- **Deletes** become tombstones on the Sheet (`Tombstones` tab). A deleted reading or borehole never comes back from another phone, even if that phone edits it later. Deleting a borehole deletes its readings everywhere.
- **Backup/restore with sync on:** a restore replaces this phone's data and re-queues all of it. It is merged into the Sheet by the rules above. **It does not delete anything from the Sheet**, and items deleted elsewhere stay deleted.
- **Security:** anyone with the URL **and** team code can read and write. To revoke access, change the code (see the setup guide). The Sheet is on the owner's Google account.
- **Restoring an old (v1–v3) backup is refused while sync is on**, because those backups have no sync IDs and every record would be added to the sheet a second time. Turn sync off first (and only turn it back on if that phone's data is not already on the sheet).
- **Known limits (0.4.0):** a reading's depth and notes share one edit time (newest reading edit wins as a whole). Renaming a borehole and creating a new borehole with its old name in the same offline session can be treated as a same-name merge (flagged). An edit form left open while a sync changes the same record can overwrite the other phone's change when saved. A reading taken offline in a borehole another phone deleted is deleted with it. Changes the sheet rejects as invalid stay "waiting". Anyone with the URL and code could delete data; the Sheet's *File → Version history* is the way back.
- Backup format is now version 4 (keeps UUIDs and edit times); versions 1–3 still restore.

## Develop
```bash
npm install
npm run dev          # local dev server
npm test             # vitest unit tests (math, CSV, backup, migration, sync merge/queue/IDs, Code.gs on a fake Sheet)
npm run build        # type-check + production build to dist/
npx vite preview --port 4173 &
npx playwright install webkit
node scripts/e2e-iphone.mjs   # WebKit iPhone 13 emulation: boreholes, readings, IDs, rename, columns, CSV, meters, offline, v1 migration,
                              # and two-phone sync against Code.gs running on a fake Sheet (no Google account used)
npm run icons        # regenerate PNG icons
```

## Deploy
`.github/workflows/pages.yml` runs the tests, builds and deploys `dist/` to GitHub Pages on every push to `main`. In the repo settings, set Pages → Source to **GitHub Actions**. The build uses `base: './'` with hash routing, so it works under any sub-path.

## Install on iPhone
Open the Pages URL in **Safari** → Share → **Add to Home Screen**. Open it once while online, and from then on it works offline. When an update is deployed, an "An update is ready" banner appears; tap **Update** to switch to it.
