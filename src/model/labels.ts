/**
 * @file labels.ts
 *
 * Labels (the user's request, 2026-11-15), shared by the canvas renderer, SVG/DXF export, picking and the API:
 * - a shape's own label: by default its name and area in the middle of the face (the area centroid, or the deepest
 *   inside point of an L or U shape), optionally with extra "제목: 내용" rows, placed against the top, bottom, left
 *   or right of the shape, shifted by dx/dy mm, faded (opacity) or hidden;
 * - the standalone label object (kind 'label'): rows of text at a point in world-millimetre text height.
 * Text layout is described here once (anchor → alignment) so every output places text the same way.
 * Widths are estimated from character classes (DOM-free); the canvas measures real text when it draws.
 */
import { type Box, type Vec2 } from '../geom/vec';
import { polygonLabelPoint } from '../geom/polygon';
import type { DocumentModel } from './document';
import { type LabelAnchor, type LabelEntity, type LabelItem, LABEL_TEXT_SIZE, type ShapeEntity } from './types';

export const ANCHOR_LABELS: Record<LabelAnchor, string> = { center: '중심', top: '상단', bottom: '하단', left: '좌측', right: '우측' };
export const LABEL_ANCHORS = Object.keys(ANCHOR_LABELS) as LabelAnchor[];
/** Line spacing as a multiple of the text height. */
export const LINE_SPACING = 1.25;
/** Most rows a label may have, and most characters in one title or content (files and the API are checked). */
export const MAX_LABEL_ITEMS = 50;
export const MAX_LABEL_TEXT = 500;

/** "제목: 내용" text of one row; just one part when the other is empty. */
export function labelRow(it: LabelItem): string {
  const t = it.title.trim();
  const v = it.value.trim();
  return t && v ? `${t}: ${v}` : t || v;
}

/** Text rows of a list of items, skipping empty ones. */
export function labelRows(items: readonly LabelItem[] | undefined): string[] {
  return (items ?? []).map(labelRow).filter((r) => r.length > 0);
}

/** Rows of a shape's label: name, area (already formatted by the caller) and the extra rows, as configured. */
export function shapeLabelRows(e: ShapeEntity, area: string): string[] {
  const l = e.label;
  const rows: string[] = [];
  if (l?.showName !== false && e.name) rows.push(e.name);
  if (l?.showArea !== false) rows.push(area);
  rows.push(...labelRows(l?.items));
  return rows;
}

/** Whether a label is shown. */
export const labelVisible = (l: { visible?: boolean } | undefined): boolean => l?.visible !== false;
/** Text opacity of a label. */
export const labelOpacity = (l: { opacity?: number } | undefined): number => l?.opacity ?? 1;

/**
 * Where a shape's label goes and how its text block is aligned there. 'center' is the label point of the face;
 * 'top'/'bottom' are the middle of the top/bottom of the shape's bounding box (the block hangs below / sits above
 * it); 'left'/'right' the middle of its left/right side (text runs inward). dx/dy shift the result in mm.
 */
export function shapeLabelPlacement(doc: DocumentModel, e: ShapeEntity): { at: Vec2; anchor: LabelAnchor } {
  const poly = doc.shapePolygon(e);
  const c = polygonLabelPoint(poly);
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  const anchor = e.label?.anchor ?? 'center';
  const at =
    anchor === 'top'
      ? { x: c.x, y: Math.max(...ys) }
      : anchor === 'bottom'
        ? { x: c.x, y: Math.min(...ys) }
        : anchor === 'left'
          ? { x: Math.min(...xs), y: c.y }
          : anchor === 'right'
            ? { x: Math.max(...xs), y: c.y }
            : c;
  return { at: { x: at.x + (e.label?.dx ?? 0), y: at.y + (e.label?.dy ?? 0) }, anchor };
}

/**
 * Layout of a text block of `rows` rows, `width` wide and `lineHeight` per row, whose `anchor` side sits on `at`
 * (units of the caller, Y down as on screen and in SVG). Returns the text alignment and each row's middle line.
 */
export function blockLayout(anchor: LabelAnchor, at: Vec2, rows: number, lineHeight: number, pad = 0): { align: 'left' | 'center' | 'right'; x: number; ys: number[] } {
  const h = rows * lineHeight;
  const top = anchor === 'top' ? at.y + pad : anchor === 'bottom' ? at.y - pad - h : at.y - h / 2;
  const align = anchor === 'left' ? 'left' : anchor === 'right' ? 'right' : 'center';
  const x = anchor === 'left' ? at.x + pad : anchor === 'right' ? at.x - pad : at.x;
  return { align, x, ys: Array.from({ length: rows }, (_, i) => top + lineHeight * (i + 0.5)) };
}

/** Rough width of a text in units of its height: wide for Hangul/CJK, narrower for Latin and digits. */
export function textWidthEm(text: string): number {
  let w = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    w += c >= 0x1100 && (c <= 0x11ff || c >= 0x2e80) ? 1 : c === 32 ? 0.3 : 0.6;
  }
  return w;
}

/** Text height of a label object, mm. */
export const labelSize = (e: LabelEntity): number => e.size ?? LABEL_TEXT_SIZE;

/** World box (mm) of a label object's text, estimated: used for picking, window selection and culling. */
export function labelBox(doc: DocumentModel, e: LabelEntity): Box {
  const p = doc.point(e.at);
  const size = labelSize(e);
  const rows = labelRows(e.items);
  const n = Math.max(1, rows.length);
  const w = Math.max(size, ...rows.map((r) => textWidthEm(r) * size));
  const h = n * size * LINE_SPACING;
  const anchor = e.anchor ?? 'center';
  const minX = anchor === 'left' ? p.x : anchor === 'right' ? p.x - w : p.x - w / 2;
  // World Y is up: a 'top' anchor hangs the block below the point.
  const maxY = anchor === 'top' ? p.y : anchor === 'bottom' ? p.y + h : p.y + h / 2;
  return { minX, minY: maxY - h, maxX: minX + w, maxY };
}

/**
 * Rows typed in one line, as the label tool asks for them: rows separated by "|" or new lines, each "제목: 내용"
 * (split at the first colon) or just a content without a title.
 */
export function parseLabelText(text: string): LabelItem[] {
  return text
    .split(/[|\n]/)
    .map((row) => row.trim())
    .filter((row) => row.length > 0)
    .slice(0, MAX_LABEL_ITEMS)
    .map((row) => {
      const i = row.search(/[:：]/);
      const item = i > 0 ? { title: row.slice(0, i).trim(), value: row.slice(i + 1).trim() } : { title: '', value: row };
      return { title: item.title.slice(0, MAX_LABEL_TEXT), value: item.value.slice(0, MAX_LABEL_TEXT) };
    });
}
