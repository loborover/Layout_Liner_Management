/**
 * @file borders.ts
 *
 * Border ("Border": Weight, Color, Opacity, Pattern) helpers shared by the canvas renderer, SVG export and the
 * property panel: the three floor-marking templates the user asked for on 2026-11-15 (구역색, 설비구역색,
 * 안전구역색), stripe geometry for patterned bands, circle border radii and default opacities.
 * Stripes are computed in world millimetres, so a 50 mm stripe is 50 mm on the floor at every zoom.
 * DOM-free. Related: src/model/strokes.ts (line bands), src/model/types.ts (StrokeStyle, StripePattern).
 */
import { type Vec2, dot } from '../geom/vec';
import { MARKING } from '../theme';
import type { StripePattern, StrokeStyle } from './types';

/** Band opacity when a border has none: walls keep the slightly see-through look they always had. */
export const DEFAULT_BAND_OPACITY = 0.85;
/** Width given to a hairline when a template is applied, so its colours and stripes can show (mm). */
export const TEMPLATE_WIDTH = 100;
/** Above this many stripe pieces in one band the band is filled with its first colour instead (very zoomed out). */
export const MAX_STRIPES = 4000;

/** Opacity a border is drawn with. */
export function borderOpacity(s: StrokeStyle): number {
  return s.opacity ?? (s.width > 0 ? DEFAULT_BAND_OPACITY : 1);
}

/** A named border preset. Applying one keeps the border's width (or gives a hairline TEMPLATE_WIDTH) and alignment. */
export interface BorderTemplate {
  id: string;
  name: string;
  description: string;
  color: string;
  pattern?: StripePattern;
}

/** The user's three floor-marking templates (2026-11-15). */
export const BORDER_TEMPLATES: readonly BorderTemplate[] = [
  { id: 'zone', name: '구역색', description: '단색 노란색', color: MARKING.yellow },
  {
    id: 'equipment-zone',
    name: '설비구역색',
    description: '노란색:검정색 = 1:1 × 50 mm, 기울기 45°',
    color: MARKING.yellow,
    pattern: { stripes: [{ color: MARKING.yellow, size: 1 }, { color: MARKING.black, size: 1 }], unit: 50, angle: 45 },
  },
  {
    id: 'safety-zone',
    name: '안전구역색',
    description: '하얀색:빨간색 = 1:1 × 50 mm, 기울기 45°',
    color: MARKING.red,
    pattern: { stripes: [{ color: MARKING.white, size: 1 }, { color: MARKING.red, size: 1 }], unit: 50, angle: 45 },
  },
];

const clonePattern = (p: StripePattern): StripePattern => ({ ...p, stripes: p.stripes.map((s) => ({ ...s })) });

/** The border after applying a template: colour and pattern from the template, opaque like paint. */
export function applyTemplate(style: StrokeStyle | undefined, t: BorderTemplate): StrokeStyle {
  const width = style && style.width > 0 ? style.width : TEMPLATE_WIDTH;
  const out: StrokeStyle = { width, align: style?.align ?? 'center', color: t.color, opacity: 1 };
  if (t.pattern) out.pattern = clonePattern(t.pattern);
  return out;
}

/** The template a border matches (colour and pattern), if any. */
export function matchTemplate(style: StrokeStyle | undefined): BorderTemplate | null {
  if (!style) return null;
  const key = (c?: string, p?: StripePattern) => JSON.stringify([c?.toLowerCase(), p ? [p.unit, p.angle, p.stripes.map((s) => [s.color.toLowerCase(), s.size])] : null]);
  const k = key(style.color, style.pattern);
  return BORDER_TEMPLATES.find((t) => key(t.color, t.pattern) === k) ?? null;
}

/** Length of one repeat of a pattern in mm. */
export function patternPeriod(p: StripePattern): number {
  return p.unit * p.stripes.reduce((sum, s) => sum + s.size, 0);
}

/** One stripe piece: a quadrilateral to fill (clip it to the band) in a stripe colour. */
export interface StripePiece {
  color: string;
  quad: Vec2[];
}

/**
 * Stripe pieces covering `region` (any points spanning the band, e.g. its polygon) for a pattern whose stripes run
 * at `angleRad` (world, counter-clockwise from +X) and repeat from `origin`. The pieces are long quads that reach
 * past the region; the caller clips them to the band. Returns null when the pattern is empty or would need more
 * than `max` pieces (then a plain fill is the sensible picture anyway).
 */
export function stripePieces(region: Vec2[], origin: Vec2, angleRad: number, p: StripePattern, max = MAX_STRIPES): StripePiece[] | null {
  const period = patternPeriod(p);
  if (!(period > 0) || region.length === 0) return null;
  const t = { x: Math.cos(angleRad), y: Math.sin(angleRad) };
  const n = { x: -t.y, y: t.x };
  let nMin = Infinity;
  let nMax = -Infinity;
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const q of region) {
    const d = { x: q.x - origin.x, y: q.y - origin.y };
    const a = dot(d, n);
    const b = dot(d, t);
    nMin = Math.min(nMin, a);
    nMax = Math.max(nMax, a);
    tMin = Math.min(tMin, b);
    tMax = Math.max(tMax, b);
  }
  const first = Math.floor(nMin / period);
  const last = Math.ceil(nMax / period);
  if ((last - first) * p.stripes.length > max) return null;
  const at = (along: number, across: number): Vec2 => ({ x: origin.x + t.x * along + n.x * across, y: origin.y + t.y * along + n.y * across });
  const out: StripePiece[] = [];
  for (let j = first; j < last; j++) {
    let s = j * period;
    for (const stripe of p.stripes) {
      const e = s + stripe.size * p.unit;
      const lo = Math.max(s, nMin);
      const hi = Math.min(e, nMax);
      if (hi - lo > period * 1e-9 && stripe.size > 0) out.push({ color: stripe.color, quad: [at(tMin, lo), at(tMax, lo), at(tMax, hi), at(tMin, hi)] });
      s = e;
    }
  }
  return out;
}

/** Inner and outer radius of a circle's border band; inside is towards the centre. */
export function circleBandRadii(radius: number, s: StrokeStyle): [number, number] {
  if (s.align === 'inside') return [Math.max(radius - s.width, 0), radius];
  if (s.align === 'outside') return [radius, radius + s.width];
  return [Math.max(radius - s.width / 2, 0), radius + s.width / 2];
}

/** Copy of a border, with its pattern copied too (commands keep snapshots). */
export function cloneStroke(s: StrokeStyle): StrokeStyle {
  return s.pattern ? { ...s, pattern: clonePattern(s.pattern) } : { ...s };
}
