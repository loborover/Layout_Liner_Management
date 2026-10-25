/**
 * @file app.ts
 *
 * Editor application shell. Owns the document, history, selection, viewport, spatial index, snap engine,
 * constraint service, tools and the editing API, and wires them to the DOM: canvas events, quick bar and ribbon
 * buttons (data-tool / data-action / data-constraint / data-preset attributes in index.html), keyboard shortcuts,
 * side bar (object tree, properties, library, underlay), status bar, autosave and the MCP live bridge.
 * Start here to find where a user action enters the system.
 *
 * Modes: 'edit' (all tools) and 'view' (InspectTool only: look, pan, click for information; nothing can change).
 * `?mode=view` in the URL opens in viewer mode.
 * Related: src/tools/* (pointer interaction), src/model/commands.ts (every undoable edit), src/view/renderer.ts,
 * src/api/editorApi.ts (scripted/AI edits).
 */
import type { Box, Vec2 } from './geom/vec';
import { FormatError, deserialize, serialize } from './io/serialize';
import { hasConstraints } from './constraints/components';
import { type ClusterStatus, ConstraintService } from './constraints/service';
import { Batch, type Command, History, RemoveConstraints, RemoveEntities, SetDimensionValue, SetUnderlay, UpdateEntities } from './model/commands';
import { DocumentModel, cloneEntity } from './model/document';
import { arrayOffsets, copyItems, makeShapes, moveToLayer, type ReorderMove, reorderItems, rotateItems, deletionTargets } from './model/edit';
import { EditorApi } from './api/editorApi';
import { METHODS, dispatch } from './api/rpc';
import { BridgeClient } from './api/bridge';
import { InspectTool } from './tools/inspect';
import { Ribbon } from './ui/ribbon';
import { Sidebar } from './ui/sidebar';
import { ObjectTree } from './ui/tree';
import { PropertyPanel } from './ui/properties';
import { fillInspector } from './ui/inspector';
import { hydrateIcons } from './ui/icons';
import type { LiveValue, Mode, UiHost } from './ui/host';
import { equipmentCsv } from './io/equipmentList';
import { DxfError, parseDxf } from './io/dxf';
import { writeDxf } from './io/dxfExport';
import { importDxf } from './io/dxfImport';
import { drawingSvg } from './io/svg';
import { UnderlayTool } from './tools/underlay';
import { EquipmentTool } from './tools/equipment';
import { Library } from './ui/library';
import { Selection } from './model/selection';
import { SpatialIndex } from './model/spatial';
import { SnapEngine, type SnapResult, type SnapSettings } from './snap/snap';
import { type ConstraintKind, DEFAULT_LAYER_ID, type Id, type StrokeStyle, type Underlay } from './model/types';
import { CircleTool, DimensionTool, LineTool, RectTool } from './tools/draw';
import { MeasureAngleTool, MeasureAreaTool, MeasureDistanceTool } from './tools/measure';
import { SelectTool } from './tools/select';
import type { Tool, ToolContext, ToolPointer } from './tools/tool';
import { type DisplayUnit, formatLength } from './view/format';
import { type EntityStatus, Renderer } from './view/renderer';
import { Viewport, gridSpacing } from './view/viewport';
import { STATUS } from './theme';

const AUTOSAVE_KEY = 'layout-liner:autosave';
const PICK_TOLERANCE_PX = 6;
const SNAP_REACH_PX = 10;
const WHEEL_ZOOM_STEP = 1.0015;
/** Tools that create geometry on the current layer. */
const DRAWING_TOOLS = new Set(['line', 'rect', 'circle', 'dimension', 'equipment']);
/** Monitoring status → fill colour (docs/VIEWER.md). */
const STATUS_COLORS: Record<string, string> = STATUS;

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`Missing element ${sel}`);
  return el;
};

export class App implements UiHost {
  readonly doc = new DocumentModel();
  readonly history = new History(this.doc);
  readonly selection = new Selection();
  readonly view = new Viewport();
  readonly index = new SpatialIndex(this.doc);
  readonly snapper = new SnapEngine(this.doc, this.index);
  readonly constraints = new ConstraintService(this.doc, this.history);
  /** Scripted/AI editing API; also exposed as window.layoutLiner (src/main.ts). */
  readonly api: EditorApi;
  /** Live monitoring values by binding key, fed by a data source (the viewer app uses the same shape). */
  readonly liveValues = new Map<string, LiveValue>();
  private constraintStatus: ClusterStatus | null = null;
  private statusTimer: number | undefined;
  private messageTimer: number | undefined;
  private renderer: Renderer;
  private tools: Record<string, Tool>;
  private tool: Tool;
  private hover: Id | null = null;
  private currentLayerId: Id = DEFAULT_LAYER_ID;
  private library: Library;
  private tree: ObjectTree;
  private props: PropertyPanel;
  private ribbon: Ribbon;
  private sidebar: Sidebar;
  private bridge: BridgeClient;
  private equipmentTool: EquipmentTool;
  private displayUnit: DisplayUnit = 'mm';
  private currentMode: Mode = 'edit';
  private inspected: Id | null = null;
  private snapSettings: SnapSettings = { object: true, polar: true, grid: true, polarStep: 15 };
  private lastSnap: SnapResult | null = null;
  private pan: { last: Vec2 } | null = null;
  private spaceHeld = false;
  private frameRequested = false;
  private autosaveTimer: number | undefined;
  private underlayAutosaveWarned = false;

  private canvas = $<HTMLCanvasElement>('#canvas');
  private hintEl = $<HTMLSpanElement>('#status-hint');
  private infoEl = $<HTMLSpanElement>('#status-info');
  private posEl = $<HTMLSpanElement>('#status-pos');
  private msgEl = $<HTMLSpanElement>('#status-msg');
  private inspectorEl = $<HTMLDivElement>('#inspector');

  constructor() {
    hydrateIcons();
    this.renderer = new Renderer(this.canvas, this.view, this.doc, this.index, this.selection);
    this.renderer.onImageLoad = () => this.requestRender();
    this.api = new EditorApi(this.doc, this.history, { currentLayer: () => this.currentLayer() });
    const ctx: ToolContext = {
      doc: this.doc,
      history: this.history,
      index: this.index,
      selection: this.selection,
      view: this.view,
      unit: () => this.displayUnit,
      layer: () => this.currentLayer(),
      lineStyle: () => this.newLineStyle(),
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
      underlay: new UnderlayTool(ctx),
      inspect: new InspectTool(ctx, (id, at) => this.showInspector(id, at)),
    };
    this.library = new Library(this, $<HTMLUListElement>('#type-list'));
    this.tree = new ObjectTree(this, $<HTMLDivElement>('#tree'));
    this.props = new PropertyPanel(this, $<HTMLDivElement>('#props'));
    this.ribbon = new Ribbon($<HTMLElement>('.ribbon'));
    this.sidebar = new Sidebar($<HTMLElement>('.sidebar'), () => this.resize());
    this.bridge = new BridgeClient(
      this.api,
      (state, detail) => this.bridgeState(state, detail),
      (method) => METHODS[method]?.mutates && this.notify(`AI가 실행함: ${method}`),
    );
    this.tool = this.tools.select;

    this.doc.onChange(() => {
      // Hidden or locked geometry can't stay selected: it could otherwise still be moved or deleted.
      this.selection.prune((id) => {
        const view = this.currentMode === 'view';
        if (this.doc.points.has(id)) return view ? this.doc.isPointVisible(id) : this.doc.isPointEditable(id);
        const e = this.doc.entities.get(id);
        return !!e && (view ? this.doc.isVisible(e) : this.doc.isEditable(e));
      });
      this.refreshPanels();
      this.refreshInspector();
      this.refreshUnderlayControls();
      this.refreshFloorSelect();
      this.scheduleAutosave();
      this.scheduleConstraintStatus();
      this.requestRender();
    });
    this.selection.onChange(() => {
      this.tree.refresh();
      this.props.refresh();
      // Selecting from the tree should show the selection's properties when the bar shows nothing else useful.
      this.requestRender();
    });
    this.history.onChange(() => this.updateButtons());

    this.bindCanvas();
    this.bindToolbar();
    this.bindKeyboard();
    new ResizeObserver(() => this.resize()).observe(this.canvas.parentElement!);
    this.resize();
    this.view.centreOn({ x: 0, y: 0 });

    this.restoreAutosave();
    this.refreshFloorSelect();
    this.refreshPanels();
    this.tree.render();
    this.props.render();
    this.setMode(new URLSearchParams(location.search).get('mode') === 'view' ? 'view' : 'edit');
    this.updateButtons();
  }

  // ---------- UiHost ----------

  mode(): Mode {
    return this.currentMode;
  }

  unit(): DisplayUnit {
    return this.displayUnit;
  }

  setPoint(id: Id, to: { x: number; y: number; z?: number }): void {
    if (this.currentMode !== 'edit') return this.notify('뷰어 모드에서는 편집할 수 없습니다.');
    void this.constraints.setPoint(id, to).then((r) => {
      if (!r.ok) this.notify(r.message);
    });
  }

  /** Current layer, falling back to the first layer of the active floor (e.g. after undo, opening a file or a floor change). */
  currentLayer(): Id {
    const layer = this.doc.layers.get(this.currentLayerId);
    if (!layer || layer.floor !== this.doc.activeFloor) {
      this.currentLayerId = [...this.doc.layers.values()].find((l) => l.floor === this.doc.activeFloor)?.id ?? this.doc.layers.keys().next().value ?? DEFAULT_LAYER_ID;
    }
    return this.currentLayerId;
  }

  setCurrentLayer(id: Id): void {
    this.currentLayerId = id;
    this.refreshPanels();
  }

  setFloor(id: Id): void {
    if (!this.doc.floors.has(id) || id === this.doc.activeFloor) return;
    this.tool.cancel();
    this.selection.clear();
    this.showInspector(null, { x: 0, y: 0 });
    this.doc.activeFloor = id;
    this.doc.changed();
  }

  activeType(): Id | null {
    return this.tool === this.equipmentTool ? this.equipmentTool.typeId : null;
  }

  placeEquipment(type: Id): void {
    if (this.currentMode !== 'edit') return;
    this.equipmentTool.setType(type);
    this.setTool('equipment');
  }

  zoomTo(ids: Id[]): void {
    let box: Box | null = null;
    for (const id of ids) {
      const e = this.doc.entities.get(id);
      if (!e) continue;
      const b = this.doc.bboxOf(e);
      box = box ? { minX: Math.min(box.minX, b.minX), minY: Math.min(box.minY, b.minY), maxX: Math.max(box.maxX, b.maxX), maxY: Math.max(box.maxY, b.maxY) } : b;
    }
    if (!box) return;
    const pad = Math.max(box.maxX - box.minX, box.maxY - box.minY, 1000) * 0.5;
    this.view.fit({ minX: box.minX - pad, minY: box.minY - pad, maxX: box.maxX + pad, maxY: box.maxY + pad });
    this.requestRender();
  }

  live(binding: string): LiveValue | undefined {
    return this.liveValues.get(binding);
  }

  ask(question: string, initial: string): string | null {
    return window.prompt(question, initial);
  }

  confirm(question: string): boolean {
    return window.confirm(question);
  }

  /** Runs an API method by name (same as the MCP tools); throws ApiError on invalid input. */
  call(method: string, params: Record<string, unknown> = {}): unknown {
    if (this.currentMode !== 'edit' && METHODS[method]?.mutates) throw new Error('뷰어 모드에서는 도면을 바꿀 수 없습니다. 편집 모드로 바꾸십시오.');
    this.tool.interrupt?.();
    return dispatch(this.api, method, params);
  }

  // ---------- modes and tools ----------

  /** Switches between editing and viewing. Viewer mode can't change the drawing. */
  setMode(mode: Mode): void {
    this.currentMode = mode;
    document.body.classList.toggle('mode-view', mode === 'view');
    document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
    $<HTMLSpanElement>('#status-mode').textContent = mode === 'view' ? '뷰어 모드' : '편집 모드';
    this.showInspector(null, { x: 0, y: 0 });
    this.selection.clear();
    if (mode === 'view' && this.bridge.state !== 'closed') this.bridge.disconnect();
    this.setTool(mode === 'view' ? 'inspect' : 'select');
    this.ribbon.refresh();
    this.refreshPanels();
    this.tree.render();
    this.props.render();
    const url = new URL(location.href);
    if (mode === 'view') url.searchParams.set('mode', 'view');
    else url.searchParams.delete('mode');
    history.replaceState(null, '', url);
  }

  setTool(id: string): void {
    const next = this.tools[id];
    if (!next) return;
    // Viewer mode only inspects and measures; editing tools stay out of reach.
    if (this.currentMode === 'view' && !['inspect', 'measure-distance', 'measure-angle', 'measure-area'].includes(id)) return;
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
    this.library?.refresh();
    this.requestRender();
  }

  requestRender(): void {
    if (this.frameRequested) return;
    this.frameRequested = true;
    requestAnimationFrame(() => {
      this.frameRequested = false;
      const drawn = this.renderer.render({
        hover: this.hover,
        unit: this.displayUnit,
        snap: this.currentMode === 'edit' ? this.lastSnap : null,
        fullyConstrained: this.constraintStatus?.fullyConstrained,
        status: this.liveStatus(),
        clean: this.currentMode === 'view',
        overlay: (p) => this.tool.overlay?.(p),
      });
      const sel = this.selection.size ? ` · 선택 ${this.selection.size}` : '';
      const cs = this.constraintStatus;
      const dof = cs && cs.clusters > 0 ? ` · 구속 자유도 ${cs.dof}${cs.dof === 0 ? ' (완전 구속)' : ''}` : '';
      const floor = this.doc.floors.get(this.doc.activeFloor)?.name ?? '';
      this.infoEl.textContent = `${floor} · 객체 ${drawn}/${this.doc.entities.size}${sel}${dof} · 그리드 ${formatLength(gridSpacing(this.view.scale).minor, this.displayUnit)}`;
    });
  }

  /** Render colours for entities with a live value (status ok/warn/alarm/offline). */
  private liveStatus(): Map<Id, EntityStatus> | undefined {
    if (this.liveValues.size === 0) return undefined;
    const out = new Map<Id, EntityStatus>();
    for (const e of this.doc.entities.values()) {
      const v = e.binding ? this.liveValues.get(e.binding) : undefined;
      if (v) out.set(e.id, { color: STATUS_COLORS[v.status ?? 'ok'] ?? STATUS_COLORS.ok, text: `${String(v.value)}${v.unit ? ` ${v.unit}` : ''}` });
    }
    return out;
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

  private refreshPanels(): void {
    this.library?.refresh();
    this.tree?.refresh();
    this.props?.refresh();
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
    const ctrl = e.ctrlKey || e.metaKey;
    const snap =
      this.currentMode === 'edit' || this.tool.id.startsWith('measure')
        ? this.snapper.snap(raw, this.view.pxToMm(SNAP_REACH_PX), gridSpacing(this.view.scale).minor, this.snapSettings, {
            ...q,
            ortho: e.shiftKey && !!q.from,
            pointsOnly: ctrl,
          })
        : null;
    return { screen, raw, world: snap?.point ?? raw, snap, button: e.button, shift: e.shiftKey, ctrl };
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
      if (DRAWING_TOOLS.has(this.tool.id) && e.button === 0 && !this.doc.isLayerEditable(this.currentLayer())) {
        // Geometry drawn there would be invisible or impossible to select, so don't create it.
        const layer = this.doc.layers.get(this.currentLayer());
        this.notify(`현재 레이어(${layer?.name ?? ''})나 그 폴더가 잠겨 있거나 숨겨져 있어 그릴 수 없습니다.`);
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
      this.posEl.textContent = `X ${formatLength(p.world.x, this.displayUnit)}  Y ${formatLength(p.world.y, this.displayUnit)}`;
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

  /** Runs an editing action only in edit mode. */
  private edit(fn: () => void): () => void {
    return () => {
      if (this.currentMode !== 'edit') return this.notify('뷰어 모드에서는 편집할 수 없습니다.');
      fn();
    };
  }

  private bindToolbar(): void {
    document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => {
      b.addEventListener('click', () => this.setTool(b.dataset.tool!));
    });
    document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => {
      b.addEventListener('click', () => this.setMode(b.dataset.mode as Mode));
    });
    document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((b) => {
      b.addEventListener(
        'click',
        this.edit(() => {
          const id = b.dataset.preset!;
          if (!this.doc.equipmentTypes.has(id)) return this.notify('라이브러리에 이 프리셋이 없습니다. 라이브러리에서 직접 고르십시오.');
          this.placeEquipment(id);
        }),
      );
    });
    const e = (fn: () => void) => this.edit(fn);
    const actions: Record<string, () => void> = {
      undo: e(() => this.undo()),
      redo: e(() => this.redo()),
      fit: () => this.fitAll(),
      new: e(() => this.newDrawing()),
      open: e(() => $<HTMLInputElement>('#file-input').click()),
      save: () => this.save(),
      delete: e(() => this.deleteSelection()),
      unconstrain: e(() => this.unconstrain()),
      rotate: e(() => this.rotateSelection()),
      array: e(() => this.arraySelection()),
      'to-layer': e(() => this.selectionToLayer()),
      'make-shape': e(() => this.makeShapeFromSelection()),
      unshape: e(() => this.unshapeSelection()),
      'order-front': e(() => this.reorderSelection('front')),
      'order-forward': e(() => this.reorderSelection('forward')),
      'order-backward': e(() => this.reorderSelection('backward')),
      'order-back': e(() => this.reorderSelection('back')),
      'style-apply': e(() => this.applyStyle(this.ribbonStyle())),
      'style-clear': e(() => this.applyStyle(undefined)),
      'add-floor': e(() => this.tree.addFloor()),
      'add-folder': e(() => this.tree.addFolder()),
      'add-layer': e(() => this.tree.addLayer()),
      'add-type': e(() => this.library.addType()),
      'export-equipment': () => this.exportEquipment(),
      'export-dxf': () => this.exportDxf(),
      'export-svg': () => this.exportSvg(),
      print: () => void this.print(),
      'load-underlay': e(() => $<HTMLInputElement>('#image-input').click()),
      'remove-underlay': e(() => {
        if (this.doc.underlay) this.history.execute(new SetUnderlay('밑그림 삭제', this.doc.underlay, null));
      }),
      'floor-up': () => this.stepFloor(1),
      'floor-down': () => this.stepFloor(-1),
      'sidebar-min': () => this.sidebar.setState('collapsed'),
      'sidebar-normal': () => this.sidebar.setState('normal'),
      'sidebar-max': () => this.sidebar.setState(this.sidebar.state === 'wide' ? 'normal' : 'wide'),
      'toggle-ribbon': () => this.ribbon.toggle(),
      'bridge-toggle': e(() => {
        if (this.bridge.state === 'closed') this.bridge.connect($<HTMLInputElement>('#bridge-url').value.trim());
        else this.bridge.disconnect();
      }),
    };
    document.querySelectorAll<HTMLButtonElement>('[data-constraint]').forEach((b) => {
      b.addEventListener('click', e(() => void this.applyConstraint(b.dataset.constraint as ConstraintKind)));
    });
    document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((b) => {
      b.addEventListener('click', () => actions[b.dataset.action!]?.());
    });
    $<HTMLInputElement>('#file-input').addEventListener('change', async (e) => {
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      input.value = '';
      if (!file) return;
      if (/\.dxf$/i.test(file.name)) this.importDxfText(await file.text());
      else this.openText(await file.text());
    });
    $<HTMLInputElement>('#image-input').addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      input.value = '';
      if (file) void this.loadUnderlay(file);
    });
    const opacity = $<HTMLInputElement>('#underlay-opacity');
    // Live while dragging, one undo step when let go.
    let opacityBefore: Underlay | null = null;
    opacity.addEventListener('input', () => {
      const u = this.doc.underlay;
      if (!u) return;
      opacityBefore ??= { ...u };
      u.opacity = Number(opacity.value) / 100;
      this.requestRender();
    });
    opacity.addEventListener('change', () => {
      const u = this.doc.underlay;
      if (u && opacityBefore) this.history.record(new SetUnderlay('밑그림 투명도', opacityBefore, { ...u }));
      opacityBefore = null;
      this.doc.changed();
    });
    $<HTMLInputElement>('#underlay-visible').addEventListener('change', (e) => {
      const u = this.doc.underlay;
      if (!u) return;
      u.visible = (e.target as HTMLInputElement).checked; // view state, like layer visibility
      this.doc.changed();
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
      this.displayUnit = unit.value as DisplayUnit;
      this.refreshPanels();
      this.requestRender();
    });
    const floor = $<HTMLSelectElement>('#floor-select');
    floor.addEventListener('change', () => this.setFloor(floor.value));
  }

  private bindKeyboard(): void {
    window.addEventListener('keydown', (e) => {
      // Typing into a field must not trigger shortcuts; a clicked checkbox, radio or colour swatch should not swallow them.
      const t = e.target;
      const typing = (t instanceof HTMLInputElement && !['checkbox', 'radio', 'color'].includes(t.type)) || t instanceof HTMLTextAreaElement;
      if (typing || t instanceof HTMLSelectElement) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const editing = this.currentMode === 'edit';
      if (mod && key === 'z' && editing) {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
      } else if (mod && key === 'y' && editing) {
        e.preventDefault();
        this.redo();
      } else if (mod && key === 's') {
        e.preventDefault();
        this.save();
      } else if (mod && key === 'o' && editing) {
        e.preventDefault();
        $<HTMLInputElement>('#file-input').click();
      } else if (mod) {
        return;
      } else if (e.key === 'Escape') {
        const home = editing ? 'select' : 'inspect';
        if (!this.tool.cancel() && this.tool !== this.tools[home]) this.setTool(home);
        this.showInspector(null, { x: 0, y: 0 });
      } else if (e.key === ' ') {
        e.preventDefault();
        if (!this.spaceHeld) {
          this.spaceHeld = true;
          this.canvas.style.cursor = 'grab';
        }
      } else if (e.key === 'PageUp' || e.key === 'PageDown') {
        e.preventDefault();
        this.stepFloor(e.key === 'PageUp' ? 1 : -1);
      } else if (editing && (e.key === 'F3' || e.key === 'F9' || e.key === 'F10')) {
        e.preventDefault();
        const key = e.key === 'F3' ? 'object' : e.key === 'F9' ? 'grid' : 'polar';
        this.snapSettings[key] = !this.snapSettings[key];
        $<HTMLInputElement>(`#snap-${key}`).checked = this.snapSettings[key];
      } else if (editing && this.tool.key?.(e)) {
        e.preventDefault();
      } else {
        const shortcuts: Record<string, () => void> = editing
          ? {
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
            }
          : { f: () => this.fitAll(), m: () => this.setTool('measure-distance'), v: () => this.setTool('inspect') };
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

  // ---------- floors, styles, shapes, order ----------

  private refreshFloorSelect(): void {
    const sel = $<HTMLSelectElement>('#floor-select');
    const floors = [...this.doc.floors.values()].sort((a, b) => b.elevation - a.elevation);
    const key = JSON.stringify([floors, this.doc.activeFloor]);
    if (sel.dataset.key === key) return;
    sel.dataset.key = key;
    sel.replaceChildren(...floors.map((f) => new Option(f.name, f.id, false, f.id === this.doc.activeFloor)));
  }

  /** Next floor up (+1) or down (-1) by elevation. */
  private stepFloor(dir: 1 | -1): void {
    const floors = [...this.doc.floors.values()].sort((a, b) => a.elevation - b.elevation);
    const i = floors.findIndex((f) => f.id === this.doc.activeFloor);
    const next = floors[i + dir];
    if (next) this.setFloor(next.id);
  }

  private ribbonStyle(): StrokeStyle {
    const width = Number($<HTMLInputElement>('#style-width').value);
    return {
      width: width >= 0 ? width : 0,
      align: $<HTMLSelectElement>('#style-align').value as StrokeStyle['align'],
      color: $<HTMLInputElement>('#style-color').value,
    };
  }

  private newLineStyle(): StrokeStyle | undefined {
    return $<HTMLInputElement>('#style-new').checked ? this.ribbonStyle() : undefined;
  }

  /** Applies (or clears) a line style on selected lines and on the edges of selected shapes. */
  private applyStyle(style: StrokeStyle | undefined): void {
    const ids = new Set<Id>();
    for (const id of this.selection.values()) {
      const e = this.doc.entities.get(id);
      if (e?.kind === 'line') ids.add(id);
      if (e?.kind === 'shape') for (const edge of e.edges) ids.add(edge);
    }
    const before = [...ids].flatMap((id) => {
      const e = this.doc.entities.get(id);
      return e?.kind === 'line' ? [e] : [];
    });
    if (before.length === 0) return this.notify('선 양식을 적용할 선이나 도형을 선택하십시오.');
    const after = before.map((l) => {
      const c = cloneEntity(l);
      if (style) c.stroke = { ...style };
      else delete c.stroke;
      return c;
    });
    this.history.execute(new UpdateEntities(style ? '선 양식' : '선 양식 지우기', before, after));
  }

  private makeShapeFromSelection(): void {
    const lines = this.selection.values().filter((id) => this.doc.entities.get(id)?.kind === 'line');
    if (lines.length < 3) return this.notify('닫힌 고리를 이루는 선을 세 개 이상 선택하십시오.');
    const r = makeShapes(this.doc, lines);
    if (!r) return this.notify('선택한 선이 닫힌 고리를 이루지 않거나 이미 도형입니다. 끝점이 서로 이어져 있어야 합니다.');
    this.history.execute(r.command);
    this.selection.set(r.shapes.map((s) => s.id));
    this.notify(`도형 ${r.shapes.length}개를 만들었습니다.`);
  }

  /** Removes selected shapes but keeps their lines. */
  private unshapeSelection(): void {
    const shapes = this.selection.values().filter((id) => this.doc.entities.get(id)?.kind === 'shape');
    if (shapes.length === 0) return this.notify('해제할 도형을 선택하십시오.');
    const removed = shapes.map((id) => cloneEntity(this.doc.entities.get(id)!));
    const order = [...this.doc.entities.keys()];
    this.history.execute({
      label: '도형 해제',
      apply: (doc) => doc.removeEntities(shapes),
      revert: (doc) => {
        doc.addEntities(removed);
        doc.reorder(order);
      },
    });
  }

  private reorderSelection(move: ReorderMove): void {
    const cmd = reorderItems(this.doc, this.selectedEntities(), move);
    if (!cmd) return this.notify(this.selection.size === 0 ? '순서를 바꿀 객체를 선택하십시오.' : '이미 그 위치입니다.');
    this.history.execute(cmd);
  }

  /** Selected entity ids; selected points (vertices) are left out. */
  private selectedEntities(): Id[] {
    return this.selection.values().filter((id) => this.doc.entities.has(id));
  }

  private deleteSelection(): void {
    const ids = deletionTargets(this.doc, this.selection.values());
    if (ids.length === 0) return this.notify('삭제할 객체를 선택하십시오.');
    this.tool.interrupt?.();
    this.selection.clear();
    this.history.execute(new RemoveEntities(ids));
  }

  // ---------- viewer inspector and AI bridge ----------

  private showInspector(id: Id | null, at: Vec2): void {
    this.inspected = id;
    const card = this.inspectorEl;
    const e = id ? this.doc.entities.get(id) : undefined;
    if (!e) {
      card.hidden = true;
      return;
    }
    fillInspector(card, this.doc, e, this.displayUnit, e.binding ? this.liveValues.get(e.binding) : undefined, () => {
      this.selection.clear();
      this.showInspector(null, at);
    });
    card.hidden = false;
    const stage = this.canvas.parentElement!.getBoundingClientRect();
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    card.style.left = `${Math.max(8, Math.min(at.x + 14, stage.width - w - 8))}px`;
    card.style.top = `${Math.max(8, Math.min(at.y + 14, stage.height - h - 8))}px`;
    this.sidebar.open('props');
  }

  /** Re-fills an open information card after the drawing or a live value changed. */
  refreshInspector(): void {
    if (!this.inspected || this.inspectorEl.hidden) return;
    const e = this.doc.entities.get(this.inspected);
    if (!e || !this.doc.isVisible(e)) return this.showInspector(null, { x: 0, y: 0 });
    fillInspector(this.inspectorEl, this.doc, e, this.displayUnit, e.binding ? this.liveValues.get(e.binding) : undefined, () => {
      this.selection.clear();
      this.showInspector(null, { x: 0, y: 0 });
    });
  }

  private bridgeState(state: 'closed' | 'connecting' | 'open', detail?: string): void {
    const el = $<HTMLSpanElement>('#bridge-status');
    el.textContent = state === 'open' ? '연결됨: AI가 이 도면을 편집할 수 있습니다' : state === 'connecting' ? '연결 중…' : '연결 안 됨';
    $<HTMLButtonElement>('[data-action="bridge-toggle"]').setAttribute('aria-pressed', String(state === 'open'));
    if (detail) this.notify(detail);
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

  private rotateSelection(): void {
    const ids = this.selectedEntities();
    if (ids.length === 0) return this.notify('회전할 객체를 선택하십시오.');
    const cmd = rotateItems(this.doc, ids, 90);
    if (typeof cmd === 'string') this.notify(cmd);
    else if (cmd) this.history.execute(cmd);
  }

  /** Rectangular array of the selection; the original stays as the first item. */
  private arraySelection(): void {
    const ids = this.selectedEntities();
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
    const ids = this.selectedEntities();
    if (ids.length === 0) return this.notify('현재 레이어로 옮길 객체를 선택하십시오.');
    const target = this.currentLayer();
    if (ids.some((id) => this.doc.floorOf(this.doc.entities.get(id)!) !== this.doc.layers.get(target)?.floor)) {
      return this.notify('다른 층의 레이어로는 옮길 수 없습니다.');
    }
    const cmd = moveToLayer(this.doc, ids, target);
    if (cmd) this.history.execute(cmd);
  }

  private refreshUnderlayControls(): void {
    const u = this.doc.underlay;
    $<HTMLDivElement>('#underlay-controls').hidden = !u;
    $<HTMLParagraphElement>('#underlay-empty').hidden = !!u;
    if (!u) return;
    const opacity = $<HTMLInputElement>('#underlay-opacity');
    if (document.activeElement !== opacity) opacity.value = String(Math.round(u.opacity * 100));
    $<HTMLInputElement>('#underlay-visible').checked = u.visible;
    $<HTMLSpanElement>('#underlay-controls .name').textContent = `${formatLength(u.width, this.displayUnit)} × ${formatLength(u.height, this.displayUnit)}`;
  }

  /** Places an image under the drawing, sized to most of the current view; the user then scales it to real size. */
  private async loadUnderlay(file: File): Promise<void> {
    if (file.size > 8 * 1024 * 1024) return this.notify('8 MB 이하의 이미지를 사용하십시오. 큰 스캔은 해상도를 낮춰 주십시오.');
    const src = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const img = new Image();
    try {
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('decode'));
        img.src = src;
      });
    } catch {
      return this.notify('이미지를 읽을 수 없습니다. PNG, JPG, GIF, WebP 파일을 사용하십시오.');
    }
    const bounds = this.view.worldBounds();
    const width = (bounds.maxX - bounds.minX) * 0.8;
    const height = (width * img.naturalHeight) / img.naturalWidth;
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    const underlay: Underlay = { src, x: cx - width / 2, y: cy - height / 2, width, height, opacity: 0.5, visible: true };
    this.history.execute(new SetUnderlay('밑그림 불러오기', this.doc.underlay, underlay));
    this.setTool('underlay');
    this.notify('밑그림을 불러왔습니다. 실제 거리를 아는 두 점을 클릭해 축척을 맞추십시오.');
  }

  private importDxfText(text: string): void {
    let dxf;
    try {
      dxf = parseDxf(text);
    } catch (err) {
      return alert(err instanceof DxfError ? `DXF를 읽을 수 없습니다: ${err.message}` : `DXF를 읽을 수 없습니다: ${String(err)}`);
    }
    let mmPerUnit = dxf.unitScale;
    if (!dxf.unitsKnown) {
      const answer = window.prompt('DXF에 도면 단위가 없습니다. 도면 1단위가 몇 mm입니까? (mm 도면: 1, m 도면: 1000, 인치: 25.4)', '1');
      if (answer === null) return;
      mmPerUnit = Number(answer);
      if (!(mmPerUnit > 0)) return this.notify('0보다 큰 숫자를 입력하십시오.');
    }
    const result = importDxf(this.doc, dxf, mmPerUnit);
    if (!result) return this.notify('가져올 선이나 원이 없습니다.');
    this.tool.cancel();
    this.history.execute(result.command);
    this.fitAll();
    const skipped = [...dxf.skipped].map(([t, c]) => `${t} ${c}`).join(', ');
    this.notify(`DXF 가져오기: 선 ${result.lines}개, 원 ${result.circles}개${skipped ? ` (제외: ${skipped})` : ''}`);
  }

  private exportDxf(): void {
    if (this.doc.entities.size === 0) return this.notify('내보낼 객체가 없습니다.');
    this.download(new Blob([writeDxf(this.doc)], { type: 'application/dxf' }), `layout-${new Date().toISOString().slice(0, 10)}.dxf`);
  }

  private exportSvg(): void {
    const svg = drawingSvg(this.doc);
    if (!svg) return this.notify('내보낼 객체가 없습니다.');
    this.download(new Blob([svg], { type: 'image/svg+xml' }), `layout-${new Date().toISOString().slice(0, 10)}.svg`);
  }

  /** Prints the whole drawing fitted to the page, through a hidden frame; the browser's dialog can save it as PDF. */
  private async print(): Promise<void> {
    const svg = drawingSvg(this.doc);
    if (!svg) return this.notify('인쇄할 객체가 없습니다.');
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden';
    document.body.append(frame);
    const page = frame.contentDocument!;
    page.open();
    page.write(
      `<!doctype html><html><head><meta charset="utf-8"><title>Layout</title><style>@page{size:landscape;margin:10mm}html,body{margin:0;height:100%}svg{width:100%;height:100%}</style></head><body>${svg}</body></html>`,
    );
    page.close();
    // Print only once the frame has loaded and an underlay image has decoded, or it may be left out.
    const loaded =
      page.readyState === 'complete'
        ? Promise.resolve()
        : new Promise<void>((resolve) => frame.contentWindow!.addEventListener('load', () => resolve(), { once: true }));
    const u = this.doc.underlay;
    const decoded = u?.visible
      ? (() => {
          const img = new Image();
          img.src = u.src;
          return img.decode().catch(() => undefined);
        })()
      : Promise.resolve();
    await Promise.all([loaded, decoded]);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    frame.contentWindow!.focus();
    frame.contentWindow!.print();
    setTimeout(() => frame.remove(), 1000);
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
        // Selected points are fixed themselves; selected geometry fixes all of its points.
        const picked = this.selection.values().filter((id) => this.doc.points.has(id));
        const points = [...new Set([...picked, ...selected.filter((e) => e.kind !== 'dimension').flatMap((e) => this.doc.pointIdsOf(e))])];
        if (points.length === 0) return this.notify('고정할 점, 선이나 원을 선택하십시오.');
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

  notify(text: string): void {
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
    document.querySelectorAll<HTMLButtonElement>('[data-action="undo"]').forEach((b) => (b.disabled = !this.history.canUndo));
    document.querySelectorAll<HTMLButtonElement>('[data-action="redo"]').forEach((b) => (b.disabled = !this.history.canRedo));
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
      const data = this.doc.toData();
      try {
        localStorage.setItem(AUTOSAVE_KEY, serialize(data));
        return;
      } catch {
        // Storage can be unavailable (private mode) or full; a large underlay image is the usual cause.
      }
      if (!data.underlay) return;
      try {
        const { underlay: _, ...rest } = data;
        localStorage.setItem(AUTOSAVE_KEY, serialize(rest));
        if (!this.underlayAutosaveWarned) {
          this.underlayAutosaveWarned = true;
          this.notify('밑그림 이미지가 커서 자동 저장에서 제외했습니다. 파일로 저장(Ctrl+S)하면 함께 저장됩니다.');
        }
      } catch {
        // Autosave is a convenience only.
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
