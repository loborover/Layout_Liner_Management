/**
 * @file heights.ts
 *
 * Vertical extent of objects for the 3D views (request: every object has X, Y, Z). A point's `z` is its height
 * above its floor's level; an object's `height` is how far it rises from there. When an object has no explicit
 * height, `defaultHeight` derives one: a styled line (a wall) and a structural preset span the floor height,
 * equipment is 1000 mm, plain lines, circles and shapes are flat. DOM-free.
 * Related: src/model/types.ts (z, height fields), src/view3d/ (3D scene).
 */
import type { DocumentModel } from './document';
import { categoryOf } from './presets';
import type { Entity, Id } from './types';

/** Height of plain equipment without one of its own, mm. */
export const EQUIPMENT_HEIGHT = 1000;

/** Floor-to-floor height of the floor an entity is on, mm. */
export function floorHeight(doc: DocumentModel, e: Entity): number {
  return doc.floors.get(doc.floorOf(e) ?? '')?.height ?? 4000;
}

/** Height used when an entity has none of its own (shown as the placeholder in the property panel). */
export function defaultHeight(doc: DocumentModel, e: Entity): number {
  switch (e.kind) {
    case 'line':
      return e.stroke && e.stroke.width > 0 ? floorHeight(doc, e) : 0;
    case 'equipment': {
      const type = doc.equipmentTypes.get(e.type);
      if (type?.height !== undefined) return type.height;
      return categoryOf(type) === 'equipment' ? EQUIPMENT_HEIGHT : floorHeight(doc, e);
    }
    default:
      return 0;
  }
}

/** Effective height of an entity, mm (dimensions have none). */
export function heightOf(doc: DocumentModel, e: Entity): number {
  if (e.kind === 'dimension') return 0;
  return e.height ?? defaultHeight(doc, e);
}

/** Absolute Z of a point, mm: its floor's elevation plus its own z. */
export function absoluteZ(doc: DocumentModel, pointId: Id, floorId: Id | undefined): number {
  return (doc.floors.get(floorId ?? '')?.elevation ?? 0) + (doc.points.get(pointId)?.z ?? 0);
}
