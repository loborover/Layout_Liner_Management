import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { apiReference } from '../scripts/apiReference';
import { EditorApi } from '../src/api/editorApi';
import { dispatch, handleJsonRpc, METHODS } from '../src/api/rpc';
import { History } from '../src/model/commands';
import { DocumentModel } from '../src/model/document';

function setup() {
  const doc = new DocumentModel();
  const history = new History(doc);
  return { doc, history, api: new EditorApi(doc, history) };
}

describe('editing API', () => {
  it('draws a room as one undo step and reports it', () => {
    const { api, doc, history } = setup();
    dispatch(api, 'addRectangle', { x: 0, y: 0, width: 4000, height: 3000 });
    const kinds = [...doc.entities.values()].map((e) => e.kind).sort();
    expect(kinds).toEqual(['line', 'line', 'line', 'line', 'shape']);
    history.undo();
    expect(doc.entities.size).toBe(0);
  });

  it('rolls a failing batch back completely', () => {
    const { api, doc } = setup();
    expect(() =>
      dispatch(api, 'batch', {
        calls: [
          { method: 'addCircle', params: { center: [0, 0], radius: 500 } },
          { method: 'deleteEntities', params: { ids: ['no-such-id'] } },
        ],
      }),
    ).toThrow();
    expect(doc.entities.size).toBe(0);
  });

  it('answers JSON-RPC with errors instead of throwing', () => {
    const { api } = setup();
    expect(handleJsonRpc(api, { id: 1, method: 'summary' })).toMatchObject({ id: 1, result: expect.anything() });
    expect(handleJsonRpc(api, { id: 2, method: 'nope' })).toMatchObject({ id: 2, error: expect.anything() });
  });

  it('every method has a description and an object schema', () => {
    for (const [name, m] of Object.entries(METHODS)) {
      expect(m.description.length, name).toBeGreaterThan(3);
      expect(m.params.type, name).toBe('object');
    }
  });

  it('refuses an explicit layer that is not on the active floor', () => {
    const { api, doc } = setup();
    const other = dispatch(api, 'addFloor', { name: '2층' }) as { floor: string; layer: string };
    expect(doc.activeFloor).not.toBe(other.floor);
    expect(() => dispatch(api, 'addCircle', { center: [0, 0], radius: 100, layer: other.layer })).toThrow('setActiveFloor');
    expect(doc.entities.size).toBe(0);
  });

  it('exports wall bands and preset symbols to SVG and DXF', () => {
    const { api, doc } = setup();
    dispatch(api, 'addRectangle', { x: 0, y: 0, width: 4000, height: 3000 });
    const lines = [...doc.entities.values()].filter((e) => e.kind === 'line').map((e) => e.id);
    dispatch(api, 'setStroke', { ids: lines, stroke: { width: 200, align: 'inside', color: '#ff0000' } });
    dispatch(api, 'placeEquipment', { type: 'st-column-round', x: 1000, y: 1000 });
    dispatch(api, 'placeEquipment', { type: 'st-stair', x: 3000, y: 1500 });
    const { svg } = dispatch(api, 'exportSvg', {}) as { svg: string };
    expect(svg.match(/fill="#ff0000"/g)?.length).toBe(4); // one band per wall
    expect(svg).toContain('<circle'); // round column
    expect(svg).toContain('UP'); // stair note
    const { dxf } = dispatch(api, 'exportDxf', {}) as { dxf: string };
    // 4 wall bands + stair footprint as closed polylines, the round column as a circle, stair treads as lines.
    expect(dxf.match(/^POLYLINE$/gm)?.length).toBe(5);
    expect(dxf.match(/^CIRCLE$/gm)?.length).toBe(1);
    expect(dxf.match(/^LINE$/gm)!.length).toBeGreaterThan(4 + 10);
  });

  it('moves a vertex in X, Y, Z and sets 3D heights, round-tripping through the file', () => {
    const { api, doc, history } = setup();
    dispatch(api, 'addRectangle', { x: 0, y: 0, width: 4000, height: 3000 });
    const line = [...doc.entities.values()].find((e) => e.kind === 'line')!;
    const info = dispatch(api, 'getEntity', { id: line.id }) as { start: { id: string; z: number }; effectiveHeight: number };
    expect(info.start.z).toBe(0);
    expect(info.effectiveHeight).toBe(0); // a plain line is flat
    dispatch(api, 'setPoint', { id: info.start.id, z: 300 });
    dispatch(api, 'updateEntity', { id: line.id, height: 2500 });
    expect(doc.point(info.start.id).z).toBe(300);
    const saved = dispatch(api, 'getDocument', {}) as { version: number; points: { z?: number }[]; entities: { height?: number }[] };
    expect(saved.version).toBe(3);
    const reloaded = setup();
    dispatch(reloaded.api, 'loadDocument', { data: saved });
    expect(reloaded.doc.point(info.start.id).z).toBe(300);
    expect((reloaded.doc.entities.get(line.id) as { height?: number }).height).toBe(2500);
    history.undo();
    history.undo();
    expect(doc.point(info.start.id).z).toBeUndefined();
  });

  it('docs/API-METHODS.md is up to date (npm run docs:api)', () => {
    expect(readFileSync(new URL('../docs/API-METHODS.md', import.meta.url), 'utf8')).toBe(apiReference());
  });
});
