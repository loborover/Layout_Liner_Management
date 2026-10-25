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
  layer: Id;
}

export type Entity = LineEntity | CircleEntity | DimensionEntity;

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
  layers: Layer[];
}

export const DEFAULT_LAYER_ID = 'layer-0';
