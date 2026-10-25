import { type Vec2, boxFromPoints, dist, sub } from '../geom/vec';
import { MovePoints, RemoveEntities } from '../model/commands';
import type { Id } from '../model/types';
import { COLORS, type Painter } from '../view/renderer';
import type { Tool, ToolContext, ToolPointer } from './tool';

type State =
  | { kind: 'idle' }
  | { kind: 'press'; start: Vec2; startRaw: Vec2; startScreen: Vec2; onEntity: boolean }
  | { kind: 'move'; start: Vec2; applied: Vec2; pointIds: Id[] }
  | { kind: 'box'; start: Vec2; end: Vec2; additive: boolean };

const DRAG_THRESHOLD_PX = 4;

export class SelectTool implements Tool {
  readonly id = 'select';
  readonly hint = '클릭: 선택 · Shift+클릭: 추가/해제 · 드래그: 이동 또는 영역 선택(→ 완전 포함, ← 걸침) · Delete: 삭제';
  readonly cursor = 'default';
  private state: State = { kind: 'idle' };

  constructor(private readonly ctx: ToolContext) {}

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
        this.state = { kind: 'move', start: s.start, applied: { x: 0, y: 0 }, pointIds: this.selectedPointIds() };
      } else {
        this.state = { kind: 'box', start: s.startRaw, end: p.raw, additive: p.shift };
        ctx.setHover(null);
      }
    }
    const t = this.state;
    if (t.kind === 'move') {
      const total = sub(p.world, t.start);
      ctx.doc.translatePoints(t.pointIds, sub(total, t.applied));
      t.applied = total;
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
      if (s.applied.x !== 0 || s.applied.y !== 0) ctx.history.record(new MovePoints(s.pointIds, s.applied));
    } else if (s.kind === 'box') {
      const crossing = s.end.x < s.start.x;
      const ids = ctx.index.select(boxFromPoints(s.start, s.end), crossing).map((e) => e.id);
      if (s.additive) ctx.selection.add(ids);
      else ctx.selection.set(ids);
    }
    ctx.requestRender();
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
      this.ctx.doc.translatePoints(s.pointIds, { x: -s.applied.x, y: -s.applied.y });
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

  private selectedPointIds(): Id[] {
    const { doc, selection } = this.ctx;
    const ids = new Set<Id>();
    for (const id of selection.values()) {
      const e = doc.entities.get(id);
      if (e && doc.isEditable(e)) for (const pid of doc.pointIdsOf(e)) ids.add(pid);
    }
    return [...ids];
  }
}
