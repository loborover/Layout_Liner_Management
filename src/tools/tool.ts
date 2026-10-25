import type { Vec2 } from '../geom/vec';
import type { History } from '../model/commands';
import type { DocumentModel } from '../model/document';
import type { Selection } from '../model/selection';
import type { SpatialIndex } from '../model/spatial';
import type { Id } from '../model/types';
import type { DisplayUnit } from '../view/format';
import type { Painter } from '../view/renderer';
import type { Viewport } from '../view/viewport';

export interface ToolContext {
  doc: DocumentModel;
  history: History;
  index: SpatialIndex;
  selection: Selection;
  view: Viewport;
  unit: () => DisplayUnit;
  /** Pick tolerance in mm for the current zoom. */
  pickTolerance: () => number;
  setHover: (id: Id | null) => void;
  setHint: (text: string) => void;
  requestRender: () => void;
}

export interface ToolPointer {
  /** Cursor position in mm, after grid snapping when enabled. */
  world: Vec2;
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
  /** Returns true when the key was handled. */
  key?(e: KeyboardEvent): boolean;
  /** Cancels the current operation; returns true if there was one. */
  cancel(): boolean;
  /** Abandons a pointer gesture in progress (e.g. before undo), leaving the document as it was before it. */
  interrupt?(): void;
  overlay?(p: Painter): void;
}
