import { GcsWrapper, init_planegcs_module } from '@salusoft89/planegcs';
import { beforeAll, describe, expect, it } from 'vitest';
import { constrainedClusters, mergeClusters } from '../src/constraints/components';
import { ConstraintService } from '../src/constraints/service';
import { ConstraintSolver } from '../src/constraints/solver';
import { deserialize, serialize } from '../src/io/serialize';
import { AddItems, History, RemoveEntities } from '../src/model/commands';
import { DocumentModel } from '../src/model/document';
import type { Constraint } from '../src/model/types';

let solver: ConstraintSolver;
beforeAll(async () => {
  const mod = await init_planegcs_module();
  solver = new ConstraintSolver(new GcsWrapper(new mod.GcsSystem()));
});

/** Slightly crooked room: four shared corners, plus a loose line and a circle elsewhere. */
function room() {
  const doc = new DocumentModel();
  const history = new History(doc);
  history.execute(
    new AddItems(
      [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 4100, y: 120 },
        { id: 'c', x: 3950, y: 3080 },
        { id: 'd', x: -60, y: 2900 },
        { id: 'x1', x: 9000, y: 0 },
        { id: 'x2', x: 9500, y: 700 },
        { id: 'o', x: 20000, y: 0 },
        { id: 'q', x: 25000, y: 0 },
      ],
      [
        { id: 'ab', kind: 'line', p1: 'a', p2: 'b', layer: 'layer-0' },
        { id: 'bc', kind: 'line', p1: 'b', p2: 'c', layer: 'layer-0' },
        { id: 'cd', kind: 'line', p1: 'c', p2: 'd', layer: 'layer-0' },
        { id: 'da', kind: 'line', p1: 'd', p2: 'a', layer: 'layer-0' },
        { id: 'loose', kind: 'line', p1: 'x1', p2: 'x2', layer: 'layer-0' },
        { id: 'k1', kind: 'circle', center: 'o', radius: 500, layer: 'layer-0' },
        { id: 'k2', kind: 'circle', center: 'q', radius: 800, layer: 'layer-0' },
      ],
    ),
  );
  return { doc, history };
}

const add = (doc: DocumentModel, ...cs: Constraint[]) => doc.addConstraints(cs);
const solveAll = (doc: DocumentModel) => solver.solve(doc, mergeClusters(constrainedClusters(doc)));

describe('constraint clusters', () => {
  it('only includes geometry connected to a constraint', () => {
    const { doc } = room();
    expect(constrainedClusters(doc)).toHaveLength(0);
    add(doc, { id: 'h', kind: 'horizontal', refs: ['ab'] });
    const [c] = constrainedClusters(doc);
    expect([...c.pointIds].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(c.entityIds.has('loose')).toBe(false);
    expect(constrainedClusters(doc, ['x1'])).toHaveLength(0);
  });
});

describe('solver', () => {
  it('squares up a room with horizontal/vertical walls and driving dimensions', () => {
    const { doc } = room();
    add(
      doc,
      { id: 'h', kind: 'horizontal', refs: ['ab', 'cd'] },
      { id: 'v', kind: 'vertical', refs: ['bc', 'da'] },
      { id: 'f', kind: 'fixed', refs: ['a'] },
    );
    doc.addEntities([
      { id: 'w', kind: 'dimension', p1: 'a', p2: 'b', offset: -500, value: 4000, layer: 'layer-0' },
      { id: 'hgt', kind: 'dimension', p1: 'b', p2: 'c', offset: -500, value: 3000, layer: 'layer-0' },
    ]);
    const r = solveAll(doc);
    expect(r.ok).toBe(true);
    expect(r.dof).toBe(0);
    const p = (id: string) => [Math.round(doc.point(id).x), Math.round(doc.point(id).y)];
    expect([p('a'), p('b'), p('c'), p('d')]).toEqual([
      [0, 0],
      [4000, 0],
      [4000, 3000],
      [0, 3000],
    ]);
    // Untouched geometry outside the cluster.
    expect(doc.point('x2')).toMatchObject({ x: 9500, y: 700 });
  });

  it('holds dragged points and moves the rest of the cluster to suit', () => {
    const { doc } = room();
    add(doc, { id: 'h', kind: 'horizontal', refs: ['ab'] }, { id: 'p', kind: 'perpendicular', refs: ['ab', 'bc'] });
    const r = solver.solve(doc, mergeClusters(constrainedClusters(doc)), new Set(['a']));
    expect(r.ok).toBe(true);
    expect(doc.point('a')).toMatchObject({ x: 0, y: 0 });
    expect(doc.point('b').y).toBeCloseTo(0, 6);
    expect(doc.point('c').x).toBeCloseTo(doc.point('b').x, 6);
  });

  it('applies equal radius and radius constraints to circles', () => {
    const { doc } = room();
    add(doc, { id: 'e', kind: 'equal', refs: ['k1', 'k2'] }, { id: 'r', kind: 'radius', refs: ['k1'], value: 600 });
    expect(solveAll(doc).ok).toBe(true);
    const r1 = doc.entities.get('k1')!;
    const r2 = doc.entities.get('k2')!;
    expect(r1.kind === 'circle' && r1.radius).toBeCloseTo(600);
    expect(r2.kind === 'circle' && r2.radius).toBeCloseTo(600);
  });

  it('reports conflicts and leaves the document untouched', () => {
    const { doc } = room();
    add(
      doc,
      { id: 'f', kind: 'fixed', refs: ['a', 'b'] },
      { id: 'v', kind: 'vertical', refs: ['ab'] },
    );
    const before = doc.toData();
    const r = solveAll(doc);
    expect(r.ok).toBe(false);
    expect(doc.toData()).toEqual(before);
  });
});

describe('constraints in the document', () => {
  it('are removed with their geometry and restored on undo', () => {
    const { doc, history } = room();
    add(doc, { id: 'h', kind: 'horizontal', refs: ['ab'] }, { id: 'e', kind: 'equal', refs: ['ab', 'cd'] });
    history.execute(new RemoveEntities(['ab']));
    expect(doc.constraints.size).toBe(0);
    history.undo();
    expect(doc.constraints.size).toBe(2);
  });

  it('round-trip through the file format and reject dangling references', () => {
    const { doc } = room();
    add(doc, { id: 'r', kind: 'radius', refs: ['k1'], value: 600 });
    const restored = new DocumentModel();
    restored.load(deserialize(serialize(doc.toData())));
    expect(restored.toData()).toEqual(doc.toData());
    const bad = doc.toData();
    bad.constraints = [{ id: 'z', kind: 'horizontal', refs: ['nope'] }];
    expect(() => deserialize(JSON.stringify(bad))).toThrow(/없는 객체/);
  });
});

describe('degenerate solutions', () => {
  it('refuses a perpendicular constraint between two horizontal lines instead of collapsing them', () => {
    const { doc } = room();
    add(doc, { id: 'h', kind: 'horizontal', refs: ['ab', 'cd'] }, { id: 'v', kind: 'vertical', refs: ['bc', 'da'] });
    expect(solveAll(doc).ok).toBe(true);
    const before = doc.toData();
    add(doc, { id: 'p', kind: 'perpendicular', refs: ['ab', 'cd'] });
    const r = solveAll(doc);
    expect(r.ok).toBe(false);
    expect(doc.toData().points).toEqual(before.points);
  });
});

describe('immovable geometry', () => {
  it('fixes a horizontal line without reporting the horizontal constraint as redundant', () => {
    const { doc } = room();
    add(doc, { id: 'h', kind: 'horizontal', refs: ['ab'] });
    expect(solveAll(doc).ok).toBe(true);
    add(doc, { id: 'f', kind: 'fixed', refs: ['a', 'b'] });
    expect(solveAll(doc).ok).toBe(true);
  });

  it('drags a wall of a dimensioned rectangle rigidly, the rest following', () => {
    const { doc } = room();
    add(doc, { id: 'h', kind: 'horizontal', refs: ['ab', 'cd'] }, { id: 'v', kind: 'vertical', refs: ['bc', 'da'] });
    doc.addEntities([{ id: 'hgt', kind: 'dimension', p1: 'b', p2: 'c', offset: 300, value: 3000, layer: 'layer-0' }]);
    expect(solveAll(doc).ok).toBe(true);
    doc.translatePoints(['b', 'c'], { x: 500, y: 200 });
    const r = solver.solve(doc, mergeClusters(constrainedClusters(doc)), new Set(['b', 'c']));
    expect(r.ok).toBe(true);
    expect(doc.point('a').y).toBeCloseTo(doc.point('b').y, 6);
    expect(doc.point('d').y).toBeCloseTo(doc.point('c').y, 6);
  });
});

describe('dragging over-constrained geometry', () => {
  it('moves a corner of a fixed, dimensioned rectangle only along its free direction', () => {
    const { doc } = room();
    add(doc, { id: 'h', kind: 'horizontal', refs: ['ab', 'cd'] }, { id: 'v', kind: 'vertical', refs: ['bc', 'da'] });
    add(doc, { id: 'f', kind: 'fixed', refs: ['a'] });
    doc.addEntities([{ id: 'hgt', kind: 'dimension', p1: 'b', p2: 'c', offset: 300, value: 3000, layer: 'layer-0' }]);
    expect(solveAll(doc).ok).toBe(true);
    const by = doc.point('b').y;
    const bx = doc.point('b').x;
    const cy = doc.point('c').y;
    doc.translatePoints(['b'], { x: 500, y: 200 });
    const cluster = mergeClusters(constrainedClusters(doc));
    expect(solver.solve(doc, cluster, new Set(['b'])).ok).toBe(false);
    const r = solver.solveTowards(doc, cluster, new Set(['b']));
    expect(r.ok).toBe(true);
    expect(doc.point('b').x).toBeCloseTo(bx + 500, 3);
    expect(doc.point('b').y).toBeCloseTo(by, 3);
    expect(doc.point('c').y).toBeCloseTo(cy, 3);
  });
});

describe('degrees of freedom', () => {
  it('counts the free height of a rectangle hanging from a fixed wall', () => {
    const { doc } = room();
    add(doc, { id: 'h', kind: 'horizontal', refs: ['ab', 'cd'] }, { id: 'v', kind: 'vertical', refs: ['bc', 'da'] });
    expect(solveAll(doc).ok).toBe(true);
    add(doc, { id: 'f', kind: 'fixed', refs: ['a', 'b'] });
    expect(solver.analyze(doc, mergeClusters(constrainedClusters(doc))).dof).toBe(1);
  });
});

describe('constrained drag with unconstrained geometry selected too', () => {
  it('moves the loose line once and undoes it with the rest', async () => {
    const { doc, history } = room();
    add(doc, { id: 'h', kind: 'horizontal', refs: ['ab'] });
    const service = new ConstraintService(doc, history, () => Promise.resolve(solver));
    await service.ensure();
    const moving = ['a', 'b', 'x1', 'x2'];
    const drag = service.beginDrag(moving)!;
    expect(drag).not.toBeNull();
    for (const step of [100, 200, 300]) expect(drag.update({ x: step, y: 0 })).toBe(true);
    expect(doc.point('x1')).toMatchObject({ x: 9300, y: 0 });
    expect(doc.point('a').y).toBeCloseTo(doc.point('b').y, 6);
    history.record(drag.finish());
    history.undo();
    expect(doc.point('x1')).toMatchObject({ x: 9000, y: 0 });
    expect(doc.point('x2')).toMatchObject({ x: 9500, y: 700 });
  });
});
