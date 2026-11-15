/**
 * @file select.ts
 *
 * Selection tool: click/shift-click/window selection, dragging (with constrained drag support), dimension-line
 * drag, double-click value editing and Delete. Clicking right on a vertex selects the point itself (shared by the
 * lines, shapes and dimensions built on it), so a single corner can be dragged or given exact X, Y, Z.
 * The underlay image is selected and dragged the same way as objects (clicking it where no object is), unless it
 * is locked; its selection id is UNDERLAY_ID.
 */
import { type Vec2, boxFromPoints, dist, sub } from '../geom/vec';
import { dimensionGeometry } from '../geom/dimension';
import { Batch, type Command, MovePoints, RemoveEntities, SetDimensionOffsets, SetUnderlay, UpdateEntities } from '../model/commands';
import { UNDERLAY_ID } from '../model/selection';
import { deletionTargets } from '../model/edit';
import type { Id, Underlay } from '../model/types';
import type { ConstrainedDrag } from '../constraints/service';
import type { SnapQuery } from '../snap/snap';
import { formatLength } from '../view/format';
import { COLORS, type Painter } from '../view/renderer';
import type { Tool, ToolContext, ToolPointer } from './tool';

type State =
  | { kind: 'idle' }
  | { kind: 'press'; start: Vec2; startRaw: Vec2; startScreen: Vec2; onEntity: boolean }
  | {
      kind: 'move';
      start: Vec2;
      applied: Vec2;
      pointIds: Id[];
      dims: { id: Id; before: number }[];
      /** Set when the moved points belong to constrained geometry. */
      drag: ConstrainedDrag | null;
      /** The underlay before the drag, when it is selected and moves along. */
      underlay: Underlay | null;
    }
  | { kind: 'box'; start: Vec2; end: Vec2; additive: boolean };

const DRAG_THRESHOLD_PX = 4;

export class SelectTool implements Tool {
  readonly id = 'select';
  readonly hint =
    '클릭: 선택(꼭짓점·선의 중간점 위: 점 선택) · Shift+클릭: 추가/해제 · 드래그: 이동 또는 영역 선택(→ 포함, ← 걸침) · 더블클릭: 치수 값·반지름·설비 번호 입력 · Delete: 삭제';
  readonly cursor = 'default';
  private state: State = { kind: 'idle' };

  constructor(private readonly ctx: ToolContext) {}

  snapQuery(): SnapQuery {
    const s = this.state;
    // While dragging a selection, snap the grabbed point to other geometry, never to what is moving.
    if (s.kind === 'move' || (s.kind === 'press' && s.onEntity)) {
      const { doc, selection } = this.ctx;
      // A dragged point must not snap to the entities built on it, which move with it.
      // Points held on the dragged ones by coincident constraints follow too, so their objects are left out as well.
      const users = (pid: Id) => [pid, ...doc.coincidentWith(pid)].flatMap((q) => doc.pointUsers(q).map((e) => e.id));
      const exclude = new Set(
        selection.values().flatMap((id) => {
          if (doc.isVertex(id)) return doc.vertexPoints(id).flatMap(users);
          const e = doc.entities.get(id);
          return e ? [id, ...doc.pointIdsOf(e).flatMap((pid) => doc.coincidentWith(pid).flatMap((q) => doc.pointUsers(q).map((x) => x.id)))] : [];
        }),
      );
      return { from: s.start, exclude };
    }
    return {};
  }

  down(p: ToolPointer): void {
    if (p.button !== 0) return;
    const { selection } = this.ctx;
    const hit = this.hitAt(p.raw);
    if (hit) {
      if (p.shift) selection.toggle(hit);
      else if (!selection.has(hit)) selection.set([hit]);
    }
    // A press on a vertex starts the drag from the vertex itself, so it lands exactly on the snap target.
    const start = hit && this.ctx.doc.isVertex(hit) ? { ...this.ctx.doc.vertex(hit) } : p.world;
    this.state = { kind: 'press', start, startRaw: p.raw, startScreen: p.screen, onEntity: !!hit && selection.has(hit) };
  }

  move(p: ToolPointer): void {
    const { ctx } = this;
    const s = this.state;
    if (s.kind === 'idle') {
      ctx.setHover(this.hitAt(p.raw));
      return;
    }
    if (s.kind === 'press') {
      if (dist(p.screen, s.startScreen) < DRAG_THRESHOLD_PX) return;
      if (s.onEntity) {
        const pointIds = this.selectedPointIds();
        const u = ctx.doc.underlay;
        this.state = {
          kind: 'move',
          start: s.start,
          applied: { x: 0, y: 0 },
          pointIds,
          dims: this.attachedDimensions(pointIds),
          drag: ctx.constraints.beginDrag(pointIds),
          underlay: u && ctx.selection.has(UNDERLAY_ID) && !u.locked ? { ...u } : null,
        };
      } else {
        this.state = { kind: 'box', start: s.startRaw, end: p.raw, additive: p.shift };
        ctx.setHover(null);
      }
    }
    const t = this.state;
    if (t.kind === 'move') {
      const total = sub(p.world, t.start);
      if (t.drag) t.drag.update(total);
      else ctx.doc.translatePoints(t.pointIds, sub(total, t.applied));
      t.applied = total;
      if (t.underlay && ctx.doc.underlay) {
        ctx.doc.underlay.x = t.underlay.x + total.x;
        ctx.doc.underlay.y = t.underlay.y + total.y;
      }
      this.applyDimensionOffsets(t.dims, total);
      ctx.doc.changed();
    } else if (t.kind === 'box') {
      t.end = p.raw;
      ctx.requestRender();
    }
  }

  up(p: ToolPointer): void {
    const { ctx } = this;
    const s = this.state;
    this.state = { kind: 'idle' };
    if (s.kind === 'press' && !s.onEntity && !p.shift) {
      ctx.selection.clear();
    } else if (s.kind === 'move') {
      if (s.applied.x !== 0 || s.applied.y !== 0) {
        const steps: Command[] = [s.drag ? s.drag.finish() : new MovePoints(s.pointIds, s.applied)];
        if (s.underlay && ctx.doc.underlay) steps.push(new SetUnderlay('밑그림 이동', s.underlay, { ...ctx.doc.underlay }));
        if (s.dims.length > 0) steps.push(new SetDimensionOffsets(s.dims.map((d) => ({ ...d, after: this.offsetOf(d.id) }))));
        ctx.history.record(new Batch('이동', steps));
      }
    } else if (s.kind === 'box') {
      const crossing = s.end.x < s.start.x;
      const ids = ctx.index.select(boxFromPoints(s.start, s.end), crossing).map((e) => e.id);
      if (s.additive) ctx.selection.add(ids);
      else ctx.selection.set(ids);
    }
    ctx.requestRender();
  }

  /** Double-click a dimension to drive it with a value, a circle to set its radius, or equipment to renumber it. */
  doubleClick(p: ToolPointer): void {
    const { ctx } = this;
    const hit = ctx.index.pick(p.raw, ctx.pickTolerance());
    if (hit?.kind === 'dimension') {
      const a = ctx.doc.point(hit.p1);
      const b = ctx.doc.point(hit.p2);
      const current = hit.value ?? Math.hypot(b.x - a.x, b.y - a.y);
      const answer = ctx.ask('치수 값(mm)을 입력하십시오. 비워 두면 참조 치수(측정만)로 바뀝니다.', current.toFixed(1));
      if (answer === null) return;
      const value = answer.trim() === '' ? undefined : Number(answer);
      if (value !== undefined && !(value > 0)) return ctx.notify('0보다 큰 숫자를 입력하십시오.');
      void ctx.constraints.setDimensionValue(hit.id, value).then((r) => {
        if (!r.ok) ctx.notify(r.message);
      });
    } else if (hit?.kind === 'circle') {
      const answer = ctx.ask(`반지름(mm)을 입력하십시오. 현재 ${formatLength(hit.radius, 'mm')}`, hit.radius.toFixed(1));
      if (answer === null) return;
      const value = Number(answer);
      if (!(value > 0)) return ctx.notify('0보다 큰 숫자를 입력하십시오.');
      void ctx.constraints.setRadius(hit.id, value).then((r) => {
        if (!r.ok) ctx.notify(r.message);
      });
    } else if (hit?.kind === 'equipment') {
      const answer = ctx.ask('설비 번호를 입력하십시오.', hit.tag);
      if (answer === null || answer.trim() === hit.tag) return;
      ctx.history.execute(new UpdateEntities('설비 번호 변경', [hit], [{ ...hit, tag: answer.trim() }]));
    }
  }

  key(e: KeyboardEvent): boolean {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const { doc, selection } = this.ctx;
      const ids = deletionTargets(doc, selection.values());
      const underlay = selection.has(UNDERLAY_ID) ? doc.underlay : null;
      if (ids.length === 0 && !underlay) return false;
      selection.clear();
      const steps: Command[] = [];
      if (ids.length > 0) steps.push(new RemoveEntities(ids));
      if (underlay) steps.push(new SetUnderlay('밑그림 삭제', underlay, null));
      this.ctx.history.execute(steps.length === 1 ? steps[0] : new Batch('삭제', steps));
      return true;
    }
    return false;
  }

  interrupt(): void {
    const s = this.state;
    this.state = { kind: 'idle' };
    if (s.kind === 'move') {
      // Revert the live preview of the drag; nothing has been recorded yet.
      if (s.drag) s.drag.cancel();
      else this.ctx.doc.translatePoints(s.pointIds, { x: -s.applied.x, y: -s.applied.y });
      if (s.underlay && this.ctx.doc.underlay) Object.assign(this.ctx.doc.underlay, { x: s.underlay.x, y: s.underlay.y });
      for (const d of s.dims) this.setOffset(d.id, d.before);
      this.ctx.doc.changed();
    } else if (s.kind === 'box') {
      this.ctx.requestRender();
    }
  }

  cancel(): boolean {
    if (this.state.kind !== 'idle') {
      const gesture = this.state.kind === 'move' || this.state.kind === 'box';
      this.interrupt();
      if (gesture) return true;
    }
    if (this.ctx.selection.size > 0) {
      this.ctx.selection.clear();
      return true;
    }
    return false;
  }

  overlay(p: Painter): void {
    const s = this.state;
    if (s.kind !== 'box') return;
    const crossing = s.end.x < s.start.x;
    p.rect(s.start, s.end, crossing ? COLORS.snap : COLORS.selected, crossing ? COLORS.crossing : COLORS.window, crossing ? [5, 4] : []);
  }

  /**
   * What a click at p selects: a vertex when the cursor is on one (points win over the lines through them), else an
   * entity, else the underlay image. A point used only by a point object selects that object, so its name and layer can be edited too.
   */
  private hitAt(p: Vec2): Id | null {
    const { doc, index } = this.ctx;
    const tol = this.ctx.pickTolerance();
    const vertex = index.pickPoint(p, tol);
    if (vertex) {
      const users = doc.pointUsers(vertex);
      return users.length === 1 && users[0].kind === 'point' ? users[0].id : vertex;
    }
    const hit = index.pick(p, tol)?.id;
    if (hit) return hit;
    // The underlay sits under everything: it is picked only where no object is, and never when locked.
    const u = doc.underlay;
    if (u?.visible && !u.locked && p.x >= u.x && p.x <= u.x + u.width && p.y >= u.y && p.y <= u.y + u.height) return UNDERLAY_ID;
    return null;
  }

  /** Selected dimensions that stay attached to unmoved points; dragging them moves their dimension line. */
  private attachedDimensions(moving: Id[]): { id: Id; before: number }[] {
    const { doc, selection } = this.ctx;
    const moved = new Set(moving);
    return selection.values().flatMap((id) => {
      const e = doc.entities.get(id);
      if (e?.kind !== 'dimension' || !doc.isEditable(e) || (moved.has(e.p1) && moved.has(e.p2))) return [];
      return [{ id, before: e.offset }];
    });
  }

  private applyDimensionOffsets(dims: { id: Id; before: number }[], delta: Vec2): void {
    const { doc } = this.ctx;
    for (const d of dims) {
      const e = doc.entities.get(d.id);
      if (e?.kind !== 'dimension') continue;
      const { normal } = dimensionGeometry(doc.point(e.p1), doc.point(e.p2), 0);
      e.offset = d.before + delta.x * normal.x + delta.y * normal.y;
    }
  }

  private offsetOf(id: Id): number {
    const e = this.ctx.doc.entities.get(id);
    return e?.kind === 'dimension' ? e.offset : 0;
  }

  private setOffset(id: Id, offset: number): void {
    const e = this.ctx.doc.entities.get(id);
    if (e?.kind === 'dimension') e.offset = offset;
  }

  /**
   * Points moved by a drag. A selected dimension attached to unselected geometry stays attached:
   * its shared points move only when the geometry they belong to is selected too.
   */
  private selectedPointIds(): Id[] {
    const { doc, selection } = this.ctx;
    const ids = new Set<Id>();
    const dimensionPoints = new Set<Id>();
    for (const id of selection.values()) {
      if (doc.isVertex(id)) {
        if (doc.isPointEditable(id)) for (const pid of doc.vertexPoints(id)) ids.add(pid);
        continue;
      }
      const e = doc.entities.get(id);
      if (!e || !doc.isEditable(e)) continue;
      for (const pid of doc.pointIdsOf(e)) (e.kind === 'dimension' ? dimensionPoints : ids).add(pid);
    }
    const usedByUnselectedGeometry = new Set<Id>();
    for (const e of doc.entities.values()) {
      if (e.kind === 'dimension' || selection.has(e.id)) continue;
      for (const pid of doc.pointIdsOf(e)) usedByUnselectedGeometry.add(pid);
    }
    for (const pid of dimensionPoints) if (!usedByUnselectedGeometry.has(pid)) ids.add(pid);
    return [...ids];
  }
}
