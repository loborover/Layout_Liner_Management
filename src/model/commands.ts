import type { Vec2 } from '../geom/vec';
import type { DocumentModel } from './document';
import type { Entity, Id, Point } from './types';

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

/** Removes entities and any points left without an entity. */
export class RemoveEntities implements Command {
  readonly label = '삭제';
  private removedEntities: Entity[] = [];
  private removedPoints: Point[] = [];

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
  }

  revert(doc: DocumentModel): void {
    doc.addPoints(this.removedPoints);
    doc.addEntities(this.removedEntities);
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
