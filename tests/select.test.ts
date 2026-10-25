import { describe, expect, it } from 'vitest';
import { AddItems, History } from '../src/model/commands';
import { DocumentModel } from '../src/model/document';
import { Selection } from '../src/model/selection';
import { SpatialIndex } from '../src/model/spatial';
import { SelectTool } from '../src/tools/select';
import type { ToolPointer } from '../src/tools/tool';
import { ConstraintService } from '../src/constraints/service';
import { Viewport } from '../src/view/viewport';

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
      [{ id: 'l', kind: 'line', p1: 'a', p2: 'b', layer: 'layer-0' }],
    ),
  );
  const at = (x: number, y: number): ToolPointer => {
    const w = { x, y };
    return { world: w, raw: w, snap: null, screen: view.toScreen(w), button: 0, shift: false };
  };
  return { doc, history, tool, at };
}

describe('select tool', () => {
  it('records a drag as one undoable move', () => {
    const { doc, history, tool, at } = setup();
    tool.down(at(50, 0));
    tool.move(at(60, 20));
    tool.up(at(60, 20));
    expect(doc.point('a')).toMatchObject({ x: 10, y: 20 });
    history.undo();
    expect(doc.point('a')).toMatchObject({ x: 0, y: 0 });
  });

  it('does not record a drag interrupted by undo', () => {
    const { doc, history, tool, at } = setup();
    tool.down(at(50, 0));
    tool.move(at(60, 20));
    tool.interrupt();
    history.undo(); // removes the line and its points
    tool.up(at(60, 20));
    expect(doc.entities.size).toBe(0);
    expect(history.canUndo).toBe(false);
    expect(() => history.redo()).not.toThrow();
    expect(doc.point('a')).toMatchObject({ x: 0, y: 0 });
  });
});
