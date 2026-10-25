import { describe, expect, it } from 'vitest';
import { angleDeg, circleIntersectsBox, distToSegment, segmentIntersectsBox } from '../src/geom/vec';

const box = { minX: 0, minY: 0, maxX: 10, maxY: 10 };

describe('geometry', () => {
  it('measures distance to a segment, clamped to its ends', () => {
    expect(distToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(3);
    expect(distToSegment({ x: 13, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(5);
  });

  it('measures angles counter-clockwise from +X', () => {
    expect(angleDeg({ x: 0, y: 0 }, { x: 0, y: 5 })).toBeCloseTo(90);
    expect(angleDeg({ x: 0, y: 0 }, { x: 0, y: -5 })).toBeCloseTo(270);
  });

  it('detects segments crossing a box without endpoints inside', () => {
    expect(segmentIntersectsBox({ x: -5, y: 5 }, { x: 15, y: 5 }, box)).toBe(true);
    expect(segmentIntersectsBox({ x: -5, y: 20 }, { x: 15, y: 20 }, box)).toBe(false);
  });

  it('treats a box fully inside a circle as not touching its outline', () => {
    expect(circleIntersectsBox({ x: 5, y: 5 }, 100, box)).toBe(false);
    expect(circleIntersectsBox({ x: 5, y: 5 }, 6, box)).toBe(true);
    expect(circleIntersectsBox({ x: 50, y: 50 }, 6, box)).toBe(false);
  });
});
