import { describe, expect, it } from 'vitest';
import { equipmentCorners, insideConvex } from '../src/geom/equipment';
import { deserialize, serialize } from '../src/io/serialize';
import { equipmentCsv, equipmentRows } from '../src/io/equipmentList';
import { AddConstraints, AddItems, History, SetEquipmentTypes } from '../src/model/commands';
import { DocumentModel } from '../src/model/document';
import { arrayOffsets, copyItems, moveToLayer, nextTag, rotateItems } from '../src/model/edit';
import { SpatialIndex } from '../src/model/spatial';
import { SnapEngine } from '../src/snap/snap';
import { parseType } from '../src/ui/panel';

function plant() {
  const doc = new DocumentModel();
  const history = new History(doc);
  history.execute(
    new AddItems(
      [
        { id: 'c1', x: 0, y: 0 },
        { id: 'c2', x: 10000, y: 0 },
        { id: 'a', x: 0, y: 5000 },
        { id: 'b', x: 2000, y: 5000 },
      ],
      [
        { id: 'm1', kind: 'equipment', type: 'eq-machine', at: 'c1', rotation: 0, tag: 'MC-1', layer: 'layer-0' },
        { id: 'm2', kind: 'equipment', type: 'eq-bench', at: 'c2', rotation: 90, tag: 'WB-1', layer: 'layer-0' },
        { id: 'w', kind: 'line', p1: 'a', p2: 'b', layer: 'layer-0' },
      ],
    ),
  );
  return { doc, history };
}

describe('equipment geometry', () => {
  it('rotates the footprint about its centre', () => {
    const cs = equipmentCorners({ x: 0, y: 0 }, 4000, 2000, 90);
    expect(cs[0].x).toBeCloseTo(1000);
    expect(cs[0].y).toBeCloseTo(-2000);
    expect(insideConvex({ x: 900, y: 1900 }, cs)).toBe(true);
    expect(insideConvex({ x: 1100, y: 0 }, cs)).toBe(false);
  });

  it('is picked by its body and found by window selection', () => {
    const { doc } = plant();
    const index = new SpatialIndex(doc);
    expect(index.pick({ x: 500, y: 300 }, 10)?.id).toBe('m1');
    // Bench turned 90°: 750 wide along X, 1800 along Y.
    expect(index.pick({ x: 10300, y: 0 }, 10)?.id).toBe('m2');
    expect(index.pick({ x: 10500, y: 0 }, 10)).toBeNull();
    const window = { minX: -1600, minY: -1200, maxX: 1600, maxY: 1200 };
    expect(index.select(window, false).map((e) => e.id)).toEqual(['m1']);
    expect(index.select({ minX: 1400, minY: -100, maxX: 1600, maxY: 100 }, true).map((e) => e.id)).toEqual(['m1']);
  });

  it('offers footprint corners as snap points without sharing the equipment point', () => {
    const { doc } = plant();
    const snap = new SnapEngine(doc, new SpatialIndex(doc));
    const r = snap.snap({ x: 1490, y: 1095 }, 50, 100, { object: true, polar: false, grid: false, polarStep: 15 });
    expect(r?.kind).toBe('endpoint');
    expect(r?.point).toMatchObject({ x: 1500, y: 1100 });
    expect(r?.pointId).toBeUndefined();
  });

  it('follows its type when the type is resized, and undo restores it', () => {
    const { doc, history } = plant();
    const types = [...doc.equipmentTypes.values()];
    history.execute(new SetEquipmentTypes('수정', types, types.map((t) => (t.id === 'eq-machine' ? { ...t, width: 5000 } : t))));
    expect(doc.bboxOf(doc.entities.get('m1')!).maxX).toBeCloseTo(2500);
    history.undo();
    expect(doc.bboxOf(doc.entities.get('m1')!).maxX).toBeCloseTo(1500);
  });
});

describe('editing', () => {
  it('numbers new equipment after the highest free tag', () => {
    const { doc } = plant();
    expect(nextTag(doc, doc.equipmentTypes.get('eq-machine')!)).toBe('MC-2');
    expect(nextTag(doc, doc.equipmentTypes.get('eq-machine')!, new Set(['MC-2']))).toBe('MC-3');
  });

  it('array-copies geometry with shared points, constraints and fresh tags', () => {
    const { doc, history } = plant();
    history.execute(new AddConstraints([{ id: 'k', kind: 'horizontal', refs: ['w'] }]));
    const cmd = copyItems(doc, ['m1', 'w'], arrayOffsets(3, 2, 4000, -3000))!;
    history.execute(cmd);
    const machines = [...doc.entities.values()].filter((e) => e.kind === 'equipment' && e.type === 'eq-machine');
    expect(machines).toHaveLength(6);
    expect(new Set(machines.map((e) => e.kind === 'equipment' && e.tag)).size).toBe(6);
    expect([...doc.entities.values()].filter((e) => e.kind === 'line')).toHaveLength(6);
    expect([...doc.constraints.values()].filter((c) => c.kind === 'horizontal')).toHaveLength(6);
    const far = machines.find((e) => e.kind === 'equipment' && doc.point(e.at).x === 8000 && doc.point(e.at).y === -3000);
    expect(far).toBeDefined();
    history.undo();
    expect(doc.entities.size).toBe(3);
    expect(doc.constraints.size).toBe(1);
  });

  it('turns lone equipment in place and a mixed selection as a group', () => {
    const { doc, history } = plant();
    history.execute(rotateItems(doc, ['m1'], 90) as never);
    expect(doc.entities.get('m1')).toMatchObject({ rotation: 90 });
    expect(doc.point('c1')).toMatchObject({ x: 0, y: 0 });
    history.execute(rotateItems(doc, ['m2', 'w'], 90) as never);
    expect(doc.entities.get('m2')).toMatchObject({ rotation: 180 });
    history.undo();
    expect(doc.point('a')).toMatchObject({ x: 0, y: 5000 });
    expect(doc.entities.get('m2')).toMatchObject({ rotation: 90 });
  });

  it('refuses to rotate constrained geometry', () => {
    const { doc, history } = plant();
    history.execute(new AddConstraints([{ id: 'k', kind: 'horizontal', refs: ['w'] }]));
    expect(typeof rotateItems(doc, ['w'], 90)).toBe('string');
    // Fixed equipment still turns in place: its centre doesn't move.
    history.execute(new AddConstraints([{ id: 'f', kind: 'fixed', refs: ['c1'] }]));
    expect(typeof rotateItems(doc, ['m1'], 90)).toBe('object');
  });

  it('moves entities to a layer and back with undo', () => {
    const { doc, history } = plant();
    doc.layers.set('l2', { id: 'l2', name: '설비', color: '#2563eb', visible: true, locked: false, floor: 'floor-1' });
    history.execute(moveToLayer(doc, ['m1', 'm2'], 'l2')!);
    expect(doc.entities.get('m1')?.layer).toBe('l2');
    history.undo();
    expect(doc.entities.get('m1')?.layer).toBe('layer-0');
    expect(moveToLayer(doc, ['w'], 'layer-0')).toBeNull();
  });
});

describe('equipment list and files', () => {
  it('exports a sorted CSV that spreadsheets read as UTF-8 and as text', () => {
    const { doc } = plant();
    const m2 = doc.entities.get('m2');
    if (m2?.kind === 'equipment') m2.tag = '=HYPERLINK("x")';
    expect(equipmentRows(doc).map((r) => r.name)).toEqual(['가공기', '작업대']);
    const csv = equipmentCsv(doc);
    expect(csv.startsWith('﻿번호,설비명')).toBe(true);
    expect(csv).toContain('MC-1,가공기,3000,2200,0,0,0,0');
    expect(csv).toContain(`"'=HYPERLINK(""x"")",작업대`);
  });

  it('round-trips equipment and gives old files the default library', () => {
    const { doc } = plant();
    const back = deserialize(serialize(doc.toData()));
    expect(back.entities.find((e) => e.id === 'm2')).toMatchObject({ kind: 'equipment', rotation: 90, tag: 'WB-1' });
    const old = JSON.parse(serialize(doc.toData()));
    delete old.equipmentTypes;
    old.entities = old.entities.filter((e: { kind: string }) => e.kind !== 'equipment');
    expect(deserialize(JSON.stringify(old)).equipmentTypes.length).toBeGreaterThan(0);
    const broken = JSON.parse(serialize(doc.toData()));
    broken.equipmentTypes = [];
    expect(() => deserialize(JSON.stringify(broken))).toThrow('종류');
  });

  it('parses a type entry', () => {
    expect(parseType('가공기, 3000, 2200, MC')).toEqual({ name: '가공기', width: 3000, depth: 2200, prefix: 'MC' });
    expect(parseType('x, 0, 10')).toBeNull();
    expect(parseType('x, 10')).toBeNull();
  });
});
