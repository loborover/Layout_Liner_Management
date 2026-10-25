/**
 * @file library.ts
 *
 * Library section of the side bar: equipment types and structural presets (column, stair, ramp, lift).
 * Also exports `parseType`, the parser of the "name, width, depth, prefix" prompt.
 */
import { SetEquipmentTypes } from '../model/commands';
import { newId } from '../model/ids';
import { CATEGORY_LABELS, categoryOf } from '../model/presets';
import type { EquipmentType, Id, StructureCategory } from '../model/types';
import type { UiHost } from './host';
import { icon } from './icons';

const ORDER: StructureCategory[] = ['column', 'stair', 'ramp', 'lift', 'equipment'];

/**
 * Library of equipment and structural presets, grouped by category. Click places an instance, double-click
 * edits name and size, × deletes an unused item. Rebuilt only when what it shows changes.
 */
export class Library {
  private shown = '';

  constructor(
    private readonly host: UiHost,
    private readonly typesEl: HTMLElement,
  ) {}

  refresh(): void {
    const { doc } = this.host;
    const counts = this.typeCounts();
    const key = JSON.stringify([[...doc.equipmentTypes.values()], [...counts], this.host.activeType(), this.host.mode()]);
    if (key === this.shown) return;
    this.shown = key;
    this.renderTypes(counts);
  }

  addType(): void {
    const t = this.askType('새 설비 종류: 이름, 폭(mm), 깊이(mm), 번호 접두어', '설비, 2000, 1000, EQ');
    if (!t) return;
    const type: EquipmentType = { id: newId('eq'), ...t };
    this.setTypes('설비 종류 추가', [...this.types(), type]);
  }

  private types(): EquipmentType[] {
    return [...this.host.doc.equipmentTypes.values()].map((t) => structuredClone(t));
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

  private renderTypes(counts: Map<Id, number>): void {
    const active = this.host.activeType();
    const editable = this.host.mode() === 'edit';
    const rows: HTMLElement[] = [];
    for (const cat of ORDER) {
      const types = [...this.host.doc.equipmentTypes.values()].filter((t) => categoryOf(t) === cat);
      if (types.length === 0) continue;
      const head = document.createElement('li');
      head.className = 'lib-head';
      head.textContent = cat === 'equipment' ? '설비' : `구조: ${CATEGORY_LABELS[cat]}`;
      rows.push(head);
      for (const type of types) {
        const row = document.createElement('li');
        row.className = 'row';
        const place = document.createElement('button');
        place.className = 'type';
        place.disabled = !editable;
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
        place.append(icon(cat === 'equipment' ? 'equipment' : cat), name, size, count);
        place.addEventListener('click', () => this.host.placeEquipment(type.id));
        place.addEventListener('dblclick', () => this.editType(type));

        const remove = document.createElement('button');
        remove.textContent = '×';
        remove.className = 'edit-only';
        remove.title = '종류 삭제 (배치되지 않은 것만)';
        remove.addEventListener('click', () => {
          if ((counts.get(type.id) ?? 0) > 0) return this.host.notify('배치된 객체가 있는 종류는 삭제할 수 없습니다.');
          this.setTypes('설비 종류 삭제', this.types().filter((t) => t.id !== type.id));
        });
        row.append(place, remove);
        rows.push(row);
      }
    }
    this.typesEl.replaceChildren(...rows);
  }

  private editType(type: EquipmentType): void {
    const t = this.askType('종류 수정: 이름, 폭(mm), 깊이(mm), 번호 접두어', `${type.name}, ${type.width}, ${type.depth}, ${type.prefix}`);
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
