/**
 * @file inspector.ts
 *
 * Information card shown next to an object clicked in viewer mode (and in the monitoring viewer app):
 * what it is, where it is, its preset properties and design checks, and its live monitoring value.
 * Read-only by design.
 */
import type { DocumentModel } from '../model/document';
import { CATEGORY_LABELS, PROP_DEFS, categoryOf, presetInfo, propValue } from '../model/presets';
import type { Entity } from '../model/types';
import { type DisplayUnit, formatArea, formatLength } from '../view/format';
import type { LiveValue } from './host';

/** Title and rows describing an entity. */
const STATUS_LABELS: Record<string, string> = { ok: '정상', warn: '주의', alarm: '경보', offline: '수신 없음' };

export function describe(doc: DocumentModel, e: Entity, unit: DisplayUnit): { title: string; rows: [string, string, boolean?][] } {
  const rows: [string, string, boolean?][] = [];
  const layer = doc.layers.get(e.layer);
  const floor = doc.floors.get(layer?.floor ?? '');
  let title = e.name ?? '';
  if (e.kind === 'equipment') {
    const type = doc.equipmentTypes.get(e.type);
    const cat = categoryOf(type);
    title = [e.tag, e.name || type?.name].filter(Boolean).join(' ');
    rows.push(['구분', `${CATEGORY_LABELS[cat]}${type ? ` · ${type.name}` : ''}`]);
    if (type) rows.push(['크기', `${formatLength(type.width, unit)} × ${formatLength(type.depth, unit)}`]);
    for (const def of PROP_DEFS[cat]) {
      if (def.key.startsWith('max') || def.key.startsWith('min')) continue;
      const v = propValue(doc, e, def.key);
      if (v === '' || def.kind === 'floor' || def.kind === 'floors') continue;
      const text = def.kind === 'select' ? (def.options?.[String(v)] ?? String(v)) : def.kind === 'boolean' ? (v ? '예' : '아니오') : `${v}${def.unit ? ` ${def.unit}` : ''}`;
      rows.push([def.label, text]);
    }
    for (const r of presetInfo(doc, e)) rows.push([r.label, r.warning ? `${r.value} ⚠ ${r.warning}` : r.value, !!r.warning]);
  } else if (e.kind === 'shape') {
    title ||= '도형';
    rows.push(['면적', formatArea(doc.shapeArea(e))]);
  } else if (e.kind === 'line') {
    title ||= '선';
    const a = doc.point(e.p1);
    const b = doc.point(e.p2);
    rows.push(['길이', formatLength(Math.hypot(b.x - a.x, b.y - a.y), unit)]);
    if (e.stroke && e.stroke.width > 0) rows.push(['두께', `${e.stroke.width} mm`]);
  } else if (e.kind === 'circle') {
    title ||= '원';
    rows.push(['반지름', formatLength(e.radius, unit)]);
  } else {
    title ||= '치수';
  }
  rows.push(['위치', [floor?.name, layer?.name].filter(Boolean).join(' / ')]);
  return { title, rows };
}

/** Fills a card element for an entity, with its live value when it has a binding. */
export function fillInspector(card: HTMLElement, doc: DocumentModel, e: Entity, unit: DisplayUnit, live?: LiveValue, onClose?: () => void): void {
  const { title, rows } = describe(doc, e, unit);
  const h = document.createElement('h3');
  const t = document.createElement('span');
  t.textContent = title;
  h.append(t);
  if (onClose) {
    const close = document.createElement('button');
    close.textContent = '×';
    close.title = '닫기';
    close.style.padding = '0 6px';
    close.addEventListener('click', onClose);
    h.append(close);
  }
  const dl = document.createElement('dl');
  const add = (k: string, v: string, warn = false) => {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    if (warn) dd.className = 'warn';
    dl.append(dt, dd);
  };
  if (e.binding) {
    add('모니터링 키', e.binding);
    if (live) {
      add('값', `${String(live.value)}${live.unit ? ` ${live.unit}` : ''}`);
      if (live.status) add('상태', STATUS_LABELS[live.status] ?? live.status, live.status !== 'ok');
      add('수신', new Date(live.at).toLocaleTimeString());
    } else add('값', '수신 대기');
  }
  for (const [k, v, warn] of rows) add(k, v, warn);
  card.replaceChildren(h, dl);
}
