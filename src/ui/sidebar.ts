/**
 * @file sidebar.ts
 *
 * Side bar with an always-visible icon rail (request: a minimised side bar must stay reachable).
 * States: 'collapsed' (rail only), 'normal' and 'wide' (maximised). A rail icon opens its section; clicking the
 * icon of the open section collapses the panel. State is remembered in localStorage.
 */

export type SidebarState = 'collapsed' | 'normal' | 'wide';

export interface SidebarOptions {
  /** Section shown first. Default 'tree'. */
  section?: string;
  /** localStorage key; pages with different sections use different keys. */
  store?: string;
}

export class Sidebar {
  private section: string;
  private readonly store: string;
  /** Width to return to when a collapsed bar is reopened from the rail. */
  private lastOpen: SidebarState = 'normal';

  constructor(
    private readonly root: HTMLElement,
    private readonly onResize: () => void,
    opts: SidebarOptions = {},
  ) {
    this.section = opts.section ?? 'tree';
    this.store = opts.store ?? 'layout-liner:sidebar';
    try {
      const saved = JSON.parse(localStorage.getItem(this.store) ?? '{}') as { state?: SidebarState; section?: string };
      if (saved.section && root.querySelector(`[data-section="${saved.section}"]`)) this.section = saved.section;
      if (saved.state) this.root.dataset.state = saved.state;
    } catch {
      // ignore
    }
    root.querySelectorAll<HTMLButtonElement>('[data-rail]').forEach((b) => {
      b.addEventListener('click', () => {
        const target = b.dataset.rail!;
        if (this.state !== 'collapsed' && target === this.section) this.setState('collapsed');
        else this.open(target);
      });
    });
    this.show(this.section);
  }

  get state(): SidebarState {
    return (this.root.dataset.state as SidebarState) ?? 'normal';
  }

  setState(state: SidebarState): void {
    if (state !== 'collapsed') this.lastOpen = state;
    this.root.dataset.state = state;
    this.show(this.section);
    this.onResize();
  }

  /** Opens a section, expanding the bar if needed. */
  open(section: string): void {
    this.section = section;
    if (this.state === 'collapsed') this.setState(this.lastOpen);
    else this.show(section);
  }

  private show(section: string): void {
    this.root.querySelectorAll<HTMLElement>('[data-section]').forEach((s) => s.classList.toggle('active', s.dataset.section === section));
    this.root.querySelectorAll<HTMLButtonElement>('[data-rail]').forEach((b) => {
      const on = b.dataset.rail === section && this.state !== 'collapsed';
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
    try {
      localStorage.setItem(this.store, JSON.stringify({ state: this.state, section }));
    } catch {
      // ignore
    }
  }
}
