/**
 * Follow-up requests of 2026-11-15: border corners that stay on their side of the reference line (with mitre,
 * round and chamfer joins), fillet/chamfer/vertex editing, shape labels and label objects, and the column
 * generator with the H-beam section.
 */
import { describe, expect, it } from 'vitest';
import { EditorApi } from '../src/api/editorApi';
import { dispatch } from '../src/api/rpc';
import { FormatError, deserialize, serialize } from '../src/io/serialize';
import { drawingSvg } from '../src/io/svg';
import { writeDxf } from '../src/io/dxfExport';
import { insidePolygon, polygonArea, polygonCentroid, polygonLabelPoint } from '../src/geom/polygon';
import type { Vec2 } from '../src/geom/vec';
import { AddItems, History } from '../src/model/commands';
import { editCorner, insertVertex, maxCornerSize, removeVertex } from '../src/model/corners';
import { DocumentModel } from '../src/model/document';
import { blockLayout, labelBox, parseLabelText, shapeLabelPlacement, shapeLabelRows } from '../src/model/labels';
import { columnTypeFor, presetInfo } from '../src/model/presets';
import { SpatialIndex } from '../src/model/spatial';
import { StrokeGeometry } from '../src/model/strokes';
import { planSymbol } from '../src/model/symbols';
import type { LabelEntity, LineEntity, ShapeEntity, StrokeStyle } from '../src/model/types';

/** A closed shape through the given corners, every edge with the given border. */
function polygonShape(corners: Vec2[], stroke?: StrokeStyle) {
  const doc = new DocumentModel();
  const history = new History(doc);
  const points = corners.map((c, i) => ({ id: `p${i}`, ...c }));
  const lines: LineEntity[] = points.map((p, i) => ({ id: `l${i}`, kind: 'line', p1: p.id, p2: points[(i + 1) % points.length].id, layer: 'layer-0', ...(stroke ? { stroke: { ...stroke } } : {}) }));
  const shape: ShapeEntity = { id: 's', kind: 'shape', points: points.map((p) => p.id), edges: lines.map((l) => l.id), layer: 'layer-0', name: '구역' };
  history.execute(new AddItems(points, [...lines, shape]));
  return { doc, history, shape: () => doc.entities.get('s') as ShapeEntity };
}

/** Signed distance of p inside a convex counter-clockwise polygon (negative outside). */
function depthInside(p: Vec2, poly: Vec2[]): number {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    d = Math.min(d, ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / len);
  }
  return d;
}

// A long, sharp triangle like the one in the user's screenshot: about 23° at the right-hand corner.
const SHARP = [
  { x: 0, y: 0 },
  { x: 10000, y: 0 },
  { x: 0, y: 4200 },
];

describe('border corners', () => {
  it('keeps an inside border inside the shape at a sharp corner', () => {
    const { doc } = polygonShape(SHARP, { width: 200, align: 'inside' });
    const bands = new StrokeGeometry(doc).all();
    expect(bands.size).toBe(3);
    for (const band of bands.values()) for (const p of band) expect(depthInside(p, SHARP)).toBeGreaterThan(-1e-6);
    // The inner corner at the sharp end is the exact crossing of the two inner edges, far beyond a square end.
    const tip = Math.max(...[...bands.values()].flat().map((p) => p.x));
    expect(tip).toBe(10000);
  });

  it('keeps an outside border outside the shape, closing the outer corners by the chosen join', () => {
    for (const join of ['miter', 'round', 'bevel'] as const) {
      const { doc } = polygonShape(SHARP, { width: 200, align: 'outside', join });
      for (const band of new StrokeGeometry(doc).all().values()) for (const p of band) expect(depthInside(p, SHARP)).toBeLessThan(1e-6);
    }
    // Round: the corner is covered by arc points 200 mm from the corner point.
    const round = polygonShape(SHARP, { width: 200, align: 'outside', join: 'round' });
    const band = new StrokeGeometry(round.doc).band('l0')!;
    const nearCorner = band.filter((p) => Math.abs(Math.hypot(p.x - 10000, p.y) - 200) < 1e-6);
    expect(nearCorner.length).toBeGreaterThan(2);
  });

  it('chamfers or rounds the outer corner of a square room and mitres it by default', () => {
    const square = [
      { x: 0, y: 0 },
      { x: 4000, y: 0 },
      { x: 4000, y: 4000 },
      { x: 0, y: 4000 },
    ];
    const at = (join?: 'round' | 'bevel') => new StrokeGeometry(polygonShape(square, { width: 200, align: 'outside', ...(join ? { join } : {}) }).doc).band('l0')!;
    const r = (pts: Vec2[]) => pts.map((p) => [Math.round(p.x), Math.round(p.y)]);
    // l0 runs (0,0) → (4000,0); its outside is below. Mitre: corners at (-200,-200) and (4200,-200).
    expect(r(at())).toEqual([
      [-200, -200],
      [4200, -200],
      [4000, 0],
      [0, 0],
    ]);
    // Chamfer: the outer edge stops square at the corner and is cut across to the bisector.
    expect(r(at('bevel'))).toContainEqual([4100, -100]);
    expect(r(at('bevel'))).toContainEqual([4000, -200]);
    for (const p of at('round').slice(2, -2)) expect(Math.hypot(p.x - 4000, p.y) > 199.99 || Math.hypot(p.x, p.y) > 199.99).toBe(true);
  });

  it('joins bands of separate objects held together by a coincident point', () => {
    const doc = new DocumentModel();
    const history = new History(doc);
    const s: StrokeStyle = { width: 100, align: 'center' };
    history.execute(
      new AddItems(
        [
          { id: 'a', x: 0, y: 0 },
          { id: 'b', x: 1000, y: 0 },
          { id: 'b2', x: 1000, y: 0 },
          { id: 'c', x: 1000, y: 1000 },
        ],
        [
          { id: 'l1', kind: 'line', p1: 'a', p2: 'b', layer: 'layer-0', stroke: s },
          { id: 'l2', kind: 'line', p1: 'b2', p2: 'c', layer: 'layer-0', stroke: s },
        ],
      ),
    );
    const band = new StrokeGeometry(doc).band('l1')!;
    // Mitred (1050, -50) on the outer side and (950, 50) on the inner side instead of a square end at x = 1000.
    expect(band.map((p) => [Math.round(p.x), Math.round(p.y)])).toEqual([
      [0, -50],
      [1050, -50],
      [950, 50],
      [0, 50],
    ]);
  });

  it('saves the join and rejects an unknown one', () => {
    const { doc } = polygonShape(SHARP, { width: 200, align: 'outside', join: 'round' });
    const back = deserialize(serialize(doc.toData()));
    expect((back.entities.find((e) => e.id === 'l0') as LineEntity).stroke?.join).toBe('round');
    const bad = doc.toData();
    (bad.entities[0] as LineEntity).stroke!.join = 'square' as never;
    expect(() => deserialize(JSON.stringify(bad))).toThrow(FormatError);
  });
});

describe('fillet, chamfer and vertices', () => {
  const room = [
    { x: 0, y: 0 },
    { x: 4000, y: 0 },
    { x: 4000, y: 3000 },
    { x: 0, y: 3000 },
  ];

  it('rounds a corner with short lines on the arc and keeps the shape closed', () => {
    const { doc, history, shape } = polygonShape(room, { width: 100, align: 'inside' });
    const cmd = editCorner(doc, 'p1', 'fillet', 1000);
    expect(typeof cmd).not.toBe('string');
    history.execute(cmd as never);
    const s = shape();
    expect(s.points.length).toBeGreaterThan(5);
    expect(s.points.length).toBe(s.edges.length);
    // Every new corner lies on the arc of radius 1000 about (3000, 1000).
    for (const id of s.points.slice(1, -2)) {
      const p = doc.point(id);
      if (p.x > 3000 && p.y < 1000) expect(Math.hypot(p.x - 3000, p.y - 1000)).toBeCloseTo(1000, 6);
    }
    // Area: the rectangle minus the corner outside the quarter circle, (1 - π/4) m², within the polygon error.
    const lost = 12e6 - doc.shapeArea(s);
    expect(lost).toBeGreaterThan((1 - Math.PI / 4) * 1e6);
    expect(lost).toBeLessThan((1 - Math.PI / 4) * 1e6 * 1.1);
    // The shape still validates as a loop of its lines, and the new lines carry the border.
    expect(() => deserialize(serialize(doc.toData()))).not.toThrow();
    expect((doc.entities.get(s.edges[2]) as LineEntity).stroke?.width).toBe(100);
    history.undo();
    expect(shape().points).toEqual(['p0', 'p1', 'p2', 'p3']);
    expect(doc.point('p1')).toMatchObject({ x: 4000, y: 0 });
  });

  it('chamfers a corner and refuses a size that does not fit', () => {
    const { doc, history, shape } = polygonShape(room);
    history.execute(editCorner(doc, 'p2', 'chamfer', 500) as never);
    expect(shape().points).toHaveLength(5);
    expect(doc.shapeArea(shape())).toBeCloseTo(12e6 - 500 * 500 * 0.5, 3);
    expect(maxCornerSize(doc, 'p0', 'fillet')).toBeCloseTo(3000, 6);
    expect(editCorner(doc, 'p0', 'fillet', 3500)).toMatch(/최대/);
    expect(editCorner(doc, 'p0', 'chamfer', 0)).toMatch(/0보다/);
  });

  it('inserts a vertex on an edge and removes it again', () => {
    const { doc, history, shape } = polygonShape(room);
    const r = insertVertex(doc, 'l2', { x: 1500, y: 3100 });
    if (typeof r === 'string') throw new Error(r);
    history.execute(r.command);
    expect(doc.point(r.point)).toMatchObject({ x: 1500, y: 3000 });
    expect(shape().points).toHaveLength(5);
    expect(doc.shapeArea(shape())).toBeCloseTo(12e6, 3);
    expect(() => deserialize(serialize(doc.toData()))).not.toThrow();
    // Pull the new corner up: the room grows by the triangle.
    doc.point(r.point).y = 4000;
    doc.changed();
    expect(doc.shapeArea(shape())).toBeCloseTo(12e6 + (4000 * 1000) / 2, 3);
    history.execute(removeVertex(doc, r.point) as never);
    expect(shape().points).toHaveLength(4);
    expect(doc.points.has(r.point)).toBe(false);
    expect(doc.shapeArea(shape())).toBeCloseTo(12e6, 3);
    expect(() => deserialize(serialize(doc.toData()))).not.toThrow();
    expect(removeVertex(doc, 'p0')).toBeTypeOf('object');
    // A triangle keeps its corners.
    const tri = polygonShape(SHARP);
    expect(removeVertex(tri.doc, 'p0')).toMatch(/세 개/);
  });
});

describe('labels', () => {
  const L = [
    { x: 0, y: 0 },
    { x: 6000, y: 0 },
    { x: 6000, y: 2000 },
    { x: 2000, y: 2000 },
    { x: 2000, y: 6000 },
    { x: 0, y: 6000 },
  ];

  it('puts a shape label at the area centroid, or inside an L shape', () => {
    expect(polygonCentroid([{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 2000 }, { x: 0, y: 2000 }])).toEqual({ x: 2000, y: 1000 });
    const p = polygonLabelPoint(L);
    expect(insidePolygon(p, L)).toBe(true);
    const { doc } = polygonShape(SHARP);
    const s = doc.entities.get('s') as ShapeEntity;
    const c = shapeLabelPlacement(doc, s).at;
    expect(c.x).toBeCloseTo(10000 / 3, 6);
    expect(c.y).toBeCloseTo(1400, 6);
  });

  it('places the label against the chosen side, offset, with its title: content rows', () => {
    const { doc } = polygonShape([{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 2000 }, { x: 0, y: 2000 }]);
    const s = doc.entities.get('s') as ShapeEntity;
    s.label = { anchor: 'top', dy: -100, items: [{ title: '담당', value: '생산1팀' }, { title: '', value: '메모' }], showArea: false };
    expect(shapeLabelPlacement(doc, s)).toEqual({ at: { x: 2000, y: 1900 }, anchor: 'top' });
    expect(shapeLabelRows(s, '8.00 m²')).toEqual(['구역', '담당: 생산1팀', '메모']);
    s.label = { anchor: 'left' };
    expect(shapeLabelPlacement(doc, s).at).toEqual({ x: 0, y: 1000 });
    // Screen layout: a top anchor hangs the block below the point, a left anchor runs text to the right.
    expect(blockLayout('top', { x: 0, y: 0 }, 2, 10)).toEqual({ align: 'center', x: 0, ys: [5, 15] });
    expect(blockLayout('left', { x: 0, y: 0 }, 1, 10, 4)).toEqual({ align: 'left', x: 4, ys: [0] });
  });

  it('reads typed rows', () => {
    expect(parseLabelText('구역: A동 | 담당：생산1팀 | 메모')).toEqual([
      { title: '구역', value: 'A동' },
      { title: '담당', value: '생산1팀' },
      { title: '', value: '메모' },
    ]);
  });

  it('round-trips shape labels and label objects, and checks them', () => {
    const { doc, history } = polygonShape(L);
    (doc.entities.get('s') as ShapeEntity).label = { anchor: 'bottom', opacity: 0.5, visible: false, items: [{ title: 'a', value: 'b' }], dx: 10 };
    history.execute(new AddItems([{ id: 't', x: 100, y: 100 }], [{ id: 'lab', kind: 'label', at: 't', layer: 'layer-0', items: [{ title: '구역', value: 'A' }], size: 200, anchor: 'left', color: '#123456', opacity: 0.8 }]));
    const back = deserialize(serialize(doc.toData()));
    const doc2 = new DocumentModel();
    doc2.load(back);
    expect(doc2.toData()).toEqual(doc.toData());
    const data = doc.toData();
    (data.entities.find((e) => e.id === 'lab') as LabelEntity).anchor = 'middle' as never;
    expect(() => deserialize(JSON.stringify(data))).toThrow(/배치 기준/);
    (data.entities.find((e) => e.id === 'lab') as LabelEntity).anchor = 'left';
    (data.entities.find((e) => e.id === 'lab') as LabelEntity).items = [{ title: {} as never, value: '' }];
    expect(() => deserialize(JSON.stringify(data))).toThrow(/라벨 항목/);
  });

  it('picks a label object by its text and exports labels', () => {
    const { doc, history } = polygonShape([{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 2000 }, { x: 0, y: 2000 }]);
    history.execute(new AddItems([{ id: 't', x: 10000, y: 0 }], [{ id: 'lab', kind: 'label', at: 't', layer: 'layer-0', items: [{ title: '', value: 'ABCDEFGHIJ' }], anchor: 'left' }]));
    const box = labelBox(doc, doc.entities.get('lab') as LabelEntity);
    expect(box.minX).toBe(10000);
    expect(box.maxX).toBeGreaterThan(11000);
    const index = new SpatialIndex(doc);
    expect(index.pick({ x: 11000, y: 0 }, 10)?.id).toBe('lab');
    const svg = drawingSvg(doc)!;
    expect(svg).toContain('>ABCDEFGHIJ</text>');
    expect(svg).toContain('>구역</text>');
    expect(writeDxf(doc)).toContain('ABCDEFGHIJ');
    (doc.entities.get('lab') as LabelEntity).visible = false;
    doc.changed();
    expect(drawingSvg(doc)!).not.toContain('ABCDEFGHIJ');
  });
});

describe('column generator and H-beam', () => {
  it('reuses a column type of the same size and adds a new one otherwise', () => {
    const doc = new DocumentModel();
    let n = 0;
    const id = () => `new-${++n}`;
    expect(columnTypeFor(doc, { section: 'rect', width: 600, depth: 600 }, id)).toMatchObject({ isNew: false, type: { id: 'st-column' } });
    expect(columnTypeFor(doc, { section: 'round', width: 600, depth: 0 }, id)).toMatchObject({ isNew: false, type: { id: 'st-column-round' } });
    expect(columnTypeFor(doc, { section: 'hbeam', width: 300, depth: 300, webThickness: 10, flangeThickness: 15, material: 'S' }, id)).toMatchObject({ isNew: false, type: { id: 'st-column-h' } });
    const big = columnTypeFor(doc, { section: 'hbeam', width: 400, depth: 400, webThickness: 13, flangeThickness: 21 }, id);
    expect(big).toMatchObject({ isNew: true, type: { name: 'H형강 기둥 H-400×400×13×21', width: 400, depth: 400 } });
  });

  it('draws an H-beam as an H and describes its section', () => {
    const doc = new DocumentModel();
    const history = new History(doc);
    history.execute(new AddItems([{ id: 'c', x: 0, y: 0 }], [{ id: 'h', kind: 'equipment', type: 'st-column-h', at: 'c', rotation: 0, tag: 'C-1', layer: 'layer-0' }]));
    const e = doc.entities.get('h') as never;
    const sym = planSymbol(doc, e);
    expect(sym.polygon).toHaveLength(12);
    // Area: two flanges 15 × 300 and the web 10 × 270.
    expect(Math.abs(polygonArea(sym.polygon))).toBeCloseTo(2 * 15 * 300 + 10 * 270, 6);
    expect(presetInfo(doc, e)[0].value).toMatch(/^H-300×300×10×15/);
  });

  it('gives older files the H-beam preset', () => {
    const doc = new DocumentModel();
    const data = doc.toData();
    const v4 = { ...data, version: 4, equipmentTypes: data.equipmentTypes.filter((t) => t.id !== 'st-column-h') };
    expect(deserialize(JSON.stringify(v4)).equipmentTypes.some((t) => t.id === 'st-column-h')).toBe(true);
  });
});

describe('API', () => {
  it('adds labels, edits a shape label, rounds corners and places columns', () => {
    const doc = new DocumentModel();
    const history = new History(doc);
    const api = new EditorApi(doc, history);
    const { shape } = dispatch(api, 'addRectangle', { x: 0, y: 0, width: 4000, height: 3000, name: '창고' }) as { shape: string };
    const lab = dispatch(api, 'addLabel', { x: 0, y: -1000, text: '구역: A\n담당: 1팀', anchor: 'top' }) as { id: string };
    expect(dispatch(api, 'getEntity', { id: lab.id })).toMatchObject({ text: ['구역: A', '담당: 1팀'] });
    dispatch(api, 'updateEntity', { id: shape, label: { anchor: 'bottom', items: [{ title: '용도', value: '보관' }] } });
    dispatch(api, 'updateEntity', { id: shape, label: { opacity: 0.5 } });
    expect((doc.entities.get(shape) as ShapeEntity).label).toEqual({ anchor: 'bottom', items: [{ title: '용도', value: '보관' }], opacity: 0.5 });
    expect(() => dispatch(api, 'updateEntity', { id: shape, label: { anchor: 'middle' } })).toThrow(/배치 기준/);
    const corner = (doc.entities.get(shape) as ShapeEntity).points[2];
    dispatch(api, 'editCorner', { point: corner, mode: 'chamfer', size: 300 });
    expect((doc.entities.get(shape) as ShapeEntity).points).toHaveLength(5);
    const col = dispatch(api, 'placeColumn', { section: 'hbeam', width: 400, depth: 400, webThickness: 13, flangeThickness: 21, x: 5000, y: 0 }) as { newType: boolean; typeName: string };
    expect(col).toMatchObject({ newType: true, typeName: 'H형강 기둥 H-400×400×13×21' });
    history.undo();
    expect(doc.equipmentTypes.has('st-column-h')).toBe(true);
    expect([...doc.equipmentTypes.values()].some((t) => t.name === 'H형강 기둥 H-400×400×13×21')).toBe(false);
  });
});
