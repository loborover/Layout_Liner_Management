/**
 * @file host.ts
 *
 * What the side panel widgets (object tree, property panel, library) need from the application. The App
 * implements it; tests or the viewer app can provide a smaller one. Keeping the widgets behind this interface
 * means they never reach into App internals.
 */
import type { History } from '../model/commands';
import type { DocumentModel } from '../model/document';
import type { Selection } from '../model/selection';
import type { Id } from '../model/types';
import type { DisplayUnit } from '../view/format';

export type Mode = 'edit' | 'view';

/** A live monitoring value bound to an entity (see src/viewer/). */
export interface LiveValue {
  value: unknown;
  status?: string;
  unit?: string;
  /** When the value was received, ms since epoch. */
  at: number;
}

export interface UiHost {
  doc: DocumentModel;
  history: History;
  selection: Selection;
  mode: () => Mode;
  unit: () => DisplayUnit;
  /** Layer new geometry goes on. */
  currentLayer: () => Id;
  setCurrentLayer: (id: Id) => void;
  /** Shows a floor (view state, not undoable). */
  setFloor: (id: Id) => void;
  /** Type being placed, if the equipment tool is active. */
  activeType: () => Id | null;
  placeEquipment: (type: Id) => void;
  /** Centres the view on entities. */
  zoomTo: (ids: Id[]) => void;
  /** Live value of a binding key, if a data source provides one. */
  live: (binding: string) => LiveValue | undefined;
  notify: (text: string) => void;
  ask: (question: string, initial: string) => string | null;
  confirm: (question: string) => boolean;
}
