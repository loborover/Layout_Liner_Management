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

  it('docs/API-METHODS.md is up to date (npm run docs:api)', () => {
    expect(readFileSync(new URL('../docs/API-METHODS.md', import.meta.url), 'utf8')).toBe(apiReference());
  });
});
