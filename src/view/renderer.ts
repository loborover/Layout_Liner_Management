/**
 * @file renderer.ts
 *
 * Canvas 2D renderer. Draws grid, underlay and entities, plus selection, constraint badges and tool overlays
 * through the Painter helper. Frame order: faces and line bands in drawing order (doc.entities order, so a
 * later entity covers an earlier one), then outlines batched by stroke style (one path per colour/width, which
 * keeps large drawings fast), then labels. Structures that reach the active floor from another floor (stairs,
 * ramps, lifts) are drawn as dashed ghosts. The viewer passes live `status` colours per entity (docs/VIEWER.md).
 */
import { dimensionGeometry } from '../geom/dimension';
import type { Vec2 } from '../geom/vec';
import { SNAP_LABELS, type SnapResult } from '../snap/snap';
import type { DocumentModel } from '../model/document';
import type { Selection } from '../model/selection';
import type { SpatialIndex } from '../model/spatial';
import { connectedFloors } from '../model/presets';
import { StrokeGeometry } from '../model/strokes';
import { planSymbol } from '../model/symbols';
import type { ConstraintKind, Entity, EquipmentEntity, Id, ShapeEntity } from '../model/types';
import { type DisplayUnit, formatArea, formatLength } from './format';
import { type Viewport, gridSpacing } from './viewport';
import { CANVAS } from '../theme';

/** Canvas colours: the Ink wash tokens from src/theme.ts. */
export const COLORS = CANVAS;

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
  ctx.fillStyle = COLORS.labelPlate;
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
    ctx.fillStyle = COLORS.labelPlate;
    ctx.fillRect(s.x + dx - 3, s.y + dy - 12, w + 6, 16);
    ctx.fillStyle = COLORS.text;
    ctx.fillText(text, s.x + dx, s.y + dy);
  }
}

/** Live state of an entity, drawn by the viewer over the plan. */
export interface EntityStatus {
  /** Fill colour of the entity's footprint or face. */
  color: string;
  /** Short value text drawn on the entity, e.g. "72.5 °C". */
  text?: string;
}

export interface RenderState {
  hover: Id | null;
  unit: DisplayUnit;
  snap?: SnapResult | null;
  /** Entities with no remaining degrees of freedom, drawn in the constrained colour. */
  fullyConstrained?: ReadonlySet<Id>;
  /** Viewer monitoring state, keyed by entity id. */
  status?: ReadonlyMap<Id, EntityStatus>;
  /** Hide constraint badges and point markers (viewer mode). */
  clean?: boolean;
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

interface Styled {
  e: Entity;
  color: string;
  width: number;
  /** Selected or hovered: outlines of faces are only drawn then. */
  highlighted: boolean;
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  readonly strokes: StrokeGeometry;
  private orderRev = -1;
  private order = new Map<Id, number>();

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
    this.strokes = new StrokeGeometry(doc);
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.dpr = dpr;
    this.canvas.width = Math.round(cssWidth * dpr);
    this.canvas.height = Math.round(cssHeight * dpr);
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.view.resize(cssWidth, cssHeight);
  }

  /** Called when an underlay image finishes loading, so the frame can be redrawn with it. */
  onImageLoad: () => void = () => {};
  private images = new Map<string, HTMLImageElement>();

  private drawUnderlay(): void {
    const u = this.doc.underlay;
    if (!u?.visible) return;
    let img = this.images.get(u.src);
    if (!img) {
      // Keep only the current image: an old one may be several megabytes.
      this.images.clear();
      img = new Image();
      img.onload = () => this.onImageLoad();
      img.src = u.src;
      this.images.set(u.src, img);
    }
    if (!img.complete || img.naturalWidth === 0) return;
    const topLeft = this.view.toScreen({ x: u.x, y: u.y + u.height });
    this.ctx.globalAlpha = u.opacity;
    this.ctx.drawImage(img, topLeft.x, topLeft.y, u.width * this.view.scale, u.height * this.view.scale);
    this.ctx.globalAlpha = 1;
  }

  private sortByOrder(items: Entity[]): Entity[] {
    if (this.orderRev !== this.doc.rev) {
      this.order = new Map([...this.doc.entities.keys()].map((id, i) => [id, i]));
      this.orderRev = this.doc.rev;
    }
    return items.sort((a, b) => (this.order.get(a.id) ?? 0) - (this.order.get(b.id) ?? 0));
  }

  /** Draws the frame and returns the number of entities drawn. */
  render(state: RenderState): number {
    const { ctx, view, doc } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, view.width, view.height);
    this.drawGrid();
    this.drawUnderlay();

    const visible: Styled[] = [];
    const ghosts: EquipmentEntity[] = [];
    for (const e of this.sortByOrder(this.index.query(view.worldBounds()))) {
      if (!doc.isVisible(e)) {
        // A connected stair/ramp/lift from another floor shows as a ghost, unless its own layer is hidden there.
        if (e.kind === 'equipment' && doc.isLayerShown(e.layer) && connectedFloors(doc, e).includes(doc.activeFloor)) ghosts.push(e);
        continue;
      }
      const layer = doc.layers.get(e.layer);
      const selected = this.selection.has(e.id);
      const hovered = e.id === state.hover;
      const own = e.kind === 'line' ? e.stroke?.color : undefined;
      const base =
        e.kind === 'dimension'
          ? e.value !== undefined
            ? COLORS.driving
            : COLORS.dimension
          : state.fullyConstrained?.has(e.id)
            ? COLORS.constrained
            : (own ?? layer?.color ?? COLORS.text);
      const color = selected ? COLORS.selected : hovered ? COLORS.hover : base;
      visible.push({ e, color, width: selected || hovered ? 2 : 1.25, highlighted: selected || hovered });
    }

    // Faces, bands and footprints in drawing order.
    for (const v of visible) this.fill(v, state.status?.get(v.e.id));

    // Outlines batched by style.
    const batches = new Map<string, { color: string; width: number; items: Styled[] }>();
    for (const v of visible) {
      if (v.e.kind === 'shape' && !v.highlighted) continue;
      const key = `${v.color}|${v.width}`;
      let batch = batches.get(key);
      if (!batch) batches.set(key, (batch = { color: v.color, width: v.width, items: [] }));
      batch.items.push(v);
    }
    for (const batch of batches.values()) this.strokeBatch(batch.items.map((v) => v.e), batch.color, batch.width);
    this.drawGhosts(ghosts);

    this.labelEntities(visible, state);
    if (!state.clean) this.drawConstraintBadges(new Set(visible.map((v) => v.e.id)));
    const painter = new Painter(ctx, view);
    if (!state.clean) {
      for (const id of this.selection.values()) {
        const e = doc.entities.get(id);
        if (!e) continue;
        for (const pid of doc.pointIdsOf(e)) painter.marker(doc.point(pid), COLORS.selected);
      }
    }
    state.overlay?.(painter);
    if (state.snap) painter.snap(state.snap);
    return visible.length;
  }

  private path(pts: Vec2[]): void {
    const { ctx, view } = this;
    pts.forEach((p, i) => {
      const s = view.toScreen(p);
      if (i === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    });
    ctx.closePath();
  }

  /** Face of a shape, band of a styled line, or footprint of equipment. */
  private fill(v: Styled, status: EntityStatus | undefined): void {
    const { ctx, doc, view } = this;
    const { e } = v;
    const layerColor = doc.layers.get(e.layer)?.color ?? COLORS.text;
    if (e.kind === 'shape') {
      ctx.beginPath();
      this.path(doc.shapePolygon(e));
      ctx.globalAlpha = status ? 0.55 : v.highlighted ? 0.18 : e.fill ? 0.35 : 0.06;
      ctx.fillStyle = status?.color ?? (v.highlighted ? v.color : (e.fill ?? layerColor));
      ctx.fill('evenodd');
      ctx.globalAlpha = 1;
    } else if (e.kind === 'line') {
      const band = this.strokes.band(e.id);
      if (!band) return;
      ctx.beginPath();
      this.path(band);
      ctx.globalAlpha = v.highlighted ? 0.6 : 0.85;
      ctx.fillStyle = v.highlighted ? v.color : (e.stroke?.color ?? layerColor);
      ctx.fill();
      ctx.globalAlpha = 1;
    } else if (e.kind === 'equipment') {
      const sym = planSymbol(doc, e);
      ctx.beginPath();
      if (sym.outline === 'circle') {
        const c = view.toScreen(doc.point(e.at));
        const r = ((doc.equipmentTypes.get(e.type)?.width ?? 0) / 2) * view.scale;
        ctx.arc(c.x, c.y, Math.max(r, 0.5), 0, Math.PI * 2);
      } else this.path(doc.cornersOf(e));
      ctx.globalAlpha = status ? 0.55 : sym.solid ? 0.7 : 0.08;
      ctx.fillStyle = status?.color ?? v.color;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  /** Stairs, ramps and lifts of another floor that reach this one, as faint dashed outlines. */
  private drawGhosts(items: EquipmentEntity[]): void {
    if (items.length === 0) return;
    const { ctx } = this;
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.globalAlpha = 0.45;
    this.strokeBatch(items, COLORS.axis, 1.25);
    ctx.restore();
  }

  /** Equipment tags and names, shape names with their area, dimension values and live status values. */
  private labelEntities(visible: Styled[], state: RenderState): void {
    const { ctx, view, doc } = this;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const { e, color } of visible) {
      const status = state.status?.get(e.id);
      if (e.kind === 'equipment') {
        const type = doc.equipmentTypes.get(e.type);
        if (!type) continue;
        const size = Math.min(type.width, type.depth) * view.scale;
        if (size < 22) continue;
        const c = view.toScreen(doc.point(e.at));
        const font = Math.max(10, Math.min(14, size / 4));
        ctx.font = `${font}px system-ui, sans-serif`;
        const note = planSymbol(doc, e).note;
        const lines = [e.tag, e.name || type.name, status?.text ?? note].filter((t): t is string => !!t);
        if (size < 40) lines.length = 1;
        ctx.fillStyle = color;
        lines.forEach((text, i) => ctx.fillText(text, c.x, c.y + (i - (lines.length - 1) / 2) * (font + 2)));
      } else if (e.kind === 'shape') {
        this.labelShape(e, color, status);
      } else if (e.kind === 'dimension') {
        const a = doc.point(e.p1);
        const b = doc.point(e.p2);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        labelDimension(ctx, view, a, b, e.offset, formatLength(Math.hypot(b.x - a.x, b.y - a.y), state.unit), color);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
      }
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  private labelShape(e: ShapeEntity, color: string, status: EntityStatus | undefined): void {
    const { ctx, view, doc } = this;
    const b = doc.bboxOf(e);
    const size = Math.min(b.maxX - b.minX, b.maxY - b.minY) * view.scale;
    if (size < 40) return;
    // Area-weighted centroid would be nicer for L-shapes, but the box centre is stable while dragging.
    const c = view.toScreen({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
    const lines = [e.name ?? '', formatArea(doc.shapeArea(e)), status?.text ?? ''].filter(Boolean);
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillStyle = color === COLORS.selected || color === COLORS.hover ? color : COLORS.text;
    lines.forEach((text, i) => ctx.fillText(text, c.x, c.y + (i - (lines.length - 1) / 2) * 15));
  }

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
      ctx.fillStyle = COLORS.labelPlate;
      ctx.fillRect(s.x + 6, s.y + 4, w, 15);
      ctx.strokeStyle = COLORS.badge;
      ctx.lineWidth = 1;
      ctx.strokeRect(s.x + 6.5, s.y + 4.5, w, 15);
      ctx.fillStyle = COLORS.badge;
      ctx.fillText(label, s.x + 9, s.y + 16);
    }
  }

  private strokeBatch(items: Entity[], color: string, width: number): void {
    const { ctx, view, doc } = this;
    ctx.beginPath();
    for (const e of items) {
      if (e.kind === 'line') {
        const a = view.toScreen(doc.point(e.p1));
        const b = view.toScreen(doc.point(e.p2));
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        const band = this.strokes.band(e.id);
        if (band) this.path(band);
      } else if (e.kind === 'dimension') {
        traceDimension(ctx, view, doc.point(e.p1), doc.point(e.p2), e.offset);
      } else if (e.kind === 'shape') {
        this.path(doc.shapePolygon(e));
      } else if (e.kind === 'equipment') {
        const sym = planSymbol(doc, e);
        if (sym.outline === 'circle') {
          const c = view.toScreen(doc.point(e.at));
          const r = Math.max(((doc.equipmentTypes.get(e.type)?.width ?? 0) / 2) * view.scale, 0.5);
          ctx.moveTo(c.x + r, c.y);
          ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
        } else this.path(doc.cornersOf(e));
        for (const [p, q] of sym.segments) {
          const a = view.toScreen(p);
          const b = view.toScreen(q);
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
        }
      } else {
        const c = view.toScreen(doc.point(e.center));
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
