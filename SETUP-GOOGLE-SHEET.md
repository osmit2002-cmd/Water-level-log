# Set up team sync with a Google Sheet (about 10 minutes)

You need a Google account and a computer. You do this **once**. Afterwards each phone only needs a web address and a team code.

The Sheet lives in your own Google Drive. Anyone who has the web address **and** the team code can read and add data, so treat the code like a shared password.

## 1. Create the Sheet
1. Go to <https://sheets.google.com> and click **Blank spreadsheet**.
2. Give it a name at the top left, for example `Water Level Log - Team`.
3. Leave it empty. The script creates the tabs **Boreholes**, **Readings** and **Tombstones** the first time a phone syncs.

## 2. Paste the script
1. In the Sheet, click **Extensions → Apps Script**. A new tab opens with a file called `Code.gs`.
2. Select everything in that file and delete it.
3. Open `sync/apps-script/Code.gs` from this release. Copy **all** of it and paste it in.
4. Click the **Save** icon (the floppy disk).

## 3. Set the team code
Pick a code that is hard to guess, for example `river-team-7-kestrel`. Don't use `CHANGE-ME`; the script refuses it.

**Either** (simplest) change the line near the top of the script:
```js
var TEAM_CODE = 'CHANGE-ME';
```
to
```js
var TEAM_CODE = 'river-team-7-kestrel';
```
and click **Save**.

**Or** (keeps the code out of the script text): click the gear icon **Project Settings** on the left → **Script Properties** → **Add script property**. Set Property `TEAM_CODE` and Value your code, then click **Save script properties**. A Script Property overrides the line in the script.

## 4. Deploy it as a web app
1. Click the blue **Deploy** button (top right) → **New deployment**.
2. Click the gear next to "Select type" and choose **Web app**.
3. Description: `Water Level Log sync`.
4. **Execute as: Me** (your email).
5. **Who has access: Anyone**. (The phones don't sign in to Google; the team code is what keeps strangers out.)
6. Click **Deploy**.
7. Google asks you to **Authorize access**. Choose your account. If you see "Google hasn't verified this app", click **Advanced → Go to (project name) (unsafe)**. It's your own script. Then click **Allow**. The script only asks to edit this spreadsheet.

## 5. Copy the web app URL
After deploying, Google shows a **Web app URL** like
`https://script.google.com/macros/s/AKfy…long…/exec`. Click **Copy**.
(You can find it again later under **Deploy → Manage deployments**.)

Check it: paste the URL into a browser. It should say *"Water Level Log sync is running…"*.

## 6. Join each phone
On every phone:
1. Open Water Level Log → **Settings**, and make sure the **User Code** is set and is **different on each phone** (it is saved with every reading; since 0.6.0 the Reading ID itself is just a number, e.g. `7`).
2. In **Sync**, paste the **Web app URL** and type the **Team code**.
3. Tap **Turn on sync**. Everything already on the phone is uploaded. The badge at the top then shows **All synced**.

Send the URL and code to your team in a private message, not a public channel.

What the badge means:
- **All synced**: everything on this phone is on the Sheet.
- **3 waiting** / **Offline · 3 waiting**: saved on the phone, will be sent next time there is signal. Nothing is lost.
- **Sync error**: tap it to see why (for example "Wrong team code").

iPhone web apps can't sync in the background: open the app with signal to sync. It also syncs every 90 seconds while open, when signal returns, and when you tap **Sync now**.

## 7. Changing the team code later (e.g. someone left)
1. If you used a **Script Property**: Project Settings → Script Properties → edit `TEAM_CODE` → Save. This takes effect immediately; no redeploy is needed.
   If you used the **line in the script**: edit it, Save, then **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**. Keep the same deployment so the URL stays the same.
2. Phones with the old code show **Sync error · Wrong team code**. Their unsent work stays queued on the phone.
3. On each phone: Settings → Sync → **Turn off sync**, then enter the same URL and the **new** code → **Turn on sync**. Queued work is sent then.

Someone who knows the old code can no longer read or write once it has changed. They do keep any data already on their own phone.

## Good to know
- **Hand edits (0.6.0):** see *0.6.0* below. You can delete rows and fix Date, Time, Depth, Water Elevation, Notes, User Code, Reference Point/Elevation and Borehole Name in the Readings table; the phones pick it up. Don't edit the Reading ID or the hidden sync columns (they are put back). Add your own columns to the right; they survive syncs.
- **Updating from 0.4.0:** paste the new `Code.gs` over the old one and *Deploy → Manage deployments → Edit → New version*. The Tombstones tab gains a `Restored At` column automatically.
- **Deleting** in the app writes a row to **Tombstones**, so the item doesn't come back from another phone, unless a phone edited it *after* the delete: then it is restored, flagged ⚑ in the app, and the tombstone gets a `Restored At` time.
- **Big catch-ups:** each request carries at most 250 changes (the app sends 100), so one sync stays far below the 6-minute script limit. If a write is cut off anyway, the phone retries and the result is the same (no duplicates).
- **Restore a backup on a synced phone:** its records are re-sent and merged by the usual rules. Restoring **does not delete** anything from the Sheet.
- **Clocks:** when two phones edit the same field, the edit with the later phone time wins. Keep phones on automatic date & time.
- Free Google limits are far above what a field team needs. Each sync takes 1–3 seconds.

## 0.4.3
No setup change since 0.4.2: Code.gs is unchanged, only the app changed. A Sheet still running the 0.4.1 Code.gs should paste the new Code.gs and redeploy (Deploy > Manage deployments > Edit > New version), because 0.4.2 changed it. The URL and key stay the same.

## 0.6.0: Reading IDs are numbers, and the Readings tab is a real table
**What changes**
- **Reading IDs are just numbers** (1, 2, 3 ...), one sequence for the whole Sheet. The Sheet hands them out, so two phones never end up with the same number, and a number is never reused, even after a delete. A phone that is offline shows a provisional number; if another phone took that number first, it changes to the next free one at the next sync. The old IDs (e.g. `OD-0007`) are kept in the hidden **Old Reading ID** column.
- **Readings tab = one reading per row**, in a real Google Sheets *Table* (header, filter buttons, banding). The readable columns come first; the sync columns (UIDs, Seq, Rev ...) are hidden at the right. If the Table can't be created (see step 3), you get the same layout with a normal filter instead.
- **Your edits reach the phones.** At every phone sync (or **Water Level Log → Apply my sheet edits now**):
  - **Delete a row** (right-click the row number → *Delete row*): the reading is removed from every phone, for good. A phone that still had an edit queued for it does not bring it back. Readings a phone keeps as **Local** are never touched.
  - **Change a value** (Date, Time, Depth, Water Elevation, Notes, User Code, Reference Point/Elevation, or Borehole Name to move it to another borehole): the phones get it. If only Water Elevation is changed, the depth is worked out from it. An invalid value (e.g. a depth that isn't a number, a borehole name that doesn't exist) is put back and the borehole gets a ⚑ note explaining why.
  - **Undo** (Edit → Undo) of a delete brings the reading back on the phones, with a new Reading ID. Prefer Edit → Undo over
    Version history: restoring an old version also rolls back readings that phones sent since then.
  - If a phone edits the same reading later than you, the later edit wins (depth and notes). Date, time and reference values can only be changed in the Sheet.
- Don't edit the **Reading ID** or the hidden columns, and don't add readings as new rows by hand (rows without a Reading UID are ignored; add readings in the app).

**Update steps for Odin (once, about 5 minutes)** - the web app URL stays the same, no phone needs to re-join:
1. Open the Sheet → **Extensions → Apps Script**. Select all of `Code.gs`, paste the new `Code.gs` over it, **Save**.
2. Optional, for a real Table: in the Apps Script editor, left side **Services (+)** → **Google Sheets API** → **Add** (keep the identifier `Sheets`). Without it you get the same columns with a normal filter.
3. Reload the Sheet. A **Water Level Log** menu appears. Click **Water Level Log → Set up / repair the Readings table** and allow access when asked. (If you skip this, the first phone sync does it.)
   - It copies the old tab to **Readings before 0.6.0 (date)** first; nothing is deleted. Check the new Readings tab, then you may delete that copy.
4. **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy.** Do **not** make a new deployment, or the URL changes.
5. On each phone: update the app (open it while online and reload once), then **Settings → Sync now**. The Reading IDs switch to numbers.

### 0.6.0 limits worth knowing
- The columns move (readable columns first). Formulas or charts in other tabs that point at old column letters must be fixed by hand.
- A row copied with the same Reading UID pauses hand deletes until the copy is removed (so a sort or paste can never delete readings by accident).
- The time of a hand edit is when the script next sees it (the next phone sync or "Apply my sheet edits now"), not when it was typed.
  A phone edit made in between can win over it.
- Dates typed as 3/4/2026 are read in the spreadsheet's own order (File → Settings → Locale). YYYY-MM-DD is always safe.
- Rows typed in by hand (no Reading UID) are not readings; add readings on a phone.
- Update every phone to 0.6.0 soon after the script: a 0.5.0 phone still syncs, but shows old-style IDs until updated.
