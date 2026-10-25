/**
 * @file dxfExport.ts
 *
 * Writes the document as ASCII DXF R12 (mm) so it opens in AutoCAD and other CAD tools.
 */
import { dimensionGeometry } from '../geom/dimension';
import type { Vec2 } from '../geom/vec';
import type { DocumentModel } from '../model/document';

/**
 * Writes the drawing as ASCII DXF R12 (AC1009), which every CAD program reads, in millimetres.
 * Lines and circles map directly; equipment becomes a closed polyline with its tag as text; dimensions
 * become their lines and a text, since R12 dimension entities need block geometry of their own.
 */
export function writeDxf(doc: DocumentModel): string {
  const out: (string | number)[] = [];
  const pair = (code: number, value: string | number) => out.push(code, typeof value === 'number' ? fmt(value) : value);
  const layerName = new Map<string, string>();
  const used = new Set<string>();
  for (const l of doc.layers.values()) {
    let name = encode((l.name.trim() || l.id).replace(/[<>/\\":;?*|=,']/g, '_'));
    while (used.has(name.toUpperCase())) name += '_';
    used.add(name.toUpperCase());
    layerName.set(l.id, name);
  }

  pair(0, 'SECTION');
  pair(2, 'HEADER');
  pair(9, '$ACADVER');
  pair(1, 'AC1009');
  pair(9, '$INSUNITS');
  pair(70, 4); // millimetres
  pair(9, '$MEASUREMENT');
  pair(70, 1); // metric
  pair(0, 'ENDSEC');

  pair(0, 'SECTION');
  pair(2, 'TABLES');
  pair(0, 'TABLE');
  pair(2, 'LAYER');
  pair(70, doc.layers.size);
  for (const l of doc.layers.values()) {
    pair(0, 'LAYER');
    pair(2, layerName.get(l.id)!);
    pair(70, l.locked ? 4 : 0);
    const aci = nearestAci(l.color);
    pair(62, l.visible ? aci : -aci);
  }
  pair(0, 'ENDTAB');
  pair(0, 'ENDSEC');

  pair(0, 'SECTION');
  pair(2, 'ENTITIES');
  const line = (a: Vec2, b: Vec2, layer: string) => {
    pair(0, 'LINE');
    pair(8, layer);
    pair(10, a.x);
    pair(20, a.y);
    pair(11, b.x);
    pair(21, b.y);
  };
  const text = (p: Vec2, height: number, value: string, layer: string, rotation = 0) => {
    pair(0, 'TEXT');
    pair(8, layer);
    pair(10, p.x);
    pair(20, p.y);
    pair(40, height);
    pair(1, encode(value));
    if (rotation) pair(50, rotation);
    // Centred horizontally and vertically on the point (72 = 1 centre, 73 = 2 middle; 11/21 is the anchor).
    pair(72, 1);
    pair(73, 2);
    pair(11, p.x);
    pair(21, p.y);
  };
  for (const e of doc.entities.values()) {
    const layer = layerName.get(e.layer) ?? '0';
    if (e.kind === 'line') line(doc.point(e.p1), doc.point(e.p2), layer);
    else if (e.kind === 'circle') {
      const c = doc.point(e.center);
      pair(0, 'CIRCLE');
      pair(8, layer);
      pair(10, c.x);
      pair(20, c.y);
      pair(40, e.radius);
    } else if (e.kind === 'equipment') {
      const corners = doc.cornersOf(e);
      pair(0, 'POLYLINE');
      pair(8, layer);
      pair(66, 1);
      pair(70, 1); // closed
      for (const c of corners) {
        pair(0, 'VERTEX');
        pair(8, layer);
        pair(10, c.x);
        pair(20, c.y);
      }
      pair(0, 'SEQEND');
      pair(8, layer);
      const type = doc.equipmentTypes.get(e.type);
      const size = Math.min(type?.width ?? 0, type?.depth ?? 0);
      const label = [e.tag, type?.name].filter(Boolean).join(' ');
      if (label && size > 0) text(doc.point(e.at), Math.min(size / 6, 250), label, layer);
    } else {
      const a = doc.point(e.p1);
      const b = doc.point(e.p2);
      const { d1, d2, normal, length } = dimensionGeometry(a, b, e.offset);
      const over = Math.sign(e.offset || 1) * 100;
      line(a, { x: d1.x + normal.x * over, y: d1.y + normal.y * over }, layer);
      line(b, { x: d2.x + normal.x * over, y: d2.y + normal.y * over }, layer);
      line(d1, d2, layer);
      let angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
      if (angle > 90 || angle <= -90) angle += 180; // keep text upright
      const mid = { x: (d1.x + d2.x) / 2 + normal.x * 150, y: (d1.y + d2.y) / 2 + normal.y * 150 };
      text(mid, 200, String(Math.round(length)), layer, angle);
    }
  }
  pair(0, 'ENDSEC');
  pair(0, 'EOF');
  const lines: string[] = [];
  for (let i = 0; i < out.length; i += 2) lines.push(String(out[i]).padStart(3, ' '), String(out[i + 1]));
  return `${lines.join('\r\n')}\r\n`;
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6));

/** Non-ASCII characters as \U+XXXX escapes, which AutoCAD and other DXF readers decode. */
function encode(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, (ch) => `\\U+${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
}

const ACI_RGB: [number, number, number, number][] = [
  [1, 255, 0, 0],
  [2, 255, 255, 0],
  [3, 0, 255, 0],
  [4, 0, 255, 255],
  [5, 0, 0, 255],
  [6, 255, 0, 255],
  [7, 0, 0, 0],
  [8, 128, 128, 128],
  [9, 192, 192, 192],
];

/** Closest of the standard AutoCAD colours (7 is black or white depending on the background). */
function nearestAci(hex: string): number {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return 7;
  const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16));
  let best = 7;
  let bestD = Infinity;
  for (const [aci, R, G, B] of ACI_RGB) {
    const d = (r - R) ** 2 + (g - G) ** 2 + (b - B) ** 2;
    if (d < bestD) {
      best = aci;
      bestD = d;
    }
  }
  return best;
}
