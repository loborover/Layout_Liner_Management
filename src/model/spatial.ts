/**
 * @file spatial.ts
 *
 * R-tree (rbush) over entity bounding boxes for viewport culling, picking and window selection. Rebuilt lazily
 * when the document revision changes.
 */
import RBush from 'rbush';
import {
  type Box,
  type Vec2,
  boxContainsBox,
  circleIntersectsBox,
  dist,
  distToSegment,
  segmentIntersectsBox,
} from '../geom/vec';
import { dimensionGeometry } from '../geom/dimension';
import { edgesOf, insideConvex } from '../geom/equipment';
import { insidePolygon } from '../geom/polygon';
import { type DocumentModel, midpointId } from './document';
import type { Entity, Id } from './types';

interface Item extends Box {
  id: Id;
}

/**
 * R-tree over entity bounding boxes, rebuilt lazily after document changes.
 * Used for viewport culling, picking and window selection.
 */
export class SpatialIndex {
  private tree = new RBush<Item>();
  private builtRev = -1;

  constructor(private readonly doc: DocumentModel) {}

  private ensure(): void {
    if (this.builtRev === this.doc.rev) return;
    const items: Item[] = [];
    for (const e of this.doc.entities.values()) items.push({ ...this.doc.bboxOf(e), id: e.id });
    this.tree.clear();
    this.tree.load(items);
    this.builtRev = this.doc.rev;
  }

  /** Entities whose bounding box overlaps the box. */
  query(box: Box): Entity[] {
    this.ensure();
    return this.tree.search(box).map((it) => this.doc.entities.get(it.id)!);
  }

  /** Distance from p to an entity's outline; 0 anywhere inside a piece of equipment, so it can be grabbed by its body. */
  distanceTo(e: Entity, p: Vec2): number {
    if (e.kind === 'point') return dist(p, this.doc.point(e.at));
    if (e.kind === 'equipment') {
      const corners = this.doc.cornersOf(e);
      if (insideConvex(p, corners)) return 0;
      return Math.min(...edgesOf(corners).map(([a, b]) => distToSegment(p, a, b)));
    }
    if (e.kind === 'shape') {
      // A shape is grabbed by its face; its outline belongs to its lines.
      return insidePolygon(p, this.doc.shapePolygon(e)) ? 0 : Infinity;
    }
    if (e.kind === 'line') return distToSegment(p, this.doc.point(e.p1), this.doc.point(e.p2));
    if (e.kind === 'dimension') {
      const { d1, d2 } = dimensionGeometry(this.doc.point(e.p1), this.doc.point(e.p2), e.offset);
      return distToSegment(p, d1, d2);
    }
    if (e.kind === 'circle') return Math.abs(dist(p, this.doc.point(e.center)) - e.radius);
    return Infinity;
  }

  /**
   * Nearest editable entity within tol (mm) of p. Faces (shapes) rank below everything else, so a line or a piece
   * of equipment inside a room is picked before the room; among overlapping faces the topmost (latest) wins.
   */
  pick(p: Vec2, tol: number): Entity | null {
    return this.pickWhere(p, tol, (e) => this.doc.isEditable(e));
  }

  /**
   * Nearest point (vertex) within tol of p among editable entities' points: line ends and midpoints, shape corners, circle
   * centres, equipment insertion points, dimension feet. Selecting a point edits everything attached to it.
   */
  pickPoint(p: Vec2, tol: number): Id | null {
    let best: Id | null = null;
    let bestD = tol;
    for (const e of this.query({ minX: p.x - tol, minY: p.y - tol, maxX: p.x + tol, maxY: p.y + tol })) {
      if (!this.doc.isEditable(e)) continue;
      // A line is an assembly of its start, midpoint and end; the midpoint is a vertex too.
      const ids = e.kind === 'line' ? [...this.doc.pointIdsOf(e), midpointId(e.id)] : this.doc.pointIdsOf(e);
      for (const id of ids) {
        const d = dist(p, this.doc.vertex(id));
        if (d <= bestD) {
          best = id;
          bestD = d;
        }
      }
    }
    return best;
  }

  /** Like pick, but any visible entity, locked or not (viewer mode inspects without editing). */
  pickVisible(p: Vec2, tol: number): Entity | null {
    return this.pickWhere(p, tol, (e) => this.doc.isVisible(e));
  }

  private pickWhere(p: Vec2, tol: number, accept: (e: Entity) => boolean): Entity | null {
    let best: Entity | null = null;
    let bestD = tol + 1e-9;
    for (const e of this.query({ minX: p.x - tol, minY: p.y - tol, maxX: p.x + tol, maxY: p.y + tol })) {
      if (!accept(e)) continue;
      const d = e.kind === 'shape' ? (this.distanceTo(e, p) === 0 ? tol * 0.999 : Infinity) : this.distanceTo(e, p);
      if (d < bestD || (d === bestD && best?.kind === 'shape' && e.kind === 'shape' && this.later(e, best))) {
        best = e;
        bestD = d;
      }
    }
    return best;
  }

  /**
   * Window selection. `crossing` false selects entities fully inside the box;
   * true selects anything the box touches (CAD right-to-left convention).
   */
  select(box: Box, crossing: boolean): Entity[] {
    return this.query(box).filter((e) => {
      if (!this.doc.isEditable(e)) return false;
      if (!crossing) return boxContainsBox(box, this.doc.bboxOf(e));
      if (e.kind === 'point') return boxContainsBox(box, this.doc.bboxOf(e));
      if (e.kind === 'line') return segmentIntersectsBox(this.doc.point(e.p1), this.doc.point(e.p2), box);
      if (e.kind === 'dimension') {
        const { d1, d2 } = dimensionGeometry(this.doc.point(e.p1), this.doc.point(e.p2), e.offset);
        return segmentIntersectsBox(d1, d2, box);
      }
      if (e.kind === 'equipment' || e.kind === 'shape') {
        const corners = e.kind === 'equipment' ? this.doc.cornersOf(e) : this.doc.shapePolygon(e);
        const centre = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
        return edgesOf(corners).some(([a, b]) => segmentIntersectsBox(a, b, box)) || insidePolygon(centre, corners);
      }
      return e.kind === 'circle' && circleIntersectsBox(this.doc.point(e.center), e.radius, box);
    });
  }

  private orderRev = -1;
  private orderIndex = new Map<Id, number>();

  /** Whether a comes after b in the drawing order (is drawn on top of it). */
  private later(a: Entity, b: Entity): boolean {
    if (this.orderRev !== this.doc.rev) {
      this.orderIndex = new Map([...this.doc.entities.keys()].map((id, i) => [id, i]));
      this.orderRev = this.doc.rev;
    }
    return (this.orderIndex.get(a.id) ?? 0) > (this.orderIndex.get(b.id) ?? 0);
  }
}
