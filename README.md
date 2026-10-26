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

## Team sync (0.4.0, hardened in 0.4.1)
Several phones share one borehole list and one pool of readings through **a Google Sheet plus a small Apps Script web app** (`sync/apps-script/Code.gs`). To set it up, follow **[SETUP-GOOGLE-SHEET.md](SETUP-GOOGLE-SHEET.md)** (about 10 minutes, no coding). For a possible OneDrive/Excel back end, see [ONEDRIVE-EXCEL-NOTES.md](ONEDRIVE-EXCEL-NOTES.md).

- **Joining:** Settings → Sync → web app URL + team code → *Turn on sync*. Everything already on the phone is uploaded. Settings → Sync also shows the status and last synced time, and has *Sync now* and *Turn off sync*.
- **Offline-first:** every save goes to the phone and into an outbox, which is sent on app open, when signal returns, every 90 s while open, about 2 s after a save, and on *Sync now*. Items leave the outbox only after the Sheet confirms them. Sends are idempotent (keyed by UUID), so a retry after a dropped connection is harmless. The header badge shows **All synced**, **N waiting**, **Offline · N waiting**, **N failed** or **Sync error**; tap it to open Settings.
- **IDs:** every borehole and reading has a random UUID. The **Reading ID** shown and exported is now `USERCODE-0001` (User Code + this phone's running number), which is unique across phones as long as each phone has its own User Code. Readings saved before 0.3.0 have no User Code, so they show as **`LEGACY-0001`** etc. using their old number. Two phones that both had pre-0.3.0 data can therefore both show e.g. `LEGACY-0003`. They are still distinct records (different UUIDs; the Sheet keeps both), but the display IDs repeat.
- **Conflicts:** borehole fields (name, reference point, reference elevation, check flag) and reading fields each carry an *updated at* time. When two phones change the same field, the **later edit wins, field by field**, and different fields edited on two phones both survive. *Caveat:* times come from each phone's clock, so a phone whose clock is wrong can win (or lose) wrongly. Keep phones on automatic date & time.
- **Reference values are snapshots:** a reading keeps the reference point/elevation it was taken with. Editing a borehole never changes existing readings, locally or on the Sheet.
- **Same borehole name on two phones** (not case-sensitive, e.g. `MW-9` and `mw-9` created offline): they merge into one borehole and their readings move to it. The borehole gets a ⚑ flag ("Check the reference values") until someone taps **Mark checked**.
- **Deletes** become tombstones on the Sheet (`Tombstones` tab). A reading is only ever removed by an explicit delete of that reading or of its borehole; no merge or clean-up step deletes readings.
- **Delete vs. edit (0.4.1):** the delete wins, *unless* the record was edited **after** it was deleted (by the phones' clocks). Then the record is **restored and flagged ⚑** for checking, and the tombstone row on the Sheet gets a `Restored At` time. A reading restored this way whose borehole was also deleted brings its borehole back (flagged) too.
- **Readings taken offline in a borehole deleted elsewhere (0.4.1)** are never deleted: the phone brings the borehole back, flagged ⚑ "deleted on another phone, but this phone has readings in it", and uploads both. Until that round trip finishes Settings shows them as *still waiting* with the reason.
- **Rejected changes (0.4.1):** if the Sheet refuses a change as invalid, the badge shows **N failed** and Settings lists each one with the reason, plus **Retry** and **Discard**. Discard asks first, and the discarded change is kept on the phone and included in backups (`unsynced.discarded`), along with any still-failed changes (`unsynced.failed`).
- **Edit form open during a sync (0.4.1):** when you save, the app checks whether the record changed since you opened the form. If it did, it shows the newer values and asks: **Save mine (replace newer)** or **Keep the newer values**. Borehole forms only apply the fields you actually changed.
- **Hand edits on the Sheet (0.4.1):** the script now updates only the rows that changed (found by their UUID) and appends new rows, so edits to other rows, extra columns to the right and formulas there survive. Edits **to the synced columns of a row** are not seen by the phones and are overwritten the next time any phone edits that record.
- **Batches (0.4.1):** phones send at most 100 changes per request (the script refuses more than 250). The script checks the whole batch first, writes the changed rows, and bumps the sheet revision last, under a script lock. Google Sheets has no transactions, so a time-out mid-write can leave some rows written; the phone keeps everything queued and the retry (keyed by UUID) completes it without duplicates.
- **Backup/restore with sync on:** a restore replaces this phone's data and re-queues all of it. It is merged into the Sheet by the rules above. **It does not delete anything from the Sheet**, and items deleted elsewhere stay deleted.
- **Security:** anyone with the URL **and** team code can read and write. To revoke access, change the code (see the setup guide). The Sheet is on the owner's Google account.
- **Restoring an old (v1–v3) backup is refused while sync is on**, because those backups have no sync IDs. **Turning sync on (0.4.1)** first reads the Sheet and matches this phone's records to existing ones by natural key (borehole name, not case-sensitive; reading = borehole + date/time + depth + User Code), so sync off → old restore → sync on does not duplicate them. Readings that differ in any of those fields are uploaded as new.
- **Known limits (0.4.1):** times come from each phone's clock, so a wrong clock can win or lose edits and delete-vs-edit decisions wrongly. A reading's depth and notes share one edit time. Renaming a borehole and creating a new one with its old name in the same offline session can be treated as a same-name merge (flagged). Hand edits to synced columns can be overwritten (above); sorting the Sheet *during* a sync can misplace that sync's rows. Matching on turn-on uses the exact depth, so a reading whose depth was edited on one side after the backup is uploaded as a second record (visible, nothing lost). Turn-on matching also adopts the Sheet's borehole for a same-name local one without a ⚑ flag. If a stale edit form is saved for a reading whose borehole was deleted meanwhile, the save shows an error (the restore path is through sync, not the form). Anyone with the URL and code could delete data; the Sheet's *File → Version history* is the way back.
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

## 0.4.2 (review fixes)
- A reading form left open across a borehole rename or merge now saves under the current borehole (found by its id), instead of re-creating the old one.
- A reading delete interrupted by a Sheet time-out is completed on the next sync; a leftover row no longer keeps its borehole alive.
- Waiting for a missing borehole holds the sync position for at most 5 syncs; re-keeping an edited borehole no longer re-sends it every sync.
- Readings refused because their borehole was refused are shown as failed and linked; they clear when the borehole is fixed, and discarding the borehole discards them too (kept in backups).

### Known limits
- Turning sync on for a phone with old local data can re-upload records that were deleted on another phone before (deletions are matched by id, not by name).
- The "edited elsewhere" check on save is not atomic: two saves in the same second on one phone may not warn.
- A delete aimed at a borehole that was already merged into another is ignored on the Sheet (the merged borehole stays).
- If you add your own columns to the Sheet, add them to the right of the app's columns.
