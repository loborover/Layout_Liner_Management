/**
 * @file mesh.ts
 *
 * Turns a Scene3D (src/model/scene3d.ts) into merged triangle and line buffers for WebGL: one buffer per
 * colour/opacity so a whole building is a handful of draw calls, plus a triangle → entity id table for picking.
 * Uses only three's math helpers (no WebGL), so it runs and is tested in Node.
 */
import { ShapeUtils, Vector2 } from 'three';
import type { Line3, Scene3D, Solid } from '../model/scene3d';
import type { Id } from '../model/types';

export interface MeshBatch {
  color: string;
  opacity: number;
  /** xyz per vertex, three vertices per triangle. */
  positions: number[];
  /** Entity id of each triangle (positions.length / 9 entries). */
  ids: Id[];
}

export interface LineBatch {
  color: string;
  /** xyz pairs. */
  positions: number[];
}

export interface SceneBuffers {
  meshes: MeshBatch[];
  /** Outline edges of every solid (drawn in ink over the faces) and the scene's own 3D lines. */
  lines: LineBatch[];
}

/** Builds merged buffers; `edgeColor` outlines the solids (null: no outlines). */
export function sceneBuffers(scene: Scene3D, edgeColor: string | null): SceneBuffers {
  const meshes = new Map<string, MeshBatch>();
  const lines = new Map<string, LineBatch>();
  const lineBatch = (color: string) => {
    let b = lines.get(color);
    if (!b) lines.set(color, (b = { color, positions: [] }));
    return b;
  };
  for (const s of scene.solids) {
    const key = `${s.color}|${s.opacity}`;
    let m = meshes.get(key);
    if (!m) meshes.set(key, (m = { color: s.color, opacity: s.opacity, positions: [], ids: [] }));
    addSolid(m, s);
    if (edgeColor) addOutline(lineBatch(edgeColor), s);
  }
  for (const l of scene.lines) addLine(lineBatch(l.color), l);
  return { meshes: [...meshes.values()], lines: [...lines.values()] };
}

function addLine(b: LineBatch, l: Line3): void {
  b.positions.push(...l.a, ...l.b);
}

function tri(m: MeshBatch, id: Id, a: number[], b: number[], c: number[]): void {
  m.positions.push(...a, ...b, ...c);
  m.ids.push(id);
}

function addSolid(m: MeshBatch, s: Solid): void {
  const n = s.outline.length;
  if (n < 3) return;
  const flat = s.top.every((t, i) => Math.abs(t - s.bottom[i]) < 1e-6);
  const bottom = (i: number) => [s.outline[i].x, s.outline[i].y, s.bottom[i]];
  const top = (i: number) => [s.outline[i].x, s.outline[i].y, s.top[i]];
  // Caps: triangulate the outline once (handles concave rooms); winding doesn't matter, faces are double-sided.
  const contour = s.outline.map((p) => new Vector2(p.x, p.y));
  for (const [a, b, c] of ShapeUtils.triangulateShape(contour, [])) {
    tri(m, s.id, top(a), top(b), top(c));
    if (!flat) tri(m, s.id, bottom(a), bottom(b), bottom(c));
  }
  if (flat) return;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tri(m, s.id, bottom(i), bottom(j), top(j));
    tri(m, s.id, bottom(i), top(j), top(i));
  }
}

function addOutline(b: LineBatch, s: Solid): void {
  const n = s.outline.length;
  const flat = s.top.every((t, i) => Math.abs(t - s.bottom[i]) < 1e-6);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const p = s.outline[i];
    const q = s.outline[j];
    b.positions.push(p.x, p.y, s.top[i], q.x, q.y, s.top[j]);
    if (flat) continue;
    b.positions.push(p.x, p.y, s.bottom[i], q.x, q.y, s.bottom[j]);
    // Vertical edges only at real corners, so cylinders don't turn into a picket fence.
    const prev = s.outline[(i - 1 + n) % n];
    const turn = Math.abs((p.x - prev.x) * (q.y - p.y) - (p.y - prev.y) * (q.x - p.x)) / (Math.hypot(p.x - prev.x, p.y - prev.y) * Math.hypot(q.x - p.x, q.y - p.y) || 1);
    if (turn > 0.25) b.positions.push(p.x, p.y, s.bottom[i], p.x, p.y, s.top[i]);
  }
}
