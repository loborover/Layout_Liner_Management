/**
 * @file edit.ts
 *
 * Higher-level editing operations that build commands: array copy and duplication with unique names, rotation, move
 * to layer (also across floors), equipment tag numbering.
 */
import type { Vec2 } from '../geom/vec';
import {
  AddConstraints,
  AddItems,
  Batch,
  type Command,
  RemoveConstraints,
  ReorderEntities,
  SetGeometry,
  UpdateEntities,
  captureGeometry,
} from './commands';
import { type DocumentModel, cloneEntity } from './document';
import { newId } from './ids';
import type { Constraint, Entity, EquipmentType, Id, LineEntity, Point, ShapeEntity } from './types';

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
 * A name not yet in `taken`: the name itself if free, else "이름 (2)", "이름 (3)"… A trailing " (n)" is treated as
 * an earlier copy number, so copying "벽 (2)" gives "벽 (3)" rather than "벽 (2) (2)".
 */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const base = name.replace(/ \((\d+)\)$/, '');
  let n = 2;
  while (taken.has(`${base} (${n})`)) n++;
  return `${base} (${n})`;
}

/** Names of every entity in the drawing (all floors), for handing out unique names. */
function entityNames(doc: DocumentModel): Set<string> {
  const names = new Set<string>();
  for (const e of doc.entities.values()) if (e.name) names.add(e.name);
  return names;
}

/** Options of {@link duplicateItems}. */
export interface DuplicateOptions {
  /** Layer the copies go on; each copy keeps its original's layer when absent. */
  layer?: Id;
  /** Undo label; '배열 복사' when absent. */
  label?: string;
}

/**
 * Copies entities once per offset. Points shared inside the selection stay shared in each copy, and
 * constraints entirely within the selection are copied with it, so a constrained room copies as one.
 * Every copy keeps its original's properties (style, fill, label, height, binding…) but gets a name of its own:
 * a named object's copy is renamed "이름 (2)" and so on, so no two objects share a name (the user's rule,
 * 2026-11-15); new equipment gets fresh tags. `ids` lists, per offset, the copies of the given ids (a shape's
 * edges, copied along with it, are not listed). Returns null when there is nothing to copy.
 */
export function duplicateItems(doc: DocumentModel, entityIds: Id[], offsets: Vec2[], options: DuplicateOptions = {}): { command: Command; ids: Id[] } | null {
  // A shape copies with its edge lines, or the copy would reference the original's lines.
  const ids = new Set(entityIds);
  for (const id of entityIds) {
    const e = doc.entities.get(id);
    if (e?.kind === 'shape') for (const edge of e.edges) ids.add(edge);
  }
  const entities = [...doc.entities.values()].filter((e) => ids.has(e.id));
  if (entities.length === 0 || offsets.length === 0) return null;
  const pointIds = [...new Set(entities.flatMap((e) => doc.pointIdsOf(e)))];
  const inside = new Set<Id>([...entities.map((e) => e.id), ...pointIds]);
  const constraints = [...doc.constraints.values()].filter((c) => c.refs.every((r) => inside.has(r)));
  const requested = new Set(entityIds);

  const points: Point[] = [];
  const copies: Entity[] = [];
  const copiedConstraints: Constraint[] = [];
  const copyIds: Id[] = [];
  const tags = new Set<string>();
  const names = entityNames(doc);
  for (const d of offsets) {
    const map = new Map<Id, Id>();
    for (const id of pointIds) {
      const p = doc.point(id);
      const q = { id: newId('p'), x: p.x + d.x, y: p.y + d.y, ...(p.z ? { z: p.z } : {}) };
      map.set(id, q.id);
      points.push(q);
    }
    // Ids first, so a shape can map edges that come after it in the document.
    for (const e of entities) map.set(e.id, newId('e'));
    for (const e of entities) {
      const id = map.get(e.id)!;
      const m = (pid: Id) => map.get(pid)!;
      let copy: Entity;
      if (e.kind === 'circle') copy = { ...cloneEntity(e), id, center: m(e.center) };
      else if (e.kind === 'point') copy = { ...e, id, at: m(e.at) };
      else if (e.kind === 'label') copy = { ...cloneEntity(e), id, at: m(e.at) };
      else if (e.kind === 'equipment') {
        const type = doc.equipmentTypes.get(e.type);
        const tag = type ? nextTag(doc, type, tags) : e.tag;
        tags.add(tag);
        copy = { ...cloneEntity(e), id, at: m(e.at), tag };
      } else if (e.kind === 'shape') copy = { ...cloneEntity(e), id, points: e.points.map(m), edges: e.edges.map(m) };
      else copy = { ...cloneEntity(e), id, p1: m(e.p1), p2: m(e.p2) };
      if (copy.name) {
        copy.name = uniqueName(copy.name, names);
        names.add(copy.name);
      }
      if (options.layer) copy.layer = options.layer;
      copies.push(copy);
      if (requested.has(e.id)) copyIds.push(id);
    }
    for (const c of constraints) copiedConstraints.push({ ...c, id: newId('k'), refs: c.refs.map((r) => map.get(r)!) });
  }
  const label = options.label ?? '배열 복사';
  const steps: Command[] = [new AddItems(points, copies)];
  if (copiedConstraints.length > 0) steps.push(new AddConstraints(copiedConstraints));
  return { command: new Batch(label, steps), ids: copyIds };
}

/** {@link duplicateItems} as a single command (array copy). */
export function copyItems(doc: DocumentModel, entityIds: Id[], offsets: Vec2[]): Command | null {
  return duplicateItems(doc, entityIds, offsets)?.command ?? null;
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

/**
 * Moves objects to a layer, which may be on another floor (dragging them in the object tree onto a layer, folder or
 * floor). A shape takes its edge lines along, as a face can't be on another layer than its loop. When objects
 * leave their floor, points they share with objects staying behind are split off, so editing one floor never
 * moves geometry on another. Objects on locked or hidden layers are left where they are. Returns null when nothing moves.
 */
export function transferItems(doc: DocumentModel, entityIds: Id[], layer: Id): Command | null {
  const target = doc.layers.get(layer);
  if (!target) return null;
  // Objects on any floor can be moved from the tree, as long as their layer is on and unlocked. A shape goes with
  // its edges and an edge line with its shapes (and their other edges), so a face never splits across layers.
  const ids = new Set<Id>();
  const add = (e: Entity) => {
    if (ids.has(e.id) || !doc.isLayerOpen(e.layer)) return;
    ids.add(e.id);
    if (e.kind === 'shape') {
      for (const edge of e.edges) {
        const l = doc.entities.get(edge);
        if (l) add(l);
      }
    } else if (e.kind === 'line') for (const s of doc.shapesUsing([e.id])) add(s);
  };
  for (const id of entityIds) {
    const e = doc.entities.get(id);
    if (e) add(e);
  }
  const moving = [...doc.entities.values()].filter((e) => ids.has(e.id) && e.layer !== layer);
  if (moving.length === 0) return null;
  const leaving = moving.filter((e) => doc.floorOf(e) !== target.floor);
  // Points the leaving objects share with geometry that stays (dimensions measure, they don't hold points).
  const split = new Map<Id, Id>();
  const newPoints: Point[] = [];
  if (leaving.length > 0) {
    for (const pid of new Set(leaving.flatMap((e) => doc.pointIdsOf(e)))) {
      if (!doc.pointUsers(pid).some((u) => !ids.has(u.id) && u.kind !== 'dimension')) continue;
      const copy: Point = { ...doc.point(pid), id: newId('p') };
      newPoints.push(copy);
      split.set(pid, copy.id);
    }
  }
  const leavingIds = new Set(leaving.map((e) => e.id));
  const after = moving.map((e) => ({ ...(leavingIds.has(e.id) && split.size > 0 ? remapPoints(e, split) : cloneEntity(e)), layer }));
  const steps: Command[] = [];
  if (newPoints.length > 0) steps.push(new AddItems(newPoints, []));
  steps.push(new UpdateEntities('레이어 변경', moving, after));
  // A coincident constraint can't hold points on two floors together: one between a point that leaves and one
  // that stays comes off.
  if (leaving.length > 0) {
    const gone = new Set(leaving.flatMap((e) => doc.pointIdsOf(e)).filter((pid) => !split.has(pid)));
    const mixed = [...doc.constraints.values()].filter((c) => c.kind === 'coincident' && c.refs.some((r) => gone.has(r)) && c.refs.some((r) => !gone.has(r)));
    if (mixed.length > 0) steps.push(new RemoveConstraints(mixed.map((c) => c.id)));
  }
  return steps.length === 1 ? steps[0] : new Batch('레이어 변경', steps);
}

/**
 * Closed loops formed by the given lines through their shared points. Only connected groups where every point
 * joins exactly two of the lines count (a simple ring); branching groups are skipped as ambiguous.
 */
export function findLoops(doc: DocumentModel, lineIds: Iterable<Id>): { points: Id[]; edges: Id[] }[] {
  const lines = [...lineIds].flatMap((id) => {
    const e = doc.entities.get(id);
    return e?.kind === 'line' ? [e] : [];
  });
  const byPoint = new Map<Id, LineEntity[]>();
  for (const l of lines) {
    for (const p of [l.p1, l.p2]) byPoint.set(p, [...(byPoint.get(p) ?? []), l]);
  }
  const used = new Set<Id>();
  const loops: { points: Id[]; edges: Id[] }[] = [];
  for (const start of lines) {
    if (used.has(start.id)) continue;
    const points: Id[] = [start.p1];
    const edges: Id[] = [start.id];
    const group = new Set<Id>([start.id]);
    let at = start.p2;
    let prev = start;
    let ok = true;
    while (at !== start.p1) {
      const next = (byPoint.get(at) ?? []).filter((l) => l.id !== prev.id);
      if ((byPoint.get(at) ?? []).length !== 2 || next.length !== 1 || group.has(next[0].id)) {
        ok = false;
        break;
      }
      points.push(at);
      edges.push(next[0].id);
      group.add(next[0].id);
      prev = next[0];
      at = prev.p1 === at ? prev.p2 : prev.p1;
    }
    for (const id of group) used.add(id);
    if (ok && (byPoint.get(start.p1) ?? []).length === 2 && edges.length >= 3) loops.push({ points, edges });
  }
  return loops;
}

/**
 * Turns closed loops among the given lines into shapes ("닫힌 선 → 도형"), skipping loops that already are one.
 * The shape goes on the layer of its first line. Returns null when there is no new loop.
 */
export function makeShapes(doc: DocumentModel, lineIds: Iterable<Id>, name?: string): { command: Command; shapes: ShapeEntity[] } | null {
  const existing = new Set([...doc.entities.values()].flatMap((e) => (e.kind === 'shape' ? [[...e.edges].sort().join('|')] : [])));
  let n = [...doc.entities.values()].filter((e) => e.kind === 'shape').length;
  const shapes: ShapeEntity[] = findLoops(doc, lineIds)
    .filter((l) => !existing.has([...l.edges].sort().join('|')))
    .map((l) => ({
      id: newId('e'),
      kind: 'shape',
      points: l.points,
      edges: l.edges,
      layer: doc.entities.get(l.edges[0])!.layer,
      name: name ?? `도형 ${++n}`,
    }));
  if (shapes.length === 0) return null;
  return { command: new AddItems([], shapes), shapes };
}

export type ReorderMove = 'front' | 'back' | 'forward' | 'backward';

/** Moves entities in the drawing order: to the top or bottom, or one step past their neighbour. */
export function reorderItems(doc: DocumentModel, entityIds: Id[], move: ReorderMove): Command | null {
  const before = [...doc.entities.keys()];
  const sel = new Set(entityIds.filter((id) => doc.entities.has(id)));
  if (sel.size === 0) return null;
  let after: Id[];
  if (move === 'front') after = [...before.filter((id) => !sel.has(id)), ...before.filter((id) => sel.has(id))];
  else if (move === 'back') after = [...before.filter((id) => sel.has(id)), ...before.filter((id) => !sel.has(id))];
  else {
    after = [...before];
    const step = move === 'forward' ? 1 : -1;
    const idxs = after.map((id, i) => (sel.has(id) ? i : -1)).filter((i) => i >= 0);
    if (step > 0) idxs.reverse();
    for (const i of idxs) {
      const j = i + step;
      if (j < 0 || j >= after.length || sel.has(after[j])) continue;
      [after[i], after[j]] = [after[j], after[i]];
    }
  }
  if (after.every((id, i) => id === before[i])) return null;
  return new ReorderEntities('순서 변경', before, after);
}

/**
 * Entities removed when deleting a selection that may contain points (vertices): a selected point takes every
 * entity built on it with it (its lines, and through RemoveEntities their shapes), like deleting a vertex in CAD.
 */
export function deletionTargets(doc: DocumentModel, ids: Iterable<Id>): Id[] {
  const out = new Set<Id>();
  for (const id of ids) {
    if (doc.entities.has(id)) out.add(id);
    else if (doc.isVertex(id)) for (const e of doc.pointUsers(id)) if (doc.isEditable(e)) out.add(e.id);
  }
  return [...out];
}

/**
 * Shortest chain of existing lines from point `from` to point `to` (by length), for closing a loop with a new
 * segment `to` → `from`. Only lines `accept` allows are walked (editable lines on the active floor). Returns the
 * points and lines in walking order (points[0] = from, last point before `to`), or null when they are not connected.
 */
export function linePath(doc: DocumentModel, from: Id, to: Id, accept: (e: LineEntity) => boolean): { points: Id[]; edges: Id[] } | null {
  if (from === to) return null;
  const adj = new Map<Id, { line: LineEntity; other: Id; len: number }[]>();
  for (const e of doc.entities.values()) {
    if (e.kind !== 'line' || !accept(e)) continue;
    const a = doc.point(e.p1);
    const b = doc.point(e.p2);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    for (const [p, q] of [
      [e.p1, e.p2],
      [e.p2, e.p1],
    ]) {
      let list = adj.get(p);
      if (!list) adj.set(p, (list = []));
      list.push({ line: e, other: q, len });
    }
  }
  // Dijkstra; drawings are small enough that a linear scan for the next node is fine.
  const distTo = new Map<Id, number>([[from, 0]]);
  const prev = new Map<Id, { point: Id; line: Id }>();
  const done = new Set<Id>();
  while (true) {
    let cur: Id | null = null;
    let best = Infinity;
    for (const [id, d] of distTo) if (!done.has(id) && d < best) [cur, best] = [id, d];
    if (cur === null) return null;
    if (cur === to) break;
    done.add(cur);
    for (const { line, other, len } of adj.get(cur) ?? []) {
      const d = best + len;
      if (d < (distTo.get(other) ?? Infinity)) {
        distTo.set(other, d);
        prev.set(other, { point: cur, line: line.id });
      }
    }
  }
  const points: Id[] = [];
  const edges: Id[] = [];
  for (let at = to; at !== from; ) {
    const step = prev.get(at)!;
    edges.unshift(step.line);
    points.unshift(step.point);
    at = step.point;
  }
  return { points, edges };
}

/** Copy of an entity with point references renamed through `map` (ids not in the map stay). */
function remapPoints<T extends Entity>(e: T, map: ReadonlyMap<Id, Id>): T {
  const c = cloneEntity(e);
  const m = (id: Id) => map.get(id) ?? id;
  if (c.kind === 'line' || c.kind === 'dimension') {
    c.p1 = m(c.p1);
    c.p2 = m(c.p2);
  } else if (c.kind === 'circle') c.center = m(c.center);
  else if (c.kind === 'equipment' || c.kind === 'point' || c.kind === 'label') c.at = m(c.at);
  else if (c.kind === 'shape') c.points = c.points.map(m);
  return c;
}

/**
 * Objects that must keep sharing their points: a shape and its edge lines (a face needs its closed loop). Every
 * other entity is an object of its own. Returns the group key of each entity id.
 */
function objectGroups(doc: DocumentModel): Map<Id, Id> {
  const group = new Map<Id, Id>();
  for (const e of doc.entities.values()) {
    if (e.kind !== 'shape') continue;
    // A line shared by two shapes (drawn with Ctrl) ties those shapes together too.
    const key = e.edges.map((id) => group.get(id)).find((g) => g !== undefined) ?? e.id;
    group.set(e.id, key);
    for (const id of e.edges) group.set(id, key);
  }
  return group;
}

/**
 * "분리": makes the selected objects (or the objects at the selected points) independent of each other, so each
 * can be moved on its own (the user's request, 2026-11-15). A point shared by several objects is split into one
 * point per object (a shape keeps one point with its own edges); coincident constraints on the selected points are
 * removed. Selecting an object detaches that object from its neighbours; selecting a point separates everything at
 * that point. Dimensions stay attached to the geometry they measure. Returns null when nothing is shared.
 */
export function detachPoints(doc: DocumentModel, ids: Iterable<Id>): Command | null {
  const groups = objectGroups(doc);
  const groupOf = (e: Entity) => groups.get(e.id) ?? e.id;
  /** Point → the group that must get a copy of it (null: every group but the first). */
  const targets = new Map<Id, Set<Id> | null>();
  for (const id of ids) {
    const e = doc.entities.get(id);
    if (e) {
      if (!doc.isEditable(e)) continue;
      const g = groupOf(e);
      const members = [...doc.entities.values()].filter((x) => groupOf(x) === g);
      for (const m of members) {
        for (const pid of doc.pointIdsOf(m)) {
          const t = targets.get(pid);
          if (t === null) continue;
          targets.set(pid, (t ?? new Set()).add(g));
        }
      }
    } else if (doc.isVertex(id) && doc.isPointEditable(id)) {
      for (const pid of doc.vertexPoints(id)) targets.set(pid, null);
    }
  }
  if (targets.size === 0) return null;

  const newPoints: Point[] = [];
  const maps = new Map<Id, Map<Id, Id>>(); // group → old point → new point
  for (const [pid, wanted] of targets) {
    const users = doc.pointUsers(pid);
    // Dimensions measure geometry: they follow the first other object at the point.
    const geometry = users.filter((e) => e.kind !== 'dimension');
    const order = [...new Set(geometry.map(groupOf))];
    if (order.length < 2) continue;
    let movers = wanted === null ? order.slice(1) : order.filter((g) => wanted.has(g));
    // When every object at the point is selected, the first keeps the point.
    if (movers.length === order.length) movers = movers.slice(1);
    for (const g of movers) {
      const p = doc.point(pid);
      const copy: Point = { ...p, id: newId('p') };
      newPoints.push(copy);
      let m = maps.get(g);
      if (!m) maps.set(g, (m = new Map()));
      m.set(pid, copy.id);
    }
  }
  const before: Entity[] = [];
  const after: Entity[] = [];
  for (const e of doc.entities.values()) {
    const m = maps.get(groupOf(e));
    if (!m || !doc.pointIdsOf(e).some((pid) => m.has(pid))) continue;
    before.push(e);
    after.push(remapPoints(e, m));
  }

  const steps: Command[] = [];
  if (newPoints.length > 0) steps.push(new AddItems(newPoints, []), new UpdateEntities('점 분리', before, after));
  // Coincident constraints on the targeted points come off; a constraint left with fewer than two points goes.
  const loose = new Set(targets.keys());
  const removed: Id[] = [];
  const kept: Constraint[] = [];
  for (const c of doc.constraints.values()) {
    if (c.kind !== 'coincident' || !c.refs.some((r) => loose.has(r))) continue;
    removed.push(c.id);
    const rest = c.refs.filter((r) => !loose.has(r));
    if (rest.length >= 2) kept.push({ ...c, id: newId('k'), refs: rest });
  }
  if (removed.length > 0) steps.push(new RemoveConstraints(removed));
  if (kept.length > 0) steps.push(new AddConstraints(kept));
  return steps.length > 0 ? new Batch('점 분리', steps) : null;
}

/** Where objects are dropped in the object tree: a floor, a folder or a layer. */
export interface TreeDropTarget {
  kind: 'floor' | 'folder' | 'layer';
  id: Id;
}

/**
 * Layer that objects dropped on a tree node go to: the layer itself; for a folder or a floor, the current layer
 * when it is in there, else its first layer (for a floor, preferring layers outside folders). Null when the
 * folder has no layer.
 */
export function layerForDrop(doc: DocumentModel, target: TreeDropTarget, current: Id): Id | null {
  if (target.kind === 'layer') return doc.layers.has(target.id) ? target.id : null;
  const layers = [...doc.layers.values()];
  const inside = target.kind === 'folder' ? layers.filter((l) => l.folder === target.id) : layers.filter((l) => l.floor === target.id);
  if (inside.some((l) => l.id === current)) return current;
  if (target.kind === 'floor') return (inside.find((l) => !l.folder) ?? inside[0])?.id ?? null;
  return inside[0]?.id ?? null;
}

/**
 * Command that edits copies of entities as they are in the document now, looked up by id. Panels must use this
 * rather than copying the entity objects they were built from: every command replaces entity objects, so those
 * may be out of date, and an edit made from them would silently undo whatever changed since (the cause of label
 * rows changing or vanishing when another field was edited, reported 2026-11-15). Null when none still exists.
 */
export function editEntities(doc: DocumentModel, label: string, ids: Iterable<Id>, edit: (e: Entity) => void): Command | null {
  const before = [...ids].flatMap((id) => {
    const e = doc.entities.get(id);
    return e ? [e] : [];
  });
  if (before.length === 0) return null;
  const after = before.map((e) => {
    const c = cloneEntity(e);
    edit(c);
    return c;
  });
  return new UpdateEntities(label, before, after);
}
