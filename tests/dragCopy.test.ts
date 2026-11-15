/**
 * @file dragCopy.test.ts
 *
 * Photoshop-style modifier drags of the select tool (Ctrl+drag, Ctrl+Alt+drag copy, Ctrl+Shift+drag axis lock),
 * object tree moves and copies between layers and floors (transferItems, layerForDrop), unique names of copies,
 * editing entities by id (the label row bug) and the ruler labels.
 */
import { describe, expect, it } from 'vitest';
import { AddConstraints, AddItems, History, UpdateEntities } from '../src/model/commands';
import { DocumentModel } from '../src/model/document';
import { duplicateItems, editEntities, layerForDrop, transferItems, uniqueName } from '../src/model/edit';
import { Selection } from '../src/model/selection';
import { SpatialIndex } from '../src/model/spatial';
import { SelectTool } from '../src/tools/select';
import type { ToolPointer } from '../src/tools/tool';
import { ConstraintService } from '../src/constraints/service';
import type { ShapeEntity } from '../src/model/types';
import { Viewport, rulerLabel, rulerTicks, rulerUnit } from '../src/view/viewport';

function setup() {
  const doc = new DocumentModel();
  const history = new History(doc);
  const selection = new Selection();
  const view = new Viewport();
  view.resize(800, 600);
  view.scale = 1;
  view.centreOn({ x: 0, y: 0 });
  const tool = new SelectTool({
    doc,
    history,
    index: new SpatialIndex(doc),
    selection,
    view,
    unit: () => 'mm',
    layer: () => 'layer-0',
    pickTolerance: () => 5,
    setHover: () => {},
    setHint: () => {},
    requestRender: () => {},
    constraints: new ConstraintService(doc, history, () => Promise.reject(new Error('solver not used here'))),
    notify: () => {},
    ask: () => null,
  });
  history.execute(
    new AddItems(
      [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 100, y: 0 },
      ],
      [{ id: 'l', kind: 'line', p1: 'a', p2: 'b', layer: 'layer-0', name: '벽' }],
    ),
  );
  const at = (x: number, y: number, mods: Partial<ToolPointer> = {}): ToolPointer => {
    const w = { x, y };
    return { world: w, raw: w, snap: null, screen: view.toScreen(w), button: 0, shift: false, ctrl: false, ...mods };
  };
  return { doc, history, selection, tool, at };
}

describe('modifier drags (select tool)', () => {
  it('Ctrl+drag moves the selection even when the press is away from it', () => {
    const { doc, selection, tool, at } = setup();
    selection.set(['l']);
    tool.down(at(300, 200, { ctrl: true }));
    tool.move(at(310, 230, { ctrl: true }));
    tool.up(at(310, 230, { ctrl: true }));
    expect(doc.point('a')).toMatchObject({ x: 10, y: 30 });
    expect(selection.values()).toEqual(['l']);
  });

  it('a plain drag away from the selection still draws a selection window', () => {
    const { doc, selection, tool, at } = setup();
    selection.set(['l']);
    tool.down(at(300, 200));
    tool.move(at(310, 230));
    tool.up(at(310, 230));
    expect(doc.point('a')).toMatchObject({ x: 0, y: 0 });
    expect(selection.size).toBe(0);
  });

  it('Ctrl+Alt+drag moves a copy with the same properties and a new name, as one undo step', () => {
    const { doc, history, selection, tool, at } = setup();
    history.execute(new UpdateEntities('테두리', [doc.entities.get('l')!], [{ ...doc.entities.get('l')!, stroke: { width: 200, align: 'inside', color: '#ff0000' } } as never]));
    tool.down(at(25, 0, { ctrl: true, alt: true }));
    tool.move(at(25, 500, { ctrl: true, alt: true }));
    tool.up(at(25, 500, { ctrl: true, alt: true }));
    expect(doc.point('a')).toMatchObject({ x: 0, y: 0 });
    expect(doc.entities.size).toBe(2);
    const [copyId] = selection.values();
    const copy = doc.entities.get(copyId)!;
    expect(copy.kind).toBe('line');
    expect(copy.name).toBe('벽 (2)');
    if (copy.kind === 'line') {
      expect(copy.stroke).toEqual({ width: 200, align: 'inside', color: '#ff0000' });
      expect(doc.point(copy.p1)).toMatchObject({ x: 0, y: 500 });
    }
    history.undo();
    expect(doc.entities.size).toBe(1);
  });

  it('Alt+drag that is cancelled leaves no copy behind', () => {
    const { doc, selection, tool, at } = setup();
    tool.down(at(25, 0, { alt: true }));
    tool.move(at(25, 500, { alt: true }));
    tool.interrupt();
    expect(doc.entities.size).toBe(1);
    expect(selection.values()).toEqual(['l']);
  });

  it('Ctrl+Shift+drag keeps to the horizontal or vertical', () => {
    const { doc, tool, at } = setup();
    tool.down(at(25, 0, { ctrl: true, shift: true }));
    tool.move(at(65, 15, { ctrl: true, shift: true }));
    tool.up(at(65, 15, { ctrl: true, shift: true }));
    expect(doc.point('a')).toMatchObject({ x: 40, y: 0 });
  });

  it('Ctrl+drag over another object still moves the selection, and Ctrl+click selects that object', () => {
    const { doc, history, selection, tool, at } = setup();
    history.execute(new AddItems([{ id: 'c', x: 300, y: 200 }], [{ id: 'pt', kind: 'point', at: 'c', layer: 'layer-0' }]));
    selection.set(['l']);
    tool.down(at(300, 200, { ctrl: true }));
    tool.move(at(310, 230, { ctrl: true }));
    tool.up(at(310, 230, { ctrl: true }));
    expect(doc.point('a')).toMatchObject({ x: 10, y: 30 });
    expect(doc.point('c')).toMatchObject({ x: 300, y: 200 });
    expect(selection.values()).toEqual(['l']);
    tool.down(at(300, 200, { ctrl: true }));
    tool.up(at(300, 200, { ctrl: true }));
    expect(selection.values()).toEqual(['pt']);
  });

  it('Ctrl+Shift+click on an object selects it rather than toggling it', () => {
    const { selection, tool, at } = setup();
    selection.set(['l']);
    tool.down(at(25, 0, { ctrl: true, shift: true }));
    tool.up(at(25, 0, { ctrl: true, shift: true }));
    expect(selection.values()).toEqual(['l']);
  });
});

describe('unique names of copies', () => {
  it('numbers copies after the name, continuing an existing number', () => {
    expect(uniqueName('벽', new Set())).toBe('벽');
    expect(uniqueName('벽', new Set(['벽']))).toBe('벽 (2)');
    expect(uniqueName('벽', new Set(['벽', '벽 (2)']))).toBe('벽 (3)');
    expect(uniqueName('벽 (2)', new Set(['벽', '벽 (2)']))).toBe('벽 (3)');
  });

  it('gives every copy of an array its own name and leaves unnamed objects unnamed', () => {
    const doc = new DocumentModel();
    const history = new History(doc);
    history.execute(
      new AddItems(
        [
          { id: 'a', x: 0, y: 0 },
          { id: 'b', x: 100, y: 0 },
          { id: 'c', x: 0, y: 100 },
        ],
        [
          { id: 'l', kind: 'line', p1: 'a', p2: 'b', layer: 'layer-0', name: '벽' },
          { id: 'p', kind: 'point', at: 'c', layer: 'layer-0' },
        ],
      ),
    );
    const dup = duplicateItems(doc, ['l', 'p'], [{ x: 0, y: 1000 }, { x: 0, y: 2000 }])!;
    history.execute(dup.command);
    const names = dup.ids.map((id) => doc.entities.get(id)!.name);
    expect(names).toEqual(['벽 (2)', undefined, '벽 (3)', undefined]);
  });
});

function twoFloors() {
  const doc = new DocumentModel();
  const history = new History(doc);
  doc.floors.set('floor-2', { id: 'floor-2', name: '2층', elevation: 4000, height: 4000 });
  doc.folders.set('g1', { id: 'g1', name: '설비', floor: 'floor-1', visible: true, locked: false });
  doc.folders.set('g-empty', { id: 'g-empty', name: '빈 폴더', floor: 'floor-1', visible: true, locked: false });
  doc.layers.set('l-g1', { id: 'l-g1', name: '기계', color: '#000000', visible: true, locked: false, floor: 'floor-1', folder: 'g1' });
  doc.layers.set('l-2', { id: 'l-2', name: '0', color: '#000000', visible: true, locked: false, floor: 'floor-2' });
  // A square room (shape over four lines) and a loose line sharing a corner with it.
  const pts = [
    { id: 'p1', x: 0, y: 0 },
    { id: 'p2', x: 1000, y: 0 },
    { id: 'p3', x: 1000, y: 1000 },
    { id: 'p4', x: 0, y: 1000 },
    { id: 'p5', x: 2000, y: 0 },
  ];
  const ids = ['p1', 'p2', 'p3', 'p4'];
  const edges = ids.map((pid, i) => ({ id: `e${i}`, kind: 'line' as const, p1: pid, p2: ids[(i + 1) % 4], layer: 'layer-0' }));
  const shape: ShapeEntity = { id: 's', kind: 'shape', points: ids, edges: edges.map((e) => e.id), layer: 'layer-0', name: '실', label: { items: [{ title: '용도', value: '창고' }] } };
  history.execute(new AddItems(pts, [...edges, shape, { id: 'x', kind: 'line', p1: 'p2', p2: 'p5', layer: 'layer-0' }]));
  return { doc, history };
}

describe('object tree drops', () => {
  it('picks the layer a floor or folder drop goes to', () => {
    const { doc } = twoFloors();
    expect(layerForDrop(doc, { kind: 'layer', id: 'l-g1' }, 'layer-0')).toBe('l-g1');
    expect(layerForDrop(doc, { kind: 'folder', id: 'g1' }, 'layer-0')).toBe('l-g1');
    expect(layerForDrop(doc, { kind: 'floor', id: 'floor-2' }, 'layer-0')).toBe('l-2');
    expect(layerForDrop(doc, { kind: 'floor', id: 'floor-1' }, 'l-g1')).toBe('l-g1');
    expect(layerForDrop(doc, { kind: 'folder', id: 'g-empty' }, 'layer-0')).toBeNull();
  });

  it('moves a shape with its edges to another floor and splits the corner it shared with a line left behind', () => {
    const { doc, history } = twoFloors();
    history.execute(transferItems(doc, ['s'], 'l-2')!);
    for (const id of ['s', 'e0', 'e1', 'e2', 'e3']) expect(doc.entities.get(id)!.layer).toBe('l-2');
    const x = doc.entities.get('x')!;
    const e0 = doc.entities.get('e0')!;
    expect(x.layer).toBe('layer-0');
    // p2 stays with the line on floor 1; the room got its own copy at the same place.
    if (x.kind === 'line' && e0.kind === 'line') {
      expect(x.p1).toBe('p2');
      expect(e0.p2).not.toBe('p2');
      expect(doc.point(e0.p2)).toMatchObject({ x: 1000, y: 0 });
    }
    history.undo();
    expect(doc.entities.get('e0')!.layer).toBe('layer-0');
    const back = doc.entities.get('e0')!;
    if (back.kind === 'line') expect(back.p2).toBe('p2');
  });

  it('moves objects from a floor that is not the one in view', () => {
    const { doc, history } = twoFloors();
    history.execute(transferItems(doc, ['s'], 'l-2')!);
    doc.activeFloor = 'floor-2';
    history.execute(transferItems(doc, ['x'], 'l-g1')!); // x is on floor 1, not in view
    expect(doc.entities.get('x')!.layer).toBe('l-g1');
    doc.layers.get('l-g1')!.locked = true;
    expect(transferItems(doc, ['e0'], 'l-g1')).not.toBeNull(); // from floor 2 (open) …
    expect(transferItems(doc, ['x'], 'l-2')).toBeNull(); // … but not off a locked layer
  });

  it('takes a dragged edge line along with its shape and the shape\'s other edges', () => {
    const { doc, history } = twoFloors();
    history.execute(transferItems(doc, ['e1'], 'l-g1')!);
    for (const id of ['s', 'e0', 'e1', 'e2', 'e3']) expect(doc.entities.get(id)!.layer).toBe('l-g1');
    expect(doc.entities.get('x')!.layer).toBe('layer-0');
  });

  it('keeps shared points within one floor and removes coincident constraints that would span floors', () => {
    const { doc, history } = twoFloors();
    history.execute(new AddItems([{ id: 'q', x: 2000, y: 0 }], [{ id: 'pt', kind: 'point', at: 'q', layer: 'layer-0' }]));
    history.execute(new AddConstraints([{ id: 'k', kind: 'coincident', refs: ['q', 'p5'] }]));
    history.execute(transferItems(doc, ['pt'], 'l-g1')!);
    expect(doc.constraints.has('k')).toBe(true); // same floor: kept
    history.execute(transferItems(doc, ['pt'], 'l-2')!);
    expect(doc.constraints.has('k')).toBe(false);
  });

  it('copies to another layer with the same properties and a new name', () => {
    const { doc, history } = twoFloors();
    const dup = duplicateItems(doc, ['s'], [{ x: 0, y: 0 }], { layer: 'l-2', label: '복사' })!;
    history.execute(dup.command);
    const copy = doc.entities.get(dup.ids[0]) as ShapeEntity;
    expect(copy.layer).toBe('l-2');
    expect(copy.name).toBe('실 (2)');
    expect(copy.label).toEqual({ items: [{ title: '용도', value: '창고' }] });
    for (const id of copy.edges) expect(doc.entities.get(id)!.layer).toBe('l-2');
    expect(doc.entities.get('s')!.layer).toBe('layer-0');
  });
});

describe('editing by id (label rows bug)', () => {
  it('an edit made from an out-of-date copy of the entity keeps later changes', () => {
    const { doc, history } = twoFloors();
    const stale = doc.entities.get('s')!; // what a panel was built from
    // A label row is added, then the face colour is changed from the same, not yet rebuilt panel.
    history.execute(editEntities(doc, '라벨 항목 추가', [stale.id], (c) => c.kind === 'shape' && c.label!.items!.push({ title: '면적', value: '1' }))!);
    history.execute(editEntities(doc, '면 색', [stale.id], (c) => c.kind === 'shape' && (c.fill = '#00ff00'))!);
    const s = doc.entities.get('s') as ShapeEntity;
    expect(s.fill).toBe('#00ff00');
    expect(s.label?.items).toEqual([
      { title: '용도', value: '창고' },
      { title: '면적', value: '1' },
    ]);
    history.undo();
    expect((doc.entities.get('s') as ShapeEntity).label?.items).toHaveLength(2);
  });
});

describe('ruler labels', () => {
  it('labels grid lines in the unit that keeps them whole', () => {
    expect(rulerUnit(5)).toBe('mm');
    expect(rulerUnit(50)).toBe('cm');
    expect(rulerUnit(500)).toBe('cm');
    expect(rulerUnit(1000)).toBe('m');
    expect(rulerUnit(5000)).toBe('m');
    expect(rulerLabel(1500, 'cm')).toBe('150');
    expect(rulerLabel(-3000, 'm')).toBe('-3');
    expect(rulerLabel(-0, 'mm')).toBe('0');
  });

  it('lists the major lines in view with their distance from the origin', () => {
    // 0.1 px/mm: minor 200 mm, major 1000 mm.
    const r = rulerTicks(-2500, 2500, 0.1);
    expect(r.unit).toBe('m');
    expect(r.major.map((t) => t.label)).toEqual(['-2', '-1', '0', '1', '2']);
    expect(r.minor).not.toContain(0);
    expect(r.minor).toContain(200);
  });
});
