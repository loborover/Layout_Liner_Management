/**
 * @file ribbon.ts
 *
 * Excel-style ribbon: a tab strip over panels of labelled command groups (static markup in index.html).
 * Handles tab switching, collapsing (toggle button or double-click on a tab) and remembers both in
 * localStorage. Commands themselves are wired by src/app.ts through data attributes.
 */

const STORE = 'layout-liner:ribbon';

export class Ribbon {
  private tab = 'home';

  constructor(private readonly root: HTMLElement) {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE) ?? '{}') as { tab?: string; collapsed?: boolean };
      if (saved.tab) this.tab = saved.tab;
      root.classList.toggle('collapsed', saved.collapsed === true);
    } catch {
      // Preferences are a convenience only.
    }
    root.querySelectorAll<HTMLButtonElement>('[role="tab"]').forEach((b) => {
      b.addEventListener('click', () => {
        // Clicking a tab of a collapsed ribbon opens it, like Office.
        root.classList.remove('collapsed');
        this.show(b.dataset.tab!);
      });
      b.addEventListener('dblclick', () => this.toggle());
    });
    this.show(this.tab);
  }

  /** Shows a tab; falls back to the first visible tab when it is hidden (e.g. edit tabs in viewer mode). */
  show(tab: string): void {
    const tabs = [...this.root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const visible = tabs.filter((b) => b.offsetParent !== null || getComputedStyle(b).display !== 'none');
    const target = visible.find((b) => b.dataset.tab === tab) ?? visible[0];
    if (!target) return;
    this.tab = target.dataset.tab!;
    for (const b of tabs) b.setAttribute('aria-selected', String(b === target));
    this.root.querySelectorAll<HTMLElement>('[data-panel]').forEach((p) => p.classList.toggle('active', p.dataset.panel === this.tab));
    this.save();
  }

  /** Re-checks the open tab after tabs were hidden or shown. */
  refresh(): void {
    this.show(this.tab);
  }

  toggle(): void {
    this.root.classList.toggle('collapsed');
    this.save();
  }

  private save(): void {
    try {
      localStorage.setItem(STORE, JSON.stringify({ tab: this.tab, collapsed: this.root.classList.contains('collapsed') }));
    } catch {
      // ignore
    }
  }
}
