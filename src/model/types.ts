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
  /** Height above its floor's level, mm (3D views). 0 when absent; 2D editing never changes it. */
  z?: number;
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
  /**
   * Source data link: the record in an external database (through the host's data gateway, docs/DATA_SOURCES.md)
   * that this object stands for. Read-only: the drawing shows the record's fields, it never writes them back.
   */
  record?: RecordRef;
}

/**
 * Reference to one record of a dataset served by the data gateway (the user's request, 2026-11-15). `key` is the
 * record's key; when absent, the equipment number (`tag`) or else the object's name is used, so a whole selection
 * can be linked to a dataset at once.
 */
export interface RecordRef {
  /** Dataset name as configured on the gateway, e.g. "equipment". */
  dataset: string;
  key?: string;
}

/** Where a styled line's band sits relative to the drawn reference line. */
export type StrokeAlign = 'center' | 'inside' | 'outside';

/**
 * How a border band closes on the outer side of a corner where two bands meet: a sharp mitre (the default), a
 * round arc ("Round") or a chamfer ("Chamfer", bevel). The inner side always meets exactly.
 */
export type StrokeJoin = 'miter' | 'round' | 'bevel';

/** One stripe of a border pattern. */
export interface Stripe {
  /** CSS hex colour. */
  color: string;
  /** Relative size: the stripe is `size × pattern.unit` mm wide. */
  size: number;
}

/**
 * Striped border pattern ("Border.Pattern"), e.g. yellow/black hazard stripes: the stripes repeat in order, each
 * `size × unit` mm wide, at `angle` degrees. For a line the angle is measured from the line's direction (so the
 * stripes look the same whichever way the line runs); for a circle from the world X axis.
 */
export interface StripePattern {
  stripes: Stripe[];
  /** mm per relative size unit (a stripe of size 1 is this wide). */
  unit: number;
  /** Degrees, counter-clockwise. 0 gives stripes along the line, 90 across it. */
  angle: number;
}

/**
 * Border of a line or circle ("Border": Weight, Color, Opacity, Pattern), e.g. a wall or a floor marking: the
 * drawn line is the reference and the band of `width` mm is laid on its inside, centred on it, or on its outside.
 * "Inside" is towards the interior of a shape the line belongs to (or of a circle); for a free line it is the left
 * side of the direction p1 → p2. A shape's border is the border of its edge lines.
 */
export interface StrokeStyle {
  /** Band width in mm ("Weight"); 0 draws a hairline in `color`. */
  width: number;
  /** CSS hex colour; the layer colour when absent. With a pattern it colours the outline and the hairline. */
  color?: string;
  align: StrokeAlign;
  /** Opacity 0–1 of the band (and of a hairline); 0.85 for a band and 1 for a hairline when absent. */
  opacity?: number;
  /** Stripes filling the band instead of the plain colour. Needs a width above 0 to show. */
  pattern?: StripePattern;
  /** Outer corner treatment where this band meets another; 'miter' when absent. */
  join?: StrokeJoin;
}

/**
 * A standalone point object (a reference or survey point, a sensor location) on a layer. Lines and shapes drawn
 * from it share its point.
 */
export interface PointEntity extends EntityBase {
  kind: 'point';
  at: Id;
}

/**
 * A line is an assembly of a start point, a midpoint and an end point joined by the line (the user's model,
 * 2026-10-25). The start and end are stored points; the midpoint is derived from them, but can be selected and
 * moved like a point (see `midpointId` in src/model/document.ts), which moves the whole line.
 */
export interface LineEntity extends EntityBase {
  kind: 'line';
  /** Start point. */
  p1: Id;
  /** End point. */
  p2: Id;
  stroke?: StrokeStyle;
  /** Height of the line's wall in 3D, mm; 0 (flat) when absent. */
  height?: number;
}

export interface CircleEntity extends EntityBase {
  kind: 'circle';
  center: Id;
  radius: number; // mm
  /** Border band around the circle (inside = towards the centre). */
  stroke?: StrokeStyle;
  /** Extruded height in 3D (a round tank, a pit), mm; 0 when absent. */
  height?: number;
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
  /** Height in 3D for this instance, mm; the type's height when absent. */
  height?: number;
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
  /** Opacity 0–1 of the face only (not its border); 0.35 with a fill colour or image, 0.06 without, when absent. */
  fillOpacity?: number;
  /** Image drawn on the face instead of the colour. */
  fillImage?: FillImage;
  /** Extruded height in 3D (a slab, a platform, a zone volume), mm; a flat face when absent. */
  height?: number;
  /** Label placement, extra rows, opacity and visibility; name and area in the middle when absent. */
  label?: ShapeLabel;
}

/** Where a label sits: in the middle of its shape (or on its point) or against the top, bottom, left or right. */
export type LabelAnchor = 'center' | 'top' | 'bottom' | 'left' | 'right';

/** One row of a label, shown as "제목: 내용" (just the content when the title is empty). */
export interface LabelItem {
  title: string;
  value: string;
}

/**
 * Label of a shape (the user's request, 2026-11-15): by default the shape's name and area in the middle of its face
 * (the area centroid). Extra "제목: 내용" rows can be added, and the label can be placed against an edge, offset,
 * faded or hidden. Absent fields keep the defaults.
 */
export interface ShapeLabel {
  /** Extra rows after the name and area. */
  items?: LabelItem[];
  /** Show the shape's name; true when absent. */
  showName?: boolean;
  /** Show the shape's area; true when absent. */
  showArea?: boolean;
  /** Placement in the face; 'center' (the area centroid) when absent. */
  anchor?: LabelAnchor;
  /** Shift from the anchor in mm (world X right, Y up). */
  dx?: number;
  dy?: number;
  /** Opacity 0–1 of the text; 1 when absent. */
  opacity?: number;
  /** False hides the label. */
  visible?: boolean;
}

/**
 * Standalone label ("라벨" object, the user's request 2026-11-15): "제목: 내용" rows of text at a point, sized in
 * world millimetres like CAD text so it scales with the drawing and prints at its real size.
 */
export interface LabelEntity extends EntityBase {
  kind: 'label';
  at: Id;
  items: LabelItem[];
  /** Text height in mm; LABEL_TEXT_SIZE when absent. */
  size?: number;
  /** Which part of the text block sits on the point; 'center' when absent ('top': the block hangs below it). */
  anchor?: LabelAnchor;
  /** Text colour; the layer colour when absent. */
  color?: string;
  /** Opacity 0–1; 1 when absent. */
  opacity?: number;
  /** False hides the text (it stays selectable in the editor as a faint frame). */
  visible?: boolean;
}

/** Default text height of a label object, mm. */
export const LABEL_TEXT_SIZE = 300;

/** Picture on a shape's face (a floor finish, a photo, a logo). */
export interface FillImage {
  /** Image as a data: URL, so the drawing file stays self-contained (never fetched from elsewhere). */
  src: string;
  /** 'stretch' fits the image to the face's bounding box; 'tile' repeats it, `size` mm wide. */
  fit: 'stretch' | 'tile';
  /** Tile width in mm for 'tile' (height follows the image's aspect ratio). */
  size?: number;
}

export type Entity = PointEntity | LineEntity | CircleEntity | DimensionEntity | EquipmentEntity | ShapeEntity | LabelEntity;
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
  /** Default height in 3D of its instances, mm; 0 (flat) when absent. */
  height?: number;
}

export type ConstraintKind = 'horizontal' | 'vertical' | 'parallel' | 'perpendicular' | 'equal' | 'fixed' | 'radius' | 'coincident';

/**
 * Geometric constraint solved by planegcs.
 * `refs` are entity ids (lines/circles), except for 'fixed' and 'coincident', which reference point ids.
 * 'coincident' holds two or more points of different objects at one place: drawing from another object's point
 * makes one, so the objects stay separate and can be pulled apart by removing it (the user's request, 2026-11-15).
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

/**
 * Group of layers and other folders on one floor. Folders nest (e.g. 작업구역 > 협력사 > 회사별, the user's request
 * 2026-11-15): hiding or locking a folder hides or locks everything inside it, however deep. Names need not be
 * unique; the `id` is what identifies a folder (in files, the API and to AI agents).
 */
export interface Folder {
  id: Id;
  name: string;
  floor: Id;
  /** Folder this one sits in (on the same floor); directly under the floor when absent. */
  parent?: Id;
  visible: boolean;
  locked: boolean;
}

/** Layer of objects, under a floor or a folder. Like folders, names may repeat and the `id` is the identity. */
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
  /** Locked images can't be selected or moved on the canvas (tracing over them stays undisturbed). */
  locked?: boolean;
}

export interface DocumentData {
  format: 'layout-liner';
  /**
   * 2 added floors, folders, shapes, line styles, presets and bindings; 3 added point Z, object heights (3D) and point objects;
   * 4 added border opacity and patterns, circle borders, face opacity and images, coincident constraints and the
   * underlay lock; 5 added border corner joins, shape labels, label objects and the H-beam column section; 6 added
   * nested folders (`Folder.parent`). Older versions are upgraded on load.
   */
  version: 6;
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
