import { describe, expect, it } from 'vitest';
import { History } from '../src/model/commands';
import { DocumentModel } from '../src/model/document';
import { Selection } from '../src/model/selection';
import { SpatialIndex } from '../src/model/spatial';
import { SnapEngine } from '../src/snap/snap';
import { DimensionTool, LineTool } from '../src/tools/draw';
import { SelectTool } from '../src/tools/select';
import type { Tool, ToolContext, ToolPointer } from '../src/tools/tool';
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
    pickTolerance: () => 5,
    setHover: () => {},
    setHint: () => {},
    requestRender: () => {},
  };
  const engine = new SnapEngine(doc, index);
  // Mirrors App.pointer(): object snaps only, 10 mm reach.
  const at = (tool: Tool, x: number, y: number): ToolPointer => {
    const raw = { x, y };
    const snap = engine.snap(raw, 10, 0, { object: true, polar: false, grid: false, polarStep: 15 }, tool.snapQuery?.() ?? {});
    return { raw, world: snap?.point ?? raw, snap, screen: view.toScreen(raw), button: 0, shift: false };
  };
  const click = (tool: Tool, x: number, y: number) => {
    const p = at(tool, x, y);
    tool.down(p);
    tool.up(p);
  };
  return { doc, history, selection, ctx, at, click };
}

describe('line tool', () => {
  it('closes a room outline on its first point with shared corners', () => {
    const { doc, ctx, click } = setup();
    const line = new LineTool(ctx);
    click(line, 0, 0);
    click(line, 4000, 0);
    click(line, 4000, 3000);
    click(line, 0, 3000);
    click(line, 3, -2); // snaps to the first point and closes
    expect(doc.entities.size).toBe(4);
    expect(doc.points.size).toBe(4);
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
