/**
 * @file editorApi.ts
 *
 * Programmatic editing API ("외부 API") used by AI agents and scripts. It is the single entry point for
 * automated edits: the browser exposes it as `window.layoutLiner`, the JSON-RPC dispatcher (rpc.ts) and the
 * MCP server (mcp/server.ts) call it, and the MCP bridge forwards calls to a live editor tab.
 *
 * Design rules:
 * - Plain JSON in, plain JSON out (coordinates in mm, Y up), so every transport can carry it.
 * - Every change is one undoable command on the shared History, exactly like a user action.
 * - Input is validated here; failures throw ApiError with a Korean message meant for the caller to show.
 * - DOM-free: it runs unchanged in Node.
 * Methods and their parameter schemas are listed in rpc.ts; keep both and docs/API.md in sync.
 */
import { type Vec2, dist } from '../geom/vec';
import { drawingSvg } from '../io/svg';
import { writeDxf } from '../io/dxfExport';
import { equipmentCsv } from '../io/equipmentList';
import { FormatError, parseStroke, validate } from '../io/serialize';
import {
  AddItems,
  type History,
  MovePoints,
  RemoveEntities,
  SetEquipmentTypes,
  SetLayerTree,
  SetPoints,
  UpdateEntities,
  captureLayerTree,
} from '../model/commands';
import { type DocumentModel, cloneEntity, midpointId } from '../model/document';
import { arrayOffsets, copyItems, makeShapes, nextTag, type ReorderMove, reorderItems, rotateItems } from '../model/edit';
import { heightOf } from '../model/heights';
import { buildScene } from '../model/scene3d';
import { newId } from '../model/ids';
import { CATEGORY_LABELS, PROP_DEFS, categoryOf, cleanProps, presetInfo } from '../model/presets';
import type { DocumentData, Entity, EquipmentType, Floor, Folder, Id, Layer, LineEntity, Point, ShapeEntity, StructureCategory } from '../model/types';
import { LAYER_DEFAULT } from '../theme';

export class ApiError extends Error {}

export type XY = [number, number] | { x: number; y: number };

export interface EditorApiOptions {
  /** Layer used when a call names none; defaults to the first layer of the active floor. */
  currentLayer?: () => Id;
  /** Endpoints closer than this (mm) to an existing point join it, so API-drawn lines connect. Default 0.5. */
  joinTolerance?: number;
}

const COLOR = /^#[0-9a-f]{6}$/i;

export class EditorApi {
  constructor(
    readonly doc: DocumentModel,
    readonly history: History,
    private readonly options: EditorApiOptions = {},
  ) {}

  // ---------- reading ----------

  /** Overview: floors, folders, layers with object counts, library and drawing extents. */
  summary() {
    const { doc } = this;
    const perLayer = new Map<Id, number>();
    const kinds: Record<string, number> = {};
    for (const e of doc.entities.values()) {
      perLayer.set(e.layer, (perLayer.get(e.layer) ?? 0) + 1);
      kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
    }
    return {
      activeFloor: doc.activeFloor,
      floors: [...doc.floors.values()],
      folders: [...doc.folders.values()],
      layers: [...doc.layers.values()].map((l) => ({ ...l, objects: perLayer.get(l.id) ?? 0 })),
      objects: kinds,
      library: [...doc.equipmentTypes.values()].map((t) => ({ ...t, category: categoryOf(t) })),
      extents: doc.extents(),
      canUndo: this.history.canUndo,
      canRedo: this.history.canRedo,
    };
  }

  /** The whole drawing in the file format (docs/DATA_MODEL.md). */
  getDocument(): DocumentData {
    return this.doc.toData();
  }

  /** Replaces the drawing (validated like a file). Clears undo history. */
  loadDocument(p: { data: unknown }): { ok: true } {
    let data: DocumentData;
    try {
      data = validate(typeof p.data === 'string' ? JSON.parse(p.data) : p.data);
    } catch (err) {
      throw new ApiError(err instanceof FormatError ? err.message : `도면을 읽을 수 없습니다: ${String(err)}`);
    }
    this.doc.load(data);
    this.history.clear();
    return { ok: true };
  }

  /** Objects with resolved coordinates, optionally filtered. */
  listEntities(p: { floor?: Id; layer?: Id; kind?: Entity['kind']; limit?: number } = {}) {
    const { doc } = this;
    const out = [];
    const limit = Math.min(Math.max(1, p.limit ?? 500), 5000);
    for (const e of doc.entities.values()) {
      if (p.layer && e.layer !== p.layer) continue;
      if (p.floor && doc.floorOf(e) !== p.floor) continue;
      if (p.kind && e.kind !== p.kind) continue;
      out.push(this.describe(e));
      if (out.length >= limit) break;
    }
    return { total: doc.entities.size, items: out };
  }

  getEntity(p: { id: Id }) {
    return this.describe(this.entity(p.id));
  }

  /** An entity with point ids resolved to coordinates and derived values (length, area, checks). */
  describe(e: Entity) {
    const { doc } = this;
    const at = (id: Id) => {
      const pt = doc.point(id);
      return { id, x: pt.x, y: pt.y, z: pt.z ?? 0 };
    };
    const base = { ...cloneEntity(e), floor: doc.floorOf(e), ...(e.kind !== 'dimension' && e.kind !== 'point' ? { effectiveHeight: heightOf(doc, e) } : {}) };
    switch (e.kind) {
      case 'point':
        return { ...base, position: at(e.at) };
      case 'line': {
        const mid = doc.vertex(midpointId(e.id));
        return { ...base, start: at(e.p1), middle: { id: mid.id, x: mid.x, y: mid.y, z: mid.z ?? 0 }, end: at(e.p2), length: dist(doc.point(e.p1), doc.point(e.p2)) };
      }
      case 'dimension':
        return { ...base, start: at(e.p1), end: at(e.p2), length: dist(doc.point(e.p1), doc.point(e.p2)) };
      case 'circle':
        return { ...base, centerAt: at(e.center) };
      case 'shape':
        return { ...base, polygon: e.points.map(at), area: doc.shapeArea(e) };
      case 'equipment': {
        const type = doc.equipmentTypes.get(e.type);
        return { ...base, position: at(e.at), typeName: type?.name, category: categoryOf(type), corners: doc.cornersOf(e), checks: presetInfo(doc, e) };
      }
    }
  }

  /**
   * Moves a point (vertex) to an exact X, Y and/or Z; everything built on it follows. A line's midpoint
   * (`middle.id` in getEntity) moves the whole line. Points of constrained geometry can only change Z here
   * (X/Y would break the constraints; use the editor or remove them first).
   */
  setPoint(p: { id: Id; x?: number; y?: number; z?: number }) {
    const { doc } = this;
    if (!doc.isVertex(p.id)) throw new ApiError(`점이 없습니다: ${p.id}. getEntity 결과의 start/middle/end/position 등에 있는 id를 쓰십시오.`);
    if (!doc.isPointEditable(p.id)) throw new ApiError('잠겼거나 보이지 않는(다른 층) 객체의 점입니다.');
    const pt = doc.vertex(p.id);
    const to = {
      x: p.x === undefined ? pt.x : this.num(p.x, 'x'),
      y: p.y === undefined ? pt.y : this.num(p.y, 'y'),
      z: p.z === undefined ? (pt.z ?? 0) : this.num(p.z, 'z'),
    };
    const movesXY = to.x !== pt.x || to.y !== pt.y;
    const moved = doc.vertexPoints(p.id);
    if (movesXY && doc.constraintsOn([...moved, ...moved.flatMap((id) => doc.pointUsers(id).map((e) => e.id))]).length > 0) {
      throw new ApiError('구속된 형상의 점입니다. X/Y는 편집기에서 옮기거나 구속을 먼저 해제하십시오(Z는 바꿀 수 있습니다).');
    }
    const d = { x: to.x - pt.x, y: to.y - pt.y, z: to.z - (pt.z ?? 0) };
    const before = SetPoints.capture(doc, moved);
    const after = new Map(
      [...before].map(([id, q]) => {
        const z = (q.z ?? 0) + d.z;
        return [id, { x: q.x + d.x, y: q.y + d.y, ...(z ? { z } : {}) }];
      }),
    );
    this.history.execute(new SetPoints('좌표 변경', before, after));
    return { id: p.id, ...to, attached: doc.pointUsers(p.id).map((e) => e.id) };
  }

  // ---------- drawing ----------

  /**
   * Polyline through points; `closed` joins the last point to the first and makes the loop a shape.
   * Endpoints within the join tolerance of existing points connect to them.
   */
  addLines(p: { points: XY[]; closed?: boolean; layer?: Id; stroke?: unknown; name?: string; fill?: string }) {
    const pts = this.points(p.points, 2);
    const layer = this.layer(p.layer);
    const stroke = this.stroke(p.stroke);
    const fresh: Point[] = [];
    const ids = pts.map((v) => this.pointAt(v, fresh, layer));
    if (p.closed) {
      if (ids.length < 3) throw new ApiError('닫힌 도형에는 점이 세 개 이상 필요합니다.');
      if (ids[ids.length - 1] === ids[0]) ids.pop();
    }
    const loop = p.closed ? [...ids, ids[0]] : ids;
    const lines: LineEntity[] = [];
    for (let i = 0; i + 1 < loop.length; i++) {
      if (loop[i] === loop[i + 1]) continue;
      lines.push({ id: newId('e'), kind: 'line', p1: loop[i], p2: loop[i + 1], layer, ...(stroke ? { stroke } : {}) });
    }
    if (lines.length === 0) throw new ApiError('길이가 있는 선이 없습니다.');
    const items: Entity[] = [...lines];
    let shape: ShapeEntity | undefined;
    if (p.closed && lines.length === ids.length) {
      shape = { id: newId('e'), kind: 'shape', points: ids, edges: lines.map((l) => l.id), layer, name: p.name ?? this.nextShapeName() };
      if (p.fill !== undefined) shape.fill = this.color(p.fill);
      items.push(shape);
    }
    this.history.execute(new AddItems(fresh, items));
    return { lines: lines.map((l) => l.id), shape: shape?.id ?? null };
  }

  /** Axis-aligned rectangle (four lines and a shape) from its lower-left corner. */
  addRectangle(p: { x: number; y: number; width: number; height: number; layer?: Id; stroke?: unknown; name?: string; fill?: string }) {
    this.num(p.x, 'x');
    this.num(p.y, 'y');
    if (!(this.num(p.width, 'width') > 0) || !(this.num(p.height, 'height') > 0)) throw new ApiError('width와 height는 0보다 커야 합니다.');
    return this.addLines({
      points: [
        [p.x, p.y],
        [p.x + p.width, p.y],
        [p.x + p.width, p.y + p.height],
        [p.x, p.y + p.height],
      ],
      closed: true,
      layer: p.layer,
      stroke: p.stroke,
      name: p.name,
      fill: p.fill,
    });
  }

  /** Standalone point object (reference or survey point); joins an existing point within the join tolerance. */
  addPoint(p: { x: number; y: number; z?: number; layer?: Id; name?: string }) {
    const fresh: Point[] = [];
    const layer = this.layer(p.layer);
    const at = this.pointAt(this.vec([p.x, p.y]), fresh, layer);
    if (p.z !== undefined) {
      const z = this.num(p.z, 'z');
      const own = fresh.find((q) => q.id === at);
      if (own && z) own.z = z;
    }
    const e: Entity = { id: newId('e'), kind: 'point', at, layer, ...(p.name ? { name: String(p.name) } : {}) };
    this.history.execute(new AddItems(fresh, [e]));
    return { id: e.id, point: at };
  }

  addCircle(p: { x: number; y: number; radius: number; layer?: Id; name?: string }) {
    if (!(this.num(p.radius, 'radius') > 0)) throw new ApiError('radius는 0보다 커야 합니다.');
    const fresh: Point[] = [];
    const layer = this.layer(p.layer);
    const center = this.pointAt(this.vec([p.x, p.y]), fresh, layer);
    const e: Entity = { id: newId('e'), kind: 'circle', center, radius: p.radius, layer, ...(p.name ? { name: p.name } : {}) };
    this.history.execute(new AddItems(fresh, [e]));
    return { id: e.id };
  }

  addDimension(p: { from: XY; to: XY; offset?: number; layer?: Id }) {
    const fresh: Point[] = [];
    const layer = this.layer(p.layer);
    const a = this.pointAt(this.vec(p.from), fresh, layer);
    const b = this.pointAt(this.vec(p.to), fresh, layer);
    if (a === b) throw new ApiError('치수의 두 점이 같습니다.');
    const e: Entity = { id: newId('e'), kind: 'dimension', p1: a, p2: b, offset: p.offset ?? 500, layer };
    this.history.execute(new AddItems(fresh, [e]));
    return { id: e.id };
  }

  /** Places equipment or a structural preset (type id or name, e.g. "계단") centred at x, y. */
  placeEquipment(p: { type: string; x: number; y: number; rotation?: number; tag?: string; layer?: Id; props?: unknown; name?: string; binding?: string }) {
    const type = this.type(p.type);
    const at: Point = { id: newId('p'), ...this.vec([p.x, p.y]) };
    const props = p.props === undefined ? undefined : cleanProps(categoryOf(type), p.props);
    const e: Entity = {
      id: newId('e'),
      kind: 'equipment',
      type: type.id,
      at: at.id,
      rotation: p.rotation === undefined ? 0 : ((this.num(p.rotation, 'rotation') % 360) + 360) % 360,
      tag: p.tag ?? nextTag(this.doc, type),
      layer: this.layer(p.layer),
      ...(props ? { props } : {}),
      ...(p.name ? { name: p.name } : {}),
      ...(p.binding ? { binding: p.binding } : {}),
    };
    this.history.execute(new AddItems([at], [e]));
    return { id: e.id, tag: e.tag };
  }

  // ---------- editing ----------

  /**
   * Changes properties of one object. `stroke: null` clears a line style, `fill: null` a shape fill,
   * `props` merges into a preset's properties (null clears them all).
   */
  updateEntity(p: {
    id: Id;
    name?: string | null;
    layer?: Id;
    binding?: string | null;
    stroke?: unknown;
    fill?: string | null;
    tag?: string;
    rotation?: number;
    radius?: number;
    props?: Record<string, unknown> | null;
    height?: number | null;
  }) {
    const e = this.entity(p.id);
    const c = cloneEntity(e);
    if (p.height !== undefined) {
      if (c.kind === 'dimension' || c.kind === 'point') throw new ApiError('치수와 점에는 높이가 없습니다. 점의 높이는 setPoint의 z로 바꾸십시오.');
      if (p.height === null) delete c.height;
      else {
        const h = this.num(p.height, 'height');
        if (h < 0) throw new ApiError('height는 0 이상이어야 합니다.');
        c.height = h;
      }
    }
    if (p.name !== undefined) {
      if (p.name) c.name = String(p.name);
      else delete c.name;
    }
    if (p.binding !== undefined) {
      if (p.binding) c.binding = String(p.binding);
      else delete c.binding;
    }
    if (p.layer !== undefined) {
      const layer = this.doc.layers.get(p.layer);
      if (!layer) throw new ApiError(`레이어가 없습니다: ${p.layer}`);
      if (layer.floor !== this.doc.floorOf(e)) throw new ApiError('다른 층의 레이어로는 옮길 수 없습니다.');
      c.layer = p.layer;
    }
    if (p.stroke !== undefined) {
      if (c.kind !== 'line') throw new ApiError('선 양식은 선에만 지정합니다. 도형은 setStroke로 변에 지정하십시오.');
      const s = this.stroke(p.stroke);
      if (s) c.stroke = s;
      else delete c.stroke;
    }
    if (p.fill !== undefined) {
      if (c.kind !== 'shape') throw new ApiError('채우기는 도형에만 지정합니다.');
      if (p.fill === null) delete c.fill;
      else c.fill = this.color(p.fill);
    }
    if (p.tag !== undefined || p.rotation !== undefined || p.props !== undefined) {
      if (c.kind !== 'equipment') throw new ApiError('tag, rotation, props는 설비·구조 객체에만 지정합니다.');
      if (p.tag !== undefined) c.tag = String(p.tag);
      if (p.rotation !== undefined) c.rotation = ((this.num(p.rotation, 'rotation') % 360) + 360) % 360;
      if (p.props === null) delete c.props;
      else if (p.props !== undefined) {
        const merged = cleanProps(categoryOf(this.doc.equipmentTypes.get(c.type)), { ...c.props, ...p.props });
        if (merged) c.props = merged;
        else delete c.props;
      }
    }
    if (p.radius !== undefined) {
      if (c.kind !== 'circle') throw new ApiError('radius는 원에만 지정합니다.');
      if (!(this.num(p.radius, 'radius') > 0)) throw new ApiError('radius는 0보다 커야 합니다.');
      c.radius = p.radius;
    }
    this.history.execute(new UpdateEntities('속성 변경', [e], [c]));
    return this.describe(this.doc.entities.get(e.id)!);
  }

  /** Line style for lines and the edges of shapes among `ids`; `stroke: null` clears it. */
  setStroke(p: { ids: Id[]; stroke: unknown }) {
    const s = this.stroke(p.stroke);
    const lineIds = new Set<Id>();
    for (const id of this.ids(p.ids)) {
      const e = this.entity(id);
      if (e.kind === 'line') lineIds.add(id);
      else if (e.kind === 'shape') for (const edge of e.edges) lineIds.add(edge);
    }
    const before = [...lineIds].map((id) => this.doc.entities.get(id)!).filter((e): e is LineEntity => e.kind === 'line');
    if (before.length === 0) throw new ApiError('선이나 도형이 없습니다.');
    const after = before.map((l) => {
      const c = cloneEntity(l);
      if (s) c.stroke = s;
      else delete c.stroke;
      return c;
    });
    this.history.execute(new UpdateEntities('선 양식', before, after));
    return { lines: before.map((l) => l.id) };
  }

  moveEntities(p: { ids: Id[]; dx: number; dy: number }) {
    const ids = this.ids(p.ids);
    const pointIds = [...new Set(ids.flatMap((id) => this.doc.pointIdsOf(this.entity(id))))];
    this.history.execute(new MovePoints(pointIds, { x: this.num(p.dx, 'dx'), y: this.num(p.dy, 'dy') }));
    return { moved: ids.length };
  }

  /** Rotates by a multiple of 90° (equipment alone turns in place). */
  rotateEntities(p: { ids: Id[]; angle?: number }) {
    const angle = p.angle ?? 90;
    if (!Number.isFinite(angle) || angle % 90 !== 0) throw new ApiError('angle은 90의 배수여야 합니다.');
    const cmd = rotateItems(this.doc, this.ids(p.ids), angle);
    if (typeof cmd === 'string') throw new ApiError(cmd);
    if (cmd) this.history.execute(cmd);
    return { ok: true };
  }

  /** Copies objects: once by (dx, dy), or as a columns × rows array with that spacing. */
  copyEntities(p: { ids: Id[]; dx: number; dy: number; columns?: number; rows?: number }) {
    const before = new Set(this.doc.entities.keys());
    const cols = p.columns ?? 2;
    const rows = p.rows ?? 1;
    if (![cols, rows].every((n) => Number.isInteger(n) && n >= 1) || cols * rows > 1000) throw new ApiError('columns×rows는 1000 이하의 정수여야 합니다.');
    const offsets = p.columns === undefined && p.rows === undefined ? [{ x: p.dx, y: p.dy }] : arrayOffsets(cols, rows, p.dx, p.dy);
    const cmd = copyItems(this.doc, this.ids(p.ids), offsets);
    if (!cmd) throw new ApiError('복사할 객체가 없습니다.');
    this.history.execute(cmd);
    return { created: [...this.doc.entities.keys()].filter((id) => !before.has(id)) };
  }

  deleteEntities(p: { ids: Id[] }) {
    const ids = this.ids(p.ids);
    const before = this.doc.entities.size;
    this.history.execute(new RemoveEntities(ids));
    return { deleted: before - this.doc.entities.size };
  }

  /** Turns closed loops among the given lines into shapes. */
  makeShapes(p: { lineIds: Id[]; name?: string }) {
    const r = makeShapes(this.doc, this.ids(p.lineIds), p.name);
    if (!r) throw new ApiError('선들이 닫힌 고리를 이루지 않거나 이미 도형입니다.');
    this.history.execute(r.command);
    return { shapes: r.shapes.map((s) => s.id) };
  }

  reorder(p: { ids: Id[]; move: ReorderMove }) {
    if (!['front', 'back', 'forward', 'backward'].includes(p.move)) throw new ApiError('move는 front, back, forward, backward 중 하나입니다.');
    const cmd = reorderItems(this.doc, this.ids(p.ids), p.move);
    if (cmd) this.history.execute(cmd);
    return { ok: true };
  }

  // ---------- floors, folders, layers ----------

  /** Adds a floor with one layer "0". Elevation defaults to the top of the highest floor. */
  addFloor(p: { name: string; elevation?: number; height?: number }) {
    const floors = [...this.doc.floors.values()];
    const top = floors.reduce((a, f) => (f.elevation + f.height > a.elevation + a.height ? f : a), floors[0]);
    const floor: Floor = {
      id: newId('floor'),
      name: String(p.name || `${floors.length + 1}층`),
      elevation: p.elevation ?? top.elevation + top.height,
      height: p.height && p.height > 0 ? p.height : top.height,
    };
    const layer: Layer = { id: newId('layer'), name: '0', color: LAYER_DEFAULT, visible: true, locked: false, floor: floor.id };
    this.tree('층 추가', (t) => {
      t.floors.push(floor);
      t.layers.push(layer);
    });
    return { floor: floor.id, layer: layer.id };
  }

  /** Shows a floor; new objects then go on its layers. Not undoable (view state). */
  setActiveFloor(p: { floor: Id }) {
    if (!this.doc.floors.has(p.floor)) throw new ApiError(`층이 없습니다: ${p.floor}`);
    this.doc.activeFloor = p.floor;
    this.doc.changed();
    return { ok: true };
  }

  addFolder(p: { name: string; floor?: Id }) {
    const floor = p.floor ?? this.doc.activeFloor;
    if (!this.doc.floors.has(floor)) throw new ApiError(`층이 없습니다: ${floor}`);
    const folder: Folder = { id: newId('folder'), name: String(p.name || '폴더'), floor, visible: true, locked: false };
    this.tree('폴더 추가', (t) => t.folders.push(folder));
    return { folder: folder.id };
  }

  addLayer(p: { name: string; floor?: Id; folder?: Id; color?: string }) {
    const folder = p.folder ? this.doc.folders.get(p.folder) : undefined;
    if (p.folder && !folder) throw new ApiError(`폴더가 없습니다: ${p.folder}`);
    const floor = folder?.floor ?? p.floor ?? this.doc.activeFloor;
    if (!this.doc.floors.has(floor)) throw new ApiError(`층이 없습니다: ${floor}`);
    const layer: Layer = {
      id: newId('layer'),
      name: String(p.name || '레이어'),
      color: p.color ? this.color(p.color) : LAYER_DEFAULT,
      visible: true,
      locked: false,
      floor,
      ...(folder ? { folder: folder.id } : {}),
    };
    this.tree('레이어 추가', (t) => t.layers.push(layer));
    return { layer: layer.id };
  }

  /** Renames, recolours, hides, locks or re-files a layer (`folder: null` takes it out of its folder). */
  updateLayer(p: { id: Id; name?: string; color?: string; visible?: boolean; locked?: boolean; folder?: Id | null }) {
    if (!this.doc.layers.has(p.id)) throw new ApiError(`레이어가 없습니다: ${p.id}`);
    if (p.folder && !this.doc.folders.has(p.folder)) throw new ApiError(`폴더가 없습니다: ${p.folder}`);
    this.tree('레이어 수정', (t) => {
      const l = t.layers.find((x) => x.id === p.id)!;
      if (p.name !== undefined) l.name = String(p.name);
      if (p.color !== undefined) l.color = this.color(p.color);
      if (p.visible !== undefined) l.visible = !!p.visible;
      if (p.locked !== undefined) l.locked = !!p.locked;
      if (p.folder === null) delete l.folder;
      else if (p.folder !== undefined) {
        l.folder = p.folder;
        l.floor = this.doc.folders.get(p.folder)!.floor;
      }
    });
    return { ok: true };
  }

  /** Adds a library item; `category` makes it a structural preset with default `props`. */
  addEquipmentType(p: { name: string; width: number; depth: number; prefix?: string; category?: StructureCategory; props?: unknown }) {
    if (!(this.num(p.width, 'width') > 0) || !(this.num(p.depth, 'depth') > 0)) throw new ApiError('width와 depth는 0보다 커야 합니다.');
    const category = p.category ?? 'equipment';
    if (!(category in CATEGORY_LABELS)) throw new ApiError(`category는 ${Object.keys(CATEGORY_LABELS).join(', ')} 중 하나입니다.`);
    const props = cleanProps(category, p.props);
    const type: EquipmentType = {
      id: newId('eq'),
      name: String(p.name || CATEGORY_LABELS[category]),
      width: p.width,
      depth: p.depth,
      prefix: p.prefix ?? '',
      ...(category !== 'equipment' ? { category } : {}),
      ...(props ? { props } : {}),
    };
    const before = [...this.doc.equipmentTypes.values()].map((t) => structuredClone(t));
    this.history.execute(new SetEquipmentTypes('설비 종류 추가', before, [...before, type]));
    return { type: type.id };
  }

  /** Property definitions of each preset category (keys accepted in `props`). */
  presetSchema() {
    return Object.fromEntries(Object.entries(PROP_DEFS).map(([k, defs]) => [k, { label: CATEGORY_LABELS[k as StructureCategory], props: defs }]));
  }

  // ---------- history and export ----------

  undo() {
    this.history.undo();
    return { canUndo: this.history.canUndo, canRedo: this.history.canRedo };
  }

  redo() {
    this.history.redo();
    return { canUndo: this.history.canUndo, canRedo: this.history.canRedo };
  }

  /** Runs several calls as one undo step; stops at the first error and undoes the ones before it. */
  batch(p: { calls: { method: string; params?: unknown }[] }, run: (method: string, params: unknown) => unknown) {
    if (!Array.isArray(p.calls) || p.calls.length === 0) throw new ApiError('calls가 비어 있습니다.');
    const start = this.history.size;
    const results: unknown[] = [];
    try {
      for (const c of p.calls) results.push(run(c.method, c.params ?? {}));
    } catch (err) {
      while (this.history.size > start) this.history.undo();
      throw err;
    }
    this.history.squash(start, '일괄 작업');
    return { results };
  }

  /** Renderer-independent 3D scene (src/model/scene3d.ts) for host-side rendering or conversion. */
  scene3d(p: { floors?: 'all' | 'active' } = {}) {
    if (p.floors !== undefined && p.floors !== 'all' && p.floors !== 'active') throw new ApiError("floors는 'all' 또는 'active'입니다.");
    return buildScene(this.doc, { floors: p.floors });
  }

  exportSvg() {
    return { svg: drawingSvg(this.doc) };
  }

  exportDxf() {
    return { dxf: writeDxf(this.doc) };
  }

  exportEquipmentCsv() {
    return { csv: equipmentCsv(this.doc) };
  }

  // ---------- helpers ----------

  private nextShapeName(): string {
    return `도형 ${[...this.doc.entities.values()].filter((e) => e.kind === 'shape').length + 1}`;
  }

  private entity(id: Id): Entity {
    const e = this.doc.entities.get(id);
    if (!e) throw new ApiError(`객체가 없습니다: ${id}`);
    return e;
  }

  private ids(ids: unknown): Id[] {
    if (!Array.isArray(ids) || ids.length === 0) throw new ApiError('ids가 비어 있습니다.');
    for (const id of ids) this.entity(String(id));
    return ids.map(String);
  }

  private num(v: unknown, name: string): number {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new ApiError(`${name}은(는) 숫자여야 합니다.`);
    return v;
  }

  private vec(v: XY): Vec2 {
    const x = Array.isArray(v) ? v[0] : v?.x;
    const y = Array.isArray(v) ? v[1] : v?.y;
    return { x: this.num(x, 'x'), y: this.num(y, 'y') };
  }

  private points(list: XY[], min: number): Vec2[] {
    if (!Array.isArray(list) || list.length < min) throw new ApiError(`points에 좌표가 ${min}개 이상 필요합니다.`);
    return list.map((v) => this.vec(v));
  }

  private color(v: unknown): string {
    if (typeof v !== 'string' || !COLOR.test(v)) throw new ApiError('색은 #rrggbb 형식이어야 합니다.');
    return v;
  }

  private stroke(v: unknown) {
    if (v === undefined || v === null) return undefined;
    try {
      const s = parseStroke({ align: 'center', ...(v as object) }, '선');
      return s;
    } catch (err) {
      throw new ApiError(err instanceof Error ? err.message : String(err));
    }
  }

  private type(ref: string): EquipmentType {
    const { doc } = this;
    const t = doc.equipmentTypes.get(ref) ?? [...doc.equipmentTypes.values()].find((x) => x.name === ref);
    if (!t) throw new ApiError(`설비·구조 종류가 없습니다: ${ref}. summary의 library에서 id나 이름을 고르십시오.`);
    return t;
  }

  /** Layer for new objects: the given one (must be on the active floor) or the current one. */
  private layer(id?: Id): Id {
    const { doc } = this;
    if (id !== undefined) {
      const layer = doc.layers.get(id);
      if (!layer) throw new ApiError(`레이어가 없습니다: ${id}`);
      if (layer.floor !== doc.activeFloor) {
        throw new ApiError(`레이어 ${layer.name}은(는) 현재 층이 아닌 층에 있습니다. 먼저 setActiveFloor로 그 층(${layer.floor})을 고르십시오.`);
      }
      return id;
    }
    const current = this.options.currentLayer?.();
    if (current && doc.layers.get(current)?.floor === doc.activeFloor) return current;
    const first = [...doc.layers.values()].find((l) => l.floor === doc.activeFloor);
    if (!first) throw new ApiError('현재 층에 레이어가 없습니다.');
    return first.id;
  }

  /**
   * Existing point within the join tolerance on the same floor as `layer` (lines, circles and dimensions only;
   * an equipment's own point never joins), or a new one appended to `fresh`.
   */
  private pointAt(v: Vec2, fresh: Point[], layer: Id): Id {
    const { doc } = this;
    const tol = this.options.joinTolerance ?? 0.5;
    for (const p of fresh) if (dist(p, v) <= tol) return p.id;
    const floor = doc.layers.get(layer)?.floor;
    for (const e of doc.entities.values()) {
      if (e.kind === 'equipment' || e.kind === 'shape' || doc.floorOf(e) !== floor) continue;
      for (const id of doc.pointIdsOf(e)) {
        const p = doc.point(id);
        if (dist(p, v) <= tol) return p.id;
      }
    }
    const p = { id: newId('p'), x: v.x, y: v.y };
    fresh.push(p);
    return p.id;
  }

  private tree(label: string, edit: (t: ReturnType<typeof captureLayerTree>) => void): void {
    const before = captureLayerTree(this.doc);
    const after = captureLayerTree(this.doc);
    edit(after);
    this.history.execute(new SetLayerTree(label, before, after));
  }
}

