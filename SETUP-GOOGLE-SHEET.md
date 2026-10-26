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
1. Open Water Level Log → **Settings**, and make sure the **User Code** is set and is **different on each phone** (it is part of every Reading ID, e.g. `JD-0007`).
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
- **Hand edits (0.4.1):** the script finds rows by their UID column and rewrites only rows that changed, appending new ones. So you can sort/filter (but not while phones are syncing, since a sort during the 1–3 s write can put values in the wrong rows; filter views are safer), add your own columns to the right, and add notes or formulas there; they survive syncs. **Don't edit the synced columns of a data row**: the phones don't see such edits, and the next app edit of that record overwrites them. Never edit or delete the UID, Rev or "Updated At" columns, and don't rename the header row. To fix a value, edit it in the app.
- **Updating from 0.4.0:** paste the new `Code.gs` over the old one and *Deploy → Manage deployments → Edit → New version*. The Tombstones tab gains a `Restored At` column automatically.
- **Deleting** in the app writes a row to **Tombstones**, so the item doesn't come back from another phone, unless a phone edited it *after* the delete: then it is restored, flagged ⚑ in the app, and the tombstone gets a `Restored At` time.
- **Big catch-ups:** each request carries at most 250 changes (the app sends 100), so one sync stays far below the 6-minute script limit. If a write is cut off anyway, the phone retries and the result is the same (no duplicates).
- **Restore a backup on a synced phone:** its records are re-sent and merged by the usual rules. Restoring **does not delete** anything from the Sheet.
- **Clocks:** when two phones edit the same field, the edit with the later phone time wins. Keep phones on automatic date & time.
- Free Google limits are far above what a field team needs. Each sync takes 1–3 seconds.
