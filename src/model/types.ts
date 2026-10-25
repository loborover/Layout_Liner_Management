export type Id = string;

/** Shared vertex. Entities reference points by id so that connected geometry moves together. */
export interface Point {
  id: Id;
  x: number; // mm
  y: number; // mm, world Y axis points up
}

export interface LineEntity {
  id: Id;
  kind: 'line';
  p1: Id;
  p2: Id;
  layer: Id;
}

export interface CircleEntity {
  id: Id;
  kind: 'circle';
  center: Id;
  radius: number; // mm
  layer: Id;
}

/** Aligned dimension. Points may be shared with measured geometry so the value follows edits. */
export interface DimensionEntity {
  id: Id;
  kind: 'dimension';
  p1: Id;
  p2: Id;
  offset: number; // mm, perpendicular to p1→p2, positive to the left
  /** When set, the dimension drives the geometry: the distance between p1 and p2 is held at this value (mm). */
  value?: number;
  layer: Id;
}

/**
 * A placed piece of equipment: a rectangular footprint of its type, centred on `at`.
 * Like a CAD block reference, the size comes from the type, so editing the type updates every instance.
 */
export interface EquipmentEntity {
  id: Id;
  kind: 'equipment';
  type: Id;
  at: Id;
  /** Degrees, counter-clockwise. At 0 the width runs along X and the front faces -Y. */
  rotation: number;
  /** Equipment number shown on the plan and in the equipment list, e.g. "CNC-3". */
  tag: string;
  layer: Id;
}

export type Entity = LineEntity | CircleEntity | DimensionEntity | EquipmentEntity;

/** Equipment definition (block): footprint and name shared by its instances. */
export interface EquipmentType {
  id: Id;
  name: string;
  width: number; // mm, along the equipment's own X
  depth: number; // mm, along its own Y
  /** Prefix of new instances' tags. */
  prefix: string;
}

export type ConstraintKind = 'horizontal' | 'vertical' | 'parallel' | 'perpendicular' | 'equal' | 'fixed' | 'radius';

/**
 * Geometric constraint solved by planegcs.
 * `refs` are entity ids (lines/circles), except for 'fixed', which references point ids.
 */
export interface Constraint {
  id: Id;
  kind: ConstraintKind;
  refs: Id[];
  /** Radius in mm for 'radius'. */
  value?: number;
}

export interface Layer {
  id: Id;
  name: string;
  color: string;
  visible: boolean;
  locked: boolean;
}

export interface DocumentData {
  format: 'layout-liner';
  version: 1;
  units: 'mm';
  points: Point[];
  entities: Entity[];
  constraints: Constraint[];
  layers: Layer[];
  equipmentTypes: EquipmentType[];
}

export const DEFAULT_LAYER_ID = 'layer-0';

/** Library a new drawing starts with. */
export const DEFAULT_EQUIPMENT_TYPES: EquipmentType[] = [
  { id: 'eq-bench', name: '작업대', width: 1800, depth: 750, prefix: 'WB' },
  { id: 'eq-rack', name: '선반', width: 2700, depth: 1000, prefix: 'RK' },
  { id: 'eq-machine', name: '가공기', width: 3000, depth: 2200, prefix: 'MC' },
  { id: 'eq-conveyor', name: '컨베이어', width: 4000, depth: 600, prefix: 'CV' },
  { id: 'eq-pallet', name: '팔레트', width: 1100, depth: 1100, prefix: 'PL' },
];
