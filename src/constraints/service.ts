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
  MovePoints,
  type PointPosition,
  SetPoints,
  type GeometryState,
  type History,
  type Driving,
  SetDriving,
  SetGeometry,
  SetParameters,
  drivingOf,
  captureGeometry,
  restoreGeometry,
} from '../model/commands';
import type { DocumentModel } from '../model/document';
import { newId } from '../model/ids';
import { ExpressionError, type ExpressionFunction, evaluate, evaluateParameters, isPlainNumber, nameProblem, parseExpression, renameInExpression } from '../model/params';
import type { Constraint, ConstraintKind, Id, Parameter } from '../model/types';
import { type ConstraintCluster, constrainedClusters, hasConstraints, mergeClusters } from './components';
import { type ConstraintSolver, type SolveResult, loadSolver } from './solver';

/** `redundant` marks a failure only because the new constraint is already implied by others. */
export type Outcome = { ok: true } | { ok: false; message: string; redundant?: boolean };

const failure = (r: SolveResult): Outcome => ({
  ok: false,
  ...(!r.degenerate && r.conflicting.length === 0 && r.redundant.length > 0 ? { redundant: true } : {}),
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
  async add(kind: ConstraintKind, refsList: Id[][], value?: number, expression?: string): Promise<Outcome> {
    const driving = { ...(value !== undefined ? { value } : {}), ...(expression ? { expression } : {}) };
    return this.addAll(refsList.map((refs) => ({ kind, refs, ...driving })));
  }

  /**
   * Adds a distance or angle constraint. A distance between two lines also keeps them parallel (walls a set
   * distance apart), unless other constraints already do, in which case the extra parallel constraint would be
   * redundant and the distance alone is added.
   */
  async addDimension(kind: 'distance' | 'angle', refs: Id[], value: number, expression?: string): Promise<Outcome> {
    const lines = refs.length === 2 && refs.every((r) => this.doc.entities.get(r)?.kind === 'line');
    if (kind === 'distance' && lines) {
      const both = await this.addAll([
        { kind: 'parallel', refs },
        { kind, refs, value, ...(expression ? { expression } : {}) },
      ]);
      // Only a parallel constraint that other constraints already imply may be dropped; any other failure
      // (e.g. the lines are held at an angle) would leave the "parallel" distance between lines that aren't.
      if (both.ok || !both.redundant) return both;
    }
    return this.add(kind, [refs], value, expression);
  }

  /** Adds several constraints as one undo step and solves; nothing changes if they cannot all be satisfied. */
  async addAll(specs: Omit<Constraint, 'id'>[]): Promise<Outcome> {
    const solver = await this.ensure();
    const constraints: Constraint[] = specs.map((s) => ({ ...s, id: newId('k'), refs: [...s.refs] }));
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
    if (this.doc.entities.get(id)?.kind !== 'dimension') return { ok: false, message: '치수가 아닙니다.' };
    return this.applyDriving([{ id, after: value === undefined ? {} : { value } }], [], '치수 값 변경');
  }

  /** Sets a circle's radius, as a radius constraint (replacing an existing one). */
  async setRadius(circleId: Id, value: number): Promise<Outcome> {
    const existing = [...this.doc.constraints.values()].find((c) => c.kind === 'radius' && c.refs[0] === circleId);
    if (!existing) return this.add('radius', [[circleId]], value);
    return this.setValue(existing.id, value, '반지름 변경');
  }

  /**
   * Changes the value of a radius, distance or angle constraint and re-solves; nothing changes if the new value
   * can't be met. The constraint stops following an expression it had.
   */
  async setValue(constraintId: Id, value: number, label = '치수 값 변경'): Promise<Outcome> {
    const existing = this.doc.constraints.get(constraintId);
    if (!existing || existing.value === undefined) return { ok: false, message: '값을 가진 구속이 아닙니다.' };
    return this.applyDriving([{ id: constraintId, after: { value } }], [], label);
  }

  /**
   * What the user typed for a driving value: a number, or an expression of parameters and functions
   * ("폭 / 2", "=max(폭, 3000)"), which is kept so the value follows the parameters. Blank is `{}` (no value).
   */
  resolveInput(text: string): { ok: true; driving: Driving } | { ok: false; message: string } {
    if (text.trim() === '') return { ok: true, driving: {} };
    if (isPlainNumber(text)) return { ok: true, driving: { value: Number(text) } };
    try {
      const { values } = evaluateParameters(this.doc.parameters.values(), this.functions);
      const value = evaluate(text, { params: (n) => values.get(n), functions: this.functions });
      return { ok: true, driving: { value, expression: text.trim().replace(/^=\s*/, '') } };
    } catch (err) {
      return { ok: false, message: err instanceof ExpressionError ? err.message : String(err) };
    }
  }

  /**
   * Sets a constraint's or dimension's value from what the user typed (number or expression). Blank turns a
   * dimension into a reference dimension; constraints need a value.
   */
  async setDrivingText(id: Id, text: string): Promise<Outcome> {
    const r = this.resolveInput(text);
    if (!r.ok) return r;
    if (r.driving.value === undefined && this.doc.constraints.has(id)) return { ok: false, message: '값을 입력하십시오.' };
    return this.applyDriving([{ id, after: r.driving }], [], '치수 값 변경');
  }

  /** Extra expression functions (e.g. DB(...) from the data gateway); they win over the built-in ones. */
  functions: Record<string, ExpressionFunction> = {};

  /**
   * Replaces the parameters and re-applies every expression that uses them, solving the geometry, as one undo
   * step. Nothing changes if a resulting value can't be met.
   */
  async setParameters(next: Parameter[], label = '파라미터 변경'): Promise<Outcome> {
    const names = new Set<string>();
    for (const p of next) {
      const problem = nameProblem(p.name, [], undefined) ?? (names.has(p.name) ? `'${p.name}' 파라미터가 이미 있습니다.` : null);
      if (problem) return { ok: false, message: problem };
      names.add(p.name);
      try {
        parseExpression(p.expression);
      } catch (err) {
        return { ok: false, message: `${p.name}: ${(err as Error).message}` };
      }
    }
    const change = new SetParameters(SetParameters.capture(this.doc), next.map((p) => ({ ...p })), label);
    change.apply(this.doc);
    return this.reapply([change], label);
  }

  /**
   * Re-evaluates the parameters and every driving expression and solves the geometry (call when a value an
   * expression uses changed, e.g. a DB value arrived). Values that fail to evaluate keep their last result.
   */
  async reapplyParameters(): Promise<Outcome> {
    return this.reapply([], '파라미터 다시 계산');
  }

  /**
   * Renames a parameter and rewrites every expression that uses it (other parameters, constraints and dimension
   * lines). Values don't change, so nothing is solved; one undo step.
   */
  renameParameter(id: Id, to: string): Outcome {
    const p = this.doc.parameters.get(id);
    if (!p) return { ok: false, message: '파라미터가 없습니다.' };
    const problem = nameProblem(to, this.doc.parameters.values(), id);
    if (problem) return { ok: false, message: problem };
    const swap = (text: string) => renameInExpression(text, p.name, to);
    const before = SetParameters.capture(this.doc);
    const after = before.map((q) => ({ ...q, name: q.id === id ? to : q.name, expression: swap(q.expression) }));
    const steps: Command[] = [new SetParameters(before, after, '파라미터 이름 변경')];
    const targets: { id: Id; expression?: string }[] = [
      ...this.doc.constraints.values(),
      ...[...this.doc.entities.values()].filter((e) => e.kind === 'dimension'),
    ];
    for (const t of targets) {
      if (!t.expression || swap(t.expression) === t.expression) continue;
      const now = drivingOf(this.doc, t.id);
      steps.push(new SetDriving(t.id, now, { ...now, expression: swap(t.expression) }, '파라미터 이름 변경'));
    }
    this.history.execute(new Batch('파라미터 이름 변경', steps));
    return { ok: true };
  }

  /** Errors of parameters that currently fail to evaluate, by parameter id. */
  parameterErrors(): Map<Id, string> {
    const { errors } = evaluateParameters(this.doc.parameters.values(), this.functions);
    return new Map([...errors].map(([id, e]) => [id, e.message]));
  }

  private async reapply(extra: Command[], label: string): Promise<Outcome> {
    const { values } = evaluateParameters(this.doc.parameters.values(), this.functions);
    const steps = [...extra];
    // Cache new parameter values so they survive a failure later (e.g. the gateway going down).
    const cached = SetParameters.capture(this.doc);
    const refreshed = cached.map((p) => (values.has(p.name) ? { ...p, value: values.get(p.name) } : p));
    if (refreshed.some((p, i) => p.value !== cached[i].value)) {
      const cache = new SetParameters(cached, refreshed, label);
      cache.apply(this.doc);
      steps.push(cache);
    }
    const changes: { id: Id; after: Driving }[] = [];
    const targets: { id: Id; expression?: string; value?: number }[] = [
      ...this.doc.constraints.values(),
      ...[...this.doc.entities.values()].filter((e) => e.kind === 'dimension'),
    ];
    for (const t of targets) {
      if (!t.expression) continue;
      try {
        const value = evaluate(t.expression, { params: (n) => values.get(n), functions: this.functions });
        if (value !== t.value) changes.push({ id: t.id, after: { value, expression: t.expression } });
      } catch {
        // Keeps its last value; the panel shows the error.
      }
    }
    const r = await this.applyDriving(changes, steps, label);
    if (!r.ok) for (const c of [...steps].reverse()) c.revert(this.doc);
    return r;
  }

  /**
   * Applies new driving values (constraints or dimension entities) after `done` commands that are already
   * applied, solves everything they touch and records it all as one undo step. On failure only the driving
   * changes are rolled back; the caller reverts `done`.
   */
  private async applyDriving(changes: { id: Id; after: Driving }[], done: Command[], label: string): Promise<Outcome> {
    for (const { id, after } of changes) {
      const kind = this.doc.constraints.get(id)?.kind;
      if (after.value === undefined) continue;
      if (!(after.value > 0) || (kind === 'angle' && !(after.value < 180))) {
        return { ok: false, message: kind === 'angle' ? '각도는 0°보다 크고 180°보다 작아야 합니다.' : '0보다 큰 값을 입력하십시오.' };
      }
    }
    const commands = changes.map(({ id, after }) => new SetDriving(id, drivingOf(this.doc, id), after, label));
    if (commands.length === 0) {
      if (done.length > 0) this.history.record(new Batch(label, done));
      return { ok: true };
    }
    for (const c of commands) c.apply(this.doc);
    const seeds = changes.flatMap(({ id }) => {
      const c = this.doc.constraints.get(id);
      return c ? c.refs.flatMap((r) => this.pointsOf(r)) : this.pointsOf(id);
    });
    const clusters = constrainedClusters(this.doc, seeds);
    const steps: Command[] = [...done, ...commands];
    if (clusters.length > 0) {
      const solver = await this.ensure();
      const cluster = mergeClusters(clusters);
      const before = geometryOf(this.doc, cluster);
      const r = solver.solve(this.doc, cluster);
      if (!r.ok) {
        for (const c of [...commands].reverse()) c.revert(this.doc);
        restoreGeometry(this.doc, before);
        return failure(r);
      }
      steps.push(new SetGeometry('구속 풀이', before, geometryOf(this.doc, cluster)));
    }
    this.history.record(new Batch(label, steps));
    return { ok: true };
  }

  /**
   * Moves one point to an exact position (property panel, API). X/Y of constrained geometry go through the solver
   * like a drag, so the constraints still hold; Z never takes part in 2D constraints.
   */
  async setPoint(id: Id, to: PointPosition): Promise<Outcome> {
    if (!this.doc.isVertex(id)) return { ok: false, message: '점이 없습니다.' };
    if (![to.x, to.y, to.z ?? 0].every(Number.isFinite)) return { ok: false, message: '좌표는 숫자여야 합니다.' };
    // A line's midpoint moves both of its ends.
    const ids = this.doc.vertexPoints(id);
    const p = this.doc.vertex(id);
    const delta = { x: to.x - p.x, y: to.y - p.y };
    const steps: Command[] = [];
    if (delta.x !== 0 || delta.y !== 0) {
      if (constrainedClusters(this.doc, ids).length > 0) await this.ensure();
      const drag = this.beginDrag(ids);
      if (drag) {
        const reached = drag.update(delta) && Math.hypot(this.doc.vertex(id).x - to.x, this.doc.vertex(id).y - to.y) <= 1e-6;
        if (!reached) {
          drag.cancel();
          return { ok: false, message: '구속 조건 때문에 점을 그 위치로 옮길 수 없습니다.' };
        }
        steps.push(drag.finish());
      } else {
        const move = new MovePoints(ids, delta);
        move.apply(this.doc);
        steps.push(move);
      }
    }
    const dz = (to.z ?? 0) - (p.z ?? 0);
    if (dz !== 0) {
      const before = SetPoints.capture(this.doc, ids);
      const after = new Map(
        ids.map((pid) => {
          const q = this.doc.point(pid);
          const z = (q.z ?? 0) + dz;
          return [pid, { x: q.x, y: q.y, ...(z ? { z } : {}) }];
        }),
      );
      const lift = new SetPoints('높이 변경', before, after);
      lift.apply(this.doc);
      steps.push(lift);
    }
    if (steps.length > 0) this.history.record(new Batch('좌표 변경', steps));
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
