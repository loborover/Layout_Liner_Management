import { dimensionGeometry } from '../geom/dimension';
import { equipmentCorners } from '../geom/equipment';
import type { Box, Vec2 } from '../geom/vec';
import {
  type Constraint,
  DEFAULT_LAYER_ID,
  type DocumentData,
  DEFAULT_EQUIPMENT_TYPES,
  type Entity,
  type EquipmentEntity,
  type EquipmentType,
  type Id,
  type Layer,
  type Point,
  type Underlay,
} from './types';

type Listener = () => void;

/**
 * In-memory drawing. Holds points, entities and layers and notifies listeners on change.
 * Edits that users can undo go through commands (see commands.ts), never directly from tools,
 * except for live drag previews that are committed as a command afterwards.
 */
export class DocumentModel {
  readonly points = new Map<Id, Point>();
  readonly entities = new Map<Id, Entity>();
  readonly constraints = new Map<Id, Constraint>();
  readonly layers = new Map<Id, Layer>();
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
    this.layers.clear();
    this.layers.set(DEFAULT_LAYER_ID, {
      id: DEFAULT_LAYER_ID,
      name: '0',
      color: '#1f2937',
      visible: true,
      locked: false,
    });
    this.underlay = null;
    this.equipmentTypes.clear();
    for (const t of DEFAULT_EQUIPMENT_TYPES) this.equipmentTypes.set(t.id, { ...t });
    this.changed();
  }

  point(id: Id): Point {
    const p = this.points.get(id);
    if (!p) throw new Error(`Unknown point ${id}`);
    return p;
  }

  addPoints(points: Point[]): void {
    for (const p of points) this.points.set(p.id, { ...p });
  }

  addEntities(entities: Entity[]): void {
    for (const e of entities) this.entities.set(e.id, { ...e });
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
    if (e.kind === 'equipment') return [e.at];
    return [e.p1, e.p2];
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
    if (e.kind === 'equipment') {
      const cs = this.cornersOf(e);
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

  isEditable(e: Entity): boolean {
    const layer = this.layers.get(e.layer);
    return !layer || (layer.visible && !layer.locked);
  }

  toData(): DocumentData {
    return {
      format: 'layout-liner',
      version: 1,
      units: 'mm',
      points: [...this.points.values()].map((p) => ({ ...p })),
      entities: [...this.entities.values()].map((e) => ({ ...e })),
      constraints: [...this.constraints.values()].map((c) => ({ ...c, refs: [...c.refs] })),
      layers: [...this.layers.values()].map((l) => ({ ...l })),
      equipmentTypes: [...this.equipmentTypes.values()].map((t) => ({ ...t })),
      ...(this.underlay ? { underlay: { ...this.underlay } } : {}),
    };
  }

  load(data: DocumentData): void {
    this.points.clear();
    this.entities.clear();
    this.constraints.clear();
    this.layers.clear();
    this.underlay = data.underlay ? { ...data.underlay } : null;
    this.equipmentTypes.clear();
    for (const t of data.equipmentTypes) this.equipmentTypes.set(t.id, { ...t });
    for (const l of data.layers) this.layers.set(l.id, { ...l });
    this.addPoints(data.points);
    this.addEntities(data.entities);
    this.addConstraints(data.constraints);
    this.changed();
  }
}
