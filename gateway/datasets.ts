/**
 * @file datasets.ts (data gateway)
 *
 * Gateway configuration and the per-dataset cache. A dataset is a named, read-only table of records with a key
 * column; its rows come from a driver (drivers.ts) and are kept in memory, refreshed in the background every
 * `refreshMs`, so browsers looking records up never wait on the database and never cause a query of their own.
 * The config file format is documented in docs/DATA_SOURCES.md; gateway/example/ has a working sample.
 */
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DATASET_NAME, type DatasetInfo, type FieldValue, type RecordFields } from '../src/data/records';
import { DRIVERS, type DriverName, type Row, type SourceConfig, isReadQuery, readRows } from './drivers';

export interface DatasetConfig extends SourceConfig {
  label?: string;
  /** Column holding each record's key (the value drawing objects link by). */
  key: string;
  /** Columns to serve, in order; all columns when absent (hide internal columns with this). */
  fields?: string[];
  /** How often the cache is refreshed, ms; 60000 when absent, at least 5000. */
  refreshMs: number;
}

export interface GatewayConfig {
  host: string;
  port: number;
  /** Value of Access-Control-Allow-Origin, for a gateway on another origin than the editor; none when absent. */
  allowOrigin?: string;
  datasets: Record<string, DatasetConfig>;
}

export const DEFAULT_PORT = 7840;
const DEFAULT_REFRESH = 60_000;
const DEFAULT_MAX_ROWS = 100_000;
const MAX_TEXT = 2000;

/** Validates a parsed config file; throws with a Korean message naming the bad field. */
export function parseConfig(raw: unknown): GatewayConfig {
  if (!raw || typeof raw !== 'object') throw new Error('설정 파일은 JSON 객체여야 합니다.');
  const r = raw as Record<string, any>;
  const out: GatewayConfig = {
    host: typeof r.host === 'string' && r.host ? r.host : '127.0.0.1',
    port: Number.isInteger(r.port) && r.port > 0 && r.port < 65536 ? r.port : DEFAULT_PORT,
    datasets: {},
  };
  if (typeof r.allowOrigin === 'string' && r.allowOrigin) out.allowOrigin = r.allowOrigin;
  const sets = r.datasets ?? {};
  if (typeof sets !== 'object' || Array.isArray(sets)) throw new Error('datasets는 이름 → 설정 객체여야 합니다.');
  for (const [name, d] of Object.entries<any>(sets)) {
    const where = `datasets.${name}`;
    if (!DATASET_NAME.test(name)) throw new Error(`${where}: 이름은 영문·숫자·_-. 64자 이내여야 합니다.`);
    if (!d || typeof d !== 'object') throw new Error(`${where}: 설정 객체가 아닙니다.`);
    if (!DRIVERS.includes(d.driver)) throw new Error(`${where}.driver는 ${DRIVERS.join(', ')} 중 하나여야 합니다.`);
    if (typeof d.key !== 'string' || !d.key) throw new Error(`${where}.key(키 열 이름)가 필요합니다.`);
    const driver = d.driver as DriverName;
    const needs = (field: string) => {
      if (typeof d[field] !== 'string' || !d[field]) throw new Error(`${where}.${field}가 필요합니다(${driver}).`);
    };
    if (driver === 'csv' || driver === 'json' || driver === 'sqlite') needs('file');
    if (driver === 'postgres' || driver === 'mysql' || driver === 'mssql') needs('connection');
    if (driver === 'sqlite' || driver === 'postgres' || driver === 'mysql' || driver === 'mssql') {
      needs('query');
      if (!isReadQuery(d.query)) throw new Error(`${where}.query는 SELECT(또는 WITH … SELECT) 한 문장이어야 합니다. 읽기 전용 계정을 쓰십시오.`);
    }
    if (driver === 'http') needs('url');
    const ds: DatasetConfig = {
      driver,
      key: d.key,
      refreshMs: Number.isFinite(d.refreshMs) ? Math.max(5000, d.refreshMs) : DEFAULT_REFRESH,
      maxRows: Number.isInteger(d.maxRows) && d.maxRows > 0 ? d.maxRows : DEFAULT_MAX_ROWS,
    };
    for (const k of ['label', 'file', 'encoding', 'delimiter', 'connection', 'query', 'url', 'path'] as const) {
      if (typeof d[k] === 'string' && d[k]) ds[k] = d[k];
    }
    if (ds.encoding) {
      try {
        new TextDecoder(ds.encoding);
      } catch {
        throw new Error(`${where}.encoding을 알 수 없습니다: ${ds.encoding}`);
      }
    }
    if (d.headers && typeof d.headers === 'object') ds.headers = Object.fromEntries(Object.entries(d.headers).filter((e): e is [string, string] => typeof e[1] === 'string'));
    if (Array.isArray(d.fields)) ds.fields = d.fields.filter((f: unknown): f is string => typeof f === 'string' && !!f);
    out.datasets[name] = ds;
  }
  return out;
}

/** Reads and validates a config file. */
export async function loadConfig(path: string): Promise<GatewayConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new Error(`설정 파일이 없습니다: ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`설정 파일이 올바른 JSON이 아닙니다: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseConfig(raw);
}

/** Converts a database value to a JSON field value (dates as ISO text, big integers as numbers or text). */
export function toField(v: unknown): FieldValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.length > MAX_TEXT ? v.slice(0, MAX_TEXT) : v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (v instanceof Uint8Array) return null;
  try {
    return toField(JSON.stringify(v));
  } catch {
    return null;
  }
}

/** Turns raw rows into records by key; rows without a key are skipped, a repeated key keeps the first row. */
export function indexRows(rows: Row[], key: string, fields?: string[]): { records: Map<string, RecordFields>; fields: string[] } {
  const columns = fields ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const records = new Map<string, RecordFields>();
  for (const row of rows) {
    const k = toField(row[key]);
    if (k === null || k === '') continue;
    const id = String(k).trim();
    if (!id || records.has(id)) continue;
    const rec: RecordFields = {};
    for (const c of columns) rec[c] = toField(row[c]);
    records.set(id, rec);
  }
  return { records, fields: columns };
}

/** One dataset's cache: loads on first use, then refreshes in the background when older than refreshMs. */
export class Dataset {
  private records = new Map<string, RecordFields>();
  private fields: string[] = [];
  private loadedAt = 0;
  private error: string | undefined;
  private loading: Promise<void> | null = null;

  constructor(
    readonly name: string,
    readonly config: DatasetConfig,
    private resolvePath: (file: string) => string,
    private now: () => number = Date.now,
  ) {}

  /** Makes sure data is there (waits only for the very first load), starting a refresh when stale. */
  async ready(): Promise<void> {
    const stale = this.now() - this.loadedAt > this.config.refreshMs;
    if (stale && !this.loading) this.loading = this.load();
    if (this.loadedAt === 0 && this.loading) await this.loading;
  }

  private async load(): Promise<void> {
    try {
      const rows = await readRows(this.config, this.resolvePath);
      const { records, fields } = indexRows(rows, this.config.key, this.config.fields);
      this.records = records;
      this.fields = fields;
      this.error = undefined;
      this.loadedAt = this.now();
    } catch (err) {
      // Keep serving the last good data; a first failure retries on the next request after a short pause.
      this.error = err instanceof Error ? err.message : String(err);
      if (this.loadedAt === 0) this.loadedAt = this.now() - this.config.refreshMs + 5000;
      else this.loadedAt = this.now();
    } finally {
      this.loading = null;
    }
  }

  info(): DatasetInfo {
    return {
      name: this.name,
      ...(this.config.label ? { label: this.config.label } : {}),
      key: this.config.key,
      fields: this.fields,
      count: this.records.size,
      ...(this.records.size || !this.error ? { loadedAt: this.loadedAt } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  get(key: string): RecordFields | undefined {
    return this.records.get(key);
  }

  /** Keys containing `q` (case-insensitive), for pickers; the first `limit` in source order. */
  keys(q: string, limit: number): string[] {
    const needle = q.toLowerCase();
    const out: string[] = [];
    for (const k of this.records.keys()) {
      if (!needle || k.toLowerCase().includes(needle)) out.push(k);
      if (out.length >= limit) break;
    }
    return out;
  }
}

/** Builds the datasets of a config; relative file paths are resolved against `configPath`'s folder. */
export function createDatasets(config: GatewayConfig, configPath: string): Map<string, Dataset> {
  const base = dirname(resolve(configPath));
  const resolvePath = (file: string) => (isAbsolute(file) ? file : resolve(base, file));
  return new Map(Object.entries(config.datasets).map(([name, c]) => [name, new Dataset(name, c, resolvePath)]));
}
