import { describe, expect, it } from 'vitest';
import { AddItems, History, MovePoints, RemoveEntities } from '../src/model/commands';
import { DocumentModel } from '../src/model/document';
import { SpatialIndex } from '../src/model/spatial';
import type { LineEntity, Point } from '../src/model/types';

function twoConnectedLines() {
  const pts: Point[] = [
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: 100, y: 0 },
    { id: 'c', x: 100, y: 100 },
  ];
  const lines: LineEntity[] = [
    { id: 'l1', kind: 'line', p1: 'a', p2: 'b', layer: 'layer-0' },
    { id: 'l2', kind: 'line', p1: 'b', p2: 'c', layer: 'layer-0' },
  ];
  return { pts, lines };
}

describe('history', () => {
  it('undoes and redoes additions', () => {
    const doc = new DocumentModel();
    const h = new History(doc);
    const { pts, lines } = twoConnectedLines();
    h.execute(new AddItems(pts, lines));
    expect(doc.entities.size).toBe(2);
    h.undo();
    expect(doc.entities.size).toBe(0);
    expect(doc.points.size).toBe(0);
    h.redo();
    expect(doc.entities.size).toBe(2);
  });

  it('keeps shared points when removing one of two connected lines', () => {
    const doc = new DocumentModel();
    const h = new History(doc);
    const { pts, lines } = twoConnectedLines();
    h.execute(new AddItems(pts, lines));
    h.execute(new RemoveEntities(['l1']));
    expect([...doc.points.keys()].sort()).toEqual(['b', 'c']);
    h.undo();
    expect(doc.points.size).toBe(3);
    expect(doc.entities.has('l1')).toBe(true);
  });

  it('moves shared points once and reverts exactly', () => {
    const doc = new DocumentModel();
    const h = new History(doc);
    const { pts, lines } = twoConnectedLines();
    h.execute(new AddItems(pts, lines));
    h.execute(new MovePoints(['b'], { x: 5, y: 7 }));
    expect(doc.point('b')).toMatchObject({ x: 105, y: 7 });
    h.undo();
    expect(doc.point('b')).toMatchObject({ x: 100, y: 0 });
  });

  it('drops the redo stack after a new edit', () => {
    const doc = new DocumentModel();
    const h = new History(doc);
    const { pts, lines } = twoConnectedLines();
    h.execute(new AddItems(pts, lines));
    h.undo();
    h.execute(new AddItems([{ id: 'z', x: 1, y: 1 }], []));
    expect(h.canRedo).toBe(false);
  });
});

describe('spatial index', () => {
  it('picks the nearest entity and reflects later edits', () => {
    const doc = new DocumentModel();
    const h = new History(doc);
    const idx = new SpatialIndex(doc);
    const { pts, lines } = twoConnectedLines();
    h.execute(new AddItems(pts, lines));
    expect(idx.pick({ x: 50, y: 2 }, 5)?.id).toBe('l1');
    expect(idx.pick({ x: 50, y: 50 }, 5)).toBeNull();
    h.execute(new MovePoints(['a'], { x: 0, y: 100 }));
    expect(idx.pick({ x: 50, y: 50 }, 5)?.id).toBe('l1');
  });

  it('distinguishes window (inside) and crossing selection', () => {
    const doc = new DocumentModel();
    const h = new History(doc);
    const idx = new SpatialIndex(doc);
    const { pts, lines } = twoConnectedLines();
    h.execute(new AddItems(pts, lines));
    const box = { minX: -10, minY: -10, maxX: 50, maxY: 10 };
    expect(idx.select(box, false)).toHaveLength(0);
    expect(idx.select(box, true).map((e) => e.id)).toEqual(['l1']);
  });
});
