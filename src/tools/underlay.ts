import { type Vec2, dist } from '../geom/vec';
import { SetUnderlay } from '../model/commands';
import { formatLength } from '../view/format';
import { COLORS, type Painter } from '../view/renderer';
import type { SnapQuery } from '../snap/snap';
import type { Tool, ToolContext, ToolPointer } from './tool';

/**
 * Scales the underlay to real size and, optionally, moves it into place:
 * click two points on the image a known distance apart, enter that distance, then click where the
 * first point belongs in the drawing (Esc keeps it where it is).
 */
export class UnderlayTool implements Tool {
  readonly id = 'underlay';
  readonly cursor = 'crosshair';
  private a: Vec2 | null = null;
  /** First point after scaling, waiting for its place in the drawing. */
  private anchor: Vec2 | null = null;
  private cursorPos: Vec2 | null = null;

  constructor(private readonly ctx: ToolContext) {}

  get hint(): string {
    if (this.anchor) return '기준점을 놓을 위치 클릭 · Esc: 현재 위치 유지';
    if (this.a) return '밑그림에서 두 번째 점 클릭 (실제 거리를 아는 두 점)';
    return '밑그림에서 실제 거리를 아는 두 점 중 첫 번째 점 클릭';
  }

  snapQuery(): SnapQuery {
    return { from: this.anchor ?? this.a };
  }

  down(p: ToolPointer): void {
    if (p.button === 2) {
      this.cancel();
      return;
    }
    if (p.button !== 0) return;
    const { doc } = this.ctx;
    const u = doc.underlay;
    if (!u) {
      this.ctx.notify('먼저 밑그림 이미지를 불러오십시오.');
      return;
    }
    if (this.anchor) {
      const d = { x: p.world.x - this.anchor.x, y: p.world.y - this.anchor.y };
      this.ctx.history.execute(new SetUnderlay('밑그림 이동', u, { ...u, x: u.x + d.x, y: u.y + d.y }));
      this.reset();
      return;
    }
    if (!this.a) {
      this.a = p.raw;
      this.update();
      return;
    }
    const measured = dist(this.a, p.raw);
    if (measured < 1e-9) return;
    const answer = this.ctx.ask(
      `두 점 사이의 실제 거리(mm)를 입력하십시오. 지금은 ${formatLength(measured, 'mm')}입니다.`,
      String(Math.round(measured)),
    );
    if (answer === null) return this.reset();
    const real = Number(answer);
    if (!(real > 0)) {
      this.ctx.notify('0보다 큰 숫자를 입력하십시오.');
      return this.reset();
    }
    // Scale about the first point, so it stays put on the image.
    const k = real / measured;
    const a = this.a;
    this.ctx.history.execute(
      new SetUnderlay('밑그림 축척', u, {
        ...u,
        x: a.x + (u.x - a.x) * k,
        y: a.y + (u.y - a.y) * k,
        width: u.width * k,
        height: u.height * k,
      }),
    );
    this.a = null;
    this.anchor = a;
    this.update();
  }

  move(p: ToolPointer): void {
    this.cursorPos = this.anchor ? p.world : p.raw;
    this.ctx.requestRender();
  }

  up(): void {}

  cancel(): boolean {
    const busy = !!(this.a || this.anchor);
    this.reset();
    return busy;
  }

  deactivate(): void {
    this.reset();
  }

  private reset(): void {
    this.a = null;
    this.anchor = null;
    this.update();
  }

  private update(): void {
    this.ctx.setHint(this.hint);
    this.ctx.requestRender();
  }

  overlay(p: Painter): void {
    const from = this.anchor ?? this.a;
    if (from) p.marker(from, COLORS.selected);
    if (from && this.cursorPos) {
      p.line(from, this.cursorPos, COLORS.preview, 1, [6, 4]);
      if (this.a) p.label(this.cursorPos, formatLength(dist(from, this.cursorPos), this.ctx.unit()));
    }
  }
}
