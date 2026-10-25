import { type Vec2, add, dot, len, scale, sub } from './vec';

export interface DimensionGeometry {
  /** Dimension line ends, offset from the measured points. */
  d1: Vec2;
  d2: Vec2;
  /** Unit normal the offset is measured along (left of a→b). */
  normal: Vec2;
  length: number;
}

/** Aligned dimension between a and b, its dimension line `offset` mm to the left of a→b. */
export function dimensionGeometry(a: Vec2, b: Vec2, offset: number): DimensionGeometry {
  const ab = sub(b, a);
  const l = len(ab);
  const normal = l === 0 ? { x: 0, y: 1 } : { x: -ab.y / l, y: ab.x / l };
  const o = scale(normal, offset);
  return { d1: add(a, o), d2: add(b, o), normal, length: l };
}

/** Signed offset that places the dimension line through `through`. */
export function offsetThrough(a: Vec2, b: Vec2, through: Vec2): number {
  return dot(sub(through, a), dimensionGeometry(a, b, 0).normal);
}
