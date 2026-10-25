import type { Vec2 } from './geom/vec';
import { FormatError, deserialize, serialize } from './io/serialize';
import { hasConstraints } from './constraints/components';
import { type ClusterStatus, ConstraintService } from './constraints/service';
import { Batch, type Command, History, RemoveConstraints, SetDimensionValue } from './model/commands';
import { DocumentModel } from './model/document';
import { arrayOffsets, copyItems, moveToLayer, rotateItems } from './model/edit';
import { equipmentCsv } from './io/equipmentList';
import { EquipmentTool } from './tools/equipment';
import { SidePanel } from './ui/panel';
import { Selection } from './model/selection';
import { SpatialIndex } from './model/spatial';
import { SnapEngine, type SnapResult, type SnapSettings } from './snap/snap';
import { type ConstraintKind, DEFAULT_LAYER_ID, type Id } from './model/types';
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
  readonly constraints = new ConstraintService(this.doc, this.history);
  private constraintStatus: ClusterStatus | null = null;
  private statusTimer: number | undefined;
  private messageTimer: number | undefined;
  private renderer: Renderer;
  private tools: Record<string, Tool>;
  private tool: Tool;
  private hover: Id | null = null;
  private currentLayer: Id = DEFAULT_LAYER_ID;
  private panel: SidePanel;
  private equipmentTool: EquipmentTool;
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
  private msgEl = $<HTMLSpanElement>('#status-msg');

  constructor() {
    this.renderer = new Renderer(this.canvas, this.view, this.doc, this.index, this.selection);
    const ctx: ToolContext = {
      doc: this.doc,
      history: this.history,
      index: this.index,
      selection: this.selection,
      view: this.view,
      unit: () => this.unit,
      layer: () => this.layerForDrawing(),
      pickTolerance: () => this.view.pxToMm(PICK_TOLERANCE_PX),
      setHover: (id) => {
        if (id === this.hover) return;
        this.hover = id;
        this.requestRender();
      },
      setHint: (text) => (this.hintEl.textContent = text),
      constraints: this.constraints,
      notify: (text) => this.notify(text),
      ask: (question, initial) => window.prompt(question, initial),
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
      equipment: (this.equipmentTool = new EquipmentTool(ctx)),
    };
    this.panel = new SidePanel(
      {
        doc: this.doc,
        history: this.history,
        currentLayer: () => this.layerForDrawing(),
        setCurrentLayer: (id) => {
          this.currentLayer = id;
          this.panel.refresh();
        },
        activeType: () => (this.tool === this.equipmentTool ? this.equipmentTool.typeId : null),
        placeEquipment: (type) => {
          this.equipmentTool.setType(type);
          this.setTool('equipment');
        },
        notify: (text) => this.notify(text),
        ask: (question, initial) => window.prompt(question, initial),
      },
      $<HTMLUListElement>('#layer-list'),
      $<HTMLUListElement>('#type-list'),
    );
    this.tool = this.tools.select;

    this.doc.onChange(() => {
      // Hidden or locked geometry can't stay selected: it could otherwise still be moved or deleted.
      this.selection.prune((id) => {
        const e = this.doc.entities.get(id);
        return !!e && this.doc.isEditable(e);
      });
      this.panel.refresh();
      this.scheduleAutosave();
      this.scheduleConstraintStatus();
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
    this.panel?.refresh();
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
        fullyConstrained: this.constraintStatus?.fullyConstrained,
        overlay: (p) => this.tool.overlay?.(p),
      });
      const sel = this.selection.size ? ` · 선택 ${this.selection.size}` : '';
      const cs = this.constraintStatus;
      const dof = cs && cs.clusters > 0 ? ` · 구속 자유도 ${cs.dof}${cs.dof === 0 ? ' (완전 구속)' : ''}` : '';
      this.infoEl.textContent = `객체 ${this.doc.entities.size} (표시 ${drawn})${sel}${dof} · 그리드 ${formatLength(gridSpacing(this.view.scale).minor, this.unit)}`;
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
    c.addEventListener('dblclick', (e) => this.tool.doubleClick?.(this.pointer(e)));
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
      unconstrain: () => this.unconstrain(),
      rotate: () => this.rotateSelection(),
      array: () => this.arraySelection(),
      'to-layer': () => this.selectionToLayer(),
      'add-layer': () => this.panel.addLayer(),
      'add-type': () => this.panel.addType(),
      'export-equipment': () => this.exportEquipment(),
    };
    document.querySelectorAll<HTMLButtonElement>('[data-constraint]').forEach((b) => {
      b.addEventListener('click', () => void this.applyConstraint(b.dataset.constraint as ConstraintKind));
    });
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
      // Typing into a field must not trigger shortcuts; a clicked checkbox, radio or colour swatch should not swallow them.
      const t = e.target;
      const typing = t instanceof HTMLInputElement && !['checkbox', 'radio', 'color'].includes(t.type);
      if (typing || t instanceof HTMLSelectElement) return;
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
          e: () => this.setTool('equipment'),
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

  /** Current layer, falling back to the first one if it was deleted (e.g. by undo or opening a file). */
  private layerForDrawing(): Id {
    if (!this.doc.layers.has(this.currentLayer)) this.currentLayer = this.doc.layers.keys().next().value ?? DEFAULT_LAYER_ID;
    return this.currentLayer;
  }

  private rotateSelection(): void {
    const ids = this.selection.values();
    if (ids.length === 0) return this.notify('회전할 객체를 선택하십시오.');
    const cmd = rotateItems(this.doc, ids, 90);
    if (typeof cmd === 'string') this.notify(cmd);
    else if (cmd) this.history.execute(cmd);
  }

  /** Rectangular array of the selection; the original stays as the first item. */
  private arraySelection(): void {
    const ids = this.selection.values();
    if (ids.length === 0) return this.notify('배열 복사할 객체를 선택하십시오.');
    const boxes = ids.flatMap((id) => {
      const e = this.doc.entities.get(id);
      return e ? [this.doc.bboxOf(e)] : [];
    });
    const w = Math.max(...boxes.map((b) => b.maxX)) - Math.min(...boxes.map((b) => b.minX));
    const h = Math.max(...boxes.map((b) => b.maxY)) - Math.min(...boxes.map((b) => b.minY));
    const round = (v: number) => Math.ceil((v + 500) / 100) * 100;
    const text = window.prompt(
      '배열 복사: 열 수, 행 수, 열 간격(mm), 행 간격(mm)\n간격은 중심 사이 거리이며, 음수면 왼쪽/아래로 복사합니다.',
      `3, 1, ${round(w)}, ${round(h)}`,
    );
    if (text === null) return;
    const [cols, rows, dx, dy] = text.split(',').map((v) => Number(v.trim()));
    const valid = [cols, rows].every((n) => Number.isInteger(n) && n >= 1) && cols * rows <= 1000 && [dx, dy].every(Number.isFinite);
    if (!valid || cols * rows < 2) {
      return this.notify('형식: 열 수, 행 수, 열 간격, 행 간격 (예: 3, 2, 2500, 1500). 열×행은 2 이상 1000 이하입니다.');
    }
    const cmd = copyItems(this.doc, ids, arrayOffsets(cols, rows, dx, dy ?? 0));
    if (cmd) this.history.execute(cmd);
  }

  private selectionToLayer(): void {
    const ids = this.selection.values();
    if (ids.length === 0) return this.notify('현재 레이어로 옮길 객체를 선택하십시오.');
    const cmd = moveToLayer(this.doc, ids, this.layerForDrawing());
    if (cmd) this.history.execute(cmd);
  }

  private exportEquipment(): void {
    if (![...this.doc.entities.values()].some((e) => e.kind === 'equipment')) return this.notify('배치된 설비가 없습니다.');
    this.download(new Blob([equipmentCsv(this.doc)], { type: 'text/csv' }), `equipment-${new Date().toISOString().slice(0, 10)}.csv`);
  }

  private download(blob: Blob, name: string): void {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /** Applies a constraint to the current selection. */
  private async applyConstraint(kind: ConstraintKind): Promise<void> {
    const selected = this.selection.values().flatMap((id) => {
      const e = this.doc.entities.get(id);
      return e ? [e] : [];
    });
    const lines = selected.filter((e) => e.kind === 'line').map((e) => e.id);
    const circles = selected.filter((e) => e.kind === 'circle').map((e) => e.id);
    let refs: Id[][] = [];
    switch (kind) {
      case 'horizontal':
      case 'vertical':
        if (lines.length === 0) return this.notify('선을 하나 이상 선택하십시오.');
        refs = lines.map((l) => [l]);
        break;
      case 'parallel':
      case 'perpendicular':
        if (lines.length !== 2) return this.notify('선 두 개를 선택하십시오.');
        refs = [lines];
        break;
      case 'equal': {
        const group = lines.length >= 2 ? lines : circles;
        if (group.length < 2 || (lines.length > 0 && circles.length > 0)) {
          return this.notify('같은 종류(선끼리 또는 원끼리)를 두 개 이상 선택하십시오.');
        }
        refs = group.slice(1).map((id) => [group[0], id]);
        break;
      }
      case 'fixed': {
        const points = [...new Set(selected.filter((e) => e.kind !== 'dimension').flatMap((e) => this.doc.pointIdsOf(e)))];
        if (points.length === 0) return this.notify('고정할 선이나 원을 선택하십시오.');
        refs = [points];
        break;
      }
      default:
        return;
    }
    try {
      const r = await this.constraints.add(kind, refs);
      if (!r.ok) this.notify(r.message);
    } catch (err) {
      this.notify(`구속 솔버를 불러오지 못했습니다: ${String(err)}`);
    }
  }

  /** Removes constraints on the selected geometry and turns selected driving dimensions into reference ones. */
  private unconstrain(): void {
    const ids = this.selection.values();
    if (ids.length === 0) return this.notify('구속을 해제할 객체를 선택하십시오.');
    const pointIds = ids.flatMap((id) => {
      const e = this.doc.entities.get(id);
      return e && e.kind !== 'dimension' ? this.doc.pointIdsOf(e) : [];
    });
    const steps: Command[] = [];
    const constraints = this.doc.constraintsOn([...ids, ...pointIds]);
    if (constraints.length > 0) steps.push(new RemoveConstraints(constraints.map((c) => c.id)));
    for (const id of ids) {
      const e = this.doc.entities.get(id);
      if (e?.kind === 'dimension' && e.value !== undefined) steps.push(new SetDimensionValue(id, e.value, undefined));
    }
    if (steps.length === 0) return this.notify('선택한 객체에 구속이 없습니다.');
    this.history.execute(new Batch('구속 해제', steps));
  }

  private notify(text: string): void {
    this.msgEl.textContent = text;
    window.clearTimeout(this.messageTimer);
    this.messageTimer = window.setTimeout(() => (this.msgEl.textContent = ''), 5000);
  }

  private scheduleConstraintStatus(): void {
    window.clearTimeout(this.statusTimer);
    if (!hasConstraints(this.doc)) {
      this.constraintStatus = null;
      return;
    }
    this.statusTimer = window.setTimeout(() => {
      this.constraints
        .ensure()
        .then(() => {
          this.constraintStatus = this.constraints.status();
          this.requestRender();
        })
        .catch((err) => this.notify(`구속 솔버를 불러오지 못했습니다: ${String(err)}`));
    }, 120);
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
    this.download(blob, `layout-${new Date().toISOString().slice(0, 10)}.json`);
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
