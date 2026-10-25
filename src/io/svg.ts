/**
 * @file svg.ts
 *
 * Exports visible layers as an SVG in millimetres; also used for printing.
 */
import { dimensionGeometry } from '../geom/dimension';
import type { Box } from '../geom/vec';
import type { DocumentModel } from '../model/document';
import { StrokeGeometry } from '../model/strokes';
import { planSymbol } from '../model/symbols';
import { COLORS } from '../view/renderer';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const n = (v: number) => String(Math.round(v * 100) / 100);

/**
 * The visible drawing as a standalone SVG in millimetres (1 user unit = 1 mm, Y flipped to point down).
 * Strokes keep a constant hairline width whatever the zoom or print scale. Returns null for an empty drawing.
 */
export function drawingSvg(doc: DocumentModel): string | null {
  const ext = visibleExtents(doc);
  if (!ext) return null;
  const size = Math.max(ext.maxX - ext.minX, ext.maxY - ext.minY, 1);
  const margin = size * 0.04;
  const minX = ext.minX - margin;
  const minY = -ext.maxY - margin; // SVG y of the top edge
  const w = ext.maxX - ext.minX + 2 * margin;
  const h = ext.maxY - ext.minY + 2 * margin;
  const textSize = size / 90;
  const y = (v: number) => n(-v);

  const parts: string[] = [];
  const strokes = new StrokeGeometry(doc);
  const pts = (cs: { x: number; y: number }[]) => cs.map((c) => `${n(c.x)},${y(c.y)}`).join(' ');
  const u = doc.underlay;
  if (u?.visible) {
    parts.push(
      `<image href="${esc(u.src)}" x="${n(u.x)}" y="${y(u.y + u.height)}" width="${n(u.width)}" height="${n(u.height)}" opacity="${u.opacity}" preserveAspectRatio="none"/>`,
    );
  }
  for (const layer of doc.layers.values()) {
    if (!doc.isLayerVisible(layer.id)) continue;
    const shapes: string[] = [];
    const labels: string[] = [];
    for (const e of doc.entities.values()) {
      if (e.layer !== layer.id) continue;
      if (e.kind === 'shape') {
        shapes.push(`<polygon points="${pts(doc.shapePolygon(e))}" fill="${e.fill ?? layer.color}" fill-opacity="${e.fill ? 0.35 : 0.08}" stroke="none"/>`);
      } else if (e.kind === 'line') {
        const a = doc.point(e.p1);
        const b = doc.point(e.p2);
        // Same as the canvas: a styled line is its band (wall thickness) filled in the line colour, over the reference line.
        const band = strokes.band(e.id);
        if (band) shapes.push(`<polygon points="${pts(band)}" fill="${e.stroke?.color ?? layer.color}" fill-opacity="0.85"/>`);
        const own = e.stroke?.color ? ` stroke="${e.stroke.color}"` : '';
        shapes.push(`<line x1="${n(a.x)}" y1="${y(a.y)}" x2="${n(b.x)}" y2="${y(b.y)}"${own}/>`);
      } else if (e.kind === 'circle') {
        const c = doc.point(e.center);
        shapes.push(`<circle cx="${n(c.x)}" cy="${y(c.y)}" r="${n(e.radius)}"/>`);
      } else if (e.kind === 'equipment') {
        // Plan symbol shared with the canvas: round columns, stair treads, ramp and lift marks.
        const sym = planSymbol(doc, e);
        const type = doc.equipmentTypes.get(e.type);
        const at = doc.point(e.at);
        const opacity = sym.solid ? 0.6 : 0.08;
        if (sym.outline === 'circle') {
          shapes.push(`<circle cx="${n(at.x)}" cy="${y(at.y)}" r="${n((type?.width ?? 0) / 2)}" fill="${layer.color}" fill-opacity="${opacity}"/>`);
        } else shapes.push(`<polygon points="${pts(doc.cornersOf(e))}" fill="${layer.color}" fill-opacity="${opacity}"/>`);
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

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(minX)} ${n(minY)} ${n(w)} ${n(h)}" width="${n(w)}mm" height="${n(h)}mm">`,
    `<style>line,circle,polygon,path{vector-effect:non-scaling-stroke;stroke-width:0.8}text{font-family:system-ui,'Malgun Gothic',sans-serif;text-anchor:middle;dominant-baseline:middle;stroke:none}</style>`,
    `<rect x="${n(minX)}" y="${n(minY)}" width="${n(w)}" height="${n(h)}" fill="#fff"/>`,
    ...parts,
    '</svg>',
  ].join('\n');
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
  for (const e of doc.entities.values()) if (doc.isVisible(e)) grow(doc.bboxOf(e));
  const u = doc.underlay;
  if (u?.visible) grow({ minX: u.x, minY: u.y, maxX: u.x + u.width, maxY: u.y + u.height });
  return box;
}
