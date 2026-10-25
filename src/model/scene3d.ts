/**
 * @file scene3d.ts
 *
 * Renderer-independent 3D scene of a drawing (request: 3D views of every object). Turns the 2D document plus Z and
 * heights (src/model/heights.ts) into simple solids and lines in world millimetres (Z up):
 * - a styled line (wall) becomes its band extruded by its height (flat without one); a plain line stays a 3D line;
 * - a shape becomes a face at its points' Z, or a prism when it has a height;
 * - a circle becomes a cylinder (height > 0) or a ring;
 * - equipment becomes a box (a cylinder for round columns), a stair becomes steps, a ramp a wedge;
 * - a point object becomes a small 3D cross;
 * - floors are stacked by their elevation.
 * DOM-free, so the same scene can be built in the browser (src/view3d/) or on a host server that renders or
 * converts it (glTF, images) for heavy drawings; the API exposes it as `scene3d`.
 */
import type { Vec2 } from '../geom/vec';
import type { DocumentModel } from './document';
import { heightOf } from './heights';
import { categoryOf, propValue } from './presets';
import { StrokeGeometry } from './strokes';
import type { Entity, Id } from './types';
import { CANVAS, SHAPE_FILL } from '../theme';

/** A vertical prism: `outline` in plan (counter-clockwise or not), with a bottom and top Z per outline vertex. */
export interface Solid {
  id: Id;
  outline: Vec2[];
  bottom: number[];
  top: number[];
  color: string;
  opacity: number;
}

export interface Line3 {
  id: Id;
  a: [number, number, number];
  b: [number, number, number];
  color: string;
}

export interface Scene3D {
  solids: Solid[];
  lines: Line3[];
  /** World bounds of everything in the scene, mm. */
  min: [number, number, number];
  max: [number, number, number];
}

export interface SceneOptions {
  /** 'all' stacks every floor; 'active' shows only the active floor. Default 'all'. */
  floors?: 'all' | 'active';
  /** Colour overrides per entity (selection, live status). */
  colors?: ReadonlyMap<Id, string>;
}

/** Segments used to approximate circles and round columns. */
const CIRCLE_SEGMENTS = 32;
/** Half size of the 3D cross drawn for a point object, mm. */
const POINT_CROSS = 150;
/** Most steps drawn for one stair. */
const MAX_STEPS = 40;

export function buildScene(doc: DocumentModel, opts: SceneOptions = {}): Scene3D {
  const strokes = new StrokeGeometry(doc);
  const solids: Solid[] = [];
  const lines: Line3[] = [];
  const all = (opts.floors ?? 'all') === 'all';

  for (const e of doc.entities.values()) {
    if (e.kind === 'dimension') continue;
    if (all ? !doc.isLayerShown(e.layer) : !doc.isVisible(e)) continue;
    const floorId = doc.floorOf(e);
    const base = doc.floors.get(floorId ?? '')?.elevation ?? 0;
    const z = (pid: Id) => base + (doc.points.get(pid)?.z ?? 0);
    const layerColor = doc.layers.get(e.layer)?.color ?? CANVAS.text;
    const override = opts.colors?.get(e.id);
    const h = heightOf(doc, e);
    switch (e.kind) {
      case 'line': {
        const a = doc.point(e.p1);
        const b = doc.point(e.p2);
        const band = strokes.band(e.id);
        if (band) {
          // Band corners: start-u1, end-u1, end-u2, start-u2. Without a height the band lies flat on the floor.
          const bottom = [z(e.p1), z(e.p2), z(e.p2), z(e.p1)];
          solids.push({ id: e.id, outline: band, bottom, top: bottom.map((v) => v + h), color: override ?? e.stroke?.color ?? layerColor, opacity: 1 });
        } else if (h > 0) {
          // A plain line with a height: a thin vertical panel.
          const bottom = [z(e.p1), z(e.p2), z(e.p2), z(e.p1)];
          solids.push({ id: e.id, outline: [a, b, b, a], bottom, top: bottom.map((v) => v + h), color: override ?? layerColor, opacity: 0.6 });
        } else {
          lines.push({ id: e.id, a: [a.x, a.y, z(e.p1)], b: [b.x, b.y, z(e.p2)], color: override ?? e.stroke?.color ?? layerColor });
        }
        break;
      }
      case 'shape': {
        const outline = doc.shapePolygon(e);
        const bottom = e.points.map(z);
        solids.push({
          id: e.id,
          outline,
          bottom,
          top: bottom.map((v) => v + h),
          color: override ?? e.fill ?? SHAPE_FILL,
          opacity: h > 0 ? 0.85 : 0.45,
        });
        break;
      }
      case 'circle': {
        const c = doc.point(e.center);
        const outline = circle(c, e.radius);
        const z0 = z(e.center);
        if (h > 0) solids.push({ id: e.id, outline, bottom: outline.map(() => z0), top: outline.map(() => z0 + h), color: override ?? layerColor, opacity: 0.9 });
        else outline.forEach((p, i) => {
          const q = outline[(i + 1) % outline.length];
          lines.push({ id: e.id, a: [p.x, p.y, z0], b: [q.x, q.y, z0], color: override ?? layerColor });
        });
        break;
      }
      case 'point': {
        // A point object shows as a small 3D cross at its X, Y, Z.
        const p = doc.point(e.at);
        const zz = z(e.at);
        const color = override ?? layerColor;
        lines.push(
          { id: e.id, a: [p.x - POINT_CROSS, p.y, zz], b: [p.x + POINT_CROSS, p.y, zz], color },
          { id: e.id, a: [p.x, p.y - POINT_CROSS, zz], b: [p.x, p.y + POINT_CROSS, zz], color },
          { id: e.id, a: [p.x, p.y, zz - POINT_CROSS], b: [p.x, p.y, zz + POINT_CROSS], color },
        );
        break;
      }
      case 'equipment':
        solids.push(...equipmentSolids(doc, e, z(e.at), h, override ?? layerColor));
        break;
    }
  }

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const grow = (x: number, y: number, zz: number) => {
    min[0] = Math.min(min[0], x);
    min[1] = Math.min(min[1], y);
    min[2] = Math.min(min[2], zz);
    max[0] = Math.max(max[0], x);
    max[1] = Math.max(max[1], y);
    max[2] = Math.max(max[2], zz);
  };
  for (const s of solids) s.outline.forEach((p, i) => (grow(p.x, p.y, s.bottom[i]), grow(p.x, p.y, s.top[i])));
  for (const l of lines) (grow(...l.a), grow(...l.b));
  if (!Number.isFinite(min[0])) return { solids, lines, min: [0, 0, 0], max: [0, 0, 0] };
  return { solids, lines, min, max };
}

function circle(c: Vec2, r: number): Vec2[] {
  return Array.from({ length: CIRCLE_SEGMENTS }, (_, i) => {
    const t = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
    return { x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) };
  });
}

/** Equipment and structural presets: a box, a round column, steps for a stair, a wedge for a ramp. */
function equipmentSolids(doc: DocumentModel, e: Extract<Entity, { kind: 'equipment' }>, z0: number, h: number, color: string): Solid[] {
  const type = doc.equipmentTypes.get(e.type);
  const w = type?.width ?? 0;
  const d = type?.depth ?? 0;
  const c = doc.point(e.at);
  const r = (e.rotation * Math.PI) / 180;
  // Local frame as in src/model/symbols.ts: x across the width, y from the front (-d/2) to the back (+d/2).
  const P = (x: number, y: number): Vec2 => ({ x: c.x + x * Math.cos(r) - y * Math.sin(r), y: c.y + x * Math.sin(r) + y * Math.cos(r) });
  const box = (y0: number, y1: number, bottom: number, top: number, opacity = 1): Solid => {
    const outline = [P(-w / 2, y0), P(w / 2, y0), P(w / 2, y1), P(-w / 2, y1)];
    return { id: e.id, outline, bottom: outline.map(() => bottom), top: outline.map(() => top), color, opacity };
  };
  switch (categoryOf(type)) {
    case 'column':
      if (propValue(doc, e, 'shape') === 'round') {
        const outline = circle(c, w / 2);
        return [{ id: e.id, outline, bottom: outline.map(() => z0), top: outline.map(() => z0 + h), color, opacity: 1 }];
      }
      return [box(-d / 2, d / 2, z0, z0 + h)];
    case 'stair': {
      const tread = Math.max(1, Number(propValue(doc, e, 'tread')) || 280);
      const n = Math.max(1, Math.min(MAX_STEPS, Math.floor(d / tread)));
      const up = propValue(doc, e, 'direction') !== 'down';
      // Steps rise from the front edge to the back ("up") or the other way round ("down").
      return Array.from({ length: n }, (_, i) => {
        const y0 = -d / 2 + (i * d) / n;
        const rise = up ? ((i + 1) * h) / n : ((n - i) * h) / n;
        return box(y0, y0 + d / n, z0, z0 + rise, 0.95);
      });
    }
    case 'ramp': {
      const s = box(-d / 2, d / 2, z0, z0, 0.95);
      // Wedge: thin at the front, full height at the back.
      s.top = [z0 + Math.min(1, h), z0 + Math.min(1, h), z0 + h, z0 + h];
      return [s];
    }
    case 'lift':
      return [box(-d / 2, d / 2, z0, z0 + h, 0.35)];
    default:
      return [box(-d / 2, d / 2, z0, z0 + h, 0.9)];
  }
}
