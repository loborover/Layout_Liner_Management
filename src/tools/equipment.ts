/**
 * @file equipment.ts
 *
 * Equipment/structure placement tool: previews the footprint at the cursor, R rotates, click places with an
 * auto-numbered tag.
 */
import { equipmentCorners } from '../geom/equipment';
import type { Vec2 } from '../geom/vec';
import { AddItems } from '../model/commands';
import { nextTag } from '../model/edit';
import { newId } from '../model/ids';
import type { Id } from '../model/types';
import { formatLength } from '../view/format';
import { COLORS, type Painter } from '../view/renderer';
import type { Tool, ToolContext, ToolPointer } from './tool';

/** Places equipment of the chosen type, centred on the cursor. */
export class EquipmentTool implements Tool {
  readonly id = 'equipment';
  readonly hint = '클릭: 설비 배치(중심) · R: 90° 회전 · Shift+R: 반대로 회전 · Esc: 종료';
  readonly cursor = 'crosshair';
  private type: Id | null = null;
  private rotation = 0;
  private cursorPos: Vec2 | null = null;

  constructor(private readonly ctx: ToolContext) {}

  setType(id: Id): void {
    this.type = id;
    this.ctx.requestRender();
  }

  activate(): void {
    // Chosen with the E key rather than from the library: start with the first type.
    if (!this.type || !this.ctx.doc.equipmentTypes.has(this.type)) this.type = this.ctx.doc.equipmentTypes.keys().next().value ?? null;
  }

  get typeId(): Id | null {
    return this.type;
  }

  down(p: ToolPointer): void {
    if (p.button === 2) {
      this.cancel();
      return;
    }
    if (p.button !== 0) return;
    const type = this.type ? this.ctx.doc.equipmentTypes.get(this.type) : undefined;
    if (!type) {
      this.ctx.notify('설비 목록에서 배치할 설비를 고르십시오.');
      return;
    }
    const at = { id: newId('p'), x: p.world.x, y: p.world.y };
    this.ctx.history.execute(
      new AddItems(
        [at],
        [
          {
            id: newId('e'),
            kind: 'equipment',
            type: type.id,
            at: at.id,
            rotation: this.rotation,
            tag: nextTag(this.ctx.doc, type),
            layer: this.ctx.layer(),
          },
        ],
      ),
    );
  }

  move(p: ToolPointer): void {
    this.cursorPos = p.world;
    this.ctx.requestRender();
  }

  up(): void {}

  key(e: KeyboardEvent): boolean {
    if (e.key.toLowerCase() !== 'r') return false;
    this.rotation = (this.rotation + (e.shiftKey ? 270 : 90)) % 360;
    this.ctx.requestRender();
    return true;
  }

  cancel(): boolean {
    return false; // nothing in progress between clicks; Esc leaves the tool
  }

  deactivate(): void {
    this.cursorPos = null;
  }

  overlay(p: Painter): void {
    const type = this.type ? this.ctx.doc.equipmentTypes.get(this.type) : undefined;
    if (!this.cursorPos || !type) return;
    const corners = equipmentCorners(this.cursorPos, type.width, type.depth, this.rotation);
    p.polygon(corners, COLORS.preview, COLORS.placeFill, true, [6, 4]);
    const unit = this.ctx.unit();
    p.label(this.cursorPos, `${type.name} ${formatLength(type.width, unit)} × ${formatLength(type.depth, unit)} · ${this.rotation}°`);
  }
}
