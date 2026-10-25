/**
 * @file viewport.ts
 *
 * World (mm, Y up) <-> screen (CSS px, Y down) transform, zoom/pan and adaptive grid spacing.
 */
import type { Box, Vec2 } from '../geom/vec';

export const MIN_SCALE = 1e-4; // px per mm (≈ 10 km across a screen)
export const MAX_SCALE = 200; // px per mm

/**
 * World (mm, Y up) ⇄ screen (CSS px, Y down) transform.
 * screen.x = world.x * scale + originX, screen.y = -world.y * scale + originY
 */
export class Viewport {
  scale = 0.1; // px per mm: 1 m = 100 px
  originX = 0;
  originY = 0;
  width = 1;
  height = 1;

  resize(width: number, height: number): void {
    // Keep the world point at the centre of the screen fixed while resizing.
    const centre = this.toWorld({ x: this.width / 2, y: this.height / 2 });
    this.width = width;
    this.height = height;
    this.centreOn(centre);
  }

  toScreen(p: Vec2): Vec2 {
    return { x: p.x * this.scale + this.originX, y: -p.y * this.scale + this.originY };
  }

  toWorld(s: Vec2): Vec2 {
    return { x: (s.x - this.originX) / this.scale, y: -(s.y - this.originY) / this.scale };
  }

  /** Converts a screen distance in px to mm. */
  pxToMm(px: number): number {
    return px / this.scale;
  }

  panBy(dxPx: number, dyPx: number): void {
    this.originX += dxPx;
    this.originY += dyPx;
  }

  /** Zooms by factor keeping the world point under `at` (screen px) fixed. */
  zoomAt(at: Vec2, factor: number): void {
    const before = this.toWorld(at);
    this.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * factor));
    this.originX = at.x - before.x * this.scale;
    this.originY = at.y + before.y * this.scale;
  }

  centreOn(p: Vec2): void {
    this.originX = this.width / 2 - p.x * this.scale;
    this.originY = this.height / 2 + p.y * this.scale;
  }

  /** Fits the box into the screen with a margin in px. */
  fit(box: Box, marginPx = 40): void {
    const w = Math.max(box.maxX - box.minX, 1);
    const h = Math.max(box.maxY - box.minY, 1);
    const sx = (this.width - 2 * marginPx) / w;
    const sy = (this.height - 2 * marginPx) / h;
    this.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(sx, sy)));
    this.centreOn({ x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 });
  }

  /** Visible world region. */
  worldBounds(): Box {
    const a = this.toWorld({ x: 0, y: this.height });
    const b = this.toWorld({ x: this.width, y: 0 });
    return { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y };
  }
}

/**
 * Grid spacing in mm on a 1-2-5 progression so that minor lines are at least `minPx` apart.
 * Every 5th minor line is a major line.
 */
export function gridSpacing(scale: number, minPx = 12): { minor: number; major: number } {
  const target = minPx / scale;
  const exp = Math.floor(Math.log10(target));
  const base = 10 ** exp;
  let minor = base;
  for (const m of [1, 2, 5, 10]) {
    if (m * base >= target) {
      minor = m * base;
      break;
    }
  }
  return { minor, major: minor * 5 };
}

export function snapToGrid(p: Vec2, step: number): Vec2 {
  return { x: Math.round(p.x / step) * step, y: Math.round(p.y / step) * step };
}
