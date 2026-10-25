import { describe, expect, it } from 'vitest';
import { Viewport, gridSpacing, snapToGrid } from '../src/view/viewport';

describe('viewport', () => {
  it('round-trips world and screen coordinates with Y up', () => {
    const v = new Viewport();
    v.resize(800, 600);
    v.scale = 0.5;
    v.centreOn({ x: 1000, y: 2000 });
    expect(v.toScreen({ x: 1000, y: 2000 })).toEqual({ x: 400, y: 300 });
    expect(v.toScreen({ x: 1000, y: 2100 }).y).toBeLessThan(300);
    const w = v.toWorld({ x: 123, y: 456 });
    const s = v.toScreen(w);
    expect(s.x).toBeCloseTo(123);
    expect(s.y).toBeCloseTo(456);
  });

  it('keeps the point under the cursor fixed while zooming', () => {
    const v = new Viewport();
    v.resize(800, 600);
    const at = { x: 200, y: 150 };
    const before = v.toWorld(at);
    v.zoomAt(at, 3);
    const after = v.toWorld(at);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it('fits a box into the screen', () => {
    const v = new Viewport();
    v.resize(800, 600);
    v.fit({ minX: 0, minY: 0, maxX: 10000, maxY: 5000 }, 40);
    const b = v.worldBounds();
    expect(b.minX).toBeLessThanOrEqual(0);
    expect(b.maxX).toBeGreaterThanOrEqual(10000);
    expect(b.minY).toBeLessThanOrEqual(0);
    expect(b.maxY).toBeGreaterThanOrEqual(5000);
  });

  it('chooses 1-2-5 grid steps at least the minimum pixel gap apart', () => {
    for (const scale of [0.001, 0.013, 0.1, 0.7, 4, 50]) {
      const { minor } = gridSpacing(scale, 12);
      expect(minor * scale).toBeGreaterThanOrEqual(12 - 1e-9);
      const mant = minor / 10 ** Math.floor(Math.log10(minor) + 1e-9);
      expect([1, 2, 5]).toContain(Math.round(mant));
    }
  });

  it('snaps to the grid', () => {
    expect(snapToGrid({ x: 1240, y: -260 }, 500)).toEqual({ x: 1000, y: -500 });
  });
});
