/**
 * @file solver.ts
 *
 * Thin wrapper around planegcs (FreeCAD's sketch solver compiled to WebAssembly, LGPL-2.1). Translates the
 * document's points/lines/circles/constraints into planegcs primitives, solves and reads results back.
 * The WASM module is loaded lazily on first use so drawings without constraints never download it.
 */
import type { GcsWrapper } from '@salusoft89/planegcs';
import type { DocumentModel } from '../model/document';
import type { Id } from '../model/types';
import type { ConstraintCluster } from './components';

export interface SolveResult {
  ok: boolean;
  /** Ids of our constraints / driving dimensions that conflict or are redundant. */
  conflicting: Id[];
  redundant: Id[];
  /** Remaining degrees of freedom of the solved system. */
  dof: number;
  /** The solver satisfied the constraints by shrinking a line or circle to nothing; rejected. */
  degenerate: boolean;
}

/**
 * Below this (mm) a line or radius counts as collapsed. The solver tends to stop near, not at, zero
 * (tens of µm), and nothing in a floor plan is meaningfully shorter than half a millimetre.
 */
const COLLAPSED = 0.5;

/** How far (mm, or sine of an angle) a constraint between immovable points may be off and still hold. */
const TOLERANCE = 1e-3;
const ANGLE_TOLERANCE = 1e-6;

// planegcs SolveStatus: Success 0, Converged 1, Failed 2, SuccessfulSolutionInvalid 3.
const SOLVED = new Set([0, 1]);

/** Prefix of the temporary constraints that pull dragged points; never one of ours. */
const DRAG = '~drag~';

/** Planegcs constraint ids are ours with a suffix when one of our constraints maps to several. */
const ownerOf = (gcsId: string): Id => gcsId.split('#')[0];

/**
 * Thin adapter between the document model and planegcs (FreeCAD's sketch solver, WebAssembly).
 * Solves one cluster at a time and writes the result back into the document.
 */
export class ConstraintSolver {
  constructor(private readonly gcs: GcsWrapper) {
    this.gcs.debug_mode = 0; // NoDebug: planegcs otherwise logs every solve to the console
  }

  /**
   * Solves the cluster in place. `held` points keep their current position (e.g. the ones being dragged).
   * On failure the document is left as it was.
   */
  solve(doc: DocumentModel, cluster: ConstraintCluster, held: ReadonlySet<Id> = new Set()): SolveResult {
    return this.run(doc, cluster, held, true, false);
  }

  /**
   * Like `solve`, but `held` points only pull towards their current position: the constraints win and the
   * held points end up as close as the remaining freedom allows. Used when dragging over-constrained geometry.
   */
  solveTowards(doc: DocumentModel, cluster: ConstraintCluster, held: ReadonlySet<Id>): SolveResult {
    // planegcs reports failure whenever the temporary pulls can't all be met, which is the point here, but its
    // best effort is still useful: take it, then settle the real constraints exactly from there.
    const pulled = this.run(doc, cluster, held, true, true);
    if (!pulled.ok) return pulled;
    return this.run(doc, cluster, new Set(), true, false);
  }

  /** Solves without touching the document, to read the remaining degrees of freedom and any conflicts. */
  analyze(doc: DocumentModel, cluster: ConstraintCluster): SolveResult {
    return this.run(doc, cluster, new Set(), false, false);
  }

  private run(
    doc: DocumentModel,
    cluster: ConstraintCluster,
    targets: ReadonlySet<Id>,
    apply: boolean,
    soft: boolean,
  ): SolveResult {
    const held: ReadonlySet<Id> = soft ? new Set() : targets;
    const fixedByConstraint = new Set<Id>();
    for (const id of cluster.constraintIds) {
      const c = doc.constraints.get(id);
      if (c?.kind === 'fixed') for (const r of c.refs) fixedByConstraint.add(r);
    }

    const primitives: Parameters<GcsWrapper['push_primitives_and_params']>[0] = [];
    // planegcs requires referenced primitives to be pushed first: points, then geometry, then constraints.
    for (const id of cluster.pointIds) {
      const p = doc.point(id);
      primitives.push({ id, type: 'point', x: p.x, y: p.y, fixed: held.has(id) || fixedByConstraint.has(id) });
    }
    for (const id of cluster.entityIds) {
      const e = doc.entities.get(id);
      if (e?.kind === 'line') primitives.push({ id, type: 'line', p1_id: e.p1, p2_id: e.p2 });
      else if (e?.kind === 'circle') primitives.push({ id, type: 'circle', c_id: e.center, radius: e.radius });
    }
    // A constraint whose points are all immovable can't be influenced by solving; planegcs would report it
    // as redundant (e.g. horizontal on a fixed line, or a wall dragged rigidly), so it is left out and
    // only checked against the current geometry: if it doesn't already hold, it conflicts.
    const unmet: Id[] = [];
    const immovable = (pointIds: Id[]) => pointIds.every((p) => held.has(p) || fixedByConstraint.has(p));
    const pointsOf = (ref: Id) => {
      const e = doc.entities.get(ref);
      return e ? doc.pointIdsOf(e) : [ref];
    };
    for (const id of cluster.entityIds) {
      const e = doc.entities.get(id);
      if (e?.kind !== 'dimension' || e.value === undefined) continue;
      if (immovable([e.p1, e.p2])) {
        if (Math.abs(this.length(doc, e.p1, e.p2) - e.value) > TOLERANCE) unmet.push(id);
      } else {
        primitives.push({ id, type: 'p2p_distance', p1_id: e.p1, p2_id: e.p2, distance: e.value });
      }
    }
    for (const id of cluster.constraintIds) {
      const c = doc.constraints.get(id);
      if (!c) continue;
      const hasFreeSize = c.kind === 'radius' || (c.kind === 'equal' && doc.entities.get(c.refs[0])?.kind === 'circle');
      if (c.kind !== 'horizontal' && c.kind !== 'vertical' && !hasFreeSize && immovable(c.refs.flatMap(pointsOf))) {
        if (!this.holds(doc, c.kind, c.refs)) unmet.push(id);
        continue;
      }
      const [a, b] = c.refs;
      switch (c.kind) {
        case 'horizontal':
        case 'vertical':
          c.refs.forEach((l, i) => {
            if (!immovable(pointsOf(l))) {
              primitives.push({ id: `${id}#${i}`, type: c.kind === 'horizontal' ? 'horizontal_l' : 'vertical_l', l_id: l });
            } else if (!this.holds(doc, c.kind, [l]) && !unmet.includes(id)) unmet.push(id);
          });
          break;
        case 'parallel':
          primitives.push({ id, type: 'parallel', l1_id: a, l2_id: b });
          break;
        case 'perpendicular':
          primitives.push({ id, type: 'perpendicular_ll', l1_id: a, l2_id: b });
          break;
        case 'equal':
          if (doc.entities.get(a)?.kind === 'circle') primitives.push({ id, type: 'equal_radius_cc', c1_id: a, c2_id: b });
          else primitives.push({ id, type: 'equal_length', l1_id: a, l2_id: b });
          break;
        case 'radius':
          primitives.push({ id, type: 'circle_radius', c_id: a, radius: c.value ?? 0 });
          break;
        case 'fixed':
          break; // expressed through the points' fixed flag
      }
    }

    if (soft) {
      // planegcs solves temporary constraints only with the freedom the real ones leave.
      for (const id of targets) {
        if (fixedByConstraint.has(id) || !cluster.pointIds.has(id)) continue;
        const p = doc.point(id);
        primitives.push({ id: `${DRAG}x${id}`, type: 'coordinate_x', p_id: id, x: p.x, temporary: true });
        primitives.push({ id: `${DRAG}y${id}`, type: 'coordinate_y', p_id: id, y: p.y, temporary: true });
      }
    }

    this.gcs.clear_data();
    this.gcs.push_primitives_and_params(primitives);
    const status = this.gcs.solve();
    const ours = (ids: string[]) => ids.filter((id) => !id.startsWith(DRAG)).map(ownerOf);
    const conflicting = [...new Set([...unmet, ...ours(this.gcs.get_gcs_conflicting_constraints())])];
    const redundant = [...new Set(ours(this.gcs.get_gcs_redundant_constraints()))];
    const ok = (soft || SOLVED.has(status)) && conflicting.length === 0 && redundant.length === 0;
    const dof = this.gcs.gcs.dof();
    let degenerate = false;
    if (ok && apply) {
      // Remember sizes so a solution that collapses geometry (e.g. perpendicular on two parallel lines) can be refused.
      const sizes = this.sizes(doc, cluster);
      const saved = [...cluster.pointIds].map((id) => {
        const pt = doc.point(id);
        return { pt, x: pt.x, y: pt.y };
      });
      const radii = [...cluster.entityIds].flatMap((id) => {
        const e = doc.entities.get(id);
        return e?.kind === 'circle' ? [{ e, r: e.radius }] : [];
      });
      this.gcs.apply_solution();
      for (const prim of this.gcs.sketch_index.get_primitives()) {
        if (prim.type === 'point') {
          const p = doc.points.get(prim.id);
          if (p) {
            p.x = prim.x;
            p.y = prim.y;
          }
        } else if (prim.type === 'circle') {
          const e = doc.entities.get(prim.id);
          if (e?.kind === 'circle') e.radius = prim.radius;
        }
      }
      const after = this.sizes(doc, cluster);
      degenerate =
        [...after].some(([id, size]) => !Number.isFinite(size) || (size < COLLAPSED && (sizes.get(id) ?? 0) >= COLLAPSED)) ||
        [...cluster.pointIds].some((id) => !Number.isFinite(doc.point(id).x) || !Number.isFinite(doc.point(id).y));
      if (degenerate) {
        for (const s of saved) {
          s.pt.x = s.x;
          s.pt.y = s.y;
        }
        for (const r of radii) r.e.radius = r.r;
      }
    }
    this.gcs.clear_data();
    return { ok: ok && !degenerate, conflicting, redundant, dof, degenerate };
  }

  private length(doc: DocumentModel, p1: Id, p2: Id): number {
    const a = doc.point(p1);
    const b = doc.point(p2);
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  /** Whether a constraint between lines already holds for the current geometry. */
  private holds(doc: DocumentModel, kind: string, refs: Id[]): boolean {
    const dirs = refs.map((id) => {
      const e = doc.entities.get(id);
      if (e?.kind !== 'line') return null;
      const a = doc.point(e.p1);
      const b = doc.point(e.p2);
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      return { x: (b.x - a.x) / len, y: (b.y - a.y) / len, len: Math.hypot(b.x - a.x, b.y - a.y) };
    });
    if (dirs.some((d) => d === null)) return true;
    const [u, v] = dirs as { x: number; y: number; len: number }[];
    switch (kind) {
      case 'horizontal':
        return Math.abs(u.y) * u.len <= TOLERANCE;
      case 'vertical':
        return Math.abs(u.x) * u.len <= TOLERANCE;
      case 'parallel':
        return Math.abs(u.x * v.y - u.y * v.x) <= ANGLE_TOLERANCE;
      case 'perpendicular':
        return Math.abs(u.x * v.x + u.y * v.y) <= ANGLE_TOLERANCE;
      case 'equal':
        return Math.abs(u.len - v.len) <= TOLERANCE;
      default:
        return true;
    }
  }

  /** Line lengths and circle radii in the cluster. */
  private sizes(doc: DocumentModel, cluster: ConstraintCluster): Map<Id, number> {
    const out = new Map<Id, number>();
    for (const id of cluster.entityIds) {
      const e = doc.entities.get(id);
      if (e?.kind === 'line') {
        const a = doc.point(e.p1);
        const b = doc.point(e.p2);
        out.set(id, Math.hypot(b.x - a.x, b.y - a.y));
      } else if (e?.kind === 'circle') out.set(id, e.radius);
    }
    return out;
  }

  destroy(): void {
    this.gcs.destroy_gcs_module();
  }
}

let loading: Promise<ConstraintSolver> | null = null;

/** Loads the solver on first use; the WebAssembly module (~480 KB) is fetched only when constraints are used. */
export function loadSolver(): Promise<ConstraintSolver> {
  loading ??= (async () => {
    const [{ init_planegcs_module, GcsWrapper }, { default: wasmUrl }] = await Promise.all([
      import('@salusoft89/planegcs'),
      import('@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url'),
    ]);
    const mod = await init_planegcs_module({ locateFile: () => wasmUrl });
    return new ConstraintSolver(new GcsWrapper(new mod.GcsSystem()));
  })();
  return loading;
}
