/**
 * @file presets.ts
 *
 * Structural presets ("구조 프리셋"): columns, stairs, ramps and lifts, next to plain equipment.
 * Each category declares its editable properties (shown in the property panel, validated on load and through the
 * API) and derived information such as stair step counts or ramp slope, with design checks.
 *
 * The check thresholds are editable defaults, not legal advice. They follow commonly cited Korean rules
 * (ramps: slope 1/12 or gentler, width ≥ 1.2 m; stairs: riser ≤ 180 mm, tread ≥ 260 mm, a landing every
 * 3 m of rise) and must be confirmed against the current law text on https://www.law.go.kr before use.
 * Related: src/view/symbols.ts (how each category is drawn), src/ui/properties.ts.
 */
import type { DocumentModel } from './document';
import type { EquipmentEntity, EquipmentType, Id, PropValue, StructureCategory } from './types';

export interface PropDef {
  key: string;
  label: string;
  kind: 'number' | 'text' | 'select' | 'boolean' | 'floor' | 'floors';
  unit?: string;
  /** For 'select': value → label. */
  options?: Record<string, string>;
  default: PropValue;
  /** Smallest allowed number. */
  min?: number;
}

export const CATEGORY_LABELS: Record<StructureCategory, string> = {
  equipment: '설비',
  column: '기둥',
  stair: '계단',
  ramp: '경사로',
  lift: '리프트',
};

/** Property definitions per category. 'floor' holds a floor id, 'floors' a comma-separated list of floor ids. */
export const PROP_DEFS: Record<StructureCategory, PropDef[]> = {
  equipment: [],
  column: [
    { key: 'shape', label: '단면', kind: 'select', options: { rect: '사각형', round: '원형' }, default: 'rect' },
    { key: 'material', label: '재료', kind: 'select', options: { RC: '철근콘크리트', S: '철골', SRC: '철골철근콘크리트' }, default: 'RC' },
    { key: 'bearing', label: '내력 기둥', kind: 'boolean', default: true },
    { key: 'fireHours', label: '내화 시간', kind: 'number', unit: '시간', default: 3, min: 0 },
  ],
  stair: [
    { key: 'toFloor', label: '연결 층', kind: 'floor', default: '' },
    { key: 'direction', label: '방향', kind: 'select', options: { up: '오름 (앞→뒤)', down: '내림 (앞→뒤)' }, default: 'up' },
    { key: 'riser', label: '단높이', kind: 'number', unit: 'mm', default: 170, min: 1 },
    { key: 'tread', label: '단너비', kind: 'number', unit: 'mm', default: 280, min: 1 },
    { key: 'maxRiser', label: '검토: 최대 단높이', kind: 'number', unit: 'mm', default: 180, min: 1 },
    { key: 'minTread', label: '검토: 최소 단너비', kind: 'number', unit: 'mm', default: 260, min: 1 },
  ],
  ramp: [
    { key: 'toFloor', label: '연결 층', kind: 'floor', default: '' },
    { key: 'rise', label: '높이차 (0: 층 높이)', kind: 'number', unit: 'mm', default: 0, min: 0 },
    { key: 'maxSlope', label: '검토: 최대 기울기 1/', kind: 'number', default: 12, min: 1 },
    { key: 'minWidth', label: '검토: 최소 폭', kind: 'number', unit: 'mm', default: 1200, min: 0 },
  ],
  lift: [
    { key: 'liftKind', label: '종류', kind: 'select', options: { passenger: '승객용', freight: '화물용', car: '자동차용', dumbwaiter: '소형화물용' }, default: 'freight' },
    { key: 'capacity', label: '적재 하중', kind: 'number', unit: 'kg', default: 1000, min: 0 },
    { key: 'speed', label: '속도', kind: 'number', unit: 'm/s', default: 1, min: 0 },
    { key: 'floors', label: '운행 층', kind: 'floors', default: '' },
  ],
};

/** Library items for structural presets, added to every new drawing and to older files on load. */
export const DEFAULT_STRUCTURE_TYPES: EquipmentType[] = [
  { id: 'st-column', name: '기둥', width: 600, depth: 600, prefix: 'C', category: 'column', props: { shape: 'rect' } },
  { id: 'st-column-round', name: '원형 기둥', width: 600, depth: 600, prefix: 'C', category: 'column', props: { shape: 'round' } },
  { id: 'st-stair', name: '계단', width: 1200, depth: 4200, prefix: 'ST', category: 'stair' },
  { id: 'st-ramp', name: '경사로', width: 1500, depth: 9000, prefix: 'RP', category: 'ramp' },
  { id: 'st-lift', name: '리프트', width: 2000, depth: 2400, prefix: 'LF', category: 'lift' },
];

export const categoryOf = (t: EquipmentType | undefined): StructureCategory => t?.category ?? 'equipment';

/** Effective property value: instance override, then type default, then the definition's default. */
export function propValue(doc: DocumentModel, e: EquipmentEntity, key: string): PropValue {
  const type = doc.equipmentTypes.get(e.type);
  const def = PROP_DEFS[categoryOf(type)].find((d) => d.key === key);
  return e.props?.[key] ?? type?.props?.[key] ?? def?.default ?? '';
}

/** Floors a stair, ramp or lift reaches besides its own (it is drawn faintly there). */
export function connectedFloors(doc: DocumentModel, e: EquipmentEntity): Id[] {
  const cat = categoryOf(doc.equipmentTypes.get(e.type));
  if (cat === 'stair' || cat === 'ramp') {
    const to = String(propValue(doc, e, 'toFloor'));
    return to && doc.floors.has(to) ? [to] : [];
  }
  if (cat === 'lift') {
    return String(propValue(doc, e, 'floors'))
      .split(',')
      .map((s) => s.trim())
      .filter((id) => doc.floors.has(id));
  }
  return [];
}

/** Coerces an untrusted value to a property's type; null when it can't be. */
export function coerceProp(def: PropDef, v: unknown): PropValue | null {
  switch (def.kind) {
    case 'number': {
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) && n >= (def.min ?? -Infinity) ? n : null;
    }
    case 'boolean':
      return typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : null;
    case 'select':
      return typeof v === 'string' && def.options && v in def.options ? v : null;
    default:
      return typeof v === 'string' ? v : null;
  }
}

/** Keeps only known, well-typed properties of a category (used when loading files and by the API). */
export function cleanProps(category: StructureCategory, props: unknown): Record<string, PropValue> | undefined {
  if (!props || typeof props !== 'object') return undefined;
  const out: Record<string, PropValue> = {};
  for (const def of PROP_DEFS[category]) {
    if (!(def.key in props)) continue;
    const v = coerceProp(def, (props as Record<string, unknown>)[def.key]);
    if (v !== null) out[def.key] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface InfoRow {
  label: string;
  value: string;
  /** Set when a design check fails; the text says why. */
  warning?: string;
}

/** Height a stair or ramp climbs: to its connected floor, else its own floor's height. */
function riseOf(doc: DocumentModel, e: EquipmentEntity): number {
  const own = doc.floors.get(doc.floorOf(e) ?? '');
  const to = doc.floors.get(String(propValue(doc, e, 'toFloor')));
  if (own && to && to.id !== own.id) return Math.abs(to.elevation - own.elevation);
  return own?.height ?? 0;
}

/** Derived values and design checks for the property panel and viewer. */
export function presetInfo(doc: DocumentModel, e: EquipmentEntity): InfoRow[] {
  const type = doc.equipmentTypes.get(e.type);
  if (!type) return [];
  const num = (k: string) => Number(propValue(doc, e, k)) || 0;
  switch (categoryOf(type)) {
    case 'stair': {
      const rise = riseOf(doc, e);
      const riser = num('riser');
      const steps = rise > 0 && riser > 0 ? Math.ceil(rise / riser) : 0;
      const actual = steps > 0 ? rise / steps : 0;
      const run = Math.max(0, steps - 1) * num('tread');
      const rows: InfoRow[] = [
        { label: '오를 높이', value: `${Math.round(rise)} mm` },
        { label: '단 수', value: `${steps}단 (실제 단높이 ${actual.toFixed(1)} mm)` },
        { label: '필요 길이(참 제외)', value: `${Math.round(run)} mm` },
      ];
      if (actual > num('maxRiser')) rows[1].warning = `단높이가 ${num('maxRiser')} mm를 넘습니다.`;
      if (num('tread') < num('minTread')) rows.push({ label: '단너비', value: `${num('tread')} mm`, warning: `단너비가 ${num('minTread')} mm보다 좁습니다.` });
      if (run > type.depth) rows[2].warning = `계단 길이(${type.depth} mm)보다 깁니다. 계단참이나 꺾임이 필요합니다.`;
      if (rise > 3000) rows.push({ label: '계단참', value: '필요', warning: '높이 3 m마다 계단참이 필요합니다.' });
      return rows;
    }
    case 'ramp': {
      const rise = num('rise') > 0 ? num('rise') : riseOf(doc, e);
      const slope = type.depth > 0 ? rise / type.depth : 0;
      const rows: InfoRow[] = [
        { label: '높이차', value: `${Math.round(rise)} mm` },
        { label: '기울기', value: slope > 0 ? `1/${(1 / slope).toFixed(1)} (${(slope * 100).toFixed(1)}%)` : '-' },
      ];
      if (slope > 1 / num('maxSlope')) rows[1].warning = `기울기가 1/${num('maxSlope')}보다 급합니다. 필요 길이 ${Math.ceil(rise * num('maxSlope'))} mm.`;
      if (type.width < num('minWidth')) rows.push({ label: '폭', value: `${type.width} mm`, warning: `폭이 ${num('minWidth')} mm보다 좁습니다.` });
      return rows;
    }
    case 'lift': {
      const floors = connectedFloors(doc, e).map((id) => doc.floors.get(id)!.name);
      return [
        { label: '바닥 면적', value: `${((type.width * type.depth) / 1e6).toFixed(2)} m²` },
        { label: '운행 층', value: floors.length > 0 ? floors.join(', ') : '지정 안 됨' },
      ];
    }
    case 'column':
      return [{ label: '단면', value: propValue(doc, e, 'shape') === 'round' ? `Ø${type.width} mm` : `${type.width}×${type.depth} mm` }];
    default:
      return [];
  }
}
