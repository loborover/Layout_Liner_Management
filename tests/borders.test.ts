import { GcsWrapper, init_planegcs_module } from '@salusoft89/planegcs';
import { beforeAll, describe, expect, it } from 'vitest';
import { constrainedClusters, mergeClusters } from '../src/constraints/components';
import { ConstraintSolver } from '../src/constraints/solver';
import { FormatError, deserialize, serialize } from '../src/io/serialize';
import { dataImageSize } from '../src/io/imageSize';
import { drawingSvg } from '../src/io/svg';
import { BORDER_TEMPLATES, applyTemplate, borderOpacity, circleBandRadii, matchTemplate, patternPeriod, stripePieces } from '../src/model/borders';
import { AddConstraints, AddItems, History } from '../src/model/commands';
import { DocumentModel } from '../src/model/document';
import { detachPoints } from '../src/model/edit';
import { formatScaleLength, scaleBarLength, screenScaleRatio } from '../src/view/viewport';

let solver: ConstraintSolver;
beforeAll(async () => {
  const mod = await init_planegcs_module();
  solver = new ConstraintSolver(new GcsWrapper(new mod.GcsSystem()));
});

/** A square shape (a, b, c, d) and a free line from its corner b, either sharing b or with its own point b2. */
function roomAndLine(shared: boolean) {
  const doc = new DocumentModel();
  const history = new History(doc);
  history.execute(
    new AddItems(
      [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 1000, y: 0 },
        { id: 'c', x: 1000, y: 1000 },
        { id: 'd', x: 0, y: 1000 },
        { id: 'b2', x: 1000, y: 0 },
        { id: 'e', x: 3000, y: 0 },
      ],
      [
        { id: 'ab', kind: 'line', p1: 'a', p2: 'b', layer: 'layer-0' },
        { id: 'bc', kind: 'line', p1: 'b', p2: 'c', layer: 'layer-0' },
        { id: 'cd', kind: 'line', p1: 'c', p2: 'd', layer: 'layer-0' },
        { id: 'da', kind: 'line', p1: 'd', p2: 'a', layer: 'layer-0' },
        { id: 's', kind: 'shape', points: ['a', 'b', 'c', 'd'], edges: ['ab', 'bc', 'cd', 'da'], layer: 'layer-0' },
        { id: 'free', kind: 'line', p1: shared ? 'b' : 'b2', p2: 'e', layer: 'layer-0' },
      ],
    ),
  );
  if (!shared) history.execute(new AddConstraints([{ id: 'k', kind: 'coincident', refs: ['b', 'b2'] }]));
  return { doc, history };
}

describe('border templates', () => {
  it('has the three floor-marking templates the user asked for', () => {
    expect(BORDER_TEMPLATES.map((t) => t.name)).toEqual(['구역색', '설비구역색', '안전구역색']);
    const [zone, equipment, safety] = BORDER_TEMPLATES;
    expect(zone.pattern).toBeUndefined();
    for (const t of [equipment, safety]) {
      expect(t.pattern?.angle).toBe(45);
      expect(t.pattern?.unit).toBe(50);
      expect(t.pattern?.stripes.map((s) => s.size)).toEqual([1, 1]);
    }
  });

  it('keeps the width and alignment, gives a hairline a visible width and is recognised again', () => {
    const t = BORDER_TEMPLATES[1];
    const wide = applyTemplate({ width: 300, align: 'inside' }, t);
    expect(wide).toMatchObject({ width: 300, align: 'inside', opacity: 1 });
    expect(applyTemplate(undefined, t).width).toBeGreaterThan(0);
    expect(matchTemplate(wide)?.id).toBe('equipment-zone');
    expect(matchTemplate({ ...wide, pattern: { ...wide.pattern!, unit: 60 } })).toBeNull();
    // The template's pattern is a copy: editing the border never changes the template.
    wide.pattern!.stripes[0].size = 3;
    expect(t.pattern!.stripes[0].size).toBe(1);
  });

  it('defaults the opacity of bands and hairlines', () => {
    expect(borderOpacity({ width: 200, align: 'center' })).toBeCloseTo(0.85);
    expect(borderOpacity({ width: 0, align: 'center' })).toBe(1);
    expect(borderOpacity({ width: 200, align: 'center', opacity: 0.3 })).toBe(0.3);
  });
});

describe('stripe geometry', () => {
  it('covers a band with stripes of size × unit mm in order', () => {
    const p = { stripes: [{ color: '#111111', size: 1 }, { color: '#222222', size: 3 }], unit: 50, angle: 90 };
    expect(patternPeriod(p)).toBe(200);
    // A 1000 × 100 band along X; stripes at 90° run across it, so they repeat along X.
    const band = [
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 1000, y: 100 },
      { x: 0, y: 100 },
    ];
    const pieces = stripePieces(band, { x: 0, y: 0 }, Math.PI / 2, p)!;
    const width = (q: { x: number }[]) => Math.max(...q.map((v) => v.x)) - Math.min(...q.map((v) => v.x));
    const first = pieces.filter((s) => s.color === '#111111');
    const second = pieces.filter((s) => s.color === '#222222');
    expect(first).toHaveLength(5);
    expect(width(first[0].quad)).toBeCloseTo(50);
    expect(width(second[0].quad)).toBeCloseTo(150);
    // Together the stripes cover the whole length once.
    expect(pieces.reduce((sum, s) => sum + width(s.quad), 0)).toBeCloseTo(1000);
  });

  it('gives up (plain fill) when far too many stripes would be needed', () => {
    const p = { stripes: [{ color: '#111111', size: 1 }], unit: 1, angle: 45 };
    expect(stripePieces([{ x: 0, y: 0 }, { x: 1e6, y: 1e6 }], { x: 0, y: 0 }, 0, p, 100)).toBeNull();
  });

  it('places a circle band inside, centred on or outside the circle', () => {
    expect(circleBandRadii(1000, { width: 100, align: 'inside' })).toEqual([900, 1000]);
    expect(circleBandRadii(1000, { width: 100, align: 'center' })).toEqual([950, 1050]);
    expect(circleBandRadii(1000, { width: 100, align: 'outside' })).toEqual([1000, 1100]);
  });
});

describe('file format 4', () => {
  it('round-trips borders, face fills, coincident constraints and the underlay lock', () => {
    const { doc } = roomAndLine(false);
    const free = doc.entities.get('free')!;
    if (free.kind === 'line') free.stroke = applyTemplate({ width: 200, align: 'center' }, BORDER_TEMPLATES[2]);
    const s = doc.entities.get('s')!;
    if (s.kind === 'shape') {
      s.fillOpacity = 0.6;
      s.fillImage = { src: 'data:image/png;base64,AAAA', fit: 'tile', size: 600 };
    }
    doc.underlay = { src: 'data:image/png;base64,AAAA', x: 0, y: 0, width: 10, height: 10, opacity: 0.5, visible: true, locked: true };
    const data = deserialize(serialize(doc.toData()));
    expect(data.version).toBe(5);
    const line = data.entities.find((e) => e.id === 'free');
    expect(line?.kind === 'line' && line.stroke?.pattern?.stripes).toHaveLength(2);
    const shape = data.entities.find((e) => e.id === 's');
    expect(shape?.kind === 'shape' && shape.fillOpacity).toBe(0.6);
    expect(shape?.kind === 'shape' && shape.fillImage?.fit).toBe('tile');
    expect(data.constraints[0]).toMatchObject({ kind: 'coincident', refs: ['b', 'b2'] });
    expect(data.underlay?.locked).toBe(true);
  });

  it('refuses face images that are not embedded and malformed patterns', () => {
    const { doc } = roomAndLine(true);
    const raw = doc.toData() as unknown as { entities: Record<string, unknown>[] };
    const shape = raw.entities.find((e) => e.id === 's')!;
    shape.fillImage = { src: 'https://example.com/a.png', fit: 'stretch' };
    expect(() => deserialize(JSON.stringify(raw))).toThrow(FormatError);
    delete shape.fillImage;
    const line = raw.entities.find((e) => e.id === 'free')!;
    line.stroke = { width: 100, align: 'center', pattern: { stripes: [], unit: 50, angle: 45 } };
    expect(() => deserialize(JSON.stringify(raw))).toThrow(FormatError);
  });

  it('still opens version 3 files', () => {
    const { doc } = roomAndLine(true);
    const v3 = { ...doc.toData(), version: 3 };
    expect(deserialize(JSON.stringify(v3)).entities).toHaveLength(6);
  });
});

describe('coincident points: separate objects that stay together until released', () => {
  it('pulls the other object along while the constraint holds', () => {
    const { doc } = roomAndLine(false);
    const cluster = mergeClusters(constrainedClusters(doc, ['b']));
    doc.point('b').x = 1200;
    expect(solver.solve(doc, cluster, new Set(['b'])).ok).toBe(true);
    expect(doc.point('b2').x).toBeCloseTo(1200);
  });

  it('detaching a selected line removes its coincident constraint', () => {
    const { doc, history } = roomAndLine(false);
    const cmd = detachPoints(doc, ['free'])!;
    history.execute(cmd);
    expect(doc.constraints.size).toBe(0);
    history.undo();
    expect(doc.constraints.size).toBe(1);
  });

  it('splits a shared point so the line gets its own, and the shape keeps its loop', () => {
    const { doc, history } = roomAndLine(true);
    history.execute(detachPoints(doc, ['free'])!);
    const free = doc.entities.get('free')!;
    expect(free.kind === 'line' && free.p1).not.toBe('b');
    expect(free.kind === 'line' && doc.point(free.p1)).toMatchObject({ x: 1000, y: 0 });
    // The shape and its edges still share b.
    const s = doc.entities.get('s')!;
    expect(s.kind === 'shape' && s.points[1]).toBe('b');
    expect(doc.pointUsers('b').map((e) => e.id).sort()).toEqual(['ab', 'bc', 's']);
    history.undo();
    expect(doc.pointUsers('b').map((e) => e.id)).toContain('free');
  });

  it('selecting the point separates every object there', () => {
    const { doc, history } = roomAndLine(true);
    history.execute(detachPoints(doc, ['b'])!);
    expect(doc.pointUsers('b').some((e) => e.id === 'free')).toBe(false);
    expect(detachPoints(doc, ['b'])).toBeNull();
  });
});

describe('scale display', () => {
  it('picks a round scale bar length and the screen ratio', () => {
    expect(scaleBarLength(0.1)).toBe(1000); // 60 px at 0.1 px/mm → 600 mm → 1 m
    expect(scaleBarLength(1)).toBe(100);
    expect(formatScaleLength(1000)).toBe('1 m');
    expect(formatScaleLength(500)).toBe('500 mm');
    // 0.1 px per mm at 96 px/inch: 1 mm of screen is 26.5 mm → about 1:38 (two significant figures).
    expect(screenScaleRatio(0.1)).toBe(38);
    expect(screenScaleRatio(0.01)).toBe(380);
  });

  it('puts a scale bar and the print scale into the SVG, sized for that scale', () => {
    const { doc } = roomAndLine(true);
    const free = doc.entities.get('free')!;
    if (free.kind === 'line') free.stroke = applyTemplate({ width: 200, align: 'center' }, BORDER_TEMPLATES[1]);
    doc.changed();
    const fit = drawingSvg(doc)!;
    expect(fit).toContain('data-role="scale-bar"');
    expect(fit).toContain('<pattern');
    const at100 = drawingSvg(doc, { scale: 100 })!;
    expect(at100).toContain('축척 1:100');
    const width = (svg: string) => Number(/width="([\d.]+)mm"/.exec(svg)![1]);
    expect(width(at100)).toBeCloseTo(width(fit) / 100);
  });
});

describe('embedded image size', () => {
  const b64 = (bytes: number[]) => 'data:image/x;base64,' + btoa(String.fromCharCode(...bytes));
  it('reads PNG, GIF and JPEG headers', () => {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0x2c, 0, 0, 0, 0x64];
    expect(dataImageSize(b64(png))).toEqual({ width: 300, height: 100 });
    expect(dataImageSize(b64([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 40, 0, 20, 0]))).toEqual({ width: 40, height: 20 });
    const jpeg = [0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 50, 0, 200, 3, 0, 0];
    expect(dataImageSize(b64(jpeg))).toEqual({ width: 200, height: 50 });
    expect(dataImageSize('data:image/png;base64,AAAA')).toBeNull();
  });

  it('keeps the aspect ratio of a tiled face picture in SVG', () => {
    const { doc } = roomAndLine(true);
    const s = doc.entities.get('s')!;
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 200, 0, 0, 0, 100];
    if (s.kind === 'shape') s.fillImage = { src: b64(png), fit: 'tile', size: 400 };
    doc.changed();
    expect(drawingSvg(doc)).toMatch(/<pattern [^>]*width="400" height="200"/);
  });
});
