/**
 * @file strokes.ts
 *
 * Geometry of styled lines ("선 양식"): the band of `stroke.width` mm laid inside, centred on, or outside the drawn
 * reference line, as used for walls. Neighbouring bands with the same style are mitred at shared points so
 * corners close cleanly. "Inside" is towards the interior of the shape the line belongs to, or the left of
 * p1 → p2 for a free line.
 *
 * The results are cached per document revision (drags call `doc.changed()`), so the renderer, SVG export and
 * picking can ask for every band each frame. DOM-free.
 */
import { type Vec2, add, dot, scale, sub } from '../geom/vec';
import { polygonArea } from '../geom/polygon';
import type { DocumentModel } from './document';
import type { Id, LineEntity, StrokeStyle } from './types';

/** Miters longer than this many band widths are cut square (very sharp corners). */
const MITER_LIMIT = 4;

const left = (d: Vec2): Vec2 => ({ x: -d.y, y: d.x });
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

const sameStyle = (a?: StrokeStyle, b?: StrokeStyle) => !!a && !!b && a.width === b.width && a.align === b.align;

/** Intersection of the lines p + t·d and q + s·e, or null when (nearly) parallel. */
function intersect(p: Vec2, d: Vec2, q: Vec2, e: Vec2): Vec2 | null {
  const den = d.x * e.y - d.y * e.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((q.x - p.x) * e.y - (q.y - p.y) * e.x) / den;
  return add(p, scale(d, t));
}

interface Frame {
  line: LineEntity;
  a: Vec2;
  b: Vec2;
  dir: Vec2;
  /** Unit normal pointing to the inside. */
  inside: Vec2;
}

/** Band polygons of every styled line with a width, keyed by line id. */
export class StrokeGeometry {
  private rev = -1;
  private bands = new Map<Id, Vec2[]>();

  constructor(private readonly doc: DocumentModel) {}

  /** The band of a line as a quadrilateral (start-u1, end-u1, end-u2, start-u2), or undefined when unstyled. */
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
    const atPoint = new Map<Id, Frame[]>();
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
    for (const e of doc.entities.values()) {
      if (e.kind !== 'line' || !e.stroke || !(e.stroke.width > 0)) continue;
      const a = doc.points.get(e.p1);
      const b = doc.points.get(e.p2);
      if (!a || !b || (a.x === b.x && a.y === b.y)) continue;
      const dir = unit(sub(b, a));
      const f: Frame = { line: e, a, b, dir, inside: scale(left(dir), insideSign.get(e.id) ?? 1) };
      frames.set(e.id, f);
      for (const p of [e.p1, e.p2]) atPoint.set(p, [...(atPoint.get(p) ?? []), f]);
    }
    for (const f of frames.values()) {
      const [u1, u2] = bandOffsets(f.line.stroke!);
      const ends = [f.line.p1, f.line.p2].map((pid, end) => {
        const p = end === 0 ? f.a : f.b;
        const others = (atPoint.get(pid) ?? []).filter((o) => o !== f);
        const n = others.length === 1 && sameStyle(others[0].line.stroke, f.line.stroke) ? others[0] : null;
        return [u1, u2].map((u) => this.corner(f, p, pid, end === 0, n, u, f.line.stroke!.width));
      });
      this.bands.set(f.line.id, [ends[0][0], ends[1][0], ends[1][1], ends[0][1]]);
    }
  }

  /** Band corner at one end of a line, mitred with its neighbour when their inside sides agree. */
  private corner(f: Frame, p: Vec2, pid: Id, isStart: boolean, n: Frame | null, u: number, width: number): Vec2 {
    const square = add(p, scale(f.inside, u));
    if (!n) return square;
    // Walk along f into the shared point, then along n out of it; compare which side is "inside" for each.
    const into = isStart ? scale(f.dir, -1) : f.dir;
    const out = n.line.p1 === pid ? n.dir : scale(n.dir, -1);
    const sf = Math.sign(dot(f.inside, left(into)));
    const sn = Math.sign(dot(n.inside, left(out)));
    if (sf !== sn) return square;
    const q = add(n.line.p1 === pid ? n.a : n.b, scale(n.inside, u));
    const m = intersect(square, f.dir, q, n.dir);
    if (!m || Math.hypot(m.x - p.x, m.y - p.y) > MITER_LIMIT * Math.max(width, Math.abs(u))) return square;
    return m;
  }
}
