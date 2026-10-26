# Water Level Log

Offline borehole water-level log for iPhone (and any modern browser). Install it to the Home Screen from Safari and it works with no signal. **All data stays on the device** (IndexedDB); the app makes no network calls with your data.

## Features
- **Boreholes:** Borehole Name, Reference Point (top of casing, collar, …) and Reference Elevation. The name is the borehole's one identifier and must be unique (not case-sensitive). It can be renamed, and the rename carries into all of that borehole's readings. Deleting a borehole removes its readings after a confirm.
- **Readings:** pick the borehole and enter the **depth to top of water** (required, 2 decimals, not negative) and optional notes. The **date and time are taken from the phone's clock when you tap Save**; there is no date/time field. Editing a reading keeps its original date and time.
  - **Reading ID:** a sequential number (1, 2, 3, …) assigned at save. Deleted IDs are never reused.
  - Water Elevation = Reference Elevation − Depth to top of water.
  - Each reading stores the Reference Point and Reference Elevation in use when it was taken, so editing a borehole later never rewrites history.
- **Views:** borehole list (latest water elevation), borehole detail (history table and SVG trend chart), all readings (borehole and date-range filters).
- **Settings → Report columns:** one switch per column. All are on by default and the choice is saved on the device. They control the CSV export and the readings/history tables. At least one column must stay on, and "Turn all on" resets them.
- **Units:** feet (default) or meters. Data is stored in feet and converted for display, entry and export.
- **CSV export:** UTF-8 BOM, RFC 4180 quoting, and a guard against formula injection in text cells. The filename is `waterlevels_<borehole|all>_<YYYY-MM-DD>.csv`. On iPhone it opens the share sheet ("Save to Files"); elsewhere it downloads.
  Columns, in this order (the enabled ones only):
  `Reading ID, Borehole Name, Date, Time, Reference Point, Reference Elevation (ft), Depth to Top of Water (ft), Water Elevation (ft), Notes`. In meters the headers end in `(m)`.
- **Boreholes CSV export and import** (Settings): `Borehole Name, Reference Point, Reference Elevation (ft)` (or `(m)`). Name and elevation are required. Rows are upserted by name and bad rows are listed with line numbers.
- **JSON backup and restore:** `water-level-log-backup` version 2, validated before use, with a confirm before it replaces all data. Version-1 backups from 0.1.0 are converted:
  - The Borehole Name is the old name, or the old ID if there was no name.
  - Reading IDs are assigned in date/time order.
  - Change, status, reader, total depth, location, lat/long and borehole notes are dropped. Dry / No-reading entries have no depth, so they are skipped, and the confirm says how many.

  iOS can clear website storage, so save a backup to Files regularly. The app also requests persistent storage.
- **Upgrading from 0.1.0:** data already on the phone is migrated the same way the first time 0.2.0 opens. The untouched 0.1.0 records are also kept in an internal archive record.
- **Field-ready:** high-contrast "Sunlight" light theme, dark mode (follows the system or can be set), large touch targets, decimal keypad, safe-area insets, and an Add to Home Screen tip in iOS Safari.

## Develop
```bash
npm install
npm run dev          # local dev server
npm test             # vitest unit tests (math, CSV, backup + v1 migration)
npm run build        # type-check + production build to dist/
npx vite preview --port 4173 &
npx playwright install webkit
node scripts/e2e-iphone.mjs   # WebKit iPhone 13 emulation: boreholes, auto-stamped readings, IDs, rename, column toggles, CSV, meters, offline, v1 DB migration
npm run icons        # regenerate PNG icons
```

## Deploy
`.github/workflows/pages.yml` runs the tests, builds and deploys `dist/` to GitHub Pages on every push to `main`. In the repo settings, set Pages → Source to **GitHub Actions**. The build uses `base: './'` with hash routing, so it works under any sub-path.

## Install on iPhone
Open the Pages URL in **Safari** → Share → **Add to Home Screen**. Open it once while online, and from then on it works offline. When an update is deployed, an "An update is ready" banner appears; tap **Update** to switch to it.
