/**
 * @file theme.ts
 *
 * Design tokens: the single source of every colour in the editor, the monitoring app, the canvas and exports.
 * The palette is "Ink wash" (수묵화), chosen by the user on 2026-10-25: charcoal #4A4A4A, cool grey #CBCBCB,
 * ivory #FFFFE3 and slate blue #6D8196. Every other colour here is derived from those four (darker/lighter steps
 * and muted status hues that sit with them) so the UI stays consistent.
 *
 * - CSS reads the tokens as custom properties (`var(--ink)` …) declared in the :root block of src/style.css.
 *   That block is a copy of `cssVariables()` (so the page has its colours before any script runs);
 *   tests/theme.test.ts fails when the two differ or when style.css uses a literal colour elsewhere.
 * - TypeScript (canvas renderer, tools, defaults) imports `PALETTE`, `UI`, `CANVAS`, `STATUS` directly.
 * DOM-free.
 */

/** The four colours of the Ink wash palette. */
export const PALETTE = {
  charcoal: '#4A4A4A',
  coolGrey: '#CBCBCB',
  ivory: '#FFFFE3',
  slate: '#6D8196',
} as const;

/** Muted hues for meaning (status, constraint state) that keep the palette's calm, low-saturation tone. */
const HUE = {
  green: '#5E8C6A',
  ochre: '#B8873E',
  red: '#B04A42',
  plum: '#86708F',
  teal: '#4F8584',
} as const;

/** UI chrome tokens, exposed to CSS as --name (camelCase → kebab-case). */
export const UI = {
  /** Page and canvas background. */
  paper: PALETTE.ivory,
  /** Panels, ribbon, cards: a step darker than the page so areas read apart. */
  paperSoft: '#F5F5D9',
  /** Hover/pressed fill for controls on paper. */
  paperDeep: '#EBEBD0',
  /** Text and icons. */
  ink: PALETTE.charcoal,
  /** Strong text (headings) and the quick bar. */
  inkDeep: '#333333',
  /** Secondary text. */
  inkMuted: '#7A7A72',
  /** Borders and separators. */
  line: PALETTE.coolGrey,
  /** Accent: selection, active tab, primary buttons. */
  accent: PALETTE.slate,
  accentDeep: '#56687A',
  accentSoft: '#DDE2E3',
  /** Text on dark (quick bar, accent buttons). */
  onDark: PALETTE.ivory,
  /** Quick bar controls on the charcoal bar. */
  barControl: '#5C5C5C',
  barLine: '#6E6E6E',
  ok: HUE.green,
  warn: HUE.ochre,
  alarm: HUE.red,
  shadow: 'rgba(51, 51, 51, 0.18)',
} as const;

/** Live-value status colours (viewer and viewer mode). */
export const STATUS: Record<'ok' | 'warn' | 'alarm' | 'offline', string> = {
  ok: HUE.green,
  warn: HUE.ochre,
  alarm: HUE.red,
  offline: '#A3A39A',
};

/** Canvas colours (src/view/renderer.ts COLORS re-exports these). */
export const CANVAS = {
  background: PALETTE.ivory,
  gridMinor: '#EFEFD4',
  gridMajor: '#DCDCC6',
  axis: '#B5B5A8',
  selected: PALETTE.slate,
  hover: HUE.ochre,
  preview: '#8597AA',
  text: PALETTE.charcoal,
  window: 'rgba(109, 129, 150, 0.10)',
  crossing: 'rgba(94, 140, 106, 0.10)',
  snap: HUE.green,
  constrained: '#4E7A5A',
  driving: HUE.red,
  badge: HUE.plum,
  guide: 'rgba(94, 140, 106, 0.6)',
  dimension: '#56687A',
  measure: HUE.plum,
  measureFill: 'rgba(134, 112, 143, 0.10)',
  /** Ghost fill of an equipment footprint while placing it. */
  placeFill: 'rgba(109, 129, 150, 0.10)',
  /** Backing plate behind canvas labels so they stay readable over geometry. */
  labelPlate: 'rgba(255, 255, 227, 0.88)',
} as const;

/** Default colour of a new layer, and the cycle the tree offers for further layers. */
export const LAYER_DEFAULT = PALETTE.charcoal;
export const LAYER_COLORS = [PALETTE.charcoal, PALETTE.slate, HUE.green, HUE.ochre, HUE.plum, HUE.red, HUE.teal];

/** Default face fill of a shape and band colour of a styled line when the layer gives none. */
export const SHAPE_FILL = '#A9B4BF';

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** CSS custom properties for the UI tokens and status colours. */
export function cssVariables(): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(UI)) vars[`--${kebab(k)}`] = v;
  for (const [k, v] of Object.entries(STATUS)) vars[`--status-${k}`] = v;
  return vars;
}

