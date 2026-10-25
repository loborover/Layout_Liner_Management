/**
 * @file commands.ts
 *
 * Command pattern for undo/redo. Every user-visible document edit is a Command applied through History, so it
 * can be undone. Commands store what they need to revert (snapshots or before/after values).
 * Rule: tools, UI and the API never mutate the document directly except for live previews later recorded with
 * `History.record`.
 */
import type { Vec2 } from '../geom/vec';
import type { DocumentModel } from './document';
import type { Constraint, Entity, EquipmentType, Id, Layer, Point, Underlay } from './types';

export interface Command {
  readonly label: string;
  apply(doc: DocumentModel): void;
  revert(doc: DocumentModel): void;
}

export class AddItems implements Command {
  readonly label = '추가';
  constructor(
    private readonly points: Point[],
    private readonly entities: Entity[],
  ) {}

  apply(doc: DocumentModel): void {
    doc.addPoints(this.points);
    doc.addEntities(this.entities);
  }

  revert(doc: DocumentModel): void {
    doc.removeEntities(this.entities.map((e) => e.id));
    doc.removePoints(this.points.map((p) => p.id));
  }
}

/** Removes entities, any points left without an entity, and constraints on what was removed. */
export class RemoveEntities implements Command {
  readonly label = '삭제';
  private removedEntities: Entity[] = [];
  private removedPoints: Point[] = [];
  private removedConstraints: Constraint[] = [];

  constructor(private readonly ids: Id[]) {}

  apply(doc: DocumentModel): void {
    this.removedEntities = this.ids.flatMap((id) => {
      const e = doc.entities.get(id);
      return e ? [{ ...e }] : [];
    });
    const candidates = this.removedEntities.flatMap((e) => doc.pointIdsOf(e));
    doc.removeEntities(this.ids);
    this.removedPoints = doc.orphanPoints(candidates).map((id) => ({ ...doc.point(id) }));
    doc.removePoints(this.removedPoints.map((p) => p.id));
    this.removedConstraints = doc.constraintsOn([...this.ids, ...this.removedPoints.map((p) => p.id)]);
    doc.removeConstraints(this.removedConstraints.map((c) => c.id));
  }

  revert(doc: DocumentModel): void {
    doc.addPoints(this.removedPoints);
    doc.addEntities(this.removedEntities);
    doc.addConstraints(this.removedConstraints);
  }
}

export class AddConstraints implements Command {
  readonly label = '구속 추가';
  constructor(private readonly constraints: Constraint[]) {}

  apply(doc: DocumentModel): void {
    doc.addConstraints(this.constraints);
  }

  revert(doc: DocumentModel): void {
    doc.removeConstraints(this.constraints.map((c) => c.id));
  }
}

export class RemoveConstraints implements Command {
  readonly label = '구속 해제';
  private removed: Constraint[] = [];
  constructor(private readonly ids: Id[]) {}

  apply(doc: DocumentModel): void {
    this.removed = this.ids.flatMap((id) => {
      const c = doc.constraints.get(id);
      return c ? [{ ...c, refs: [...c.refs] }] : [];
    });
    doc.removeConstraints(this.ids);
  }

  revert(doc: DocumentModel): void {
    doc.addConstraints(this.removed);
  }
}

/** Point positions and circle radii, captured before and after a solve. */
export interface GeometryState {
  points: Map<Id, { x: number; y: number }>;
  radii: Map<Id, number>;
}

export function captureGeometry(doc: DocumentModel, pointIds: Iterable<Id>, circleIds: Iterable<Id> = []): GeometryState {
  const points = new Map<Id, { x: number; y: number }>();
  for (const id of pointIds) {
    const p = doc.points.get(id);
    if (p) points.set(id, { x: p.x, y: p.y });
  }
  const radii = new Map<Id, number>();
  for (const id of circleIds) {
    const e = doc.entities.get(id);
    if (e?.kind === 'circle') radii.set(id, e.radius);
  }
  return { points, radii };
}

export function restoreGeometry(doc: DocumentModel, state: GeometryState): void {
  for (const [id, v] of state.points) {
    const p = doc.points.get(id);
    if (p) {
      p.x = v.x;
      p.y = v.y;
    }
  }
  for (const [id, r] of state.radii) {
    const e = doc.entities.get(id);
    if (e?.kind === 'circle') e.radius = r;
  }
}

/** Sets geometry to a captured state (used for solver results and constrained drags). */
export class SetGeometry implements Command {
  constructor(
    readonly label: string,
    private readonly before: GeometryState,
    private readonly after: GeometryState,
  ) {}

  apply(doc: DocumentModel): void {
    restoreGeometry(doc, this.after);
  }

  revert(doc: DocumentModel): void {
    restoreGeometry(doc, this.before);
  }
}

/** Sets or clears a dimension's driving value. */
export class SetDimensionValue implements Command {
  readonly label = '치수 값 변경';
  constructor(
    private readonly id: Id,
    private readonly before: number | undefined,
    private readonly after: number | undefined,
  ) {}

  apply(doc: DocumentModel): void {
    this.set(doc, this.after);
  }

  revert(doc: DocumentModel): void {
    this.set(doc, this.before);
  }

  private set(doc: DocumentModel, v: number | undefined): void {
    const e = doc.entities.get(this.id);
    if (e?.kind !== 'dimension') return;
    if (v === undefined) delete e.value;
    else e.value = v;
  }
}

export class MovePoints implements Command {
  readonly label = '이동';
  constructor(
    private readonly ids: Id[],
    private readonly delta: Vec2,
  ) {}

  apply(doc: DocumentModel): void {
    doc.translatePoints(this.ids, this.delta);
  }

  revert(doc: DocumentModel): void {
    doc.translatePoints(this.ids, { x: -this.delta.x, y: -this.delta.y });
  }
}

type HistoryListener = () => void;

export class History {
  private done: Command[] = [];
  private undone: Command[] = [];
  private listeners = new Set<HistoryListener>();

  constructor(
    private readonly doc: DocumentModel,
    private readonly limit = 500,
  ) {}

  onChange(fn: HistoryListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get canUndo(): boolean {
    return this.done.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  execute(cmd: Command): void {
    cmd.apply(this.doc);
    this.record(cmd);
  }

  /** Records a command whose effect is already in the document (e.g. after a live drag). */
  record(cmd: Command): void {
    this.done.push(cmd);
    if (this.done.length > this.limit) this.done.shift();
    this.undone = [];
    this.doc.changed();
    this.emit();
  }

  undo(): void {
    const cmd = this.done.pop();
    if (!cmd) return;
    cmd.revert(this.doc);
    this.undone.push(cmd);
    this.doc.changed();
    this.emit();
  }

  redo(): void {
    const cmd = this.undone.pop();
    if (!cmd) return;
    cmd.apply(this.doc);
    this.done.push(cmd);
    this.doc.changed();
    this.emit();
  }

  clear(): void {
    this.done = [];
    this.undone = [];
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

/** Changes the offset of dimension entities (moving a dimension line without moving what it measures). */
export class SetDimensionOffsets implements Command {
  readonly label = '치수선 이동';
  constructor(private readonly changes: { id: Id; before: number; after: number }[]) {}

  apply(doc: DocumentModel): void {
    this.set(doc, 'after');
  }

  revert(doc: DocumentModel): void {
    this.set(doc, 'before');
  }

  private set(doc: DocumentModel, which: 'before' | 'after'): void {
    for (const c of this.changes) {
      const e = doc.entities.get(c.id);
      if (e?.kind === 'dimension') e.offset = c[which];
    }
  }
}

/** Several commands recorded as one undo step. */
export class Batch implements Command {
  constructor(
    readonly label: string,
    private readonly commands: Command[],
  ) {}

  apply(doc: DocumentModel): void {
    for (const c of this.commands) c.apply(doc);
  }

  revert(doc: DocumentModel): void {
    for (const c of [...this.commands].reverse()) c.revert(doc);
  }
}

/** Changes a constraint's value (e.g. a radius). */
export class SetConstraintValue implements Command {
  readonly label = '구속 값 변경';
  constructor(
    private readonly id: Id,
    private readonly before: number | undefined,
    private readonly after: number | undefined,
  ) {}

  apply(doc: DocumentModel): void {
    const c = doc.constraints.get(this.id);
    if (c) c.value = this.after;
  }

  revert(doc: DocumentModel): void {
    const c = doc.constraints.get(this.id);
    if (c) c.value = this.before;
  }
}

/** Replaces entities' properties (layer, tag, rotation…) with new versions of the same entities. */
export class UpdateEntities implements Command {
  private readonly before: Entity[];
  private readonly after: Entity[];
  constructor(
    readonly label: string,
    before: Entity[],
    after: Entity[],
  ) {
    // Copies: the live entities may be edited in place later (e.g. a dimension offset drag).
    this.before = before.map((e) => ({ ...e }));
    this.after = after.map((e) => ({ ...e }));
  }

  apply(doc: DocumentModel): void {
    doc.addEntities(this.after);
  }

  revert(doc: DocumentModel): void {
    doc.addEntities(this.before);
  }
}

/** Replaces the whole layer table. Layer edits are rare and small, so a snapshot is simplest. */
export class SetLayers implements Command {
  constructor(
    readonly label: string,
    private readonly before: Layer[],
    private readonly after: Layer[],
  ) {}

  apply(doc: DocumentModel): void {
    replace(doc.layers, this.after);
  }

  revert(doc: DocumentModel): void {
    replace(doc.layers, this.before);
  }
}

/** Replaces the equipment library; instances pick up a changed size or name from it. */
export class SetEquipmentTypes implements Command {
  constructor(
    readonly label: string,
    private readonly before: EquipmentType[],
    private readonly after: EquipmentType[],
  ) {}

  apply(doc: DocumentModel): void {
    replace(doc.equipmentTypes, this.after);
  }

  revert(doc: DocumentModel): void {
    replace(doc.equipmentTypes, this.before);
  }
}

function replace<T extends { id: Id }>(map: Map<Id, T>, items: T[]): void {
  map.clear();
  for (const it of items) map.set(it.id, { ...it });
}

/** Adds, changes or removes the underlay image. */
export class SetUnderlay implements Command {
  constructor(
    readonly label: string,
    private readonly before: Underlay | null,
    private readonly after: Underlay | null,
  ) {}

  apply(doc: DocumentModel): void {
    doc.underlay = this.after ? { ...this.after } : null;
  }

  revert(doc: DocumentModel): void {
    doc.underlay = this.before ? { ...this.before } : null;
  }
}
