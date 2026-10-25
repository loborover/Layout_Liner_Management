import { describe, expect, it } from 'vitest';
import { EditorApi } from '../src/api/editorApi';
import { dispatch } from '../src/api/rpc';
import { History } from '../src/model/commands';
import { DocumentModel } from '../src/model/document';
import { buildScene } from '../src/model/scene3d';
import { sceneBuffers } from '../src/view3d/mesh';

function setup() {
  const doc = new DocumentModel();
  const api = new EditorApi(doc, new History(doc));
  return { doc, api, call: (m: string, p: object = {}) => dispatch(api, m, p) as never };
}

describe('3D scene', () => {
  it('starts every height at 0, extrudes by explicit heights and stacks floors by elevation', () => {
    const { doc, call } = setup();
    call('addRectangle', { x: 0, y: 0, width: 4000, height: 3000 });
    const lines = [...doc.entities.values()].filter((e) => e.kind === 'line').map((e) => e.id);
    call('setStroke', { ids: lines, stroke: { width: 200, align: 'inside' } });
    // Without heights, walls lie flat on the floor.
    let walls = buildScene(doc).solids.filter((s) => lines.includes(s.id));
    expect(walls).toHaveLength(4);
    expect(walls.every((w) => w.top.every((t) => t === 0))).toBe(true);
    for (const id of lines) call('updateEntity', { id, height: 4000 });
    const second = call('addFloor', { name: '2층' }) as { floor: string };
    call('setActiveFloor', { floor: second.floor });
    const placed = call('placeEquipment', { type: 'eq-bench', x: 1000, y: 1000 }) as { id: string };
    expect(buildScene(doc).solids.find((s) => s.id === placed.id)!.top[0]).toBe(4000); // flat, on the second floor
    call('updateEntity', { id: placed.id, height: 1000 });
    const scene = buildScene(doc);
    walls = scene.solids.filter((s) => lines.includes(s.id));
    expect(walls.every((w) => w.top.every((t) => t === 4000) && w.bottom.every((b) => b === 0))).toBe(true);
    const bench = scene.solids.find((s) => s.id === placed.id)!;
    expect(bench.bottom[0]).toBe(4000);
    expect(bench.top[0]).toBe(5000);
    expect(scene.max[2]).toBe(5000);
    // Only the active floor.
    expect(buildScene(doc, { floors: 'active' }).solids.every((s) => doc.floorOf(doc.entities.get(s.id)!) === second.floor)).toBe(true);
  });

  it('uses point Z and explicit heights, builds steps for stairs and a wedge for ramps', () => {
    const { doc, call } = setup();
    call('addLines', { points: [[0, 0], [5000, 0]] });
    const line = [...doc.entities.values()].find((e) => e.kind === 'line')!;
    call('setPoint', { id: (line as { p1: string }).p1, z: 500 });
    let scene = buildScene(doc);
    expect(scene.lines[0].a[2]).toBe(500); // a plain line stays a 3D line
    call('updateEntity', { id: line.id, height: 1200 });
    scene = buildScene(doc);
    expect(scene.solids[0].top).toEqual([1700, 1200, 1200, 1700]);
    const stair = call('placeEquipment', { type: 'st-stair', x: 10000, y: 0 }) as { id: string };
    const rampAt = call('placeEquipment', { type: 'st-ramp', x: 20000, y: 0 }) as { id: string };
    call('updateEntity', { id: stair.id, height: 4000 });
    call('updateEntity', { id: rampAt.id, height: 1000 });
    scene = buildScene(doc);
    const steps = scene.solids.filter((s) => (doc.entities.get(s.id) as { type?: string })?.type === 'st-stair');
    expect(steps.length).toBe(15); // 4200 deep / 280 tread
    expect(Math.max(...steps.flatMap((s) => s.top))).toBe(4000);
    const ramp = scene.solids.find((s) => (doc.entities.get(s.id) as { type?: string })?.type === 'st-ramp')!;
    expect(ramp.top[0]).toBeLessThan(ramp.top[2]);
  });

  it('merges geometry into few buffers with an id per triangle', () => {
    const { doc, call } = setup();
    call('addRectangle', { x: 0, y: 0, width: 4000, height: 3000, });
    for (const x of [1000, 3000]) {
      const { id } = call('placeEquipment', { type: 'eq-bench', x, y: 1000 }) as { id: string };
      call('updateEntity', { id, height: 900 });
    }
    const b = sceneBuffers(buildScene(doc), '#4A4A4A');
    for (const m of b.meshes) expect(m.ids.length * 9).toBe(m.positions.length);
    for (const l of b.lines) expect(l.ids.length * 6).toBe(l.positions.length);
    // Rectangle lines have no height: they stay pickable 3D lines with their own ids; outlines carry none.
    const lineIds = new Set(b.lines.flatMap((l) => l.ids).filter(Boolean));
    expect([...lineIds].every((id) => doc.entities.get(id!)?.kind === 'line')).toBe(true);
    expect(lineIds.size).toBe(4);
    const benchTriangles = b.meshes.flatMap((m) => m.ids).filter((id) => doc.entities.get(id)?.kind === 'equipment');
    expect(benchTriangles.length).toBe(2 * 12); // two boxes, 12 triangles each
  });

  it('is available through the API', () => {
    const { call } = setup();
    call('addCircle', { x: 0, y: 0, radius: 500 });
    const s = call('scene3d', {}) as { lines: unknown[] };
    expect(s.lines.length).toBeGreaterThan(0);
  });
});
