/**
 * @file main.ts (viewer)
 *
 * Monitoring viewer app ("뷰어모드 전용 앱"), entry of viewer.html. A separate, read-only page for operators:
 * it loads a drawing made in the editor, connects to the host server's live values (WebSocket push or REST
 * polling, see sources.ts) and shows each bound object coloured by status with its value, a watch list sorted
 * by severity, and an information card on click. It reuses the editor's model, renderer and InspectTool but has
 * no editing code paths, so it can be deployed for monitoring screens on its own.
 *
 * Configuration (docs/VIEWER.md): URL parameters drawing, source, interval, floor, or config=<json url> with
 * { drawing, source, interval, thresholds, staleMs }.
 */
import { DocumentModel } from '../model/document';
import { History } from '../model/commands';
import { Selection } from '../model/selection';
import { SpatialIndex } from '../model/spatial';
import { ConstraintService } from '../constraints/service';
import { deserialize, FormatError } from '../io/serialize';
import type { Id } from '../model/types';
import { InspectTool } from '../tools/inspect';
import type { ToolContext, ToolPointer } from '../tools/tool';
import { hydrateIcons } from '../ui/icons';
import type { LiveValue } from '../ui/host';
import { fillInspector } from '../ui/inspector';
import { Sidebar } from '../ui/sidebar';
import { showVersion } from '../ui/version';
import { type EntityStatus, Renderer } from '../view/renderer';
import { Viewport } from '../view/viewport';
import { type DataSource, type SourceState, type Threshold, applyThresholds, sourceFor } from './sources';
import { STATUS } from '../theme';

const STATUS_COLORS: Record<string, string> = STATUS;
const STATUS_LABELS: Record<string, string> = { ok: '정상', warn: '주의', alarm: '경보', offline: '수신 없음' };
const SEVERITY: Record<string, number> = { alarm: 0, warn: 1, offline: 2, ok: 3 };
const WHEEL_ZOOM_STEP = 1.0015;

interface ViewerConfig {
  drawing?: string;
  source?: string;
  interval?: number;
  floor?: string;
  thresholds?: Record<string, Threshold>;
  /** A value older than this is shown as offline, ms. Default: 3 polling intervals, at least 10 s. */
  staleMs?: number;
}

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`Missing element ${sel}`);
  return el;
};

class ViewerApp {
  readonly doc = new DocumentModel();
  readonly history = new History(this.doc);
  readonly selection = new Selection();
  readonly view = new Viewport();
  readonly index = new SpatialIndex(this.doc);
  readonly values = new Map<string, LiveValue>();
  private renderer: Renderer;
  private tool: InspectTool;
  private canvas = $<HTMLCanvasElement>('#canvas');
  private card = $<HTMLDivElement>('#inspector');
  private source: DataSource | null = null;
  private config: ViewerConfig = {};
  private hover: Id | null = null;
  private inspected: Id | null = null;
  private frame = false;
  private pan: { x: number; y: number } | null = null;
  private sidebar: Sidebar;

  constructor() {
    hydrateIcons();
    this.renderer = new Renderer(this.canvas, this.view, this.doc, this.index, this.selection);
    this.renderer.onImageLoad = () => this.render();
    const ctx: ToolContext = {
      doc: this.doc,
      history: this.history,
      index: this.index,
      selection: this.selection,
      view: this.view,
      constraints: new ConstraintService(this.doc, this.history),
      unit: () => 'mm',
      layer: () => this.doc.layers.keys().next().value ?? '',
      pickTolerance: () => this.view.pxToMm(6),
      setHover: (id) => {
        if (id !== this.hover) {
          this.hover = id;
          this.render();
        }
      },
      setHint: (t) => ($<HTMLSpanElement>('#status-hint').textContent = t),
      notify: (t) => this.notify(t),
      ask: () => null,
      requestRender: () => this.render(),
    };
    this.tool = new InspectTool(ctx, (id, at) => this.inspect(id, at));
    $<HTMLSpanElement>('#status-hint').textContent = this.tool.hint;
    this.sidebar = new Sidebar($<HTMLElement>('.sidebar'), () => this.resize(), { section: 'watch', store: 'layout-liner:viewer-sidebar' });
    this.bind();
    new ResizeObserver(() => this.resize()).observe(this.canvas.parentElement!);
    this.resize();
    this.doc.onChange(() => {
      this.refreshFloors();
      this.render();
    });
    this.selection.onChange(() => this.render());
    // Re-evaluate staleness even when no message arrives.
    window.setInterval(() => this.render(), 2000);
    void this.configure();
  }

  // ---------- configuration and data ----------

  private async configure(): Promise<void> {
    const q = new URLSearchParams(location.search);
    if (q.get('config')) {
      try {
        this.config = await (await fetch(q.get('config')!, { cache: 'no-store' })).json();
      } catch (err) {
        this.notify(`설정 파일을 읽을 수 없습니다: ${String(err)}`);
      }
    }
    for (const k of ['drawing', 'source', 'floor'] as const) if (q.get(k)) this.config[k] = q.get(k)!;
    if (q.get('interval')) this.config.interval = Number(q.get('interval'));
    if (this.config.interval) $<HTMLInputElement>('#source-interval').value = String(this.config.interval);
    if (this.config.source) $<HTMLInputElement>('#source-url').value = this.config.source;
    if (this.config.drawing) {
      try {
        const res = await fetch(this.config.drawing, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.load(await res.text());
      } catch (err) {
        this.notify(`도면을 불러올 수 없습니다: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else this.notify('도면 열기로 편집기에서 저장한 도면(.json)을 여십시오.');
    if (this.config.source) this.connect(this.config.source);
  }

  private load(text: string): void {
    try {
      this.doc.load(deserialize(text));
    } catch (err) {
      return this.notify(err instanceof FormatError ? `도면을 열 수 없습니다: ${err.message}` : String(err));
    }
    if (this.config.floor && this.doc.floors.has(this.config.floor)) this.doc.activeFloor = this.config.floor;
    this.selection.clear();
    this.inspect(null, { x: 0, y: 0 });
    $<HTMLSpanElement>('#status-msg').textContent = '';
    this.doc.changed();
    this.fit();
  }

  private bindingKeys(): string[] {
    return [...new Set([...this.doc.entities.values()].flatMap((e) => (e.binding ? [e.binding] : [])))];
  }

  private connect(url: string): void {
    this.source?.stop();
    const interval = Math.max(250, Number($<HTMLInputElement>('#source-interval').value) || 2000);
    try {
      this.source = sourceFor(url, interval, () => this.bindingKeys());
    } catch (err) {
      this.source = null;
      return this.notify(err instanceof Error ? err.message : String(err));
    }
    this.source.start(
      (values) => {
        applyThresholds(values, this.config.thresholds ?? {});
        for (const [k, v] of values) this.values.set(k, v);
        this.render();
        this.refreshCard();
      },
      (state, detail) => this.sourceState(state, detail),
    );
    $<HTMLButtonElement>('[data-action="connect"]').textContent = '끊기';
  }

  private disconnect(): void {
    this.source?.stop();
    this.source = null;
    this.sourceState('idle');
    $<HTMLButtonElement>('[data-action="connect"]').textContent = '연결';
  }

  private sourceState(state: SourceState | 'idle', detail?: string): void {
    const pill = $<HTMLSpanElement>('#source-state');
    pill.className = `pill ${state}`;
    pill.textContent = { idle: '연결 안 됨', connecting: '연결 중…', live: `수신 중 · ${this.source?.label ?? ''}`, error: '오류' }[state];
    if (detail) this.notify(detail);
  }

  /** Current value with staleness applied: no update for staleMs → offline. */
  private valueOf(key: string): LiveValue | undefined {
    const v = this.values.get(key);
    if (!v) return undefined;
    const interval = Number($<HTMLInputElement>('#source-interval').value) || 2000;
    const stale = this.config.staleMs ?? Math.max(10000, interval * 3);
    return Date.now() - v.at > stale ? { ...v, status: 'offline' } : v;
  }

  // ---------- rendering ----------

  private statusMap(): Map<Id, EntityStatus> {
    const out = new Map<Id, EntityStatus>();
    for (const e of this.doc.entities.values()) {
      if (!e.binding) continue;
      const v = this.valueOf(e.binding);
      out.set(e.id, v ? { color: STATUS_COLORS[v.status ?? 'ok'], text: `${String(v.value)}${v.unit ? ` ${v.unit}` : ''}` } : { color: STATUS_COLORS.offline, text: '—' });
    }
    return out;
  }

  render(): void {
    if (this.frame) return;
    this.frame = true;
    requestAnimationFrame(() => {
      this.frame = false;
      const drawn = this.renderer.render({ hover: this.hover, unit: 'mm', status: this.statusMap(), clean: true });
      const floor = this.doc.floors.get(this.doc.activeFloor)?.name ?? '';
      $<HTMLSpanElement>('#status-info').textContent = `${floor} · 객체 ${drawn}`;
      this.renderList();
    });
  }

  private renderList(): void {
    const rows = [...this.doc.entities.values()]
      .filter((e) => e.binding)
      .map((e) => ({ e, v: this.valueOf(e.binding!) }))
      .sort((a, b) => SEVERITY[a.v?.status ?? 'offline'] - SEVERITY[b.v?.status ?? 'offline'] || a.e.binding!.localeCompare(b.e.binding!));
    const counts: Record<string, number> = { ok: 0, warn: 0, alarm: 0, offline: 0 };
    const items = rows.map(({ e, v }) => {
      const status = v?.status ?? 'offline';
      counts[status]++;
      const li = document.createElement('li');
      li.classList.toggle('selected', this.selection.has(e.id));
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = STATUS_COLORS[status];
      dot.title = STATUS_LABELS[status];
      const name = document.createElement('span');
      const type = e.kind === 'equipment' ? this.doc.equipmentTypes.get(e.type) : undefined;
      name.textContent = e.kind === 'equipment' ? [e.tag, e.name || type?.name].filter(Boolean).join(' ') : (e.name ?? e.binding!);
      const val = document.createElement('span');
      val.className = 'val';
      val.textContent = v ? `${String(v.value)}${v.unit ? ` ${v.unit}` : ''}` : '—';
      const sub = document.createElement('span');
      sub.className = 'sub';
      sub.textContent = `${e.binding} · ${this.doc.floors.get(this.doc.floorOf(e) ?? '')?.name ?? ''} · ${STATUS_LABELS[status]}`;
      li.append(dot, name, val, sub);
      li.dataset.id = e.id;
      return li;
    });
    const list = $<HTMLUListElement>('#watch-list');
    // Only replace when content changed; clicks are handled by delegation (see bind) since rows are rebuilt as values arrive.
    const key = items.map((li) => li.textContent + li.className).join('|');
    if (list.dataset.key !== key) {
      list.dataset.key = key;
      list.replaceChildren(...items);
    }
    $<HTMLParagraphElement>('#watch-empty').hidden = rows.length > 0;
    $<HTMLSpanElement>('#counts').textContent = rows.length ? `경보 ${counts.alarm} · 주의 ${counts.warn} · 정상 ${counts.ok} · 없음 ${counts.offline}` : '';
  }

  /** Jumps to a watched object: switches floor, centres it, selects it and opens its card. */
  private focus(id: Id): void {
    const e = this.doc.entities.get(id);
    if (!e) return;
    const floor = this.doc.floorOf(e);
    if (floor && floor !== this.doc.activeFloor) {
      this.doc.activeFloor = floor;
      this.doc.changed();
    }
    this.selection.set([e.id]);
    const b = this.doc.bboxOf(e);
    this.view.centreOn({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
    this.render();
    this.inspect(e.id, this.view.toScreen({ x: b.maxX, y: b.maxY }));
  }

  private inspect(id: Id | null, at: { x: number; y: number }): void {
    this.inspected = id;
    const e = id ? this.doc.entities.get(id) : undefined;
    if (!e) {
      this.card.hidden = true;
      return;
    }
    this.refreshCard();
    this.card.hidden = false;
    const stage = this.canvas.parentElement!.getBoundingClientRect();
    this.card.style.left = `${Math.max(8, Math.min(at.x + 14, stage.width - this.card.offsetWidth - 8))}px`;
    this.card.style.top = `${Math.max(8, Math.min(at.y + 14, stage.height - this.card.offsetHeight - 8))}px`;
  }

  private refreshCard(): void {
    const e = this.inspected ? this.doc.entities.get(this.inspected) : undefined;
    if (!e) return;
    fillInspector(this.card, this.doc, e, 'mm', e.binding ? this.valueOf(e.binding) : undefined, () => {
      this.selection.clear();
      this.inspect(null, { x: 0, y: 0 });
    });
  }

  // ---------- UI ----------

  private refreshFloors(): void {
    const sel = $<HTMLSelectElement>('#floor-select');
    const floors = [...this.doc.floors.values()].sort((a, b) => b.elevation - a.elevation);
    sel.replaceChildren(...floors.map((f) => new Option(f.name, f.id, false, f.id === this.doc.activeFloor)));
  }

  private fit(): void {
    const ext = this.doc.extents();
    if (ext) this.view.fit(ext);
    this.render();
  }

  private resize(): void {
    const r = this.canvas.parentElement!.getBoundingClientRect();
    this.renderer.resize(r.width, r.height, window.devicePixelRatio || 1);
    this.render();
  }

  private pointer(e: PointerEvent): ToolPointer {
    const r = this.canvas.getBoundingClientRect();
    const screen = { x: e.clientX - r.left, y: e.clientY - r.top };
    const raw = this.view.toWorld(screen);
    return { screen, raw, world: raw, snap: null, button: e.button, shift: e.shiftKey, ctrl: false };
  }

  private bind(): void {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      if (e.button === 1) this.pan = { x: e.clientX, y: e.clientY };
      else this.tool.down(this.pointer(e));
    });
    c.addEventListener('pointermove', (e) => {
      if (this.pan) {
        this.view.panBy(e.clientX - this.pan.x, e.clientY - this.pan.y);
        this.pan = { x: e.clientX, y: e.clientY };
        this.render();
      } else this.tool.move(this.pointer(e));
    });
    c.addEventListener('pointerup', (e) => {
      if (this.pan) this.pan = null;
      else this.tool.up(this.pointer(e));
    });
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const r = c.getBoundingClientRect();
        const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        this.view.zoomAt({ x: e.clientX - r.left, y: e.clientY - r.top }, WHEEL_ZOOM_STEP ** -delta);
        this.render();
      },
      { passive: false },
    );
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.key.toLowerCase() === 'f') this.fit();
      if (e.key === 'Escape') this.tool.cancel();
    });
    const actions: Record<string, () => void> = {
      open: () => $<HTMLInputElement>('#file-input').click(),
      fit: () => this.fit(),
      connect: () => {
        if (this.source) return this.disconnect();
        const url = $<HTMLInputElement>('#source-url').value.trim();
        if (!url) return this.notify('데이터 주소를 입력하십시오. 서버 없이 보려면 "모의 데이터"를 누르십시오.');
        this.connect(url);
      },
      mock: () => {
        $<HTMLInputElement>('#source-url').value = 'mock';
        this.connect('mock');
      },
      'sidebar-min': () => this.sidebar.setState('collapsed'),
      'sidebar-max': () => this.sidebar.setState(this.sidebar.state === 'wide' ? 'normal' : 'wide'),
    };
    document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((b) => b.addEventListener('click', () => actions[b.dataset.action!]?.()));
    $<HTMLInputElement>('#file-input').addEventListener('change', async (e) => {
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      input.value = '';
      if (file) this.load(await file.text());
    });
    // pointerdown, not click: a row may be rebuilt between press and release when new values arrive.
    $<HTMLUListElement>('#watch-list').addEventListener('pointerdown', (e) => {
      const li = (e.target as HTMLElement).closest<HTMLLIElement>('li[data-id]');
      if (li) this.focus(li.dataset.id!);
    });
    $<HTMLSelectElement>('#floor-select').addEventListener('change', (e) => {
      this.doc.activeFloor = (e.target as HTMLSelectElement).value;
      this.selection.clear();
      this.inspect(null, { x: 0, y: 0 });
      this.doc.changed();
    });
  }

  private notify(text: string): void {
    const el = $<HTMLSpanElement>('#status-msg');
    el.textContent = text;
    window.setTimeout(() => el.textContent === text && (el.textContent = ''), 6000);
  }
}

const viewer = new ViewerApp();
Object.assign(window, { viewer });
showVersion($<HTMLElement>('#app-version'));
