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
});
