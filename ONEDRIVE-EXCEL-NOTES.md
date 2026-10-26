# Could sync use a OneDrive Excel workbook instead? (notes, not built)

*Researched Oct 26, 2026 against the Microsoft Graph docs linked below.*

**Short answer:** yes for a **work/school (Microsoft 365 business)** account, with each person signing in to Microsoft. It **can't** work with only a team code unless we also run a small server. For a **personal** OneDrive (outlook.com / hotmail) account, the Excel API isn't supported.

## What it would take
1. **Azure app registration** (Odin, about 20 min, in Entra admin center → App registrations):
   - Type: Single-page application. Redirect URI = the app's GitHub Pages URL.
   - Delegated permission **Files.ReadWrite** (or Files.ReadWrite.All if the workbook is shared from someone else's drive / a SharePoint site), plus **User.Read**.
   - "Accounts in this organizational directory only" for one company tenant. An admin may have to grant consent.
2. **Sign-in in the app with MSAL.js** (`@azure/msal-browser`): authorization code flow with PKCE, tokens cached on the phone. Each phone signs in once. iOS Home Screen apps sometimes lose the session and need the user to sign in again; that has to be handled.
3. **The workbook:** an `.xlsx` in OneDrive for Business or SharePoint with Excel **tables** `Boreholes`, `Readings`, `Tombstones` (same columns as the Google Sheet), shared with the team.
4. **Graph Excel API** ([overview](https://learn.microsoft.com/en-us/graph/api/resources/excel?view=graph-rest-1.0)):
   - `POST …/workbook/createSession` (persistent) → `workbook-session-id` header ([docs](https://learn.microsoft.com/en-us/graph/api/workbook-createsession?view=graph-rest-1.0)).
   - Read: `GET …/workbook/tables/Readings/rows` (or `range` for speed).
   - Write: `POST …/workbook/tables/Readings/rows/add` for new rows; `PATCH …/workbook/tables/Readings/rows/itemAt(index=n)` (or a range) to update.
   - Items are addressed as `/me/drive/items/{id}/workbook/…` or `/drives/{drive-id}/items/{id}/workbook/…` for a shared file.
5. **A new `SyncAdapter`** (`SyncAdapter` in `src/sync/types.ts` already separates this; see `sheets.ts` and `mock.ts`): the merge, tombstone and outbox code stays as it is. The difference is that **the merge runs on the phone**. There is no server code to take a lock, so the adapter must read rows, merge, then write, and retry if the rows changed in between. Excel has no compare-and-swap, so a per-phone "ownership" scheme or a revision cell checked before writing is needed.

## Caveats
- **Business vs personal:** Graph Excel workbook endpoints support OneDrive for Business, SharePoint and group drives only. Microsoft's docs say *"Support for workbooks stored in OneDrive Consumer platform is still not available"*, and `createSession` lists personal Microsoft accounts as **Not supported**. A personal account could only download the whole `.xlsx`, edit it and re-upload it, which risks overwriting other phones' changes.
- **No team-code-only option without a server:** Graph always needs a Microsoft sign-in token. To join with just a code, we'd need a small server (e.g. an Azure Function holding an app credential) that checks the code and calls Graph for the phones. That's more to host and secure. (Apps Script plays this role for Google for free.)
- Concurrency: Excel sessions are slower (often 1–5 s per call) and throttled (HTTP 429). Several phones syncing at once need retry/back-off.
- Security is better than a team code: each person signs in, and access is removed by un-sharing the file or by the tenant admin.

## Effort estimate
| Variant | Effort |
|---|---|
| Business account, each person signs in (MSAL + Graph adapter, merge on the client with retry, tests, docs) | **4–6 dev days** |
| Team code via a small Azure Function proxy (adds hosting, a secret and a deploy guide) | **6–8 dev days** |
| Personal OneDrive | Not recommended: no supported workbook API |

Because the sync engine is adapter-based, the Google Sheet and Excel back ends can coexist. The phones' data and IDs don't change.
