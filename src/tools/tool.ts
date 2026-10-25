/**
 * @file tool.ts
 *
 * Tool interface and the ToolContext services every tool receives. A tool turns pointer/keyboard input into
 * commands and draws its own preview overlay.
 */
import type { Vec2 } from '../geom/vec';
import type { ConstraintService } from '../constraints/service';
import type { History } from '../model/commands';
import type { DocumentModel } from '../model/document';
import type { Selection } from '../model/selection';
import type { SnapQuery, SnapResult } from '../snap/snap';
import type { SpatialIndex } from '../model/spatial';
import type { Id, StrokeStyle } from '../model/types';
import type { DisplayUnit } from '../view/format';
import type { Painter } from '../view/renderer';
import type { Viewport } from '../view/viewport';

export interface ToolContext {
  doc: DocumentModel;
  history: History;
  index: SpatialIndex;
  selection: Selection;
  view: Viewport;
  constraints: ConstraintService;
  unit: () => DisplayUnit;
  /** Layer new geometry goes on. */
  layer: () => Id;
  /** Line style given to newly drawn lines, if the user chose one (ribbon "새 선에 적용"). */
  lineStyle?: () => StrokeStyle | undefined;
  /** Pick tolerance in mm for the current zoom. */
  pickTolerance: () => number;
  setHover: (id: Id | null) => void;
  setHint: (text: string) => void;
  /** Shows a short message to the user (e.g. why a constraint was rejected). */
  notify: (text: string) => void;
  /** Asks for a value; null when cancelled. */
  ask: (question: string, initial: string) => string | null;
  requestRender: () => void;
}

export interface ToolPointer {
  /** Cursor position in mm after snapping. */
  world: Vec2;
  /** The snap that produced `world`, if any. */
  snap: SnapResult | null;
  /** Cursor position in mm without snapping. */
  raw: Vec2;
  screen: Vec2;
  button: number;
  shift: boolean;
}

export interface Tool {
  readonly id: string;
  readonly hint: string;
  readonly cursor: string;
  activate?(): void;
  deactivate?(): void;
  down(p: ToolPointer): void;
  move(p: ToolPointer): void;
  up(p: ToolPointer): void;
  doubleClick?(p: ToolPointer): void;
  /** What the snap engine needs to know about the operation in progress. */
  snapQuery?(): SnapQuery;
  /** Returns true when the key was handled. */
  key?(e: KeyboardEvent): boolean;
  /** Cancels the current operation; returns true if there was one. */
  cancel(): boolean;
  /** Abandons a pointer gesture in progress (e.g. before undo), leaving the document as it was before it. */
  interrupt?(): void;
  overlay?(p: Painter): void;
}
