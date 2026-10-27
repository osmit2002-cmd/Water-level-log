export class FakeSheet { name: string; data: unknown[][]; formats: [number, string][]; writes: number; frozen: number; maxRows: number; quoted: Set<string>; formulas: Map<string, string>; rowsWritten: number; hiddenCols: [number, number][]; protections: { desc: string; warn: boolean }[]; filter: unknown; hidden: boolean; deletes?: number; deleteRow(r: number): void; objects(): Record<string, unknown>[]; getRange(r: number, c: number, nr?: number, nc?: number): { setValues(v: unknown[][]): void; getValues(): unknown[][] } }
export class FakeSpreadsheet { sheets: Map<string, FakeSheet>; failAfter: number | null; getSheetByName(n: string): FakeSheet | null; insertSheet(n: string): FakeSheet }
export interface FakeTables { list: { tableId: string; props: unknown[]; range: { endRowIndex: number; endColumnIndex: number } }[]; calls: string[] }
export function fakeTables(): FakeTables;
export interface FakeEnv { tables: FakeTables | null; ss: FakeSpreadsheet; props: { getProperty(k: string): string | null; setProperty(k: string, v: string): void }; lock: unknown; now: () => string; _store: Map<string, string>; isLocked(): boolean }
export function fakeEnv(o?: { team?: string | null; clock?: () => string; tables?: FakeTables }): FakeEnv;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loadCodeGs(path?: URL | string): any;
