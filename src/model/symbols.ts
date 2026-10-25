/**
 * @file symbols.ts
 *
 * Plan symbols of equipment and structural presets, in world coordinates, so the canvas renderer and the SVG and
 * DXF exports draw the same thing: a column is a solid square or circle, a stair shows its treads and walking
 * direction, a ramp its direction arrow, a lift a crossed car with its door, plain equipment a front tick.
 * DOM-free. Related: src/model/presets.ts (properties), src/view/renderer.ts.
 */
import type { Vec2 } from '../geom/vec';
import type { DocumentModel } from './document';
import { categoryOf, propValue } from './presets';
import type { EquipmentEntity } from './types';

export interface PlanSymbol {
  /** Footprint outline: the rotated rectangle, or a circle of diameter `width` for round columns. */
  outline: 'rect' | 'circle';
  /** Extra strokes inside or around the footprint. */
  segments: [Vec2, Vec2][];
  /** Filled solid (columns) rather than tinted. */
  solid: boolean;
  /** Short text such as "UP" or a slope, drawn under the tag. */
  note?: string;
}

/** Most tread lines drawn for one stair; more would only darken the symbol. */
const MAX_TREADS = 60;

export function planSymbol(doc: DocumentModel, e: EquipmentEntity): PlanSymbol {
  const type = doc.equipmentTypes.get(e.type);
  const w = type?.width ?? 0;
  const d = type?.depth ?? 0;
  const c = doc.point(e.at);
  const r = (e.rotation * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  // Local frame: x across the width, y from the front (-d/2) to the back (+d/2).
  const P = (x: number, y: number): Vec2 => ({ x: c.x + x * cos - y * sin, y: c.y + x * sin + y * cos });
  const seg = (x1: number, y1: number, x2: number, y2: number): [Vec2, Vec2] => [P(x1, y1), P(x2, y2)];
  const arrow = (fromY: number, toY: number): [Vec2, Vec2][] => {
    const head = Math.min(w * 0.25, Math.abs(toY - fromY) * 0.2);
    const s = Math.sign(toY - fromY) || 1;
    return [seg(0, fromY, 0, toY), seg(0, toY, -head, toY - s * head), seg(0, toY, head, toY - s * head)];
  };
  switch (categoryOf(type)) {
    case 'column':
      return { outline: propValue(doc, e, 'shape') === 'round' ? 'circle' : 'rect', segments: [], solid: true };
    case 'stair': {
      const tread = Math.max(1, Number(propValue(doc, e, 'tread')) || 280);
      const segments: [Vec2, Vec2][] = [];
      const count = Math.min(MAX_TREADS, Math.floor(d / tread));
      for (let i = 1; i <= count; i++) {
        const y = -d / 2 + i * tread;
        if (y < d / 2 - 1e-6) segments.push(seg(-w / 2, y, w / 2, y));
      }
      const up = propValue(doc, e, 'direction') !== 'down';
      segments.push(...(up ? arrow(-d / 2 + tread / 2, d / 2 - tread / 2) : arrow(d / 2 - tread / 2, -d / 2 + tread / 2)));
      return { outline: 'rect', segments, solid: false, note: up ? 'UP' : 'DN' };
    }
    case 'ramp': {
      const segments = arrow(-d * 0.4, d * 0.4);
      // Chevrons along the slope, as on architectural plans.
      for (const y of [-d * 0.2, 0, d * 0.2]) segments.push(seg(-w * 0.3, y - w * 0.15, 0, y), seg(0, y, w * 0.3, y - w * 0.15));
      return { outline: 'rect', segments, solid: false, note: 'RAMP' };
    }
    case 'lift':
      return {
        outline: 'rect',
        segments: [seg(-w / 2, -d / 2, w / 2, d / 2), seg(w / 2, -d / 2, -w / 2, d / 2), seg(-w * 0.3, -d / 2 - d * 0.04, w * 0.3, -d / 2 - d * 0.04)],
        solid: false,
      };
    default: {
      // Front marker: a short tick into the footprint from the middle of the front edge.
      const t = Math.min(d * 0.25, Math.max(w, d) * 0.08);
      return { outline: 'rect', segments: [seg(0, -d / 2, 0, -d / 2 + t)], solid: false };
    }
  }
}
