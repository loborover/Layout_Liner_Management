/**
 * @file sources.ts
 *
 * Live data sources of the monitoring viewer ("호스트 서버의 값을 내려받아 실시간 모니터링").
 * Chosen by the user (2026-10-25): WebSocket push and REST polling, plus a mock source for demos and tests.
 * Every source turns server payloads into LiveValue maps with `normalize`, which accepts (docs/VIEWER.md):
 *
 *   { "values": { "line1.temp": 72.5, "mc1.state": { "value": "RUN", "status": "ok", "unit": "" } } }
 *   { "line1.temp": 72.5 }                                   (flat object)
 *   [ { "key": "line1.temp", "value": 72.5, "status": "warn", "unit": "°C" } ]
 *
 * Status is one of ok | warn | alarm | offline; when the server sends none, thresholds may supply one.
 * Pure parsing lives here (DOM-free, tested in tests/viewer.test.ts); sockets and fetch are thin wrappers.
 */
import type { LiveValue } from '../ui/host';

export type SourceState = 'idle' | 'connecting' | 'live' | 'error';

export interface DataSource {
  readonly label: string;
  start(onValues: (values: Map<string, LiveValue>) => void, onState: (state: SourceState, detail?: string) => void): void;
  stop(): void;
}

const STATUSES = new Set(['ok', 'warn', 'alarm', 'offline']);

/** Threshold rule for a key (or a prefix ending in "*"): value ≥ warn → warn, ≥ alarm → alarm. */
export interface Threshold {
  warn?: number;
  alarm?: number;
  /** Values ≤ low are an alarm too (e.g. a pressure drop). */
  low?: number;
}

function entry(key: string, raw: unknown, at: number): [string, LiveValue] | null {
  if (!key) return null;
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    const v: LiveValue = { value: r.value ?? null, at: typeof r.at === 'number' ? r.at : at };
    if (typeof r.status === 'string' && STATUSES.has(r.status)) v.status = r.status;
    if (typeof r.unit === 'string') v.unit = r.unit;
    return [key, v];
  }
  return [key, { value: raw, at }];
}

/** Parses a server payload into values by key; unknown shapes yield an empty map. */
export function normalize(payload: unknown, at = Date.now()): Map<string, LiveValue> {
  const out = new Map<string, LiveValue>();
  const add = (e: [string, LiveValue] | null) => e && out.set(e[0], e[1]);
  if (Array.isArray(payload)) {
    for (const item of payload) {
      if (item && typeof item === 'object' && typeof (item as { key?: unknown }).key === 'string') add(entry((item as { key: string }).key, item, at));
    }
    return out;
  }
  if (!payload || typeof payload !== 'object') return out;
  const p = payload as Record<string, unknown>;
  const values = p.values && typeof p.values === 'object' && !Array.isArray(p.values) ? (p.values as Record<string, unknown>) : p;
  if (Array.isArray(p.values)) return normalize(p.values, at);
  for (const [k, v] of Object.entries(values)) add(entry(k, v, at));
  return out;
}

/** Fills in a status from thresholds where the server gave none. Exact keys win over "prefix*" rules. */
export function applyThresholds(values: Map<string, LiveValue>, rules: Record<string, Threshold>): void {
  const prefixes = Object.entries(rules).filter(([k]) => k.endsWith('*'));
  for (const [key, v] of values) {
    if (v.status || typeof v.value !== 'number') continue;
    const rule = rules[key] ?? prefixes.find(([k]) => key.startsWith(k.slice(0, -1)))?.[1];
    if (!rule) continue;
    const n = v.value;
    v.status = (rule.alarm !== undefined && n >= rule.alarm) || (rule.low !== undefined && n <= rule.low) ? 'alarm' : rule.warn !== undefined && n >= rule.warn ? 'warn' : 'ok';
  }
}

/** Server pushes payloads over a WebSocket; reconnects with back-off (1 s doubling to 30 s). */
export class WebSocketSource implements DataSource {
  private socket: WebSocket | null = null;
  private retry: number | undefined;
  private delay = 1000;
  private stopped = false;

  constructor(readonly url: string) {}

  get label(): string {
    return `WebSocket ${this.url}`;
  }

  start(onValues: (v: Map<string, LiveValue>) => void, onState: (s: SourceState, d?: string) => void): void {
    this.stopped = false;
    const open = () => {
      onState('connecting');
      const s = new WebSocket(this.url);
      this.socket = s;
      s.onopen = () => {
        this.delay = 1000;
        onState('live');
      };
      s.onmessage = (ev) => {
        try {
          onValues(normalize(JSON.parse(String(ev.data))));
        } catch {
          onState('error', '서버 메시지가 JSON이 아닙니다.');
        }
      };
      s.onclose = () => {
        if (this.stopped) return;
        onState('error', `연결이 끊겼습니다. ${Math.round(this.delay / 1000)}초 뒤 다시 연결합니다.`);
        this.retry = window.setTimeout(open, this.delay);
        this.delay = Math.min(this.delay * 2, 30000);
      };
    };
    open();
  }

  stop(): void {
    this.stopped = true;
    window.clearTimeout(this.retry);
    this.socket?.close();
    this.socket = null;
  }
}

/** Fetches a JSON URL every `intervalMs` (no overlapping requests). */
export class PollingSource implements DataSource {
  private timer: number | undefined;
  private stopped = false;

  constructor(
    readonly url: string,
    readonly intervalMs = 2000,
  ) {}

  get label(): string {
    return `REST ${this.url} (${this.intervalMs / 1000}초)`;
  }

  start(onValues: (v: Map<string, LiveValue>) => void, onState: (s: SourceState, d?: string) => void): void {
    this.stopped = false;
    onState('connecting');
    const tick = async () => {
      try {
        const res = await fetch(this.url, { cache: 'no-store', headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        onValues(normalize(await res.json()));
        onState('live');
      } catch (err) {
        onState('error', `값을 가져오지 못했습니다: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!this.stopped) this.timer = window.setTimeout(tick, this.intervalMs);
    };
    void tick();
  }

  stop(): void {
    this.stopped = true;
    window.clearTimeout(this.timer);
  }
}

/** Simulated values for every key, for trying the viewer without a server. */
export class MockSource implements DataSource {
  readonly label = '모의 데이터';
  private timer: number | undefined;
  private state = new Map<string, number>();

  constructor(
    private readonly keys: () => string[],
    private readonly intervalMs = 1000,
  ) {}

  start(onValues: (v: Map<string, LiveValue>) => void, onState: (s: SourceState, d?: string) => void): void {
    onState('live');
    const tick = () => {
      const out = new Map<string, LiveValue>();
      const now = Date.now();
      for (const key of this.keys()) {
        const prev = this.state.get(key) ?? 40 + Math.random() * 30;
        const next = Math.min(100, Math.max(0, prev + (Math.random() - 0.5) * 8));
        this.state.set(key, next);
        out.set(key, { value: Math.round(next * 10) / 10, status: next >= 85 ? 'alarm' : next >= 70 ? 'warn' : 'ok', at: now });
      }
      onValues(out);
    };
    tick();
    this.timer = window.setInterval(tick, this.intervalMs);
  }

  stop(): void {
    window.clearInterval(this.timer);
  }
}

/** Builds a source from a URL: ws(s):// → WebSocket, http(s):// → polling, "mock" → simulated. */
export function sourceFor(url: string, intervalMs: number, keys: () => string[]): DataSource {
  if (url === 'mock') return new MockSource(keys);
  if (/^wss?:\/\//i.test(url)) return new WebSocketSource(url);
  if (/^https?:\/\//i.test(url) || url.startsWith('/')) return new PollingSource(url, intervalMs);
  throw new Error('ws://, wss://, http://, https:// 주소나 mock을 입력하십시오.');
}
