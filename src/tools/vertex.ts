/**
 * @file vertex.ts
 *
 * Vertex insertion tool ("꼭짓점 추가", the user's request 2026-11-15): hover a line (a free line or a shape's edge)
 * to see where the new corner goes, click to split the line there. The new point is selected so it can be dragged
 * or rounded straight away. Related: src/model/corners.ts (insertVertex).
 */
import { type Vec2, dot, sub } from '../geom/vec';
import { insertVertex } from '../model/corners';
import type { LineEntity } from '../model/types';
import { COLORS, type Painter } from '../view/renderer';
import type { Tool, ToolContext, ToolPointer } from './tool';

export class VertexTool implements Tool {
  readonly id = 'vertex';
  readonly hint = '선(도형의 변) 위를 클릭: 그 자리에 꼭짓점 추가 · 스냅된 점(중간점 등)이 있으면 그 위치 · Esc: 종료';
  readonly cursor = 'crosshair';
  private target: { line: LineEntity; at: Vec2 } | null = null;

  constructor(private readonly ctx: ToolContext) {}

  /** The editable line under the cursor and the point of it nearest the (snapped) cursor. */
  private find(p: ToolPointer): { line: LineEntity; at: Vec2 } | null {
    const { doc, index } = this.ctx;
    const tol = this.ctx.pickTolerance();
    let best: LineEntity | null = null;
    let bestD = tol;
    for (const e of index.query({ minX: p.raw.x - tol, minY: p.raw.y - tol, maxX: p.raw.x + tol, maxY: p.raw.y + tol })) {
      if (e.kind !== 'line' || !doc.isEditable(e)) continue;
      const d = index.distanceTo(e, p.raw);
      if (d <= bestD) [best, bestD] = [e, d];
    }
    if (!best) return null;
    const a = doc.point(best.p1);
    const b = doc.point(best.p2);
    const d = sub(b, a);
    const src = p.snap ? p.world : p.raw;
    const t = Math.max(0, Math.min(1, dot(sub(src, a), d) / (dot(d, d) || 1)));
    return { line: best, at: { x: a.x + d.x * t, y: a.y + d.y * t } };
  }

  down(p: ToolPointer): void {
    if (p.button !== 0) return;
    const hit = this.find(p);
    if (!hit) return this.ctx.notify('꼭짓점을 넣을 선 위를 클릭하십시오.');
    const r = insertVertex(this.ctx.doc, hit.line.id, hit.at);
    if (typeof r === 'string') return this.ctx.notify(r);
    this.ctx.history.execute(r.command);
    this.ctx.selection.set([r.point]);
  }

  move(p: ToolPointer): void {
    this.target = this.find(p);
    this.ctx.setHover(this.target?.line.id ?? null);
    this.ctx.requestRender();
  }

  up(): void {}

  cancel(): boolean {
    return false;
  }

  deactivate(): void {
    this.target = null;
  }

  overlay(p: Painter): void {
    if (this.target) p.vertex(this.target.at, COLORS.preview, true);
  }
}
