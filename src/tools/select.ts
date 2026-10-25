import { type Vec2, boxFromPoints, dist, sub } from '../geom/vec';
import { dimensionGeometry } from '../geom/dimension';
import { Batch, type Command, MovePoints, RemoveEntities, SetDimensionOffsets, UpdateEntities } from '../model/commands';
import type { Id } from '../model/types';
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
    }
  | { kind: 'box'; start: Vec2; end: Vec2; additive: boolean };

const DRAG_THRESHOLD_PX = 4;

export class SelectTool implements Tool {
  readonly id = 'select';
  readonly hint =
    '클릭: 선택 · Shift+클릭: 추가/해제 · 드래그: 이동 또는 영역 선택(→ 포함, ← 걸침) · 더블클릭: 치수 값·반지름·설비 번호 입력 · Delete: 삭제';
  readonly cursor = 'default';
  private state: State = { kind: 'idle' };

  constructor(private readonly ctx: ToolContext) {}

  snapQuery(): SnapQuery {
    const s = this.state;
    // While dragging a selection, snap the grabbed point to other geometry, never to what is moving.
    if (s.kind === 'move' || (s.kind === 'press' && s.onEntity)) {
      return { from: s.start, exclude: new Set(this.ctx.selection.values()) };
    }
    return {};
  }

  down(p: ToolPointer): void {
    if (p.button !== 0) return;
    const { index, selection } = this.ctx;
    const hit = index.pick(p.raw, this.ctx.pickTolerance());
    if (hit) {
      if (p.shift) selection.toggle(hit.id);
      else if (!selection.has(hit.id)) selection.set([hit.id]);
    }
    this.state = { kind: 'press', start: p.world, startRaw: p.raw, startScreen: p.screen, onEntity: !!hit && selection.has(hit.id) };
  }

  move(p: ToolPointer): void {
    const { ctx } = this;
    const s = this.state;
    if (s.kind === 'idle') {
      ctx.setHover(ctx.index.pick(p.raw, ctx.pickTolerance())?.id ?? null);
      return;
    }
    if (s.kind === 'press') {
      if (dist(p.screen, s.startScreen) < DRAG_THRESHOLD_PX) return;
      if (s.onEntity) {
        const pointIds = this.selectedPointIds();
        this.state = {
          kind: 'move',
          start: s.start,
          applied: { x: 0, y: 0 },
          pointIds,
          dims: this.attachedDimensions(pointIds),
          drag: ctx.constraints.beginDrag(pointIds),
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
      const ids = this.ctx.selection.values();
      if (ids.length === 0) return false;
      this.ctx.selection.clear();
      this.ctx.history.execute(new RemoveEntities(ids));
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
    p.rect(s.start, s.end, crossing ? '#16a34a' : COLORS.selected, crossing ? COLORS.crossing : COLORS.window, crossing ? [5, 4] : []);
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
