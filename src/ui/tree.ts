/**
 * @file tree.ts
 *
 * Object tree in the side bar, modelled on the browser of Autodesk Fusion 360:
 *
 *   층 (floor) > 폴더 (folder) > 레이어 (layer) > 객체 (entity)
 *   도형 (shape) > 선 (its edge lines) > 점 (start, middle, end)
 *
 * Clicking a floor shows it; clicking an object selects it (Shift adds), double-clicking zooms to it. In edit
 * mode floors, folders and layers can be added, renamed (double-click), deleted, hidden and locked, and a
 * layer can be dragged onto a folder or a floor. Object order and properties are edited with the ribbon's
 * 순서 group and the property panel. Tree edits are undoable commands (SetLayerTree); visibility and locks are
 * view state applied directly, as in most CAD tools.
 *
 * Large layers list their first MAX_ROWS objects only, and the tree is rebuilt at most a few times a second.
 */
import { SetLayerTree, captureLayerTree, type LayerTree } from '../model/commands';
import { midpointId } from '../model/document';
import { newId } from '../model/ids';
import { categoryOf } from '../model/presets';
import type { Entity, Floor, Folder, Id, Layer } from '../model/types';
import { formatArea, formatLength } from '../view/format';
import type { UiHost } from './host';
import { type IconName, icon } from './icons';
import { LAYER_COLORS } from '../theme';

const MAX_ROWS = 300;
const KIND_LABEL: Record<Entity['kind'], string> = { point: '점', line: '선', circle: '원', dimension: '치수', equipment: '설비', shape: '도형' };

export class ObjectTree {
  /** Explicit open/closed choices by node key; nodes without one use their default. */
  private open = new Map<string, boolean>();
  private timer: number | undefined;
  private dragLayer: Id | null = null;

  constructor(
    private readonly host: UiHost,
    private readonly root: HTMLElement,
  ) {}

  /** Rebuilds soon (coalescing bursts such as drags). */
  refresh(): void {
    if (this.timer !== undefined) return;
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      this.render();
    }, 100);
  }

  render(): void {
    const scroll = this.root.parentElement?.scrollTop ?? 0;
    const { doc } = this.host;
    const rows: HTMLElement[] = [];
    for (const floor of doc.floors.values()) {
      rows.push(this.floorNode(floor));
      if (!this.isOpen(`f:${floor.id}`, floor.id === doc.activeFloor)) continue;
      for (const folder of doc.folders.values()) {
        if (folder.floor !== floor.id) continue;
        rows.push(this.folderNode(folder));
        if (!this.isOpen(`g:${folder.id}`, true)) continue;
        for (const layer of doc.layers.values()) if (layer.folder === folder.id) rows.push(...this.layerRows(layer, 2));
      }
      for (const layer of doc.layers.values()) if (layer.floor === floor.id && !layer.folder) rows.push(...this.layerRows(layer, 1));
    }
    this.root.replaceChildren(...rows);
    if (this.root.parentElement) this.root.parentElement.scrollTop = scroll;
  }

  // ---- actions (also used by the side bar header buttons) ----

  addFloor(): void {
    const { doc } = this.host;
    const floors = [...doc.floors.values()];
    const top = floors.reduce((a, f) => (f.elevation > a.elevation ? f : a), floors[0]);
    const text = this.host.ask('새 층: 이름, 바닥 높이(mm), 층고(mm)', `${floors.length + 1}층, ${top.elevation + top.height}, ${top.height}`);
    if (text === null) return;
    const [name, elevation, height] = text.split(',').map((s) => s.trim());
    const floor: Floor = { id: newId('floor'), name: name || `${floors.length + 1}층`, elevation: Number(elevation) || 0, height: Number(height) > 0 ? Number(height) : 4000 };
    const layer: Layer = { id: newId('layer'), name: '0', color: LAYER_COLORS[0], visible: true, locked: false, floor: floor.id };
    this.change('층 추가', (t) => {
      t.floors.push(floor);
      t.layers.push(layer);
    });
    this.host.setFloor(floor.id);
    this.host.setCurrentLayer(layer.id);
  }

  addFolder(): void {
    const { doc } = this.host;
    const name = this.host.ask('새 폴더 이름', `폴더 ${doc.folders.size + 1}`);
    if (name === null || !name.trim()) return;
    const folder: Folder = { id: newId('folder'), name: name.trim(), floor: doc.activeFloor, visible: true, locked: false };
    this.change('폴더 추가', (t) => t.folders.push(folder));
  }

  addLayer(): void {
    const { doc } = this.host;
    const name = this.host.ask('새 레이어 이름', `레이어 ${doc.layers.size}`);
    if (name === null || !name.trim()) return;
    const current = doc.layers.get(this.host.currentLayer());
    const layer: Layer = {
      id: newId('layer'),
      name: name.trim(),
      color: LAYER_COLORS[doc.layers.size % LAYER_COLORS.length],
      visible: true,
      locked: false,
      floor: doc.activeFloor,
      ...(current?.floor === doc.activeFloor && current.folder ? { folder: current.folder } : {}),
    };
    this.change('레이어 추가', (t) => t.layers.push(layer));
    this.host.setCurrentLayer(layer.id);
  }

  // ---- nodes ----

  private isOpen(key: string, fallback: boolean): boolean {
    return this.open.get(key) ?? fallback;
  }

  private node(depth: number, key: string | null, expandable: boolean, defaultOpen: boolean): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'node';
    row.setAttribute('role', 'treeitem');
    row.style.paddingLeft = `${depth * 14}px`;
    const twisty = document.createElement('span');
    twisty.className = 'twisty';
    if (expandable && key) {
      const open = this.isOpen(key, defaultOpen);
      twisty.classList.toggle('open', open);
      twisty.append(icon('chevron'));
      row.setAttribute('aria-expanded', String(open));
      twisty.addEventListener('click', (e) => {
        e.stopPropagation();
        this.open.set(key, !open);
        this.render();
      });
    }
    row.append(twisty);
    return row;
  }

  private label(text: string, title?: string): HTMLSpanElement {
    const s = document.createElement('span');
    s.className = 'label';
    s.textContent = text;
    if (title) s.title = title;
    return s;
  }

  private meta(text: string): HTMLSpanElement {
    const s = document.createElement('span');
    s.className = 'meta';
    s.textContent = text;
    return s;
  }

  private mini(name: IconName, title: string, onClick: () => void, editOnly = true): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = `mini${editOnly ? ' edit-only' : ''}`;
    b.title = title;
    b.append(icon(name));
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  private floorNode(floor: Floor): HTMLElement {
    const { doc } = this.host;
    const row = this.node(0, `f:${floor.id}`, true, floor.id === doc.activeFloor);
    row.classList.toggle('current-floor', floor.id === doc.activeFloor);
    const label = this.label(floor.name, '클릭: 이 층 보기 · 더블클릭: 이름·높이 수정');
    row.addEventListener('click', () => this.host.setFloor(floor.id));
    label.addEventListener('dblclick', () => this.editFloor(floor));
    row.append(icon('floor'), label, this.meta(`EL ${formatLength(floor.elevation, this.host.unit())}`));
    row.append(this.mini('trash', '층 삭제 (객체가 없는 층만)', () => this.removeFloor(floor.id)));
    this.dropTarget(row, (layer) => {
      layer.floor = floor.id;
      delete layer.folder;
    });
    return row;
  }

  private folderNode(folder: Folder): HTMLElement {
    const row = this.node(1, `g:${folder.id}`, true, true);
    row.classList.toggle('dim', !folder.visible);
    const label = this.label(folder.name, '더블클릭: 이름 바꾸기');
    label.addEventListener('dblclick', () => {
      const name = this.host.ask('폴더 이름', folder.name);
      if (name?.trim()) this.change('폴더 이름 변경', (t) => (t.folders.find((f) => f.id === folder.id)!.name = name.trim()));
    });
    row.append(icon('folder'), label);
    row.append(this.viewToggle(folder, 'visible'), this.viewToggle(folder, 'locked'));
    row.append(this.mini('trash', '폴더 삭제 (레이어는 층으로 옮겨집니다)', () => this.removeFolder(folder.id)));
    this.dropTarget(row, (layer) => {
      layer.floor = folder.floor;
      layer.folder = folder.id;
    });
    return row;
  }

  private layerRows(layer: Layer, depth: number): HTMLElement[] {
    const { doc } = this.host;
    const items = [...doc.entities.values()].filter((e) => e.layer === layer.id);
    const row = this.node(depth, `l:${layer.id}`, items.length > 0, items.length <= 50);
    row.classList.toggle('dim', !layer.visible);
    const current = this.host.currentLayer() === layer.id;
    const pick = document.createElement('input');
    pick.type = 'radio';
    pick.name = 'current-layer';
    pick.checked = current;
    pick.className = 'edit-only';
    pick.title = '현재 레이어 (새 객체가 여기에 그려집니다)';
    pick.addEventListener('change', () => this.host.setCurrentLayer(layer.id));
    const color = document.createElement('input');
    color.type = 'color';
    color.value = layer.color;
    color.title = '레이어 색';
    color.disabled = this.host.mode() === 'view';
    color.addEventListener('change', () => this.change('레이어 색 변경', (t) => (t.layers.find((l) => l.id === layer.id)!.color = color.value)));
    const label = this.label(layer.name, '더블클릭: 이름 바꾸기 · 끌어서 폴더나 층으로 옮기기');
    label.addEventListener('dblclick', () => {
      const name = this.host.ask('레이어 이름', layer.name);
      if (name?.trim()) this.change('레이어 이름 변경', (t) => (t.layers.find((l) => l.id === layer.id)!.name = name.trim()));
    });
    row.append(pick, color, icon('layer'), label, this.meta(String(items.length)));
    row.append(this.viewToggle(layer, 'visible'), this.viewToggle(layer, 'locked'));
    row.append(this.mini('trash', '레이어 삭제 (빈 레이어만)', () => this.removeLayer(layer.id)));
    if (this.host.mode() === 'edit') {
      row.draggable = true;
      row.addEventListener('dragstart', (e) => {
        this.dragLayer = layer.id;
        e.dataTransfer?.setData('text/plain', layer.id);
      });
      row.addEventListener('dragend', () => (this.dragLayer = null));
    }
    const rows: HTMLElement[] = [row];
    if (!this.isOpen(`l:${layer.id}`, items.length <= 50)) return rows;
    for (const e of items.slice(0, MAX_ROWS)) rows.push(...this.entityRows(e, depth + 1));
    if (items.length > MAX_ROWS) {
      const more = document.createElement('div');
      more.className = 'more';
      more.textContent = `… 외 ${items.length - MAX_ROWS}개 (도면에서 선택하면 속성을 볼 수 있습니다)`;
      rows.push(more);
    }
    return rows;
  }

  private entityRows(e: Entity, depth: number): HTMLElement[] {
    const { doc, selection } = this.host;
    const unit = this.host.unit();
    const expandable = e.kind === 'shape' || e.kind === 'line';
    const key = `e:${e.id}`;
    // A line opens by itself when one of its points is selected, so the selected point shows in the tree.
    const pointSelected = e.kind === 'line' && [e.p1, midpointId(e.id), e.p2].some((id) => selection.has(id));
    const row = this.node(depth, key, expandable, pointSelected);
    row.classList.toggle('selected', selection.has(e.id));
    let iconName: IconName =
      e.kind === 'shape' ? 'shape' : e.kind === 'dimension' ? 'dimension' : e.kind === 'circle' ? 'circle' : e.kind === 'point' ? 'point' : 'line';
    let text = e.name || KIND_LABEL[e.kind];
    let meta = '';
    if (e.kind === 'point') {
      const p = doc.point(e.at);
      meta = `${formatLength(p.x, unit)}, ${formatLength(p.y, unit)}`;
    } else if (e.kind === 'line') {
      const a = doc.point(e.p1);
      const b = doc.point(e.p2);
      meta = formatLength(Math.hypot(b.x - a.x, b.y - a.y), unit) + (e.stroke && e.stroke.width > 0 ? ` · ${e.stroke.width}` : '');
    } else if (e.kind === 'shape') meta = formatArea(doc.shapeArea(e));
    else if (e.kind === 'circle') meta = `R ${formatLength(e.radius, unit)}`;
    else if (e.kind === 'dimension') {
      const a = doc.point(e.p1);
      const b = doc.point(e.p2);
      meta = formatLength(Math.hypot(b.x - a.x, b.y - a.y), unit);
    } else if (e.kind === 'equipment') {
      const type = doc.equipmentTypes.get(e.type);
      const cat = categoryOf(type);
      iconName = cat === 'equipment' ? 'equipment' : cat;
      text = [e.tag, e.name || type?.name].filter(Boolean).join(' ');
    }
    if (e.binding) meta += ` · ⚡${e.binding}`;
    row.append(icon(iconName), this.label(text, '클릭: 선택 · Shift+클릭: 추가 · 더블클릭: 확대'), this.meta(meta));
    row.addEventListener('click', (ev) => {
      if (!doc.isVisible(e)) this.host.setFloor(doc.floorOf(e) ?? doc.activeFloor);
      if (ev.shiftKey) selection.toggle(e.id);
      else selection.set([e.id]);
    });
    row.addEventListener('dblclick', () => this.host.zoomTo([e.id]));
    const rows: HTMLElement[] = [row];
    if (!expandable || !this.isOpen(key, pointSelected)) return rows;
    if (e.kind === 'shape') {
      for (const id of e.edges) {
        const line = doc.entities.get(id);
        if (line) rows.push(...this.entityRows(line, depth + 1));
      }
    } else if (e.kind === 'line') {
      // A line is an assembly of three points and the line: each point is its own selectable object.
      const pt = (name: string, id: Id) => {
        const v = doc.vertex(id);
        const r = this.node(depth + 1, null, false, false);
        r.classList.toggle('selected', selection.has(id));
        r.append(icon('point'), this.label(name, '클릭: 점 선택 · Shift+클릭: 추가'), this.meta(`${formatLength(v.x, unit)}, ${formatLength(v.y, unit)}`));
        r.addEventListener('click', (ev) => {
          if (ev.shiftKey) selection.toggle(id);
          else selection.set([id]);
        });
        return r;
      };
      rows.push(pt('시작점', e.p1), pt('중간점', midpointId(e.id)), pt('끝점', e.p2));
    }
    return rows;
  }

  /** Eye or lock toggle for a folder or layer. View state: applied directly, not undoable. */
  private viewToggle(target: Folder | Layer, prop: 'visible' | 'locked'): HTMLButtonElement {
    const on = target[prop];
    const name: IconName = prop === 'visible' ? (on ? 'eye' : 'eyeOff') : on ? 'lock' : 'unlock';
    return this.mini(
      name,
      prop === 'visible' ? (on ? '숨기기' : '보이기') : on ? '잠금 해제' : '잠금 (선택·편집 불가)',
      () => {
        const { doc } = this.host;
        const live = doc.folders.get(target.id) ?? doc.layers.get(target.id);
        if (!live) return;
        live[prop] = !live[prop];
        doc.changed();
      },
      prop === 'locked',
    );
  }

  private dropTarget(row: HTMLElement, apply: (layer: Layer) => void): void {
    row.addEventListener('dragover', (e) => {
      if (!this.dragLayer) return;
      e.preventDefault();
      row.classList.add('drop');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drop');
      const id = this.dragLayer;
      if (!id) return;
      this.change('레이어 옮기기', (t) => {
        const layer = t.layers.find((l) => l.id === id);
        if (layer) apply(layer);
      });
    });
  }

  private editFloor(floor: Floor): void {
    const text = this.host.ask('층: 이름, 바닥 높이(mm), 층고(mm)', `${floor.name}, ${floor.elevation}, ${floor.height}`);
    if (text === null) return;
    const [name, elevation, height] = text.split(',').map((s) => s.trim());
    this.change('층 수정', (t) => {
      const f = t.floors.find((x) => x.id === floor.id)!;
      if (name) f.name = name;
      if (Number.isFinite(Number(elevation)) && elevation !== '') f.elevation = Number(elevation);
      if (Number(height) > 0) f.height = Number(height);
    });
  }

  private removeFloor(id: Id): void {
    const { doc } = this.host;
    if (doc.floors.size <= 1) return this.host.notify('마지막 층은 삭제할 수 없습니다.');
    const layers = new Set([...doc.layers.values()].filter((l) => l.floor === id).map((l) => l.id));
    if ([...doc.entities.values()].some((e) => layers.has(e.layer))) return this.host.notify('객체가 있는 층은 삭제할 수 없습니다.');
    this.change('층 삭제', (t) => {
      t.floors = t.floors.filter((f) => f.id !== id);
      t.folders = t.folders.filter((f) => f.floor !== id);
      t.layers = t.layers.filter((l) => l.floor !== id);
    });
  }

  private removeFolder(id: Id): void {
    this.change('폴더 삭제', (t) => {
      t.folders = t.folders.filter((f) => f.id !== id);
      for (const l of t.layers) if (l.folder === id) delete l.folder;
    });
  }

  private removeLayer(id: Id): void {
    const { doc } = this.host;
    const layer = doc.layers.get(id);
    if (!layer) return;
    if ([...doc.layers.values()].filter((l) => l.floor === layer.floor).length <= 1) return this.host.notify('층의 마지막 레이어는 삭제할 수 없습니다.');
    if ([...doc.entities.values()].some((e) => e.layer === id)) {
      return this.host.notify('객체가 있는 레이어는 삭제할 수 없습니다. 객체를 다른 레이어로 옮긴 뒤 삭제하십시오.');
    }
    this.change('레이어 삭제', (t) => (t.layers = t.layers.filter((l) => l.id !== id)));
  }

  /** Applies an edit to a copy of the layer tree as one undoable step. */
  private change(label: string, edit: (t: LayerTree) => void): void {
    const { doc, history } = this.host;
    const before = captureLayerTree(doc);
    const after = captureLayerTree(doc);
    edit(after);
    history.execute(new SetLayerTree(label, before, after));
  }
}
