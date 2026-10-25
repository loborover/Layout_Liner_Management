/**
 * @file equipmentList.ts
 *
 * Equipment schedule export: one row per placed equipment, as UTF-8 CSV with BOM so Excel opens it directly.
 */
import type { DocumentModel } from '../model/document';

const HEADER = ['번호', '설비명', '폭(mm)', '깊이(mm)', 'X(mm)', 'Y(mm)', '회전(°)', '레이어'];

export interface EquipmentRow {
  tag: string;
  name: string;
  width: number;
  depth: number;
  x: number;
  y: number;
  rotation: number;
  layer: string;
}

/** Placed equipment, by name then tag (numbers in tags sort numerically). */
export function equipmentRows(doc: DocumentModel): EquipmentRow[] {
  const rows: EquipmentRow[] = [];
  for (const e of doc.entities.values()) {
    if (e.kind !== 'equipment') continue;
    const type = doc.equipmentTypes.get(e.type);
    const at = doc.point(e.at);
    rows.push({
      tag: e.tag,
      name: type?.name ?? '',
      width: type?.width ?? 0,
      depth: type?.depth ?? 0,
      x: at.x,
      y: at.y,
      rotation: e.rotation,
      layer: doc.layers.get(e.layer)?.name ?? '',
    });
  }
  const collator = new Intl.Collator('ko', { numeric: true });
  return rows.sort((a, b) => collator.compare(a.name, b.name) || collator.compare(a.tag, b.tag));
}

const cell = (v: string | number) => {
  let s = typeof v === 'number' ? String(Math.round(v * 10) / 10) : v;
  // Text a spreadsheet would run as a formula (CSV injection) is kept as text.
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Equipment list as CSV, with a BOM so spreadsheet apps read the Korean headers as UTF-8. */
export function equipmentCsv(doc: DocumentModel): string {
  const lines = [HEADER, ...equipmentRows(doc).map((r) => [r.tag, r.name, r.width, r.depth, r.x, r.y, r.rotation, r.layer])];
  return `﻿${lines.map((l) => l.map(cell).join(',')).join('\r\n')}\r\n`;
}
