/**
 * @file view3d.ts
 *
 * 3D views of the drawing with three.js (WebGL), loaded only when the user opens a 3D view so the 2D editor stays
 * light (the user's choice on 2026-10-25: three.js loaded on demand; heavy work may move to a host server, which
 * can build the same Scene3D, see docs/VIEW3D.md). Views are orthographic, as in CAD:
 *   top (plan from above), front (from -Y), side (from +X), iso (isometric, can be orbited), and a 4-up layout
 *   showing all four at once.
 * Controls: wheel zooms at the cursor, drag pans, in the iso view left-drag orbits and Shift/middle-drag pans,
 * double-click fits. A click picks the object under the cursor (onPick).
 */
import {
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshLambertMaterial,
  OrthographicCamera,
  Raycaster,
  Scene,
  Spherical,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { Scene3D } from '../model/scene3d';
import type { Id } from '../model/types';
import { CANVAS, LIGHT, PALETTE } from '../theme';
import { sceneBuffers } from './mesh';

export type ViewName = 'top' | 'front' | 'side' | 'iso';
export type Layout = ViewName | 'quad';

export const VIEW_LABELS: Record<ViewName, string> = { top: '위', front: '정면', side: '측면', iso: '등각' };

interface Pane {
  view: ViewName;
  camera: OrthographicCamera;
  /** Point the camera looks at. */
  target: Vector3;
  /** Orbit of the iso view around its target. */
  orbit: Spherical;
  /** Pixel rectangle in the canvas (CSS px, origin top-left). */
  rect: { x: number; y: number; w: number; h: number };
}

const FAR = 1e7;
/** How close a click must be to a 3D line to pick it, px. */
const PICK_PX = 6;

export class View3D {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private content = new Group();
  private meshes: { mesh: Mesh; ids: Id[] }[] = [];
  /** Pickable 3D lines (unextruded lines, circles, point crosses), with the entity id of each segment. */
  private lines: { lines: LineSegments; ids: (Id | null)[] }[] = [];
  private panes: Pane[] = [];
  private layout: Layout = 'iso';
  private width = 1;
  private height = 1;
  private bounds = { min: new Vector3(), max: new Vector3(1, 1, 1) };
  private frame = false;
  private drag: { pane: Pane; x: number; y: number; orbit: boolean; moved: boolean } | null = null;
  private readonly labels: HTMLElement;

  constructor(
    host: HTMLElement,
    private readonly onPick: (id: Id | null) => void,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'view3d';
    this.labels = document.createElement('div');
    this.labels.className = 'view3d-labels';
    host.append(this.canvas, this.labels);
    this.renderer = new WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setScissorTest(true);
    this.scene.background = new Color(CANVAS.background);
    this.scene.add(new AmbientLight(LIGHT.ambient, 1.6));
    const sun = new DirectionalLight(LIGHT.sun, 1.4);
    sun.position.set(-0.5, -0.8, 1);
    this.scene.add(sun);
    this.scene.add(this.content);
    this.setLayout('iso');
    this.bindInput();
  }

  /** Replaces the displayed geometry. `fit` re-frames every view on it. */
  setScene(s: Scene3D, fit = false): void {
    this.scene.remove(this.content);
    this.content.traverse((o) => {
      if (o instanceof Mesh || o instanceof LineSegments) {
        o.geometry.dispose();
        (o.material as { dispose(): void }).dispose();
      }
    });
    this.content = new Group();
    this.meshes = [];
    this.lines = [];
    const buffers = sceneBuffers(s, PALETTE.charcoal);
    for (const b of buffers.meshes) {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(new Float32Array(b.positions), 3));
      g.computeVertexNormals();
      // Faces are washed a quarter towards the paper colour, so solids read as ink wash and their ink outlines stay crisp.
      const mat = new MeshLambertMaterial({
        color: new Color(b.color).lerp(new Color(CANVAS.background), 0.25),
        transparent: b.opacity < 1,
        opacity: b.opacity,
        side: DoubleSide,
        // Keep outlines visible on top of coplanar faces.
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
        depthWrite: b.opacity >= 1,
      });
      const mesh = new Mesh(g, mat);
      this.content.add(mesh);
      this.meshes.push({ mesh, ids: b.ids });
    }
    for (const l of buffers.lines) {
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(new Float32Array(l.positions), 3));
      const lines = new LineSegments(g, new LineBasicMaterial({ color: l.color }));
      this.content.add(lines);
      this.lines.push({ lines, ids: l.ids });
    }
    this.scene.add(this.content);
    this.bounds.min.set(...s.min);
    this.bounds.max.set(...s.max);
    if (fit) this.fitAll();
    this.requestRender();
  }

  setLayout(layout: Layout): void {
    this.layout = layout;
    const views: ViewName[] = layout === 'quad' ? ['top', 'iso', 'front', 'side'] : [layout];
    const old = new Map(this.panes.map((p) => [p.view, p]));
    this.panes = views.map((view) => old.get(view) ?? this.makePane(view));
    this.arrange();
    this.fitAll();
  }

  get currentLayout(): Layout {
    return this.layout;
  }

  resize(width: number, height: number, dpr: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(this.width, this.height, false);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.arrange();
    this.panes.forEach((p) => this.frameCamera(p));
    this.requestRender();
  }

  fitAll(): void {
    for (const p of this.panes) this.fit(p);
    this.requestRender();
  }

  dispose(): void {
    this.renderer.dispose();
    this.canvas.remove();
    this.labels.remove();
  }

  requestRender(): void {
    if (this.frame) return;
    this.frame = true;
    requestAnimationFrame(() => {
      this.frame = false;
      this.draw();
    });
  }

  // ---------- cameras ----------

  private makePane(view: ViewName): Pane {
    const camera = new OrthographicCamera(-1, 1, 1, -1, -FAR, FAR);
    camera.up.set(0, 0, 1);
    // Iso: 45° around, 35.264° up (true isometric), looking at the building's front-right corner.
    const orbit = new Spherical(1, Math.PI / 2 - Math.atan(1 / Math.SQRT2), Math.PI / 4);
    return { view, camera, target: new Vector3(), orbit, rect: { x: 0, y: 0, w: 1, h: 1 } };
  }

  /** Unit vector from the target towards the camera. */
  private direction(p: Pane): Vector3 {
    switch (p.view) {
      case 'top':
        return new Vector3(0, 0, 1);
      case 'front':
        return new Vector3(0, -1, 0);
      case 'side':
        return new Vector3(1, 0, 0);
      case 'iso': {
        // Spherical with Z up: theta around Z measured from -Y towards +X.
        const s = p.orbit;
        return new Vector3(Math.sin(s.phi) * Math.sin(s.theta), -Math.sin(s.phi) * Math.cos(s.theta), Math.cos(s.phi));
      }
    }
  }

  private arrange(): void {
    const { width: w, height: h } = this;
    if (this.panes.length === 1) this.panes[0].rect = { x: 0, y: 0, w, h };
    else {
      const hw = Math.floor(w / 2);
      const hh = Math.floor(h / 2);
      const cells = [
        { x: 0, y: 0, w: hw, h: hh },
        { x: hw, y: 0, w: w - hw, h: hh },
        { x: 0, y: hh, w: hw, h: h - hh },
        { x: hw, y: hh, w: w - hw, h: h - hh },
      ];
      this.panes.forEach((p, i) => (p.rect = cells[i]));
    }
    this.labels.replaceChildren(
      ...this.panes.map((p) => {
        const el = document.createElement('span');
        el.textContent = VIEW_LABELS[p.view];
        el.style.left = `${p.rect.x + 8}px`;
        el.style.top = `${p.rect.y + 6}px`;
        return el;
      }),
    );
    this.labels.classList.toggle('quad', this.panes.length > 1);
  }

  /** Frames the whole scene in a pane. */
  private fit(p: Pane): void {
    const { min, max } = this.bounds;
    p.target.set((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2);
    p.camera.zoom = 1;
    p.camera.userData.size = 1;
    this.frameCamera(p);
    // Size the view from the bounds as the camera sees them (an iso box projects taller than any of its sides).
    const right = new Vector3().setFromMatrixColumn(p.camera.matrixWorld, 0);
    const up = new Vector3().setFromMatrixColumn(p.camera.matrixWorld, 1);
    let halfW = 0;
    let halfH = 0;
    for (const x of [min.x, max.x])
      for (const y of [min.y, max.y])
        for (const z of [min.z, max.z]) {
          const v = new Vector3(x, y, z).sub(p.target);
          halfW = Math.max(halfW, Math.abs(v.dot(right)));
          halfH = Math.max(halfH, Math.abs(v.dot(up)));
        }
    const aspect = p.rect.w / Math.max(1, p.rect.h);
    p.camera.userData.size = Math.max(halfH, halfW / aspect, 500) * 1.1;
    this.frameCamera(p);
  }

  private frameCamera(p: Pane): void {
    const half = (p.camera.userData.size as number | undefined) ?? 10000;
    const aspect = p.rect.w / Math.max(1, p.rect.h);
    p.camera.left = -half * aspect;
    p.camera.right = half * aspect;
    p.camera.top = half;
    p.camera.bottom = -half;
    const dir = this.direction(p);
    p.camera.up.set(0, 0, 1);
    if (p.view === 'top') p.camera.up.set(0, 1, 0);
    p.camera.position.copy(p.target).addScaledVector(dir, FAR / 4);
    p.camera.lookAt(p.target);
    p.camera.updateProjectionMatrix();
    p.camera.updateMatrixWorld();
  }

  private draw(): void {
    for (const p of this.panes) {
      // WebGL's viewport origin is bottom-left.
      const y = this.height - p.rect.y - p.rect.h;
      this.renderer.setViewport(p.rect.x, y, p.rect.w, p.rect.h);
      this.renderer.setScissor(p.rect.x, y, p.rect.w, p.rect.h);
      this.renderer.render(this.scene, p.camera);
    }
  }

  // ---------- input ----------

  private paneAt(x: number, y: number): Pane {
    return this.panes.find((p) => x >= p.rect.x && x < p.rect.x + p.rect.w && y >= p.rect.y && y < p.rect.y + p.rect.h) ?? this.panes[0];
  }

  private local(e: MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** World units per CSS pixel in a pane. */
  private unitsPerPx(p: Pane): number {
    return (p.camera.top - p.camera.bottom) / p.camera.zoom / p.rect.h;
  }

  private bindInput(): void {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const at = this.local(e);
      const p = this.paneAt(at.x, at.y);
      const before = this.worldAt(p, at);
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      p.camera.zoom = Math.min(500, Math.max(0.02, p.camera.zoom * 1.0015 ** -delta));
      p.camera.updateProjectionMatrix();
      // Keep the point under the cursor in place.
      const after = this.worldAt(p, at);
      p.target.add(before.sub(after));
      this.frameCamera(p);
      this.requestRender();
    }, { passive: false });
    c.addEventListener('pointerdown', (e) => {
      const at = this.local(e);
      c.setPointerCapture(e.pointerId);
      const p = this.paneAt(at.x, at.y);
      this.drag = { pane: p, x: at.x, y: at.y, orbit: p.view === 'iso' && e.button === 0 && !e.shiftKey, moved: false };
    });
    c.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d) return;
      const at = this.local(e);
      const dx = at.x - d.x;
      const dy = at.y - d.y;
      if (!d.moved && Math.hypot(dx, dy) < 3) return;
      d.moved = true;
      d.x = at.x;
      d.y = at.y;
      const p = d.pane;
      if (d.orbit) {
        p.orbit.theta -= dx * 0.008;
        p.orbit.phi = Math.min(Math.PI / 2 - 0.01, Math.max(0.01, p.orbit.phi - dy * 0.008));
      } else {
        // Pan in the camera plane.
        const k = this.unitsPerPx(p);
        const right = new Vector3().setFromMatrixColumn(p.camera.matrix, 0);
        const up = new Vector3().setFromMatrixColumn(p.camera.matrix, 1);
        p.target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
      }
      this.frameCamera(p);
      this.requestRender();
    });
    c.addEventListener('pointerup', (e) => {
      const d = this.drag;
      this.drag = null;
      if (d && !d.moved && e.button === 0) this.onPick(this.pick(this.local(e)));
    });
    c.addEventListener('dblclick', (e) => {
      const at = this.local(e);
      this.fit(this.paneAt(at.x, at.y));
      this.requestRender();
    });
  }

  /** World point on the plane through the target facing the camera, under a pane pixel. */
  private worldAt(p: Pane, at: { x: number; y: number }): Vector3 {
    const ndc = new Vector3(((at.x - p.rect.x) / p.rect.w) * 2 - 1, -((at.y - p.rect.y) / p.rect.h) * 2 + 1, 0);
    const v = ndc.unproject(p.camera);
    const dir = this.direction(p);
    // Project onto the plane through the target.
    return v.addScaledVector(dir, -v.clone().sub(p.target).dot(dir));
  }

  private pick(at: { x: number; y: number }): Id | null {
    const p = this.paneAt(at.x, at.y);
    const ray = new Raycaster();
    ray.setFromCamera(new Vector2(((at.x - p.rect.x) / p.rect.w) * 2 - 1, -((at.y - p.rect.y) / p.rect.h) * 2 + 1), p.camera);
    // Lines are hit within a few pixels, converted to world units at the pane's current zoom.
    const worldPerPx = (p.camera.top - p.camera.bottom) / p.camera.zoom / Math.max(1, p.rect.h);
    ray.params.Line = { threshold: PICK_PX * worldPerPx };
    const targets = [...this.meshes.map((m) => m.mesh), ...this.lines.map((l) => l.lines)];
    // Hits come nearest first; outline segments carry no id, so the face or line behind them answers.
    for (const h of ray.intersectObjects(targets, false)) {
      const m = this.meshes.find((x) => x.mesh === h.object);
      if (m && h.faceIndex !== undefined && h.faceIndex !== null) return m.ids[h.faceIndex] ?? null;
      const l = this.lines.find((x) => x.lines === h.object);
      const id = l && h.index !== undefined ? l.ids[Math.floor(h.index / 2)] : null;
      if (id) return id;
    }
    return null;
  }
}
