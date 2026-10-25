import type { History } from '../model/commands';
import { SetEquipmentTypes, SetLayers } from '../model/commands';
import type { DocumentModel } from '../model/document';
import { newId } from '../model/ids';
import type { EquipmentType, Id, Layer } from '../model/types';

export interface PanelHost {
  doc: DocumentModel;
  history: History;
  currentLayer: () => Id;
  setCurrentLayer: (id: Id) => void;
  /** Type being placed, if the equipment tool is active. */
  activeType: () => Id | null;
  placeEquipment: (type: Id) => void;
  notify: (text: string) => void;
  ask: (question: string, initial: string) => string | null;
}

const LAYER_COLORS = ['#1f2937', '#0f766e', '#16a34a', '#d97706', '#9333ea', '#dc2626', '#0891b2'];

/** Side panel: layer table and equipment library. Rebuilt only when what it shows changes. */
export class SidePanel {
  private shown = '';

  constructor(
    private readonly host: PanelHost,
    private readonly layersEl: HTMLElement,
    private readonly typesEl: HTMLElement,
  ) {}

  refresh(): void {
    const { doc } = this.host;
    const counts = this.typeCounts();
    const key = JSON.stringify([
      [...doc.layers.values()],
      [...doc.equipmentTypes.values()],
      [...counts],
      this.host.currentLayer(),
      this.host.activeType(),
    ]);
    if (key === this.shown) return;
    this.shown = key;
    this.renderLayers();
    this.renderTypes(counts);
  }

  addLayer(): void {
    const { doc } = this.host;
    const name = this.host.ask('새 레이어 이름', `레이어 ${doc.layers.size}`);
    if (name === null || !name.trim()) return;
    const layer: Layer = {
      id: newId('layer'),
      name: name.trim(),
      color: LAYER_COLORS[doc.layers.size % LAYER_COLORS.length],
      visible: true,
      locked: false,
    };
    this.setLayers('레이어 추가', [...this.layers(), layer]);
    this.host.setCurrentLayer(layer.id);
  }

  addType(): void {
    const t = this.askType('새 설비 종류: 이름, 폭(mm), 깊이(mm), 번호 접두어', '설비, 2000, 1000, EQ');
    if (!t) return;
    const type: EquipmentType = { id: newId('eq'), ...t };
    this.setTypes('설비 종류 추가', [...this.types(), type]);
  }

  private layers(): Layer[] {
    return [...this.host.doc.layers.values()].map((l) => ({ ...l }));
  }

  private types(): EquipmentType[] {
    return [...this.host.doc.equipmentTypes.values()].map((t) => ({ ...t }));
  }

  private setLayers(label: string, after: Layer[]): void {
    this.host.history.execute(new SetLayers(label, this.layers(), after));
  }

  private setTypes(label: string, after: EquipmentType[]): void {
    this.host.history.execute(new SetEquipmentTypes(label, this.types(), after));
  }

  private typeCounts(): Map<Id, number> {
    const counts = new Map<Id, number>();
    for (const e of this.host.doc.entities.values()) {
      if (e.kind === 'equipment') counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    }
    return counts;
  }

  private renderLayers(): void {
    const { doc } = this.host;
    const current = this.host.currentLayer();
    this.layersEl.replaceChildren(
      ...[...doc.layers.values()].map((layer) => {
        const row = document.createElement('li');
        row.className = 'row';

        const pick = document.createElement('input');
        pick.type = 'radio';
        pick.name = 'current-layer';
        pick.checked = layer.id === current;
        pick.title = '현재 레이어 (새 객체가 여기에 그려집니다)';
        pick.addEventListener('change', () => this.host.setCurrentLayer(layer.id));

        // Visibility and locking are view state, as in most CAD tools: applied directly, not undoable.
        const toggle = (prop: 'visible' | 'locked', title: string, text: string) => {
          const label = document.createElement('label');
          label.className = 'toggle';
          label.title = title;
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.checked = layer[prop];
          box.addEventListener('change', () => {
            const l = doc.layers.get(layer.id);
            if (!l) return;
            l[prop] = box.checked;
            doc.changed();
          });
          label.append(box, text);
          return label;
        };

        const color = document.createElement('input');
        color.type = 'color';
        color.value = layer.color;
        color.title = '레이어 색';
        color.addEventListener('change', () => {
          this.setLayers('레이어 색 변경', this.layers().map((l) => (l.id === layer.id ? { ...l, color: color.value } : l)));
        });

        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = layer.name;
        name.title = '더블클릭: 이름 바꾸기';
        name.addEventListener('dblclick', () => {
          const next = this.host.ask('레이어 이름', layer.name);
          if (next === null || !next.trim() || next.trim() === layer.name) return;
          this.setLayers('레이어 이름 변경', this.layers().map((l) => (l.id === layer.id ? { ...l, name: next.trim() } : l)));
        });

        const remove = document.createElement('button');
        remove.textContent = '×';
        remove.title = '레이어 삭제 (빈 레이어만)';
        remove.addEventListener('click', () => this.removeLayer(layer.id));

        row.append(pick, toggle('visible', '표시', '표시'), toggle('locked', '잠금 (선택·편집 불가)', '잠금'), color, name, remove);
        return row;
      }),
    );
  }

  private removeLayer(id: Id): void {
    const { doc } = this.host;
    if (doc.layers.size <= 1) return this.host.notify('마지막 레이어는 삭제할 수 없습니다.');
    if ([...doc.entities.values()].some((e) => e.layer === id)) {
      return this.host.notify('객체가 있는 레이어는 삭제할 수 없습니다. 객체를 다른 레이어로 옮긴 뒤 삭제하십시오.');
    }
    const after = this.layers().filter((l) => l.id !== id);
    this.setLayers('레이어 삭제', after);
    if (this.host.currentLayer() === id) this.host.setCurrentLayer(after[0].id);
  }

  private renderTypes(counts: Map<Id, number>): void {
    const active = this.host.activeType();
    this.typesEl.replaceChildren(
      ...[...this.host.doc.equipmentTypes.values()].map((type) => {
        const row = document.createElement('li');
        row.className = 'row';
        const place = document.createElement('button');
        place.className = 'type';
        place.setAttribute('aria-pressed', String(type.id === active));
        place.title = '클릭: 배치 · 더블클릭: 이름·크기 수정';
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = type.name;
        const size = document.createElement('span');
        size.className = 'muted';
        size.textContent = `${type.width}×${type.depth}`;
        const count = document.createElement('span');
        count.className = 'count';
        count.textContent = String(counts.get(type.id) ?? 0);
        count.title = '배치된 수';
        place.append(name, size, count);
        place.addEventListener('click', () => this.host.placeEquipment(type.id));
        place.addEventListener('dblclick', () => this.editType(type));

        const remove = document.createElement('button');
        remove.textContent = '×';
        remove.title = '설비 종류 삭제 (배치되지 않은 것만)';
        remove.addEventListener('click', () => {
          if ((counts.get(type.id) ?? 0) > 0) return this.host.notify('배치된 설비가 있는 종류는 삭제할 수 없습니다.');
          this.setTypes('설비 종류 삭제', this.types().filter((t) => t.id !== type.id));
        });
        row.append(place, remove);
        return row;
      }),
    );
  }

  private editType(type: EquipmentType): void {
    const t = this.askType('설비 종류 수정: 이름, 폭(mm), 깊이(mm), 번호 접두어', `${type.name}, ${type.width}, ${type.depth}, ${type.prefix}`);
    if (!t) return;
    this.setTypes('설비 종류 수정', this.types().map((x) => (x.id === type.id ? { ...x, ...t } : x)));
  }

  /** Asks for "name, width, depth, prefix"; null when cancelled or invalid (after telling the user why). */
  private askType(question: string, initial: string): Omit<EquipmentType, 'id'> | null {
    const text = this.host.ask(question, initial);
    if (text === null) return null;
    const t = parseType(text);
    if (!t) this.host.notify('형식: 이름, 폭, 깊이, 접두어 (예: 가공기, 3000, 2200, MC). 폭과 깊이는 0보다 커야 합니다.');
    return t;
  }
}

/** Parses "name, width, depth[, prefix]". */
export function parseType(text: string): Omit<EquipmentType, 'id'> | null {
  const parts = text.split(',').map((s) => s.trim());
  if (parts.length < 3 || !parts[0]) return null;
  const width = Number(parts[1]);
  const depth = Number(parts[2]);
  if (!(width > 0) || !(depth > 0) || !Number.isFinite(width) || !Number.isFinite(depth)) return null;
  return { name: parts[0], width, depth, prefix: parts[3] ?? '' };
}
