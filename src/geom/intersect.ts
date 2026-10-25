/**
 * @file intersect.ts
 *
 * Pure intersection routines (segment/segment, segment/circle, circle/circle) used by the snap engine.
 */
import { type Vec2, dot, sub } from './vec';

const EPS = 1e-9;

/** Intersection point of segments ab and cd, or null. */
export function segmentSegment(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 | null {
  const r = sub(b, a);
  const s = sub(d, c);
  const denom = r.x * s.y - r.y * s.x;
  if (Math.abs(denom) < EPS) return null; // parallel or collinear
  const ac = sub(c, a);
  const t = (ac.x * s.y - ac.y * s.x) / denom;
  const u = (ac.x * r.y - ac.y * r.x) / denom;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  return { x: a.x + t * r.x, y: a.y + t * r.y };
}

/** Intersections of segment ab with the circle (centre c, radius rad). */
export function segmentCircle(a: Vec2, b: Vec2, c: Vec2, rad: number): Vec2[] {
  const d = sub(b, a);
  const f = sub(a, c);
  const A = dot(d, d);
  if (A < EPS) return [];
  const B = 2 * dot(f, d);
  const C = dot(f, f) - rad * rad;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return [];
  const sq = Math.sqrt(disc);
  const out: Vec2[] = [];
  for (const t of disc === 0 ? [-B / (2 * A)] : [(-B - sq) / (2 * A), (-B + sq) / (2 * A)]) {
    if (t >= -EPS && t <= 1 + EPS) out.push({ x: a.x + t * d.x, y: a.y + t * d.y });
  }
  return out;
}

/** Intersections of two circles. */
export function circleCircle(c1: Vec2, r1: number, c2: Vec2, r2: number): Vec2[] {
  const dx = c2.x - c1.x;
  const dy = c2.y - c1.y;
  const d = Math.hypot(dx, dy);
  if (d < EPS || d > r1 + r2 + EPS || d < Math.abs(r1 - r2) - EPS) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const mx = c1.x + (a * dx) / d;
  const my = c1.y + (a * dy) / d;
  if (h < EPS) return [{ x: mx, y: my }];
  return [
    { x: mx + (h * dy) / d, y: my - (h * dx) / d },
    { x: mx - (h * dy) / d, y: my + (h * dx) / d },
  ];
}
