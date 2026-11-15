import { GcsWrapper, init_planegcs_module } from '@salusoft89/planegcs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  angleArms,
  angleFromSelection,
  dimensionAt,
  dimensionScale,
  dimensionShape,
  distanceFromSelection,
  measureDimension,
} from '../src/constraints/dimensions';
import { ConstraintService } from '../src/constraints/service';
import { ConstraintSolver } from '../src/constraints/solver';
import { deserialize, serialize } from '../src/io/serialize';
import { AddItems, History, RemoveEntities } from '../src/model/commands';
import { DocumentModel } from '../src/model/document';
import type { Constraint, LineEntity } from '../src/model/types';

let solver: ConstraintSolver;
beforeAll(async () => {
  const mod = await init_planegcs_module();
  solver = new ConstraintSolver(new GcsWrapper(new mod.GcsSystem()));
});

/** A rough room (shared corners), a loose point and a point object. */
function setup() {
  const doc = new DocumentModel();
  const history = new History(doc);
  history.execute(
    new AddItems(
      [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 4000, y: 100 },
        { id: 'c', x: 3950, y: 3000 },
        { id: 'd', x: -50, y: 2950 },
        { id: 'p', x: 2000, y: 6000 },
        { id: 'q', x: 6000, y: 6000 },
      ],
      [
        { id: 'ab', kind: 'line', p1: 'a', p2: 'b', layer: 'layer-0' },
        { id: 'bc', kind: 'line', p1: 'b', p2: 'c', layer: 'layer-0' },
        { id: 'cd', kind: 'line', p1: 'c', p2: 'd', layer: 'layer-0' },
        { id: 'da', kind: 'line', p1: 'd', p2: 'a', layer: 'layer-0' },
        { id: 'pt', kind: 'point', at: 'q', layer: 'layer-0' },
        { id: 'pp', kind: 'point', at: 'p', layer: 'layer-0' },
      ],
    ),
  );
  const service = new ConstraintService(doc, history, () => Promise.resolve(solver));
  return { doc, history, service };
}

const line = (doc: DocumentModel, id: string) => doc.entities.get(id) as LineEntity;
const distance = (doc: DocumentModel, p: string, q: string) => Math.hypot(doc.point(q).x - doc.point(p).x, doc.point(q).y - doc.point(p).y);

describe('picking dimension constraints from a selection', () => {
  it('accepts two points, a point and a line, or two parallel lines', () => {
    const { doc } = setup();
    expect(distanceFromSelection(doc, ['a', 'pt'])).toMatchObject({ ok: true, refs: ['a', 'q'] });
    const pl = distanceFromSelection(doc, ['p', 'ab']);
    expect(pl).toMatchObject({ ok: true, refs: ['p', 'ab'] });
    const ll = distanceFromSelection(doc, ['ab', 'cd']);
    expect(ll.ok).toBe(true);
    if (ll.ok) expect(ll.value).toBeCloseTo(measureDimension(doc, { id: '', kind: 'distance', refs: ['ab', 'cd'] }), 9);
  });

  it('explains what is wrong with other selections', () => {
    const { doc } = setup();
    expect(distanceFromSelection(doc, ['a']).ok).toBe(false);
    expect(distanceFromSelection(doc, ['ab', 'bc']).ok).toBe(false); // not parallel
    expect(distanceFromSelection(doc, ['a', 'ab']).ok).toBe(false); // the line's own end
    expect(angleFromSelection(doc, ['a', 'ab']).ok).toBe(false);
  });

  it('measures an angle between arms running away from the shared corner', () => {
    const { doc } = setup();
    // ab runs a→b and bc runs b→c, so the corner at b is between b→a and b→c.
    const arms = angleArms(doc, line(doc, 'ab'), line(doc, 'bc'));
    expect(arms.a).toEqual(['b', 'a']);
    expect(arms.b).toEqual(['b', 'c']);
    const pick = angleFromSelection(doc, ['ab', 'bc']);
    expect(pick.ok && pick.value).toBeGreaterThan(80);
    expect(pick.ok && pick.value).toBeLessThan(100);
  });
});

describe('solving dimension constraints', () => {
  it('holds the distance between two points and follows a new value', async () => {
    const { doc, service } = setup();
    expect(await service.add('distance', [['a', 'c']], 5000)).toEqual({ ok: true });
    expect(distance(doc, 'a', 'c')).toBeCloseTo(5000, 3);
    const c = [...doc.constraints.values()][0];
    expect(await service.setValue(c.id, 5500)).toEqual({ ok: true });
    expect(distance(doc, 'a', 'c')).toBeCloseTo(5500, 3);
  });

  it('holds a point at a distance from a line', async () => {
    const { doc, service } = setup();
    expect(await service.add('horizontal', [['ab']])).toEqual({ ok: true });
    expect(await service.add('distance', [['p', 'ab']], 4000)).toEqual({ ok: true });
    expect(measureDimension(doc, { id: '', kind: 'distance', refs: ['p', 'ab'] })).toBeCloseTo(4000, 3);
    // The point stays on the side it was on.
    expect(doc.point('p').y).toBeGreaterThan(doc.point('a').y);
  });

  it('sets the distance between two parallel walls without a separate parallel constraint clashing', async () => {
    const { doc, service } = setup();
    expect(await service.add('parallel', [['ab', 'cd']])).toEqual({ ok: true });
    expect(await service.add('distance', [['ab', 'cd']], 3500)).toEqual({ ok: true });
    const d = measureDimension(doc, { id: '', kind: 'distance', refs: ['ab', 'cd'] });
    expect(d).toBeCloseTo(3500, 3);
    // Both ends of the far wall are at the distance, because the walls are parallel.
    expect(measureDimension(doc, { id: '', kind: 'distance', refs: ['d', 'ab'] })).toBeCloseTo(3500, 3);
  });

  it('keeps two walls parallel when their distance is set, without doubling up an existing parallel constraint', async () => {
    const { doc, service } = setup();
    expect(await service.addDimension('distance', ['ab', 'cd'], 3000)).toEqual({ ok: true });
    expect([...doc.constraints.values()].map((c) => c.kind).sort()).toEqual(['distance', 'parallel']);
    expect(measureDimension(doc, { id: '', kind: 'distance', refs: ['c', 'ab'] })).toBeCloseTo(3000, 3);
    expect(measureDimension(doc, { id: '', kind: 'distance', refs: ['d', 'ab'] })).toBeCloseTo(3000, 3);
    // With a parallel constraint already on bc and da, the dimension comes alone.
    expect(await service.add('parallel', [['bc', 'da']])).toEqual({ ok: true });
    expect(await service.addDimension('distance', ['bc', 'da'], 4500)).toEqual({ ok: true });
    expect([...doc.constraints.values()].filter((c) => c.kind === 'parallel')).toHaveLength(2);
  });

  it('sets an angle at a corner, keeping the turn direction, and edits it', async () => {
    const { doc, service } = setup();
    const before = angleArms(doc, line(doc, 'ab'), line(doc, 'bc'));
    expect(await service.add('angle', [['ab', 'bc']], 60)).toEqual({ ok: true });
    let arms = angleArms(doc, line(doc, 'ab'), line(doc, 'bc'));
    expect(arms.degrees).toBeCloseTo(60, 4);
    expect(arms.sign).toBe(before.sign);
    const c = [...doc.constraints.values()].find((k) => k.kind === 'angle')!;
    expect(await service.setValue(c.id, 120)).toEqual({ ok: true });
    arms = angleArms(doc, line(doc, 'ab'), line(doc, 'bc'));
    expect(arms.degrees).toBeCloseTo(120, 4);
    expect(arms.sign).toBe(before.sign);
    expect((await service.setValue(c.id, 180)).ok).toBe(false);
  });

  it('refuses a dimension that conflicts and leaves the drawing as it was', async () => {
    const { doc, service } = setup();
    expect(await service.add('fixed', [['a', 'b']])).toEqual({ ok: true });
    const r = await service.add('distance', [['a', 'b']], 1000);
    expect(r.ok).toBe(false);
    expect([...doc.constraints.values()].some((c) => c.kind === 'distance')).toBe(false);
    expect(doc.point('b')).toMatchObject({ x: 4000, y: 100 });
  });

  it('is undone with the geometry and removed with the line it measures', async () => {
    const { doc, history, service } = setup();
    await service.add('angle', [['ab', 'bc']], 90);
    history.undo();
    expect(doc.constraints.size).toBe(0);
    expect(doc.point('c')).toMatchObject({ x: 3950, y: 3000 });
    history.redo();
    expect(doc.constraints.size).toBe(1);
    history.execute(new RemoveEntities(['bc']));
    expect(doc.constraints.size).toBe(0);
  });
});

describe('drawing and picking dimension constraints', () => {
  it('places a point-to-line dimension along the perpendicular and finds its label', () => {
    const { doc } = setup();
    const c: Constraint = { id: 'k', kind: 'distance', refs: ['p', 'da'], value: 2000 };
    doc.addConstraints([c]);
    const shape = dimensionShape(doc, c, dimensionScale(10));
    expect(shape?.kind).toBe('linear');
    if (shape?.kind !== 'linear') return;
    expect(shape.a).toEqual(doc.point('p'));
    expect(dimensionAt(doc, shape.label, dimensionScale(10), 50)?.id).toBe('k');
    expect(dimensionAt(doc, { x: -9000, y: -9000 }, dimensionScale(10), 50)).toBeNull();
  });

  it('draws an angle as an arc at the corner', () => {
    const { doc } = setup();
    const c: Constraint = { id: 'k', kind: 'angle', refs: ['ab', 'bc'], value: 90 };
    const shape = dimensionShape(doc, c, dimensionScale(10));
    expect(shape?.kind).toBe('arc');
    if (shape?.kind === 'arc') expect(shape.center).toEqual(doc.point('b'));
  });
});

describe('saving dimension constraints', () => {
  it('round-trips and validates their references', () => {
    const { doc } = setup();
    doc.addConstraints([
      { id: 'k1', kind: 'distance', refs: ['p', 'ab'], value: 2000 },
      { id: 'k2', kind: 'angle', refs: ['ab', 'bc'], value: 90 },
    ]);
    const data = deserialize(serialize(doc.toData()));
    expect(data.version).toBe(6);
    expect(data.constraints).toEqual([
      { id: 'k1', kind: 'distance', refs: ['p', 'ab'], value: 2000 },
      { id: 'k2', kind: 'angle', refs: ['ab', 'bc'], value: 90 },
    ]);
    const broken = (c: object) => {
      const raw = JSON.parse(serialize(doc.toData()));
      raw.constraints = [c];
      return () => deserialize(JSON.stringify(raw));
    };
    expect(broken({ id: 'x', kind: 'angle', refs: ['ab', 'p'], value: 30 })).toThrow();
    expect(broken({ id: 'x', kind: 'angle', refs: ['ab', 'bc'], value: 200 })).toThrow();
    expect(broken({ id: 'x', kind: 'distance', refs: ['ab', 'p'], value: 30 })).toThrow();
    expect(broken({ id: 'x', kind: 'distance', refs: ['a', 'b'] })).toThrow();
  });
});
