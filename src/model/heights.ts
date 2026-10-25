/**
 * @file heights.ts
 *
 * Vertical extent of objects for the 3D views (request: every object has X, Y, Z). A point's `z` is its height
 * above its floor's level; an object's `height` is how far it rises from there. Every height starts at 0 (the
 * user's rule, 2026-10-25): an object without its own height, or its equipment type's, is flat in 3D until the
 * user gives it one. DOM-free.
 * Related: src/model/types.ts (z, height fields), src/view3d/ (3D scene).
 */
import type { DocumentModel } from './document';
import type { Entity, Id } from './types';

/** Height used when an entity has none of its own (shown as the placeholder in the property panel). */
export function defaultHeight(doc: DocumentModel, e: Entity): number {
  return e.kind === 'equipment' ? (doc.equipmentTypes.get(e.type)?.height ?? 0) : 0;
}

/** Effective height of an entity, mm (dimensions and point objects have none). */
export function heightOf(doc: DocumentModel, e: Entity): number {
  if (e.kind === 'dimension' || e.kind === 'point') return 0;
  return e.height ?? defaultHeight(doc, e);
}

/** Absolute Z of a point, mm: its floor's elevation plus its own z. */
export function absoluteZ(doc: DocumentModel, pointId: Id, floorId: Id | undefined): number {
  return (doc.floors.get(floorId ?? '')?.elevation ?? 0) + (doc.points.get(pointId)?.z ?? 0);
}
