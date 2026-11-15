/**
 * @file recordPanel.ts
 *
 * Widgets of the source data link ("외부 데이터", docs/DATA_SOURCES.md):
 * - `DataBrowser`, the side bar section opened from the ribbon's "외부 연결" tab: pick a dataset of the data
 *   gateway, search its records and copy a field as a `DB("dataset", "key", "field")` reference to use in a
 *   parameter or formula (src/data/recordValues.ts). Read-only: nothing here changes the source.
 * - `appendRecordInfo`, the block the information card (viewer mode, monitoring viewer app) adds for an object
 *   that links to a record (`entity.record`, set through the API).
 * Lookups go through RecordStore (src/data/records.ts) and fill in asynchronously.
 */
import { type DatasetInfo, type RecordState, type RecordStore, formatField, recordKey } from '../data/records';
import { formatFieldRef } from '../data/recordValues';
import type { Entity } from '../model/types';

/** Fields shown before "더 보기"; a record can have dozens of columns. */
const MAX_SHOWN_FIELDS = 12;
/** Keys listed per search. */
const KEY_LIST_LIMIT = 100;

/** Text for a lookup that did not produce a record. */
function stateText(s: RecordState, key: string): string {
  if (s.status === 'loading') return '불러오는 중…';
  if (s.status === 'missing') return `원본에 '${key}' 레코드가 없습니다.`;
  if (s.status === 'error') return s.message;
  return '';
}

/** Adds up to MAX_SHOWN_FIELDS rows of a record, with a toggle for the rest. */
function fieldRows(parent: HTMLElement, fields: Record<string, unknown>, add: (name: string, value: string) => void): void {
  const entries = Object.entries(fields);
  for (const [name, v] of entries.slice(0, MAX_SHOWN_FIELDS)) add(name, formatField(v as never));
  if (entries.length > MAX_SHOWN_FIELDS) {
    const more = document.createElement('button');
    more.textContent = `필드 ${entries.length - MAX_SHOWN_FIELDS}개 더 보기`;
    more.style.gridColumn = '1 / -1';
    more.addEventListener('click', () => {
      more.remove();
      for (const [name, v] of entries.slice(MAX_SHOWN_FIELDS)) add(name, formatField(v as never));
    });
    parent.append(more);
  }
}

/**
 * Appends the linked record's fields to an information card (filled by fillInspector). The block fills in when the
 * lookup finishes, unless the card was refilled for something else meanwhile.
 */
export function appendRecordInfo(card: HTMLElement, store: RecordStore | undefined, e: Entity): void {
  const key = recordKey(e);
  if (!store || !e.record || !key) return;
  const dl = card.querySelector('dl');
  if (!dl) return;
  const add = (k: string, v: string, warn = false) => {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    if (warn) dd.className = 'warn';
    dl.append(dt, dd);
  };
  const marker = document.createElement('dt');
  marker.textContent = '원본';
  const where = document.createElement('dd');
  where.textContent = `${e.record.dataset} · ${key}`;
  dl.append(marker, where);
  const fill = (s: RecordState) => {
    if (!marker.isConnected) return;
    if (s.status === 'ok') fieldRows(dl, s.fields, (name, value) => add(name, value));
    else add('상태', stateText(s, key), true);
  };
  const cached = store.peek(e.record.dataset, key);
  if (cached && cached.status !== 'loading') return fill(cached);
  void store.get(e.record.dataset, key).then(fill);
}

/**
 * Side bar section "외부 데이터": datasets of the gateway, their records, and copyable field references.
 * `notify` shows a status bar message (copy results, errors).
 */
export class DataBrowser {
  private dataset = '';
  private key = '';
  private datasets: DatasetInfo[] = [];
  private status: HTMLElement;
  private select: HTMLSelectElement;
  private search: HTMLInputElement;
  private keys: HTMLUListElement;
  private record: HTMLElement;
  private searchSeq = 0;

  constructor(
    root: HTMLElement,
    private readonly store: RecordStore,
    private readonly notify: (text: string) => void,
  ) {
    this.status = el('p', 'muted');
    this.select = document.createElement('select');
    this.select.addEventListener('change', () => this.pickDataset(this.select.value));
    this.search = document.createElement('input');
    this.search.type = 'search';
    this.search.placeholder = '키 검색 (예: MC)';
    this.search.addEventListener('input', () => this.listKeys());
    this.keys = el('ul', 'list data-keys') as HTMLUListElement;
    this.record = el('div', 'props');
    const pick = el('label', 'row');
    pick.append('데이터셋 ', this.select);
    root.replaceChildren(this.status, pick, this.search, this.keys, this.record);
    store.onChange(() => {
      if (this.key) void this.showRecord();
    });
  }

  /** Reloads the dataset list (after opening the section or changing the gateway address). */
  async refresh(): Promise<void> {
    this.status.textContent = `불러오는 중… (${this.store.base})`;
    try {
      this.datasets = await this.store.datasets(true);
    } catch (err) {
      this.datasets = [];
      this.status.textContent = `데이터 게이트웨이 연결 안 됨: ${message(err)}`;
      this.select.replaceChildren();
      this.keys.replaceChildren();
      this.record.replaceChildren();
      return;
    }
    this.status.textContent = this.datasets.length
      ? `${this.store.base} · 데이터셋 ${this.datasets.length}개 (읽기 전용)`
      : '게이트웨이에 설정된 데이터셋이 없습니다(docs/DATA_SOURCES.md).';
    this.select.replaceChildren(...this.datasets.map((d) => new Option(`${d.label ?? d.name} (${d.count}건)`, d.name)));
    const keep = this.datasets.some((d) => d.name === this.dataset) ? this.dataset : (this.datasets[0]?.name ?? '');
    this.select.value = keep;
    this.pickDataset(keep);
  }

  private pickDataset(name: string): void {
    if (name !== this.dataset) this.key = '';
    this.dataset = name;
    const info = this.datasets.find((d) => d.name === name);
    if (info?.error) this.status.textContent = `원본 읽기 오류: ${info.error}`;
    void this.listKeys();
    void this.showRecord();
  }

  private async listKeys(): Promise<void> {
    const seq = ++this.searchSeq;
    if (!this.dataset) return this.keys.replaceChildren();
    let keys: string[];
    try {
      keys = await this.store.keys(this.dataset, this.search.value.trim(), KEY_LIST_LIMIT);
    } catch (err) {
      if (seq === this.searchSeq) this.keys.replaceChildren(el('li', 'muted', message(err)));
      return;
    }
    if (seq !== this.searchSeq) return;
    this.keys.replaceChildren(
      ...keys.map((k) => {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.textContent = k;
        b.setAttribute('aria-pressed', String(k === this.key));
        b.addEventListener('click', () => {
          this.key = k;
          this.keys.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
          void this.showRecord();
        });
        li.append(b);
        return li;
      }),
    );
    if (keys.length === 0) this.keys.append(el('li', 'muted', '일치하는 레코드가 없습니다.'));
  }

  private async showRecord(): Promise<void> {
    const { dataset, key } = this;
    if (!dataset || !key) return this.record.replaceChildren();
    const s = await this.store.get(dataset, key);
    if (dataset !== this.dataset || key !== this.key) return;
    const f = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = key;
    f.append(legend);
    if (s.status !== 'ok') {
      f.append(el('div', 'warning', stateText(s, key)));
    } else {
      for (const [field, v] of Object.entries(s.fields)) {
        const k = el('span', 'k', field);
        const value = el('span', 'v');
        const text = el('span', '', formatField(v));
        const copy = document.createElement('button');
        copy.textContent = '참조 복사';
        const ref = formatFieldRef({ dataset, key, field });
        copy.title = `${ref}\nParameter 값이나 수식에 붙여 넣으면 이 값을 씁니다`;
        copy.addEventListener('click', () => void this.copy(ref));
        value.append(text, ' ', copy);
        f.append(k, value);
      }
      const hint = el('div', 'muted', '참조를 Parameter·치수 수식에 붙여 넣으면 원본 값이 개체값으로 쓰입니다. 값은 원본에서만 고칩니다.');
      hint.style.gridColumn = '1 / -1';
      hint.style.fontSize = '11.5px';
      f.append(hint);
    }
    this.record.replaceChildren(f);
  }

  private async copy(ref: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(ref);
      this.notify(`복사됨: ${ref}`);
    } catch {
      // Clipboard needs a secure context (https or localhost); show the text to copy by hand instead.
      this.notify(`복사할 수 없습니다. 직접 복사하십시오: ${ref}`);
    }
  }
}

function el(tag: string, cls = '', text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
