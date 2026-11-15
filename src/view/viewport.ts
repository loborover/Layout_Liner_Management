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

/** CSS pixels per millimetre of a screen at the CSS reference density (96 px per inch). */
export const CSS_PX_PER_MM = 96 / 25.4;

/**
 * Length (mm, on a 1-2-5 progression) of an on-screen scale bar that is between `minPx` and about 2.5 × `minPx`
 * long at this zoom.
 */
export function scaleBarLength(scale: number, minPx = 60): number {
  const target = minPx / scale;
  const exp = Math.floor(Math.log10(target));
  const base = 10 ** exp;
  for (const m of [1, 2, 5, 10]) if (m * base >= target) return m * base;
  return 10 * base;
}

/**
 * The drawing scale the screen shows, as N of "1:N": how many millimetres of the floor one millimetre of screen
 * stands for, at the CSS reference density. Real screens differ in density, so this is approximate; the scale bar
 * is the exact reference. Rounded to two significant figures.
 */
export function screenScaleRatio(scale: number): number {
  const n = 1 / (scale / CSS_PX_PER_MM);
  if (n < 1) return Math.round(n * 100) / 100;
  const exp = Math.floor(Math.log10(n)) - 1;
  const step = 10 ** Math.max(exp, 0);
  return Math.round(n / step) * step;
}

/** Scale bar label: whole metres as "5 m", smaller lengths in mm. */
export function formatScaleLength(mm: number): string {
  return mm >= 1000 ? `${mm / 1000} m` : `${mm} mm`;
}

/** Unit of the ruler labels: the largest of mm, cm and m in which the labelled grid steps are whole numbers. */
export type RulerUnit = 'mm' | 'cm' | 'm';

const RULER_UNIT_MM: Record<RulerUnit, number> = { mm: 1, cm: 10, m: 1000 };

/**
 * Unit the rulers label a grid step of `step` mm in (the major grid step): metres from 1 m up, centimetres from
 * 1 cm, else millimetres, so a label reads "3" (m) rather than "3000" (mm) and is never a fraction of the unit.
 */
export function rulerUnit(step: number): RulerUnit {
  if (step >= 1000 && Number.isInteger(step / 1000)) return 'm';
  if (step >= 10 && Number.isInteger(step / 10)) return 'cm';
  return 'mm';
}

/** Ruler label of the grid line at `mm` from the origin (0,0) in `unit`, e.g. 1500 mm in cm → "150". */
export function rulerLabel(mm: number, unit: RulerUnit): string {
  const v = mm / RULER_UNIT_MM[unit];
  // Grid lines are whole multiples of the step; rounding only removes floating point noise (and "-0").
  const r = Math.round(v * 1000) / 1000;
  return String(r === 0 ? 0 : r);
}

/**
 * Labelled ticks of a ruler between world coordinates `min` and `max`: every major grid line, with its distance
 * from the origin as a label in `unit`. Minor ticks are the minor grid lines in between.
 */
export function rulerTicks(min: number, max: number, scale: number): { unit: RulerUnit; major: { at: number; label: string }[]; minor: number[] } {
  const { minor, major } = gridSpacing(scale);
  const unit = rulerUnit(major);
  const majors: { at: number; label: string }[] = [];
  for (let i = Math.ceil(min / major); i * major <= max; i++) majors.push({ at: i * major, label: rulerLabel(i * major, unit) });
  const minors: number[] = [];
  for (let i = Math.ceil(min / minor); i * minor <= max; i++) if (i % 5 !== 0) minors.push(i * minor);
  return { unit, major: majors, minor: minors };
}
