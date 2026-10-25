/**
 * @file serialize.ts
 *
 * Drawing file format (JSON) save/load. `deserialize` validates every field and upgrades older files, so it is
 * the single gate for untrusted input (files, autosave, API/MCP loads). See docs/DATA_MODEL.md.
 */
import { DEFAULT_STRUCTURE_TYPES, cleanProps } from '../model/presets';
import {
  type Constraint,
  type ConstraintKind,
  DEFAULT_EQUIPMENT_TYPES,
  DEFAULT_FLOOR_ID,
  DEFAULT_LAYER_ID,
  type DocumentData,
  type Entity,
  type EquipmentType,
  type Floor,
  type Folder,
  type Layer,
  type Point,
  type StrokeStyle,
  type StructureCategory,
  type Underlay,
} from '../model/types';
import { LAYER_DEFAULT } from '../theme';

const CONSTRAINT_KINDS: ConstraintKind[] = ['horizontal', 'vertical', 'parallel', 'perpendicular', 'equal', 'fixed', 'radius'];
const CATEGORIES: StructureCategory[] = ['equipment', 'column', 'stair', 'ramp', 'lift'];
const COLOR = /^#[0-9a-f]{6}$/i;

export class FormatError extends Error {}

export function serialize(data: DocumentData): string {
  return JSON.stringify(data, null, 2);
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
// Raw JSON: fields are checked one by one below, so treat every record as loosely typed.
type Raw = any;

/** Optional name and monitoring binding shared by every entity. */
function common(e: Raw): { name?: string; binding?: string } {
  const out: { name?: string; binding?: string } = {};
  if (typeof e.name === 'string' && e.name) out.name = e.name;
  if (typeof e.binding === 'string' && e.binding) out.binding = e.binding;
  return out;
}

/** Validates a line style; throws on a malformed one. */
export function parseStroke(v: Raw, where: string): StrokeStyle | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isNum(v.width) || v.width < 0 || !['center', 'inside', 'outside'].includes(v.align)) {
    throw new FormatError(`${where}의 선 양식이 잘못되었습니다.`);
  }
  if (v.color !== undefined && !(typeof v.color === 'string' && COLOR.test(v.color))) throw new FormatError(`${where}의 선 색이 잘못되었습니다.`);
  return { width: v.width, align: v.align, ...(v.color ? { color: v.color } : {}) };
}

/**
 * Parses and validates a saved drawing. Throws FormatError with a readable message.
 * Version 1 files (before floors, folders and shapes) are upgraded: everything goes on one floor "1층" and the
 * structural presets are added to the library.
 */
export function deserialize(text: string): DocumentData {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new FormatError('JSON 형식이 아닙니다.');
  }
  return validate(raw);
}

/** Validates an already parsed drawing object (files, autosave, API and MCP input). */
export function validate(raw: unknown): DocumentData {
  const obj = raw as Raw;
  if (!obj || obj.format !== 'layout-liner') throw new FormatError('Layout Liner 도면 파일이 아닙니다.');
  if (obj.version !== 1 && obj.version !== 2) throw new FormatError(`지원하지 않는 파일 버전입니다: ${String(obj.version)}`);
  if (!Array.isArray(obj.points) || !Array.isArray(obj.entities)) throw new FormatError('points/entities 항목이 없습니다.');

  const points: Point[] = obj.points.map((p: Raw, i: number) => {
    if (!isStr(p?.id) || !isNum(p?.x) || !isNum(p?.y)) throw new FormatError(`잘못된 점 데이터 (#${i})`);
    return { id: p.id, x: p.x, y: p.y };
  });
  const pointIds = new Set(points.map((p) => p.id));

  const floors: Floor[] =
    Array.isArray(obj.floors) && obj.floors.length > 0
      ? obj.floors.map((f: Raw, i: number) => {
          if (!isStr(f?.id)) throw new FormatError(`잘못된 층 데이터 (#${i})`);
          return {
            id: f.id,
            name: typeof f.name === 'string' ? f.name : f.id,
            elevation: isNum(f.elevation) ? f.elevation : 0,
            height: isNum(f.height) && f.height > 0 ? f.height : 4000,
          };
        })
      : [{ id: DEFAULT_FLOOR_ID, name: '1층', elevation: 0, height: 4000 }];
  const floorIds = new Set(floors.map((f) => f.id));
  const floorOr = (id: unknown) => (isStr(id) && floorIds.has(id) ? id : floors[0].id);

  const folders: Folder[] = (Array.isArray(obj.folders) ? obj.folders : []).map((f: Raw, i: number) => {
    if (!isStr(f?.id)) throw new FormatError(`잘못된 폴더 데이터 (#${i})`);
    return {
      id: f.id,
      name: typeof f.name === 'string' ? f.name : f.id,
      floor: floorOr(f.floor),
      visible: f.visible !== false,
      locked: f.locked === true,
    };
  });
  const folderFloor = new Map(folders.map((f) => [f.id, f.floor]));

  const layers: Layer[] =
    Array.isArray(obj.layers) && obj.layers.length > 0
      ? obj.layers.map((l: Raw, i: number) => {
          if (!isStr(l?.id)) throw new FormatError(`잘못된 레이어 데이터 (#${i})`);
          const floor = floorOr(l.floor);
          const layer: Layer = {
            id: l.id,
            name: typeof l.name === 'string' ? l.name : l.id,
            color: typeof l.color === 'string' ? l.color : LAYER_DEFAULT,
            visible: l.visible !== false,
            locked: l.locked === true,
            floor,
          };
          // A folder on another floor would hide the layer in the tree, so drop such a link.
          if (isStr(l.folder) && folderFloor.get(l.folder) === floor) layer.folder = l.folder;
          return layer;
        })
      : [{ id: DEFAULT_LAYER_ID, name: '0', color: LAYER_DEFAULT, visible: true, locked: false, floor: floors[0].id }];
  const layerIds = new Set(layers.map((l) => l.id));

  // Drawings saved before equipment existed get the default library; older ones also get the structural presets.
  const equipmentTypes: EquipmentType[] = Array.isArray(obj.equipmentTypes)
    ? obj.equipmentTypes.map((t: Raw, i: number) => {
        if (!isStr(t?.id) || !isNum(t.width) || !isNum(t.depth) || t.width <= 0 || t.depth <= 0) {
          throw new FormatError(`잘못된 설비 종류 데이터 (#${i})`);
        }
        const category: StructureCategory = CATEGORIES.includes(t.category) ? t.category : 'equipment';
        const type: EquipmentType = {
          id: t.id,
          name: typeof t.name === 'string' ? t.name : t.id,
          width: t.width,
          depth: t.depth,
          prefix: typeof t.prefix === 'string' ? t.prefix : '',
        };
        if (category !== 'equipment') type.category = category;
        const props = cleanProps(category, t.props);
        if (props) type.props = props;
        return type;
      })
    : DEFAULT_EQUIPMENT_TYPES.map((t) => ({ ...t }));
  if (obj.version === 1) {
    for (const t of DEFAULT_STRUCTURE_TYPES) if (!equipmentTypes.some((x) => x.id === t.id)) equipmentTypes.push(structuredClone(t));
  }
  const typeById = new Map(equipmentTypes.map((t) => [t.id, t]));

  const ref = (id: unknown, i: number) => {
    if (!isStr(id) || !pointIds.has(id)) throw new FormatError(`엔티티 #${i}가 없는 점을 참조합니다.`);
    return id;
  };
  const entities: Entity[] = obj.entities.map((e: Raw, i: number): Entity => {
    if (!isStr(e?.id)) throw new FormatError(`잘못된 엔티티 데이터 (#${i})`);
    const layer = isStr(e.layer) && layerIds.has(e.layer) ? e.layer : layers[0].id;
    const base = { id: e.id, layer, ...common(e) };
    if (e.kind === 'line') {
      const stroke = parseStroke(e.stroke, `선 #${i}`);
      return { ...base, kind: 'line', p1: ref(e.p1, i), p2: ref(e.p2, i), ...(stroke ? { stroke } : {}) };
    }
    if (e.kind === 'circle') {
      if (!isNum(e.radius) || e.radius <= 0) throw new FormatError(`원 #${i}의 반지름이 잘못되었습니다.`);
      return { ...base, kind: 'circle', center: ref(e.center, i), radius: e.radius };
    }
    if (e.kind === 'dimension') {
      if (!isNum(e.offset)) throw new FormatError(`치수 #${i}의 간격 값이 잘못되었습니다.`);
      if (e.value !== undefined && (!isNum(e.value) || e.value <= 0)) throw new FormatError(`치수 #${i}의 값이 잘못되었습니다.`);
      return { ...base, kind: 'dimension', p1: ref(e.p1, i), p2: ref(e.p2, i), offset: e.offset, ...(e.value !== undefined ? { value: e.value } : {}) };
    }
    if (e.kind === 'equipment') {
      const type = isStr(e.type) ? typeById.get(e.type) : undefined;
      if (!type) throw new FormatError(`설비 #${i}의 종류가 없습니다.`);
      if (!isNum(e.rotation)) throw new FormatError(`설비 #${i}의 회전 값이 잘못되었습니다.`);
      const tag = typeof e.tag === 'string' ? e.tag : '';
      const props = cleanProps(type.category ?? 'equipment', e.props);
      return { ...base, kind: 'equipment', type: type.id, at: ref(e.at, i), rotation: e.rotation, tag, ...(props ? { props } : {}) };
    }
    if (e.kind === 'shape') {
      if (!Array.isArray(e.points) || !Array.isArray(e.edges) || e.points.length < 3 || e.points.length !== e.edges.length) {
        throw new FormatError(`도형 #${i}의 꼭짓점·변 데이터가 잘못되었습니다.`);
      }
      const shape: Entity = { ...base, kind: 'shape', points: e.points.map((p: unknown) => ref(p, i)), edges: [...e.edges] };
      if (typeof e.fill === 'string' && COLOR.test(e.fill)) shape.fill = e.fill;
      return shape;
    }
    throw new FormatError(`알 수 없는 엔티티 종류 (#${i})`);
  });
  // Shapes must be closed loops of existing lines through their points.
  const byId = new Map(entities.map((e) => [e.id, e]));
  entities.forEach((e, i) => {
    if (e.kind !== 'shape') return;
    e.edges.forEach((edgeId, k) => {
      const l = byId.get(edgeId);
      const a = e.points[k];
      const b = e.points[(k + 1) % e.points.length];
      if (l?.kind !== 'line' || !((l.p1 === a && l.p2 === b) || (l.p1 === b && l.p2 === a))) {
        throw new FormatError(`도형 #${i}의 변이 선과 맞지 않습니다.`);
      }
    });
  });

  const known = new Set<string>([...pointIds, ...entities.map((e) => e.id)]);
  const constraints: Constraint[] = (Array.isArray(obj.constraints) ? obj.constraints : []).map((c: Raw, i: number) => {
    if (!isStr(c?.id) || !CONSTRAINT_KINDS.includes(c.kind)) throw new FormatError(`잘못된 구속 데이터 (#${i})`);
    if (!Array.isArray(c.refs) || !c.refs.every((r: unknown) => isStr(r) && known.has(r))) {
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
    version: 2,
    units: 'mm',
    points,
    entities,
    constraints,
    floors,
    folders,
    layers,
    activeFloor: floorOr(obj.activeFloor),
    equipmentTypes,
    ...(underlay ? { underlay } : {}),
  };
}
