/**
 * @file dxf.ts
 *
 * Minimal ASCII DXF reader: LINE, LWPOLYLINE/POLYLINE (with bulges), CIRCLE, ARC, INSERT of blocks, LAYER table
 * and $INSUNITS. Produces a neutral DxfDrawing; src/io/dxfImport.ts turns it into document items.
 */
import type { Vec2 } from '../geom/vec';

/**
 * Minimal ASCII DXF reader for floor plans: LINE, LWPOLYLINE, POLYLINE/VERTEX, CIRCLE, ARC and INSERT
 * (block references, expanded), with layers and drawing units. Curves other than full circles become
 * short straight segments, since the drawing model has no arcs. Text, hatches and dimensions are counted
 * and skipped.
 */

export interface DxfSegment {
  a: Vec2;
  b: Vec2;
  layer: string;
}

export interface DxfCircle {
  c: Vec2;
  r: number;
  layer: string;
}

export interface DxfLayer {
  name: string;
  color: string;
  visible: boolean;
  locked: boolean;
}

export interface DxfDrawing {
  segments: DxfSegment[];
  circles: DxfCircle[];
  layers: DxfLayer[];
  /** Millimetres per drawing unit, from $INSUNITS (1 when unknown or unitless). */
  unitScale: number;
  /** Whether $INSUNITS named the units; when false the caller should confirm the scale. */
  unitsKnown: boolean;
  /** Entity types that were not imported, with counts. */
  skipped: Map<string, number>;
}

export class DxfError extends Error {}

type Pair = [number, string];
type Entity = { type: string; pairs: Pair[] };

// $INSUNITS codes to millimetres (code table: https://ezdxf.mozman.at/docs/concepts/units.html).
const INSUNITS: Record<number, number> = {
  1: 25.4, // inches
  2: 304.8, // feet
  4: 1, // millimetres
  5: 10, // centimetres
  6: 1000, // metres
  10: 914.4, // yards
  14: 100, // decimetres
};

// AutoCAD Color Index for the first standard colours; yellow and white are darkened for a light background.
const ACI: Record<number, string> = {
  1: '#dc2626',
  2: '#ca8a04',
  3: '#16a34a',
  4: '#0891b2',
  5: '#2563eb',
  6: '#c026d3',
  7: '#1f2937',
  8: '#6b7280',
  9: '#9ca3af',
};

/** Max angle per straight segment when approximating arcs. */
const ARC_STEP = (10 * Math.PI) / 180;

export function parseDxf(text: string): DxfDrawing {
  const pairs = toPairs(text);
  const sections = splitSections(pairs);
  if (!sections.has('ENTITIES')) throw new DxfError('ENTITIES 섹션이 없습니다. ASCII DXF 파일인지 확인하십시오.');

  const header = sections.get('HEADER') ?? [];
  let unitScale = 1;
  let unitsKnown = false;
  for (let i = 0; i < header.length - 1; i++) {
    if (header[i][0] === 9 && header[i][1] === '$INSUNITS') {
      const code = Number(header[i + 1][1]);
      if (INSUNITS[code]) {
        unitScale = INSUNITS[code];
        unitsKnown = true;
      }
    }
  }

  const layers = readLayers(sections.get('TABLES') ?? []);
  const blocks = readBlocks(sections.get('BLOCKS') ?? []);
  const out: DxfDrawing = { segments: [], circles: [], layers, unitScale, unitsKnown, skipped: new Map() };
  const identity: Transform = { m: [1, 0, 0, 1], t: { x: 0, y: 0 } };
  emit(groupEntities(sections.get('ENTITIES')!), identity, blocks, out, 0, '0');

  // Scale everything to millimetres last, so blocks and arcs are computed in drawing units.
  if (unitScale !== 1) {
    const s = (p: Vec2) => ({ x: p.x * unitScale, y: p.y * unitScale });
    out.segments = out.segments.map((g) => ({ ...g, a: s(g.a), b: s(g.b) }));
    out.circles = out.circles.map((c) => ({ ...c, c: s(c.c), r: c.r * unitScale }));
  }
  const used = new Set([...out.segments.map((s) => s.layer), ...out.circles.map((c) => c.layer)]);
  for (const name of used) {
    if (!out.layers.some((l) => l.name === name)) out.layers.push({ name, color: ACI[7], visible: true, locked: false });
  }
  out.layers = out.layers.filter((l) => used.has(l.name));
  return out;
}

function toPairs(text: string): Pair[] {
  const lines = text.split(/\r?\n/);
  const out: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i].trim());
    if (!Number.isInteger(code)) throw new DxfError(`${i + 1}번째 줄의 그룹 코드를 읽을 수 없습니다. ASCII DXF 파일인지 확인하십시오.`);
    out.push([code, decodeText(lines[i + 1].trim())]);
  }
  return out;
}

/** Decodes \U+XXXX escapes that DXF uses for non-ASCII characters. */
function decodeText(s: string): string {
  return s.replace(/\\U\+([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

function splitSections(pairs: Pair[]): Map<string, Pair[]> {
  const out = new Map<string, Pair[]>();
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i][0] === 0 && pairs[i][1] === 'SECTION' && pairs[i + 1]?.[0] === 2) {
      const name = pairs[i + 1][1];
      const start = i + 2;
      let end = start;
      while (end < pairs.length && !(pairs[end][0] === 0 && pairs[end][1] === 'ENDSEC')) end++;
      out.set(name, pairs.slice(start, end));
      i = end;
    }
  }
  return out;
}

/** Splits a run of pairs into entities, each starting at a group code 0. */
function groupEntities(pairs: Pair[]): Entity[] {
  const out: Entity[] = [];
  for (const p of pairs) {
    if (p[0] === 0) out.push({ type: p[1], pairs: [] });
    else out.at(-1)?.pairs.push(p);
  }
  return out;
}

const num = (e: Entity, code: number, fallback = 0): number => {
  const p = e.pairs.find((q) => q[0] === code);
  const v = p ? Number(p[1]) : NaN;
  return Number.isFinite(v) ? v : fallback;
};
const str = (e: Entity, code: number, fallback = ''): string => e.pairs.find((q) => q[0] === code)?.[1] ?? fallback;

function readLayers(tables: Pair[]): DxfLayer[] {
  return groupEntities(tables)
    .filter((e) => e.type === 'LAYER')
    .map((e) => {
      const color = num(e, 62, 7);
      const flags = num(e, 70);
      return {
        name: str(e, 2, '0'),
        color: ACI[Math.abs(color)] ?? '#4b5563',
        visible: color >= 0 && (flags & 1) === 0, // negative colour: off; flag 1: frozen
        locked: (flags & 4) !== 0,
      };
    });
}

interface Block {
  base: Vec2;
  entities: Entity[];
}

function readBlocks(pairs: Pair[]): Map<string, Block> {
  const out = new Map<string, Block>();
  let current: { name: string; block: Block } | null = null;
  for (const e of groupEntities(pairs)) {
    if (e.type === 'BLOCK') {
      current = { name: str(e, 2), block: { base: { x: num(e, 10), y: num(e, 20) }, entities: [] } };
    } else if (e.type === 'ENDBLK') {
      if (current) out.set(current.name, current.block);
      current = null;
    } else current?.block.entities.push(e);
  }
  return out;
}

/** 2D affine transform: p' = m·p + t, m = [a, b, c, d] for [[a, c], [b, d]]. */
interface Transform {
  m: [number, number, number, number];
  t: Vec2;
}

const apply = (tr: Transform, p: Vec2): Vec2 => ({
  x: tr.m[0] * p.x + tr.m[2] * p.y + tr.t.x,
  y: tr.m[1] * p.x + tr.m[3] * p.y + tr.t.y,
});

const compose = (outer: Transform, inner: Transform): Transform => {
  const [a, b, c, d] = outer.m;
  const [e, f, g, h] = inner.m;
  return { m: [a * e + c * f, b * e + d * f, a * g + c * h, b * g + d * h], t: apply(outer, inner.t) };
};

/** Whether the transform keeps circles round (uniform scale, possibly mirrored), and that scale. */
function uniformScale(tr: Transform): number | null {
  const sx = Math.hypot(tr.m[0], tr.m[1]);
  const sy = Math.hypot(tr.m[2], tr.m[3]);
  const dotp = tr.m[0] * tr.m[2] + tr.m[1] * tr.m[3];
  return Math.abs(sx - sy) < 1e-9 * Math.max(sx, 1) && Math.abs(dotp) < 1e-9 * Math.max(sx * sy, 1) ? sx : null;
}

/** Entity coordinates are in the object coordinate system; an extrusion of (0,0,-1) mirrors X. */
const ocs = (e: Entity): Transform => ({ m: [num(e, 230, 1) < 0 ? -1 : 1, 0, 0, 1], t: { x: 0, y: 0 } });

function emit(entities: Entity[], tr: Transform, blocks: Map<string, Block>, out: DxfDrawing, depth: number, parentLayer: string): void {
  if (depth > 16) return; // guards against self-referencing blocks
  const skip = (type: string) => out.skipped.set(type, (out.skipped.get(type) ?? 0) + 1);
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i];
    // Layer "0" inside a block takes the layer of the INSERT, as in AutoCAD.
    const raw = str(e, 8, '0');
    const layer = raw === '0' && depth > 0 ? parentLayer : raw;
    const seg = (a: Vec2, b: Vec2, t: Transform) => {
      const pa = apply(t, a);
      const pb = apply(t, b);
      if (Math.hypot(pb.x - pa.x, pb.y - pa.y) > 1e-9) out.segments.push({ a: pa, b: pb, layer });
    };
    switch (e.type) {
      case 'LINE':
        seg({ x: num(e, 10), y: num(e, 20) }, { x: num(e, 11), y: num(e, 21) }, tr);
        break;
      case 'CIRCLE':
      case 'ARC': {
        const t = compose(tr, ocs(e));
        const c = { x: num(e, 10), y: num(e, 20) };
        const r = num(e, 40);
        if (!(r > 0)) break;
        const s = uniformScale(t);
        if (e.type === 'CIRCLE' && s !== null) {
          out.circles.push({ c: apply(t, c), r: r * s, layer });
          break;
        }
        const start = e.type === 'ARC' ? (num(e, 50) * Math.PI) / 180 : 0;
        let end = e.type === 'ARC' ? (num(e, 51) * Math.PI) / 180 : Math.PI * 2;
        if (end <= start) end += Math.PI * 2;
        arcPoints(c, r, start, end).reduce((a, b) => (seg(a, b, t), b));
        break;
      }
      case 'LWPOLYLINE': {
        const vertices: { p: Vec2; bulge: number }[] = [];
        for (const [code, v] of e.pairs) {
          if (code === 10) vertices.push({ p: { x: Number(v), y: 0 }, bulge: 0 });
          else if (code === 20 && vertices.length) vertices[vertices.length - 1].p.y = Number(v);
          else if (code === 42 && vertices.length) vertices[vertices.length - 1].bulge = Number(v);
        }
        polyline(vertices, (num(e, 70) & 1) !== 0, compose(tr, ocs(e)), seg);
        break;
      }
      case 'POLYLINE': {
        const vertices: { p: Vec2; bulge: number }[] = [];
        while (entities[i + 1]?.type === 'VERTEX') {
          const v = entities[++i];
          vertices.push({ p: { x: num(v, 10), y: num(v, 20) }, bulge: num(v, 42) });
        }
        if (entities[i + 1]?.type === 'SEQEND') i++;
        polyline(vertices, (num(e, 70) & 1) !== 0, compose(tr, ocs(e)), seg);
        break;
      }
      case 'INSERT': {
        const block = blocks.get(str(e, 2));
        if (!block) break;
        const sx = num(e, 41, 1);
        const sy = num(e, 42, 1);
        const rot = (num(e, 50) * Math.PI) / 180;
        const cos = Math.cos(rot);
        const sin = Math.sin(rot);
        // insert point + R·S·(p − base)
        const local: Transform = {
          m: [cos * sx, sin * sx, -sin * sy, cos * sy],
          t: { x: num(e, 10), y: num(e, 20) },
        };
        const toBase: Transform = { m: [1, 0, 0, 1], t: { x: -block.base.x, y: -block.base.y } };
        const placed = compose(local, toBase);
        // Rectangular arrays of the block (column/row counts and spacing, along the rotated axes).
        const cols = Math.max(1, num(e, 70, 1));
        const rows = Math.max(1, num(e, 71, 1));
        const dc = num(e, 44);
        const dr = num(e, 45);
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const offset: Transform = { m: [1, 0, 0, 1], t: { x: c * dc * cos - r * dr * sin, y: c * dc * sin + r * dr * cos } };
            emit(block.entities, compose(compose(tr, ocs(e)), compose(offset, placed)), blocks, out, depth + 1, layer);
          }
        }
        break;
      }
      case 'VERTEX':
      case 'SEQEND':
      case 'ATTRIB':
      case 'ATTDEF':
        break;
      default:
        skip(e.type);
    }
  }
}

function polyline(
  vertices: { p: Vec2; bulge: number }[],
  closed: boolean,
  t: Transform,
  seg: (a: Vec2, b: Vec2, t: Transform) => void,
): void {
  const n = vertices.length;
  for (let k = 0; k < (closed ? n : n - 1); k++) {
    const { p: a, bulge } = vertices[k];
    const b = vertices[(k + 1) % n].p;
    if (Math.abs(bulge) < 1e-9) {
      seg(a, b, t);
      continue;
    }
    // Bulge = tan(θ/4) of the included angle θ; positive is counter-clockwise.
    const theta = 4 * Math.atan(bulge);
    const chord = Math.hypot(b.x - a.x, b.y - a.y);
    if (chord < 1e-12) continue;
    const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    // Centre's signed distance from the chord: negative for arcs over 180°, which puts it on the other side.
    const h = r * Math.cos(Math.abs(theta) / 2);
    const dir = { x: (b.x - a.x) / chord, y: (b.y - a.y) / chord };
    const side = Math.sign(theta); // counter-clockwise arcs bend around a centre left of the chord
    const c = { x: mid.x - dir.y * h * side, y: mid.y + dir.x * h * side };
    const start = Math.atan2(a.y - c.y, a.x - c.x);
    const pts = arcPoints(c, r, start, start + theta);
    pts[0] = a;
    pts[pts.length - 1] = b;
    pts.reduce((p, q) => (seg(p, q, t), q));
  }
}

/** Points along an arc from `start` to `end` (radians; end < start runs clockwise). */
function arcPoints(c: Vec2, r: number, start: number, end: number): Vec2[] {
  const n = Math.max(1, Math.ceil(Math.abs(end - start) / ARC_STEP));
  const out: Vec2[] = [];
  for (let k = 0; k <= n; k++) {
    const a = start + ((end - start) * k) / n;
    out.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
  }
  return out;
}
