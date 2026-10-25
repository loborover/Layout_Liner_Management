import { describe, expect, it } from 'vitest';
import { DxfError, parseDxf } from '../src/io/dxf';
import { writeDxf } from '../src/io/dxfExport';
import { importDxf } from '../src/io/dxfImport';
import { deserialize, serialize } from '../src/io/serialize';
import { drawingSvg } from '../src/io/svg';
import { AddItems, History, SetUnderlay } from '../src/model/commands';
import { DocumentModel } from '../src/model/document';

/** Builds DXF text from [code, value] pairs. */
const dxf = (...pairs: (string | number)[]) => {
  const lines: string[] = [];
  for (let i = 0; i < pairs.length; i += 2) lines.push(String(pairs[i]), String(pairs[i + 1]));
  return lines.join('\n');
};
const section = (name: string, ...pairs: (string | number)[]) => [0, 'SECTION', 2, name, ...pairs, 0, 'ENDSEC'];

const sample = dxf(
  ...section('HEADER', 9, '$INSUNITS', 70, 6), // metres
  ...section('TABLES', 0, 'TABLE', 2, 'LAYER', 0, 'LAYER', 2, 'WALL', 62, 1, 70, 0, 0, 'LAYER', 2, 'OFF', 62, -3, 70, 4, 0, 'ENDTAB'),
  ...section('BLOCKS', 0, 'BLOCK', 2, 'COL', 10, 0, 20, 0, 0, 'LINE', 8, '0', 10, 0, 20, 0, 11, 1, 21, 0, 0, 'ENDBLK'),
  ...section(
    'ENTITIES',
    // closed square room, 4 x 3 m
    0, 'LWPOLYLINE', 8, 'WALL', 90, 4, 70, 1, 10, 0, 20, 0, 10, 4, 20, 0, 10, 4, 20, 3, 10, 0, 20, 3,
    0, 'CIRCLE', 8, 'OFF', 10, 2, 20, 1.5, 40, 0.5,
    // quarter arc, radius 1 about (10, 0), from 0° to 90°
    0, 'ARC', 8, 'WALL', 10, 10, 20, 0, 40, 1, 50, 0, 51, 90,
    // block inserted at (20, 0), rotated 90°, scaled 2
    0, 'INSERT', 8, 'WALL', 2, 'COL', 10, 20, 20, 0, 41, 2, 42, 2, 50, 90,
    0, 'TEXT', 8, 'WALL', 1, '\\U+D68C\\U+C758\\U+C2E4',
    0, 'HATCH', 8, 'WALL',
  ),
  0, 'EOF',
);

describe('DXF reading', () => {
  it('reads geometry, layers and units in millimetres', () => {
    const d = parseDxf(sample);
    expect(d.unitScale).toBe(1000);
    expect(d.unitsKnown).toBe(true);
    expect(d.circles).toEqual([{ c: { x: 2000, y: 1500 }, r: 500, layer: 'OFF' }]);
    const off = d.layers.find((l) => l.name === 'OFF')!;
    expect(off).toMatchObject({ visible: false, locked: true, color: '#16a34a' });
    expect(d.skipped).toEqual(new Map([['TEXT', 1], ['HATCH', 1]]));
    const room = d.segments.slice(0, 4);
    expect(room.map((s) => [s.a.x, s.a.y, s.b.x, s.b.y])).toEqual([
      [0, 0, 4000, 0],
      [4000, 0, 4000, 3000],
      [4000, 3000, 0, 3000],
      [0, 3000, 0, 0],
    ]);
  });

  it('turns arcs into short segments on the arc', () => {
    const arc = parseDxf(sample).segments.filter((s) => s.a.x >= 9000 && s.a.x <= 11001 && s.layer === 'WALL' && s.a.y >= 0 && s.a.x > 8000 && s.b.x < 12000);
    expect(arc.length).toBe(9); // 90° in 10° steps
    for (const s of arc) expect(Math.hypot(s.b.x - 10000, s.b.y)).toBeCloseTo(1000, 6);
    expect(arc[0].a).toMatchObject({ x: 11000, y: 0 });
    expect(arc.at(-1)!.b.x).toBeCloseTo(10000);
    expect(arc.at(-1)!.b.y).toBeCloseTo(1000);
  });

  it('expands block references with their rotation and scale, on the insert layer', () => {
    const col = parseDxf(sample).segments.find((s) => s.a.x === 20000)!;
    expect(col.layer).toBe('WALL');
    expect(col.b.x).toBeCloseTo(20000);
    expect(col.b.y).toBeCloseTo(2000);
  });

  it('follows polyline bulges round the correct side', () => {
    // Semicircle from (0,0) to (2,0) counter-clockwise: bulge 1, passes below the chord.
    const d = parseDxf(dxf(...section('ENTITIES', 0, 'LWPOLYLINE', 8, 'A', 90, 2, 70, 0, 10, 0, 20, 0, 42, 1, 10, 2, 20, 0), 0, 'EOF'));
    expect(d.unitsKnown).toBe(false);
    const lowest = Math.min(...d.segments.map((s) => s.a.y));
    expect(lowest).toBeCloseTo(-1, 6);
    expect(d.segments.at(-1)!.b).toEqual({ x: 2, y: 0 });
  });

  it('rejects files that are not ASCII DXF', () => {
    expect(() => parseDxf('hello\nworld')).toThrow(DxfError);
    expect(() => parseDxf(dxf(...section('HEADER'), 0, 'EOF'))).toThrow('ENTITIES');
  });
});

describe('DXF import into the drawing', () => {
  it('shares coincident endpoints, adds layers and undoes in one step', () => {
    const doc = new DocumentModel();
    const history = new History(doc);
    const r = importDxf(doc, parseDxf(sample))!;
    history.execute(r.command);
    expect(r.circles).toBe(1);
    const walls = [...doc.entities.values()].filter((e) => e.kind === 'line');
    expect(walls.length).toBe(r.lines);
    // The room's four corners are shared: 4 lines, 4 points.
    const corner = [...doc.points.values()].find((p) => p.x === 0 && p.y === 0)!;
    expect(walls.filter((e) => e.kind === 'line' && (e.p1 === corner.id || e.p2 === corner.id))).toHaveLength(2);
    expect([...doc.layers.values()].map((l) => l.name)).toEqual(['0', 'WALL', 'OFF']);
    history.undo();
    expect(doc.entities.size).toBe(0);
    expect(doc.layers.size).toBe(1);
  });

  it('applies a unit the user gives for unitless files', () => {
    const doc = new DocumentModel();
    const d = parseDxf(dxf(...section('ENTITIES', 0, 'LINE', 8, '0', 10, 0, 20, 0, 11, 2, 21, 0), 0, 'EOF'));
    new History(doc).execute(importDxf(doc, d, 1000)!.command);
    expect(Math.max(...[...doc.points.values()].map((p) => p.x))).toBe(2000);
  });
});

function plan() {
  const doc = new DocumentModel();
  doc.layers.set('l2', { id: 'l2', name: '설비', color: '#16a34a', visible: true, locked: false });
  new History(doc).execute(
    new AddItems(
      [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 5000, y: 0 },
        { id: 'c', x: 2500, y: 2000 },
      ],
      [
        { id: 'w', kind: 'line', p1: 'a', p2: 'b', layer: 'layer-0' },
        { id: 'd', kind: 'dimension', p1: 'a', p2: 'b', offset: -500, layer: 'layer-0' },
        { id: 'm', kind: 'equipment', type: 'eq-machine', at: 'c', rotation: 0, tag: 'MC-1', layer: 'l2' },
        { id: 'k', kind: 'circle', center: 'c', radius: 300, layer: 'l2' },
      ],
    ),
  );
  return doc;
}

describe('exports', () => {
  it('writes DXF R12 that reads back with the same geometry and layer names', () => {
    const doc = plan();
    const text = writeDxf(doc);
    expect(text).toContain('AC1009');
    const back = parseDxf(text);
    expect(back.unitScale).toBe(1);
    expect(back.layers.map((l) => l.name).sort()).toEqual(['0', '설비']);
    expect(back.circles).toEqual([{ c: { x: 2500, y: 2000 }, r: 300, layer: '설비' }]);
    // wall + 3 dimension lines on layer 0; machine outline (4 edges) on 설비
    expect(back.segments.filter((s) => s.layer === '0')).toHaveLength(4);
    expect(back.segments.filter((s) => s.layer === '설비')).toHaveLength(4);
    expect(back.skipped.get('TEXT')).toBe(2);
  });

  it('writes an SVG in millimetres with hidden layers left out', () => {
    const doc = plan();
    doc.layers.get('l2')!.visible = false;
    const svg = drawingSvg(doc)!;
    expect(svg).toMatch(/viewBox="[-\d.]+ [-\d.]+ [\d.]+ [\d.]+" width="[\d.]+mm"/);
    expect(svg).toContain('<line x1="0" y1="0" x2="5000" y2="0"/>');
    expect(svg).not.toContain('<circle');
    expect(svg).toContain('>5000</text>');
    expect(drawingSvg(new DocumentModel())).toBeNull();
  });
});

describe('underlay', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';

  it('round-trips through the file and undo', () => {
    const doc = new DocumentModel();
    const history = new History(doc);
    const u = { src: png, x: -100, y: -50, width: 20000, height: 10000, opacity: 0.4, visible: true };
    history.execute(new SetUnderlay('밑그림', null, u));
    expect(deserialize(serialize(doc.toData())).underlay).toEqual(u);
    expect(doc.extents()).toEqual({ minX: -100, minY: -50, maxX: 19900, maxY: 9950 });
    history.undo();
    expect(doc.underlay).toBeNull();
    expect(doc.toData().underlay).toBeUndefined();
  });

  it('only accepts embedded images', () => {
    const data = { ...new DocumentModel().toData(), underlay: { src: 'https://example.com/plan.png', x: 0, y: 0, width: 1, height: 1, opacity: 1, visible: true } };
    expect(() => deserialize(JSON.stringify(data))).toThrow('밑그림');
  });
});
