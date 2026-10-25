import { describe, expect, it } from 'vitest';
import { circleCircle, segmentCircle, segmentSegment } from '../src/geom/intersect';
import { polygonArea, polygonPerimeter } from '../src/geom/polygon';
import { AddItems, History } from '../src/model/commands';
import { DocumentModel } from '../src/model/document';
import { SpatialIndex } from '../src/model/spatial';
import { SnapEngine, type SnapSettings } from '../src/snap/snap';

const ALL: SnapSettings = { object: true, polar: true, grid: true, polarStep: 15 };
const OBJECT_ONLY: SnapSettings = { object: true, polar: false, grid: false, polarStep: 15 };

function setup() {
  const doc = new DocumentModel();
  const history = new History(doc);
  // A horizontal line, a vertical line crossing it, and a circle.
  history.execute(
    new AddItems(
      [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 1000, y: 0 },
        { id: 'c', x: 500, y: -500 },
        { id: 'd', x: 500, y: 500 },
        { id: 'o', x: 3000, y: 0 },
      ],
      [
        { id: 'h', kind: 'line', p1: 'a', p2: 'b', layer: 'layer-0' },
        { id: 'v', kind: 'line', p1: 'c', p2: 'd', layer: 'layer-0' },
        { id: 'k', kind: 'circle', center: 'o', radius: 400, layer: 'layer-0' },
      ],
    ),
  );
  return { doc, engine: new SnapEngine(doc, new SpatialIndex(doc)) };
}

describe('intersections and polygons', () => {
  it('intersects segments, segment-circle and circle-circle', () => {
    expect(segmentSegment({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: -5 }, { x: 5, y: 5 })).toEqual({ x: 5, y: 0 });
    expect(segmentSegment({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 1 }, { x: 10, y: 1 })).toBeNull();
    expect(segmentCircle({ x: -10, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }, 5)).toHaveLength(2);
    expect(circleCircle({ x: 0, y: 0 }, 5, { x: 8, y: 0 }, 5).map((p) => Math.round(p.y)).sort()).toEqual([-3, 3]);
  });

  it('computes area and perimeter of a 4 m × 3 m room', () => {
    const room = [
      { x: 0, y: 0 },
      { x: 4000, y: 0 },
      { x: 4000, y: 3000 },
      { x: 0, y: 3000 },
    ];
    expect(polygonArea(room)).toBe(12e6);
    expect(polygonPerimeter(room)).toBe(14000);
  });
});

describe('snap engine', () => {
  it('prefers an endpoint and reports its point id', () => {
    const { engine } = setup();
    const s = engine.snap({ x: 8, y: 6 }, 20, 100, ALL);
    expect(s).toMatchObject({ kind: 'endpoint', pointId: 'a', point: { x: 0, y: 0 } });
  });

  it('finds intersections, midpoints, centres and quadrants', () => {
    const { engine } = setup();
    expect(engine.snap({ x: 505, y: 4 }, 20, 100, OBJECT_ONLY)).toMatchObject({ kind: 'intersection', point: { x: 500, y: 0 } });
    expect(engine.snap({ x: 495, y: 498 }, 20, 100, OBJECT_ONLY)?.kind).toBe('endpoint');
    expect(engine.snap({ x: 3005, y: 5 }, 20, 100, OBJECT_ONLY)).toMatchObject({ kind: 'center', pointId: 'o' });
    expect(engine.snap({ x: 3002, y: 396 }, 20, 100, OBJECT_ONLY)).toMatchObject({ kind: 'quadrant', point: { x: 3000, y: 400 } });
    expect(engine.snap({ x: 250, y: 3 }, 20, 100, OBJECT_ONLY)).toBeNull();
    expect(engine.snap({ x: 498, y: 3 }, 20, 100, OBJECT_ONLY)?.kind).toBe('intersection'); // beats the coincident midpoints
  });

  it('snaps perpendicular from the base point', () => {
    const { engine } = setup();
    const s = engine.snap({ x: 252, y: 5 }, 20, 100, OBJECT_ONLY, { from: { x: 250, y: 800 } });
    expect(s).toMatchObject({ kind: 'perpendicular', point: { x: 250, y: 0 } });
  });

  it('ignores excluded entities', () => {
    const { engine } = setup();
    expect(engine.snap({ x: 3, y: 2 }, 20, 100, OBJECT_ONLY, { exclude: new Set(['h']) })).toBeNull();
  });

  it('tracks 15° angles and ortho, rounding distance to the grid', () => {
    const { engine } = setup();
    const from = { x: 10000, y: 10000 };
    const polar = engine.snap({ x: 10000 + 1000, y: 10000 + 20 }, 50, 100, ALL, { from });
    expect(polar?.kind).toBe('polar');
    expect(polar?.point.y).toBeCloseTo(10000);
    expect(polar?.point.x).toBeCloseTo(11000);
    const ortho = engine.snap({ x: 10000 + 130, y: 10000 + 870 }, 50, 100, ALL, { from, ortho: true });
    expect(ortho?.kind).toBe('ortho');
    expect(ortho?.point.x).toBeCloseTo(10000);
    expect(ortho?.point.y).toBeCloseTo(10900);
  });

  it('falls back to the grid', () => {
    const { engine } = setup();
    expect(engine.snap({ x: 20140, y: 20260 }, 20, 100, ALL)).toMatchObject({ kind: 'grid', point: { x: 20100, y: 20300 } });
  });
});
