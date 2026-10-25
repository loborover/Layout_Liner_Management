/**
 * @file types.ts
 *
 * Document data types: the persisted schema of a drawing. Changing anything here usually also needs
 * src/io/serialize.ts (validation/migration), docs/DATA_MODEL.md and tests/serialize.test.ts.
 */
export type Id = string;

/** Shared vertex. Entities reference points by id so that connected geometry moves together. */
export interface Point {
  id: Id;
  x: number; // mm
  y: number; // mm, world Y axis points up
}

/** Fields every entity has. */
interface EntityBase {
  id: Id;
  layer: Id;
  /** Optional user label shown in the object tree, the property panel and the viewer. */
  name?: string;
  /**
   * Monitoring binding: the key of a live value from the host server (see docs/VIEWER.md).
   * The viewer colours and labels the entity from that value; the editor only stores it.
   */
  binding?: string;
}

/** Where a styled line's band sits relative to the drawn reference line. */
export type StrokeAlign = 'center' | 'inside' | 'outside';

/**
 * Line style, e.g. a wall: the drawn line is the reference and the band of `width` mm is laid on its inside,
 * centred on it, or on its outside. "Inside" is towards the interior of a shape the line belongs to; for a
 * free line it is the left side of the direction p1 → p2.
 */
export interface StrokeStyle {
  /** Band width in mm; 0 draws a hairline in `color`. */
  width: number;
  /** CSS hex colour; the layer colour when absent. */
  color?: string;
  align: StrokeAlign;
}

export interface LineEntity extends EntityBase {
  kind: 'line';
  /** Start point. The midpoint is derived (snap "중점"). */
  p1: Id;
  /** End point. */
  p2: Id;
  stroke?: StrokeStyle;
}

export interface CircleEntity extends EntityBase {
  kind: 'circle';
  center: Id;
  radius: number; // mm
}

/** Aligned dimension. Points may be shared with measured geometry so the value follows edits. */
export interface DimensionEntity extends EntityBase {
  kind: 'dimension';
  p1: Id;
  p2: Id;
  offset: number; // mm, perpendicular to p1→p2, positive to the left
  /** When set, the dimension drives the geometry: the distance between p1 and p2 is held at this value (mm). */
  value?: number;
}

/** Values of preset properties (see src/model/presets.ts). */
export type PropValue = number | string | boolean;

/**
 * A placed piece of equipment or a structural preset (column, stair, ramp, lift): a footprint of its type,
 * centred on `at`. Like a CAD block reference, the size comes from the type, so editing the type updates every
 * instance; `props` overrides the type's property values for this instance only.
 */
export interface EquipmentEntity extends EntityBase {
  kind: 'equipment';
  type: Id;
  at: Id;
  /** Degrees, counter-clockwise. At 0 the width runs along X and the front faces -Y. */
  rotation: number;
  /** Equipment number shown on the plan and in the equipment list, e.g. "CNC-3". */
  tag: string;
  props?: Record<string, PropValue>;
}

/**
 * Closed shape ("도형") made of lines whose shared points form a loop: the point → line → face → shape
 * hierarchy. The lines stay ordinary lines (and can be styled); the shape adds the enclosed face with a fill,
 * a name and an area. `points[i]` → `points[i+1]` is the edge `edges[i]`, the loop closing back on points[0].
 */
export interface ShapeEntity extends EntityBase {
  kind: 'shape';
  points: Id[];
  edges: Id[];
  /** Face fill colour; the layer colour (faint) when absent. */
  fill?: string;
}

export type Entity = LineEntity | CircleEntity | DimensionEntity | EquipmentEntity | ShapeEntity;
export type EntityKind = Entity['kind'];

/** Category of a library item: plain equipment or a structural preset with its own drawing and properties. */
export type StructureCategory = 'equipment' | 'column' | 'stair' | 'ramp' | 'lift';

/** Equipment/structure definition (block): footprint, name and default properties shared by its instances. */
export interface EquipmentType {
  id: Id;
  name: string;
  width: number; // mm, along the equipment's own X (diameter for a round column)
  depth: number; // mm, along its own Y
  /** Prefix of new instances' tags. */
  prefix: string;
  /** 'equipment' when absent. */
  category?: StructureCategory;
  /** Default property values, keyed by the category's property definitions. */
  props?: Record<string, PropValue>;
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

/**
 * Storey of a multi-storey building. Floors are the top level of the layer tree: floor > folder > layer > entity.
 * Only the active floor is shown and edited.
 */
export interface Floor {
  id: Id;
  name: string;
  /** Floor level above the reference level, mm. */
  elevation: number;
  /** Floor-to-floor height, mm (used by stairs and ramps to work out steps and slope). */
  height: number;
}

/** Group of layers on one floor. Hiding or locking a folder hides or locks all of its layers. */
export interface Folder {
  id: Id;
  name: string;
  floor: Id;
  visible: boolean;
  locked: boolean;
}

export interface Layer {
  id: Id;
  name: string;
  color: string;
  visible: boolean;
  locked: boolean;
  floor: Id;
  /** Folder the layer belongs to; directly under the floor when absent. */
  folder?: Id;
}

/** Scanned or exported floor plan shown under the drawing, to trace over. */
export interface Underlay {
  /** Image as a data: URL, so the drawing file stays self-contained. */
  src: string;
  /** World position (mm) of the image's bottom-left corner. */
  x: number;
  y: number;
  /** Size in mm. */
  width: number;
  height: number;
  opacity: number;
  visible: boolean;
}

export interface DocumentData {
  format: 'layout-liner';
  /** 2 added floors, folders, shapes, line styles, presets and bindings; version 1 files are upgraded on load. */
  version: 2;
  units: 'mm';
  points: Point[];
  entities: Entity[];
  constraints: Constraint[];
  floors: Floor[];
  folders: Folder[];
  layers: Layer[];
  /** Floor shown when the drawing is opened. */
  activeFloor: Id;
  equipmentTypes: EquipmentType[];
  underlay?: Underlay;
}

export const DEFAULT_LAYER_ID = 'layer-0';
export const DEFAULT_FLOOR_ID = 'floor-1';

/** Equipment library a new drawing starts with (structural presets are added from src/model/presets.ts). */
export const DEFAULT_EQUIPMENT_TYPES: EquipmentType[] = [
  { id: 'eq-bench', name: '작업대', width: 1800, depth: 750, prefix: 'WB' },
  { id: 'eq-rack', name: '선반', width: 2700, depth: 1000, prefix: 'RK' },
  { id: 'eq-machine', name: '가공기', width: 3000, depth: 2200, prefix: 'MC' },
  { id: 'eq-conveyor', name: '컨베이어', width: 4000, depth: 600, prefix: 'CV' },
  { id: 'eq-pallet', name: '팔레트', width: 1100, depth: 1100, prefix: 'PL' },
];
