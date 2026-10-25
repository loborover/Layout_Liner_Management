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
import type { DocumentModel } from './document';
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
    if (e.kind === 'equipment') {
      const corners = this.doc.cornersOf(e);
      if (insideConvex(p, corners)) return 0;
      return Math.min(...edgesOf(corners).map(([a, b]) => distToSegment(p, a, b)));
    }
    if (e.kind === 'line') return distToSegment(p, this.doc.point(e.p1), this.doc.point(e.p2));
    if (e.kind === 'dimension') {
      const { d1, d2 } = dimensionGeometry(this.doc.point(e.p1), this.doc.point(e.p2), e.offset);
      return distToSegment(p, d1, d2);
    }
    return Math.abs(dist(p, this.doc.point(e.center)) - e.radius);
  }

  /** Nearest editable entity within tol (mm) of p. */
  pick(p: Vec2, tol: number): Entity | null {
    let best: Entity | null = null;
    let bestD = tol;
    for (const e of this.query({ minX: p.x - tol, minY: p.y - tol, maxX: p.x + tol, maxY: p.y + tol })) {
      if (!this.doc.isEditable(e)) continue;
      const d = this.distanceTo(e, p);
      if (d <= bestD) {
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
      if (e.kind === 'line') return segmentIntersectsBox(this.doc.point(e.p1), this.doc.point(e.p2), box);
      if (e.kind === 'dimension') {
        const { d1, d2 } = dimensionGeometry(this.doc.point(e.p1), this.doc.point(e.p2), e.offset);
        return segmentIntersectsBox(d1, d2, box);
      }
      if (e.kind === 'equipment') {
        const corners = this.doc.cornersOf(e);
        const centre = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
        return edgesOf(corners).some(([a, b]) => segmentIntersectsBox(a, b, box)) || insideConvex(centre, corners);
      }
      return circleIntersectsBox(this.doc.point(e.center), e.radius, box);
    });
  }
}
