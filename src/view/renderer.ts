/**
 * @file renderer.ts
 *
 * Canvas 2D renderer. Draws grid, underlay and entities, plus selection, constraint badges and tool overlays
 * through the Painter helper. Frame order: faces and line bands in drawing order (doc.entities order, so a
 * later entity covers an earlier one), then outlines batched by stroke style (one path per colour/width, which
 * keeps large drawings fast), then labels. Structures that reach the active floor from another floor (stairs,
 * ramps, lifts) are drawn as dashed ghosts. The viewer passes live `status` colours per entity (docs/VIEWER.md).
 * Border bands are filled with their colour or stripe pattern (src/model/borders.ts) at their opacity; shape faces
 * with a colour or picture at the face opacity. Shape labels and label objects are placed by src/model/labels.ts
 * (shape labels in screen-size text, label objects in world-millimetre text). A selected underlay gets a frame,
 * and a scale bar with the approximate screen scale sits in the lower left. Optional rulers along the top and left
 * edge label the major grid lines with their distance from the origin (0,0) in mm, cm or m (`showRulers`).
 */
import { dimensionGeometry } from '../geom/dimension';
import { dimensionScale, dimensionShape, dimensionText, isDimensionConstraint } from '../constraints/dimensions';
import type { Vec2 } from '../geom/vec';
import { SNAP_LABELS, type SnapResult } from '../snap/snap';
import { type DocumentModel, midpointId } from '../model/document';
import { type Selection, UNDERLAY_ID } from '../model/selection';
import { borderOpacity, circleBandRadii, patternPeriod, stripePieces } from '../model/borders';
import type { SpatialIndex } from '../model/spatial';
import { connectedFloors } from '../model/presets';
import { StrokeGeometry } from '../model/strokes';
import { planSymbol } from '../model/symbols';
import { LINE_SPACING, blockLayout, labelOpacity, labelRows, labelSize, labelVisible, shapeLabelPlacement, shapeLabelRows } from '../model/labels';
import type { ConstraintKind, Entity, EquipmentEntity, FillImage, Id, LabelEntity, ShapeEntity, StrokeStyle } from '../model/types';
import { type DisplayUnit, formatArea, formatLength } from './format';
import { type Viewport, formatScaleLength, gridSpacing, rulerTicks, scaleBarLength, screenScaleRatio } from './viewport';
import { CANVAS } from '../theme';

/** Canvas colours: the Ink wash tokens from src/theme.ts. */
export const COLORS = CANVAS;

const EXT_GAP_PX = 3;
const EXT_OVERSHOOT_PX = 5;
const TICK_PX = 5;
/** Half size of a point object's cross on screen, px. */
const POINT_MARK_PX = 6;
/** Thickness of the ruler bands, px. */
export const RULER_PX = 20;

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

  /** Vertex grip: a square, filled when the point is selected. */
  vertex(p: Vec2, color: string, filled: boolean): void {
    const { ctx } = this;
    const s = this.view.toScreen(p);
    const h = filled ? 5 : 4.5;
    ctx.beginPath();
    ctx.rect(s.x - h, s.y - h, h * 2, h * 2);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = color;
    ctx.fillStyle = filled ? color : COLORS.background;
    ctx.fill();
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
  /** Cursor position in mm, marked on the rulers. */
  cursor?: Vec2 | null;
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
  coincident: '',
  distance: '',
  angle: '',
};

interface Styled {
  e: Entity;
  color: string;
  width: number;
  /** Opacity of the outline (a hairline border's opacity). */
  alpha: number;
  /** Selected or hovered: outlines of faces are only drawn then. */
  highlighted: boolean;
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  readonly strokes: StrokeGeometry;
  private orderRev = -1;
  private faceRev = -1;
  private order = new Map<Id, number>();
  /** Rulers with grid labels along the top and left edge (the editor's 눈금자 switch). */
  showRulers = false;

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

  /** Frame and corner grips of the underlay when it is selected (or hovered), like any selected object. */
  private drawUnderlayFrame(hover: Id | null): void {
    const u = this.doc.underlay;
    if (!u?.visible) return;
    const selected = this.selection.has(UNDERLAY_ID);
    if (!selected && hover !== UNDERLAY_ID) return;
    const painter = new Painter(this.ctx, this.view);
    const color = selected ? COLORS.selected : COLORS.hover;
    painter.rect({ x: u.x, y: u.y }, { x: u.x + u.width, y: u.y + u.height }, color, undefined, selected ? [] : [6, 4]);
    if (selected) for (const c of [{ x: u.x, y: u.y }, { x: u.x + u.width, y: u.y }, { x: u.x, y: u.y + u.height }, { x: u.x + u.width, y: u.y + u.height }]) painter.marker(c, color, 7);
  }

  /** Images used as shape faces, by data URL. */
  private faceImages = new Map<string, HTMLImageElement>();

  private faceImage(src: string): HTMLImageElement | null {
    let img = this.faceImages.get(src);
    if (!img) {
      img = new Image();
      img.onload = () => this.onImageLoad();
      img.src = src;
      this.faceImages.set(src, img);
    }
    return img.complete && img.naturalWidth > 0 ? img : null;
  }

  /** Drops face images no shape uses any more, so replaced pictures don't stay in memory. */
  private pruneFaceImages(): void {
    if (this.faceImages.size === 0) return;
    const used = new Set<string>();
    for (const e of this.doc.entities.values()) if (e.kind === 'shape' && e.fillImage) used.add(e.fillImage.src);
    for (const src of this.faceImages.keys()) if (!used.has(src)) this.faceImages.delete(src);
  }

  private sortByOrder(items: Entity[]): Entity[] {
    if (this.orderRev !== this.doc.rev) {
      this.order = this.doc.paintOrder();
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
    if (this.faceRev !== doc.rev) {
      this.faceRev = doc.rev;
      this.pruneFaceImages();
    }

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
      const stroke = e.kind === 'line' || e.kind === 'circle' ? e.stroke : undefined;
      const own = stroke?.color;
      const base =
        e.kind === 'dimension'
          ? e.value !== undefined
            ? COLORS.driving
            : COLORS.dimension
          : state.fullyConstrained?.has(e.id)
            ? COLORS.constrained
            : (own ?? layer?.color ?? COLORS.text);
      const color = selected ? COLORS.selected : hovered ? COLORS.hover : base;
      // A hairline border shows its own opacity; a band's opacity is its fill (see fill()).
      const alpha = stroke && stroke.width === 0 && !(selected || hovered) ? borderOpacity(stroke) : 1;
      visible.push({ e, color, width: selected || hovered ? 2 : 1.25, alpha, highlighted: selected || hovered });
    }

    // Faces, bands and footprints in drawing order.
    for (const v of visible) this.fill(v, state.status?.get(v.e.id));

    // Outlines batched by style.
    const batches = new Map<string, { color: string; width: number; alpha: number; items: Styled[] }>();
    for (const v of visible) {
      if (v.e.kind === 'shape' && !v.highlighted) continue;
      // A label's frame only shows while it is selected or hovered, or (editing) when its text is hidden.
      if (v.e.kind === 'label' && !v.highlighted && (state.clean || labelVisible(v.e))) continue;
      const key = `${v.color}|${v.width}|${v.alpha}`;
      let batch = batches.get(key);
      if (!batch) batches.set(key, (batch = { color: v.color, width: v.width, alpha: v.alpha, items: [] }));
      batch.items.push(v);
    }
    for (const batch of batches.values()) {
      ctx.globalAlpha = batch.alpha;
      this.strokeBatch(batch.items.map((v) => v.e), batch.color, batch.width);
    }
    ctx.globalAlpha = 1;
    this.drawGhosts(ghosts);

    this.labelEntities(visible, state);
    if (!state.clean) this.drawConstraintBadges(new Set(visible.map((v) => v.e.id)));
    if (!state.clean) this.drawDimensionConstraints(new Set(visible.map((v) => v.e.id)), state.unit);
    if (!state.clean) this.drawUnderlayFrame(state.hover);
    const painter = new Painter(ctx, view);
    if (!state.clean) {
      for (const id of this.selection.values()) {
        if (doc.isVertex(id)) {
          if (doc.isPointVisible(id)) painter.vertex(doc.vertex(id), COLORS.selected, true);
          continue;
        }
        const e = doc.entities.get(id);
        if (!e) continue;
        for (const pid of doc.pointIdsOf(e)) painter.marker(doc.point(pid), COLORS.selected);
        // A line is start + midpoint + end: show its midpoint grip too.
        if (e.kind === 'line') painter.vertex(doc.vertex(midpointId(e.id)), COLORS.selected, false);
      }
      // A hovered vertex shows as a grip: clicking it selects the point itself.
      if (state.hover && doc.isVertex(state.hover) && !this.selection.has(state.hover)) painter.vertex(doc.vertex(state.hover), COLORS.hover, false);
    }
    state.overlay?.(painter);
    if (state.snap) painter.snap(state.snap);
    if (this.showRulers) this.drawRulers(state.cursor ?? undefined);
    this.drawScaleBar();
    return visible.length;
  }

  /**
   * Scale bar in the lower left: a bar of a round length (1-2-5 steps) with its length and the approximate screen
   * scale (1:N at 96 px per inch). It is the on-screen statement of the drawing's scale at the current zoom.
   */
  private drawScaleBar(): void {
    const { ctx, view } = this;
    const mm = scaleBarLength(view.scale);
    const px = mm * view.scale;
    const x = 14 + (this.showRulers ? RULER_PX : 0);
    const y = view.height - 18;
    const label = `${formatScaleLength(mm)} · 화면 약 1:${screenScaleRatio(view.scale).toLocaleString('ko-KR')}`;
    ctx.font = '11px system-ui, sans-serif';
    const textW = ctx.measureText(label).width;
    ctx.fillStyle = COLORS.labelPlate;
    ctx.fillRect(x - 6, y - 20, Math.max(px, textW) + 12, 30);
    // Four alternating segments, like a printed scale bar.
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = i % 2 === 0 ? COLORS.text : COLORS.background;
      ctx.fillRect(x + (px / 4) * i, y, px / 4, 5);
    }
    ctx.strokeStyle = COLORS.text;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, px, 5);
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(label, x, y - 6);
  }

  /**
   * Rulers along the top (X) and left (Y) edge: a tick at every grid line and, at each major line, its distance
   * from the origin (0,0). The unit (mm, cm or m) follows the zoom and is shown in the corner square.
   */
  private drawRulers(cursor?: Vec2): void {
    const { ctx, view } = this;
    const R = RULER_PX;
    const b = view.worldBounds();
    const xs = rulerTicks(b.minX, b.maxX, view.scale);
    const ys = rulerTicks(b.minY, b.maxY, view.scale);
    ctx.fillStyle = COLORS.ruler;
    ctx.fillRect(0, 0, view.width, R);
    ctx.fillRect(0, 0, R, view.height);
    ctx.beginPath();
    ctx.strokeStyle = COLORS.rulerTick;
    ctx.lineWidth = 1;
    // Band edges facing the drawing.
    ctx.moveTo(R, R - 0.5);
    ctx.lineTo(view.width, R - 0.5);
    ctx.moveTo(R - 0.5, R);
    ctx.lineTo(R - 0.5, view.height);
    for (const x of xs.minor) {
      const sx = Math.round(view.toScreen({ x, y: 0 }).x) + 0.5;
      if (sx < R) continue;
      ctx.moveTo(sx, R - 5);
      ctx.lineTo(sx, R);
    }
    for (const { at } of xs.major) {
      const sx = Math.round(view.toScreen({ x: at, y: 0 }).x) + 0.5;
      if (sx < R) continue;
      ctx.moveTo(sx, 2);
      ctx.lineTo(sx, R);
    }
    for (const y of ys.minor) {
      const sy = Math.round(view.toScreen({ x: 0, y }).y) + 0.5;
      if (sy < R) continue;
      ctx.moveTo(R - 5, sy);
      ctx.lineTo(R, sy);
    }
    for (const { at } of ys.major) {
      const sy = Math.round(view.toScreen({ x: 0, y: at }).y) + 0.5;
      if (sy < R) continue;
      ctx.moveTo(2, sy);
      ctx.lineTo(R, sy);
    }
    ctx.stroke();
    ctx.fillStyle = COLORS.text;
    ctx.font = '10px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    for (const { at, label } of xs.major) {
      const sx = Math.round(view.toScreen({ x: at, y: 0 }).x);
      if (sx >= R) ctx.fillText(label, sx + 3, 3);
    }
    // Y labels read bottom to top, beside their tick.
    for (const { at, label } of ys.major) {
      const sy = Math.round(view.toScreen({ x: 0, y: at }).y);
      if (sy < R) continue;
      ctx.save();
      ctx.translate(3, sy - 3);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(label, 0, 0);
      ctx.restore();
    }
    // Where the cursor (snapped point) is, on both rulers.
    if (cursor) {
      const c = view.toScreen(cursor);
      ctx.beginPath();
      ctx.strokeStyle = COLORS.selected;
      if (c.x >= R) {
        ctx.moveTo(Math.round(c.x) + 0.5, 0);
        ctx.lineTo(Math.round(c.x) + 0.5, R);
      }
      if (c.y >= R) {
        ctx.moveTo(0, Math.round(c.y) + 0.5);
        ctx.lineTo(R, Math.round(c.y) + 0.5);
      }
      ctx.stroke();
    }
    // Corner square: the unit of the labels.
    ctx.fillStyle = COLORS.ruler;
    ctx.fillRect(0, 0, R, R);
    ctx.strokeStyle = COLORS.rulerTick;
    ctx.strokeRect(0.5, 0.5, R - 1, R - 1);
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(xs.unit, R / 2, R / 2);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
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
      const poly = doc.shapePolygon(e);
      const trace = () => this.path(poly);
      if (status) this.fillPlain(trace, 'evenodd', status.color, 0.55);
      else {
        const opacity = e.fillOpacity ?? (e.fill || e.fillImage ? 0.35 : 0.06);
        const img = e.fillImage ? this.faceImage(e.fillImage.src) : null;
        if (img && e.fillImage) this.fillImage(trace, poly, img, e.fillImage, opacity);
        else this.fillPlain(trace, 'evenodd', e.fill ?? layerColor, opacity);
        if (v.highlighted) this.fillPlain(trace, 'evenodd', v.color, 0.18);
      }
    } else if (e.kind === 'line') {
      const band = this.strokes.band(e.id);
      if (!band || !e.stroke) return;
      const a = doc.point(e.p1);
      const b = doc.point(e.p2);
      this.fillBand(() => this.path(band), 'nonzero', band, e.stroke, layerColor, v, a, Math.atan2(b.y - a.y, b.x - a.x));
    } else if (e.kind === 'circle') {
      if (!e.stroke || !(e.stroke.width > 0)) return;
      const c = doc.point(e.center);
      const [r0, r1] = circleBandRadii(e.radius, e.stroke);
      const sc = view.toScreen(c);
      const trace = () => {
        ctx.moveTo(sc.x + r1 * view.scale, sc.y);
        ctx.arc(sc.x, sc.y, Math.max(r1 * view.scale, 0.5), 0, Math.PI * 2);
        if (r0 > 0) {
          ctx.moveTo(sc.x + r0 * view.scale, sc.y);
          ctx.arc(sc.x, sc.y, r0 * view.scale, 0, Math.PI * 2);
        }
      };
      const region = [
        { x: c.x - r1, y: c.y - r1 },
        { x: c.x + r1, y: c.y + r1 },
        { x: c.x - r1, y: c.y + r1 },
        { x: c.x + r1, y: c.y - r1 },
      ];
      this.fillBand(trace, 'evenodd', region, e.stroke, layerColor, v, c, 0);
    } else if (e.kind === 'equipment') {
      const sym = planSymbol(doc, e);
      ctx.beginPath();
      if (sym.outline === 'circle') {
        const c = view.toScreen(doc.point(e.at));
        const r = ((doc.equipmentTypes.get(e.type)?.width ?? 0) / 2) * view.scale;
        ctx.arc(c.x, c.y, Math.max(r, 0.5), 0, Math.PI * 2);
      } else this.path(sym.polygon);
      ctx.globalAlpha = status ? 0.55 : sym.solid ? 0.7 : 0.08;
      ctx.fillStyle = status?.color ?? v.color;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  /** Fills the path `trace` adds with one colour. */
  private fillPlain(trace: () => void, rule: CanvasFillRule, color: string, opacity: number): void {
    const { ctx } = this;
    ctx.beginPath();
    trace();
    ctx.globalAlpha = opacity;
    ctx.fillStyle = color;
    ctx.fill(rule);
    ctx.globalAlpha = 1;
  }

  /**
   * A border band: its colour, or its stripe pattern clipped to the band (world-size stripes, so a 50 mm stripe is
   * 50 mm on the floor). `baseAngle` is the line direction the pattern angle is measured from. Stripes thinner than
   * about a pixel are drawn as the first stripe colour. A selected band gets a tint of the selection colour.
   */
  private fillBand(trace: () => void, rule: CanvasFillRule, region: Vec2[], s: StrokeStyle, layerColor: string, v: Styled, origin: Vec2, baseAngle: number): void {
    const { ctx, view } = this;
    const opacity = borderOpacity(s);
    const p = s.pattern;
    const plain = s.color ?? p?.stripes[0]?.color ?? layerColor;
    if (v.highlighted && !p) return this.fillPlain(trace, rule, v.color, 0.6);
    const pieces = p && patternPeriod(p) * view.scale >= 2 ? stripePieces(region, origin, baseAngle + (p.angle * Math.PI) / 180, p) : null;
    if (!pieces) this.fillPlain(trace, rule, p ? p.stripes[0].color : plain, opacity);
    else {
      ctx.save();
      ctx.beginPath();
      trace();
      ctx.clip(rule);
      ctx.globalAlpha = opacity;
      const byColor = new Map<string, Vec2[][]>();
      for (const piece of pieces) byColor.set(piece.color, [...(byColor.get(piece.color) ?? []), piece.quad]);
      for (const [color, quads] of byColor) {
        ctx.beginPath();
        for (const q of quads) this.path(q);
        ctx.fillStyle = color;
        ctx.fill();
      }
      ctx.restore();
    }
    if (v.highlighted) this.fillPlain(trace, rule, v.color, 0.3);
  }

  /** A face picture: stretched over the face's bounding box or tiled at its size, clipped to the face. */
  private fillImage(trace: () => void, poly: Vec2[], img: HTMLImageElement, f: FillImage, opacity: number): void {
    const { ctx, view } = this;
    ctx.save();
    ctx.beginPath();
    trace();
    ctx.clip('evenodd');
    ctx.globalAlpha = opacity;
    if (f.fit === 'tile') {
      const pattern = ctx.createPattern(img, 'repeat');
      if (pattern) {
        const k = ((f.size ?? 1000) * view.scale) / img.naturalWidth;
        const o = view.toScreen({ x: 0, y: 0 });
        pattern.setTransform(new DOMMatrix([k, 0, 0, k, o.x, o.y]));
        ctx.fillStyle = pattern;
        ctx.fill('evenodd');
      }
    } else {
      const xs = poly.map((q) => q.x);
      const ys = poly.map((q) => q.y);
      const tl = view.toScreen({ x: Math.min(...xs), y: Math.max(...ys) });
      const br = view.toScreen({ x: Math.max(...xs), y: Math.min(...ys) });
      ctx.drawImage(img, tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    }
    ctx.restore();
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
      } else if (e.kind === 'label') {
        this.drawLabel(e, color, status);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
      } else if (e.kind === 'dimension') {
        const a = doc.point(e.p1);
        const b = doc.point(e.p2);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        const measured = formatLength(Math.hypot(b.x - a.x, b.y - a.y), state.unit);
        // Driving dimensions show what they hold (and the expression behind it); a reference dimension only
        // measures, so its value is in parentheses as in CAD drawings.
        const text = e.value === undefined ? `(${measured})` : e.expression ? `${e.expression} = ${measured}` : measured;
        labelDimension(ctx, view, a, b, e.offset, text, color);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
      }
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  /**
   * A shape's label: name, area and its extra "제목: 내용" rows at the face's centre (area centroid) or against the
   * chosen side, shifted by its offset, at its opacity; a live value is added below. Small shapes stay unlabelled.
   */
  private labelShape(e: ShapeEntity, color: string, status: EntityStatus | undefined): void {
    const { ctx, view, doc } = this;
    if (!labelVisible(e.label) && !status) return;
    const b = doc.bboxOf(e);
    const size = Math.min(b.maxX - b.minX, b.maxY - b.minY) * view.scale;
    if (size < 40) return;
    const rows = labelVisible(e.label) ? shapeLabelRows(e, formatArea(doc.shapeArea(e))) : [];
    if (status?.text) rows.push(status.text);
    if (rows.length === 0) return;
    const { at, anchor } = shapeLabelPlacement(doc, e);
    const layout = blockLayout(anchor, view.toScreen(at), rows.length, 15, 6);
    ctx.save();
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = layout.align;
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = labelOpacity(e.label);
    ctx.fillStyle = color === COLORS.selected || color === COLORS.hover ? color : COLORS.text;
    rows.forEach((text, i) => ctx.fillText(text, layout.x, layout.ys[i]));
    ctx.restore();
  }

  /** A label object: its rows in world-size text (CAD-like), at its colour and opacity; nothing when hidden. */
  private drawLabel(e: LabelEntity, color: string, status: EntityStatus | undefined): void {
    const { ctx, view, doc } = this;
    const rows = labelVisible(e) ? labelRows(e.items) : [];
    if (status?.text) rows.push(status.text);
    const px = labelSize(e) * view.scale;
    if (rows.length === 0 || px < 3) return;
    const layout = blockLayout(e.anchor ?? 'center', view.toScreen(doc.point(e.at)), rows.length, px * LINE_SPACING);
    const own = color === COLORS.selected || color === COLORS.hover;
    ctx.save();
    ctx.font = `${px}px system-ui, sans-serif`;
    ctx.textAlign = layout.align;
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = labelOpacity(e);
    ctx.fillStyle = own ? color : (e.color ?? color);
    rows.forEach((text, i) => ctx.fillText(text, layout.x, layout.ys[i]));
    ctx.restore();
  }

  /**
   * Distance and angle constraints, drawn like dimensions in the driving colour with their value, when all of the
   * geometry they reference is visible. Double-clicking the value edits it (src/tools/select.ts).
   */
  private drawDimensionConstraints(visible: ReadonlySet<Id>, unit: DisplayUnit): void {
    const { ctx, view, doc } = this;
    const scale = dimensionScale(view.pxToMm(1));
    for (const c of doc.constraints.values()) {
      if (!isDimensionConstraint(c)) continue;
      if (!c.refs.every((r) => (doc.points.has(r) ? doc.isPointVisible(r) : visible.has(r)))) continue;
      const shape = dimensionShape(doc, c, scale);
      if (!shape) continue;
      const text = dimensionText(c, (mm) => formatLength(mm, unit));
      if (shape.kind === 'linear') {
        ctx.beginPath();
        traceDimension(ctx, view, shape.a, shape.b, shape.offset);
        ctx.strokeStyle = COLORS.driving;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        labelDimension(ctx, view, shape.a, shape.b, shape.offset, text, COLORS.driving);
        continue;
      }
      if (shape.kind === 'arc') {
        const c0 = view.toScreen(shape.center);
        const r = shape.radius * view.scale;
        // Screen Y points down, so world angles turn the other way.
        ctx.beginPath();
        ctx.arc(c0.x, c0.y, r, -shape.start, -(shape.start + shape.sweep), shape.sweep > 0);
        ctx.strokeStyle = COLORS.driving;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      const s = view.toScreen(shape.label);
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const w = ctx.measureText(text).width;
      ctx.fillStyle = COLORS.labelPlate;
      ctx.fillRect(s.x - w / 2 - 2, s.y - 7, w + 4, 14);
      ctx.fillStyle = COLORS.driving;
      ctx.fillText(text, s.x, s.y);
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
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
      if (isDimensionConstraint(c)) continue; // drawn as dimensions (drawDimensionConstraints)
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
        } else this.path(sym.polygon);
        for (const [p, q] of sym.segments) {
          const a = view.toScreen(p);
          const b = view.toScreen(q);
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
        }
      } else if (e.kind === 'point') {
        // A point object keeps a fixed screen size: a small cross in a ring.
        const c = view.toScreen(doc.point(e.at));
        ctx.moveTo(c.x - POINT_MARK_PX, c.y);
        ctx.lineTo(c.x + POINT_MARK_PX, c.y);
        ctx.moveTo(c.x, c.y - POINT_MARK_PX);
        ctx.lineTo(c.x, c.y + POINT_MARK_PX);
        ctx.moveTo(c.x + POINT_MARK_PX * 0.6, c.y);
        ctx.arc(c.x, c.y, POINT_MARK_PX * 0.6, 0, Math.PI * 2);
      } else if (e.kind === 'label') {
        // A label is its text (drawn with the other labels); a selected, hovered or hidden one shows its frame.
        const box = doc.bboxOf(e);
        const a = view.toScreen({ x: box.minX, y: box.maxY });
        const b = view.toScreen({ x: box.maxX, y: box.minY });
        ctx.rect(a.x - 2, a.y - 2, b.x - a.x + 4, b.y - a.y + 4);
      } else {
        const c = view.toScreen(doc.point(e.center));
        const r = Math.max(e.radius * view.scale, 0.5);
        ctx.moveTo(c.x + r, c.y);
        ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
        // Edges of a border band, like a styled line's band outline.
        if (e.stroke && e.stroke.width > 0) {
          for (const br of circleBandRadii(e.radius, e.stroke)) {
            if (br <= 0 || br === e.radius) continue;
            ctx.moveTo(c.x + br * view.scale, c.y);
            ctx.arc(c.x, c.y, br * view.scale, 0, Math.PI * 2);
          }
        }
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
