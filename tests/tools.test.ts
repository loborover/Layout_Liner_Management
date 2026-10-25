import { describe, expect, it } from 'vitest';
import { History } from '../src/model/commands';
import { DocumentModel, midpointId } from '../src/model/document';
import { Selection } from '../src/model/selection';
import { SpatialIndex } from '../src/model/spatial';
import { SnapEngine } from '../src/snap/snap';
import { DimensionTool, LineTool, PointTool } from '../src/tools/draw';
import { SelectTool } from '../src/tools/select';
import type { Tool, ToolContext, ToolPointer } from '../src/tools/tool';
import { ConstraintService } from '../src/constraints/service';
import { Viewport } from '../src/view/viewport';
import { deserialize, serialize } from '../src/io/serialize';

function setup() {
  const doc = new DocumentModel();
  const history = new History(doc);
  const index = new SpatialIndex(doc);
  const selection = new Selection();
  const view = new Viewport();
  view.resize(800, 600);
  view.scale = 1;
  const ctx: ToolContext = {
    doc,
    history,
    index,
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
  };
  const engine = new SnapEngine(doc, index);
  // Mirrors App.pointer(): object snaps only, 10 mm reach.
  const at = (tool: Tool, x: number, y: number, ctrl = false): ToolPointer => {
    const raw = { x, y };
    const snap = engine.snap(raw, 10, 0, { object: true, polar: false, grid: false, polarStep: 15 }, { ...(tool.snapQuery?.() ?? {}), pointsOnly: ctrl });
    return { raw, world: snap?.point ?? raw, snap, screen: view.toScreen(raw), button: 0, shift: false, ctrl };
  };
  const click = (tool: Tool, x: number, y: number, ctrl = false) => {
    const p = at(tool, x, y, ctrl);
    tool.down(p);
    tool.up(p);
  };
  return { doc, history, selection, ctx, at, click };
}

describe('line tool', () => {
  it('closes a room outline on its first point with shared corners', () => {
    const { doc, ctx, click, history } = setup();
    const line = new LineTool(ctx);
    click(line, 0, 0);
    click(line, 4000, 0);
    click(line, 4000, 3000);
    click(line, 0, 3000);
    click(line, 3, -2); // snaps to the first point and closes
    const kinds = [...doc.entities.values()].map((e) => e.kind);
    expect(kinds.filter((k) => k === 'line')).toHaveLength(4);
    // The closed loop becomes a shape (face) over the four lines, in the same undo step.
    const shape = [...doc.entities.values()].find((e) => e.kind === 'shape');
    expect(shape?.kind === 'shape' && shape.edges).toHaveLength(4);
    expect(shape?.kind === 'shape' && doc.shapeArea(shape)).toBeCloseTo(12e6);
    expect(doc.points.size).toBe(4);
    history.undo();
    expect([...doc.entities.values()].some((e) => e.kind === 'shape')).toBe(false);
  });

  it('connects a new line to an existing endpoint instead of duplicating it', () => {
    const { doc, ctx, click } = setup();
    const line = new LineTool(ctx);
    click(line, 0, 0);
    click(line, 1000, 0);
    line.cancel();
    click(line, 1004, 3);
    click(line, 1000, 1000);
    expect(doc.points.size).toBe(3);
  });
});

describe('Ctrl snap closes loops into shapes', () => {
  it('fills the loop a new segment closes through existing lines', () => {
    const { doc, ctx, click } = setup();
    const line = new LineTool(ctx);
    // Three sides of a room, drawn as an open chain (no shape yet).
    click(line, 0, 0);
    click(line, 1000, 0);
    click(line, 1000, 800);
    click(line, 0, 800);
    line.cancel();
    expect([...doc.entities.values()].filter((e) => e.kind === 'shape')).toHaveLength(0);
    // Ctrl: start on one open end, finish on the other.
    click(line, 3, 797, true);
    click(line, 4, 3, true);
    const shapes = [...doc.entities.values()].filter((e) => e.kind === 'shape');
    expect(shapes).toHaveLength(1);
    expect(doc.shapeArea(shapes[0] as never)).toBeCloseTo(800000);
    expect(doc.points.size).toBe(4); // snapped onto the existing corners, nothing duplicated
  });

  it('snaps only to points while Ctrl is held', () => {
    const { at, ctx } = setup();
    const line = new LineTool(ctx);
    click0(line, at);
    // Grid/other snaps would move the cursor; with Ctrl and nothing near, the raw position is kept.
    expect(at(line, 503, 207, true).world).toEqual({ x: 503, y: 207 });
  });
});

function click0(tool: Tool, at: (t: Tool, x: number, y: number, ctrl?: boolean) => ToolPointer) {
  const p = at(tool, 0, 0);
  tool.down(p);
  tool.up(p);
}

describe('point selection', () => {
  it('selects a vertex, drags it with its lines, and deletes what is built on it', () => {
    const { doc, history, selection, ctx, at, click } = setup();
    const line = new LineTool(ctx);
    click(line, 0, 0);
    click(line, 1000, 0);
    click(line, 1000, 800);
    line.cancel();
    const select = new SelectTool(ctx);
    click(select, 1001, 1);
    const corner = selection.values()[0];
    expect(doc.points.has(corner)).toBe(true);
    // Drag the corner: both lines through it follow.
    select.down(at(select, 1000, 0));
    select.move(at(select, 1200, 100));
    select.up(at(select, 1200, 100));
    expect(doc.point(corner)).toMatchObject({ x: 1200, y: 100 });
    history.undo();
    expect(doc.point(corner)).toMatchObject({ x: 1000, y: 0 });
    // Delete the vertex: the two lines on it go with it.
    selection.set([corner]);
    select.key({ key: 'Delete' } as KeyboardEvent);
    expect([...doc.entities.values()].filter((e) => e.kind === 'line')).toHaveLength(0);
  });
});

describe('points as objects', () => {
  it("selects a line's midpoint as a point and moves the whole line with it", () => {
    const { doc, history, selection, ctx, at, click } = setup();
    const line = new LineTool(ctx);
    click(line, 0, 0);
    click(line, 1000, 0);
    line.cancel();
    const l = [...doc.entities.values()].find((e) => e.kind === 'line')!;
    const select = new SelectTool(ctx);
    click(select, 502, 1);
    expect(selection.values()).toEqual([midpointId(l.id)]);
    expect(doc.vertex(midpointId(l.id))).toMatchObject({ x: 500, y: 0 });
    select.down(at(select, 500, 0));
    select.move(at(select, 500, 300));
    select.up(at(select, 500, 300));
    if (l.kind !== 'line') throw new Error();
    expect(doc.point(l.p1)).toMatchObject({ x: 0, y: 300 });
    expect(doc.point(l.p2)).toMatchObject({ x: 1000, y: 300 });
    history.undo();
    expect(doc.point(l.p1)).toMatchObject({ x: 0, y: 0 });
    // Deleting the midpoint deletes its line.
    selection.set([midpointId(l.id)]);
    select.key({ key: 'Delete' } as KeyboardEvent);
    expect(doc.entities.size).toBe(0);
  });

  it('places point objects that lines can start from and that survive save/load', () => {
    const { doc, selection, ctx, click } = setup();
    const tool = new PointTool(ctx);
    click(tool, 100, 100);
    const pe = [...doc.entities.values()].find((e) => e.kind === 'point')!;
    expect(pe.kind === 'point' && doc.point(pe.at)).toMatchObject({ x: 100, y: 100 });
    click(tool, 101, 99); // already a point object here: refused
    expect(doc.entities.size).toBe(1);
    // A line drawn from it (Ctrl: points only) shares its point.
    const line = new LineTool(ctx);
    click(line, 104, 103, true);
    click(line, 900, 100);
    line.cancel();
    const l = [...doc.entities.values()].find((e) => e.kind === 'line')!;
    expect(l.kind === 'line' && pe.kind === 'point' && l.p1 === pe.at).toBe(true);
    // Clicking a lone point object selects the object itself.
    const other = new PointTool(ctx);
    click(other, 2000, 2000);
    const lone = [...doc.entities.values()].filter((e) => e.kind === 'point')[1];
    const select = new SelectTool(ctx);
    click(select, 2001, 2001);
    expect(selection.values()).toEqual([lone.id]);
    const copy = new DocumentModel();
    copy.load(deserialize(serialize(doc.toData())));
    expect([...copy.entities.values()].filter((e) => e.kind === 'point')).toHaveLength(2);
  });
});

describe('dimension', () => {
  it('follows the geometry it is attached to and keeps its value through save/load', () => {
    const { doc, ctx, history, selection, click, at } = setup();
    const line = new LineTool(ctx);
    click(line, 0, 0);
    click(line, 2000, 0);
    line.cancel();
    const dim = new DimensionTool(ctx);
    click(dim, 2, 1);
    click(dim, 1998, -2);
    click(dim, 1000, 500);
    const d = [...doc.entities.values()].find((e) => e.kind === 'dimension')!;
    expect(d.kind === 'dimension' && d.offset).toBeCloseTo(500);
    expect(doc.points.size).toBe(2);

    // Drag the line's right end; the dimension measures the new length.
    const select = new SelectTool(ctx);
    const lineId = [...doc.entities.values()].find((e) => e.kind === 'line')!.id;
    selection.set([lineId]);
    select.down(at(select, 1000, 0));
    select.move(at(select, 1500, 0));
    select.up(at(select, 1500, 0));
    const restored = new DocumentModel();
    restored.load(deserialize(serialize(doc.toData())));
    const rd = [...restored.entities.values()].find((e) => e.kind === 'dimension')!;
    if (rd.kind !== 'dimension') throw new Error('expected a dimension');
    expect(restored.point(rd.p2).x - restored.point(rd.p1).x).toBe(2000);
    expect(restored.point(rd.p1).x).toBe(500);
    history.undo();
    expect(doc.point(rd.p1).x).toBe(0);
  });

  it('moves only the dimension line when an attached dimension is dragged', () => {
    const { doc, ctx, history, selection, click, at } = setup();
    const line = new LineTool(ctx);
    click(line, 0, 0);
    click(line, 2000, 0);
    line.cancel();
    const dim = new DimensionTool(ctx);
    click(dim, 0, 0);
    click(dim, 2000, 0);
    click(dim, 1000, 300);
    const d = [...doc.entities.values()].find((e) => e.kind === 'dimension')!;
    selection.set([d.id]);
    const select = new SelectTool(ctx);
    select.down(at(select, 1000, 300));
    select.move(at(select, 1000, 800));
    select.up(at(select, 1000, 800));
    expect(d.kind === 'dimension' && d.offset).toBeCloseTo(800);
    expect(doc.point(d.kind === 'dimension' ? d.p1 : '').y).toBe(0);
    history.undo();
    expect(d.kind === 'dimension' && d.offset).toBeCloseTo(300);
  });
});
