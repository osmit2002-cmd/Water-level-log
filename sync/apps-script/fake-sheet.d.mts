export class FakeSheet { name: string; data: unknown[][]; formats: [number, string][]; writes: number; frozen: number; maxRows: number; quoted: Set<string>; formulas: Map<string, string>; rowsWritten: number; objects(): Record<string, unknown>[]; getRange(r: number, c: number, nr?: number, nc?: number): { setValues(v: unknown[][]): void; getValues(): unknown[][] } }
export class FakeSpreadsheet { sheets: Map<string, FakeSheet>; failAfter: number | null; getSheetByName(n: string): FakeSheet | null; insertSheet(n: string): FakeSheet }
export interface FakeEnv { ss: FakeSpreadsheet; props: { getProperty(k: string): string | null; setProperty(k: string, v: string): void }; lock: unknown; now: () => string; _store: Map<string, string>; isLocked(): boolean }
export function fakeEnv(o?: { team?: string | null; clock?: () => string }): FakeEnv;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loadCodeGs(path?: URL | string): any;
