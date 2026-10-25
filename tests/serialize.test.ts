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
});
