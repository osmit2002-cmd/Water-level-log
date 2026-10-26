export class FakeSheet { name: string; data: unknown[][]; formats: [number, string][]; writes: number; frozen: number; objects(): Record<string, unknown>[] }
export class FakeSpreadsheet { sheets: Map<string, FakeSheet>; getSheetByName(n: string): FakeSheet | null }
export interface FakeEnv { ss: FakeSpreadsheet; props: { getProperty(k: string): string | null; setProperty(k: string, v: string): void }; lock: unknown; now: () => string; _store: Map<string, string>; isLocked(): boolean }
export function fakeEnv(o?: { team?: string | null; clock?: () => string }): FakeEnv;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loadCodeGs(path?: URL | string): any;
