import type { Vec2 } from './vec';

/** Corners of a width × depth rectangle centred on `c` and rotated by `rotationDeg`, counter-clockwise from front-left. */
export function equipmentCorners(c: Vec2, width: number, depth: number, rotationDeg: number): Vec2[] {
  const r = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const hw = width / 2;
  const hd = depth / 2;
  return [
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd],
  ].map(([x, y]) => ({ x: c.x + x * cos - y * sin, y: c.y + x * sin + y * cos }));
}

/** Whether p lies inside the convex polygon (corners in counter-clockwise order). */
export function insideConvex(p: Vec2, corners: Vec2[]): boolean {
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    if ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) < 0) return false;
  }
  return true;
}

/** The polygon's edges as segment pairs. */
export function edgesOf(corners: Vec2[]): [Vec2, Vec2][] {
  return corners.map((a, i) => [a, corners[(i + 1) % corners.length]]);
}
