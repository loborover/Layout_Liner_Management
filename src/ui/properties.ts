/**
 * @file properties.ts
 *
 * Property panel for the current selection. Shows what an object is and lets edit mode change it:
 * name, layer, monitoring binding (all objects); border ("테두리": weight, colour, opacity, stripe pattern with a live
 * swatch and the three templates) for lines, circles and shapes' edges; face fill (colour or image) and face-only
 * opacity, area (shapes); radius (circles); the underlay image when it is selected; coincide/detach for points; tag, rotation and preset properties with design checks (equipment and structures).
 * Every object also lists the X, Y, Z of its points (Z = height above the floor) and its 3D height; a selected
 * point (vertex) gets its own X, Y, Z fields. With nothing selected it shows the active floor. In viewer mode the same fields are read-only and live values
 * from the monitoring data source are added. Every change is one undoable UpdateEntities/SetEquipmentTypes command.
 */
import { SetUnderlay, UpdateEntities } from '../model/commands';
import { editEntities } from '../model/edit';
import { type DocumentModel, cloneEntity, midpointId } from '../model/document';
import { BORDER_TEMPLATES, TEMPLATE_WIDTH, applyTemplate, borderOpacity, cloneStroke, matchTemplate, patternPeriod, stripePieces } from '../model/borders';
import { UNDERLAY_ID } from '../model/selection';
import { defaultHeight } from '../model/heights';
import { CATEGORY_LABELS, PROP_DEFS, type PropDef, categoryOf, presetInfo, propValue } from '../model/presets';
import { polygonPerimeter } from '../geom/polygon';
import { hasHeight } from '../model/heights';
import { ANCHOR_LABELS, MAX_LABEL_ITEMS, MAX_LABEL_TEXT, labelOpacity, labelSize, labelVisible } from '../model/labels';
import type { CircleEntity, Entity, Id, LabelAnchor, LabelEntity, LabelItem, LineEntity, PropValue, ShapeEntity, ShapeLabel, StrokeJoin, StrokeStyle, Underlay } from '../model/types';
import { formatArea, formatLength } from '../view/format';
import type { UiHost } from './host';
import { recordSet } from './recordPanel';
import { CANVAS, LAYER_DEFAULT, MARKING, SHAPE_FILL } from '../theme';

const ALIGN_LABELS = { inside: '내측', center: '중심', outside: '외측' } as const;
const JOIN_LABELS = { miter: '뾰족 (Miter)', round: '라운드 (Round)', bevel: '모따기 (Chamfer)' } as const;

/**
 * A layer as a choice in a list: its folder path within the floor ("작업구역 / 협력사 / A사"), so layers with the same
 * name in different folders can be told apart (names may repeat; the option's value is the layer id).
 */
function layerOption(doc: DocumentModel, id: Id): string {
  return doc.treePath(id).split(' / ').slice(1).join(' / ');
}

export class PropertyPanel {
  private timer: number | undefined;

  constructor(
    private readonly host: UiHost,
    private readonly root: HTMLElement,
  ) {}

  /** Set when a rebuild was put off because the user was typing in a field; done when the focus leaves the panel's fields. */
  private stale = false;

  refresh(): void {
    if (this.timer !== undefined) return;
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      // Don't rebuild under the user's cursor while they type in a field; catch up once they leave it.
      if (this.typingIn(document.activeElement)) {
        this.stale = true;
        return;
      }
      this.render();
    }, 120);
  }

  private typingIn(el: Element | null): boolean {
    return !!el && this.root.contains(el) && el instanceof HTMLInputElement && el.type !== 'checkbox';
  }

  /** Call once: rebuilds a panel left stale by a put-off refresh when the focus leaves its text fields. */
  bind(): void {
    this.root.addEventListener('focusout', (e) => {
      // 'change' fires before 'focusout', so the edit just committed is already in the document.
      if (this.stale && !this.typingIn(e.relatedTarget as Element | null)) this.refresh();
    });
  }

  render(): void {
    this.stale = false;
    const { doc, selection } = this.host;
    const items = selection.values().flatMap((id) => {
      const e = doc.entities.get(id);
      return e ? [e] : [];
    });
    const points = selection.values().filter((id) => doc.isVertex(id));
    const sets: HTMLElement[] = [];
    if (selection.has(UNDERLAY_ID) && doc.underlay) sets.push(this.underlaySet());
    if (items.length === 0 && points.length > 0) sets.push(this.pointSet(points));
    else if (items.length === 0 && sets.length > 0) {
      // Only the underlay is selected.
    }
    else if (items.length === 0) sets.push(this.floorInfo());
    else if (items.length === 1) sets.push(...this.single(items[0]));
    else sets.push(...this.multiple(items));
    if (items.length > 0) sets.push(recordSet(this.host, items, this.readOnly));
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

  /** Replaces entities with edited copies as one undo step (of the entities as they are now, see editEntities). */
  private update(label: string, items: Entity[], edit: (e: Entity) => void): void {
    const cmd = editEntities(this.host.doc, label, items.map((e) => e.id), edit);
    if (cmd) this.host.history.execute(cmd);
  }

  /** X, Y, Z inputs for one point (mm; Z above the floor level). */
  private xyz(id: Id): HTMLElement {
    const { doc } = this.host;
    const p = doc.vertex(id);
    const box = document.createElement('span');
    box.className = 'xyz';
    const field = (axis: 'x' | 'y' | 'z') => {
      const label = document.createElement('label');
      label.textContent = axis.toUpperCase();
      const value = axis === 'z' ? (p.z ?? 0) : p[axis];
      const input = this.input('number', String(Math.round(value * 100) / 100), (v) => {
        const n = Number(v);
        if (v.trim() === '' || !Number.isFinite(n)) return this.host.notify('좌표는 숫자로 입력하십시오.');
        const cur = doc.vertex(id);
        this.host.setPoint(id, { x: cur.x, y: cur.y, z: cur.z ?? 0, [axis]: n });
      });
      input.step = 'any';
      input.title = `${axis.toUpperCase()} (mm${axis === 'z' ? ', 층 바닥 기준 높이' : ''})`;
      label.append(input);
      return label;
    };
    box.append(field('x'), field('y'), field('z'));
    return box;
  }

  /** Coordinates of an entity's points: what each point is, then X, Y, Z. */
  private coordinates(e: Entity): HTMLElement {
    const { doc } = this.host;
    const f = this.fieldset('좌표 (mm)');
    const named: [string, Id][] =
      e.kind === 'line'
        ? [
            ['시작점', e.p1],
            ['중간점', midpointId(e.id)],
            ['끝점', e.p2],
          ]
        : e.kind === 'dimension'
        ? [
            ['시작점', e.p1],
            ['끝점', e.p2],
          ]
        : e.kind === 'circle'
          ? [['중심', e.center]]
          : e.kind === 'equipment' || e.kind === 'point' || e.kind === 'label'
            ? [['위치', e.at]]
            : e.points.map((id, i) => [`꼭짓점 ${i + 1}`, id] as [string, Id]);
    const MAX = 12;
    for (const [label, id] of named.slice(0, MAX)) this.row(f, label, this.xyz(id));
    if (named.length > MAX) this.row(f, '', `외 ${named.length - MAX}개 (꼭짓점을 클릭해 편집)`);
    if (hasHeight(e)) {
      const h = this.input('number', e.height !== undefined ? String(e.height) : '', (v) =>
        this.update('높이 변경', [e], (c) => {
          if (!hasHeight(c)) return;
          const n = Number(v);
          if (v.trim() === '') delete c.height;
          else if (Number.isFinite(n) && n >= 0) c.height = n;
        }),
      );
      h.placeholder = `${defaultHeight(doc, e)} (기본값)`;
      h.min = '0';
      h.title = '3D 보기에서 바닥(점의 Z)부터 올라가는 높이. 비우면 기본값';
      this.row(f, '높이', h);
    }
    return f;
  }

  /** A selected point (or several): its coordinates and what is built on it. */
  private pointSet(ids: Id[]): HTMLElement {
    const { doc } = this.host;
    const f = this.fieldset(ids.length > 1 ? `점 ${ids.length}개` : doc.midpointLine(ids[0]) ? '선의 중간점' : '점');
    for (const id of ids.slice(0, 12)) {
      this.row(f, ids.length === 1 ? '좌표' : id, this.xyz(id));
    }
    const users = [...new Set(ids.flatMap((id) => doc.pointUsers(id)))];
    const names = users.slice(0, 6).map((e) => e.name ?? this.kindLabel(e));
    this.row(f, '연결', users.length ? `${names.join(', ')}${users.length > 6 ? ` 외 ${users.length - 6}개` : ''}` : '없음');
    const partners = new Set(ids.filter((id) => doc.points.has(id)).flatMap((id) => doc.coincidentWith(id)));
    if (partners.size > 0) this.row(f, '일치 구속', `다른 객체의 점 ${partners.size}개와 일치`);
    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(
      this.button('일치', '선택한 점들을 한 위치에 붙입니다(일치 구속, 객체는 따로 유지). Shift+클릭으로 점을 두 개 이상 고르십시오', () => this.host.runAction('coincide')),
      this.button('분리', '이 점을 공유하거나 일치 구속된 객체들을 서로 떼어 따로 움직이게 합니다', () => this.host.runAction('detach')),
    );
    f.append(actions);
    this.warning(f, '점을 옮기면 이 점을 쓰는 선·도형·치수와 일치 구속된 점이 함께 바뀝니다(선의 중간점은 선 전체를 옮깁니다). 따로 움직이려면 분리하십시오. Delete는 연결된 객체를 지웁니다.');
    return f;
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
    for (const l of doc.layers.values()) if (l.floor === doc.floorOf(e)) layers[l.id] = layerOption(doc, l.id);
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
    return { point: '점', line: '선', circle: '원', dimension: '치수', shape: '도형', label: '라벨' }[e.kind];
  }

  private single(e: Entity): HTMLElement[] {
    const { doc } = this.host;
    const unit = this.host.unit();
    const sets = [this.common(e)];
    const f = sets[0];
    if (e.kind === 'line') {
      const a = doc.point(e.p1);
      const b = doc.point(e.p2);
      this.row(f, '길이', formatLength(Math.hypot(b.x - a.x, b.y - a.y), unit));
      const shapes = doc.shapesUsing([e.id]);
      if (shapes.length) this.row(f, '소속 도형', shapes.map((s) => s.name ?? '도형').join(', '));
      sets.push(this.strokeSet([e]));
    } else if (e.kind === 'shape') {
      const poly = doc.shapePolygon(e);
      this.row(f, '면적', formatArea(doc.shapeArea(e)));
      this.row(f, '둘레', formatLength(polygonPerimeter(poly), unit));
      this.row(f, '꼭짓점', `${e.points.length}개`);
      sets.push(this.faceSet(e));
      const lines = e.edges.flatMap((id) => {
        const l = doc.entities.get(id);
        return l?.kind === 'line' ? [l] : [];
      });
      sets.push(this.strokeSet(lines, '테두리 (Border, 변 전체)'));
      // Fillet and chamfer are operations, not properties: they live in the ribbon's 모서리·꼭짓점 group only.
      sets.push(this.labelSet(e));
    } else if (e.kind === 'circle') {
      const constrained = doc.constraintsOn([e.id]).length > 0;
      const r = this.input('number', String(Math.round(e.radius * 100) / 100), (v) => {
        const n = Number(v);
        if (!(n > 0)) return this.host.notify('반지름은 0보다 커야 합니다.');
        this.update('반지름 변경', [e], (x) => x.kind === 'circle' && (x.radius = n));
      });
      r.disabled ||= constrained;
      if (constrained) r.title = '구속된 원은 원을 더블클릭해 반지름을 지정하십시오.';
      this.row(f, '반지름 (mm)', r);
      sets.push(this.strokeSet([e]));
    } else if (e.kind === 'dimension') {
      const a = doc.point(e.p1);
      const b = doc.point(e.p2);
      this.row(f, '측정값', formatLength(Math.hypot(b.x - a.x, b.y - a.y), unit));
      this.row(f, '종류', e.value !== undefined ? `구동 (${e.value} mm)` : '참조');
    } else if (e.kind === 'equipment') {
      sets.push(...this.equipmentSets(e));
    } else if (e.kind === 'label') {
      sets.push(this.labelSet(e));
    }
    sets.splice(1, 0, this.coordinates(e));
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
      for (const def of defs) {
        if (def.when && propValue(doc, e, def.when.key) !== def.when.value) continue;
        this.row(p, def.label + (def.unit ? ` (${def.unit})` : ''), this.propInput(e, def));
      }
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

  /**
   * Border editor ("테두리": Weight, Color, 투명도, Pattern) for lines and circles (a shape passes its edges).
   * Typing or picking a colour changes the drawing at once (one undo step when the field is committed); the swatch
   * shows the pattern as it will look. Templates set colour and pattern in one go.
   */
  private strokeSet(items: (LineEntity | CircleEntity)[], title = '테두리 (Border)'): HTMLElement {
    const { doc } = this.host;
    const f = this.fieldset(title);
    const first = items[0]?.stroke;
    const same = items.every((l) => JSON.stringify(l.stroke) === JSON.stringify(first));
    const layerColor = doc.layers.get(items[0]?.layer ?? '')?.color ?? LAYER_DEFAULT;
    const current: StrokeStyle = same && first ? cloneStroke(first) : { width: 0, align: 'center' };
    /** Style being edited; inputs change it, then it is applied live and committed. */
    const draft: StrokeStyle = cloneStroke(current);
    let before: Entity[] | null = null;
    const live = () => {
      before ??= items.map((e) => cloneEntity(doc.entities.get(e.id) ?? e));
      for (const e of items) {
        const target = doc.entities.get(e.id);
        if (target?.kind === 'line' || target?.kind === 'circle') target.stroke = cloneStroke(draft);
      }
      doc.changed();
      preview();
    };
    const commit = () => {
      if (!before) live();
      const after = items.map((e) => cloneEntity(doc.entities.get(e.id) ?? e));
      this.host.history.record(new UpdateEntities('테두리', before!, after));
      before = null;
      this.render();
    };
    /** A field that edits the draft live while typing and commits when done. */
    const field = (type: string, value: string, set: (v: string) => boolean | void): HTMLInputElement => {
      const i = document.createElement('input');
      i.type = type;
      i.value = value;
      i.disabled = this.readOnly;
      i.addEventListener('input', () => set(i.value) !== false && live());
      i.addEventListener('change', () => set(i.value) !== false && commit());
      if (type !== 'color') i.addEventListener('keydown', (e) => e.key === 'Enter' && i.blur());
      return i;
    };

    const templates: Record<string, string> = { '': '직접 지정' };
    for (const t of BORDER_TEMPLATES) templates[t.id] = `${t.name} (${t.description})`;
    const tpl = this.select(templates, matchTemplate(same ? first : undefined)?.id ?? '', (v) => {
      const t = BORDER_TEMPLATES.find((x) => x.id === v);
      if (t) this.update('테두리 템플릿', items, (c) => (c.kind === 'line' || c.kind === 'circle') && (c.stroke = applyTemplate(c.stroke, t)));
    });
    tpl.title = '구역색·설비구역색·안전구역색: 색과 줄무늬를 한 번에 적용합니다. 두께가 0이면 100 mm로 바꿉니다.';
    this.row(f, '템플릿', tpl);
    this.row(f, '위치', this.select(ALIGN_LABELS, current.align, (v) => {
      draft.align = v as StrokeStyle['align'];
      commit();
    }));
    const join = this.select(JOIN_LABELS, current.join ?? 'miter', (v) => {
      if (v === 'miter') delete draft.join;
      else draft.join = v as StrokeJoin;
      commit();
    });
    join.title = '다른 테두리와 만나는 모서리의 바깥쪽 처리. 안쪽은 항상 정확히 만나며, 내측 테두리는 그린 선 밖으로 나가지 않습니다';
    this.row(f, '모서리', join);
    const width = field('number', same ? String(current.width) : '', (v) => {
      const n = Number(v);
      if (v.trim() === '' || !(n >= 0)) return false;
      draft.width = n;
    });
    width.min = '0';
    width.title = '두께 Weight (mm). 0이면 가는 선';
    this.row(f, '두께 (mm)', width);
    this.row(f, '색', field('color', current.color ?? layerColor, (v) => void (draft.color = v)));
    const opacity = field('number', String(Math.round((1 - borderOpacity(current)) * 100)), (v) => {
      const n = Number(v);
      if (v.trim() === '' || !(n >= 0 && n <= 100)) return false;
      draft.opacity = 1 - n / 100;
    });
    opacity.min = '0';
    opacity.max = '100';
    opacity.step = '5';
    opacity.title = '테두리 투명도 (%): 0 불투명, 100 완전 투명';
    this.row(f, '투명도 (%)', opacity);

    // Pattern
    const toggle = this.input('checkbox', '', () => {
      if (toggle.checked) {
        const base = draft.color ?? layerColor;
        draft.pattern = { stripes: [{ color: base, size: 1 }, { color: base === MARKING.black ? MARKING.yellow : MARKING.black, size: 1 }], unit: 50, angle: 45 };
        if (!(draft.width > 0)) draft.width = TEMPLATE_WIDTH;
      } else delete draft.pattern;
      commit();
    });
    toggle.checked = !!current.pattern;
    toggle.title = '줄무늬 패턴으로 테두리 띠를 채웁니다';
    this.row(f, '패턴', toggle);
    const canvas = document.createElement('canvas');
    canvas.className = 'pattern-preview';
    canvas.width = 220;
    canvas.height = 36;
    const preview = () => drawBorderPreview(canvas, draft, layerColor);
    if (current.pattern) {
      const p = draft.pattern!;
      const count = field('number', String(p.stripes.length), (v) => {
        const n = Math.round(Number(v));
        if (!(n >= 1 && n <= 16)) return false;
        const old = p.stripes;
        p.stripes = Array.from({ length: n }, (_, i) => old[i] ?? { ...old[i % old.length] });
      });
      count.min = '1';
      count.max = '16';
      count.title = '한 번 반복되는 줄무늬의 개수 (1~16)';
      count.addEventListener('change', () => this.render());
      this.row(f, '줄무늬 수', count);
      const angle = field('number', String(p.angle), (v) => {
        const n = Number(v);
        if (v.trim() === '' || !Number.isFinite(n)) return false;
        p.angle = n;
      });
      angle.step = '15';
      angle.title = '줄무늬 기울기 (°): 선 방향 기준, 0은 선과 나란히, 90은 선을 가로질러';
      this.row(f, '기울기 (°)', angle);
      const unit = field('number', String(p.unit), (v) => {
        const n = Number(v);
        if (!(n > 0)) return false;
        p.unit = n;
      });
      unit.min = '0';
      unit.title = '크기 1인 줄무늬의 실제 폭 (mm). 줄무늬 폭 = 크기 × 단위 길이';
      this.row(f, '단위 길이 (mm)', unit);
      p.stripes.forEach((st, i) => {
        const box = document.createElement('span');
        box.className = 'row stripe';
        const color = field('color', st.color, (v) => void (st.color = v));
        const size = field('number', String(st.size), (v) => {
          const n = Number(v);
          if (!(n > 0 && n <= 1000)) return false;
          st.size = n;
        });
        size.min = '0';
        size.step = 'any';
        size.title = `상대 크기: 폭 ${formatLength(st.size * p.unit, 'mm')}`;
        const mm = document.createElement('span');
        mm.className = 'muted';
        mm.textContent = `= ${formatLength(st.size * p.unit, 'mm')}`;
        box.append(color, size, mm);
        if (p.stripes.length > 1) {
          box.append(
            this.button('×', '이 줄무늬 삭제', () => {
              p.stripes.splice(i, 1);
              commit();
            }),
          );
        }
        this.row(f, `줄무늬 ${i + 1}`, box);
      });
    }
    this.row(f, '미리보기', canvas);
    preview();
    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(this.button('테두리 지우기', '가는 선(레이어 색)으로 되돌립니다', () => this.update('테두리 지우기', items, (c) => (c.kind === 'line' || c.kind === 'circle') && delete c.stroke)));
    f.append(actions);
    if (!same) this.warning(f, '객체마다 테두리가 다릅니다. 바꾸면 모두 같은 값이 됩니다.');
    if (current.pattern && !(current.width > 0)) this.warning(f, '두께가 0이면 패턴이 보이지 않습니다. 두께를 지정하십시오.');
    return f;
  }

  /**
   * Label editor for a shape's label or a label object: shown or hidden, opacity, placement ("배치 기준": centre,
   * top, bottom, left, right) and the "제목: 내용" rows; a shape also chooses whether its name and area show and
   * shifts its label by X/Y mm, a label object sets its text height and colour.
   */
  private labelSet(e: ShapeEntity | LabelEntity): HTMLElement {
    const f = this.fieldset(e.kind === 'shape' ? '라벨 (도형)' : '라벨 내용');
    const look = e.kind === 'shape' ? (e.label ?? {}) : e;
    const set = (label: string, edit: (l: ShapeLabel | LabelEntity) => void) =>
      this.update(label, [e], (c) => {
        if (c.kind === 'shape') {
          const l: ShapeLabel = c.label ?? {};
          edit(l);
          if (Object.keys(l).length > 0) c.label = l;
          else delete c.label;
        } else if (c.kind === 'label') edit(c);
      });
    const visible = this.input('checkbox', '', () => set(visible.checked ? '라벨 표시' : '라벨 숨기기', (l) => (visible.checked ? delete l.visible : (l.visible = false))));
    visible.checked = labelVisible(look);
    visible.title = '끄면 라벨을 그리지 않습니다 (인쇄·SVG·DXF에도 빠집니다)';
    this.row(f, '표시', visible);
    const opacity = this.input('number', String(Math.round((1 - labelOpacity(look)) * 100)), (v) => {
      const n = Number(v);
      if (v.trim() === '' || !(n >= 0 && n <= 100)) return this.host.notify('투명도는 0~100(%)입니다.');
      set('라벨 투명도', (l) => (n === 0 ? delete l.opacity : (l.opacity = 1 - n / 100)));
    });
    opacity.min = '0';
    opacity.max = '100';
    opacity.step = '10';
    opacity.title = '라벨 글자의 투명도 (%): 0 불투명, 100 완전 투명';
    this.row(f, '투명도 (%)', opacity);
    const anchor = this.select(ANCHOR_LABELS, look.anchor ?? 'center', (v) => set('라벨 배치', (l) => (v === 'center' ? delete l.anchor : (l.anchor = v as LabelAnchor))));
    anchor.title =
      e.kind === 'shape' ? '라벨을 놓을 곳: 중심(면적 중심), 상단·하단·좌측·우측(도형의 그쪽 가장자리 안쪽)' : '글 상자의 어느 쪽이 점에 오는지: 상단이면 점 아래로, 좌측이면 점 오른쪽으로 씁니다';
    this.row(f, '배치 기준', anchor);
    if (e.kind === 'shape') {
      const sl = e.label ?? {};
      const flag = (key: 'showName' | 'showArea', text: string) => {
        const box = this.input('checkbox', '', () =>
          set(text, (l) => {
            const sl2 = l as ShapeLabel;
            if (box.checked) delete sl2[key];
            else sl2[key] = false;
          }),
        );
        box.checked = sl[key] !== false;
        return box;
      };
      this.row(f, '이름 표시', flag('showName', '라벨 이름 표시'));
      this.row(f, '면적 표시', flag('showArea', '라벨 면적 표시'));
      for (const [key, text] of [
        ['dx', 'X 이동 (mm)'],
        ['dy', 'Y 이동 (mm)'],
      ] as const) {
        const i = this.input('number', String(sl[key] ?? 0), (v) => {
          const n = Number(v);
          if (!Number.isFinite(n)) return this.host.notify('숫자를 입력하십시오.');
          set('라벨 위치', (l) => (n === 0 ? delete (l as ShapeLabel)[key] : ((l as ShapeLabel)[key] = n)));
        });
        i.step = '100';
        i.title = '배치 기준에서 옮길 거리 (mm). X는 오른쪽, Y는 위쪽이 +';
        this.row(f, text, i);
      }
    } else {
      const size = this.input('number', String(labelSize(e)), (v) => {
        const n = Number(v);
        if (!(n > 0)) return this.host.notify('글자 높이는 0보다 커야 합니다.');
        set('글자 높이', (l) => ((l as LabelEntity).size = n));
      });
      size.min = '1';
      size.step = '50';
      size.title = '글자 높이 (mm, 도면 크기): 확대·축소하면 함께 커지고 작아집니다';
      this.row(f, '글자 높이 (mm)', size);
      const layerColor = this.host.doc.layers.get(e.layer)?.color ?? LAYER_DEFAULT;
      this.row(f, '색', this.input('color', e.color ?? layerColor, (v) => set('라벨 색', (l) => ((l as LabelEntity).color = v))));
    }
    // "제목: 내용" rows.
    const items = (e.kind === 'shape' ? e.label?.items : e.items) ?? [];
    const setItems = (label: string, edit: (list: LabelItem[]) => void) =>
      set(label, (l) => {
        const list = (l.items ?? []).map((it) => ({ ...it }));
        edit(list);
        if (list.length > 0 || 'kind' in l) l.items = list;
        else delete l.items;
      });
    items.forEach((it, i) => {
      const box = document.createElement('span');
      box.className = 'row label-item';
      // Rows are edited by position in the live list; a row that has gone (removed meanwhile) is left alone.
      const title = this.input('text', it.title, (v) => setItems('라벨 항목', (list) => list[i] && (list[i].title = v)));
      title.placeholder = '제목';
      title.maxLength = MAX_LABEL_TEXT;
      const value = this.input('text', it.value, (v) => setItems('라벨 항목', (list) => list[i] && (list[i].value = v)));
      value.placeholder = '내용';
      value.maxLength = MAX_LABEL_TEXT;
      box.append(title, value, this.button('×', '이 항목 삭제', () => setItems('라벨 항목 삭제', (list) => list[i] && list.splice(i, 1))));
      this.row(f, `항목 ${i + 1}`, box);
    });
    const actions = document.createElement('div');
    actions.className = 'actions';
    const add = this.button('+ 항목 추가', '"제목: 내용" 한 줄을 추가합니다', () => setItems('라벨 항목 추가', (list) => list.push({ title: '', value: '' })));
    add.disabled = items.length >= MAX_LABEL_ITEMS;
    actions.append(add);
    f.append(actions);
    return f;
  }

  /** Face of a shape: none, a colour or an image, and the face's own opacity (the border keeps its own). */
  private faceSet(e: ShapeEntity): HTMLElement {
    const { doc } = this.host;
    const f = this.fieldset('면 (채우기)');
    const kind = e.fillImage ? 'image' : e.fill ? 'color' : 'none';
    const set = (label: string, edit: (c: ShapeEntity) => void) => this.update(label, [e], (c) => c.kind === 'shape' && edit(c));
    this.row(
      f,
      '채우기',
      this.select({ none: '없음 (레이어 색, 옅게)', color: '단색', image: '이미지' }, kind, (v) => {
        if (v === 'none') set('면 채우기', (c) => (delete c.fill, delete c.fillImage));
        else if (v === 'color') set('면 채우기', (c) => (delete c.fillImage, (c.fill ??= doc.layers.get(e.layer)?.color ?? SHAPE_FILL)));
        else this.pickImage((src) => set('면 이미지', (c) => (c.fillImage = { src, fit: 'stretch' })));
      }),
    );
    if (kind === 'color') this.row(f, '색', this.input('color', e.fill ?? SHAPE_FILL, (v) => set('채우기 색', (c) => (c.fill = v))));
    if (e.fillImage) {
      const img = e.fillImage;
      const box = document.createElement('span');
      box.className = 'row';
      box.append(this.button('바꾸기…', '다른 이미지를 고릅니다', () => this.pickImage((src) => set('면 이미지', (c) => c.fillImage && (c.fillImage.src = src)))));
      this.row(f, '이미지', box);
      this.row(f, '맞춤', this.select({ stretch: '늘이기 (도형에 맞춤)', tile: '바둑판 (반복)' }, img.fit, (v) => set('이미지 맞춤', (c) => c.fillImage && (c.fillImage.fit = v as 'stretch' | 'tile'))));
      if (img.fit === 'tile') {
        const size = this.input('number', String(img.size ?? 1000), (v) => {
          const n = Number(v);
          if (!(n > 0)) return this.host.notify('타일 너비는 0보다 커야 합니다.');
          set('타일 크기', (c) => c.fillImage && (c.fillImage.size = n));
        });
        size.title = '반복되는 이미지 한 장의 실제 너비 (mm)';
        this.row(f, '타일 너비 (mm)', size);
      }
    }
    const defaultOpacity = e.fill || e.fillImage ? 0.35 : 0.06;
    const opacity = this.input('number', e.fillOpacity !== undefined ? String(Math.round((1 - e.fillOpacity) * 100)) : '', (v) => {
      if (v.trim() === '') return set('면 투명도', (c) => delete c.fillOpacity);
      const n = Number(v);
      if (!(n >= 0 && n <= 100)) return this.host.notify('투명도는 0~100(%)입니다.');
      set('면 투명도', (c) => (c.fillOpacity = 1 - n / 100));
    });
    opacity.min = '0';
    opacity.max = '100';
    opacity.step = '5';
    opacity.placeholder = `${Math.round((1 - defaultOpacity) * 100)} (기본값)`;
    opacity.title = '면만의 투명도 (%): 0 불투명, 100 완전 투명. 테두리에는 영향이 없습니다. 비우면 기본값';
    this.row(f, '면 투명도 (%)', opacity);
    return f;
  }

  /** Asks for an image file and hands back its data: URL (embedded, so the drawing stays self-contained). */
  private pickImage(done: (src: string) => void): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/gif,image/webp';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > 4 * 1024 * 1024) return this.host.notify('면 이미지는 4 MB 이하로 사용하십시오.');
      if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return this.host.notify('PNG, JPG, GIF, WebP 이미지를 사용하십시오.');
      const reader = new FileReader();
      reader.onload = () => done(String(reader.result));
      reader.onerror = () => this.host.notify('이미지를 읽을 수 없습니다.');
      reader.readAsDataURL(file);
    });
    input.click();
  }

  /** The underlay image, selected on the canvas like an object: position, size, opacity, lock. */
  private underlaySet(): HTMLElement {
    const { doc } = this.host;
    const u = doc.underlay!;
    const f = this.fieldset('밑그림 이미지');
    const set = (label: string, patch: Partial<Underlay>) => {
      const cur = doc.underlay;
      if (cur) this.host.history.execute(new SetUnderlay(label, cur, { ...cur, ...patch }));
    };
    const num = (value: number, onSet: (n: number) => void, positive = false) => {
      const i = this.input('number', String(Math.round(value * 100) / 100), (v) => {
        const n = Number(v);
        if (v.trim() === '' || !Number.isFinite(n) || (positive && !(n > 0))) return this.host.notify(positive ? '0보다 큰 숫자를 입력하십시오.' : '숫자를 입력하십시오.');
        onSet(n);
      });
      i.step = 'any';
      return i;
    };
    this.row(f, 'X (왼쪽 아래, mm)', num(u.x, (n) => set('밑그림 이동', { x: n })));
    this.row(f, 'Y (왼쪽 아래, mm)', num(u.y, (n) => set('밑그림 이동', { y: n })));
    // Width and height keep the image's proportions.
    this.row(f, '너비 (mm)', num(u.width, (n) => set('밑그림 크기', { width: n, height: (u.height * n) / u.width }), true));
    this.row(f, '높이 (mm)', num(u.height, (n) => set('밑그림 크기', { height: n, width: (u.width * n) / u.height }), true));
    const opacity = num(Math.round((1 - u.opacity) * 100), (n) => set('밑그림 투명도', { opacity: Math.min(1, Math.max(0.05, 1 - n / 100)) }));
    opacity.min = '0';
    opacity.max = '95';
    this.row(f, '투명도 (%)', opacity);
    const lock = this.input('checkbox', '', () => set(lock.checked ? '밑그림 잠금' : '밑그림 잠금 해제', { locked: lock.checked }));
    lock.checked = !!u.locked;
    lock.title = '잠그면 도면에서 클릭해도 선택·이동되지 않습니다 (따라 그릴 때 편리)';
    this.row(f, '잠금', lock);
    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(
      this.button('축척 맞추기', '두 점과 실제 거리로 축척을 맞춥니다', () => this.host.runAction('underlay-calibrate')),
      this.button('삭제', '밑그림 삭제', () => this.host.runAction('remove-underlay')),
    );
    f.append(actions);
    const hint = document.createElement('div');
    hint.className = 'warning muted';
    hint.textContent = '도형처럼 끌어서 옮기고, Delete로 지웁니다. 잠그면 선택되지 않습니다.';
    f.append(hint);
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
      for (const l of doc.layers.values()) if (floors.has(l.floor)) layers[l.id] = layerOption(doc, l.id);
      const shared = items.every((e) => e.layer === items[0].layer) ? items[0].layer : '';
      this.row(f, '레이어', this.select(layers, shared, (v) => v && this.update('레이어 변경', items, (c) => (c.layer = v))));
    }
    const sets: HTMLElement[] = [f];
    const lineIds = new Set<Id>();
    for (const e of items) {
      if (e.kind === 'line' || e.kind === 'circle') lineIds.add(e.id);
      if (e.kind === 'shape') for (const id of e.edges) lineIds.add(id);
    }
    const lines = [...lineIds].flatMap((id) => {
      const l = doc.entities.get(id);
      return l?.kind === 'line' || l?.kind === 'circle' ? [l] : [];
    });
    if (lines.length > 0) sets.push(this.strokeSet(lines, `테두리 (Border, ${lines.length}개)`));
    return sets;
  }
}

/**
 * Draws a border swatch: a band in the border's colour or stripes, at the border's opacity, about four pattern
 * repeats long, with the pattern angle measured from the band (as on a horizontal line).
 */
function drawBorderPreview(canvas: HTMLCanvasElement, s: StrokeStyle, layerColor: string): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = CANVAS.background;
  ctx.fillRect(0, 0, w, h);
  const bandH = 22;
  const top = (h - bandH) / 2;
  ctx.globalAlpha = borderOpacity(s);
  const p = s.pattern;
  if (!p || !(patternPeriod(p) > 0)) {
    ctx.fillStyle = s.color ?? layerColor;
    if (s.width > 0) ctx.fillRect(4, top, w - 8, bandH);
    else ctx.fillRect(4, h / 2 - 1, w - 8, 2);
  } else {
    // Preview units: k mm per pixel so that about four repeats fit.
    const k = (patternPeriod(p) * 4) / (w - 8);
    const region = [
      { x: 0, y: 0 },
      { x: (w - 8) * k, y: 0 },
      { x: (w - 8) * k, y: bandH * k },
      { x: 0, y: bandH * k },
    ];
    ctx.save();
    ctx.beginPath();
    ctx.rect(4, top, w - 8, bandH);
    ctx.clip();
    for (const piece of stripePieces(region, { x: 0, y: 0 }, (p.angle * Math.PI) / 180, p) ?? []) {
      ctx.beginPath();
      piece.quad.forEach((q, i) => (i === 0 ? ctx.moveTo(4 + q.x / k, top + bandH - q.y / k) : ctx.lineTo(4 + q.x / k, top + bandH - q.y / k)));
      ctx.closePath();
      ctx.fillStyle = piece.color;
      ctx.fill();
    }
    ctx.restore();
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = CANVAS.axis;
  ctx.strokeRect(4.5, top + 0.5, w - 9, bandH);
}
