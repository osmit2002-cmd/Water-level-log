import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { QUEUED_EVENT, outboxCount, queueEverything, resetCursor } from '../lib/db';
import { useStore } from '../store';
import { syncOnce } from './engine';
import { SheetsAdapter, syncUrlError } from './sheets';
import type { SyncAdapter } from './types';

export interface SyncConfig { enabled: boolean; url: string; team: string; lastSyncedAt?: string; lastError?: string }
export const SYNC_KEY = 'wll-sync';
/** Periodic sync while the app is open. */
export const SYNC_INTERVAL_MS = 90_000;
/** Wait after a save before syncing, so a burst of edits goes in one request. */
export const SYNC_DEBOUNCE_MS = 2_000;

export function loadSyncConfig(): SyncConfig {
  try {
    const j = JSON.parse(localStorage.getItem(SYNC_KEY) ?? '{}');
    return { enabled: !!j.enabled, url: typeof j.url === 'string' ? j.url : '', team: typeof j.team === 'string' ? j.team : '', lastSyncedAt: j.lastSyncedAt || undefined, lastError: j.lastError || undefined };
  } catch { return { enabled: false, url: '', team: '' }; }
}
export type SyncState = 'off' | 'syncing' | 'synced' | 'waiting' | 'offline' | 'error';

interface SyncCtx {
  config: SyncConfig;
  pending: number;
  state: SyncState;
  busy: boolean;
  /** Check the URL and code, then turn sync on (queues all local data) and sync. Returns an error message or ''. */
  enable: (url: string, team: string) => Promise<string>;
  disable: () => void;
  syncNow: () => Promise<void>;
}
const Ctx = createContext<SyncCtx | null>(null);
export const useSync = () => useContext(Ctx)!;

/** Test hook: lets e2e/unit tests swap the transport. */
export let makeAdapter = (url: string, team: string): SyncAdapter => new SheetsAdapter(url, team);
export function _setAdapterFactory(f: typeof makeAdapter) { makeAdapter = f; }

export function SyncProvider({ children }: { children: ReactNode }) {
  const { reload, ready } = useStore();
  const [config, setConfigState] = useState<SyncConfig>(loadSyncConfig);
  const cfgRef = useRef(config);
  const [pending, setPending] = useState(0);
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);
  const inFlight = useRef<Promise<void> | null>(null);
  const again = useRef(false);

  const setConfig = useCallback((p: Partial<SyncConfig>) => {
    const n = { ...cfgRef.current, ...p };
    cfgRef.current = n;
    localStorage.setItem(SYNC_KEY, JSON.stringify(n));
    setConfigState(n);
  }, []);
  const refreshCount = useCallback(async () => { try { setPending(await outboxCount()); } catch { /* db not open */ } }, []);

  const run = useCallback(async (): Promise<void> => {
    const c = cfgRef.current;
    if (!c.enabled || !c.url) return;
    if (inFlight.current) { again.current = true; return inFlight.current; }
    const p = (async () => {
      setBusy(true);
      try {
        do {
          again.current = false;
          const r = await syncOnce(makeAdapter(cfgRef.current.url, cfgRef.current.team));
          if (r.changed) await reload();
          setConfig({ lastSyncedAt: new Date().toISOString(), lastError: undefined });
        } while (again.current && cfgRef.current.enabled);
      } catch (e) {
        if (cfgRef.current.enabled) setConfig({ lastError: (e as Error).message || String(e) });
      } finally {
        await refreshCount();
        setBusy(false);
        inFlight.current = null;
      }
    })();
    inFlight.current = p;
    return p;
  }, [reload, refreshCount, setConfig]);

  // Triggers: app open, coming back online, returning to the app, a timer, and (debounced) after each local save.
  useEffect(() => {
    if (!ready) return;
    void refreshCount();
    if (!config.enabled) return;
    void run();
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const onQueued = () => { void refreshCount(); clearTimeout(debounce); debounce = setTimeout(() => void run(), SYNC_DEBOUNCE_MS); };
    const onOnline = () => { setOnline(true); void run(); };
    const onOffline = () => setOnline(false);
    const onVisible = () => { if (document.visibilityState === 'visible') void run(); };
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') void run(); }, SYNC_INTERVAL_MS);
    window.addEventListener(QUEUED_EVENT, onQueued);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(debounce); clearInterval(timer);
      window.removeEventListener(QUEUED_EVENT, onQueued);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [ready, config.enabled, run, refreshCount]);
  // Keep the count right when sync is off too (it is shown in Settings).
  useEffect(() => {
    if (config.enabled) return;
    const f = () => void refreshCount();
    window.addEventListener(QUEUED_EVENT, f);
    return () => window.removeEventListener(QUEUED_EVENT, f);
  }, [config.enabled, refreshCount]);

  const enable = useCallback(async (url: string, team: string) => {
    url = url.trim(); team = team.trim();
    const ue = syncUrlError(url);
    if (ue) return ue;
    if (!team) return 'Enter the team code';
    const st = await makeAdapter(url, team).status();
    if (!st.ok) return st.message;
    await queueEverything();
    await resetCursor(); // this may be a different sheet than last time: pull everything
    setConfig({ enabled: true, url, team, lastError: undefined });
    await run();
    return cfgRef.current.lastError ?? '';
  }, [run, setConfig]);
  const disable = useCallback(() => setConfig({ enabled: false, lastError: undefined }), [setConfig]);
  const syncNow = useCallback(() => run(), [run]);

  const state: SyncState = !config.enabled ? 'off' : busy ? 'syncing' : !online ? 'offline' : config.lastError ? 'error' : pending ? 'waiting' : 'synced';
  const value = useMemo(() => ({ config, pending, state, busy, enable, disable, syncNow }), [config, pending, state, busy, enable, disable, syncNow]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function SyncBadge() {
  const { state, pending, config } = useSync();
  if (state === 'off') return null;
  const text = state === 'synced' ? 'All synced'
    : state === 'syncing' ? (pending ? `Syncing ${pending}…` : 'Syncing…')
    : state === 'offline' ? (pending ? `Offline · ${pending} waiting` : 'Offline')
    : state === 'error' ? (pending ? `Sync error · ${pending} waiting` : 'Sync error')
    : `${pending} waiting`;
  return <a href="#/settings" className={`sync-badge ${state}`} data-testid="sync-badge" data-state={state} title={state === 'error' ? config.lastError : undefined}>{text}</a>;
}
