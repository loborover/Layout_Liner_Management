/**
 * @file polygon.ts
 *
 * Pure polygon measures (signed area, perimeter) used by the area tool and shapes.
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
