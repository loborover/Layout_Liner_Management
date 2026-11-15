/**
 * @file records.ts
 *
 * Source data link ("원본 데이터 연결", the user's request 2026-11-15): drawing objects can reference a record of
 * an external database, so the editor stays a visual tool while names, makers, capacities and other master data
 * live in their own system. The browser never talks to a database: the host runs the data gateway
 * (gateway/, docs/DATA_SOURCES.md), which runs only the read-only queries its owner configured and serves the
 * results as JSON. This file holds the wire format shared with the gateway, the record key rule and the
 * browser/Node client (`RecordStore`) that batches and caches lookups. No DOM, so tests and the MCP server can use it.
 */
import type { Entity, RecordRef } from '../model/types';

/** Upper bounds that keep a hostile file or request from asking for absurd work. */
export const MAX_DATASET_NAME = 64;
export const MAX_RECORD_KEY = 200;
/** Keys asked for in one request (the gateway refuses more). */
export const MAX_KEYS_PER_REQUEST = 100;
/** Dataset names: letters, digits, '_', '-', '.', so they are safe in a URL path and a config file. */
export const DATASET_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** A field value of a record (database values are converted to these by the gateway). */
export type FieldValue = string | number | boolean | null;
export type RecordFields = Record<string, FieldValue>;

/** What GET /datasets returns for each dataset. */
export interface DatasetInfo {
  name: string;
  /** Display name, e.g. "설비 대장". */
  label?: string;
  /** Column holding the record key. */
  key: string;
  /** Column names in display order. */
  fields: string[];
  /** Number of records in the gateway's cache. */
  count: number;
  /** When the cache was last filled, ms since epoch. */
  loadedAt?: number;
  /** Last load error, if the source could not be read. */
  error?: string;
}

/** What GET /datasets/:name/records?key=…&key=… returns. */
export interface RecordsResponse {
  records: Record<string, RecordFields>;
  missing: string[];
}

/** State of one record lookup. */
export type RecordState =
  | { status: 'loading' }
  | { status: 'ok'; fields: RecordFields }
  | { status: 'missing' }
  | { status: 'error'; message: string };

/** Validates a record reference from a file or an API call; undefined when absent or malformed. */
export function parseRecordRef(v: unknown): RecordRef | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as { dataset?: unknown; key?: unknown };
  if (typeof r.dataset !== 'string' || !DATASET_NAME.test(r.dataset)) return undefined;
  const out: RecordRef = { dataset: r.dataset };
  if (typeof r.key === 'string' && r.key.trim() && r.key.length <= MAX_RECORD_KEY) out.key = r.key.trim();
  return out;
}

/** Key used when a link names no key: the equipment number, else the object's name. */
export function defaultRecordKey(e: Entity): string | undefined {
  const k = (e.kind === 'equipment' && e.tag.trim()) || e.name?.trim();
  return k || undefined;
}

/** The record key an object links to, or undefined when it has no link or no usable key. */
export function recordKey(e: Entity): string | undefined {
  if (!e.record) return undefined;
  const k = e.record.key ?? defaultRecordKey(e);
  return k && k.length <= MAX_RECORD_KEY ? k : undefined;
}

/** Shows a field value as text ('' for null). */
export function formatField(v: FieldValue | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? '예' : '아니오';
  return String(v);
}

/** Default gateway address: the editor's own web server proxies /data/ to the gateway (deploy/nginx.conf). */
export const DEFAULT_GATEWAY = '/data';

/**
 * Gateway address from a page's query string (`?data=…`), else `fallback`. Only http(s) addresses and same-origin
 * paths are accepted, so a link cannot point the page at another kind of URL.
 */
export function gatewayAddress(search: string, fallback = DEFAULT_GATEWAY): string {
  const v = new URLSearchParams(search).get('data')?.trim();
  if (v && (/^https?:\/\//i.test(v) || (v.startsWith('/') && !v.startsWith('//')))) return v;
  return fallback;
}

type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

interface CacheEntry {
  state: RecordState;
  at: number;
  waiters: ((s: RecordState) => void)[];
}

/**
 * Client of the data gateway: looks records up by dataset and key, batching the keys asked for in the same tick
 * into one request per dataset and caching results for `ttlMs`, so a panel or a card can ask freely.
 * Failures are kept as an 'error' state (the editor works without a gateway; it just has nothing to show).
 */
export class RecordStore {
  private cache = new Map<string, CacheEntry>();
  private pending = new Map<string, Set<string>>();
  private flushQueued = false;
  private datasetList: { at: number; value: Promise<DatasetInfo[]> } | null = null;
  private listeners = new Set<() => void>();
  readonly base: string;

  /**
   * @param base gateway address, e.g. "/data" behind the editor's own web server or "http://127.0.0.1:7840".
   */
  constructor(
    base: string,
    private fetchFn: Fetch = (url, init) => fetch(url, init),
    private ttlMs = 60_000,
  ) {
    this.base = base.replace(/\/+$/, '');
  }

  /** Calls `fn` whenever a lookup finishes (to refresh a panel). Returns an unsubscribe function. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Datasets the gateway offers (cached like records). */
  datasets(force = false): Promise<DatasetInfo[]> {
    const now = Date.now();
    if (force || !this.datasetList || now - this.datasetList.at > this.ttlMs) {
      const value = this.getJson(`${this.base}/datasets`).then((body) => {
        const list = (body as { datasets?: unknown }).datasets;
        if (!Array.isArray(list)) throw new Error('게이트웨이 응답 형식이 잘못되었습니다.');
        return list as DatasetInfo[];
      });
      // A failed list is retried on the next call instead of being cached.
      value.catch(() => {
        if (this.datasetList?.value === value) this.datasetList = null;
      });
      this.datasetList = { at: now, value };
    }
    return this.datasetList.value;
  }

  /** Record keys of a dataset containing `q` (for a key picker); not cached. */
  async keys(dataset: string, q: string, limit = 50): Promise<string[]> {
    const params = new URLSearchParams({ q, limit: String(limit) });
    const body = (await this.getJson(`${this.base}/datasets/${encodeURIComponent(dataset)}/keys?${params}`)) as { keys?: unknown };
    return Array.isArray(body.keys) ? body.keys.filter((k): k is string => typeof k === 'string') : [];
  }

  /** Last known state of a record without asking the gateway. */
  peek(dataset: string, key: string): RecordState | undefined {
    return this.cache.get(cacheKey(dataset, key))?.state;
  }

  /** Looks a record up (from the cache when fresh). */
  get(dataset: string, key: string): Promise<RecordState> {
    const id = cacheKey(dataset, key);
    const hit = this.cache.get(id);
    if (hit && hit.state.status !== 'loading' && Date.now() - hit.at <= this.ttlMs) return Promise.resolve(hit.state);
    return new Promise((resolve) => {
      if (hit && hit.state.status === 'loading') {
        hit.waiters.push(resolve);
        return;
      }
      this.cache.set(id, { state: { status: 'loading' }, at: Date.now(), waiters: [resolve] });
      let keys = this.pending.get(dataset);
      if (!keys) this.pending.set(dataset, (keys = new Set()));
      keys.add(key);
      if (!this.flushQueued) {
        this.flushQueued = true;
        setTimeout(() => void this.flush(), 0);
      }
    });
  }

  /** Looks up the record an entity links to; undefined when it has no link. */
  getFor(e: Entity): Promise<RecordState> | undefined {
    const key = recordKey(e);
    return e.record && key ? this.get(e.record.dataset, key) : undefined;
  }

  /** Drops cached records and the dataset list (e.g. after the gateway's data changed). */
  clear(): void {
    for (const [id, entry] of this.cache) if (entry.state.status !== 'loading') this.cache.delete(id);
    this.datasetList = null;
  }

  private async flush(): Promise<void> {
    this.flushQueued = false;
    const batches = [...this.pending];
    this.pending.clear();
    await Promise.all(
      batches.flatMap(([dataset, keys]) => {
        const all = [...keys];
        const chunks: string[][] = [];
        for (let i = 0; i < all.length; i += MAX_KEYS_PER_REQUEST) chunks.push(all.slice(i, i + MAX_KEYS_PER_REQUEST));
        return chunks.map((chunk) => this.fetchChunk(dataset, chunk));
      }),
    );
    for (const fn of this.listeners) fn();
  }

  private async fetchChunk(dataset: string, keys: string[]): Promise<void> {
    const q = new URLSearchParams();
    for (const k of keys) q.append('key', k);
    let states: Map<string, RecordState>;
    try {
      const body = (await this.getJson(`${this.base}/datasets/${encodeURIComponent(dataset)}/records?${q}`)) as Partial<RecordsResponse>;
      const records = body.records && typeof body.records === 'object' ? body.records : {};
      states = new Map(
        keys.map((k): [string, RecordState] => {
          const fields = Object.prototype.hasOwnProperty.call(records, k) ? records[k] : undefined;
          return [k, fields && typeof fields === 'object' ? { status: 'ok', fields } : { status: 'missing' }];
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      states = new Map(keys.map((k) => [k, { status: 'error', message }]));
    }
    const now = Date.now();
    for (const [k, state] of states) {
      const id = cacheKey(dataset, k);
      const waiters = this.cache.get(id)?.waiters ?? [];
      this.cache.set(id, { state, at: now, waiters: [] });
      for (const w of waiters) w(state);
    }
  }

  private async getJson(url: string): Promise<unknown> {
    let res;
    try {
      res = await this.fetchFn(url, { headers: { Accept: 'application/json' } });
    } catch {
      throw new Error('데이터 게이트웨이에 연결할 수 없습니다.');
    }
    if (!res.ok) {
      let detail = '';
      try {
        const body = (await res.json()) as { error?: unknown };
        if (typeof body.error === 'string') detail = `: ${body.error}`;
      } catch {
        // Not JSON (e.g. a proxy error page).
      }
      throw new Error(res.status === 404 && !detail ? '데이터 게이트웨이가 설정되지 않았습니다(HTTP 404).' : `데이터 게이트웨이 오류 HTTP ${res.status}${detail}`);
    }
    try {
      return await res.json();
    } catch {
      // e.g. a development server answering an unknown path with index.html.
      throw new Error('데이터 게이트웨이 응답이 JSON이 아닙니다(주소 확인).');
    }
  }
}

function cacheKey(dataset: string, key: string): string {
  return `${dataset}\u0000${key}`;
}
