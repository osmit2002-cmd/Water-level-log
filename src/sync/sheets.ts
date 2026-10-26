import type { AdapterStatus, PullResult, PushBatch, PushResult, SyncAdapter } from './types';

/**
 * Google Sheet + Apps Script web app (sync/apps-script/Code.gs).
 * Requests are POSTs with a text/plain body: a "simple request", so the browser sends no CORS preflight
 * (Apps Script cannot answer OPTIONS). The script replies with JSON; errors come back as { ok: false, error }.
 */
export class SheetsAdapter implements SyncAdapter {
  readonly kind = 'google-sheet';
  constructor(private url: string, private team: string, private timeoutMs = 30000) {}
  private async call<T>(op: string, body: Record<string, unknown> = {}): Promise<T> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(this.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ team: this.team, op, ...body }), redirect: 'follow', signal: ctl.signal, credentials: 'omit' });
    } catch (e) {
      throw new Error((e as Error).name === 'AbortError' ? 'The sync server did not answer in time' : 'Could not reach the sync server (no signal?)');
    } finally { clearTimeout(t); }
    if (!res.ok) throw new Error(`Sync server error (HTTP ${res.status})`);
    let j: { ok?: boolean; error?: string } & T;
    try { j = await res.json(); } catch { throw new Error('The web app URL did not return sync data. Check the URL (it should end in /exec) and that access is "Anyone".'); }
    if (!j.ok) throw new Error(j.error || 'Sync failed');
    return j;
  }
  push(batch: PushBatch) { return this.call<PushResult>('push', { ...batch }); }
  pull(since: number) { return this.call<PullResult>('pull', { since }); }
  async status(): Promise<AdapterStatus> {
    try { const r = await this.call<{ message?: string }>('ping'); return { ok: true, message: r.message || 'Connected' }; } catch (e) { return { ok: false, message: (e as Error).message }; }
  }
}

/** Basic check of a web app URL entered in Settings. */
export function syncUrlError(url: string): string {
  let u: URL;
  try { u = new URL(url.trim()); } catch { return 'Enter the web app URL (starts with https://)'; }
  if (u.protocol !== 'https:') return 'The web app URL must start with https://';
  return '';
}
