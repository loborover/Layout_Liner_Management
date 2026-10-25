/**
 * @file inspect.ts
 *
 * Viewer-mode tool: left drag pans, click selects an object and opens its information card, hover highlights.
 * It never changes the document, which is what makes viewer mode safe to hand to operators.
 */
import type { Vec2 } from '../geom/vec';
import type { Id } from '../model/types';
import type { Tool, ToolContext, ToolPointer } from './tool';

const CLICK_PX = 4;

export class InspectTool implements Tool {
  readonly id = 'inspect';
  readonly hint = '클릭: 객체 정보 · 드래그: 화면 이동 · 휠: 확대·축소 · F: 전체 보기';
  readonly cursor = 'default';
  private press: { screen: Vec2; last: Vec2; moved: boolean } | null = null;

  constructor(
    private readonly ctx: ToolContext,
    /** Opens (id) or closes (null) the information card at a screen position. */
    private readonly inspect: (id: Id | null, at: Vec2) => void,
  ) {}

  down(p: ToolPointer): void {
    if (p.button !== 0) return;
    this.press = { screen: p.screen, last: p.screen, moved: false };
  }

  move(p: ToolPointer): void {
    const { ctx } = this;
    if (this.press) {
      const d = { x: p.screen.x - this.press.last.x, y: p.screen.y - this.press.last.y };
      if (Math.hypot(p.screen.x - this.press.screen.x, p.screen.y - this.press.screen.y) > CLICK_PX) this.press.moved = true;
      if (this.press.moved) {
        ctx.view.panBy(d.x, d.y);
        ctx.requestRender();
      }
      this.press.last = p.screen;
      return;
    }
    ctx.setHover(this.pick(p)?.id ?? null);
  }

  up(p: ToolPointer): void {
    const press = this.press;
    this.press = null;
    if (!press || press.moved) return;
    const hit = this.pick(p);
    if (hit) this.ctx.selection.set([hit.id]);
    else this.ctx.selection.clear();
    this.inspect(hit?.id ?? null, p.screen);
  }

  /** Like editing picks, but locked layers are inspectable too: only visibility matters to a viewer. */
  private pick(p: ToolPointer) {
    const { ctx } = this;
    const tol = ctx.pickTolerance();
    return ctx.index.pickVisible(p.raw, tol);
  }

  cancel(): boolean {
    this.press = null;
    this.inspect(null, { x: 0, y: 0 });
    return false;
  }
}
