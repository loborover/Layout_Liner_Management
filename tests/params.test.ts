import { GcsWrapper, init_planegcs_module } from '@salusoft89/planegcs';
import { beforeAll, describe, expect, it } from 'vitest';
import { EditorApi } from '../src/api/editorApi';
import { measureDimension, smartDimension } from '../src/constraints/dimensions';
import { ConstraintService } from '../src/constraints/service';
import { ConstraintSolver } from '../src/constraints/solver';
import { deserialize, serialize } from '../src/io/serialize';
import { AddConstraints, AddItems, History } from '../src/model/commands';
import { DocumentModel } from '../src/model/document';
import { rotateItems } from '../src/model/edit';
import {
  ExpressionError,
  evaluate,
  evaluateParameters,
  isPlainNumber,
  nameProblem,
  parseExpression,
  references,
  renameInExpression,
} from '../src/model/params';
import { Selection } from '../src/model/selection';
import { SpatialIndex } from '../src/model/spatial';
import { DimensionTool, RectTool } from '../src/tools/draw';
import type { Tool, ToolContext, ToolPointer } from '../src/tools/tool';
import { Viewport } from '../src/view/viewport';

let solver: ConstraintSolver;
beforeAll(async () => {
  const mod = await init_planegcs_module();
  solver = new ConstraintSolver(new GcsWrapper(new mod.GcsSystem()));
});

describe('expressions', () => {
  it('computes arithmetic with precedence, parameters and functions', () => {
    expect(evaluate('1 + 2 * 3')).toBe(7);
    expect(evaluate('=(1 + 2) * 3')).toBe(9);
    expect(evaluate('-2^2')).toBe(-4);
    expect(evaluate('2^3^2')).toBe(512);
    expect(evaluate('10 % 4')).toBe(2);
    expect(evaluate('2e3 / 4')).toBe(500);
    expect(evaluate('max(폭, 깊이) + 1', { params: (n) => ({ 폭: 3000, 깊이: 5000 })[n] })).toBe(5001);
    expect(evaluate('round(cos(60), 3)')).toBe(0.5);
    expect(evaluate('DB("설비", "M-01", "폭") * 2', { functions: { DB: (_d, _k, f) => (f === '폭' ? '1200' : undefined) } })).toBe(2400);
  });

  it('explains what is wrong', () => {
    expect(() => parseExpression('1 +')).toThrow(ExpressionError);
    expect(() => parseExpression('(1')).toThrow(/'\)'/);
    expect(() => evaluate('폭')).toThrow(/알 수 없는 파라미터/);
    expect(() => evaluate('nope(1)')).toThrow(/알 수 없는 함수/);
    expect(() => evaluate('1 / 0')).toThrow(/유한한/);
    try {
      evaluate('DB("a", "b", "c")', { functions: { DB: () => undefined } });
    } catch (err) {
      expect((err as ExpressionError).code).toBe('missing');
    }
  });

  it('lists what an expression uses and renames whole names only', () => {
    expect(references(parseExpression('폭 * 2 + DB("x", 폭2, 3)'))).toEqual({ params: ['폭', '폭2'], calls: [{ name: 'DB', args: ['x', null, 3] }] });
    expect(renameInExpression('폭 * 2 + 폭2 + max(폭, 1) + "폭"', '폭', '너비')).toBe('너비 * 2 + 폭2 + max(너비, 1) + "폭"');
    expect(renameInExpression('max(1, 2)', 'max', 'x')).toBe('max(1, 2)');
    expect(isPlainNumber(' 12.5 ')).toBe(true);
    expect(isPlainNumber('12 + 1')).toBe(false);
    expect(nameProblem('1폭', [])).not.toBeNull();
    expect(nameProblem('max', [])).not.toBeNull();
    expect(nameProblem('폭', [{ id: 'a', name: '폭', expression: '1' }])).not.toBeNull();
    expect(nameProblem('폭', [{ id: 'a', name: '폭', expression: '1' }], 'a')).toBeNull();
  });

  it('evaluates parameters in dependency order and keeps the last value on failure', () => {
    const { values, errors } = evaluateParameters([
      { id: '1', name: '면적', expression: '폭 * 깊이' },
      { id: '2', name: '폭', expression: '3000' },
      { id: '3', name: '깊이', expression: '폭 / 2' },
      { id: '4', name: '외부', expression: 'DB("a", "b", "c")', value: 77 },
      { id: '5', name: '순환a', expression: '순환b' },
      { id: '6', name: '순환b', expression: '순환a' },
    ]);
    expect(values.get('면적')).toBe(4_500_000);
    expect(values.get('외부')).toBe(77);
    expect(errors.get('4')?.code).toBe('unknown');
    expect(errors.get('5')?.code).toBe('cycle');
    expect(values.has('순환a')).toBe(false);
  });

  it('keeps cached values for a cycle and everything that uses it, whatever the order', () => {
    const { values, errors } = evaluateParameters([
      { id: 'u', name: '사용', expression: 'a + 1', value: 11 },
      { id: 'a', name: 'a', expression: 'b * 2', value: 10 },
      { id: 'b', name: 'b', expression: 'a', value: 5 },
    ]);
    expect(values.get('a')).toBe(10);
    expect(values.get('b')).toBe(5);
    expect(values.get('사용')).toBe(11);
    expect([...errors.values()].map((e) => e.code)).toEqual(['cycle', 'cycle', 'cycle']);
  });
});

/** A 4000 × 3000 rectangle drawn with the rectangle tool, so it carries its right angles. */
function room() {
  const doc = new DocumentModel();
  const history = new History(doc);
  const view = new Viewport();
  view.resize(800, 600);
  view.scale = 1;
  const constraints = new ConstraintService(doc, history, () => Promise.resolve(solver));
  const ctx: ToolContext = {
    doc,
    history,
    index: new SpatialIndex(doc),
    selection: new Selection(),
    view,
    unit: () => 'mm',
    layer: () => 'layer-0',
    pickTolerance: () => 5,
    setHover: () => {},
    setHint: () => {},
    requestRender: () => {},
    constraints,
    notify: () => {},
    ask: () => null,
  };
  const pointer = (x: number, y: number, pointId?: string): ToolPointer => ({
    raw: { x, y },
    world: { x, y },
    snap: pointId ? { point: { x, y }, kind: 'endpoint', pointId } : null,
    screen: { x, y },
    button: 0,
    shift: false,
    ctrl: false,
  });
  const click = (tool: Tool, x: number, y: number, pointId?: string) => {
    tool.down(pointer(x, y, pointId));
    tool.up(pointer(x, y, pointId));
  };
  click(new RectTool(ctx), 0, 0);
  click(new RectTool(ctx), 0, 0);
  const rect = new RectTool(ctx);
  click(rect, 0, 0);
  click(rect, 4000, 3000);
  const lines = [...doc.entities.values()].filter((e) => e.kind === 'line');
  return { doc, history, constraints, ctx, click, lines: lines.map((l) => l.id) };
}

describe('rectangle tool', () => {
  it('keeps its corners square, and can still turn as a whole', async () => {
    const { doc, history, constraints, lines } = room();
    expect([...doc.constraints.values()].map((c) => c.kind)).toEqual(['perpendicular', 'perpendicular', 'perpendicular']);
    // Dragging one corner keeps every corner at 90°.
    await constraints.ensure();
    const corner = (doc.entities.get(lines[1]) as { p2: string }).p2;
    const drag = constraints.beginDrag([corner])!;
    expect(drag.update({ x: 700, y: 400 })).toBe(true);
    history.record(drag.finish());
    const dir = (id: string) => {
      const l = doc.entities.get(id) as { p1: string; p2: string };
      const a = doc.point(l.p1);
      const b = doc.point(l.p2);
      return { x: b.x - a.x, y: b.y - a.y };
    };
    for (let i = 0; i < 4; i++) {
      const u = dir(lines[i]);
      const v = dir(lines[(i + 1) % 4]);
      expect(Math.abs(u.x * v.x + u.y * v.y) / Math.hypot(u.x, u.y) / Math.hypot(v.x, v.y)).toBeLessThan(1e-6);
    }
    // Right angles turn with the shape; a horizontal constraint would not.
    expect(typeof rotateItems(doc, lines, 30)).toBe('object');
    history.execute(new AddConstraints([{ id: 'h', kind: 'horizontal', refs: [lines[0]] }]));
    expect(typeof rotateItems(doc, lines, 30)).toBe('string');
  });
});

describe('dimension line tool', () => {
  it('drives the distance when placed on existing points, and only measures on empty space', async () => {
    const { doc, constraints, ctx, click, lines } = room();
    const bottom = doc.entities.get(lines[0]) as { p1: string; p2: string };
    const tool = new DimensionTool(ctx);
    click(tool, 0, 0, bottom.p1);
    click(tool, 4000, 0, bottom.p2);
    click(tool, 2000, -500);
    await constraints.ensure();
    await new Promise((r) => setTimeout(r, 0));
    const placed = [...doc.entities.values()].find((e) => e.kind === 'dimension')!;
    expect(placed).toMatchObject({ value: 4000 });
    click(tool, 9000, 0);
    click(tool, 9500, 0);
    click(tool, 9200, 300);
    await new Promise((r) => setTimeout(r, 0));
    const loose = [...doc.entities.values()].filter((e) => e.kind === 'dimension')[1];
    expect(loose).not.toHaveProperty('value');
  });
});

describe('smart dimension', () => {
  it('turns a line into its length, two crossing lines into an angle and a circle into its radius', async () => {
    const { doc, history, constraints, lines } = room();
    expect(smartDimension(doc, [lines[0]])).toMatchObject({ ok: true, kind: 'distance', refs: [lines[0]], value: 4000 });
    expect(smartDimension(doc, [lines[0], lines[1]])).toMatchObject({ ok: true, kind: 'angle' });
    expect(smartDimension(doc, [lines[0], lines[2]])).toMatchObject({ ok: true, kind: 'distance', value: 3000 });
    history.execute(new AddItems([{ id: 'o', x: 0, y: 9000 }], [{ id: 'c', kind: 'circle', center: 'o', radius: 400, layer: 'layer-0' }]));
    expect(smartDimension(doc, ['c'])).toMatchObject({ ok: true, kind: 'radius', value: 400 });
    // A line's length is held and can be changed.
    expect(await constraints.addDimension('distance', [lines[0]], 5000)).toEqual({ ok: true });
    const length = [...doc.constraints.values()].find((c) => c.kind === 'distance')!;
    expect(measureDimension(doc, length)).toBeCloseTo(5000, 3);
  });
});

describe('parameters driving dimensions', () => {
  it('follows a parameter expression, re-solves when the parameter changes, and undoes in one step', async () => {
    const { doc, history, constraints, lines } = room();
    expect(await constraints.setParameters([{ id: 'w', name: '폭', expression: '6000' }])).toEqual({ ok: true });
    const input = constraints.resolveInput('폭 / 2');
    expect(input).toEqual({ ok: true, driving: { value: 3000, expression: '폭 / 2' } });
    if (!input.ok) return;
    expect(await constraints.addDimension('distance', [lines[0]], input.driving.value!, input.driving.expression)).toEqual({ ok: true });
    const length = [...doc.constraints.values()].find((c) => c.kind === 'distance')!;
    expect(measureDimension(doc, length)).toBeCloseTo(3000, 3);

    expect(await constraints.setParameters([{ id: 'w', name: '폭', expression: '9000' }])).toEqual({ ok: true });
    expect(doc.constraints.get(length.id)).toMatchObject({ value: 4500, expression: '폭 / 2' });
    expect(measureDimension(doc, length)).toBeCloseTo(4500, 3);
    expect(doc.parameters.get('w')).toMatchObject({ value: 9000 });

    history.undo();
    expect(doc.parameters.get('w')).toMatchObject({ expression: '6000' });
    expect(measureDimension(doc, length)).toBeCloseTo(3000, 3);
  });

  it('keeps the last value when an expression can no longer be computed, and renames everywhere', async () => {
    const { doc, constraints, lines } = room();
    constraints.functions = { DB: () => 2500 };
    await constraints.setParameters([{ id: 'd', name: '외부', expression: 'DB("a", "b", "c")' }]);
    await constraints.addDimension('distance', [lines[1]], 2500, '외부');
    constraints.functions = { DB: () => undefined }; // the gateway went down
    expect(await constraints.reapplyParameters()).toEqual({ ok: true });
    const k = [...doc.constraints.values()].find((c) => c.kind === 'distance')!;
    expect(k.value).toBe(2500);
    expect(constraints.parameterErrors().get('d')).toMatch(/값 없음/);

    expect(constraints.renameParameter('d', '기준')).toEqual({ ok: true });
    expect(doc.constraints.get(k.id)?.expression).toBe('기준');
    expect(doc.parameters.get('d')?.name).toBe('기준');
  });

  it('refuses a parameter value the geometry cannot take, leaving everything as it was', async () => {
    const { doc, constraints, lines } = room();
    await constraints.setParameters([{ id: 'w', name: '폭', expression: '4000' }]);
    await constraints.addDimension('distance', [lines[0]], 4000, '폭');
    const r = await constraints.setParameters([{ id: 'w', name: '폭', expression: '-5' }]);
    expect(r.ok).toBe(false);
    expect(doc.parameters.get('w')?.expression).toBe('4000');
  });

  it('saves parameters and expressions, and the API manages them', () => {
    const { doc, history, lines } = room();
    let changed = 0;
    const api = new EditorApi(doc, history, { onParametersChanged: () => changed++ });
    expect(api.setParameter({ name: '폭', expression: 12000 })).toMatchObject({ name: '폭', value: 12000 });
    expect(api.setParameter({ name: '절반', expression: '폭 / 2', note: '가운데' })).toMatchObject({ value: 6000 });
    expect(changed).toBe(2);
    expect(() => api.setParameter({ name: '1x', expression: '1' })).toThrow();
    expect(() => api.setParameter({ name: 'x', expression: '1 +' })).toThrow();
    doc.addConstraints([{ id: 'k', kind: 'distance', refs: [lines[0]], value: 6000, expression: '절반' }]);
    expect(api.listParameters().parameters).toEqual([
      expect.objectContaining({ name: '폭', value: 12000, usedBy: 0 }),
      expect.objectContaining({ name: '절반', value: 6000, usedBy: 1, note: '가운데' }),
    ]);
    const data = deserialize(serialize(doc.toData()));
    expect(data.version).toBe(8);
    expect(data.parameters).toEqual(doc.toData().parameters);
    expect(data.constraints.find((c) => c.id === 'k')).toMatchObject({ expression: '절반', refs: [lines[0]] });
    // A value no dimension can take is refused before anything changes.
    expect(() => api.setParameter({ name: '폭', expression: -100 })).toThrow(/쓸 수 없습니다/);
    expect(doc.parameters.size).toBe(2);
    // The editor can revert a value the geometry can't reach.
    const reverting = new EditorApi(doc, history, { onParametersChanged: (revert) => revert() });
    reverting.setParameter({ name: '폭', expression: 20000 });
    expect([...doc.parameters.values()].find((q) => q.name === '폭')).toMatchObject({ expression: '12000' });
    expect(api.removeParameter({ name: '절반' })).toEqual({ ok: true, usedBy: 1 });
    expect(doc.parameters.size).toBe(1);
  });
});
