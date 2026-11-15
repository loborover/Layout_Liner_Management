/**
 * @file layerTree.ts
 *
 * Edits of the floor > folder (> folder …) > layer tree on a plain LayerTree copy (src/model/commands.ts), so the
 * object tree (src/ui/tree.ts) and the API (src/api/editorApi.ts) apply them the same way and wrap the result in
 * one SetLayerTree command. Folders nest (the user's request, 2026-11-15); these functions keep the tree sound:
 * a folder never ends up inside itself, and a folder's sub-folders and layers always share its floor.
 * Names may repeat; nodes are identified by id. DOM-free.
 */
import type { LayerTree } from './commands';
import type { Folder, Id } from './types';

/** Where a folder or layer goes: straight under a floor, or into a folder. */
export type TreeParent = { kind: 'floor'; id: Id } | { kind: 'folder'; id: Id };

/** Ids of a folder and every folder inside it, however deep. */
export function folderSubtree(folders: readonly Folder[], id: Id): Set<Id> {
  const out = new Set<Id>([id]);
  // Folders are few; repeat until no new child is found (also safe with a loop in bad data).
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of folders) {
      if (f.parent && out.has(f.parent) && !out.has(f.id)) {
        out.add(f.id);
        grew = true;
      }
    }
  }
  return out;
}

/** Puts every folder and layer inside folder `root` (and the folder itself) on `floor`. */
function setSubtreeFloor(t: LayerTree, root: Id, floor: Id): void {
  const inside = folderSubtree(t.folders, root);
  for (const f of t.folders) if (inside.has(f.id)) f.floor = floor;
  for (const l of t.layers) if (l.folder && inside.has(l.folder)) l.floor = floor;
}

/**
 * Moves a folder (with everything in it) under a floor or into another folder. Returns an error message for the
 * user, or null when done; moving a folder into itself or into one of its own sub-folders is refused.
 */
export function moveFolder(t: LayerTree, id: Id, to: TreeParent): string | null {
  const folder = t.folders.find((f) => f.id === id);
  if (!folder) return `폴더가 없습니다: ${id}`;
  if (to.kind === 'folder') {
    const target = t.folders.find((f) => f.id === to.id);
    if (!target) return `폴더가 없습니다: ${to.id}`;
    if (folderSubtree(t.folders, id).has(to.id)) return '폴더를 자기 자신이나 그 하위 폴더 안으로 옮길 수 없습니다.';
    folder.parent = target.id;
    setSubtreeFloor(t, id, target.floor);
  } else {
    if (!t.floors.some((f) => f.id === to.id)) return `층이 없습니다: ${to.id}`;
    delete folder.parent;
    setSubtreeFloor(t, id, to.id);
  }
  return null;
}

/** Moves a layer under a floor or into a folder (taking that folder's floor). */
export function moveLayer(t: LayerTree, id: Id, to: TreeParent): string | null {
  const layer = t.layers.find((l) => l.id === id);
  if (!layer) return `레이어가 없습니다: ${id}`;
  if (to.kind === 'folder') {
    const target = t.folders.find((f) => f.id === to.id);
    if (!target) return `폴더가 없습니다: ${to.id}`;
    layer.folder = target.id;
    layer.floor = target.floor;
  } else {
    if (!t.floors.some((f) => f.id === to.id)) return `층이 없습니다: ${to.id}`;
    delete layer.folder;
    layer.floor = to.id;
  }
  return null;
}

/**
 * Deletes a folder. What it held (sub-folders and layers) moves up into its parent folder, or under the floor,
 * so deleting a folder never deletes layers or objects.
 */
export function removeFolder(t: LayerTree, id: Id): void {
  const folder = t.folders.find((f) => f.id === id);
  if (!folder) return;
  t.folders = t.folders.filter((f) => f.id !== id);
  for (const f of t.folders) {
    if (f.parent !== id) continue;
    if (folder.parent) f.parent = folder.parent;
    else delete f.parent;
  }
  for (const l of t.layers) {
    if (l.folder !== id) continue;
    if (folder.parent) l.folder = folder.parent;
    else delete l.folder;
  }
}

