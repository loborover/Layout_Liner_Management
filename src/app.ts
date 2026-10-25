import type { Vec2 } from './geom/vec';
import { FormatError, deserialize, serialize } from './io/serialize';
import { History } from './model/commands';
import { DocumentModel } from './model/document';
import { Selection } from './model/selection';
import { SpatialIndex } from './model/spatial';
import { SnapEngine, type SnapResult, type SnapSettings } from './snap/snap';
import type { Id } from './model/types';
import { CircleTool, DimensionTool, LineTool, RectTool } from './tools/draw';
import { MeasureAngleTool, MeasureAreaTool, MeasureDistanceTool } from './tools/measure';
import { SelectTool } from './tools/select';
import type { Tool, ToolContext, ToolPointer } from './tools/tool';
import { type DisplayUnit, formatLength } from './view/format';
import { Renderer } from './view/renderer';
import { Viewport, gridSpacing } from './view/viewport';

const AUTOSAVE_KEY = 'layout-liner:autosave';
const PICK_TOLERANCE_PX = 6;
const SNAP_REACH_PX = 10;
const WHEEL_ZOOM_STEP = 1.0015;

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`Missing element ${sel}`);
  return el;
};

export class App {
  readonly doc = new DocumentModel();
  readonly history = new History(this.doc);
  readonly selection = new Selection();
  readonly view = new Viewport();
  readonly index = new SpatialIndex(this.doc);
  readonly snapper = new SnapEngine(this.doc, this.index);
  private renderer: Renderer;
  private tools: Record<string, Tool>;
  private tool: Tool;
  private hover: Id | null = null;
  private unit: DisplayUnit = 'mm';
  private snapSettings: SnapSettings = { object: true, polar: true, grid: true, polarStep: 15 };
  private lastSnap: SnapResult | null = null;
  private pan: { last: Vec2 } | null = null;
  private spaceHeld = false;
  private frameRequested = false;
  private autosaveTimer: number | undefined;

  private canvas = $<HTMLCanvasElement>('#canvas');
  private hintEl = $<HTMLSpanElement>('#status-hint');
  private infoEl = $<HTMLSpanElement>('#status-info');
  private posEl = $<HTMLSpanElement>('#status-pos');

  constructor() {
    this.renderer = new Renderer(this.canvas, this.view, this.doc, this.index, this.selection);
    const ctx: ToolContext = {
      doc: this.doc,
      history: this.history,
      index: this.index,
      selection: this.selection,
      view: this.view,
      unit: () => this.unit,
      pickTolerance: () => this.view.pxToMm(PICK_TOLERANCE_PX),
      setHover: (id) => {
        if (id === this.hover) return;
        this.hover = id;
        this.requestRender();
      },
      setHint: (text) => (this.hintEl.textContent = text),
      requestRender: () => this.requestRender(),
    };
    this.tools = {
      select: new SelectTool(ctx),
      line: new LineTool(ctx),
      rect: new RectTool(ctx),
      circle: new CircleTool(ctx),
      dimension: new DimensionTool(ctx),
      'measure-distance': new MeasureDistanceTool(ctx),
      'measure-angle': new MeasureAngleTool(ctx),
      'measure-area': new MeasureAreaTool(ctx),
    };
    this.tool = this.tools.select;

    this.doc.onChange(() => {
      this.selection.prune((id) => this.doc.entities.has(id));
      this.scheduleAutosave();
      this.requestRender();
    });
    this.selection.onChange(() => this.requestRender());
    this.history.onChange(() => this.updateButtons());

    this.bindCanvas();
    this.bindToolbar();
    this.bindKeyboard();
    new ResizeObserver(() => this.resize()).observe(this.canvas.parentElement!);
    this.resize();
    this.view.centreOn({ x: 0, y: 0 });

    this.restoreAutosave();
    this.setTool('select');
    this.updateButtons();
  }

  setTool(id: string): void {
    const next = this.tools[id];
    if (!next) return;
    this.tool.cancel();
    this.tool.deactivate?.();
    this.tool = next;
    this.tool.activate?.();
    this.hover = null;
    this.canvas.style.cursor = next.cursor;
    this.hintEl.textContent = next.hint;
    document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.tool === id));
    });
    this.requestRender();
  }

  requestRender(): void {
    if (this.frameRequested) return;
    this.frameRequested = true;
    requestAnimationFrame(() => {
      this.frameRequested = false;
      const drawn = this.renderer.render({
        hover: this.hover,
        unit: this.unit,
        snap: this.lastSnap,
        overlay: (p) => this.tool.overlay?.(p),
      });
      const sel = this.selection.size ? ` · 선택 ${this.selection.size}` : '';
      this.infoEl.textContent = `객체 ${this.doc.entities.size} (표시 ${drawn})${sel} · 그리드 ${formatLength(gridSpacing(this.view.scale).minor, this.unit)}`;
    });
  }

  fitAll(): void {
    const ext = this.doc.extents();
    if (ext) this.view.fit(ext);
    else {
      this.view.scale = 0.1;
      this.view.centreOn({ x: 0, y: 0 });
    }
    this.requestRender();
  }

  private resize(): void {
    const r = this.canvas.parentElement!.getBoundingClientRect();
    this.renderer.resize(r.width, r.height, window.devicePixelRatio || 1);
    this.requestRender();
  }

  private pointer(e: PointerEvent | MouseEvent): ToolPointer {
    const r = this.canvas.getBoundingClientRect();
    const screen = { x: e.clientX - r.left, y: e.clientY - r.top };
    const raw = this.view.toWorld(screen);
    const q = this.tool.snapQuery?.() ?? {};
    const snap = this.snapper.snap(
      raw,
      this.view.pxToMm(SNAP_REACH_PX),
      gridSpacing(this.view.scale).minor,
      this.snapSettings,
      { ...q, ortho: e.shiftKey && !!q.from },
    );
    return { screen, raw, world: snap?.point ?? raw, snap, button: e.button, shift: e.shiftKey };
  }

  private bindCanvas(): void {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      if (e.button === 1 || (e.button === 0 && this.spaceHeld)) {
        e.preventDefault();
        this.pan = { last: { x: e.clientX, y: e.clientY } };
        c.style.cursor = 'grabbing';
        return;
      }
      this.tool.down(this.pointer(e));
    });
    c.addEventListener('pointerleave', () => {
      this.lastSnap = null;
      this.requestRender();
    });
    c.addEventListener('pointermove', (e) => {
      if (this.pan) {
        this.view.panBy(e.clientX - this.pan.last.x, e.clientY - this.pan.last.y);
        this.pan.last = { x: e.clientX, y: e.clientY };
        this.requestRender();
        return;
      }
      const p = this.pointer(e);
      this.setSnap(p.snap);
      this.posEl.textContent = `X ${formatLength(p.world.x, this.unit)}  Y ${formatLength(p.world.y, this.unit)}`;
      this.tool.move(p);
    });
    c.addEventListener('pointerup', (e) => {
      if (this.pan) {
        this.pan = null;
        c.style.cursor = this.spaceHeld ? 'grab' : this.tool.cursor;
        return;
      }
      this.tool.up(this.pointer(e));
    });
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const r = c.getBoundingClientRect();
        const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        this.view.zoomAt({ x: e.clientX - r.left, y: e.clientY - r.top }, WHEEL_ZOOM_STEP ** -delta);
        this.requestRender();
      },
      { passive: false },
    );
  }

  private bindToolbar(): void {
    document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => {
      b.addEventListener('click', () => this.setTool(b.dataset.tool!));
    });
    const actions: Record<string, () => void> = {
      undo: () => this.undo(),
      redo: () => this.redo(),
      fit: () => this.fitAll(),
      new: () => this.newDrawing(),
      open: () => $<HTMLInputElement>('#file-input').click(),
      save: () => this.save(),
    };
    document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((b) => {
      b.addEventListener('click', () => actions[b.dataset.action!]?.());
    });
    $<HTMLInputElement>('#file-input').addEventListener('change', async (e) => {
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      input.value = '';
      if (file) this.openText(await file.text());
    });
    for (const [sel, key] of [
      ['#snap-object', 'object'],
      ['#snap-polar', 'polar'],
      ['#snap-grid', 'grid'],
    ] as const) {
      const box = $<HTMLInputElement>(sel);
      box.checked = this.snapSettings[key];
      box.addEventListener('change', () => (this.snapSettings[key] = box.checked));
    }
    const unit = $<HTMLSelectElement>('#unit');
    unit.addEventListener('change', () => {
      this.unit = unit.value as DisplayUnit;
      this.requestRender();
    });
  }

  private bindKeyboard(): void {
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
      } else if (mod && key === 'y') {
        e.preventDefault();
        this.redo();
      } else if (mod && key === 's') {
        e.preventDefault();
        this.save();
      } else if (mod && key === 'o') {
        e.preventDefault();
        $<HTMLInputElement>('#file-input').click();
      } else if (mod) {
        return;
      } else if (e.key === 'Escape') {
        if (!this.tool.cancel() && this.tool !== this.tools.select) this.setTool('select');
      } else if (e.key === ' ') {
        e.preventDefault();
        if (!this.spaceHeld) {
          this.spaceHeld = true;
          this.canvas.style.cursor = 'grab';
        }
      } else if (e.key === 'F3' || e.key === 'F9' || e.key === 'F10') {
        e.preventDefault();
        const key = e.key === 'F3' ? 'object' : e.key === 'F9' ? 'grid' : 'polar';
        this.snapSettings[key] = !this.snapSettings[key];
        $<HTMLInputElement>(`#snap-${key}`).checked = this.snapSettings[key];
      } else if (this.tool.key?.(e)) {
        e.preventDefault();
      } else {
        const shortcuts: Record<string, () => void> = {
          v: () => this.setTool('select'),
          l: () => this.setTool('line'),
          r: () => this.setTool('rect'),
          c: () => this.setTool('circle'),
          d: () => this.setTool('dimension'),
          m: () => this.setTool('measure-distance'),
          n: () => this.setTool('measure-angle'),
          a: () => this.setTool('measure-area'),
          f: () => this.fitAll(),
        };
        shortcuts[key]?.();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === ' ') {
        this.spaceHeld = false;
        if (!this.pan) this.canvas.style.cursor = this.tool.cursor;
      }
    });
  }

  // A live drag must not straddle an undo: its preview would be recorded against changed geometry.
  private undo(): void {
    this.tool.interrupt?.();
    this.history.undo();
  }

  private redo(): void {
    this.tool.interrupt?.();
    this.history.redo();
  }

  private setSnap(snap: SnapResult | null): void {
    const same =
      snap?.kind === this.lastSnap?.kind &&
      snap?.point.x === this.lastSnap?.point.x &&
      snap?.point.y === this.lastSnap?.point.y;
    this.lastSnap = snap;
    if (!same) this.requestRender();
  }

  private updateButtons(): void {
    $<HTMLButtonElement>('[data-action="undo"]').disabled = !this.history.canUndo;
    $<HTMLButtonElement>('[data-action="redo"]').disabled = !this.history.canRedo;
  }

  private newDrawing(): void {
    if (this.doc.entities.size > 0 && !confirm('현재 도면을 지우고 새로 시작하시겠습니까? (저장하지 않은 내용은 사라집니다)')) return;
    this.tool.cancel();
    this.selection.clear();
    this.doc.reset();
    this.history.clear();
    this.fitAll();
  }

  private save(): void {
    const blob = new Blob([serialize(this.doc.toData())], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `layout-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  private openText(text: string): void {
    try {
      const data = deserialize(text);
      this.tool.cancel();
      this.selection.clear();
      this.doc.load(data);
      this.history.clear();
      this.fitAll();
    } catch (err) {
      alert(err instanceof FormatError ? `파일을 열 수 없습니다: ${err.message}` : `파일을 열 수 없습니다: ${String(err)}`);
    }
  }

  private scheduleAutosave(): void {
    window.clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(AUTOSAVE_KEY, serialize(this.doc.toData()));
      } catch {
        // Storage can be unavailable (private mode, quota); autosave is a convenience only.
      }
    }, 500);
  }

  private restoreAutosave(): void {
    let text: string | null = null;
    try {
      text = localStorage.getItem(AUTOSAVE_KEY);
    } catch {
      return;
    }
    if (!text) return;
    try {
      this.doc.load(deserialize(text));
      this.fitAll();
    } catch {
      // A corrupt autosave should never block the app from starting.
    }
  }
}
