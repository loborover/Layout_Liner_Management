import { type Vec2, angleDeg, dist } from '../geom/vec';
import { AddItems } from '../model/commands';
import { newId } from '../model/ids';
import { DEFAULT_LAYER_ID, type Id, type LineEntity, type Point } from '../model/types';
import { formatAngle, formatLength } from '../view/format';
import { COLORS, type Painter } from '../view/renderer';
import type { Tool, ToolContext, ToolPointer } from './tool';

const DASH = [6, 4];

const point = (p: Vec2): Point => ({ id: newId('p'), x: p.x, y: p.y });
const line = (p1: Id, p2: Id): LineEntity => ({ id: newId('e'), kind: 'line', p1, p2, layer: DEFAULT_LAYER_ID });

/** Chained line tool: each click adds a segment joined to the previous one. */
export class LineTool implements Tool {
  readonly id = 'line';
  readonly hint = '클릭: 점 추가(연속 선) · 시작점 클릭: 닫기 · 우클릭/Esc: 종료';
  readonly cursor = 'crosshair';
  /** Start of the current segment. Not yet in the document when `pending` is true. */
  private start: Point | null = null;
  private pending = false;
  private first: Point | null = null;
  private cursorPos: Vec2 | null = null;

  constructor(private readonly ctx: ToolContext) {}

  down(p: ToolPointer): void {
    if (p.button === 2) {
      this.cancel();
      return;
    }
    if (p.button !== 0) return;
    // The chain's last point can disappear through undo; start a fresh chain then.
    if (this.start && !this.pending && !this.ctx.doc.points.has(this.start.id)) this.reset();
    if (!this.start) {
      this.start = point(p.world);
      this.first = this.start;
      this.pending = true;
      return;
    }
    if (dist(p.world, this.start) < 1e-9) return;

    // Clicking near the chain's first point closes the outline on that shared point.
    const closing =
      !this.pending &&
      this.first !== null &&
      this.ctx.doc.points.has(this.first.id) &&
      dist(p.raw, this.first) <= this.ctx.pickTolerance();
    const end = closing ? this.first! : point(p.world);
    const newPoints = [...(this.pending ? [this.start] : []), ...(closing ? [] : [end])];
    this.ctx.history.execute(new AddItems(newPoints, [line(this.start.id, end.id)]));
    if (closing) {
      this.reset();
    } else {
      this.start = this.ctx.doc.point(end.id);
      this.pending = false;
    }
    this.ctx.requestRender();
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

  private reset(): void {
    this.start = null;
    this.first = null;
    this.pending = false;
  }
}

/** Axis-aligned rectangle from two corners, stored as four connected lines. */
export class RectTool implements Tool {
  readonly id = 'rect';
  readonly hint = '클릭: 첫 모서리 → 클릭: 반대 모서리 · Esc: 취소';
  readonly cursor = 'crosshair';
  private corner: Vec2 | null = null;
  private cursorPos: Vec2 | null = null;

  constructor(private readonly ctx: ToolContext) {}

  down(p: ToolPointer): void {
    if (p.button === 2) {
      this.cancel();
      return;
    }
    if (p.button !== 0) return;
    if (!this.corner) {
      this.corner = p.world;
      return;
    }
    const a = this.corner;
    const b = p.world;
    if (Math.abs(a.x - b.x) < 1e-9 || Math.abs(a.y - b.y) < 1e-9) return;
    const pts = [point(a), point({ x: b.x, y: a.y }), point(b), point({ x: a.x, y: b.y })];
    const lines = pts.map((pt, i) => line(pt.id, pts[(i + 1) % 4].id));
    this.ctx.history.execute(new AddItems(pts, lines));
    this.corner = null;
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
export class CircleTool implements Tool {
  readonly id = 'circle';
  readonly hint = '클릭: 중심 → 클릭: 반지름 · Esc: 취소';
  readonly cursor = 'crosshair';
  private centre: Vec2 | null = null;
  private cursorPos: Vec2 | null = null;

  constructor(private readonly ctx: ToolContext) {}

  down(p: ToolPointer): void {
    if (p.button === 2) {
      this.cancel();
      return;
    }
    if (p.button !== 0) return;
    if (!this.centre) {
      this.centre = p.world;
      return;
    }
    const r = dist(this.centre, p.world);
    if (r < 1e-9) return;
    const c = point(this.centre);
    this.ctx.history.execute(
      new AddItems([c], [{ id: newId('e'), kind: 'circle', center: c.id, radius: r, layer: DEFAULT_LAYER_ID }]),
    );
    this.centre = null;
  }

  move(p: ToolPointer): void {
    this.cursorPos = p.world;
    this.ctx.requestRender();
  }

  up(): void {}

  cancel(): boolean {
    const active = this.centre !== null;
    this.centre = null;
    this.ctx.requestRender();
    return active;
  }

  deactivate(): void {
    this.centre = null;
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
