/**
 * @file dimensions.ts
 *
 * Dimensional constraints ('distance' and 'angle'): which selections they can be made from, what they measure on
 * the current geometry, how the solver should orient an angle, and where their dimension lines and values are
 * drawn. Pure functions of the document, shared by the solver, the renderer, the select tool and the ribbon
 * command, so all of them agree on what a dimension constraint means. No DOM.
 * Related: src/constraints/solver.ts, src/view/renderer.ts, src/tools/select.ts, docs/DATA_MODEL.md.
 */
import { type Vec2, add, dot, len, scale, sub } from '../geom/vec';
import type { DocumentModel } from '../model/document';
import type { Constraint, Id, LineEntity } from '../model/types';

/** Lines whose directions differ by less than this (sine of the angle) count as parallel for a line-to-line distance. */
const PARALLEL_SIN = Math.sin((1 * Math.PI) / 180);

/** Points closer than this (mm) count as the same corner when orienting an angle. */
const SAME_POINT = 1e-6;

export type DimensionPick = { ok: true; refs: Id[]; value: number } | { ok: false; message: string };

/** The stored points and lines of a selection: point objects stand for their point, a midpoint can't be used. */
export function pickedGeometry(doc: DocumentModel, selected: readonly Id[]): { points: Id[]; lines: Id[]; other: number } {
  const points: Id[] = [];
  const lines: Id[] = [];
  let other = 0;
  for (const id of selected) {
    const e = doc.entities.get(id);
    if (doc.points.has(id)) points.push(id);
    else if (e?.kind === 'point') points.push(e.at);
    else if (e?.kind === 'line') lines.push(id);
    else other++;
  }
  return { points: [...new Set(points)], lines: [...new Set(lines)], other };
}

function line(doc: DocumentModel, id: Id): LineEntity | null {
  const e = doc.entities.get(id);
  return e?.kind === 'line' ? e : null;
}

/** Unit direction of a line and its length. */
function direction(doc: DocumentModel, l: LineEntity): { u: Vec2; length: number } {
  const v = sub(doc.point(l.p2), doc.point(l.p1));
  const length = len(v);
  return { u: length === 0 ? { x: 1, y: 0 } : scale(v, 1 / length), length };
}

/** Foot of the perpendicular from `p` on the infinite line through `l`. */
export function footOnLine(doc: DocumentModel, p: Vec2, l: LineEntity): Vec2 {
  const a = doc.point(l.p1);
  const { u } = direction(doc, l);
  return add(a, scale(u, dot(sub(p, a), u)));
}

/** Distance from `p` to the infinite line through `l`. */
function pointLineDistance(doc: DocumentModel, p: Vec2, l: LineEntity): number {
  return len(sub(p, footOnLine(doc, p, l)));
}

/**
 * How an angle between two lines is measured: each line becomes an arm running away from where the lines meet
 * (a shared or coincident corner, else the intersection of their extensions; for parallel lines, as drawn).
 * `degrees` is the angle between the arms (0..180) and `sign` the turn from arm A to arm B (+1 counter-clockwise),
 * which the solver keeps so solving never flips the geometry to the mirror solution.
 */
export interface AngleArms {
  a: [Id, Id];
  b: [Id, Id];
  /** Where the arms start: the corner, or null for parallel lines. */
  vertex: Vec2 | null;
  degrees: number;
  sign: 1 | -1;
}

export function angleArms(doc: DocumentModel, la: LineEntity, lb: LineEntity): AngleArms {
  const [a1, a2, b1, b2] = [la.p1, la.p2, lb.p1, lb.p2].map((id) => doc.point(id));
  let vertex: Vec2 | null = null;
  // A corner the lines already share wins over the intersection (it is the same place, but exact).
  for (const p of [a1, a2]) for (const q of [b1, b2]) if (!vertex && len(sub(p, q)) <= SAME_POINT) vertex = p;
  if (!vertex) {
    const r = sub(a2, a1);
    const s = sub(b2, b1);
    const cross = r.x * s.y - r.y * s.x;
    if (Math.abs(cross) > 1e-12 * (len(r) * len(s) || 1)) {
      const t = ((b1.x - a1.x) * s.y - (b1.y - a1.y) * s.x) / cross;
      vertex = add(a1, scale(r, t));
    }
  }
  const arm = (l: LineEntity, p: Vec2, q: Vec2): [Id, Id] => {
    if (!vertex) return [l.p1, l.p2];
    return len(sub(p, vertex)) <= len(sub(q, vertex)) ? [l.p1, l.p2] : [l.p2, l.p1];
  };
  const a = arm(la, a1, a2);
  const b = arm(lb, b1, b2);
  const ua = sub(doc.point(a[1]), doc.point(a[0]));
  const ub = sub(doc.point(b[1]), doc.point(b[0]));
  const cross = ua.x * ub.y - ua.y * ub.x;
  const degrees = (Math.atan2(Math.abs(cross), dot(ua, ub)) * 180) / Math.PI;
  return { a, b, vertex, degrees, sign: cross < 0 ? -1 : 1 };
}

/** What a dimensional constraint measures on the current geometry (mm or degrees); NaN when its refs are gone. */
export function measureDimension(doc: DocumentModel, c: Constraint): number {
  if (c.kind === 'angle') {
    const [la, lb] = c.refs.map((id) => line(doc, id));
    return la && lb ? angleArms(doc, la, lb).degrees : NaN;
  }
  if (c.kind !== 'distance') return NaN;
  const [r1, r2] = c.refs;
  const l1 = line(doc, r1);
  const l2 = line(doc, r2);
  if (!l1 && !l2) {
    if (!doc.points.has(r1) || !doc.points.has(r2)) return NaN;
    return len(sub(doc.point(r2), doc.point(r1)));
  }
  if (!l1 && l2) return doc.points.has(r1) ? pointLineDistance(doc, doc.point(r1), l2) : NaN;
  if (l1 && l2) return pointLineDistance(doc, doc.point(l2.p1), l1);
  return NaN;
}

/**
 * Refs and current value of a distance constraint for a selection: two points, a point and a line, or two
 * parallel lines. A user error comes back as a message.
 */
export function distanceFromSelection(doc: DocumentModel, selected: readonly Id[]): DimensionPick {
  const { points, lines, other } = pickedGeometry(doc, selected);
  const usage = '거리 구속: 점 두 개, 점 하나와 선 하나, 또는 평행한 선 두 개를 선택하십시오(Shift+클릭).';
  if (other > 0 || points.length + lines.length !== 2) return { ok: false, message: usage };
  let refs: Id[];
  if (points.length === 2) refs = points;
  else if (points.length === 1) {
    const l = line(doc, lines[0])!;
    if (l.p1 === points[0] || l.p2 === points[0]) return { ok: false, message: '선의 끝점과 그 선 사이의 거리는 항상 0입니다. 다른 점을 선택하십시오.' };
    refs = [points[0], lines[0]];
  } else {
    const [la, lb] = lines.map((id) => line(doc, id)!);
    const ua = direction(doc, la).u;
    const ub = direction(doc, lb).u;
    if (Math.abs(ua.x * ub.y - ua.y * ub.x) > PARALLEL_SIN) {
      return { ok: false, message: '두 선이 평행하지 않습니다. 평행 구속을 먼저 걸거나, 각도 구속을 쓰십시오.' };
    }
    refs = lines;
  }
  const value = measureDimension(doc, { id: '', kind: 'distance', refs });
  if (!(value > 0.5)) return { ok: false, message: '선택한 점·선이 이미 겹쳐 있습니다. 거리가 0인 조건은 일치 구속을 쓰십시오.' };
  return { ok: true, refs, value };
}

/** Refs and current value of an angle constraint for a selection of two lines. */
export function angleFromSelection(doc: DocumentModel, selected: readonly Id[]): DimensionPick {
  const { points, lines, other } = pickedGeometry(doc, selected);
  if (other > 0 || points.length > 0 || lines.length !== 2) return { ok: false, message: '각도 구속: 선 두 개를 선택하십시오(Shift+클릭).' };
  const [la, lb] = lines.map((id) => line(doc, id)!);
  const { degrees } = angleArms(doc, la, lb);
  if (!(degrees > 0.01 && degrees < 179.99)) {
    return { ok: false, message: '두 선이 평행합니다. 평행한 선 사이에는 거리 구속을 쓰십시오.' };
  }
  return { ok: true, refs: lines, value: degrees };
}

/** Screen-size choices for drawing dimension constraints, in mm at the current zoom. */
export interface DimensionScale {
  /** Offset of a point-to-point dimension line from the points. */
  offset: number;
  /** Radius of an angle's arc. */
  arc: number;
}

/** Dimension constraints keep a constant size on screen: these are px, turned into mm for the current zoom. */
const OFFSET_PX = 22;
const ARC_PX = 28;

/** Screen-constant drawing sizes for a zoom where one screen pixel is `mmPerPx` mm. */
export const dimensionScale = (mmPerPx: number): DimensionScale => ({ offset: OFFSET_PX * mmPerPx, arc: ARC_PX * mmPerPx });

/**
 * The dimension constraint whose value label is under `at` (within `tolerance` mm), for double-click editing.
 * Labels are about 14 px tall, so the tolerance is a few pixels in mm.
 */
export function dimensionAt(doc: DocumentModel, at: Vec2, s: DimensionScale, tolerance: number): Constraint | null {
  let best: Constraint | null = null;
  let bestDistance = tolerance;
  for (const c of doc.constraints.values()) {
    if (!isDimensionConstraint(c) || !dimensionVisible(doc, c)) continue;
    const shape = dimensionShape(doc, c, s);
    if (!shape) continue;
    const d = len(sub(shape.label, at));
    if (d <= bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  return best;
}

/** Whether all the geometry a dimension constraint references is shown (layer, folder and floor visibility). */
export function dimensionVisible(doc: DocumentModel, c: Constraint): boolean {
  return c.refs.every((r) => {
    if (doc.points.has(r)) return doc.isPointVisible(r);
    const e = doc.entities.get(r);
    return !!e && doc.isVisible(e);
  });
}

/** Where a dimension constraint is drawn: a linear dimension (like the dimension object) or an arc. */
export type DimensionShape =
  | { kind: 'linear'; a: Vec2; b: Vec2; offset: number; label: Vec2 }
  | { kind: 'arc'; center: Vec2; radius: number; start: number; sweep: number; label: Vec2 }
  | { kind: 'text'; label: Vec2 };

/** Drawing geometry of a distance or angle constraint, or null when it isn't one (or its geometry is gone). */
export function dimensionShape(doc: DocumentModel, c: Constraint, s: DimensionScale): DimensionShape | null {
  if (c.kind === 'angle') {
    const [la, lb] = c.refs.map((id) => line(doc, id));
    if (!la || !lb) return null;
    const arms = angleArms(doc, la, lb);
    if (!arms.vertex) {
      // Parallel lines: no corner to draw an arc at; the value sits between the lines' midpoints.
      const mid = (l: LineEntity) => scale(add(doc.point(l.p1), doc.point(l.p2)), 0.5);
      return { kind: 'text', label: scale(add(mid(la), mid(lb)), 0.5) };
    }
    const dirA = sub(doc.point(arms.a[1]), doc.point(arms.a[0]));
    const start = Math.atan2(dirA.y, dirA.x);
    const sweep = (arms.sign * arms.degrees * Math.PI) / 180;
    const mid = start + sweep / 2;
    const r = s.arc * 1.6;
    const label = add(arms.vertex, { x: Math.cos(mid) * r, y: Math.sin(mid) * r });
    return { kind: 'arc', center: arms.vertex, radius: s.arc, start, sweep, label };
  }
  if (c.kind !== 'distance') return null;
  const [r1, r2] = c.refs;
  const l1 = line(doc, r1);
  const l2 = line(doc, r2);
  let a: Vec2;
  let b: Vec2;
  let offset = 0;
  if (!l1 && !l2) {
    if (!doc.points.has(r1) || !doc.points.has(r2)) return null;
    a = doc.point(r1);
    b = doc.point(r2);
    offset = s.offset;
  } else if (!l1 && l2) {
    if (!doc.points.has(r1)) return null;
    a = doc.point(r1);
    b = footOnLine(doc, a, l2);
  } else if (l1 && l2) {
    a = doc.point(l2.p1);
    b = footOnLine(doc, a, l1);
  } else return null;
  const d = sub(b, a);
  const l = len(d) || 1;
  const normal = { x: -d.y / l, y: d.x / l };
  const label = add(scale(add(a, b), 0.5), scale(normal, offset));
  return { kind: 'linear', a, b, offset, label };
}

/** Text shown for a dimension constraint's value. */
export function dimensionText(c: Constraint, formatLength: (mm: number) => string): string {
  const v = c.value ?? 0;
  return c.kind === 'angle' ? `${Math.round(v * 100) / 100}°` : formatLength(v);
}

/** Whether a constraint is a dimensional one (has a value the user edits and is drawn as a dimension). */
export const isDimensionConstraint = (c: Constraint): boolean => c.kind === 'distance' || c.kind === 'angle';
