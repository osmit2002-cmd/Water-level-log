# Water Level Log

Offline borehole water-level log for iPhone (and any modern browser). Install it to the Home Screen from Safari and it works with no signal. **All data stays on the device** (IndexedDB); the app makes no network calls with your data.

## Features
- **Boreholes:** ID, name, reference point label (top of casing, collar, …), reference elevation, optional total depth, location, notes, lat/long. Add, edit, delete (delete removes that borehole's readings after a confirm). The ID can't be changed after creation.
- **Readings:** depth to water (2 decimals) below the reference point, or a status of **Dry** / **No reading**. Date and time default to now and can be edited, plus optional reader and notes.
  - Water elevation = reference elevation − depth.
  - Change = this water elevation − the previous *valid* reading's elevation for the same borehole, in date/time order. Dry and No-reading entries are skipped. Changes are recomputed after any edit, delete or out-of-order entry.
  - Each reading stores the reference elevation and point in use when it was taken, so editing a borehole later never rewrites history.
  - A change of more than 10 ft asks for a second "Save anyway" tap. Negative depths are rejected, and a depth past the total depth shows a warning.
- **Views:** borehole list (latest water elevation and change), borehole detail (history table and SVG trend chart), all readings (borehole and date-range filters).
- **Units:** feet (default) or meters. Data is stored in feet and converted for display, entry and export. CSV headers end in `_ft` or `_m`.
- **CSV export:** UTF-8 BOM, RFC 4180 quoting, a guard against formula injection in text cells. The filename is `waterlevels_<borehole|all>_<YYYY-MM-DD>.csv`. On iPhone it opens the share sheet ("Save to Files"); elsewhere it downloads.
  Columns: `borehole_id, reference_point, reference_elevation_ft, date, time, depth_to_water_ft, water_elevation_ft, change_from_previous_ft, total_depth_ft, notes, status, borehole_name, reader, latitude, longitude`.
- **Boreholes CSV export and import** (Data tab): requires `borehole_id` and `reference_elevation_ft` (or `_m`). Optional columns are `borehole_name, reference_point, total_depth_ft, location, notes, latitude, longitude`. Rows are upserted by ID and bad rows are listed with line numbers.
- **JSON backup and restore:** a versioned format (`water-level-log-backup` v1), validated before use, with a confirm before it replaces all data. iOS can clear website storage, so save a backup to Files regularly. The app also requests persistent storage.
- **Field-ready:** high-contrast "Sunlight" light theme, dark mode (follows the system or can be set), large touch targets, decimal keypad, safe-area insets, and an Add to Home Screen tip in iOS Safari.

## Develop
```bash
npm install
npm run dev          # local dev server
npm test             # vitest unit tests (math, CSV, backup)
npm run build        # type-check + production build to dist/
npx vite preview --port 4173 &
npx playwright install webkit
node scripts/e2e-iphone.mjs   # WebKit iPhone 13 emulation: add borehole, add reading, CSV export, offline reload
npm run icons        # regenerate PNG icons
```

## Deploy
`.github/workflows/pages.yml` runs the tests, builds and deploys `dist/` to GitHub Pages on every push to `main`. In the repo settings, set Pages → Source to **GitHub Actions**. The build uses `base: './'` with hash routing, so it works under any sub-path.

## Install on iPhone
Open the Pages URL in **Safari** → Share → **Add to Home Screen**. Open it once while online, and from then on it works offline. When an update is deployed, close and reopen the app to pick it up.
