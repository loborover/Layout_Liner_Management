/**
 * @file draw.ts
 *
 * Drawing tools: point object, chained line, rectangle, circle and aligned dimension. Each click produces an AddItems command.
 */
import { offsetThrough } from '../geom/dimension';
import { type Vec2, angleDeg, dist } from '../geom/vec';
import { AddConstraints, AddItems, Batch, type Command } from '../model/commands';
import { linePath } from '../model/edit';
import { newId } from '../model/ids';
import { type Constraint, type Entity, type Id, type LineEntity, type Point, type ShapeEntity } from '../model/types';
import { formatAngle, formatLength } from '../view/format';
import { COLORS, type Painter } from '../view/renderer';
import type { SnapQuery } from '../snap/snap';
import type { Tool, ToolContext, ToolPointer } from './tool';

const DASH = [6, 4];

const point = (p: Vec2): Point => ({ id: newId('p'), x: p.x, y: p.y });

/** The document point the cursor snapped onto, if any. */
export function existingPoint(ctx: ToolContext, p: ToolPointer): Point | null {
  const id = p.snap?.pointId;
  return id && ctx.doc.points.has(id) ? ctx.doc.point(id) : null;
}
/** Coincident constraint holding a new object's point on another object's point, so the two stay separate objects. */
function coincident(a: Id, b: Id): Constraint {
  return { id: newId('k'), kind: 'coincident', refs: [a, b] };
}

/** AddItems plus the coincident constraints that tie the new points to existing ones, as one step. */
function addWithLinks(points: Point[], entities: Entity[], links: Constraint[]): Command {
  const add = new AddItems(points, entities);
  return links.length > 0 ? new Batch('추가', [add, new AddConstraints(links)]) : add;
}

function line(ctx: ToolContext, p1: Id, p2: Id): LineEntity {
  const stroke = ctx.lineStyle?.();
  return { id: newId('e'), kind: 'line', p1, p2, layer: ctx.layer(), ...(stroke ? { stroke: { ...stroke } } : {}) };
}

/** Shape over a closed chain of lines: `points[i]` → `points[i+1]` is `lines[i]`. */
function shapeOf(ctx: ToolContext, points: Id[], lines: Id[]): ShapeEntity {
  const n = [...ctx.doc.entities.values()].filter((e) => e.kind === 'shape').length + 1;
  return { id: newId('e'), kind: 'shape', points, edges: lines, layer: ctx.layer(), name: `도형 ${n}` };
}

/**
 * Chained line tool: each click adds a segment joined to the previous one. Closing the chain on its first point
 * also creates a shape (face) over the loop, in the same undo step. Segments of one chain share their points.
 * Starting or ending on another object's point gives the chain its own point there, held by a coincident
 * constraint, so the objects stay separate and can be pulled apart later (구속 해제 or 점 분리).
 * With Ctrl held, the cursor snaps only to existing points of visible objects and joins them by sharing the point,
 * and a segment that ends on an existing point which closes a loop with existing lines (not only the chain's own
 * start) also makes that loop a shape.
 */
export class LineTool implements Tool {
  readonly id = 'line';
  readonly hint =
    '클릭: 점 추가(연속 선) · 다른 객체의 점 클릭: 일치 구속으로 연결(분리 가능) · 시작점 클릭: 닫기 · Ctrl: 기존 점을 공유해 잇고, 닫히면 도형 · Shift: 수평/수직 · 우클릭/Esc: 종료';
  readonly cursor = 'crosshair';
  /** Start of the current segment. Not yet in the document when `pending` is true. */
  private start: Point | null = null;
  private pending = false;
  /** Existing point the pending start sits on (coincident constraint added with the first segment). */
  private startLink: Id | null = null;
  private first: Point | null = null;
  /** Points and lines of the current chain, in drawing order, for the shape made when it closes. */
  private chainPoints: Id[] = [];
  private chainLines: Id[] = [];
  private cursorPos: Vec2 | null = null;

  constructor(private readonly ctx: ToolContext) {}

  down(p: ToolPointer): void {
    if (p.button === 2) {
      this.cancel();
      return;
    }
    if (p.button !== 0) return;
    const { doc } = this.ctx;
    // The chain's last point can disappear through undo; start a fresh chain then.
    if (this.start && !this.pending && !doc.points.has(this.start.id)) this.reset();
    const snapped = existingPoint(this.ctx, p);
    if (!this.start) {
      // Ctrl joins by sharing the point; otherwise the chain gets its own point, held there by a constraint.
      const share = snapped && p.ctrl;
      this.start = share ? snapped : point(snapped ?? p.world);
      this.startLink = snapped && !share ? snapped.id : null;
      this.first = this.start;
      this.pending = !share;
      this.chainPoints = [this.start.id];
      this.chainLines = [];
      return;
    }
    // Back on the chain's own first point (or on the object point it started from): close the outline.
    const closing = !!snapped && !!this.first && this.chainLines.length >= 2 && dist(snapped, this.first) < 1e-9 && doc.points.has(this.first.id);
    const own = snapped && this.chainPoints.includes(snapped.id);
    const existing = closing ? this.first : snapped && (own || p.ctrl) ? snapped : null;
    const end = existing ?? point(snapped ?? p.world);
    if (end.id === this.start.id || dist(end, this.start) < 1e-9) return;
    const newPoints = [...(this.pending ? [this.start] : []), ...(existing ? [] : [end])];
    const links = [
      ...(this.pending && this.startLink ? [coincident(this.start.id, this.startLink)] : []),
      ...(snapped && !existing ? [coincident(end.id, snapped.id)] : []),
    ];
    const seg = line(this.ctx, this.start.id, end.id);
    this.chainLines.push(seg.id);
    if (existing && existing.id === this.first?.id) {
      // Outline closed on its first point: the loop becomes a shape.
      const add = addWithLinks(newPoints, [seg], links);
      // An undo during the chain may have removed earlier segments; then there is no loop to fill.
      const closed = this.chainLines.length >= 3 && this.chainLines.slice(0, -1).every((id) => doc.entities.has(id));
      this.ctx.history.execute(
        closed ? new Batch('도형 그리기', [add, new AddItems([], [shapeOf(this.ctx, [...this.chainPoints], [...this.chainLines])])]) : add,
      );
      this.reset();
    } else {
      const add = addWithLinks(newPoints, [seg], links);
      // Ctrl onto an existing point: if that closes a loop through existing lines, fill it as a shape.
      const loop = p.ctrl && existing && !this.pending ? this.loopThrough(this.start.id, existing.id) : null;
      if (loop) {
        const shape = shapeOf(this.ctx, [this.start.id, ...loop.points], [seg.id, ...loop.edges]);
        this.ctx.history.execute(new Batch('도형 그리기', [add, new AddItems([], [shape])]));
        this.ctx.notify(`닫힌 선으로 ${shape.name}을(를) 만들었습니다.`);
        this.reset();
        this.ctx.requestRender();
        return;
      }
      this.ctx.history.execute(add);
      this.chainPoints.push(end.id);
      this.start = doc.point(end.id);
      this.pending = false;
      this.startLink = null;
    }
    this.ctx.requestRender();
  }

  snapQuery(): SnapQuery {
    return { from: this.start };
  }

  move(p: ToolPointer): void {
    this.cursorPos = p.world;
    this.ctx.requestRender();
  }

  up(): void {}

  cancel(): boolean {
    const active = this.start !== null;
    this.reset();
    this.ctx.requestRender();
    return active;
  }

  deactivate(): void {
    this.reset();
  }

  overlay(p: Painter): void {
    if (!this.cursorPos) return;
    p.marker(this.cursorPos, COLORS.preview, 4);
    if (!this.start) return;
    p.line(this.start, this.cursorPos, COLORS.preview, 1.5, DASH);
    const unit = this.ctx.unit();
    p.label(this.cursorPos, `${formatLength(dist(this.start, this.cursorPos), unit)} · ${formatAngle(angleDeg(this.start, this.cursorPos))}`);
  }

  /**
   * Loop closed by a new segment start → end: the shortest chain of existing editable lines from end back to start.
   * Returns it as points (from end) and edges. The new segment is in no shape yet, so the loop is never a duplicate.
   */
  private loopThrough(start: Id, end: Id): { points: Id[]; edges: Id[] } | null {
    const { doc } = this.ctx;
    const path = linePath(doc, end, start, (e) => doc.isEditable(e));
    return path && path.edges.length >= 2 ? path : null;
  }

  private reset(): void {
    this.start = null;
    this.startLink = null;
    this.first = null;
    this.pending = false;
    this.chainPoints = [];
    this.chainLines = [];
  }
}

/** Axis-aligned rectangle from two corners, stored as four connected lines and a shape over them. */
export class RectTool implements Tool {
  readonly id = 'rect';
  readonly hint = '클릭: 첫 모서리 → 클릭: 반대 모서리 · 네 모서리는 직각으로 구속됩니다 · Esc: 취소';
  readonly cursor = 'crosshair';
  private corner: Vec2 | null = null;
  /** Existing point the first corner was snapped onto (it gets a coincident constraint). */
  private cornerLink: Id | null = null;
  private cursorPos: Vec2 | null = null;

  constructor(private readonly ctx: ToolContext) {}

  snapQuery(): SnapQuery {
    return { from: this.corner };
  }

  down(p: ToolPointer): void {
    if (p.button === 2) {
      this.cancel();
      return;
    }
    if (p.button !== 0) return;
    if (!this.corner) {
      this.corner = p.world;
      this.cornerLink = existingPoint(this.ctx, p)?.id ?? null;
      return;
    }
    const a = this.corner;
    const b = p.world;
    if (Math.abs(a.x - b.x) < 1e-9 || Math.abs(a.y - b.y) < 1e-9) return;
    const pts = [point(a), point({ x: b.x, y: a.y }), point(b), point({ x: a.x, y: b.y })];
    const lines = pts.map((pt, i) => line(this.ctx, pt.id, pts[(i + 1) % 4].id));
    const shape = shapeOf(this.ctx, pts.map((pt) => pt.id), lines.map((l) => l.id));
    // Corners snapped onto other objects' points stay on them through coincident constraints (separable).
    const endLink = existingPoint(this.ctx, p)?.id;
    const links = [
      ...(this.cornerLink && this.ctx.doc.points.has(this.cornerLink) ? [coincident(pts[0].id, this.cornerLink)] : []),
      ...(endLink ? [coincident(pts[2].id, endLink)] : []),
    ];
    // A rectangle keeps its right angles (the user's request, 2026-11-15): three corners are enough, the fourth
    // follows (a fourth constraint would be redundant and the solver would refuse the drawing).
    const square = [0, 1, 2].map((i): Constraint => ({ id: newId('k'), kind: 'perpendicular', refs: [lines[i].id, lines[i + 1].id] }));
    this.ctx.history.execute(addWithLinks(pts, [...lines, shape], [...square, ...links]));
    this.corner = null;
    this.cornerLink = null;
  }

  move(p: ToolPointer): void {
    this.cursorPos = p.world;
    this.ctx.requestRender();
  }

  up(): void {}

  cancel(): boolean {
    const active = this.corner !== null;
    this.corner = null;
    this.ctx.requestRender();
    return active;
  }

  deactivate(): void {
    this.corner = null;
  }

  overlay(p: Painter): void {
    if (!this.cursorPos) return;
    p.marker(this.cursorPos, COLORS.preview, 4);
    if (!this.corner) return;
    p.rect(this.corner, this.cursorPos, COLORS.preview, undefined, DASH);
    const unit = this.ctx.unit();
    const w = Math.abs(this.cursorPos.x - this.corner.x);
    const h = Math.abs(this.cursorPos.y - this.corner.y);
    p.label(this.cursorPos, `${formatLength(w, unit)} × ${formatLength(h, unit)}`);
  }
}

/** Circle from centre and a point on the circumference. */
/**
 * Point object tool: each click places a standalone point (a reference or survey point, a sensor location). Clicking
 * an existing point puts the new point on it with a coincident constraint (Ctrl: shares that point instead).
 */
export class PointTool implements Tool {
  readonly id = 'point';
  readonly hint = '클릭: 점 놓기(기존 점 위면 일치 구속, Ctrl: 그 점을 공유) · 속성 패널에서 X, Y, Z 입력 · Esc: 끝내기';
  readonly cursor = 'crosshair';
  private cursorPos: Vec2 | null = null;

  constructor(private readonly ctx: ToolContext) {}

  snapQuery(): SnapQuery {
    return {};
  }

  down(p: ToolPointer): void {
    if (p.button !== 0) return;
    const { doc } = this.ctx;
    const snapped = existingPoint(this.ctx, p);
    const shared = snapped && p.ctrl ? snapped : null;
    const taken = snapped && [snapped.id, ...doc.coincidentWith(snapped.id)].some((id) => doc.pointUsers(id).some((e) => e.kind === 'point'));
    if (taken) return this.ctx.notify('이 위치에는 이미 점 객체가 있습니다.');
    const at = shared ?? point(snapped ?? p.world);
    const e: Entity = { id: newId('e'), kind: 'point', at: at.id, layer: this.ctx.layer() };
    this.ctx.history.execute(addWithLinks(shared ? [] : [at], [e], snapped && !shared ? [coincident(at.id, snapped.id)] : []));
  }

  move(p: ToolPointer): void {
    this.cursorPos = p.world;
    this.ctx.requestRender();
  }

  up(): void {}

  cancel(): boolean {
    return false;
  }

  overlay(p: Painter): void {
    if (this.cursorPos) p.marker(this.cursorPos, COLORS.preview, 4);
  }
}

export class CircleTool implements Tool {
  readonly id = 'circle';
  readonly hint = '클릭: 중심 → 클릭: 반지름 · Esc: 취소';
  readonly cursor = 'crosshair';
  private centre: Vec2 | null = null;
  private centreLink: Id | null = null;
  private centreShared: Id | null = null;
  private cursorPos: Vec2 | null = null;

  constructor(private readonly ctx: ToolContext) {}

  snapQuery(): SnapQuery {
    return { from: this.centre };
  }

  down(p: ToolPointer): void {
    if (p.button === 2) {
      this.cancel();
      return;
    }
    if (p.button !== 0) return;
    if (!this.centre) {
      this.centre = p.world;
      // Like lines: a centre snapped to another object's point gets its own point held there (Ctrl shares it).
      const snapped = existingPoint(this.ctx, p);
      this.centreShared = snapped && p.ctrl ? snapped.id : null;
      this.centreLink = snapped && !p.ctrl ? snapped.id : null;
      return;
    }
    const r = dist(this.centre, p.world);
    if (r < 1e-9) return;
    const { doc } = this.ctx;
    const shared = this.centreShared && doc.points.has(this.centreShared) ? this.centreShared : null;
    const link = this.centreLink && doc.points.has(this.centreLink) ? this.centreLink : null;
    const c = shared ? null : point(this.centre);
    const circle: Entity = { id: newId('e'), kind: 'circle', center: shared ?? c!.id, radius: r, layer: this.ctx.layer() };
    this.ctx.history.execute(addWithLinks(c ? [c] : [], [circle], c && link ? [coincident(c.id, link)] : []));
    this.reset();
  }

  private reset(): void {
    this.centre = null;
    this.centreLink = null;
    this.centreShared = null;
  }

  move(p: ToolPointer): void {
    this.cursorPos = p.world;
    this.ctx.requestRender();
  }

  up(): void {}

  cancel(): boolean {
    const active = this.centre !== null;
    this.reset();
    this.ctx.requestRender();
    return active;
  }

  deactivate(): void {
    this.reset();
  }

  overlay(p: Painter): void {
    if (!this.cursorPos) return;
    p.marker(this.cursorPos, COLORS.preview, 4);
    if (!this.centre) return;
    const r = dist(this.centre, this.cursorPos);
    p.circle(this.centre, r, COLORS.preview, 1.5, DASH);
    p.line(this.centre, this.cursorPos, COLORS.preview, 1, DASH);
    p.label(this.cursorPos, `R ${formatLength(r, this.ctx.unit())}`);
  }
}

/**
 * Dimension line: two points, then where the line goes. A dimension placed on existing points drives them: it
 * holds the distance it was drawn at (a constraint, not a measurement) until its value is changed or it is
 * turned into a reference dimension (blank value). One placed on empty space has nothing to hold, so it stays a
 * reference dimension. Measuring without changing anything is the 측정 tab's job.
 */
export class DimensionTool implements Tool {
  readonly id = 'dimension';
  readonly hint =
    '클릭: 첫 점 → 클릭: 둘째 점 → 클릭: 치수선 위치 · 형상의 점에 붙이면 그 거리로 구속됩니다(값은 더블클릭해 수정) · Esc: 취소';
  readonly cursor = 'crosshair';
  private p1: Point | null = null;
  private p2: Point | null = null;
  private cursorPos: Vec2 | null = null;

  constructor(private readonly ctx: ToolContext) {}

  snapQuery(): SnapQuery {
    return { from: this.p2 ? null : this.p1 };
  }

  down(p: ToolPointer): void {
    if (p.button === 2) {
      this.cancel();
      return;
    }
    if (p.button !== 0) return;
    if (!this.p1) {
      this.p1 = existingPoint(this.ctx, p) ?? point(p.world);
      return;
    }
    if (!this.p2) {
      const p2 = existingPoint(this.ctx, p) ?? point(p.world);
      if (p2.id !== this.p1.id && dist(p2, this.p1) > 1e-9) this.p2 = p2;
      return;
    }
    const { doc } = this.ctx;
    const fresh = [this.p1, this.p2].filter((pt) => !doc.points.has(pt.id));
    const offset = offsetThrough(this.p1, this.p2, p.world);
    const id = newId('e');
    this.ctx.history.execute(new AddItems(fresh, [{ id, kind: 'dimension', p1: this.p1.id, p2: this.p2.id, offset, layer: this.ctx.layer() }]));
    if (fresh.length === 0) {
      const length = dist(this.p1, this.p2);
      this.ctx.constraints
        .setDimensionValue(id, length)
        .then((r) => {
          if (!r.ok) this.ctx.notify(`${r.message} 이 치수는 참조 치수(측정값 표시)로 남깁니다.`);
        })
        .catch((err) => this.ctx.notify(`구속 솔버를 불러오지 못해 참조 치수로 남깁니다: ${String(err)}`));
    }
    this.p1 = this.p2 = null;
  }

  move(p: ToolPointer): void {
    this.cursorPos = p.world;
    this.ctx.requestRender();
  }

  up(): void {}

  cancel(): boolean {
    const active = this.p1 !== null;
    this.p1 = this.p2 = null;
    this.ctx.requestRender();
    return active;
  }

  deactivate(): void {
    this.p1 = this.p2 = null;
  }

  overlay(p: Painter): void {
    if (!this.cursorPos) return;
    p.marker(this.cursorPos, COLORS.preview, 4);
    if (!this.p1) return;
    const unit = this.ctx.unit();
    if (!this.p2) {
      p.line(this.p1, this.cursorPos, COLORS.preview, 1, DASH);
      p.label(this.cursorPos, formatLength(dist(this.p1, this.cursorPos), unit));
      return;
    }
    p.dimension(this.p1, this.p2, offsetThrough(this.p1, this.p2, this.cursorPos), formatLength(dist(this.p1, this.p2), unit));
  }
}
