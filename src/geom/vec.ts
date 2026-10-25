/**
 * @file vec.ts
 *
 * 2D vector and axis-aligned box helpers shared by every module. World units are millimetres, Y up.
 */
export interface Vec2 {
  x: number;
  y: number;
}

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const vec = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Angle of the vector a→b in degrees, counter-clockwise from +X (world Y is up). */
export function angleDeg(a: Vec2, b: Vec2): number {
  const deg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  return deg < 0 ? deg + 360 : deg;
}

/** Closest point to p on segment ab. */
export function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 === 0) return { ...a };
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  return add(a, scale(ab, t));
}

export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  return dist(p, closestOnSegment(p, a, b));
}

export function boxFromPoints(a: Vec2, b: Vec2): Box {
  return {
    minX: Math.min(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxX: Math.max(a.x, b.x),
    maxY: Math.max(a.y, b.y),
  };
}

export function boxContainsBox(outer: Box, inner: Box): boolean {
  return (
    inner.minX >= outer.minX &&
    inner.maxX <= outer.maxX &&
    inner.minY >= outer.minY &&
    inner.maxY <= outer.maxY
  );
}

export function boxContainsPoint(b: Box, p: Vec2): boolean {
  return p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY;
}

export function boxesOverlap(a: Box, b: Box): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const cross = (o: Vec2, p: Vec2, q: Vec2) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  const onSeg = (o: Vec2, p: Vec2, q: Vec2) =>
    Math.min(o.x, p.x) <= q.x && q.x <= Math.max(o.x, p.x) && Math.min(o.y, p.y) <= q.y && q.y <= Math.max(o.y, p.y);
  return (
    (d1 === 0 && onSeg(c, d, a)) ||
    (d2 === 0 && onSeg(c, d, b)) ||
    (d3 === 0 && onSeg(a, b, c)) ||
    (d4 === 0 && onSeg(a, b, d))
  );
}

/** True when segment ab touches the box (inside or crossing an edge). */
export function segmentIntersectsBox(a: Vec2, b: Vec2, box: Box): boolean {
  if (boxContainsPoint(box, a) || boxContainsPoint(box, b)) return true;
  const c1 = vec(box.minX, box.minY);
  const c2 = vec(box.maxX, box.minY);
  const c3 = vec(box.maxX, box.maxY);
  const c4 = vec(box.minX, box.maxY);
  return (
    segmentsIntersect(a, b, c1, c2) ||
    segmentsIntersect(a, b, c2, c3) ||
    segmentsIntersect(a, b, c3, c4) ||
    segmentsIntersect(a, b, c4, c1)
  );
}

/** True when the circle outline touches the box. */
export function circleIntersectsBox(c: Vec2, r: number, box: Box): boolean {
  // Nearest point of the box to the centre must be within r,
  // and the farthest corner must be at least r away (otherwise the box sits inside the circle).
  const nx = Math.max(box.minX, Math.min(c.x, box.maxX));
  const ny = Math.max(box.minY, Math.min(c.y, box.maxY));
  if (Math.hypot(nx - c.x, ny - c.y) > r) return false;
  const fx = Math.max(Math.abs(box.minX - c.x), Math.abs(box.maxX - c.x));
  const fy = Math.max(Math.abs(box.minY - c.y), Math.abs(box.maxY - c.y));
  return Math.hypot(fx, fy) >= r;
}
