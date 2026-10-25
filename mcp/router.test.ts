import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EditorApi } from '../src/api/editorApi';
import { handleJsonRpc } from '../src/api/rpc';
import { History } from '../src/model/commands';
import { DocumentModel } from '../src/model/document';
import { Router } from './router';
import { toolList } from './tools';

describe('MCP router', () => {
  it('edits a headless drawing and autosaves it to the file', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'll-')), 'plan.json');
    const router = new Router({ file });
    await router.newDrawing();
    const r = (await router.call('addRectangle', { x: 0, y: 0, width: 5000, height: 4000, name: '창고' })) as { shape: string };
    expect(r.shape).toBeTruthy();
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved.entities.some((e: { kind: string; name?: string }) => e.kind === 'shape' && e.name === '창고')).toBe(true);
  });

  it('forwards calls to a connected editor and returns its answer', async () => {
    const router = new Router();
    // A fake editor tab: answers with its own EditorApi, like src/api/bridge.ts does in the browser.
    const doc = new DocumentModel();
    const api = new EditorApi(doc, new History(doc));
    const socket = {
      send: (text: string) => queueMicrotask(() => router.receive(JSON.stringify(handleJsonRpc(api, JSON.parse(text))))),
      close: () => {},
    };
    router.attach(socket);
    await router.call('placeEquipment', { type: '리프트', x: 0, y: 0 });
    expect(router.doc.entities.size).toBe(0); // the headless document is untouched
    expect(doc.entities.size).toBe(1);
    await expect(router.call('deleteEntities', { ids: ['nope'] })).rejects.toThrow(/객체가 없습니다/);
    router.detach(socket);
    expect(router.connected).toBe(false);
  });

  it('lists one tool per API method plus the file tools', () => {
    const names = toolList().map((t) => t.name);
    expect(names).toContain('addRectangle');
    expect(names).toContain('open_file');
    expect(new Set(names).size).toBe(names.length);
  });
});
