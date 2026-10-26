import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Borehole, Reading, Settings } from './lib/types';
import { normalizeSettings } from './lib/types';
import { allBoreholes, allReadings, requestPersist } from './lib/db';
import { deriveReadings, type DerivedReading } from './lib/math';

const SETTINGS_KEY = 'wll-settings';
export function loadSettings(): Settings {
  try { return normalizeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}')); } catch { return normalizeSettings({}); }
}

interface Store {
  ready: boolean;
  loadError?: string;
  boreholes: Borehole[];
  bhMap: Map<string, Borehole>;
  readings: Reading[];
  derived: DerivedReading[];
  settings: Settings;
  persisted?: boolean;
  setSettings: (s: Settings) => void;
  reload: () => Promise<void>;
}
const Ctx = createContext<Store | null>(null);
export const useStore = () => useContext(Ctx)!;

export function StoreProvider({ children }: { children: ReactNode }) {
  const [boreholes, setB] = useState<Borehole[]>([]);
  const [readings, setR] = useState<Reading[]>([]);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [persisted, setPersisted] = useState<boolean>();
  const [settings, setS] = useState<Settings>(loadSettings);
  const reload = useCallback(async () => {
    try {
      const [b, r] = await Promise.all([allBoreholes(), allReadings()]);
      b.sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true }));
      setB(b); setR(r); setReady(true); setLoadError(undefined);
    } catch (e) {
      setLoadError((e as Error).message || String(e));
    }
  }, []);
  useEffect(() => { void reload(); void requestPersist().then(setPersisted); }, [reload]);
  const setSettings = useCallback((s: Settings) => { const n = normalizeSettings(s); localStorage.setItem(SETTINGS_KEY, JSON.stringify(n)); setS(n); }, []);
  useEffect(() => {
    const el = document.documentElement;
    if (settings.theme === 'auto') delete el.dataset.theme; else el.dataset.theme = settings.theme;
  }, [settings.theme]);
  const value = useMemo<Store>(() => ({
    ready, loadError, boreholes, readings, settings, persisted, setSettings, reload,
    bhMap: new Map(boreholes.map((b) => [b.name, b])), derived: deriveReadings(readings)
  }), [ready, loadError, boreholes, readings, settings, persisted, setSettings, reload]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
