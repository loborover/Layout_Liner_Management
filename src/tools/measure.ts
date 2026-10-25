/**
 * @file measure.ts
 *
 * Measuring tools (distance, angle, area/perimeter). They only draw overlays and never change the document.
 */
import { type Vec2, angleDeg, dist } from '../geom/vec';
import { polygonArea, polygonPerimeter } from '../geom/polygon';
import type { SnapQuery } from '../snap/snap';
import { formatAngle, formatArea, formatLength } from '../view/format';
import { COLORS, type Painter } from '../view/renderer';
import type { Tool, ToolContext, ToolPointer } from './tool';

const MEASURE = '#7c3aed';
const MEASURE_FILL = 'rgba(124, 58, 237, 0.10)';
const DASH = [6, 4];

/**
 * Base for measuring tools: clicks collect points, results stay on screen until the next measurement.
 * Measurements are not part of the drawing; use the dimension tool to keep one.
 */
abstract class MeasureTool implements Tool {
  abstract readonly id: string;
  abstract readonly hint: string;
  readonly cursor = 'crosshair';
  protected pts: Vec2[] = [];
  protected done = false;
  protected cursorPos: Vec2 | null = null;

  constructor(protected readonly ctx: ToolContext) {}

  /** Number of points that completes a measurement; 0 for open-ended (finished explicitly). */
  protected abstract readonly needed: number;
  protected abstract draw(p: Painter, pts: Vec2[], live: boolean): void;

  snapQuery(): SnapQuery {
    return { from: this.done ? null : (this.pts.at(-1) ?? null) };
  }

  down(p: ToolPointer): void {
    if (p.button === 2) {
      this.finish();
      return;
    }
    if (p.button !== 0) return;
    if (this.done) {
      this.pts = [];
      this.done = false;
    }
    if (this.closesOn(p)) {
      this.finish();
      return;
    }
    this.pts.push(p.world);
    if (this.needed > 0 && this.pts.length === this.needed) this.done = true;
    this.ctx.requestRender();
  }

  move(p: ToolPointer): void {
    this.cursorPos = p.world;
    this.ctx.requestRender();
  }

  up(): void {}

  key(e: KeyboardEvent): boolean {
    if (e.key === 'Enter') {
      this.finish();
      return true;
    }
    return false;
  }

  cancel(): boolean {
    const active = this.pts.length > 0;
    this.pts = [];
    this.done = false;
    this.ctx.requestRender();
    return active;
  }

  deactivate(): void {
    this.pts = [];
    this.done = false;
  }

  overlay(p: Painter): void {
    if (this.cursorPos && !this.done) p.marker(this.cursorPos, MEASURE, 4);
    const pts = this.done || !this.cursorPos ? this.pts : [...this.pts, this.cursorPos];
    if (pts.length > 0) this.draw(p, pts, !this.done);
  }

  protected closesOn(_p: ToolPointer): boolean {
    return false;
  }

  protected finish(): void {
    if (this.needed === 0 && this.pts.length >= 3) this.done = true;
    else if (!this.done) this.pts = [];
    this.ctx.requestRender();
  }
}

export class MeasureDistanceTool extends MeasureTool {
  readonly id = 'measure-distance';
  readonly hint = '클릭: 시작점 → 클릭: 끝점 (거리·ΔX·ΔY·각도 표시) · 다시 클릭: 새 측정';
  protected readonly needed = 2;

  protected draw(p: Painter, pts: Vec2[]): void {
    if (pts.length < 2) return;
    const [a, b] = pts;
    const unit = this.ctx.unit();
    p.line(a, { x: b.x, y: a.y }, MEASURE, 1, [2, 3]);
    p.line({ x: b.x, y: a.y }, b, MEASURE, 1, [2, 3]);
    p.line(a, b, MEASURE, 1.5);
    p.marker(a, MEASURE);
    p.marker(b, MEASURE);
    p.label(b, `${formatLength(dist(a, b), unit)} · ${formatAngle(angleDeg(a, b))}`);
    p.label(b, `ΔX ${formatLength(b.x - a.x, unit)}  ΔY ${formatLength(b.y - a.y, unit)}`, 10, 8);
  }
}

export class MeasureAngleTool extends MeasureTool {
  readonly id = 'measure-angle';
  readonly hint = '클릭: 첫 점 → 클릭: 꼭짓점 → 클릭: 둘째 점 (사잇각 표시)';
  protected readonly needed = 3;

  protected draw(p: Painter, pts: Vec2[]): void {
    p.line(pts[0], pts[1] ?? pts[0], MEASURE, 1.5);
    pts.forEach((pt) => p.marker(pt, MEASURE));
    if (pts.length < 3) return;
    const [a, v, b] = pts;
    p.line(v, b, MEASURE, 1.5);
    const a1 = angleDeg(v, a);
    const a2 = angleDeg(v, b);
    let sweep = (a2 - a1 + 360) % 360;
    // Show the interior angle (≤ 180°).
    const [from, to] = sweep <= 180 ? [a1, a1 + sweep] : [a2, a2 + (360 - sweep)];
    sweep = Math.min(sweep, 360 - sweep);
    p.arcPx(v, 28, from, to, MEASURE);
    p.label(v, formatAngle(sweep), 14, -16);
  }
}

export class MeasureAreaTool extends MeasureTool {
  readonly id = 'measure-area';
  readonly hint = '클릭: 꼭짓점 추가 · 첫 점 클릭/Enter/우클릭: 닫고 면적·둘레 표시';
  protected readonly needed = 0;

  protected closesOn(p: ToolPointer): boolean {
    const first = this.pts[0];
    return !!first && this.pts.length >= 3 && dist(p.raw, first) <= this.ctx.pickTolerance() * 1.5;
  }

  protected draw(p: Painter, pts: Vec2[], live: boolean): void {
    p.polygon(pts, MEASURE, MEASURE_FILL, !live || pts.length >= 3, live ? DASH : []);
    for (const pt of this.pts) p.marker(pt, MEASURE);
    if (pts.length < 3) return;
    const c = pts.reduce((s, q) => ({ x: s.x + q.x / pts.length, y: s.y + q.y / pts.length }), { x: 0, y: 0 });
    const unit = this.ctx.unit();
    p.label(c, `면적 ${formatArea(polygonArea(pts))}`, -40, -4);
    p.label(c, `둘레 ${formatLength(polygonPerimeter(pts), unit)}`, -40, 14);
    if (live && this.pts[0]) p.marker(this.pts[0], COLORS.snap, 8);
  }
}
