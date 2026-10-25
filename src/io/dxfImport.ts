/**
 * @file dxfImport.ts
 *
 * Converts a parsed DxfDrawing into points/entities/layers as one undoable command, merging coincident endpoints
 * into shared points.
 */
import { AddItems, Batch, type Command, SetLayers } from '../model/commands';
import type { DocumentModel } from '../model/document';
import { newId } from '../model/ids';
import type { Entity, Id, Layer, Point } from '../model/types';
import type { DxfDrawing } from './dxf';

/** Endpoints closer than this (mm) become one shared point, so imported outlines are connected. */
const MERGE = 0.01;

export interface ImportSummary {
  command: Command;
  lines: number;
  circles: number;
}

/** Adds an imported DXF drawing to the document: its layers by name, then its geometry, in one undoable step. */
export function importDxf(doc: DocumentModel, dxf: DxfDrawing, mmPerUnit = dxf.unitScale): ImportSummary | null {
  const k = mmPerUnit / dxf.unitScale; // the drawing is already in mm for its own unit guess
  const before: Layer[] = [...doc.layers.values()].map((l) => ({ ...l }));
  const after = before.map((l) => ({ ...l }));
  const layerId = new Map<string, Id>(after.map((l) => [l.name, l.id]));
  for (const l of dxf.layers) {
    if (layerId.has(l.name)) continue;
    const layer: Layer = { id: newId('layer'), ...l };
    after.push(layer);
    layerId.set(l.name, layer.id);
  }

  const points: Point[] = [];
  // Grid of MERGE-sized cells; a point's neighbours within MERGE are in its cell or the eight around it,
  // so points just either side of a cell boundary still merge.
  const cells = new Map<string, Point[]>();
  const pointAt = (x: number, y: number): Id => {
    const cx = Math.floor(x / MERGE);
    const cy = Math.floor(y / MERGE);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (const p of cells.get(`${cx + i},${cy + j}`) ?? []) if (Math.hypot(p.x - x, p.y - y) <= MERGE) return p.id;
      }
    }
    const p = { id: newId('p'), x, y };
    points.push(p);
    const key = `${cx},${cy}`;
    cells.set(key, [...(cells.get(key) ?? []), p]);
    return p.id;
  };

  const entities: Entity[] = [];
  const seen = new Set<string>();
  for (const s of dxf.segments) {
    const p1 = pointAt(s.a.x * k, s.a.y * k);
    const p2 = pointAt(s.b.x * k, s.b.y * k);
    // Drawn twice on the same layer; the same line on two layers is kept so each layer shows it.
    const key = `${s.layer}|${p1 < p2 ? `${p1}|${p2}` : `${p2}|${p1}`}`;
    if (p1 === p2 || seen.has(key)) continue;
    seen.add(key);
    entities.push({ id: newId('e'), kind: 'line', p1, p2, layer: layerId.get(s.layer)! });
  }
  const lines = entities.length;
  for (const c of dxf.circles) {
    const center = pointAt(c.c.x * k, c.c.y * k);
    entities.push({ id: newId('e'), kind: 'circle', center, radius: c.r * k, layer: layerId.get(c.layer)! });
  }
  if (entities.length === 0) return null;
  const steps: Command[] = [];
  if (after.length > before.length) steps.push(new SetLayers('레이어 추가', before, after));
  steps.push(new AddItems(points, entities));
  return { command: new Batch('DXF 가져오기', steps), lines, circles: entities.length - lines };
}
