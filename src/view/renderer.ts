import type { Vec2 } from '../geom/vec';
import type { DocumentModel } from '../model/document';
import type { Selection } from '../model/selection';
import type { SpatialIndex } from '../model/spatial';
import type { Entity, Id } from '../model/types';
import { type Viewport, gridSpacing } from './viewport';

export const COLORS = {
  background: '#f8fafc',
  gridMinor: '#e2e8f0',
  gridMajor: '#cbd5e1',
  axis: '#94a3b8',
  selected: '#2563eb',
  hover: '#f59e0b',
  preview: '#0ea5e9',
  text: '#0f172a',
  window: 'rgba(37, 99, 235, 0.08)',
  crossing: 'rgba(22, 163, 74, 0.08)',
};

/** Thin wrapper that lets tools draw overlays in world coordinates with screen-constant line widths. */
export class Painter {
  constructor(
    readonly ctx: CanvasRenderingContext2D,
    readonly view: Viewport,
  ) {}

  line(a: Vec2, b: Vec2, color: string, width = 1, dash: number[] = []): void {
    const sa = this.view.toScreen(a);
    const sb = this.view.toScreen(b);
    const { ctx } = this;
    ctx.beginPath();
    ctx.setLineDash(dash);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.moveTo(sa.x, sa.y);
    ctx.lineTo(sb.x, sb.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  circle(c: Vec2, r: number, color: string, width = 1, dash: number[] = []): void {
    const sc = this.view.toScreen(c);
    const { ctx } = this;
    ctx.beginPath();
    ctx.setLineDash(dash);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.arc(sc.x, sc.y, Math.max(r * this.view.scale, 0.5), 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /** Rectangle given by two world corners. */
  rect(a: Vec2, b: Vec2, stroke: string, fill?: string, dash: number[] = []): void {
    const sa = this.view.toScreen(a);
    const sb = this.view.toScreen(b);
    const { ctx } = this;
    const x = Math.min(sa.x, sb.x);
    const y = Math.min(sa.y, sb.y);
    const w = Math.abs(sb.x - sa.x);
    const h = Math.abs(sb.y - sa.y);
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fillRect(x, y, w, h);
    }
    ctx.setLineDash(dash);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    ctx.setLineDash([]);
  }

  /** Small square marker at a world point. */
  marker(p: Vec2, color: string, sizePx = 6): void {
    const s = this.view.toScreen(p);
    this.ctx.fillStyle = color;
    this.ctx.fillRect(s.x - sizePx / 2, s.y - sizePx / 2, sizePx, sizePx);
  }

  /** Label with a light backing, offset from a world point in px. */
  label(p: Vec2, text: string, dx = 10, dy = -10): void {
    const s = this.view.toScreen(p);
    const { ctx } = this;
    ctx.font = '12px system-ui, sans-serif';
    const w = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillRect(s.x + dx - 3, s.y + dy - 12, w + 6, 16);
    ctx.fillStyle = COLORS.text;
    ctx.fillText(text, s.x + dx, s.y + dy);
  }
}

export interface RenderState {
  hover: Id | null;
  overlay?: (p: Painter) => void;
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly view: Viewport,
    private readonly doc: DocumentModel,
    private readonly index: SpatialIndex,
    private readonly selection: Selection,
  ) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D를 사용할 수 없습니다.');
    this.ctx = ctx;
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.dpr = dpr;
    this.canvas.width = Math.round(cssWidth * dpr);
    this.canvas.height = Math.round(cssHeight * dpr);
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.view.resize(cssWidth, cssHeight);
  }

  /** Draws the frame and returns the number of entities drawn. */
  render(state: RenderState): number {
    const { ctx, view } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, view.width, view.height);
    this.drawGrid();

    // Batch entities by stroke style so each style is one path and one stroke call.
    const batches = new Map<string, { color: string; width: number; items: Entity[] }>();
    let drawn = 0;
    for (const e of this.index.query(view.worldBounds())) {
      const layer = this.doc.layers.get(e.layer);
      if (layer && !layer.visible) continue;
      const selected = this.selection.has(e.id);
      const hovered = e.id === state.hover;
      const color = selected ? COLORS.selected : hovered ? COLORS.hover : (layer?.color ?? COLORS.text);
      const width = selected || hovered ? 2 : 1.25;
      const key = `${color}|${width}`;
      let batch = batches.get(key);
      if (!batch) batches.set(key, (batch = { color, width, items: [] }));
      batch.items.push(e);
      drawn++;
    }
    for (const batch of batches.values()) this.strokeBatch(batch.items, batch.color, batch.width);

    const painter = new Painter(ctx, view);
    for (const id of this.selection.values()) {
      const e = this.doc.entities.get(id);
      if (!e) continue;
      for (const pid of this.doc.pointIdsOf(e)) painter.marker(this.doc.point(pid), COLORS.selected);
    }
    state.overlay?.(painter);
    return drawn;
  }

  private strokeBatch(items: Entity[], color: string, width: number): void {
    const { ctx, view } = this;
    ctx.beginPath();
    for (const e of items) {
      if (e.kind === 'line') {
        const a = view.toScreen(this.doc.point(e.p1));
        const b = view.toScreen(this.doc.point(e.p2));
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      } else {
        const c = view.toScreen(this.doc.point(e.center));
        const r = Math.max(e.radius * view.scale, 0.5);
        ctx.moveTo(c.x + r, c.y);
        ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      }
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  private drawGrid(): void {
    const { ctx, view } = this;
    const { minor, major } = gridSpacing(view.scale);
    const b = view.worldBounds();
    const drawSet = (step: number, color: string) => {
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      for (let x = Math.ceil(b.minX / step) * step; x <= b.maxX; x += step) {
        const sx = Math.round(view.toScreen({ x, y: 0 }).x) + 0.5;
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, view.height);
      }
      for (let y = Math.ceil(b.minY / step) * step; y <= b.maxY; y += step) {
        const sy = Math.round(view.toScreen({ x: 0, y }).y) + 0.5;
        ctx.moveTo(0, sy);
        ctx.lineTo(view.width, sy);
      }
      ctx.stroke();
    };
    drawSet(minor, COLORS.gridMinor);
    drawSet(major, COLORS.gridMajor);

    // World origin axes.
    const o = view.toScreen({ x: 0, y: 0 });
    ctx.beginPath();
    ctx.strokeStyle = COLORS.axis;
    ctx.moveTo(Math.round(o.x) + 0.5, 0);
    ctx.lineTo(Math.round(o.x) + 0.5, view.height);
    ctx.moveTo(0, Math.round(o.y) + 0.5);
    ctx.lineTo(view.width, Math.round(o.y) + 0.5);
    ctx.stroke();
  }
}
