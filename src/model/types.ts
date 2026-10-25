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

export type Entity = LineEntity | CircleEntity | DimensionEntity;

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
}

export const DEFAULT_LAYER_ID = 'layer-0';
