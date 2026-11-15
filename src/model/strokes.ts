/**
 * @file strokes.ts
 *
 * Geometry of styled lines ("선 양식", borders): the band of `stroke.width` mm laid inside, centred on, or outside the
 * drawn reference line, as used for walls and floor markings. "Inside" is towards the interior of the shape the
 * line belongs to, or the left of p1 → p2 for a free line.
 *
 * Where two bands with the same width and alignment meet (a shared point, or points held together by a coincident
 * constraint), the corner is built as a proper offset of the corner, split between the two lines along the
 * corner's bisector (the user's request, 2026-11-15):
 * - on the inner side of the turn the offset edges are cut exactly where they cross, however sharp the corner, so
 *   an inside band never pokes out past the reference line (and an outside band never into the shape);
 * - on the outer side of the turn the band is closed by the line's `join`: a sharp mitre (cut to a chamfer when it
 *   would run past MITER_LIMIT band widths), a round arc, or a chamfer (bevel).
 * The reference line itself is never crossed: offset 0 always meets exactly at the corner point.
 * A band's polygon therefore has two points per end for a plain end and more at a round or chamfered corner.
 *
 * The results are cached per document revision (drags call `doc.changed()`), so the renderer, SVG/DXF export,
 * 3D scene and picking can ask for every band each frame. DOM-free.
 */
import { type Vec2, add, dot, scale, sub } from '../geom/vec';
import { polygonArea } from '../geom/polygon';
import type { DocumentModel } from './document';
import type { Id, LineEntity, StrokeJoin, StrokeStyle } from './types';

/** Mitres longer than this many band widths are cut to a chamfer (very sharp outer corners). */
export const MITER_LIMIT = 4;
/** Largest angle step (radians) between the points of a round join. */
const ROUND_STEP = Math.PI / 18;
/** Points closer than this (mm) count as the same corner when they are not literally shared. */
const SAME_PLACE = 1e-3;

const left = (d: Vec2): Vec2 => ({ x: -d.y, y: d.x });
const cross = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x;
const unit = (d: Vec2): Vec2 => {
  const l = Math.hypot(d.x, d.y) || 1;
  return { x: d.x / l, y: d.y / l };
};

/** Offsets of the band's two long edges, measured towards the inside. */
export function bandOffsets(s: StrokeStyle): [number, number] {
  if (s.align === 'inside') return [0, s.width];
  if (s.align === 'outside') return [-s.width, 0];
  return [-s.width / 2, s.width / 2];
}

/** How a border's outer corners are closed; a sharp mitre when unset. */
export function strokeJoin(s: StrokeStyle): StrokeJoin {
  return s.join ?? 'miter';
}

const sameStyle = (a?: StrokeStyle, b?: StrokeStyle) => !!a && !!b && a.width === b.width && a.align === b.align;

/** Intersection of the lines p + t·d and q + s·e, or null when (nearly) parallel. */
function intersect(p: Vec2, d: Vec2, q: Vec2, e: Vec2): Vec2 | null {
  const den = d.x * e.y - d.y * e.x;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((q.x - p.x) * e.y - (q.y - p.y) * e.x) / den;
  return add(p, scale(d, t));
}

interface Frame {
  line: LineEntity;
  a: Vec2;
  b: Vec2;
  dir: Vec2;
  len: number;
  /** Unit normal pointing to the inside. */
  inside: Vec2;
}

const placeKey = (p: Vec2) => `${Math.round(p.x / SAME_PLACE)},${Math.round(p.y / SAME_PLACE)}`;

/** Band polygons of every styled line with a width, keyed by line id. */
export class StrokeGeometry {
  private rev = -1;
  private bands = new Map<Id, Vec2[]>();

  constructor(private readonly doc: DocumentModel) {}

  /**
   * The band of a line as a polygon, or undefined when unstyled. It starts with the start corner on offset u1, runs
   * along u1 to the end, across the end (u1 → u2, through any join points), back along u2 and across the start: for
   * a plain band that is the quadrilateral (start-u1, end-u1, end-u2, start-u2).
   */
  band(id: Id): Vec2[] | undefined {
    this.ensure();
    return this.bands.get(id);
  }

  all(): ReadonlyMap<Id, Vec2[]> {
    this.ensure();
    return this.bands;
  }

  private ensure(): void {
    if (this.rev === this.doc.rev) return;
    this.rev = this.doc.rev;
    this.bands.clear();
    const { doc } = this;
    const frames = new Map<Id, Frame>();
    const byPoint = new Map<Id, Frame[]>();
    const byPlace = new Map<string, Frame[]>();
    // Inside side of shape edges: interior is left of the loop direction for a counter-clockwise loop.
    const insideSign = new Map<Id, number>();
    for (const e of doc.entities.values()) {
      if (e.kind !== 'shape') continue;
      const ccw = polygonArea(doc.shapePolygon(e)) > 0 ? 1 : -1;
      e.edges.forEach((edgeId, i) => {
        const line = doc.entities.get(edgeId);
        if (line?.kind !== 'line') return;
        const forward = line.p1 === e.points[i];
        if (!insideSign.has(edgeId)) insideSign.set(edgeId, ccw * (forward ? 1 : -1));
      });
    }
    const push = <K>(map: Map<K, Frame[]>, k: K, f: Frame) => {
      const list = map.get(k);
      if (list) list.push(f);
      else map.set(k, [f]);
    };
    for (const e of doc.entities.values()) {
      if (e.kind !== 'line' || !e.stroke || !(e.stroke.width > 0)) continue;
      const a = doc.points.get(e.p1);
      const b = doc.points.get(e.p2);
      if (!a || !b) continue;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (!(len > 0)) continue;
      const dir = unit(sub(b, a));
      const f: Frame = { line: e, a, b, dir, len, inside: scale(left(dir), insideSign.get(e.id) ?? 1) };
      frames.set(e.id, f);
      push(byPoint, e.p1, f);
      push(byPoint, e.p2, f);
      push(byPlace, placeKey(a), f);
      push(byPlace, placeKey(b), f);
    }
    for (const f of frames.values()) {
      const cuts = [0, 1].map((end) => {
        const p = end === 0 ? f.a : f.b;
        const pid = end === 0 ? f.line.p1 : f.line.p2;
        // The neighbour: the one other band on this very point, else the one other band at this place (a point of
        // another object held here by a coincident constraint). Three or more bands meeting are left square.
        const shared = (byPoint.get(pid) ?? []).filter((o) => o !== f);
        const near = shared.length > 0 ? shared : (byPlace.get(placeKey(p)) ?? []).filter((o) => o !== f);
        const n = near.length === 1 && sameStyle(near[0].line.stroke, f.line.stroke) ? near[0] : null;
        return this.cut(f, p, end === 0, n);
      });
      const [start, end] = cuts;
      this.bands.set(f.line.id, [start[0], ...end, ...start.slice(1).reverse()]);
    }
  }

  /**
   * Points across one end of a band, from offset u1 to offset u2. Without a neighbour the end is square. With one,
   * each offset is closed against the neighbour's same offset: exactly where they cross on the inner side of the
   * turn, by the join on the outer side; every point beyond the line's own edge lies on the corner's bisector, so
   * the neighbour's band continues seamlessly.
   */
  private cut(f: Frame, p: Vec2, isStart: boolean, n: Frame | null): Vec2[] {
    const s = f.line.stroke!;
    const [u1, u2] = bandOffsets(s);
    const square = (u: number) => add(p, scale(f.inside, u));
    if (!n) return [square(u1), square(u2)];
    // Walk along f into the corner, then along n out of it.
    const into = isStart ? scale(f.dir, -1) : f.dir;
    const nStartsHere = Math.hypot(n.a.x - p.x, n.a.y - p.y) <= Math.hypot(n.b.x - p.x, n.b.y - p.y);
    const out = nStartsHere ? n.dir : scale(n.dir, -1);
    // Both lines must agree which side is inside (a free line drawn the other way round does not).
    const sf = Math.sign(dot(f.inside, left(into)));
    const sn = Math.sign(dot(n.inside, left(out)));
    const turn = cross(into, out);
    if (sf === 0 || sf !== sn || dot(into, out) < -1 + 1e-9) return [square(u1), square(u2)];
    const pts: Vec2[][] = [u1, u2].map((u) => {
      if (u === 0 || Math.abs(turn) < 1e-12) return [square(u)];
      const nf = scale(f.inside, Math.sign(u));
      const nn = scale(n.inside, Math.sign(u));
      const sq = square(u);
      const qn = add(p, scale(n.inside, u));
      const inner = Math.sign(u) * sf === Math.sign(turn);
      const m = intersect(sq, f.dir, qn, n.dir);
      if (inner) {
        // Exact crossing of the two offset edges; only a corner sharper than the lines are long is left square.
        if (!m) return [sq];
        const back = dot(sub(p, m), into);
        const ahead = dot(sub(m, p), out);
        return back <= f.len && ahead <= n.len ? [m] : [sq];
      }
      const bisector = unit(add(nf, nn));
      const r = Math.abs(u);
      let join = strokeJoin(s);
      if (join === 'miter' && (!m || Math.hypot(m.x - p.x, m.y - p.y) > MITER_LIMIT * r)) join = 'bevel';
      if (join === 'miter') return [m!];
      if (join === 'bevel') return [sq, add(p, scale(add(nf, nn), r / 2))];
      // Round: arc of radius |u| about the corner from the line's own edge to the bisector.
      const a0 = Math.atan2(nf.y, nf.x);
      let sweep = Math.atan2(bisector.y, bisector.x) - a0;
      while (sweep > Math.PI) sweep -= 2 * Math.PI;
      while (sweep < -Math.PI) sweep += 2 * Math.PI;
      const steps = Math.max(1, Math.ceil(Math.abs(sweep) / ROUND_STEP));
      const arc: Vec2[] = [];
      for (let k = 0; k <= steps; k++) {
        const t = a0 + (sweep * k) / steps;
        arc.push({ x: p.x + Math.cos(t) * r, y: p.y + Math.sin(t) * r });
      }
      return arc;
    });
    // u1's points run from its own edge to the bisector; u2's from the bisector back to its edge.
    return [...pts[0], ...pts[1].reverse()];
  }
}
