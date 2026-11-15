/**
 * @file layerTree.test.ts
 *
 * Nested folders: moving and deleting folders (src/model/layerTree.ts), visibility and locks inherited through
 * every folder level, tree paths and the API's folder methods.
 */
import { describe, expect, it } from 'vitest';
import { EditorApi } from '../src/api/editorApi';
import { dispatch } from '../src/api/rpc';
import { AddConstraints, AddItems, History, SetLayerTree, captureLayerTree } from '../src/model/commands';
import { DocumentModel } from '../src/model/document';
import { layerForDrop, layerTreeCommand } from '../src/model/edit';
import { folderSubtree, moveFolder, moveLayer, removeFolder } from '../src/model/layerTree';

/** 1층 > 작업구역 > 협력사 > A사 > layer "A" ; 2층 with its own layer. */
function plant() {
  const doc = new DocumentModel();
  const history = new History(doc);
  const before = captureLayerTree(doc);
  const t = captureLayerTree(doc);
  t.floors.push({ id: 'floor-2', name: '2층', elevation: 4000, height: 4000 });
  t.folders.push(
    { id: 'work', name: '작업구역', floor: 'floor-1', visible: true, locked: false },
    { id: 'partners', name: '협력사', floor: 'floor-1', parent: 'work', visible: true, locked: false },
    { id: 'a', name: 'A사', floor: 'floor-1', parent: 'partners', visible: true, locked: false },
  );
  t.layers.push(
    { id: 'la', name: 'A', color: '#000000', visible: true, locked: false, floor: 'floor-1', folder: 'a' },
    { id: 'l2', name: '0', color: '#000000', visible: true, locked: false, floor: 'floor-2' },
  );
  history.execute(new SetLayerTree('준비', before, t));
  return { doc, history };
}

describe('nested folders', () => {
  it('hides and locks everything inside a folder, however deep', () => {
    const { doc } = plant();
    expect(doc.isLayerEditable('la')).toBe(true);
    doc.folders.get('work')!.locked = true;
    expect(doc.isLayerEditable('la')).toBe(false);
    expect(doc.isLayerVisible('la')).toBe(true);
    doc.folders.get('work')!.locked = false;
    doc.folders.get('partners')!.visible = false;
    expect(doc.isLayerVisible('la')).toBe(false);
  });

  it('gives the path of a layer or folder by name', () => {
    const { doc } = plant();
    expect(doc.treePath('la')).toBe('1층 / 작업구역 / 협력사 / A사 / A');
    expect(doc.treePath('partners')).toBe('1층 / 작업구역 / 협력사');
  });

  it('moves a folder with its sub-folders and layers, also to another floor', () => {
    const { doc } = plant();
    const t = captureLayerTree(doc);
    expect(moveFolder(t, 'partners', { kind: 'floor', id: 'floor-2' })).toBeNull();
    expect(t.folders.find((f) => f.id === 'partners')).toMatchObject({ floor: 'floor-2' });
    expect(t.folders.find((f) => f.id === 'partners')!.parent).toBeUndefined();
    expect(t.folders.find((f) => f.id === 'a')).toMatchObject({ floor: 'floor-2', parent: 'partners' });
    expect(t.layers.find((l) => l.id === 'la')).toMatchObject({ floor: 'floor-2', folder: 'a' });
  });

  it('refuses to put a folder inside itself or its own sub-folder', () => {
    const { doc } = plant();
    const t = captureLayerTree(doc);
    expect(moveFolder(t, 'work', { kind: 'folder', id: 'a' })).toMatch(/하위 폴더/);
    expect(moveFolder(t, 'work', { kind: 'folder', id: 'work' })).toMatch(/하위 폴더/);
    expect(t.folders.find((f) => f.id === 'work')!.parent).toBeUndefined();
    expect([...folderSubtree(t.folders, 'work')].sort()).toEqual(['a', 'partners', 'work']);
  });

  it('moves a layer into a folder on another floor, and back under a floor', () => {
    const { doc } = plant();
    const t = captureLayerTree(doc);
    expect(moveLayer(t, 'l2', { kind: 'folder', id: 'partners' })).toBeNull();
    expect(t.layers.find((l) => l.id === 'l2')).toMatchObject({ floor: 'floor-1', folder: 'partners' });
    expect(moveLayer(t, 'l2', { kind: 'floor', id: 'floor-2' })).toBeNull();
    expect(t.layers.find((l) => l.id === 'l2')!.folder).toBeUndefined();
  });

  it('deleting a folder moves what it held one level up', () => {
    const { doc } = plant();
    const t = captureLayerTree(doc);
    removeFolder(t, 'partners');
    expect(t.folders.find((f) => f.id === 'a')!.parent).toBe('work');
    removeFolder(t, 'work');
    expect(t.folders.find((f) => f.id === 'a')!.parent).toBeUndefined();
    expect(t.layers.find((l) => l.id === 'la')!.folder).toBe('a');
  });

  it('moving a folder to another floor splits points its objects shared with objects left behind', () => {
    const { doc, history } = plant();
    history.execute(
      new AddItems(
        [
          { id: 'p1', x: 0, y: 0 },
          { id: 'p2', x: 1000, y: 0 },
          { id: 'p3', x: 2000, y: 0 },
          { id: 'q', x: 2000, y: 0 },
        ],
        [
          { id: 'inA', kind: 'line', p1: 'p1', p2: 'p2', layer: 'la' },
          { id: 'out', kind: 'line', p1: 'p2', p2: 'p3', layer: 'layer-0' },
          { id: 'pt', kind: 'point', at: 'q', layer: 'la' },
        ],
      ),
    );
    history.execute(new AddConstraints([{ id: 'k', kind: 'coincident', refs: ['q', 'p3'] }]));
    const before = captureLayerTree(doc);
    const after = captureLayerTree(doc);
    expect(moveFolder(after, 'work', { kind: 'floor', id: 'floor-2' })).toBeNull();
    history.execute(layerTreeCommand(doc, '폴더 옮기기', before, after));
    const inA = doc.entities.get('inA')!;
    const out = doc.entities.get('out')!;
    if (inA.kind !== 'line' || out.kind !== 'line') throw new Error('lines expected');
    expect(out.p1).toBe('p2');
    expect(inA.p2).not.toBe('p2');
    expect(doc.point(inA.p2)).toMatchObject({ x: 1000, y: 0 });
    expect(doc.constraints.has('k')).toBe(false);
    history.undo();
    expect((doc.entities.get('inA') as { p2: string }).p2).toBe('p2');
    expect(doc.constraints.has('k')).toBe(true);
    expect(doc.layers.get('la')!.floor).toBe('floor-1');
  });

  it('drops objects on a folder into the layers of its sub-folders when it has none of its own', () => {
    const { doc } = plant();
    expect(layerForDrop(doc, { kind: 'folder', id: 'work' }, 'layer-0')).toBe('la');
  });

  it('adds, moves and lists folders through the API by id', () => {
    const { doc, history } = plant();
    const api = new EditorApi(doc, history);
    const { folder } = dispatch(api, 'addFolder', { name: '협력사', parent: 'work' }) as { folder: string; path: string };
    expect(doc.folders.get(folder)).toMatchObject({ parent: 'work', floor: 'floor-1' });
    dispatch(api, 'updateFolder', { id: folder, parent: 'a' });
    expect(doc.treePath(folder)).toBe('1층 / 작업구역 / 협력사 / A사 / 협력사');
    expect(() => dispatch(api, 'updateFolder', { id: 'work', parent: folder })).toThrow();
    dispatch(api, 'updateFolder', { id: folder, parent: null, floor: 'floor-2' });
    expect(doc.folders.get(folder)).toMatchObject({ floor: 'floor-2' });
    const summary = dispatch(api, 'summary', {}) as { folders: { id: string; path: string }[]; layers: { id: string; path: string }[] };
    // Two folders named 협력사, told apart by id and path.
    expect(summary.folders.filter((f) => f.path.endsWith('협력사')).map((f) => f.id).sort()).toEqual([folder, 'partners'].sort());
    expect(summary.layers.find((l) => l.id === 'la')!.path).toBe('1층 / 작업구역 / 협력사 / A사 / A');
    history.undo();
    expect(doc.folders.get(folder)).toMatchObject({ floor: 'floor-1', parent: 'a' });
  });
});
