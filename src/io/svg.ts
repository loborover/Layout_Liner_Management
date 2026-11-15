/**
 * @file svg.ts
 *
 * Exports visible layers as an SVG in millimetres; also used for printing. Borders keep their opacity and stripe
 * patterns (SVG <pattern> in world millimetres), faces their opacity and pictures. Every export carries a graphic
 * scale bar, which stays true however the page is scaled; with a fixed print scale (e.g. 1:100) the SVG is sized so
 * that it prints at that scale and the ratio is written next to the bar. Shape labels (name, area, extra rows) and
 * label objects are placed as on the canvas (src/model/labels.ts), at their opacity; hidden ones are left out.
 */
import { dimensionGeometry } from '../geom/dimension';
import type { Box, Vec2 } from '../geom/vec';
import type { DocumentModel } from '../model/document';
import { borderOpacity, circleBandRadii, patternPeriod } from '../model/borders';
import { LINE_SPACING, blockLayout, labelOpacity, labelRows, labelSize, labelVisible, shapeLabelPlacement, shapeLabelRows } from '../model/labels';
import type { LabelAnchor, StripePattern, StrokeStyle } from '../model/types';
import { formatArea } from '../view/format';
import { dataImageSize } from './imageSize';
import { formatScaleLength, scaleBarLength } from '../view/viewport';
import { CANVAS } from '../theme';
import { StrokeGeometry } from '../model/strokes';
import { planSymbol } from '../model/symbols';
import { COLORS } from '../view/renderer';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const n = (v: number) => String(Math.round(v * 100) / 100);

export interface SvgOptions {
  /** Print scale N of 1:N. The SVG's width and height are then the paper size at that scale; absent: sized 1:1. */
  scale?: number;
}

/**
 * The visible drawing as a standalone SVG in millimetres (1 user unit = 1 mm, Y flipped to point down).
 * Strokes keep a constant hairline width whatever the zoom or print scale. Returns null for an empty drawing.
 */
export function drawingSvg(doc: DocumentModel, opts: SvgOptions = {}): string | null {
  const ext = visibleExtents(doc);
  if (!ext) return null;
  const size = Math.max(ext.maxX - ext.minX, ext.maxY - ext.minY, 1);
  const margin = size * 0.04;
  // Room under the drawing for the scale bar.
  const footer = size * 0.06;
  const minX = ext.minX - margin;
  const minY = -ext.maxY - margin; // SVG y of the top edge
  const w = ext.maxX - ext.minX + 2 * margin;
  const h = ext.maxY - ext.minY + 2 * margin + footer;
  const textSize = size / 90;
  const y = (v: number) => n(-v);

  const parts: string[] = [];
  const defs: string[] = [];
  /** A <pattern> for stripes running at `deg` (world, counter-clockwise) from `origin`; returns its fill URL. */
  const stripes = (p: StripePattern, origin: { x: number; y: number }, deg: number): string => {
    const id = `pat${defs.length}`;
    const period = patternPeriod(p);
    let at = 0;
    const rects = p.stripes.map((st) => {
      const r = `<rect x="0" y="${n(at)}" width="${n(period)}" height="${n(st.size * p.unit)}" fill="${st.color}"/>`;
      at += st.size * p.unit;
      return r;
    });
    // Pattern space: stripes along +x, repeating along +y; SVG y points down, so world angles are negated.
    defs.push(
      `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${n(period)}" height="${n(period)}" patternTransform="translate(${n(origin.x)} ${y(origin.y)}) rotate(${n(-deg)})">${rects.join('')}</pattern>`,
    );
    return `url(#${id})`;
  };
  /** Fill attributes of a border band. */
  const bandFill = (s: StrokeStyle, color: string, origin: { x: number; y: number }, baseDeg: number): string => {
    const fill = s.pattern && patternPeriod(s.pattern) > 0 ? stripes(s.pattern, origin, baseDeg + s.pattern.angle) : (s.color ?? color);
    return `fill="${fill}" fill-opacity="${n(borderOpacity(s))}"`;
  };
  const strokes = new StrokeGeometry(doc);
  const pts = (cs: { x: number; y: number }[]) => cs.map((c) => `${n(c.x)},${y(c.y)}`).join(' ');
  const u = doc.underlay;
  if (u?.visible) {
    parts.push(
      `<image href="${esc(u.src)}" x="${n(u.x)}" y="${y(u.y + u.height)}" width="${n(u.width)}" height="${n(u.height)}" opacity="${u.opacity}" preserveAspectRatio="none"/>`,
    );
  }
  const order = doc.paintOrder();
  const painted = [...doc.entities.values()].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  for (const layer of doc.layers.values()) {
    if (!doc.isLayerVisible(layer.id)) continue;
    const shapes: string[] = [];
    const labels: string[] = [];
    for (const e of painted) {
      if (e.layer !== layer.id) continue;
      if (e.kind === 'shape') {
        const poly = doc.shapePolygon(e);
        const opacity = e.fillOpacity ?? (e.fill || e.fillImage ? 0.35 : 0.08);
        if (e.fillImage) {
          const clip = `clip${defs.length}`;
          defs.push(`<clipPath id="${clip}"><polygon points="${pts(poly)}"/></clipPath>`);
          const xs = poly.map((q) => q.x);
          const ys = poly.map((q) => q.y);
          const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
          if (e.fillImage.fit === 'tile') {
            // Tiles are `size` mm wide with the picture's own aspect ratio, as on the canvas.
            const t = e.fillImage.size ?? 1000;
            const px = dataImageSize(e.fillImage.src);
            const th = px ? (t * px.height) / px.width : t;
            const pid = `pat${defs.length}`;
            defs.push(`<pattern id="${pid}" patternUnits="userSpaceOnUse" width="${n(t)}" height="${n(th)}"><image href="${esc(e.fillImage.src)}" width="${n(t)}" height="${n(th)}" preserveAspectRatio="none"/></pattern>`);
            shapes.push(`<polygon points="${pts(poly)}" fill="url(#${pid})" fill-opacity="${n(opacity)}" stroke="none"/>`);
          } else {
            shapes.push(
              `<image href="${esc(e.fillImage.src)}" x="${n(x0)}" y="${y(y1)}" width="${n(x1 - x0)}" height="${n(y1 - y0)}" preserveAspectRatio="none" opacity="${n(opacity)}" clip-path="url(#${clip})"/>`,
            );
          }
        } else shapes.push(`<polygon points="${pts(poly)}" fill="${e.fill ?? layer.color}" fill-opacity="${n(opacity)}" stroke="none"/>`);
        if (labelVisible(e.label)) {
          const { at, anchor } = shapeLabelPlacement(doc, e);
          textBlock(labels, shapeLabelRows(e, formatArea(doc.shapeArea(e))), anchor, at, textSize, labelOpacity(e.label), CANVAS.text, textSize * 0.5);
        }
      } else if (e.kind === 'line') {
        const a = doc.point(e.p1);
        const b = doc.point(e.p2);
        // Same as the canvas: a styled line is its band (wall thickness) filled in its colour or stripes, over the reference line.
        const band = strokes.band(e.id);
        if (band && e.stroke) {
          const deg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
          shapes.push(`<polygon points="${pts(band)}" ${bandFill(e.stroke, layer.color, a, deg)}/>`);
        }
        const own = e.stroke?.color ? ` stroke="${e.stroke.color}"` : '';
        const alpha = e.stroke && e.stroke.width === 0 && e.stroke.opacity !== undefined ? ` stroke-opacity="${n(e.stroke.opacity)}"` : '';
        shapes.push(`<line x1="${n(a.x)}" y1="${y(a.y)}" x2="${n(b.x)}" y2="${y(b.y)}"${own}${alpha}/>`);
      } else if (e.kind === 'circle') {
        const c = doc.point(e.center);
        if (e.stroke && e.stroke.width > 0) {
          const [r0, r1] = circleBandRadii(e.radius, e.stroke);
          const ring = (r: number) => `M${n(c.x + r)} ${y(c.y)}A${n(r)} ${n(r)} 0 1 0 ${n(c.x - r)} ${y(c.y)}A${n(r)} ${n(r)} 0 1 0 ${n(c.x + r)} ${y(c.y)}Z`;
          shapes.push(`<path d="${ring(r1)}${r0 > 0 ? ring(r0) : ''}" fill-rule="evenodd" stroke="none" ${bandFill(e.stroke, layer.color, c, 0)}/>`);
        }
        const own = e.stroke?.color ? ` stroke="${e.stroke.color}"` : '';
        shapes.push(`<circle cx="${n(c.x)}" cy="${y(c.y)}" r="${n(e.radius)}"${own}/>`);
      } else if (e.kind === 'equipment') {
        // Plan symbol shared with the canvas: round columns, stair treads, ramp and lift marks.
        const sym = planSymbol(doc, e);
        const type = doc.equipmentTypes.get(e.type);
        const at = doc.point(e.at);
        const opacity = sym.solid ? 0.6 : 0.08;
        if (sym.outline === 'circle') {
          shapes.push(`<circle cx="${n(at.x)}" cy="${y(at.y)}" r="${n((type?.width ?? 0) / 2)}" fill="${layer.color}" fill-opacity="${opacity}"/>`);
        } else shapes.push(`<polygon points="${pts(sym.polygon)}" fill="${layer.color}" fill-opacity="${opacity}"/>`);
        if (sym.segments.length > 0) {
          shapes.push(`<path d="${sym.segments.map(([p, q]) => `M${n(p.x)} ${y(p.y)}L${n(q.x)} ${y(q.y)}`).join('')}"/>`);
        }
        const fs = Math.min(textSize, Math.min(type?.width ?? 0, type?.depth ?? 0) / 4);
        if (fs > 0) {
          const lines = [e.tag, type?.name ?? '', sym.note ?? ''].filter(Boolean);
          lines.forEach((t, i) => {
            const dy = (i - (lines.length - 1) / 2) * fs * 1.2;
            labels.push(`<text x="${n(at.x)}" y="${n(-at.y + dy)}" font-size="${n(fs)}">${esc(t)}</text>`);
          });
        }
      } else if (e.kind === 'label') {
        if (labelVisible(e)) textBlock(labels, labelRows(e.items), e.anchor ?? 'center', doc.point(e.at), labelSize(e), labelOpacity(e), e.color ?? layer.color);
      } else if (e.kind === 'point') {
        const p = doc.point(e.at);
        const r = textSize * 0.25;
        shapes.push(`<path d="M${n(p.x - r)} ${y(p.y)}L${n(p.x + r)} ${y(p.y)}M${n(p.x)} ${y(p.y - r)}L${n(p.x)} ${y(p.y + r)}" stroke="${layer.color}"/>`);
      } else {
        const a = doc.point(e.p1);
        const b = doc.point(e.p2);
        const { d1, d2, normal, length } = dimensionGeometry(a, b, e.offset);
        const color = e.value !== undefined ? COLORS.driving : COLORS.dimension;
        const ext1 = `M${n(a.x)} ${y(a.y)}L${n(d1.x)} ${y(d1.y)}`;
        const ext2 = `M${n(b.x)} ${y(b.y)}L${n(d2.x)} ${y(d2.y)}`;
        shapes.push(`<path d="${ext1}${ext2}M${n(d1.x)} ${y(d1.y)}L${n(d2.x)} ${y(d2.y)}" stroke="${color}"/>`);
        let angle = (-Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
        if (angle > 90 || angle <= -90) angle += 180;
        const mx = (d1.x + d2.x) / 2 + normal.x * textSize * 0.8;
        const my = -((d1.y + d2.y) / 2 + normal.y * textSize * 0.8);
        labels.push(
          `<text x="${n(mx)}" y="${n(my)}" font-size="${n(textSize)}" fill="${color}" transform="rotate(${n(angle)} ${n(mx)} ${n(my)})">${Math.round(length)}</text>`,
        );
      }
    }
    if (shapes.length === 0) continue;
    parts.push(
      `<g data-layer="${esc(layer.name)}" stroke="${layer.color}" fill="none">${shapes.join('')}</g>`,
      `<g fill="${layer.color}">${labels.join('')}</g>`,
    );
  }

  // Graphic scale: a bar of a round length about a sixth of the drawing wide, true at any print size.
  const bar = scaleBarLength(1, w / 6);
  const barH = textSize * 0.5;
  const bx = ext.minX;
  const by = -ext.minY + margin + footer * 0.5; // SVG y of the bar's top, in the footer under the drawing
  const segs = [0, 1, 2, 3].map(
    (i) => `<rect x="${n(bx + (bar / 4) * i)}" y="${n(by)}" width="${n(bar / 4)}" height="${n(barH)}" fill="${i % 2 === 0 ? CANVAS.text : CANVAS.background}"/>`,
  );
  const ratio = opts.scale ? ` · 축척 1:${opts.scale}` : '';
  parts.push(
    `<g data-role="scale-bar" stroke="${CANVAS.text}">${segs.join('')}<rect x="${n(bx)}" y="${n(by)}" width="${n(bar)}" height="${n(barH)}" fill="none"/></g>`,
    `<text x="${n(bx)}" y="${n(by - textSize * 0.7)}" font-size="${n(textSize)}" fill="${CANVAS.text}" style="text-anchor:start">${esc(formatScaleLength(bar) + ratio)}</text>`,
  );
  // At a print scale the paper size is the drawing size divided by N.
  const paper = opts.scale ? opts.scale : 1;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(minX)} ${n(minY)} ${n(w)} ${n(h)}" width="${n(w / paper)}mm" height="${n(h / paper)}mm">`,
    `<style>line,circle,polygon,path,rect{vector-effect:non-scaling-stroke;stroke-width:0.8}text{font-family:system-ui,'Malgun Gothic',sans-serif;text-anchor:middle;dominant-baseline:middle;stroke:none}</style>`,
    ...(defs.length > 0 ? [`<defs>${defs.join('')}</defs>`] : []),
    `<rect x="${n(minX)}" y="${n(minY)}" width="${n(w)}" height="${n(h)}" fill="#fff" stroke="none"/>`,
    ...parts,
    '</svg>',
  ].join('\n');
}

/** Writes rows of text whose `anchor` side sits on world point `at`, `size` mm high (see blockLayout). */
function textBlock(out: string[], rows: string[], anchor: LabelAnchor, at: Vec2, size: number, opacity: number, color: string, pad = 0): void {
  if (rows.length === 0) return;
  const layout = blockLayout(anchor, { x: at.x, y: -at.y }, rows.length, size * LINE_SPACING, pad);
  const align = layout.align === 'left' ? 'start' : layout.align === 'right' ? 'end' : 'middle';
  const alpha = opacity < 1 ? ` fill-opacity="${n(opacity)}"` : '';
  rows.forEach((t, i) => out.push(`<text x="${n(layout.x)}" y="${n(layout.ys[i])}" font-size="${n(size)}" fill="${color}"${alpha} style="text-anchor:${align}">${esc(t)}</text>`));
}

/** Bounds of what the SVG shows: entities on visible layers and a visible underlay. */
function visibleExtents(doc: DocumentModel): Box | null {
  // Accumulated in a loop: spreading every box into Math.min would overflow the argument limit on big drawings.
  let box: Box | null = null;
  const grow = (b: Box) => {
    box = box
      ? { minX: Math.min(box.minX, b.minX), minY: Math.min(box.minY, b.minY), maxX: Math.max(box.maxX, b.maxX), maxY: Math.max(box.maxY, b.maxY) }
      : b;
  };
  // Hidden labels are not drawn, so they must not stretch the sheet either.
  for (const e of doc.entities.values()) if (doc.isVisible(e) && !(e.kind === 'label' && !labelVisible(e))) grow(doc.bboxOf(e));
  const u = doc.underlay;
  if (u?.visible) grow({ minX: u.x, minY: u.y, maxX: u.x + u.width, maxY: u.y + u.height });
  return box;
}
