import { describe, expect, it } from 'vitest';
import { EditorApi } from '../src/api/editorApi';
import { dispatch } from '../src/api/rpc';
import { RecordStore, gatewayAddress, parseRecordRef, recordKey } from '../src/data/records';
import { asFormulaValue, fieldRefOf, formatFieldRef, prefetch, recordFunctions, refsFromCalls } from '../src/data/recordValues';
import { deserialize, serialize } from '../src/io/serialize';
import { History } from '../src/model/commands';
import { DocumentModel } from '../src/model/document';
import type { Entity } from '../src/model/types';

/** Fake gateway: records by dataset, counting requests. */
function fakeGateway(data: Record<string, Record<string, Record<string, string>>>, fail = false) {
  const calls: string[] = [];
  const fetchFn = async (url: string) => {
    calls.push(url);
    if (fail) throw new Error('down');
    const u = new URL(url, 'http://x');
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.at(-1) === 'datasets') return { ok: true, status: 200, json: async () => ({ datasets: Object.keys(data).map((name) => ({ name, key: 'k', fields: [], count: 0 })) }) };
    const ds = data[decodeURIComponent(parts.at(-2)!)];
    if (!ds) return { ok: false, status: 404, json: async () => ({ error: '데이터셋이 없습니다' }) };
    const keys = u.searchParams.getAll('key');
    const records = Object.fromEntries(keys.filter((k) => ds[k]).map((k) => [k, ds[k]]));
    return { ok: true, status: 200, json: async () => ({ records, missing: keys.filter((k) => !ds[k]) }) };
  };
  return { calls, store: new RecordStore('http://gw/data/', fetchFn) };
}

describe('source data links', () => {
  it('validates record references and picks the default key', () => {
    expect(parseRecordRef({ dataset: 'equipment', key: ' MC-1 ' })).toEqual({ dataset: 'equipment', key: 'MC-1' });
    expect(parseRecordRef({ dataset: 'equipment', key: '' })).toEqual({ dataset: 'equipment' });
    expect(parseRecordRef({ dataset: '../etc' })).toBeUndefined();
    expect(parseRecordRef('equipment')).toBeUndefined();
    const eq = { id: 'e', kind: 'equipment', type: 't', at: 'p', rotation: 0, tag: 'MC-3', layer: 'l', record: { dataset: 'equipment' } } as Entity;
    expect(recordKey(eq)).toBe('MC-3');
    expect(recordKey({ ...eq, record: { dataset: 'equipment', key: 'X' } } as Entity)).toBe('X');
    const shape = { id: 's', kind: 'shape', points: [], edges: [], layer: 'l', name: 'A-101', record: { dataset: 'rooms' } } as Entity;
    expect(recordKey(shape)).toBe('A-101');
    expect(recordKey({ ...shape, name: undefined } as Entity)).toBeUndefined();
    expect(recordKey({ ...shape, record: undefined } as Entity)).toBeUndefined();
  });

  it('reads the gateway address from ?data= and refuses other schemes', () => {
    expect(gatewayAddress('')).toBe('/data');
    expect(gatewayAddress('?data=http://10.0.0.5:7840')).toBe('http://10.0.0.5:7840');
    expect(gatewayAddress('?data=/api/data')).toBe('/api/data');
    expect(gatewayAddress('?data=javascript:alert(1)')).toBe('/data');
    expect(gatewayAddress('?data=//evil.example')).toBe('/data');
  });

  it('batches lookups of one tick into one request and caches them', async () => {
    const { store, calls } = fakeGateway({ equipment: { 'MC-1': { name: '가공기' }, 'MC-2': { name: '선반' } } });
    const [a, b, c] = await Promise.all([store.get('equipment', 'MC-1'), store.get('equipment', 'MC-2'), store.get('equipment', 'NOPE')]);
    expect(a).toEqual({ status: 'ok', fields: { name: '가공기' } });
    expect(b.status).toBe('ok');
    expect(c).toEqual({ status: 'missing' });
    expect(calls).toEqual(['http://gw/data/datasets/equipment/records?key=MC-1&key=MC-2&key=NOPE']);
    await store.get('equipment', 'MC-1');
    expect(calls.length).toBe(1);
    expect(store.peek('equipment', 'MC-2')?.status).toBe('ok');
    expect((await store.datasets()).map((d) => d.name)).toEqual(['equipment']);
  });

  it('turns gateway failures into error states instead of throwing', async () => {
    const down = fakeGateway({}, true).store;
    expect(await down.get('equipment', 'MC-1')).toEqual({ status: 'error', message: '데이터 게이트웨이에 연결할 수 없습니다.' });
    await expect(down.datasets()).rejects.toThrow('연결할 수 없습니다');
    const { store } = fakeGateway({});
    const r = await store.get('nothing', 'k');
    expect(r.status).toBe('error');
    expect(r.status === 'error' && r.message).toContain('데이터셋이 없습니다');
  });

  it('keeps links in saved drawings and drops malformed ones', () => {
    const doc = new DocumentModel();
    doc.addPoints([{ id: 'a', x: 0, y: 0 }]);
    doc.addEntities([
      { id: 'p', kind: 'point', at: 'a', layer: 'layer-0', record: { dataset: 'survey', key: 'BM-1' } },
      { id: 'q', kind: 'point', at: 'a', layer: 'layer-0' },
    ]);
    const data = JSON.parse(serialize(doc.toData()));
    expect(deserialize(JSON.stringify(data)).entities[0].record).toEqual({ dataset: 'survey', key: 'BM-1' });
    data.entities[1].record = { dataset: 'bad name!' };
    expect(deserialize(JSON.stringify(data)).entities[1].record).toBeUndefined();
  });

  it('links objects through the API as one undo step', () => {
    const doc = new DocumentModel();
    const history = new History(doc);
    const api = new EditorApi(doc, history);
    const a = dispatch(api, 'placeEquipment', { type: 'eq-machine', x: 0, y: 0 }) as { id: string; tag: string };
    const b = dispatch(api, 'placeEquipment', { type: 'eq-machine', x: 5000, y: 0 }) as { id: string; tag: string };
    const r = dispatch(api, 'linkRecords', { ids: [a.id, b.id], dataset: 'equipment' }) as { linked: number };
    expect(r.linked).toBe(2);
    expect((dispatch(api, 'getEntity', { id: b.id }) as { recordKey: string }).recordKey).toBe(b.tag);
    expect(() => dispatch(api, 'linkRecords', { ids: [a.id, b.id], dataset: 'equipment', key: 'X' })).toThrow();
    dispatch(api, 'updateEntity', { id: a.id, record: { dataset: 'equipment', key: 'MC-77' } });
    expect(doc.entities.get(a.id)!.record).toEqual({ dataset: 'equipment', key: 'MC-77' });
    expect(() => dispatch(api, 'updateEntity', { id: a.id, record: { dataset: 'no spaces' } })).toThrow();
    history.undo();
    expect(doc.entities.get(a.id)!.record).toEqual({ dataset: 'equipment' });
    dispatch(api, 'linkRecords', { ids: [a.id], dataset: null });
    expect(doc.entities.get(a.id)!.record).toBeUndefined();
    history.undo();
    history.undo();
    expect(doc.entities.get(b.id)!.record).toBeUndefined();
  });
});

describe('source data as formula values', () => {
  it('formats and parses DB references', () => {
    const ref = { dataset: 'equipment', key: 'MC-"1"', field: '정격전력(kW)' };
    expect(formatFieldRef(ref)).toBe('DB("equipment", "MC-\\"1\\"", "정격전력(kW)")');
    expect(fieldRefOf(['equipment', 'MC-1', '설비명'])).toEqual({ dataset: 'equipment', key: 'MC-1', field: '설비명' });
    expect(fieldRefOf(['bad name', 'MC-1', '설비명'])).toBeUndefined();
    expect(fieldRefOf(['equipment', 'MC-1'])).toBeUndefined();
    expect(refsFromCalls([{ name: 'DB', args: ['rooms', 'A-101', 'name'] }, { name: 'max', args: [1, 2] }, { name: 'DB', args: [null, 'x', 'y'] }])).toEqual([
      { dataset: 'rooms', key: 'A-101', field: 'name' },
    ]);
  });

  it('turns numeric text into numbers', () => {
    expect(asFormulaValue('22')).toBe(22);
    expect(asFormulaValue(' 5.5 ')).toBe(5.5);
    expect(asFormulaValue('1,200')).toBe(1200);
    expect(asFormulaValue('HX-500')).toBe('HX-500');
    expect(asFormulaValue('')).toBe('');
    expect(asFormulaValue(null)).toBeUndefined();
    expect(asFormulaValue(true)).toBe(1);
  });

  it('answers DB() from the cache and fetches what is missing', async () => {
    const { store, calls } = fakeGateway({ equipment: { 'MC-1': { kw: '22', name: '가공기' } } });
    const fns = recordFunctions(store);
    let changed = 0;
    store.onChange(() => changed++);
    expect(fns.DB('equipment', 'MC-1', 'kw')).toBeUndefined();
    await new Promise((r) => setTimeout(r, 5));
    expect(changed).toBe(1);
    expect(fns.DB('equipment', 'MC-1', 'kw')).toBe(22);
    expect(fns.DB('equipment', 'MC-1', 'name')).toBe('가공기');
    expect(fns.DB('equipment', 'MC-1', 'nope')).toBeUndefined();
    expect(fns.DB('equipment', 'MC-1')).toBeUndefined();
    expect(calls.length).toBe(1);
    await prefetch(store, [{ dataset: 'equipment', key: 'MC-9', field: 'kw' }, { dataset: 'equipment', key: 'MC-9', field: 'name' }]);
    expect(calls.length).toBe(2);
    store.setBase('http://other/');
    expect(store.base).toBe('http://other');
    expect(store.peek('equipment', 'MC-1')).toBeUndefined();
  });

  it('drops answers from the previous gateway after the address changes', async () => {
    let release: () => void = () => undefined;
    const slow = (url: string) =>
      new Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>((resolve) => {
        release = () => resolve({ ok: true, status: 200, json: async () => ({ records: { A: { from: url } }, missing: [] }) });
      });
    const store = new RecordStore('http://old', slow);
    const inFlight = store.get('ds', 'A');
    await new Promise((r) => setTimeout(r, 5));
    store.setBase('http://new');
    expect(await inFlight).toEqual({ status: 'error', message: '게이트웨이 주소가 바뀌었습니다.' });
    release();
    await new Promise((r) => setTimeout(r, 5));
    expect(store.peek('ds', 'A')).toBeUndefined();
  });
});
