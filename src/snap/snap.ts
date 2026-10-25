/**
 * @file snap.ts
 *
 * Snap engine: object snaps (endpoint, midpoint, centre, quadrant, intersection, perpendicular), polar/ortho
 * tracking and grid snapping. Given a raw cursor position it returns the snapped point and why.
 */
import { type Vec2, add, closestOnSegment, dist, dot, scale, sub } from '../geom/vec';
import type { DocumentModel } from '../model/document';
import type { SpatialIndex } from '../model/spatial';
import type { Entity, Id } from '../model/types';
import { edgesOf } from '../geom/equipment';
import { circleCircle, segmentCircle, segmentSegment } from '../geom/intersect';

export type ObjectSnapKind = 'endpoint' | 'intersection' | 'center' | 'midpoint' | 'quadrant' | 'perpendicular';
export type SnapKind = ObjectSnapKind | 'ortho' | 'polar' | 'grid';

export interface SnapResult {
  point: Vec2;
  kind: SnapKind;
  /** Existing document point at this location (endpoints and centres), so tools can connect to it. */
  pointId?: Id;
  /** Alignment guide to draw for ortho/polar tracking. */
  guide?: { from: Vec2; angleDeg: number };
}

export interface SnapSettings {
  object: boolean;
  polar: boolean;
  grid: boolean;
  /** Polar tracking increment in degrees. */
  polarStep: number;
}

export interface SnapQuery {
  /** Base point of the current operation (start of a line, move base), enabling perpendicular/ortho/polar. */
  from?: Vec2 | null;
  /** Shift held: constrain to horizontal/vertical from `from`. */
  ortho?: boolean;
  /** Entities to ignore (e.g. those being moved). */
  exclude?: ReadonlySet<Id>;
  /**
   * Ctrl held: snap only to existing points of visible objects (line ends, shape corners, circle centres), even
   * when object snap is off, and never to the grid or tracking, so the new geometry connects to them.
   */
  pointsOnly?: boolean;
}

export const SNAP_LABELS: Record<SnapKind, string> = {
  endpoint: '끝점',
  intersection: '교차점',
  center: '중심',
  midpoint: '중점',
  quadrant: '사분점',
  perpendicular: '수직',
  ortho: '직교',
  polar: '극좌표',
  grid: '그리드',
};

// Lower wins when several object snaps are within reach.
const PRIORITY: Record<ObjectSnapKind, number> = {
  endpoint: 0,
  intersection: 1,
  center: 2,
  midpoint: 2,
  quadrant: 3,
  perpendicular: 4,
};

interface Candidate {
  point: Vec2;
  kind: ObjectSnapKind;
  pointId?: Id;
}

export class SnapEngine {
  constructor(
    private readonly doc: DocumentModel,
    private readonly index: SpatialIndex,
  ) {}

  /**
   * Resolves the cursor position. Order: object snaps, then ortho (Shift), polar tracking, grid, raw cursor.
   * `tol` is the reach in mm; `gridStep` the current grid spacing in mm.
   */
  snap(raw: Vec2, tol: number, gridStep: number, settings: SnapSettings, q: SnapQuery = {}): SnapResult | null {
    if (q.pointsOnly) return this.objectSnap(raw, tol * 1.5, q);
    if (settings.object) {
      const hit = this.objectSnap(raw, tol, q);
      if (hit) return hit;
    }
    const from = q.from;
    if (from && q.ortho) {
      const d = sub(raw, from);
      const angleDeg = Math.abs(d.x) >= Math.abs(d.y) ? (d.x >= 0 ? 0 : 180) : d.y >= 0 ? 90 : 270;
      return this.alongRay(from, angleDeg, raw, settings.grid ? gridStep : 0, 'ortho');
    }
    if (from && settings.polar && dist(raw, from) > tol) {
      const angle = (Math.atan2(raw.y - from.y, raw.x - from.x) * 180) / Math.PI;
      const snapped = Math.round(angle / settings.polarStep) * settings.polarStep;
      const dir = { x: Math.cos((snapped * Math.PI) / 180), y: Math.sin((snapped * Math.PI) / 180) };
      const v = sub(raw, from);
      if (Math.abs(v.x * dir.y - v.y * dir.x) <= tol) {
        return this.alongRay(from, ((snapped % 360) + 360) % 360, raw, settings.grid ? gridStep : 0, 'polar');
      }
    }
    if (settings.grid && gridStep > 0) {
      return {
        point: { x: Math.round(raw.x / gridStep) * gridStep, y: Math.round(raw.y / gridStep) * gridStep },
        kind: 'grid',
      };
    }
    return null;
  }

  private alongRay(from: Vec2, angleDeg: number, raw: Vec2, step: number, kind: 'ortho' | 'polar'): SnapResult {
    const rad = (angleDeg * Math.PI) / 180;
    const dir = { x: Math.cos(rad), y: Math.sin(rad) };
    let t = dot(sub(raw, from), dir);
    if (step > 0) t = Math.round(t / step) * step;
    return { point: add(from, scale(dir, t)), kind, guide: { from, angleDeg } };
  }

  private objectSnap(raw: Vec2, tol: number, q: SnapQuery): SnapResult | null {
    const near = this.index
      .query({ minX: raw.x - tol, minY: raw.y - tol, maxX: raw.x + tol, maxY: raw.y + tol })
      // Shapes snap through their edge lines.
      .filter((e) => e.kind !== 'dimension' && e.kind !== 'shape' && !q.exclude?.has(e.id) && this.visible(e));

    const candidates: Candidate[] = [];
    for (const e of near) this.collect(e, q.from ?? null, candidates);
    for (let i = 0; i < near.length; i++) {
      for (let j = i + 1; j < near.length; j++) {
        for (const point of this.intersections(near[i], near[j])) candidates.push({ point, kind: 'intersection' });
      }
    }

    let best: Candidate | null = null;
    let bestD = Infinity;
    for (const c of candidates) {
      if (q.pointsOnly && !c.pointId) continue;
      const d = dist(c.point, raw);
      if (d > tol) continue;
      if (!best || PRIORITY[c.kind] < PRIORITY[best.kind] || (PRIORITY[c.kind] === PRIORITY[best.kind] && d < bestD)) {
        best = c;
        bestD = d;
      }
    }
    return best ? { point: { ...best.point }, kind: best.kind, pointId: best.pointId } : null;
  }

  private visible(e: Entity): boolean {
    return this.doc.isVisible(e);
  }

  private collect(e: Entity, from: Vec2 | null, out: Candidate[]): void {
    const { doc } = this;
    if (e.kind === 'point') {
      const p = doc.point(e.at);
      out.push({ point: p, kind: 'endpoint', pointId: p.id });
    } else if (e.kind === 'line') {
      const a = doc.point(e.p1);
      const b = doc.point(e.p2);
      out.push({ point: a, kind: 'endpoint', pointId: a.id });
      out.push({ point: b, kind: 'endpoint', pointId: b.id });
      out.push({ point: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, kind: 'midpoint' });
      if (from) {
        const foot = closestOnSegment(from, a, b);
        // Only a true perpendicular foot, not a clamped segment end.
        if (dist(foot, a) > 1e-9 && dist(foot, b) > 1e-9) out.push({ point: foot, kind: 'perpendicular' });
      }
    } else if (e.kind === 'equipment') {
      // Footprint corners and edge midpoints snap, but never hand out the equipment's own point:
      // a line drawn from its centre shouldn't drag along when the equipment moves.
      const cs = doc.cornersOf(e);
      out.push({ point: { ...doc.point(e.at) }, kind: 'center' });
      for (const [a, b] of edgesOf(cs)) {
        out.push({ point: a, kind: 'endpoint' });
        out.push({ point: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, kind: 'midpoint' });
        if (from) {
          const foot = closestOnSegment(from, a, b);
          if (dist(foot, a) > 1e-9 && dist(foot, b) > 1e-9) out.push({ point: foot, kind: 'perpendicular' });
        }
      }
    } else if (e.kind === 'circle') {
      const c = doc.point(e.center);
      const r = e.radius;
      out.push({ point: c, kind: 'center', pointId: c.id });
      for (const [dx, dy] of [
        [r, 0],
        [0, r],
        [-r, 0],
        [0, -r],
      ]) {
        out.push({ point: { x: c.x + dx, y: c.y + dy }, kind: 'quadrant' });
      }
      if (from) {
        const d = dist(from, c);
        if (d > 1e-9) out.push({ point: add(c, scale(sub(from, c), r / d)), kind: 'perpendicular' });
      }
    }
  }

  /** Straight edges of an entity, for intersections. */
  private segments(e: Entity): [Vec2, Vec2][] {
    if (e.kind === 'line') return [[this.doc.point(e.p1), this.doc.point(e.p2)]];
    if (e.kind === 'equipment') return edgesOf(this.doc.cornersOf(e));
    return [];
  }

  private intersections(e1: Entity, e2: Entity): Vec2[] {
    const { doc } = this;
    if (e1.kind === 'equipment' || e2.kind === 'equipment') {
      const out: Vec2[] = [];
      const other = e1.kind === 'equipment' ? e2 : e1;
      const edges = this.segments(e1.kind === 'equipment' ? e1 : e2);
      for (const [a, b] of edges) {
        if (other.kind === 'circle') out.push(...segmentCircle(a, b, doc.point(other.center), other.radius));
        for (const [c, d] of this.segments(other)) {
          const p = segmentSegment(a, b, c, d);
          if (p) out.push(p);
        }
      }
      return out;
    }
    if (e1.kind === 'line' && e2.kind === 'line') {
      const p = segmentSegment(doc.point(e1.p1), doc.point(e1.p2), doc.point(e2.p1), doc.point(e2.p2));
      return p ? [p] : [];
    }
    if (e1.kind === 'line' && e2.kind === 'circle') {
      return segmentCircle(doc.point(e1.p1), doc.point(e1.p2), doc.point(e2.center), e2.radius);
    }
    if (e1.kind === 'circle' && e2.kind === 'line') return this.intersections(e2, e1);
    if (e1.kind === 'circle' && e2.kind === 'circle') {
      return circleCircle(doc.point(e1.center), e1.radius, doc.point(e2.center), e2.radius);
    }
    return [];
  }
}
