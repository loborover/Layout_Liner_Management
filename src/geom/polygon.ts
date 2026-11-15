/**
 * @file polygon.ts
 *
 * Pure polygon measures (signed area, perimeter, centroid) used by the area tool and shapes, and where a shape's
 * label goes (the area centroid, or the deepest inside point of a concave shape).
 */
import type { Vec2 } from './vec';

/** Signed area of a polygon (positive when counter-clockwise), shoelace formula. */
export function polygonArea(pts: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    s += p.x * q.y - q.x * p.y;
  }
  return s / 2;
}

export function polygonPerimeter(pts: Vec2[], closed = true): number {
  let s = 0;
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    s += Math.hypot(q.x - p.x, q.y - p.y);
  }
  return s;
}

/** Whether p lies inside a simple polygon (even-odd rule; any orientation). */
export function insidePolygon(p: Vec2, pts: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Area centroid of a simple polygon; the vertex average when it has no area. */
export function polygonCentroid(pts: Vec2[]): Vec2 {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    const w = p.x * q.y - q.x * p.y;
    a += w;
    cx += (p.x + q.x) * w;
    cy += (p.y + q.y) * w;
  }
  if (Math.abs(a) < 1e-9) {
    const n = pts.length || 1;
    return { x: pts.reduce((s, p) => s + p.x, 0) / n, y: pts.reduce((s, p) => s + p.y, 0) / n };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

/** Distance from p to the nearest edge of a closed polygon. */
function distToOutline(p: Vec2, pts: Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t));
  }
  return best;
}

/**
 * Where a label belongs in a polygon: its area centroid, unless that falls outside (an L or U shape), in which case
 * the inside point farthest from the outline found on a coarse-to-fine grid (a simple "pole of inaccessibility").
 */
export function polygonLabelPoint(pts: Vec2[]): Vec2 {
  const c = polygonCentroid(pts);
  if (pts.length < 3 || insidePolygon(c, pts)) return c;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  let minX = Math.min(...xs);
  let maxX = Math.max(...xs);
  let minY = Math.min(...ys);
  let maxY = Math.max(...ys);
  let best = c;
  let bestD = -1;
  for (let round = 0; round < 4; round++) {
    const N = 16;
    const sx = (maxX - minX) / N;
    const sy = (maxY - minY) / N;
    for (let i = 0; i <= N; i++) {
      for (let j = 0; j <= N; j++) {
        const q = { x: minX + sx * i, y: minY + sy * j };
        if (!insidePolygon(q, pts)) continue;
        const d = distToOutline(q, pts);
        if (d > bestD) [best, bestD] = [q, d];
      }
    }
    if (bestD < 0) return c;
    // Look again more finely around the best point so far.
    [minX, maxX, minY, maxY] = [best.x - sx * 2, best.x + sx * 2, best.y - sy * 2, best.y + sy * 2];
  }
  return best;
}
