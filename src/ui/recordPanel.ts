/**
 * @file recordPanel.ts
 *
 * Widgets of the source data link ("원본 데이터", docs/DATA_SOURCES.md): the property panel section that links
 * selected objects to a dataset of the data gateway and shows the linked record's fields, and the block the
 * information card (viewer mode, monitoring viewer app) appends for a linked object. Records are read-only here:
 * the panel only stores the link (dataset and optional key) in the drawing, as one undoable command.
 * Lookups go through RecordStore (src/data/records.ts) and fill in asynchronously.
 */
import { type RecordState, type RecordStore, defaultRecordKey, formatField, recordKey } from '../data/records';
import { UpdateEntities } from '../model/commands';
import { cloneEntity } from '../model/document';
import type { Entity } from '../model/types';
import type { UiHost } from './host';

/** Fields shown before "더 보기"; a record can have dozens of columns. */
const MAX_SHOWN_FIELDS = 12;

function row(f: HTMLElement, key: string, value: Node | string, cls = ''): void {
  const k = document.createElement('span');
  k.className = 'k';
  k.textContent = key;
  const v = document.createElement('span');
  v.className = `v ${cls}`;
  v.append(value);
  f.append(k, v);
}

function note(f: HTMLElement, text: string, warn = false): HTMLElement {
  const n = document.createElement('div');
  n.className = warn ? 'warning' : 'warning muted';
  n.textContent = text;
  f.append(n);
  return n;
}

/** Applies a link change to `items` as one undo step. */
function relink(host: UiHost, label: string, items: Entity[], edit: (c: Entity) => void): void {
  const after = items.map((e) => {
    const c = cloneEntity(e);
    edit(c);
    return c;
  });
  host.history.execute(new UpdateEntities(label, items, after));
}

/** Text for a lookup that did not produce a record. */
function stateText(s: RecordState, key: string): string {
  if (s.status === 'loading') return '불러오는 중…';
  if (s.status === 'missing') return `원본에 '${key}' 레코드가 없습니다.`;
  if (s.status === 'error') return s.message;
  return '';
}

/**
 * Property panel section "원본 데이터" for one or more selected objects: dataset picker, record key (one
 * object) and the linked record's fields.
 */
export function recordSet(host: UiHost, items: Entity[], readOnly: boolean): HTMLFieldSetElement {
  const f = document.createElement('fieldset');
  const legend = document.createElement('legend');
  legend.textContent = '원본 데이터 (DB, 읽기 전용)';
  f.append(legend);
  const store = host.records;
  if (!store) {
    note(f, '데이터 게이트웨이 주소가 설정되지 않았습니다.');
    return f;
  }
  const first = items[0];
  const shared = items.every((e) => e.record?.dataset === first.record?.dataset) ? (first.record?.dataset ?? '') : null;

  // Dataset picker: filled when the gateway answers; the current value is kept even if the gateway is down.
  const select = document.createElement('select');
  select.disabled = readOnly;
  const base = [new Option('(연결 안 함)', '')];
  if (shared === null) base.unshift(new Option('(여러 데이터셋)', '\u0000'));
  if (shared) base.push(new Option(shared, shared));
  select.replaceChildren(...base);
  select.value = shared ?? '\u0000';
  select.addEventListener('change', () => {
    const v = select.value;
    if (v === '\u0000') return;
    relink(host, v ? '원본 데이터 연결' : '원본 데이터 연결 해제', items, (c) => {
      if (!v) delete c.record;
      else c.record = { dataset: v, ...(c.record?.dataset === v && c.record.key ? { key: c.record.key } : {}) };
    });
  });
  row(f, '데이터셋', select);
  const status = note(f, '데이터셋 목록을 불러오는 중…');
  store.datasets().then(
    (list) => {
      for (const d of list) {
        if (d.name === shared) {
          select.querySelector<HTMLOptionElement>(`option[value="${CSS.escape(d.name)}"]`)!.text = d.label ? `${d.label} (${d.name})` : d.name;
          continue;
        }
        select.append(new Option(d.label ? `${d.label} (${d.name})` : d.name, d.name));
      }
      const current = list.find((d) => d.name === shared);
      if (list.length === 0) status.textContent = '게이트웨이에 설정된 데이터셋이 없습니다(docs/DATA_SOURCES.md).';
      else if (shared && !current) status.textContent = `게이트웨이에 '${shared}' 데이터셋이 없습니다.`;
      else if (current?.error) {
        status.textContent = `원본 읽기 오류: ${current.error}`;
        status.className = 'warning';
      } else status.remove();
    },
    (err: unknown) => {
      status.textContent = `데이터 게이트웨이 연결 안 됨: ${err instanceof Error ? err.message : String(err)}`;
    },
  );

  if (items.length > 1) {
    const linked = items.filter((e) => recordKey(e) !== undefined).length;
    row(f, '연결', `${linked} / ${items.length}개`);
    note(f, '여러 객체를 한 번에 연결하면 각 객체의 설비 번호(없으면 이름)가 레코드 키가 됩니다.');
    return f;
  }

  const e = first;
  const key = document.createElement('input');
  key.type = 'text';
  key.value = e.record?.key ?? '';
  key.disabled = readOnly || !e.record;
  const fallback = defaultRecordKey(e);
  key.placeholder = fallback ? `${fallback} (기본: ${e.kind === 'equipment' && e.tag.trim() ? '설비 번호' : '이름'})` : '레코드 키';
  key.title = '원본 레코드의 키 값. 비워 두면 설비 번호, 없으면 이름을 키로 씁니다.';
  key.addEventListener('keydown', (ev) => ev.key === 'Enter' && key.blur());
  key.addEventListener('change', () =>
    relink(host, '원본 레코드 키 변경', [e], (c) => {
      if (!c.record) return;
      const v = key.value.trim();
      c.record = { dataset: c.record.dataset, ...(v ? { key: v } : {}) };
    }),
  );
  // Suggest keys from the gateway while typing.
  const list = document.createElement('datalist');
  list.id = `record-keys-${Math.random().toString(36).slice(2)}`;
  key.setAttribute('list', list.id);
  let asked = '';
  key.addEventListener('input', () => {
    const q = key.value.trim();
    if (!e.record || q === asked) return;
    asked = q;
    store.keys(e.record.dataset, q, 30).then(
      (keys) => list.replaceChildren(...keys.map((k) => new Option(k, k))),
      () => undefined,
    );
  });
  const keyCell = document.createElement('span');
  keyCell.append(key, list);
  row(f, '레코드 키', keyCell);
  if (!e.record) {
    if (!readOnly) note(f, '데이터셋을 고르면 이 객체가 원본 레코드를 참조합니다. 값은 원본에서만 고칩니다.');
    return f;
  }
  const k = recordKey(e);
  if (!k) {
    note(f, '레코드 키가 없습니다. 키를 입력하거나 이름(설비 번호)을 지정하십시오.', true);
    return f;
  }
  const body = document.createElement('div');
  body.style.display = 'contents';
  f.append(body);
  const show = (s: RecordState) => {
    body.replaceChildren();
    if (s.status !== 'ok') {
      note(body, stateText(s, k), s.status !== 'loading');
      return;
    }
    fieldRows(body, s.fields, (name, value) => row(body, name, value));
  };
  show(store.peek(e.record.dataset, k) ?? { status: 'loading' });
  void store.get(e.record.dataset, k).then(show);
  return f;
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
