/**
 * @file corners.ts
 *
 * 2D CAD corner and vertex editing (the user's request, 2026-11-15): fillet ("필렛", a round corner), chamfer
 * ("모따기", a cut corner), inserting a vertex on an edge ("버텍스 추가") and removing one ("버텍스 삭제").
 *
 * Drawings are made of straight lines that share points (a shape is a loop of lines), so a fillet is a chain of
 * short lines along the arc, fine enough to look round (about every 10°), rather than a separate arc object; areas,
 * borders, 3D walls and DXF/SVG export then keep working unchanged. The new lines copy the style, layer and height
 * of the corner's first line, and every shape built on the corner gets the new points and edges in loop order.
 * Every operation returns one undoable Command, or a Korean message saying why it can't be done.
 * DOM-free. Related: src/model/edit.ts (other editing operations), src/ui ribbon "편집".
 */
import { type Vec2, add, dot, scale, sub } from '../geom/vec';
import { AddItems, Batch, type Command, RemoveEntities, SetPoints, UpdateEntities } from './commands';
import { type DocumentModel, cloneEntity } from './document';
import { newId } from './ids';
import type { Entity, Id, LineEntity, Point, ShapeEntity } from './types';

export type CornerMode = 'fillet' | 'chamfer';

/** Largest angle (radians) one line of a fillet spans. */
const FILLET_STEP = Math.PI / 18;
/** Shortest piece (mm) an edit may leave of a line. */
const MIN_PIECE = 1e-3;

const unit = (d: Vec2): Vec2 => {
  const l = Math.hypot(d.x, d.y) || 1;
  return { x: d.x / l, y: d.y / l };
};
const other = (l: LineEntity, pid: Id) => (l.p1 === pid ? l.p2 : l.p1);

interface Corner {
  /** Line on one side of the corner and the line on the other. */
  l1: LineEntity;
  l2: LineEntity;
  /** Their far ends. */
  a: Id;
  b: Id;
  shapes: ShapeEntity[];
}

/**
 * The two lines meeting at a point, if the point is a plain corner: exactly two lines, nothing else built on it but
 * shapes, and no constraint on the point itself (a fixed or coincident point must stay where it is).
 */
function cornerAt(doc: DocumentModel, pid: Id): Corner | string {
  if (!doc.points.has(pid)) return '꼭짓점을 선택하십시오(선의 중간점은 해당되지 않습니다).';
  const users = doc.pointUsers(pid);
  if (!users.every((e) => doc.isEditable(e))) return '잠겼거나 보이지 않는 객체의 꼭짓점입니다.';
  const lines = users.filter((e): e is LineEntity => e.kind === 'line');
  const rest = users.filter((e) => e.kind !== 'line' && e.kind !== 'shape');
  if (lines.length !== 2 || rest.length > 0) return '두 선이 만나는 꼭짓점에만 쓸 수 있습니다(치수·점 객체가 붙은 점이나 세 선 이상이 만나는 점은 제외).';
  if (doc.constraintsOn([pid]).length > 0) return '고정·일치 구속이 걸린 꼭짓점입니다. 구속을 해제한 뒤 다시 하십시오.';
  const [l1, l2] = lines;
  const a = other(l1, pid);
  const b = other(l2, pid);
  if (a === b) return '두 선이 같은 두 점을 잇고 있습니다.';
  const shapes = users.filter((e): e is ShapeEntity => e.kind === 'shape');
  return { l1, l2, a, b, shapes };
}

/** Largest fillet radius or chamfer distance a corner takes (mm), or 0 when it can't be rounded. */
export function maxCornerSize(doc: DocumentModel, pid: Id, mode: CornerMode): number {
  const c = cornerAt(doc, pid);
  if (typeof c === 'string') return 0;
  const p = doc.point(pid);
  const la = Math.hypot(doc.point(c.a).x - p.x, doc.point(c.a).y - p.y);
  const lb = Math.hypot(doc.point(c.b).x - p.x, doc.point(c.b).y - p.y);
  const t = Math.min(la, lb);
  if (mode === 'chamfer') return t;
  const theta = Math.acos(Math.max(-1, Math.min(1, dot(unit(sub(doc.point(c.a), p)), unit(sub(doc.point(c.b), p))))));
  return t * Math.tan(theta / 2);
}

/**
 * Rounds (fillet, `size` = radius) or cuts (chamfer, `size` = distance along each edge) the corner at point `pid`.
 * The corner point moves to the start of the cut on its first line and new points and lines continue to the second.
 */
export function editCorner(doc: DocumentModel, pid: Id, mode: CornerMode, size: number): Command | string {
  if (!(size > 0) || !Number.isFinite(size)) return mode === 'fillet' ? '반지름은 0보다 커야 합니다.' : '모따기 거리는 0보다 커야 합니다.';
  const c = cornerAt(doc, pid);
  if (typeof c === 'string') return c;
  const p = doc.point(pid);
  const A = doc.point(c.a);
  const B = doc.point(c.b);
  const u = unit(sub(A, p));
  const v = unit(sub(B, p));
  const theta = Math.acos(Math.max(-1, Math.min(1, dot(u, v))));
  if (theta < 1e-3 || theta > Math.PI - 1e-3) return '두 선이 일직선이거나 겹쳐 있어 모서리가 없습니다.';
  const t = mode === 'fillet' ? size / Math.tan(theta / 2) : size;
  const la = Math.hypot(A.x - p.x, A.y - p.y);
  const lb = Math.hypot(B.x - p.x, B.y - p.y);
  if (t > Math.min(la, lb) - MIN_PIECE) {
    const max = Math.floor(maxCornerSize(doc, pid, mode) * 10) / 10;
    return `${mode === 'fillet' ? '반지름' : '거리'}이 변보다 깁니다. 이 모서리는 최대 ${max} mm까지 됩니다.`;
  }
  const t1 = add(p, scale(u, t));
  const t2 = add(p, scale(v, t));
  // Points after the moved corner point, ending with the cut's end on the second line.
  const path: Vec2[] = [];
  if (mode === 'fillet') {
    const centre = add(p, scale(unit(add(u, v)), size / Math.sin(theta / 2)));
    const a1 = Math.atan2(t1.y - centre.y, t1.x - centre.x);
    let sweep = Math.atan2(t2.y - centre.y, t2.x - centre.x) - a1;
    while (sweep > Math.PI) sweep -= 2 * Math.PI;
    while (sweep < -Math.PI) sweep += 2 * Math.PI;
    const n = Math.max(2, Math.ceil(Math.abs(sweep) / FILLET_STEP));
    for (let k = 1; k < n; k++) path.push({ x: centre.x + Math.cos(a1 + (sweep * k) / n) * size, y: centre.y + Math.sin(a1 + (sweep * k) / n) * size });
  }
  path.push(t2);
  const z = p.z;
  const fresh: Point[] = path.map((q) => ({ id: newId('p'), x: q.x, y: q.y, ...(z ? { z } : {}) }));
  const chain = [pid, ...fresh.map((q) => q.id)];
  const style = c.l1;
  const lines: LineEntity[] = [];
  for (let k = 0; k + 1 < chain.length; k++) {
    const l: LineEntity = { ...cloneEntity(style), id: newId('e'), p1: chain[k], p2: chain[k + 1] };
    delete l.name;
    delete l.binding;
    lines.push(l);
  }
  const end = chain[chain.length - 1];
  const l2 = cloneEntity(c.l2);
  if (l2.p1 === pid) l2.p1 = end;
  else l2.p2 = end;
  const shapes = c.shapes.map((s) => {
    const out = cloneEntity(s);
    const i = out.points.indexOf(pid);
    const len = out.points.length;
    // Coming from the first line's side, the loop runs corner → arc → second line; otherwise the other way round.
    const forward = out.edges[(i - 1 + len) % len] === c.l1.id;
    out.points.splice(i, 1, ...(forward ? chain : [...chain].reverse()));
    out.edges.splice(i, 0, ...(forward ? lines : [...lines].reverse()).map((l) => l.id));
    return out;
  });
  const label = mode === 'fillet' ? '필렛' : '모따기';
  const before = SetPoints.capture(doc, [pid]);
  const after = new Map([[pid, { x: t1.x, y: t1.y, ...(z ? { z } : {}) }]]);
  return new Batch(label, [new AddItems(fresh, lines), new SetPoints(label, before, after), new UpdateEntities(label, [c.l2, ...c.shapes], [l2, ...shapes])]);
}

/**
 * Splits a line at the point of it nearest `at` ("버텍스 추가"): the line keeps its start and ends at the new point,
 * and a copy runs on to the old end. Shapes built on the line get the new corner too.
 */
export function insertVertex(doc: DocumentModel, lineId: Id, at: Vec2): { command: Command; point: Id } | string {
  const line = doc.entities.get(lineId);
  if (line?.kind !== 'line') return '꼭짓점을 넣을 선을 고르십시오.';
  if (!doc.isEditable(line)) return '잠겼거나 보이지 않는 선입니다.';
  const a = doc.point(line.p1);
  const b = doc.point(line.p2);
  const d = sub(b, a);
  const len2 = dot(d, d);
  if (!(len2 > 0)) return '길이가 없는 선입니다.';
  const t = Math.max(0, Math.min(1, dot(sub(at, a), d) / len2));
  const len = Math.sqrt(len2);
  if (t * len < MIN_PIECE || (1 - t) * len < MIN_PIECE) return '선의 끝점에는 꼭짓점을 넣을 수 없습니다.';
  const za = a.z ?? 0;
  const zb = b.z ?? 0;
  const z = za + (zb - za) * t;
  const q: Point = { id: newId('p'), x: a.x + d.x * t, y: a.y + d.y * t, ...(z ? { z } : {}) };
  const rest: LineEntity = { ...cloneEntity(line), id: newId('e'), p1: q.id, p2: line.p2 };
  delete rest.name;
  delete rest.binding;
  const first = { ...cloneEntity(line), p2: q.id };
  const shapes = doc.shapesUsing([lineId]).map((s) => {
    const out = cloneEntity(s);
    const k = out.edges.indexOf(lineId);
    out.points.splice(k + 1, 0, q.id);
    // Walking the loop from the line's start: first piece, then the rest; from its end: the other way round.
    if (out.points[k] === line.p1) out.edges.splice(k + 1, 0, rest.id);
    else out.edges.splice(k, 1, rest.id, lineId);
    return out;
  });
  const before: Entity[] = [line, ...doc.shapesUsing([lineId])];
  return { command: new Batch('꼭짓점 추가', [new AddItems([q], [rest]), new UpdateEntities('꼭짓점 추가', before, [first, ...shapes])]), point: q.id };
}

/**
 * Removes a corner where two lines meet ("버텍스 삭제"): the first line runs straight on to the second line's far end
 * and the second line goes. A shape keeps at least three corners.
 */
export function removeVertex(doc: DocumentModel, pid: Id): Command | string {
  const c = cornerAt(doc, pid);
  if (typeof c === 'string') return c;
  if (c.shapes.some((s) => s.points.length <= 3)) return '도형에는 꼭짓점이 세 개 이상 있어야 합니다.';
  const l1 = cloneEntity(c.l1);
  if (l1.p1 === pid) l1.p1 = c.b;
  else l1.p2 = c.b;
  const shapes = c.shapes.map((s) => {
    const out = cloneEntity(s);
    const i = out.points.indexOf(pid);
    const len = out.points.length;
    const prev = (i - 1 + len) % len;
    out.edges[prev] = c.l1.id;
    out.edges[i] = c.l1.id;
    out.edges.splice(i, 1);
    out.points.splice(i, 1);
    return out;
  });
  return new Batch('꼭짓점 삭제', [new UpdateEntities('꼭짓점 삭제', [c.l1, ...c.shapes], [l1, ...shapes]), new RemoveEntities([c.l2.id])]);
}
