import type { Vec2 } from './geom/vec';
import { FormatError, deserialize, serialize } from './io/serialize';
import { History } from './model/commands';
import { DocumentModel } from './model/document';
import { Selection } from './model/selection';
import { SpatialIndex } from './model/spatial';
import type { Id } from './model/types';
import { CircleTool, LineTool, RectTool } from './tools/draw';
import { SelectTool } from './tools/select';
import type { Tool, ToolContext, ToolPointer } from './tools/tool';
import { type DisplayUnit, formatLength } from './view/format';
import { Renderer } from './view/renderer';
import { Viewport, gridSpacing, snapToGrid } from './view/viewport';

const AUTOSAVE_KEY = 'layout-liner:autosave';
const PICK_TOLERANCE_PX = 6;
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
  private renderer: Renderer;
  private tools: Record<string, Tool>;
  private tool: Tool;
  private hover: Id | null = null;
  private unit: DisplayUnit = 'mm';
  private gridSnap = true;
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
      const drawn = this.renderer.render({ hover: this.hover, overlay: (p) => this.tool.overlay?.(p) });
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
    const world = this.gridSnap ? snapToGrid(raw, gridSpacing(this.view.scale).minor) : raw;
    return { screen, raw, world, button: e.button, shift: e.shiftKey };
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
    c.addEventListener('pointermove', (e) => {
      const p = this.pointer(e);
      this.posEl.textContent = `X ${formatLength(p.world.x, this.unit)}  Y ${formatLength(p.world.y, this.unit)}`;
      if (this.pan) {
        this.view.panBy(e.clientX - this.pan.last.x, e.clientY - this.pan.last.y);
        this.pan.last = { x: e.clientX, y: e.clientY };
        this.requestRender();
        return;
      }
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
    const snap = $<HTMLInputElement>('#grid-snap');
    snap.addEventListener('change', () => (this.gridSnap = snap.checked));
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
      } else if (e.key === 'F9') {
        e.preventDefault();
        const snap = $<HTMLInputElement>('#grid-snap');
        snap.checked = !snap.checked;
        this.gridSnap = snap.checked;
      } else if (this.tool.key?.(e)) {
        e.preventDefault();
      } else {
        const shortcuts: Record<string, () => void> = {
          v: () => this.setTool('select'),
          l: () => this.setTool('line'),
          r: () => this.setTool('rect'),
          c: () => this.setTool('circle'),
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
