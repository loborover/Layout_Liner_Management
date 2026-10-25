/**
 * @file document.ts
 *
 * In-memory document (the single source of truth for a drawing): points, entities, constraints, layer tree,
 * equipment/structure library and underlay. Provides queries (bbox, point ids, extents) and change notification.
 * It is DOM-free so it also runs in Node (tests, MCP server).
 */
import { dimensionGeometry } from '../geom/dimension';
import { equipmentCorners } from '../geom/equipment';
import type { Box, Vec2 } from '../geom/vec';
import { polygonArea } from '../geom/polygon';
import { DEFAULT_STRUCTURE_TYPES } from './presets';
import {
  type Constraint,
  DEFAULT_FLOOR_ID,
  DEFAULT_LAYER_ID,
  type DocumentData,
  DEFAULT_EQUIPMENT_TYPES,
  type Entity,
  type EquipmentEntity,
  type EquipmentType,
  type Floor,
  type Folder,
  type Id,
  type Layer,
  type LineEntity,
  type Point,
  type ShapeEntity,
  type Underlay,
} from './types';
import { LAYER_DEFAULT } from '../theme';

/** Vertex id of a line's midpoint: the line id plus this suffix (never stored, see `midpointId`). */
const MIDPOINT_SUFFIX = '~mid';

/** Selectable vertex id of a line's derived midpoint. */
export function midpointId(lineId: Id): Id {
  return lineId + MIDPOINT_SUFFIX;
}

type Listener = () => void;

/**
 * In-memory drawing. Holds points, entities, the floor > folder > layer tree and the library, and notifies
 * listeners on change. Map insertion order is meaningful: `entities` order is the drawing order (later on top)
 * and the order shown in the object tree; `floors`, `folders` and `layers` order is their order in the tree.
 * Edits that users can undo go through commands (see commands.ts), never directly from tools,
 * except for live drag previews that are committed as a command afterwards.
 */
export class DocumentModel {
  readonly points = new Map<Id, Point>();
  readonly entities = new Map<Id, Entity>();
  readonly constraints = new Map<Id, Constraint>();
  readonly floors = new Map<Id, Floor>();
  readonly folders = new Map<Id, Folder>();
  readonly layers = new Map<Id, Layer>();
  /** Floor shown and edited. View state, but saved so a drawing reopens on the same floor. */
  activeFloor: Id = DEFAULT_FLOOR_ID;
  readonly equipmentTypes = new Map<Id, EquipmentType>();
  underlay: Underlay | null = null;
  private listeners = new Set<Listener>();
  private revision = 0;

  constructor() {
    this.reset();
  }

  get rev(): number {
    return this.revision;
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  changed(): void {
    this.revision++;
    for (const fn of this.listeners) fn();
  }

  reset(): void {
    this.points.clear();
    this.entities.clear();
    this.constraints.clear();
    this.floors.clear();
    this.folders.clear();
    this.layers.clear();
    this.floors.set(DEFAULT_FLOOR_ID, { id: DEFAULT_FLOOR_ID, name: '1층', elevation: 0, height: 4000 });
    this.activeFloor = DEFAULT_FLOOR_ID;
    this.layers.set(DEFAULT_LAYER_ID, {
      id: DEFAULT_LAYER_ID,
      name: '0',
      color: LAYER_DEFAULT,
      visible: true,
      locked: false,
      floor: DEFAULT_FLOOR_ID,
    });
    this.underlay = null;
    this.equipmentTypes.clear();
    for (const t of [...DEFAULT_EQUIPMENT_TYPES, ...DEFAULT_STRUCTURE_TYPES]) this.equipmentTypes.set(t.id, structuredClone(t));
    this.changed();
  }

  point(id: Id): Point {
    const p = this.points.get(id);
    if (!p) throw new Error(`Unknown point ${id}`);
    return p;
  }

  /** The line whose derived midpoint has this vertex id, if any. */
  midpointLine(id: Id): LineEntity | null {
    if (!id.endsWith(MIDPOINT_SUFFIX)) return null;
    const e = this.entities.get(id.slice(0, -MIDPOINT_SUFFIX.length));
    return e?.kind === 'line' ? e : null;
  }

  /** Whether an id names a selectable vertex: a stored point or a line's midpoint. */
  isVertex(id: Id): boolean {
    return this.points.has(id) || this.midpointLine(id) !== null;
  }

  /** Position of a vertex; a midpoint is the average of its line's ends (X, Y and Z). */
  vertex(id: Id): Point {
    const line = this.midpointLine(id);
    if (!line) return this.point(id);
    const a = this.point(line.p1);
    const b = this.point(line.p2);
    return { id, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: ((a.z ?? 0) + (b.z ?? 0)) / 2 };
  }

  /** Stored points that move when a vertex moves: the point itself, or both ends of a midpoint's line. */
  vertexPoints(id: Id): Id[] {
    const line = this.midpointLine(id);
    return line ? [line.p1, line.p2] : [id];
  }

  addPoints(points: Point[]): void {
    for (const p of points) this.points.set(p.id, { ...p });
  }

  addEntities(entities: Entity[]): void {
    for (const e of entities) this.entities.set(e.id, cloneEntity(e));
  }

  /**
   * Puts entities in the given order (ids not listed keep their relative order after the listed ones).
   * Used by reordering commands; the drawing order follows.
   */
  reorder(order: Id[]): void {
    const next = new Map<Id, Entity>();
    for (const id of order) {
      const e = this.entities.get(id);
      if (e) next.set(id, e);
    }
    for (const [id, e] of this.entities) if (!next.has(id)) next.set(id, e);
    this.entities.clear();
    for (const [id, e] of next) this.entities.set(id, e);
  }

  /** Shapes that use a line as one of their edges. */
  shapesUsing(lineIds: Iterable<Id>): ShapeEntity[] {
    const set = new Set(lineIds);
    const out: ShapeEntity[] = [];
    for (const e of this.entities.values()) if (e.kind === 'shape' && e.edges.some((id) => set.has(id))) out.push(e);
    return out;
  }

  /** Polygon of a shape in world coordinates. */
  shapePolygon(e: ShapeEntity): Vec2[] {
    return e.points.map((id) => this.point(id));
  }

  /** Enclosed area of a shape in mm². */
  shapeArea(e: ShapeEntity): number {
    return Math.abs(polygonArea(this.shapePolygon(e)));
  }

  /** Floor an entity is on (through its layer). */
  floorOf(e: Entity): Id | undefined {
    return this.layers.get(e.layer)?.floor;
  }

  removeEntities(ids: Iterable<Id>): void {
    for (const id of ids) this.entities.delete(id);
  }

  removePoints(ids: Iterable<Id>): void {
    for (const id of ids) this.points.delete(id);
  }

  addConstraints(constraints: Constraint[]): void {
    for (const c of constraints) this.constraints.set(c.id, { ...c, refs: [...c.refs] });
  }

  removeConstraints(ids: Iterable<Id>): void {
    for (const id of ids) this.constraints.delete(id);
  }

  /** Constraints that reference any of the given entity or point ids. */
  constraintsOn(ids: Iterable<Id>): Constraint[] {
    const set = new Set(ids);
    return [...this.constraints.values()].filter((c) => c.refs.some((r) => set.has(r)));
  }

  translatePoints(ids: Iterable<Id>, d: Vec2): void {
    for (const id of ids) {
      const p = this.point(id);
      p.x += d.x;
      p.y += d.y;
    }
  }

  /** Point ids an entity depends on. */
  pointIdsOf(e: Entity): Id[] {
    if (e.kind === 'circle') return [e.center];
    if (e.kind === 'equipment' || e.kind === 'point') return [e.at];
    if (e.kind === 'shape') return e.points;
    return [e.p1, e.p2];
  }

  private usersRev = -1;
  private users = new Map<Id, Entity[]>();

  /** Entities that reference a point (lines, shapes, dimensions, circles, equipment), cached per revision. */
  pointUsers(id: Id): Entity[] {
    const line = this.midpointLine(id);
    if (line) return [line];
    if (this.usersRev !== this.rev) {
      this.users.clear();
      for (const e of this.entities.values()) {
        for (const pid of this.pointIdsOf(e)) {
          let list = this.users.get(pid);
          if (!list) this.users.set(pid, (list = []));
          list.push(e);
        }
      }
      this.usersRev = this.rev;
    }
    return this.users.get(id) ?? [];
  }

  /** Whether a point can be selected and edited: some editable entity uses it. */
  isPointEditable(id: Id): boolean {
    return this.pointUsers(id).some((e) => this.isEditable(e));
  }

  /** Whether a point is shown: some visible entity uses it. */
  isPointVisible(id: Id): boolean {
    return this.pointUsers(id).some((e) => this.isVisible(e));
  }

  /** Footprint corners of a piece of equipment, counter-clockwise from its front-left. */
  cornersOf(e: EquipmentEntity): Vec2[] {
    const t = this.equipmentTypes.get(e.type);
    return equipmentCorners(this.point(e.at), t?.width ?? 0, t?.depth ?? 0, e.rotation);
  }

  /** Points no remaining entity references, among the given candidates. */
  orphanPoints(candidates: Iterable<Id>): Id[] {
    const used = new Set<Id>();
    for (const e of this.entities.values()) for (const id of this.pointIdsOf(e)) used.add(id);
    return [...new Set(candidates)].filter((id) => !used.has(id));
  }

  bboxOf(e: Entity): Box {
    if (e.kind === 'point') {
      const p = this.point(e.at);
      return { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y };
    }
    if (e.kind === 'line') {
      const a = this.point(e.p1);
      const b = this.point(e.p2);
      return {
        minX: Math.min(a.x, b.x),
        minY: Math.min(a.y, b.y),
        maxX: Math.max(a.x, b.x),
        maxY: Math.max(a.y, b.y),
      };
    }
    if (e.kind === 'dimension') {
      const a = this.point(e.p1);
      const b = this.point(e.p2);
      const { d1, d2 } = dimensionGeometry(a, b, e.offset);
      const xs = [a.x, b.x, d1.x, d2.x];
      const ys = [a.y, b.y, d1.y, d2.y];
      return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
    }
    if (e.kind === 'equipment' || e.kind === 'shape') {
      const cs = e.kind === 'equipment' ? this.cornersOf(e) : this.shapePolygon(e);
      const xs = cs.map((c) => c.x);
      const ys = cs.map((c) => c.y);
      return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
    }
    const c = this.point(e.center);
    return { minX: c.x - e.radius, minY: c.y - e.radius, maxX: c.x + e.radius, maxY: c.y + e.radius };
  }

  extents(): Box | null {
    const u = this.underlay;
    let box: Box | null = u?.visible ? { minX: u.x, minY: u.y, maxX: u.x + u.width, maxY: u.y + u.height } : null;
    for (const e of this.entities.values()) {
      const b = this.bboxOf(e);
      box = box
        ? {
            minX: Math.min(box.minX, b.minX),
            minY: Math.min(box.minY, b.minY),
            maxX: Math.max(box.maxX, b.maxX),
            maxY: Math.max(box.maxY, b.maxY),
          }
        : b;
    }
    return box;
  }

  /** Whether a layer is shown: on the active floor, and neither it nor its folder hidden. */
  isLayerVisible(id: Id): boolean {
    const layer = this.layers.get(id);
    if (!layer) return true;
    return layer.floor === this.activeFloor && this.isLayerShown(id);
  }

  /** Whether a layer and its folder are switched on, whatever floor is active (cross-floor ghosts use this). */
  isLayerShown(id: Id): boolean {
    const layer = this.layers.get(id);
    if (!layer) return true;
    const folder = layer.folder ? this.folders.get(layer.folder) : undefined;
    return layer.visible && (!folder || folder.visible);
  }

  /** Whether a layer accepts edits: visible and neither it nor its folder locked. */
  isLayerEditable(id: Id): boolean {
    const layer = this.layers.get(id);
    if (!layer) return true;
    const folder = layer.folder ? this.folders.get(layer.folder) : undefined;
    return this.isLayerVisible(id) && !layer.locked && !folder?.locked;
  }

  isVisible(e: Entity): boolean {
    return this.isLayerVisible(e.layer);
  }

  isEditable(e: Entity): boolean {
    return this.isLayerEditable(e.layer);
  }

  toData(): DocumentData {
    return {
      format: 'layout-liner',
      version: 3,
      units: 'mm',
      points: [...this.points.values()].map((p) => ({ ...p })),
      entities: [...this.entities.values()].map(cloneEntity),
      constraints: [...this.constraints.values()].map((c) => ({ ...c, refs: [...c.refs] })),
      floors: [...this.floors.values()].map((f) => ({ ...f })),
      folders: [...this.folders.values()].map((f) => ({ ...f })),
      layers: [...this.layers.values()].map((l) => ({ ...l })),
      activeFloor: this.activeFloor,
      equipmentTypes: [...this.equipmentTypes.values()].map((t) => structuredClone(t)),
      ...(this.underlay ? { underlay: { ...this.underlay } } : {}),
    };
  }

  load(data: DocumentData): void {
    this.points.clear();
    this.entities.clear();
    this.constraints.clear();
    this.layers.clear();
    this.floors.clear();
    this.folders.clear();
    this.underlay = data.underlay ? { ...data.underlay } : null;
    this.equipmentTypes.clear();
    for (const t of data.equipmentTypes) this.equipmentTypes.set(t.id, structuredClone(t));
    for (const f of data.floors) this.floors.set(f.id, { ...f });
    for (const f of data.folders) this.folders.set(f.id, { ...f });
    for (const l of data.layers) this.layers.set(l.id, { ...l });
    this.activeFloor = this.floors.has(data.activeFloor) ? data.activeFloor : (this.floors.keys().next().value ?? DEFAULT_FLOOR_ID);
    this.addPoints(data.points);
    this.addEntities(data.entities);
    this.addConstraints(data.constraints);
    this.changed();
  }
}

/** Deep enough copy of an entity: arrays and nested objects are copied so commands' snapshots stay intact. */
export function cloneEntity<T extends Entity>(e: T): T {
  const c = { ...e };
  if (c.kind === 'shape') {
    c.points = [...c.points];
    c.edges = [...c.edges];
  } else if (c.kind === 'line' && c.stroke) c.stroke = { ...c.stroke };
  else if (c.kind === 'equipment' && c.props) c.props = { ...c.props };
  return c;
}
