/**
 * @file icons.ts
 *
 * Inline SVG icons (24×24, stroke = currentColor) for the ribbon, side rail and object tree. Kept as strings so
 * the app needs no icon font or image requests. Use `icon(name)` to get an element.
 */

const PATHS = {
  layers: '<path d="M12 3 2 8l10 5 10-5-10-5Z"/><path d="m2 13 10 5 10-5"/><path d="m2 18 10 5 10-5" opacity=".5"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  box: '<path d="M3 7 12 3l9 4v10l-9 4-9-4Z"/><path d="m3 7 9 4 9-4M12 11v10"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 17-5-5-9 8"/>',
  collapse: '<path d="m9 6 6 6-6 6"/>',
  expand: '<path d="m15 6-6 6 6 6"/>',
  maximize: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M4 9h16"/>',
  minimize: '<path d="M5 12h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.6 6.6C3.9 8.3 2 12 2 12s4 7 10 7c1.7 0 3.2-.5 4.5-1.2"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>',
  folder: '<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"/>',
  floor: '<path d="M3 21h18M5 21V7l7-4 7 4v14"/><path d="M9 21v-5h6v5M9 10h6"/>',
  layer: '<path d="M12 4 3 9l9 5 9-5-9-5Z"/><path d="m3 14 9 5 9-5"/>',
  line: '<path d="M5 19 19 5"/><circle cx="5" cy="19" r="1.5"/><circle cx="19" cy="5" r="1.5"/>',
  rect: '<rect x="4" y="6" width="16" height="12"/>',
  circle: '<circle cx="12" cy="12" r="8"/>',
  shape: '<path d="M4 18 7 5l11 3 2 10Z" fill="currentColor" fill-opacity=".15"/>',
  dimension: '<path d="M4 8v8M20 8v8M4 12h16"/><path d="m7 10-3 2 3 2M17 10l3 2-3 2"/>',
  equipment: '<rect x="4" y="7" width="16" height="10" rx="1"/><path d="M12 17v-3"/>',
  column: '<rect x="7" y="7" width="10" height="10" fill="currentColor" fill-opacity=".5"/>',
  stair: '<path d="M4 20h4v-4h4v-4h4V8h4V4"/>',
  ramp: '<path d="M3 19h18L3 9Z"/><path d="m11 14 4-2"/>',
  lift: '<rect x="5" y="3" width="14" height="18" rx="1"/><path d="m9 9 3-3 3 3M9 15l3 3 3-3"/>',
  point: '<circle cx="12" cy="12" r="3" fill="currentColor"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  top: '<path d="M6 5h12M6 15l6-6 6 6"/>',
  bottom: '<path d="M6 19h12M6 9l6 6 6-6"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16Z"/>',
  view: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  ai: '<rect x="4" y="7" width="16" height="12" rx="3"/><path d="M12 3v4M9 12h0M15 12h0M9 16h6"/>',
  pulse: '<path d="M3 12h4l2-6 4 12 2-6h6"/>',
} as const;

export type IconName = keyof typeof PATHS;

/** An inline SVG icon element. */
export function icon(name: IconName, title?: string): SVGSVGElement {
  const tpl = document.createElement('template');
  tpl.innerHTML = `<svg class="icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name]}</svg>`;
  const svg = tpl.content.firstElementChild as SVGSVGElement;
  if (title) {
    svg.setAttribute('aria-hidden', 'false');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', title);
  }
  return svg;
}

/** Replaces `data-icon="name"` placeholders in static HTML with the icon. */
export function hydrateIcons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => {
    const name = el.dataset.icon as IconName;
    if (name in PATHS && !el.querySelector('svg.icon')) el.prepend(icon(name));
  });
}
