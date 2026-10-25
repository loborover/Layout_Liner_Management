import type { DocumentModel } from '../model/document';
import type { Id } from '../model/types';

/** A set of geometry connected through shared points and constraints, solved as one system. */
export interface ConstraintCluster {
  pointIds: Set<Id>;
  entityIds: Set<Id>;
  constraintIds: Set<Id>;
}

class UnionFind {
  private parent = new Map<Id, Id>();

  find(x: Id): Id {
    let root = x;
    while (this.parent.has(root) && this.parent.get(root) !== root) root = this.parent.get(root)!;
    // Path compression.
    let cur = x;
    while (cur !== root) {
      const next = this.parent.get(cur) ?? root;
      this.parent.set(cur, root);
      cur = next;
    }
    if (!this.parent.has(root)) this.parent.set(root, root);
    return root;
  }

  union(a: Id, b: Id): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/** Point ids that an entity or point reference stands for. */
function pointsOfRef(doc: DocumentModel, ref: Id): Id[] {
  if (doc.points.has(ref)) return [ref];
  const e = doc.entities.get(ref);
  return e ? doc.pointIdsOf(e) : [];
}

/** True when any constraint or driving dimension exists, i.e. the solver is needed at all. */
export function hasConstraints(doc: DocumentModel): boolean {
  if (doc.constraints.size > 0) return true;
  for (const e of doc.entities.values()) if (e.kind === 'dimension' && e.value !== undefined) return true;
  return false;
}

/**
 * Clusters that contain at least one constraint (or driving dimension) and touch any of the seed points.
 * Geometry outside these clusters is unaffected by solving and is left out of the solver.
 */
export function constrainedClusters(doc: DocumentModel, seedPointIds?: Iterable<Id>): ConstraintCluster[] {
  const uf = new UnionFind();
  for (const e of doc.entities.values()) {
    if (e.kind === 'dimension' && e.value === undefined) continue; // reference dimensions don't link anything
    const pts = doc.pointIdsOf(e);
    for (const p of pts.slice(1)) uf.union(pts[0], p);
  }
  for (const c of doc.constraints.values()) {
    const pts = c.refs.flatMap((r) => pointsOfRef(doc, r));
    for (const p of pts.slice(1)) uf.union(pts[0], p);
  }

  const clusters = new Map<Id, ConstraintCluster & { constrained: boolean }>();
  const get = (pointId: Id) => {
    const root = uf.find(pointId);
    let c = clusters.get(root);
    if (!c) clusters.set(root, (c = { pointIds: new Set(), entityIds: new Set(), constraintIds: new Set(), constrained: false }));
    return c;
  };
  for (const e of doc.entities.values()) {
    const pts = doc.pointIdsOf(e);
    if (e.kind === 'dimension' && e.value === undefined) continue;
    const c = get(pts[0]);
    c.entityIds.add(e.id);
    for (const p of pts) c.pointIds.add(p);
    if (e.kind === 'dimension') c.constrained = true;
  }
  for (const k of doc.constraints.values()) {
    const pts = k.refs.flatMap((r) => pointsOfRef(doc, r));
    if (pts.length === 0) continue;
    const c = get(pts[0]);
    c.constraintIds.add(k.id);
    c.constrained = true;
  }

  const seeds = seedPointIds ? new Set([...seedPointIds].map((p) => uf.find(p))) : null;
  return [...clusters.entries()]
    .filter(([root, c]) => c.constrained && (!seeds || seeds.has(root)))
    .map(([, { pointIds, entityIds, constraintIds }]) => ({ pointIds, entityIds, constraintIds }));
}

export function mergeClusters(clusters: ConstraintCluster[]): ConstraintCluster {
  const out: ConstraintCluster = { pointIds: new Set(), entityIds: new Set(), constraintIds: new Set() };
  for (const c of clusters) {
    for (const id of c.pointIds) out.pointIds.add(id);
    for (const id of c.entityIds) out.entityIds.add(id);
    for (const id of c.constraintIds) out.constraintIds.add(id);
  }
  return out;
}
