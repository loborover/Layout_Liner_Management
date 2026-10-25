/**
 * @file edit.ts
 *
 * Higher-level editing operations that build commands: array copy, rotation, move to layer, equipment tag numbering.
 */
import type { Vec2 } from '../geom/vec';
import {
  AddConstraints,
  AddItems,
  Batch,
  type Command,
  SetGeometry,
  UpdateEntities,
  captureGeometry,
} from './commands';
import type { DocumentModel } from './document';
import { newId } from './ids';
import type { Constraint, Entity, EquipmentType, Id, Point } from './types';

/** Next free tag for a type, e.g. "MC-4" after "MC-1".."MC-3". `taken` holds tags handed out but not yet in the document. */
export function nextTag(doc: DocumentModel, type: EquipmentType, taken: Set<string> = new Set()): string {
  const prefix = type.prefix || type.name;
  const used = new Set(taken);
  for (const e of doc.entities.values()) if (e.kind === 'equipment') used.add(e.tag);
  let n = 1;
  while (used.has(`${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
}

/**
 * Copies entities once per offset. Points shared inside the selection stay shared in each copy, and
 * constraints entirely within the selection are copied with it, so a constrained room copies as one.
 * New equipment gets fresh tags. Returns null when there is nothing to copy.
 */
export function copyItems(doc: DocumentModel, entityIds: Id[], offsets: Vec2[]): Command | null {
  const entities = entityIds.flatMap((id) => {
    const e = doc.entities.get(id);
    return e ? [e] : [];
  });
  if (entities.length === 0 || offsets.length === 0) return null;
  const pointIds = [...new Set(entities.flatMap((e) => doc.pointIdsOf(e)))];
  const inside = new Set<Id>([...entities.map((e) => e.id), ...pointIds]);
  const constraints = [...doc.constraints.values()].filter((c) => c.refs.every((r) => inside.has(r)));

  const points: Point[] = [];
  const copies: Entity[] = [];
  const copiedConstraints: Constraint[] = [];
  const tags = new Set<string>();
  for (const d of offsets) {
    const map = new Map<Id, Id>();
    for (const id of pointIds) {
      const p = doc.point(id);
      const q = { id: newId('p'), x: p.x + d.x, y: p.y + d.y };
      map.set(id, q.id);
      points.push(q);
    }
    for (const e of entities) {
      const id = newId('e');
      map.set(e.id, id);
      const m = (pid: Id) => map.get(pid)!;
      let copy: Entity;
      if (e.kind === 'circle') copy = { ...e, id, center: m(e.center) };
      else if (e.kind === 'equipment') {
        const type = doc.equipmentTypes.get(e.type);
        const tag = type ? nextTag(doc, type, tags) : e.tag;
        tags.add(tag);
        copy = { ...e, id, at: m(e.at), tag };
      } else copy = { ...e, id, p1: m(e.p1), p2: m(e.p2) };
      copies.push(copy);
    }
    for (const c of constraints) copiedConstraints.push({ ...c, id: newId('k'), refs: c.refs.map((r) => map.get(r)!) });
  }
  const steps: Command[] = [new AddItems(points, copies)];
  if (copiedConstraints.length > 0) steps.push(new AddConstraints(copiedConstraints));
  return new Batch('배열 복사', steps);
}

/** Offsets of a rows × columns rectangular array, without the original at (0, 0). */
export function arrayOffsets(columns: number, rows: number, dx: number, dy: number): Vec2[] {
  const out: Vec2[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) if (r !== 0 || c !== 0) out.push({ x: c * dx, y: r * dy });
  }
  return out;
}

/**
 * Rotates the selection by `deg` (counter-clockwise). Equipment on its own turns in place; anything else turns
 * as a group about the middle of its bounding box. Returns an error message for constrained geometry, whose
 * horizontal/vertical constraints a rotation would break.
 */
export function rotateItems(doc: DocumentModel, entityIds: Id[], deg: number): Command | string | null {
  const entities = entityIds.flatMap((id) => {
    const e = doc.entities.get(id);
    return e ? [e] : [];
  });
  if (entities.length === 0) return null;
  const pointIds = [...new Set(entities.flatMap((e) => doc.pointIdsOf(e)))];
  const equipment = entities.filter((e) => e.kind === 'equipment');
  const turned = equipment.map((e) => ({ ...e, rotation: normalizeDeg(e.rotation + deg) }));
  const steps: Command[] = [new UpdateEntities('회전', equipment, turned)];
  if (equipment.length < entities.length) {
    // Equipment turning in place moves no points, so only a group rotation can break constraints.
    if (doc.constraintsOn([...entityIds, ...pointIds]).length > 0) return '구속된 객체는 회전할 수 없습니다. 구속을 해제한 뒤 회전해 주세요.';
    const boxes = entities.map((e) => doc.bboxOf(e));
    const c = {
      x: (Math.min(...boxes.map((b) => b.minX)) + Math.max(...boxes.map((b) => b.maxX))) / 2,
      y: (Math.min(...boxes.map((b) => b.minY)) + Math.max(...boxes.map((b) => b.maxY))) / 2,
    };
    const before = captureGeometry(doc, pointIds);
    const r = (deg * Math.PI) / 180;
    const after = captureGeometry(doc, []);
    for (const [id, p] of before.points) {
      const x = p.x - c.x;
      const y = p.y - c.y;
      after.points.set(id, { x: c.x + x * Math.cos(r) - y * Math.sin(r), y: c.y + x * Math.sin(r) + y * Math.cos(r) });
    }
    steps.push(new SetGeometry('회전', before, after));
  }
  return new Batch('회전', steps);
}

const normalizeDeg = (d: number) => {
  const n = ((d % 360) + 360) % 360;
  return Math.abs(n - 360) < 1e-9 ? 0 : n;
};

/** Moves entities to another layer. */
export function moveToLayer(doc: DocumentModel, entityIds: Id[], layer: Id): Command | null {
  const before = entityIds.flatMap((id) => {
    const e = doc.entities.get(id);
    return e && e.layer !== layer ? [e] : [];
  });
  if (before.length === 0) return null;
  return new UpdateEntities('레이어 변경', before, before.map((e) => ({ ...e, layer })));
}
