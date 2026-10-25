/**
 * @file serialize.ts
 *
 * Drawing file format (JSON) save/load. `deserialize` validates every field and upgrades older files, so it is
 * the single gate for untrusted input (files, autosave, API/MCP loads). See docs/DATA_MODEL.md.
 */
import {
  type Constraint,
  type ConstraintKind,
  DEFAULT_EQUIPMENT_TYPES,
  DEFAULT_LAYER_ID,
  type DocumentData,
  type Entity,
  type EquipmentType,
  type Layer,
  type Point,
  type Underlay,
} from '../model/types';

const CONSTRAINT_KINDS: ConstraintKind[] = ['horizontal', 'vertical', 'parallel', 'perpendicular', 'equal', 'fixed', 'radius'];

export class FormatError extends Error {}

export function serialize(data: DocumentData): string {
  return JSON.stringify(data, null, 2);
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Parses and validates a saved drawing. Throws FormatError with a readable message. */
export function deserialize(text: string): DocumentData {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new FormatError('JSON 형식이 아닙니다.');
  }
  const obj = raw as Partial<DocumentData>;
  if (!obj || obj.format !== 'layout-liner') throw new FormatError('Layout Liner 도면 파일이 아닙니다.');
  if (obj.version !== 1) throw new FormatError(`지원하지 않는 파일 버전입니다: ${String(obj.version)}`);
  if (!Array.isArray(obj.points) || !Array.isArray(obj.entities)) throw new FormatError('points/entities 항목이 없습니다.');

  const points: Point[] = obj.points.map((p, i) => {
    if (!isStr(p?.id) || !isNum(p?.x) || !isNum(p?.y)) throw new FormatError(`잘못된 점 데이터 (#${i})`);
    return { id: p.id, x: p.x, y: p.y };
  });
  const pointIds = new Set(points.map((p) => p.id));

  const layers: Layer[] = Array.isArray(obj.layers) && obj.layers.length > 0
    ? obj.layers.map((l, i) => {
        if (!isStr(l?.id)) throw new FormatError(`잘못된 레이어 데이터 (#${i})`);
        return {
          id: l.id,
          name: typeof l.name === 'string' ? l.name : l.id,
          color: typeof l.color === 'string' ? l.color : '#1f2937',
          visible: l.visible !== false,
          locked: l.locked === true,
        };
      })
    : [{ id: DEFAULT_LAYER_ID, name: '0', color: '#1f2937', visible: true, locked: false }];
  const layerIds = new Set(layers.map((l) => l.id));

  // Drawings saved before equipment existed get the default library.
  const equipmentTypes: EquipmentType[] = Array.isArray(obj.equipmentTypes)
    ? obj.equipmentTypes.map((t, i) => {
        if (!isStr(t?.id) || !isNum(t.width) || !isNum(t.depth) || t.width <= 0 || t.depth <= 0) {
          throw new FormatError(`잘못된 설비 종류 데이터 (#${i})`);
        }
        return {
          id: t.id,
          name: typeof t.name === 'string' ? t.name : t.id,
          width: t.width,
          depth: t.depth,
          prefix: typeof t.prefix === 'string' ? t.prefix : '',
        };
      })
    : DEFAULT_EQUIPMENT_TYPES.map((t) => ({ ...t }));
  const typeIds = new Set(equipmentTypes.map((t) => t.id));

  const ref = (id: unknown, i: number) => {
    if (!isStr(id) || !pointIds.has(id)) throw new FormatError(`엔티티 #${i}가 없는 점을 참조합니다.`);
    return id;
  };
  const entities: Entity[] = obj.entities.map((e, i) => {
    if (!isStr(e?.id)) throw new FormatError(`잘못된 엔티티 데이터 (#${i})`);
    const layer = isStr(e.layer) && layerIds.has(e.layer) ? e.layer : layers[0].id;
    if (e.kind === 'line') return { id: e.id, kind: 'line', p1: ref(e.p1, i), p2: ref(e.p2, i), layer };
    if (e.kind === 'circle') {
      if (!isNum(e.radius) || e.radius <= 0) throw new FormatError(`원 #${i}의 반지름이 잘못되었습니다.`);
      return { id: e.id, kind: 'circle', center: ref(e.center, i), radius: e.radius, layer };
    }
    if (e.kind === 'dimension') {
      if (!isNum(e.offset)) throw new FormatError(`치수 #${i}의 간격 값이 잘못되었습니다.`);
      if (e.value !== undefined && (!isNum(e.value) || e.value <= 0)) throw new FormatError(`치수 #${i}의 값이 잘못되었습니다.`);
      const dim: Entity = { id: e.id, kind: 'dimension', p1: ref(e.p1, i), p2: ref(e.p2, i), offset: e.offset, layer };
      if (e.value !== undefined) dim.value = e.value;
      return dim;
    }
    if (e.kind === 'equipment') {
      if (!isStr(e.type) || !typeIds.has(e.type)) throw new FormatError(`설비 #${i}의 종류가 없습니다.`);
      if (!isNum(e.rotation)) throw new FormatError(`설비 #${i}의 회전 값이 잘못되었습니다.`);
      const tag = typeof e.tag === 'string' ? e.tag : '';
      return { id: e.id, kind: 'equipment', type: e.type, at: ref(e.at, i), rotation: e.rotation, tag, layer };
    }
    throw new FormatError(`알 수 없는 엔티티 종류 (#${i})`);
  });

  const known = new Set<string>([...pointIds, ...entities.map((e) => e.id)]);
  const constraints: Constraint[] = (Array.isArray(obj.constraints) ? obj.constraints : []).map((c, i) => {
    if (!isStr(c?.id) || !CONSTRAINT_KINDS.includes(c.kind)) throw new FormatError(`잘못된 구속 데이터 (#${i})`);
    if (!Array.isArray(c.refs) || !c.refs.every((r) => isStr(r) && known.has(r))) {
      throw new FormatError(`구속 #${i}가 없는 객체를 참조합니다.`);
    }
    const out: Constraint = { id: c.id, kind: c.kind, refs: [...c.refs] };
    if (c.value !== undefined) {
      if (!isNum(c.value) || c.value <= 0) throw new FormatError(`구속 #${i}의 값이 잘못되었습니다.`);
      out.value = c.value;
    }
    return out;
  });

  let underlay: Underlay | undefined;
  if (obj.underlay !== undefined && obj.underlay !== null) {
    const u = obj.underlay;
    // Only embedded images: a URL would make opening a drawing fetch from wherever the file points.
    const embedded = typeof u.src === 'string' && /^data:image\/(png|jpeg|gif|webp);base64,/.test(u.src);
    if (!embedded || ![u.x, u.y, u.width, u.height].every(isNum) || !(u.width > 0) || !(u.height > 0)) {
      throw new FormatError('밑그림 이미지 데이터가 잘못되었습니다.');
    }
    const opacity = isNum(u.opacity) ? Math.min(1, Math.max(0.05, u.opacity)) : 0.5;
    underlay = { src: u.src, x: u.x, y: u.y, width: u.width, height: u.height, opacity, visible: u.visible !== false };
  }

  return {
    format: 'layout-liner',
    version: 1,
    units: 'mm',
    points,
    entities,
    constraints,
    layers,
    equipmentTypes,
    ...(underlay ? { underlay } : {}),
  };
}
