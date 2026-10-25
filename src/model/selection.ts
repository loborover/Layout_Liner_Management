/**
 * @file selection.ts
 *
 * Set of selected entity ids with change notification. View state, not part of the document or undo.
 */
import type { Id } from './types';

export class Selection {
  private ids = new Set<Id>();
  private listeners = new Set<() => void>();

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  has(id: Id): boolean {
    return this.ids.has(id);
  }

  get size(): number {
    return this.ids.size;
  }

  values(): Id[] {
    return [...this.ids];
  }

  set(ids: Iterable<Id>): void {
    this.ids = new Set(ids);
    this.emit();
  }

  add(ids: Iterable<Id>): void {
    for (const id of ids) this.ids.add(id);
    this.emit();
  }

  toggle(id: Id): void {
    if (this.ids.has(id)) this.ids.delete(id);
    else this.ids.add(id);
    this.emit();
  }

  clear(): void {
    if (this.ids.size === 0) return;
    this.ids.clear();
    this.emit();
  }

  /** Drops ids that no longer exist in the document. */
  prune(exists: (id: Id) => boolean): void {
    const before = this.ids.size;
    for (const id of this.ids) if (!exists(id)) this.ids.delete(id);
    if (this.ids.size !== before) this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
