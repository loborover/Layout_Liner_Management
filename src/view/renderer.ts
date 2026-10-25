import { dimensionGeometry } from '../geom/dimension';
import type { Vec2 } from '../geom/vec';
import { SNAP_LABELS, type SnapResult } from '../snap/snap';
import type { DocumentModel } from '../model/document';
import type { Selection } from '../model/selection';
import type { SpatialIndex } from '../model/spatial';
import type { ConstraintKind, Entity, Id } from '../model/types';
import { type DisplayUnit, formatLength } from './format';
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
  snap: '#16a34a',
  constrained: '#15803d',
  driving: '#be123c',
  badge: '#7c3aed',
  guide: 'rgba(22, 163, 74, 0.6)',
  dimension: '#0f766e',
};

const EXT_GAP_PX = 3;
const EXT_OVERSHOOT_PX = 5;
const TICK_PX = 5;

/** Adds an aligned dimension's extension lines, dimension line and ticks to the current path. */
function traceDimension(ctx: CanvasRenderingContext2D, view: Viewport, a: Vec2, b: Vec2, offset: number): void {
  const { d1, d2, normal } = dimensionGeometry(a, b, offset);
  const side = Math.sign(offset) || 1;
  const sNormal = { x: normal.x * side, y: -normal.y * side }; // screen-space direction from a toward d1
  for (const [p, d] of [
    [a, d1],
    [b, d2],
  ] as const) {
    const sp = view.toScreen(p);
    const sd = view.toScreen(d);
    const lenPx = Math.hypot(sd.x - sp.x, sd.y - sp.y);
    if (lenPx > EXT_GAP_PX) {
      ctx.moveTo(sp.x + sNormal.x * EXT_GAP_PX, sp.y + sNormal.y * EXT_GAP_PX);
      ctx.lineTo(sd.x + sNormal.x * EXT_OVERSHOOT_PX, sd.y + sNormal.y * EXT_OVERSHOOT_PX);
    }
  }
  const s1 = view.toScreen(d1);
  const s2 = view.toScreen(d2);
  ctx.moveTo(s1.x, s1.y);
  ctx.lineTo(s2.x, s2.y);
  // 45° architectural ticks.
  const l = Math.hypot(s2.x - s1.x, s2.y - s1.y) || 1;
  const u = { x: (s2.x - s1.x) / l, y: (s2.y - s1.y) / l };
  const t = { x: (u.x - u.y) * Math.SQRT1_2 * TICK_PX, y: (u.y + u.x) * Math.SQRT1_2 * TICK_PX };
  for (const s of [s1, s2]) {
    ctx.moveTo(s.x - t.x, s.y - t.y);
    ctx.lineTo(s.x + t.x, s.y + t.y);
  }
}

/** Writes a dimension's value centred above its dimension line, kept upright. */
function labelDimension(ctx: CanvasRenderingContext2D, view: Viewport, a: Vec2, b: Vec2, offset: number, text: string, color: string): void {
  const { d1, d2 } = dimensionGeometry(a, b, offset);
  const s1 = view.toScreen(d1);
  const s2 = view.toScreen(d2);
  let angle = Math.atan2(s2.y - s1.y, s2.x - s1.x);
  if (angle > Math.PI / 2 || angle <= -Math.PI / 2) angle += Math.PI;
  ctx.save();
  ctx.translate((s1.x + s2.x) / 2, (s1.y + s2.y) / 2);
  ctx.rotate(angle);
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  const w = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(248,250,252,0.85)';
  ctx.fillRect(-w / 2 - 2, -17, w + 4, 14);
  ctx.fillStyle = color;
  ctx.fillText(text, 0, -4);
  ctx.restore();
}

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

  /** Polyline or polygon through world points. */
  polygon(pts: Vec2[], stroke: string, fill?: string, closed = true, dash: number[] = []): void {
    if (pts.length === 0) return;
    const { ctx } = this;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const s = this.view.toScreen(p);
      if (i === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    });
    if (closed) ctx.closePath();
    if (fill && closed) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    ctx.setLineDash(dash);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /** Arc around a world centre with a screen radius, angles in degrees counter-clockwise from +X. */
  arcPx(c: Vec2, radiusPx: number, fromDeg: number, toDeg: number, color: string): void {
    const s = this.view.toScreen(c);
    const { ctx } = this;
    ctx.beginPath();
    // Screen Y points down, so world counter-clockwise is canvas anticlockwise with negated angles.
    ctx.arc(s.x, s.y, radiusPx, (-fromDeg * Math.PI) / 180, (-toDeg * Math.PI) / 180, true);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  /** Small square marker at a world point. */
  marker(p: Vec2, color: string, sizePx = 6): void {
    const s = this.view.toScreen(p);
    this.ctx.fillStyle = color;
    this.ctx.fillRect(s.x - sizePx / 2, s.y - sizePx / 2, sizePx, sizePx);
  }

  dimension(a: Vec2, b: Vec2, offset: number, text: string, color = COLORS.preview): void {
    const { ctx } = this;
    ctx.beginPath();
    traceDimension(ctx, this.view, a, b, offset);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();
    labelDimension(ctx, this.view, a, b, offset, text, color);
  }

  /** Snap marker, its name, and the tracking guide when there is one. */
  snap(s: SnapResult): void {
    const { ctx, view } = this;
    const p = view.toScreen(s.point);
    if (s.guide) {
      const g = view.toScreen(s.guide.from);
      const rad = (s.guide.angleDeg * Math.PI) / 180;
      const far = Math.hypot(view.width, view.height);
      ctx.beginPath();
      ctx.setLineDash([2, 4]);
      ctx.strokeStyle = COLORS.guide;
      ctx.lineWidth = 1;
      ctx.moveTo(g.x, g.y);
      ctx.lineTo(g.x + Math.cos(rad) * far, g.y - Math.sin(rad) * far);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (s.kind === 'grid') return;
    ctx.beginPath();
    ctx.strokeStyle = COLORS.snap;
    ctx.lineWidth = 1.5;
    const r = 6;
    switch (s.kind) {
      case 'endpoint':
        ctx.rect(p.x - r, p.y - r, 2 * r, 2 * r);
        break;
      case 'midpoint':
        ctx.moveTo(p.x, p.y - r);
        ctx.lineTo(p.x + r, p.y + r);
        ctx.lineTo(p.x - r, p.y + r);
        ctx.closePath();
        break;
      case 'center':
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        break;
      case 'quadrant':
        ctx.moveTo(p.x, p.y - r);
        ctx.lineTo(p.x + r, p.y);
        ctx.lineTo(p.x, p.y + r);
        ctx.lineTo(p.x - r, p.y);
        ctx.closePath();
        break;
      case 'intersection':
        ctx.moveTo(p.x - r, p.y - r);
        ctx.lineTo(p.x + r, p.y + r);
        ctx.moveTo(p.x + r, p.y - r);
        ctx.lineTo(p.x - r, p.y + r);
        break;
      case 'perpendicular':
        ctx.moveTo(p.x - r, p.y - r);
        ctx.lineTo(p.x - r, p.y + r);
        ctx.lineTo(p.x + r, p.y + r);
        ctx.moveTo(p.x - r, p.y);
        ctx.lineTo(p.x, p.y);
        ctx.lineTo(p.x, p.y + r);
        break;
      default:
        ctx.moveTo(p.x - r, p.y);
        ctx.lineTo(p.x + r, p.y);
        ctx.moveTo(p.x, p.y - r);
        ctx.lineTo(p.x, p.y + r);
    }
    ctx.stroke();
    // Below-left of the marker, clear of the tool labels drawn to the upper right.
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = COLORS.snap;
    ctx.textAlign = 'right';
    ctx.fillText(SNAP_LABELS[s.kind], p.x - 9, p.y + 18);
    ctx.textAlign = 'left';
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
  unit: DisplayUnit;
  snap?: SnapResult | null;
  /** Entities with no remaining degrees of freedom, drawn in the constrained colour. */
  fullyConstrained?: ReadonlySet<Id>;
  overlay?: (p: Painter) => void;
}

const BADGES: Record<ConstraintKind, string> = {
  horizontal: 'H',
  vertical: 'V',
  parallel: '∥',
  perpendicular: '⊥',
  equal: '=',
  fixed: '',
  radius: 'R',
};

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
    const visibleIds = new Set<Id>();
    let drawn = 0;
    for (const e of this.index.query(view.worldBounds())) {
      visibleIds.add(e.id);
      const layer = this.doc.layers.get(e.layer);
      if (layer && !layer.visible) continue;
      const selected = this.selection.has(e.id);
      const hovered = e.id === state.hover;
      const base =
        e.kind === 'dimension'
          ? e.value !== undefined
            ? COLORS.driving
            : COLORS.dimension
          : state.fullyConstrained?.has(e.id)
            ? COLORS.constrained
            : (layer?.color ?? COLORS.text);
      const color = selected ? COLORS.selected : hovered ? COLORS.hover : base;
      const width = selected || hovered ? 2 : 1.25;
      const key = `${color}|${width}`;
      let batch = batches.get(key);
      if (!batch) batches.set(key, (batch = { color, width, items: [] }));
      batch.items.push(e);
      drawn++;
    }
    this.fillEquipment(batches);
    for (const batch of batches.values()) this.strokeBatch(batch.items, batch.color, batch.width);
    this.labelEquipment(batches);
    for (const batch of batches.values()) {
      for (const e of batch.items) {
        if (e.kind !== 'dimension') continue;
        const a = this.doc.point(e.p1);
        const b = this.doc.point(e.p2);
        labelDimension(ctx, view, a, b, e.offset, formatLength(Math.hypot(b.x - a.x, b.y - a.y), state.unit), batch.color);
      }
    }

    const painter = new Painter(ctx, view);
    this.drawConstraintBadges(visibleIds);
    for (const id of this.selection.values()) {
      const e = this.doc.entities.get(id);
      if (!e) continue;
      for (const pid of this.doc.pointIdsOf(e)) painter.marker(this.doc.point(pid), COLORS.selected);
    }
    state.overlay?.(painter);
    if (state.snap) painter.snap(state.snap);
    return drawn;
  }

  /** Light tint over equipment footprints so they read as solid objects. */
  private fillEquipment(batches: Map<string, { color: string; items: Entity[] }>): void {
    const { ctx, view } = this;
    ctx.globalAlpha = 0.08;
    for (const batch of batches.values()) {
      ctx.beginPath();
      let any = false;
      for (const e of batch.items) {
        if (e.kind !== 'equipment') continue;
        const cs = this.doc.cornersOf(e).map((c) => view.toScreen(c));
        ctx.moveTo(cs[0].x, cs[0].y);
        for (let i = 1; i < 4; i++) ctx.lineTo(cs[i].x, cs[i].y);
        ctx.closePath();
        any = true;
      }
      if (!any) continue;
      ctx.fillStyle = batch.color;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /** Name and tag in the middle of each piece of equipment that is big enough on screen to hold them. */
  private labelEquipment(batches: Map<string, { color: string; items: Entity[] }>): void {
    const { ctx, view } = this;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const batch of batches.values()) {
      ctx.fillStyle = batch.color;
      for (const e of batch.items) {
        if (e.kind !== 'equipment') continue;
        const type = this.doc.equipmentTypes.get(e.type);
        if (!type) continue;
        const size = Math.min(type.width, type.depth) * view.scale;
        if (size < 22) continue;
        const c = view.toScreen(this.doc.point(e.at));
        const font = Math.max(10, Math.min(14, size / 4));
        ctx.font = `${font}px system-ui, sans-serif`;
        const lines = e.tag ? [e.tag, type.name] : [type.name];
        if (size < 40) lines.length = 1;
        lines.forEach((text, i) => ctx.fillText(text, c.x, c.y + (i - (lines.length - 1) / 2) * (font + 2)));
      }
    }
    ctx.textBaseline = 'alphabetic';
  }

  /** Small symbols next to constrained entities, and a marker on fixed points. */
  private drawConstraintBadges(visible: ReadonlySet<Id>): void {
    if (this.doc.constraints.size === 0) return;
    const { ctx, view } = this;
    const perEntity = new Map<Id, string[]>();
    for (const c of this.doc.constraints.values()) {
      if (c.kind === 'fixed') {
        for (const pid of c.refs) {
          const pt = this.doc.points.get(pid);
          if (!pt) continue;
          const s = view.toScreen(pt);
          ctx.beginPath();
          ctx.strokeStyle = COLORS.driving;
          ctx.lineWidth = 1.5;
          ctx.moveTo(s.x - 6, s.y + 8);
          ctx.lineTo(s.x, s.y);
          ctx.lineTo(s.x + 6, s.y + 8);
          ctx.closePath();
          ctx.stroke();
        }
        continue;
      }
      const text = c.kind === 'radius' ? `R${Math.round(c.value ?? 0)}` : BADGES[c.kind];
      for (const id of c.refs) {
        if (!visible.has(id)) continue;
        const list = perEntity.get(id) ?? [];
        list.push(text);
        perEntity.set(id, list);
      }
    }
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    for (const [id, texts] of perEntity) {
      const e = this.doc.entities.get(id);
      if (!e) continue;
      let anchor: Vec2;
      if (e.kind === 'line') {
        const a = this.doc.point(e.p1);
        const b = this.doc.point(e.p2);
        anchor = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      } else if (e.kind === 'circle') {
        const c = this.doc.point(e.center);
        anchor = { x: c.x + e.radius * Math.SQRT1_2, y: c.y + e.radius * Math.SQRT1_2 };
      } else continue;
      const s = view.toScreen(anchor);
      const label = texts.join(' ');
      const w = ctx.measureText(label).width + 6;
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fillRect(s.x + 6, s.y + 4, w, 15);
      ctx.strokeStyle = COLORS.badge;
      ctx.lineWidth = 1;
      ctx.strokeRect(s.x + 6.5, s.y + 4.5, w, 15);
      ctx.fillStyle = COLORS.badge;
      ctx.fillText(label, s.x + 9, s.y + 16);
    }
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
      } else if (e.kind === 'dimension') {
        traceDimension(ctx, view, this.doc.point(e.p1), this.doc.point(e.p2), e.offset);
      } else if (e.kind === 'equipment') {
        const cs = this.doc.cornersOf(e).map((c) => view.toScreen(c));
        ctx.moveTo(cs[0].x, cs[0].y);
        for (let i = 1; i < 4; i++) ctx.lineTo(cs[i].x, cs[i].y);
        ctx.closePath();
        // Front marker: a short tick into the footprint from the middle of the front edge.
        const mid = { x: (cs[0].x + cs[1].x) / 2, y: (cs[0].y + cs[1].y) / 2 };
        const back = { x: (cs[2].x + cs[3].x) / 2, y: (cs[2].y + cs[3].y) / 2 };
        const len = Math.hypot(back.x - mid.x, back.y - mid.y);
        if (len > 1) {
          const t = Math.min(10, len * 0.25) / len;
          ctx.moveTo(mid.x, mid.y);
          ctx.lineTo(mid.x + (back.x - mid.x) * t, mid.y + (back.y - mid.y) * t);
        }
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
