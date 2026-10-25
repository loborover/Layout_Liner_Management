/**
 * @file svg.ts
 *
 * Exports visible layers as an SVG in millimetres; also used for printing.
 */
import { dimensionGeometry } from '../geom/dimension';
import type { Box } from '../geom/vec';
import type { DocumentModel } from '../model/document';
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
  const u = doc.underlay;
  if (u?.visible) {
    parts.push(
      `<image href="${esc(u.src)}" x="${n(u.x)}" y="${y(u.y + u.height)}" width="${n(u.width)}" height="${n(u.height)}" opacity="${u.opacity}" preserveAspectRatio="none"/>`,
    );
  }
  for (const layer of doc.layers.values()) {
    if (!layer.visible) continue;
    const shapes: string[] = [];
    const labels: string[] = [];
    for (const e of doc.entities.values()) {
      if (e.layer !== layer.id) continue;
      if (e.kind === 'line') {
        const a = doc.point(e.p1);
        const b = doc.point(e.p2);
        shapes.push(`<line x1="${n(a.x)}" y1="${y(a.y)}" x2="${n(b.x)}" y2="${y(b.y)}"/>`);
      } else if (e.kind === 'circle') {
        const c = doc.point(e.center);
        shapes.push(`<circle cx="${n(c.x)}" cy="${y(c.y)}" r="${n(e.radius)}"/>`);
      } else if (e.kind === 'equipment') {
        const pts = doc.cornersOf(e).map((c) => `${n(c.x)},${y(c.y)}`).join(' ');
        shapes.push(`<polygon points="${pts}" fill="${layer.color}" fill-opacity="0.08"/>`);
        const type = doc.equipmentTypes.get(e.type);
        const at = doc.point(e.at);
        const fs = Math.min(textSize, Math.min(type?.width ?? 0, type?.depth ?? 0) / 4);
        if (fs > 0) {
          const lines = [e.tag, type?.name ?? ''].filter(Boolean);
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
  for (const e of doc.entities.values()) if (doc.layers.get(e.layer)?.visible !== false) grow(doc.bboxOf(e));
  const u = doc.underlay;
  if (u?.visible) grow({ minX: u.x, minY: u.y, maxX: u.x + u.width, maxY: u.y + u.height });
  return box;
}
