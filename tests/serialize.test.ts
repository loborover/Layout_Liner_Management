import { describe, expect, it } from 'vitest';
import { FormatError, deserialize, serialize } from '../src/io/serialize';
import { DocumentModel } from '../src/model/document';

describe('serialize', () => {
  it('round-trips a document', () => {
    const doc = new DocumentModel();
    doc.addPoints([
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 10, y: 0 },
    ]);
    doc.addEntities([
      { id: 'l', kind: 'line', p1: 'a', p2: 'b', layer: 'layer-0' },
      { id: 'c', kind: 'circle', center: 'a', radius: 5, layer: 'layer-0' },
    ]);
    const restored = new DocumentModel();
    restored.load(deserialize(serialize(doc.toData())));
    expect(restored.toData()).toEqual(doc.toData());
  });

  it('rejects files that are not drawings or reference missing points', () => {
    expect(() => deserialize('nope')).toThrow(FormatError);
    expect(() => deserialize('{"format":"other"}')).toThrow(FormatError);
    const bad = {
      format: 'layout-liner',
      version: 1,
      units: 'mm',
      points: [],
      entities: [{ id: 'l', kind: 'line', p1: 'x', p2: 'y', layer: 'layer-0' }],
      layers: [],
    };
    expect(() => deserialize(JSON.stringify(bad))).toThrow(/없는 점/);
  });

  it('reads point objects (version 3) and drops a height they cannot have', () => {
    const data = {
      format: 'layout-liner',
      version: 3,
      units: 'mm',
      points: [{ id: 'p', x: 10, y: 20, z: 300 }],
      entities: [{ id: 'a', kind: 'point', at: 'p', layer: 'layer-0', name: '기준점', height: 5 }],
      layers: [],
    };
    const doc = new DocumentModel();
    doc.load(deserialize(JSON.stringify(data)));
    expect(doc.entities.get('a')).toEqual({ id: 'a', kind: 'point', at: 'p', layer: 'layer-0', name: '기준점' });
    expect(doc.point('p').z).toBe(300);
    expect(() => deserialize(JSON.stringify({ ...data, entities: [{ id: 'a', kind: 'point', at: 'q', layer: 'layer-0' }] }))).toThrow(/없는 점/);
  });

  it('reads version 4 borders and coincident constraints, and rejects a coincident constraint on an entity', () => {
    const data = {
      format: 'layout-liner',
      version: 4,
      units: 'mm',
      points: [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 1000, y: 0 },
        { id: 'c', x: 1000, y: 0 },
        { id: 'd', x: 1000, y: 1000 },
      ],
      entities: [
        { id: 'l1', kind: 'line', p1: 'a', p2: 'b', layer: 'layer-0', stroke: { width: 100, align: 'center', opacity: 0.5, pattern: { stripes: [{ color: '#FFFFFF', size: 1 }, { color: '#D32F2F', size: 2 }], unit: 50, angle: 45 } } },
        { id: 'l2', kind: 'line', p1: 'c', p2: 'd', layer: 'layer-0' },
        { id: 'k', kind: 'circle', center: 'd', radius: 300, layer: 'layer-0', stroke: { width: 50, align: 'inside' } },
      ],
      constraints: [{ id: 'j', kind: 'coincident', refs: ['b', 'c'] }],
      layers: [],
    };
    const out = deserialize(JSON.stringify(data));
    const l1 = out.entities[0];
    expect(l1.kind === 'line' && l1.stroke).toMatchObject({ opacity: 0.5, pattern: { unit: 50, angle: 45 } });
    expect(out.entities[2].kind === 'circle' && out.entities[2].stroke?.width).toBe(50);
    expect(out.constraints).toEqual([{ id: 'j', kind: 'coincident', refs: ['b', 'c'] }]);
    expect(() => deserialize(JSON.stringify({ ...data, constraints: [{ id: 'j', kind: 'coincident', refs: ['l1', 'c'] }] }))).toThrow(/점만/);
    expect(() => deserialize(JSON.stringify({ ...data, constraints: [{ id: 'j', kind: 'coincident', refs: ['b'] }] }))).toThrow(/두 개 이상/);
  });

  it('reads version 6 distance and angle constraints and checks what they reference', () => {
    const doc = new DocumentModel();
    doc.addPoints([
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 4000, y: 0 },
      { id: 'c', x: 4000, y: 3000 },
      { id: 'p', x: 2000, y: 6000 },
    ]);
    doc.addEntities([
      { id: 'ab', kind: 'line', p1: 'a', p2: 'b', layer: 'layer-0' },
      { id: 'bc', kind: 'line', p1: 'b', p2: 'c', layer: 'layer-0' },
      { id: 'pp', kind: 'point', at: 'p', layer: 'layer-0' },
    ]);
    doc.addConstraints([
      { id: 'k1', kind: 'distance', refs: ['p', 'ab'], value: 2000 },
      { id: 'k2', kind: 'angle', refs: ['ab', 'bc'], value: 90 },
      { id: 'k3', kind: 'distance', refs: ['a', 'c'], value: 5000 },
    ]);
    const data = deserialize(serialize(doc.toData()));
    expect(data.version).toBe(7);
    expect(data.constraints).toEqual(doc.toData().constraints);
    const raw = JSON.parse(serialize(doc.toData()));
    const withConstraint = (c: object) => () => deserialize(JSON.stringify({ ...raw, constraints: [c] }));
    expect(withConstraint({ id: 'x', kind: 'angle', refs: ['ab', 'p'], value: 30 })).toThrow(FormatError);
    expect(withConstraint({ id: 'x', kind: 'angle', refs: ['ab', 'bc'], value: 200 })).toThrow(/180/);
    expect(withConstraint({ id: 'x', kind: 'distance', refs: ['ab', 'p'], value: 30 })).toThrow(FormatError);
    expect(withConstraint({ id: 'x', kind: 'distance', refs: ['a', 'b'] })).toThrow(/값이 없습니다/);
    // A version 5 file (no dimension constraints) still opens and saves as version 7.
    expect(deserialize(JSON.stringify({ ...raw, version: 5, constraints: [] })).version).toBe(7);
  });
});

describe('nested folders (version 7)', () => {
  const base = (folders: unknown[], layers: unknown[] = []) =>
    JSON.stringify({
      format: 'layout-liner',
      version: 7,
      units: 'mm',
      points: [],
      entities: [],
      constraints: [],
      floors: [
        { id: 'floor-1', name: '1층', elevation: 0, height: 4000 },
        { id: 'floor-2', name: '2층', elevation: 4000, height: 4000 },
      ],
      folders,
      layers: [{ id: 'layer-0', name: '0', color: '#000000', visible: true, locked: false, floor: 'floor-1' }, ...layers],
      activeFloor: 'floor-1',
      equipmentTypes: [],
    });
  const folder = (id: string, parent?: string, floor = 'floor-1') => ({ id, name: id, floor, visible: true, locked: false, ...(parent ? { parent } : {}) });

  it('keeps a folder inside a folder through a save and load', () => {
    const data = deserialize(base([folder('a'), folder('b', 'a'), folder('c', 'b')]));
    expect(data.version).toBe(7);
    expect(data.folders.map((f) => f.parent)).toEqual([undefined, 'a', 'b']);
    const doc = new DocumentModel();
    doc.load(data);
    expect(deserialize(serialize(doc.toData())).folders.map((f) => f.parent)).toEqual([undefined, 'a', 'b']);
  });

  it('drops a parent on another floor, a missing one and a loop', () => {
    const data = deserialize(base([folder('a', 'b'), folder('b', 'a'), folder('x', 'missing'), folder('y', 'a', 'floor-2')]));
    const parents = Object.fromEntries(data.folders.map((f) => [f.id, f.parent]));
    // The loop a ⇄ b is cut where it closes.
    expect([parents.a, parents.b].filter(Boolean)).toHaveLength(1);
    expect(parents.x).toBeUndefined();
    expect(parents.y).toBeUndefined();
  });

  it('refuses two folders or two layers with one id (names may repeat, ids may not)', () => {
    expect(() => deserialize(base([folder('a'), folder('a')]))).toThrow(FormatError);
    expect(() => deserialize(base([], [{ id: 'layer-0', name: '0', floor: 'floor-1' }]))).toThrow(FormatError);
    const sameNames = deserialize(base([{ ...folder('a'), name: '협력사' }, { ...folder('b'), name: '협력사' }]));
    expect(sameNames.folders.map((f) => f.name)).toEqual(['협력사', '협력사']);
  });

  it('opens version 5 files (folders without parents) as before', () => {
    const v5 = JSON.parse(base([folder('a')]));
    v5.version = 5;
    expect(deserialize(JSON.stringify(v5)).folders[0].parent).toBeUndefined();
  });
});
