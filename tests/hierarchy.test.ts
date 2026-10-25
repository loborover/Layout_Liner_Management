import { describe, expect, it } from 'vitest';
import { AddItems, History, RemoveEntities, SetLayerTree, captureLayerTree } from '../src/model/commands';
import { DocumentModel } from '../src/model/document';
import { copyItems, findLoops, makeShapes, reorderItems } from '../src/model/edit';
import { SpatialIndex } from '../src/model/spatial';
import { StrokeGeometry } from '../src/model/strokes';
import { connectedFloors, presetInfo } from '../src/model/presets';
import { deserialize, serialize } from '../src/io/serialize';
import type { LineEntity, Point } from '../src/model/types';

/** A 4 m × 3 m room as four lines over shared corners (no shape yet). */
function room(_doc: DocumentModel, history: History) {
  const pts: Point[] = [
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: 4000, y: 0 },
    { id: 'c', x: 4000, y: 3000 },
    { id: 'd', x: 0, y: 3000 },
  ];
  const lines: LineEntity[] = ['ab', 'bc', 'cd', 'da'].map((id) => ({ id, kind: 'line', p1: id[0], p2: id[1], layer: 'layer-0' }));
  history.execute(new AddItems(pts, lines));
}

describe('point → line → face → shape', () => {
  it('finds a closed loop of lines and makes it a shape once', () => {
    const doc = new DocumentModel();
    const history = new History(doc);
    room(doc, history);
    expect(findLoops(doc, ['ab', 'bc', 'cd', 'da'])).toHaveLength(1);
    expect(findLoops(doc, ['ab', 'bc', 'cd'])).toHaveLength(0);
    const made = makeShapes(doc, ['ab', 'bc', 'cd', 'da'])!;
    history.execute(made.command);
    expect(doc.shapeArea(made.shapes[0])).toBeCloseTo(12e6);
    expect(makeShapes(doc, ['ab', 'bc', 'cd', 'da'])).toBeNull();
  });

  it('removes a shape with its lines, and a line takes its shape with it; undo restores order', () => {
    const doc = new DocumentModel();
    const history = new History(doc);
    room(doc, history);
    const { command, shapes } = makeShapes(doc, ['ab', 'bc', 'cd', 'da'])!;
    history.execute(command);
    const order = [...doc.entities.keys()];
    history.execute(new RemoveEntities(['bc']));
    expect(doc.entities.has(shapes[0].id)).toBe(false);
    expect(doc.entities.has('ab')).toBe(true);
    history.undo();
    expect([...doc.entities.keys()]).toEqual(order);
    history.execute(new RemoveEntities([shapes[0].id]));
    expect(doc.entities.size).toBe(0);
    expect(doc.points.size).toBe(0);
  });

  it('picks lines on the outline and the shape inside its face', () => {
    const doc = new DocumentModel();
    const history = new History(doc);
    room(doc, history);
    const { command, shapes } = makeShapes(doc, ['ab', 'bc', 'cd', 'da'])!;
    history.execute(command);
    const index = new SpatialIndex(doc);
    expect(index.pick({ x: 2000, y: 2 }, 10)?.id).toBe('ab');
    expect(index.pick({ x: 2000, y: 1500 }, 10)?.id).toBe(shapes[0].id);
  });

  it('copies a shape together with its lines', () => {
    const doc = new DocumentModel();
    const history = new History(doc);
    room(doc, history);
    const { command, shapes } = makeShapes(doc, ['ab', 'bc', 'cd', 'da'])!;
    history.execute(command);
    history.execute(copyItems(doc, [shapes[0].id], [{ x: 5000, y: 0 }])!);
    const copies = [...doc.entities.values()].filter((e) => e.kind === 'shape');
    expect(copies).toHaveLength(2);
    const copy = copies[1];
    expect(copy.kind === 'shape' && copy.edges.every((id) => doc.entities.get(id)?.kind === 'line')).toBe(true);
    expect(copy.kind === 'shape' && doc.point(copy.points[0]).x).toBe(5000);
  });

  it('reorders entities and undoes it', () => {
    const doc = new DocumentModel();
    const history = new History(doc);
    room(doc, history);
    history.execute(reorderItems(doc, ['ab'], 'front')!);
    expect([...doc.entities.keys()].at(-1)).toBe('ab');
    history.execute(reorderItems(doc, ['ab'], 'backward')!);
    expect([...doc.entities.keys()]).toEqual(['bc', 'cd', 'ab', 'da']);
    history.undo();
    history.undo();
    expect([...doc.entities.keys()]).toEqual(['ab', 'bc', 'cd', 'da']);
  });
});

describe('floors and folders', () => {
  it('shows and edits only the active floor and respects folder visibility and locks', () => {
    const doc = new DocumentModel();
    const history = new History(doc);
    room(doc, history);
    const before = captureLayerTree(doc);
    const after = captureLayerTree(doc);
    after.floors.push({ id: 'f2', name: '2층', elevation: 4000, height: 4000 });
    after.folders.push({ id: 'g', name: '건축', floor: 'floor-1', visible: true, locked: false });
    after.layers[0].folder = 'g';
    history.execute(new SetLayerTree('트리', before, after));
    const e = doc.entities.get('ab')!;
    expect(doc.isEditable(e)).toBe(true);
    doc.folders.get('g')!.locked = true;
    expect(doc.isVisible(e)).toBe(true);
    expect(doc.isEditable(e)).toBe(false);
    doc.folders.get('g')!.locked = false;
    doc.activeFloor = 'f2';
    expect(doc.isVisible(e)).toBe(false);
    history.undo();
    expect(doc.floors.has('f2')).toBe(false);
    expect(doc.activeFloor).toBe('floor-1');
  });

  it('upgrades version 1 files onto one floor with the structural presets', () => {
    const v1 = {
      format: 'layout-liner',
      version: 1,
      units: 'mm',
      points: [{ id: 'p', x: 0, y: 0 }],
      entities: [{ id: 'm', kind: 'equipment', type: 'eq-bench', at: 'p', rotation: 0, tag: 'WB-1', layer: 'layer-0' }],
      constraints: [],
      layers: [{ id: 'layer-0', name: '0', color: '#000000', visible: true, locked: false }],
      equipmentTypes: [{ id: 'eq-bench', name: '작업대', width: 1800, depth: 750, prefix: 'WB' }],
    };
    const data = deserialize(JSON.stringify(v1));
    expect(data.version).toBe(3);
    expect(data.floors).toHaveLength(1);
    expect(data.layers[0].floor).toBe(data.floors[0].id);
    expect(data.equipmentTypes.some((t) => t.category === 'stair')).toBe(true);
  });

  it('round-trips shapes, styles, folders, props and bindings', () => {
    const doc = new DocumentModel();
    const history = new History(doc);
    room(doc, history);
    history.execute(makeShapes(doc, ['ab', 'bc', 'cd', 'da'], '사무실')!.command);
    const ab = doc.entities.get('ab') as LineEntity;
    ab.stroke = { width: 200, align: 'inside', color: '#334155' };
    ab.binding = 'wall.temp';
    doc.folders.set('g', { id: 'g', name: '건축', floor: 'floor-1', visible: false, locked: false });
    const back = deserialize(serialize(doc.toData()));
    const doc2 = new DocumentModel();
    doc2.load(back);
    expect(doc2.toData()).toEqual(doc.toData());
  });

  it('rejects a shape whose edges do not follow its points', () => {
    const doc = new DocumentModel();
    const history = new History(doc);
    room(doc, history);
    const data = doc.toData();
    data.entities.push({ id: 's', kind: 'shape', points: ['a', 'b', 'c', 'd'], edges: ['ab', 'cd', 'bc', 'da'], layer: 'layer-0' });
    expect(() => deserialize(JSON.stringify(data))).toThrow(/변/);
  });
});

describe('line styles', () => {
  it('lays an inside band towards the room and mitres the corners', () => {
    const doc = new DocumentModel();
    const history = new History(doc);
    room(doc, history);
    history.execute(makeShapes(doc, ['ab', 'bc', 'cd', 'da'])!.command);
    for (const id of ['ab', 'bc', 'cd', 'da']) (doc.entities.get(id) as LineEntity).stroke = { width: 200, align: 'inside' };
    doc.changed();
    const band = new StrokeGeometry(doc).band('ab')!;
    // Outer edge on the line, inner edge 200 mm inside, mitred to the inner corners (200, 200) and (3800, 200).
    expect(band.map((p) => [Math.round(p.x), Math.round(p.y)])).toEqual([
      [0, 0],
      [4000, 0],
      [3800, 200],
      [200, 200],
    ]);
  });

  it('centres a band on a free line and squares its ends', () => {
    const doc = new DocumentModel();
    const history = new History(doc);
    history.execute(
      new AddItems(
        [
          { id: 'a', x: 0, y: 0 },
          { id: 'b', x: 1000, y: 0 },
        ],
        [{ id: 'l', kind: 'line', p1: 'a', p2: 'b', layer: 'layer-0', stroke: { width: 100, align: 'center' } }],
      ),
    );
    const band = new StrokeGeometry(doc).band('l')!;
    expect(band.map((p) => [p.x, p.y])).toEqual([
      [0, -50],
      [1000, -50],
      [1000, 50],
      [0, 50],
    ]);
  });
});

describe('structural presets', () => {
  it('counts stair steps from the floor height and flags a steep ramp', () => {
    const doc = new DocumentModel();
    const history = new History(doc);
    history.execute(
      new AddItems(
        [{ id: 'p', x: 0, y: 0 }, { id: 'q', x: 5000, y: 0 }],
        [
          { id: 's', kind: 'equipment', type: 'st-stair', at: 'p', rotation: 0, tag: 'ST-1', layer: 'layer-0' },
          { id: 'r', kind: 'equipment', type: 'st-ramp', at: 'q', rotation: 0, tag: 'RP-1', layer: 'layer-0', props: { rise: 1000 } },
        ],
      ),
    );
    const stair = presetInfo(doc, doc.entities.get('s') as never);
    expect(stair.find((r) => r.label === '단 수')?.value).toMatch(/^24단/); // 4000 / 170 → 24 steps
    const ramp = presetInfo(doc, doc.entities.get('r') as never);
    expect(ramp.find((r) => r.label === '기울기')?.warning).toBeDefined(); // 1000 over 9000 is steeper than 1/12
  });

  it('lists the floors a lift serves', () => {
    const doc = new DocumentModel();
    doc.floors.set('f2', { id: 'f2', name: '2층', elevation: 4000, height: 4000 });
    const history = new History(doc);
    history.execute(
      new AddItems(
        [{ id: 'p', x: 0, y: 0 }],
        [{ id: 'l', kind: 'equipment', type: 'st-lift', at: 'p', rotation: 0, tag: 'LF-1', layer: 'layer-0', props: { floors: 'floor-1, f2, nope' } }],
      ),
    );
    expect(connectedFloors(doc, doc.entities.get('l') as never)).toEqual(['floor-1', 'f2']);
  });
});

describe('cross-floor visibility', () => {
  it('a hidden layer stays hidden from other floors', () => {
    const doc = new DocumentModel();
    const layer = doc.layers.values().next().value!;
    expect(doc.isLayerShown(layer.id)).toBe(true);
    doc.activeFloor = 'elsewhere';
    expect(doc.isLayerVisible(layer.id)).toBe(false);
    expect(doc.isLayerShown(layer.id)).toBe(true);
    layer.visible = false;
    expect(doc.isLayerShown(layer.id)).toBe(false);
  });
});
