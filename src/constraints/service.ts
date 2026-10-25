/**
 * @file service.ts
 *
 * High-level constraint operations used by the app and tools: adding constraints (validated by a trial solve),
 * driving dimensions, constrained drags and the degrees-of-freedom status. Produces undoable commands.
 * Related: src/constraints/solver.ts (planegcs wrapper), src/model/commands.ts.
 */
import {
  AddConstraints,
  Batch,
  type Command,
  type GeometryState,
  type History,
  SetConstraintValue,
  SetDimensionValue,
  SetGeometry,
  captureGeometry,
  restoreGeometry,
} from '../model/commands';
import type { DocumentModel } from '../model/document';
import { newId } from '../model/ids';
import type { Constraint, ConstraintKind, Id } from '../model/types';
import { type ConstraintCluster, constrainedClusters, hasConstraints, mergeClusters } from './components';
import { type ConstraintSolver, type SolveResult, loadSolver } from './solver';

export type Outcome = { ok: true } | { ok: false; message: string };

const failure = (r: SolveResult): Outcome => ({
  ok: false,
  message:
    r.degenerate
      ? '이 구속을 만족하려면 선이나 원이 한 점으로 줄어들어야 합니다.'
      : r.conflicting.length > 0
        ? '기존 구속과 충돌합니다.'
        : r.redundant.length > 0
          ? '이미 다른 구속으로 정해진 조건입니다(중복 구속).'
          : '구속을 만족하는 해를 찾지 못했습니다.',
});

function geometryOf(doc: DocumentModel, cluster: ConstraintCluster): GeometryState {
  const circles = [...cluster.entityIds].filter((id) => doc.entities.get(id)?.kind === 'circle');
  return captureGeometry(doc, cluster.pointIds, circles);
}

/** A drag of constrained geometry: the dragged points are held at the cursor and the rest is re-solved. */
export class ConstrainedDrag {
  private readonly before: GeometryState;
  private lastGood: GeometryState;

  constructor(
    private readonly doc: DocumentModel,
    private readonly solver: ConstraintSolver,
    private readonly cluster: ConstraintCluster,
    readonly moving: Id[],
  ) {
    this.before = this.snapshot();
    this.lastGood = this.before;
  }

  /** The cluster's geometry plus any dragged points outside it (unconstrained geometry selected alongside). */
  private snapshot(): GeometryState {
    const circles = [...this.cluster.entityIds].filter((id) => this.doc.entities.get(id)?.kind === 'circle');
    return captureGeometry(this.doc, new Set([...this.cluster.pointIds, ...this.moving]), circles);
  }

  /** Moves the dragged points by `delta` from where the drag started. Returns false if the solver could not follow. */
  update(delta: { x: number; y: number }): boolean {
    restoreGeometry(this.doc, this.before);
    this.doc.translatePoints(this.moving, delta);
    const held = new Set(this.moving);
    let r = this.solver.solve(this.doc, this.cluster, held);
    if (!r.ok) {
      // The constraints don't let the points go exactly there (e.g. a corner of a dimensioned room):
      // follow the cursor as far as they allow instead.
      restoreGeometry(this.doc, this.before);
      this.doc.translatePoints(this.moving, delta);
      r = this.solver.solveTowards(this.doc, this.cluster, held);
    }
    if (r.ok) this.lastGood = this.snapshot();
    else restoreGeometry(this.doc, this.lastGood);
    return r.ok;
  }

  cancel(): void {
    restoreGeometry(this.doc, this.before);
  }

  /** Command for the drag, already applied. */
  finish(): Command {
    return new SetGeometry('이동', this.before, this.snapshot());
  }
}

export interface ClusterStatus {
  /** Entities in clusters with no remaining freedom. */
  fullyConstrained: Set<Id>;
  clusters: number;
  dof: number;
}

/**
 * Applies constraints through the solver and keeps edits undoable.
 * The solver (WebAssembly) is loaded lazily the first time the drawing has constraints.
 */
export class ConstraintService {
  private solver: ConstraintSolver | null = null;
  private loading: Promise<ConstraintSolver> | null = null;

  constructor(
    private readonly doc: DocumentModel,
    private readonly history: History,
    private readonly load: () => Promise<ConstraintSolver> = loadSolver,
  ) {}

  get ready(): boolean {
    return this.solver !== null;
  }

  /** Starts loading the solver when the drawing needs it; resolves once it is available. */
  async ensure(): Promise<ConstraintSolver> {
    if (this.solver) return this.solver;
    this.loading ??= this.load().then((s) => (this.solver = s));
    return this.loading;
  }

  preloadIfNeeded(): void {
    if (!this.solver && hasConstraints(this.doc)) void this.ensure();
  }

  /** Adds constraints of one kind to the given refs and solves; nothing changes if they cannot be satisfied. */
  async add(kind: ConstraintKind, refsList: Id[][], value?: number): Promise<Outcome> {
    const solver = await this.ensure();
    const constraints: Constraint[] = refsList.map((refs) => ({
      id: newId('k'),
      kind,
      refs,
      ...(value !== undefined ? { value } : {}),
    }));
    const seeds = constraints.flatMap((c) => c.refs.flatMap((r) => this.pointsOf(r)));
    this.doc.addConstraints(constraints);
    const cluster = mergeClusters(constrainedClusters(this.doc, seeds));
    const before = geometryOf(this.doc, cluster);
    const r = solver.solve(this.doc, cluster);
    if (!r.ok) {
      this.doc.removeConstraints(constraints.map((c) => c.id));
      restoreGeometry(this.doc, before);
      return failure(r);
    }
    this.history.record(
      new Batch('구속 추가', [new AddConstraints(constraints), new SetGeometry('구속 풀이', before, geometryOf(this.doc, cluster))]),
    );
    return { ok: true };
  }

  /** Makes a dimension driving at `value` mm, or a reference dimension when `value` is undefined. */
  async setDimensionValue(id: Id, value: number | undefined): Promise<Outcome> {
    const e = this.doc.entities.get(id);
    if (e?.kind !== 'dimension') return { ok: false, message: '치수가 아닙니다.' };
    const previous = e.value;
    const change = new SetDimensionValue(id, previous, value);
    if (value === undefined) {
      this.history.execute(change);
      return { ok: true };
    }
    const solver = await this.ensure();
    change.apply(this.doc);
    const cluster = mergeClusters(constrainedClusters(this.doc, [e.p1, e.p2]));
    const before = geometryOf(this.doc, cluster);
    const r = solver.solve(this.doc, cluster);
    if (!r.ok) {
      change.revert(this.doc);
      restoreGeometry(this.doc, before);
      return failure(r);
    }
    this.history.record(new Batch('치수 값 변경', [change, new SetGeometry('구속 풀이', before, geometryOf(this.doc, cluster))]));
    return { ok: true };
  }

  /** Sets a circle's radius, as a radius constraint (replacing an existing one). */
  async setRadius(circleId: Id, value: number): Promise<Outcome> {
    const existing = [...this.doc.constraints.values()].find((c) => c.kind === 'radius' && c.refs[0] === circleId);
    if (!existing) return this.add('radius', [[circleId]], value);
    const solver = await this.ensure();
    const change = new SetConstraintValue(existing.id, existing.value, value);
    change.apply(this.doc);
    const cluster = mergeClusters(constrainedClusters(this.doc, this.pointsOf(circleId)));
    const before = geometryOf(this.doc, cluster);
    const r = solver.solve(this.doc, cluster);
    if (!r.ok) {
      change.revert(this.doc);
      restoreGeometry(this.doc, before);
      return failure(r);
    }
    this.history.record(new Batch('반지름 변경', [change, new SetGeometry('구속 풀이', before, geometryOf(this.doc, cluster))]));
    return { ok: true };
  }

  /** Starts a drag of the given points, or returns null when none of them is constrained. */
  beginDrag(pointIds: Id[]): ConstrainedDrag | null {
    if (!this.solver || pointIds.length === 0) return null;
    const clusters = constrainedClusters(this.doc, pointIds);
    if (clusters.length === 0) return null;
    const fixed = new Set(
      [...this.doc.constraints.values()].filter((c) => c.kind === 'fixed').flatMap((c) => c.refs),
    );
    const moving = pointIds.filter((p) => !fixed.has(p));
    return new ConstrainedDrag(this.doc, this.solver, mergeClusters(clusters), moving);
  }

  /** Degrees of freedom per cluster, for colouring fully constrained geometry. */
  status(): ClusterStatus | null {
    if (!this.solver) return null;
    const out: ClusterStatus = { fullyConstrained: new Set(), clusters: 0, dof: 0 };
    for (const cluster of constrainedClusters(this.doc)) {
      const r = this.solver.analyze(this.doc, cluster);
      out.clusters++;
      out.dof += r.dof;
      if (r.ok && r.dof === 0) for (const id of cluster.entityIds) out.fullyConstrained.add(id);
    }
    return out;
  }

  private pointsOf(ref: Id): Id[] {
    if (this.doc.points.has(ref)) return [ref];
    const e = this.doc.entities.get(ref);
    return e ? this.doc.pointIdsOf(e) : [];
  }
}
