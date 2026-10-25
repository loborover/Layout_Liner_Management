/**
 * @file properties.ts
 *
 * Property panel for the current selection. Shows what an object is and lets edit mode change it:
 * name, layer, monitoring binding (all objects); line style (lines and shapes' edges); fill and area (shapes);
 * radius (circles); tag, rotation and preset properties with design checks (equipment and structures).
 * With nothing selected it shows the active floor. In viewer mode the same fields are read-only and live values
 * from the monitoring data source are added. Every change is one undoable UpdateEntities/SetEquipmentTypes command.
 */
import { UpdateEntities } from '../model/commands';
import { cloneEntity } from '../model/document';
import { CATEGORY_LABELS, PROP_DEFS, type PropDef, categoryOf, presetInfo, propValue } from '../model/presets';
import { polygonPerimeter } from '../geom/polygon';
import type { Entity, Id, LineEntity, PropValue, StrokeStyle } from '../model/types';
import { formatArea, formatLength } from '../view/format';
import type { UiHost } from './host';
import { LAYER_DEFAULT, SHAPE_FILL } from '../theme';

const ALIGN_LABELS = { inside: '내측', center: '중심', outside: '외측' } as const;

export class PropertyPanel {
  private timer: number | undefined;

  constructor(
    private readonly host: UiHost,
    private readonly root: HTMLElement,
  ) {}

  refresh(): void {
    if (this.timer !== undefined) return;
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      // Don't rebuild under the user's cursor while they type in a field.
      if (this.root.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement && document.activeElement.type !== 'checkbox') return;
      this.render();
    }, 120);
  }

  render(): void {
    const { doc, selection } = this.host;
    const items = selection.values().flatMap((id) => {
      const e = doc.entities.get(id);
      return e ? [e] : [];
    });
    const sets: HTMLElement[] = [];
    if (items.length === 0) sets.push(this.floorInfo());
    else if (items.length === 1) sets.push(...this.single(items[0]));
    else sets.push(...this.multiple(items));
    this.root.replaceChildren(...sets);
  }

  private get readOnly(): boolean {
    return this.host.mode() === 'view';
  }

  // ---- building blocks ----

  private fieldset(title: string): HTMLFieldSetElement {
    const f = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = title;
    f.append(legend);
    return f;
  }

  private row(f: HTMLElement, key: string, value: Node | string, cls = ''): void {
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = key;
    const v = document.createElement('span');
    v.className = `v ${cls}`;
    v.append(value);
    f.append(k, v);
  }

  private warning(f: HTMLElement, text: string): void {
    const w = document.createElement('div');
    w.className = 'warning';
    w.textContent = `⚠ ${text}`;
    f.append(w);
  }

  private input(type: string, value: string, onCommit: (v: string) => void): HTMLInputElement {
    const i = document.createElement('input');
    i.type = type;
    i.value = value;
    i.disabled = this.readOnly;
    i.addEventListener('change', () => onCommit(i.value));
    if (type !== 'color') i.addEventListener('keydown', (e) => e.key === 'Enter' && i.blur());
    return i;
  }

  private select(options: Record<string, string>, value: string, onChange: (v: string) => void): HTMLSelectElement {
    const s = document.createElement('select');
    for (const [k, label] of Object.entries(options)) s.append(new Option(label, k, false, k === value));
    s.disabled = this.readOnly;
    s.addEventListener('change', () => onChange(s.value));
    return s;
  }

  private button(text: string, title: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = text;
    b.title = title;
    b.className = 'edit-only';
    b.addEventListener('click', onClick);
    return b;
  }

  /** Replaces entities with edited copies as one undo step. */
  private update(label: string, items: Entity[], edit: (e: Entity) => void): void {
    const after = items.map((e) => {
      const c = cloneEntity(e);
      edit(c);
      return c;
    });
    this.host.history.execute(new UpdateEntities(label, items, after));
  }

  // ---- sections ----

  private floorInfo(): HTMLElement {
    const { doc } = this.host;
    const floor = doc.floors.get(doc.activeFloor);
    const f = this.fieldset('현재 층');
    if (floor) {
      this.row(f, '이름', floor.name);
      this.row(f, '바닥 높이', formatLength(floor.elevation, this.host.unit()));
      this.row(f, '층고', formatLength(floor.height, this.host.unit()));
      const layers = new Set([...doc.layers.values()].filter((l) => l.floor === floor.id).map((l) => l.id));
      const count = [...doc.entities.values()].filter((e) => layers.has(e.layer)).length;
      this.row(f, '객체 수', String(count));
    }
    const hint = document.createElement('div');
    hint.className = 'warning muted';
    hint.style.color = '';
    hint.textContent = '도면이나 객체 트리에서 객체를 선택하면 속성이 표시됩니다. 층 이름·높이는 트리에서 층을 더블클릭해 바꿉니다.';
    f.append(hint);
    return f;
  }

  private common(e: Entity): HTMLElement {
    const { doc } = this.host;
    const f = this.fieldset(this.kindLabel(e));
    this.row(f, '이름', this.input('text', e.name ?? '', (v) => this.update('이름 변경', [e], (c) => (v.trim() ? (c.name = v.trim()) : delete c.name))));
    const layers: Record<string, string> = {};
    for (const l of doc.layers.values()) if (l.floor === doc.floorOf(e)) layers[l.id] = l.name;
    this.row(f, '레이어', this.select(layers, e.layer, (v) => this.update('레이어 변경', [e], (c) => (c.layer = v))));
    const binding = this.input('text', e.binding ?? '', (v) => this.update('모니터링 키 변경', [e], (c) => (v.trim() ? (c.binding = v.trim()) : delete c.binding)));
    binding.placeholder = '예: line1.temp';
    binding.title = '모니터링 뷰어에서 이 객체에 연결할 서버 값의 키';
    this.row(f, '모니터링 키', binding);
    if (e.binding) {
      const live = this.host.live(e.binding);
      if (live) {
        const text = `${String(live.value)}${live.unit ? ` ${live.unit}` : ''}${live.status ? ` (${live.status})` : ''}`;
        this.row(f, '실시간 값', text, 'live');
      }
    }
    return f;
  }

  private kindLabel(e: Entity): string {
    if (e.kind === 'equipment') return CATEGORY_LABELS[categoryOf(this.host.doc.equipmentTypes.get(e.type))];
    return { line: '선', circle: '원', dimension: '치수', shape: '도형' }[e.kind];
  }

  private single(e: Entity): HTMLElement[] {
    const { doc } = this.host;
    const unit = this.host.unit();
    const sets = [this.common(e)];
    const f = sets[0];
    if (e.kind === 'line') {
      const a = doc.point(e.p1);
      const b = doc.point(e.p2);
      this.row(f, '시작점', `${formatLength(a.x, unit)}, ${formatLength(a.y, unit)}`);
      this.row(f, '끝점', `${formatLength(b.x, unit)}, ${formatLength(b.y, unit)}`);
      this.row(f, '길이', formatLength(Math.hypot(b.x - a.x, b.y - a.y), unit));
      const shapes = doc.shapesUsing([e.id]);
      if (shapes.length) this.row(f, '소속 도형', shapes.map((s) => s.name ?? '도형').join(', '));
      sets.push(this.strokeSet([e]));
    } else if (e.kind === 'shape') {
      const poly = doc.shapePolygon(e);
      this.row(f, '면적', formatArea(doc.shapeArea(e)));
      this.row(f, '둘레', formatLength(polygonPerimeter(poly), unit));
      this.row(f, '꼭짓점', `${e.points.length}개`);
      const fill = this.input('color', e.fill ?? doc.layers.get(e.layer)?.color ?? SHAPE_FILL, (v) => this.update('채우기 색', [e], (c) => c.kind === 'shape' && (c.fill = v)));
      const clear = this.button('없음', '채우기 색 지우기 (레이어 색으로 옅게)', () => this.update('채우기 색', [e], (c) => c.kind === 'shape' && delete c.fill));
      const box = document.createElement('span');
      box.className = 'row';
      box.append(fill, clear);
      this.row(f, '면 채우기', box);
      const lines = e.edges.flatMap((id) => {
        const l = doc.entities.get(id);
        return l?.kind === 'line' ? [l] : [];
      });
      sets.push(this.strokeSet(lines, '변 선 양식'));
    } else if (e.kind === 'circle') {
      const c = doc.point(e.center);
      this.row(f, '중심', `${formatLength(c.x, unit)}, ${formatLength(c.y, unit)}`);
      const constrained = doc.constraintsOn([e.id]).length > 0;
      const r = this.input('number', String(Math.round(e.radius * 100) / 100), (v) => {
        const n = Number(v);
        if (!(n > 0)) return this.host.notify('반지름은 0보다 커야 합니다.');
        this.update('반지름 변경', [e], (x) => x.kind === 'circle' && (x.radius = n));
      });
      r.disabled ||= constrained;
      if (constrained) r.title = '구속된 원은 원을 더블클릭해 반지름을 지정하십시오.';
      this.row(f, '반지름 (mm)', r);
    } else if (e.kind === 'dimension') {
      const a = doc.point(e.p1);
      const b = doc.point(e.p2);
      this.row(f, '측정값', formatLength(Math.hypot(b.x - a.x, b.y - a.y), unit));
      this.row(f, '종류', e.value !== undefined ? `구동 (${e.value} mm)` : '참조');
    } else if (e.kind === 'equipment') {
      sets.push(...this.equipmentSets(e));
    }
    return sets;
  }

  private equipmentSets(e: Extract<Entity, { kind: 'equipment' }>): HTMLElement[] {
    const { doc } = this.host;
    const type = doc.equipmentTypes.get(e.type);
    const f = this.fieldset(type ? `${type.name} (${type.width}×${type.depth})` : '종류 없음');
    this.row(f, '번호', this.input('text', e.tag, (v) => this.update('번호 변경', [e], (c) => c.kind === 'equipment' && (c.tag = v.trim()))));
    const rot = this.input('number', String(e.rotation), (v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return;
      this.update('회전', [e], (c) => c.kind === 'equipment' && (c.rotation = ((n % 360) + 360) % 360));
    });
    this.row(f, '회전 (°)', rot);
    const at = doc.point(e.at);
    this.row(f, '위치', `${formatLength(at.x, this.host.unit())}, ${formatLength(at.y, this.host.unit())}`);
    const sets: HTMLElement[] = [f];
    const defs = PROP_DEFS[categoryOf(type)];
    if (defs.length > 0) {
      const p = this.fieldset('특성 (이 객체)');
      for (const def of defs) this.row(p, def.label + (def.unit ? ` (${def.unit})` : ''), this.propInput(e, def));
      const reset = this.button('기본값으로', '이 객체의 특성을 종류 기본값으로 되돌립니다', () =>
        this.update('특성 초기화', [e], (c) => c.kind === 'equipment' && delete c.props),
      );
      const actions = document.createElement('div');
      actions.className = 'actions';
      actions.append(reset);
      p.append(actions);
      sets.push(p);
    }
    const info = presetInfo(doc, e);
    if (info.length > 0) {
      const i = this.fieldset('검토');
      for (const r of info) {
        this.row(i, r.label, r.value, r.warning ? 'warn' : '');
        if (r.warning) this.warning(i, r.warning);
      }
      sets.push(i);
    }
    return sets;
  }

  private propInput(e: Extract<Entity, { kind: 'equipment' }>, def: PropDef): HTMLElement {
    const { doc } = this.host;
    const value = propValue(doc, e, def.key);
    const set = (v: PropValue) => this.update(`${def.label} 변경`, [e], (c) => c.kind === 'equipment' && (c.props = { ...c.props, [def.key]: v }));
    switch (def.kind) {
      case 'number':
        return this.input('number', String(value), (v) => {
          const n = Number(v);
          if (!Number.isFinite(n) || n < (def.min ?? -Infinity)) return this.host.notify(`${def.label}: ${def.min ?? ''} 이상의 숫자를 입력하십시오.`);
          set(n);
        });
      case 'boolean': {
        const box = this.input('checkbox', '', () => set(box.checked));
        box.checked = value === true;
        return box;
      }
      case 'select':
        return this.select(def.options ?? {}, String(value), set);
      case 'floor': {
        const options: Record<string, string> = { '': '(없음)' };
        for (const fl of doc.floors.values()) if (fl.id !== doc.floorOf(e)) options[fl.id] = fl.name;
        return this.select(options, String(value), set);
      }
      case 'floors': {
        const chosen = new Set(String(value).split(',').map((s) => s.trim()).filter(Boolean));
        const wrap = document.createElement('span');
        wrap.className = 'row';
        wrap.style.flexWrap = 'wrap';
        for (const fl of doc.floors.values()) {
          const label = document.createElement('label');
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.checked = chosen.has(fl.id);
          box.disabled = this.readOnly;
          box.addEventListener('change', () => {
            if (box.checked) chosen.add(fl.id);
            else chosen.delete(fl.id);
            set([...doc.floors.keys()].filter((id) => chosen.has(id)).join(','));
          });
          label.append(box, fl.name);
          wrap.append(label);
        }
        return wrap;
      }
      default:
        return this.input('text', String(value), set);
    }
  }

  /** Line style editor for one or more lines (a shape passes its edges). */
  private strokeSet(lines: LineEntity[], title = '선 양식'): HTMLElement {
    const f = this.fieldset(title);
    const first = lines[0]?.stroke;
    const same = lines.every((l) => JSON.stringify(l.stroke) === JSON.stringify(first));
    const current: StrokeStyle = same && first ? first : { width: 0, align: 'center' };
    const apply = (patch: Partial<StrokeStyle>) =>
      this.update(
        '선 양식',
        lines,
        (c) => c.kind === 'line' && (c.stroke = { ...(c.stroke ?? { width: current.width, align: current.align }), ...patch }),
      );
    this.row(f, '위치', this.select(ALIGN_LABELS, current.align, (v) => apply({ align: v as StrokeStyle['align'] })));
    this.row(
      f,
      '두께 (mm)',
      this.input('number', same ? String(current.width) : '', (v) => {
        const n = Number(v);
        if (!(n >= 0)) return this.host.notify('두께는 0 이상이어야 합니다.');
        apply({ width: n });
      }),
    );
    const color = this.input('color', current.color ?? this.host.doc.layers.get(lines[0]?.layer ?? '')?.color ?? LAYER_DEFAULT, (v) => apply({ color: v }));
    this.row(f, '색', color);
    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(this.button('양식 지우기', '가는 선(레이어 색)으로 되돌립니다', () => this.update('선 양식 지우기', lines, (c) => c.kind === 'line' && delete c.stroke)));
    f.append(actions);
    if (!same) this.warning(f, '선마다 양식이 다릅니다. 바꾸면 모두 같은 값이 됩니다.');
    return f;
  }

  private multiple(items: Entity[]): HTMLElement[] {
    const { doc } = this.host;
    const f = this.fieldset(`${items.length}개 선택`);
    const counts = new Map<string, number>();
    for (const e of items) counts.set(this.kindLabel(e), (counts.get(this.kindLabel(e)) ?? 0) + 1);
    this.row(f, '구성', [...counts].map(([k, n]) => `${k} ${n}`).join(', '));
    const floors = new Set(items.map((e) => doc.floorOf(e)));
    if (floors.size === 1) {
      const layers: Record<string, string> = { '': '(여러 레이어)' };
      for (const l of doc.layers.values()) if (floors.has(l.floor)) layers[l.id] = l.name;
      const shared = items.every((e) => e.layer === items[0].layer) ? items[0].layer : '';
      this.row(f, '레이어', this.select(layers, shared, (v) => v && this.update('레이어 변경', items, (c) => (c.layer = v))));
    }
    const sets: HTMLElement[] = [f];
    const lineIds = new Set<Id>();
    for (const e of items) {
      if (e.kind === 'line') lineIds.add(e.id);
      if (e.kind === 'shape') for (const id of e.edges) lineIds.add(id);
    }
    const lines = [...lineIds].flatMap((id) => {
      const l = doc.entities.get(id);
      return l?.kind === 'line' ? [l] : [];
    });
    if (lines.length > 0) sets.push(this.strokeSet(lines, `선 양식 (선 ${lines.length}개)`));
    return sets;
  }
}
