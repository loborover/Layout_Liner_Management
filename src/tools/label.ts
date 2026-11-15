/**
 * @file label.ts
 *
 * Label tool ("라벨", the user's request 2026-11-15): click where the label goes and type its rows as
 * "제목: 내용 | 제목: 내용". The label is selected afterwards, so its rows, placement, text height, opacity and
 * visibility can be edited in the property panel. Related: src/model/labels.ts, src/model/types.ts (LabelEntity).
 */
import type { Vec2 } from '../geom/vec';
import { AddItems } from '../model/commands';
import { newId } from '../model/ids';
import { labelRows, parseLabelText } from '../model/labels';
import { type Entity, LABEL_TEXT_SIZE } from '../model/types';
import { COLORS, type Painter } from '../view/renderer';
import type { Tool, ToolContext, ToolPointer } from './tool';

export class LabelTool implements Tool {
  readonly id = 'label';
  readonly hint = '클릭: 라벨 놓기(내용 입력: "제목: 내용", 여러 줄은 | 로 구분) · 속성 패널에서 항목·배치·글자 높이·투명도 편집 · Esc: 끝내기';
  readonly cursor = 'text';
  private cursorPos: Vec2 | null = null;

  constructor(private readonly ctx: ToolContext) {}

  down(p: ToolPointer): void {
    if (p.button !== 0) return;
    const text = this.ctx.ask('라벨 내용: "제목: 내용" (여러 줄은 | 로 구분, 예: 구역: A동 | 담당: 생산1팀)', '');
    if (text === null) return;
    const items = parseLabelText(text);
    if (labelRows(items).length === 0) return this.ctx.notify('라벨 내용을 입력하십시오.');
    const at = { id: newId('p'), x: p.world.x, y: p.world.y };
    const e: Entity = { id: newId('e'), kind: 'label', at: at.id, items, layer: this.ctx.layer() };
    this.ctx.history.execute(new AddItems([at], [e]));
    this.ctx.selection.set([e.id]);
  }

  move(p: ToolPointer): void {
    this.cursorPos = p.world;
    this.ctx.requestRender();
  }

  up(): void {}

  cancel(): boolean {
    return false;
  }

  deactivate(): void {
    this.cursorPos = null;
  }

  overlay(p: Painter): void {
    if (!this.cursorPos) return;
    // The default text height, so the user sees how big the label will be.
    const h = LABEL_TEXT_SIZE * 1.25;
    p.rect({ x: this.cursorPos.x - h, y: this.cursorPos.y - h / 2 }, { x: this.cursorPos.x + h, y: this.cursorPos.y + h / 2 }, COLORS.preview, undefined, [4, 3]);
  }
}
