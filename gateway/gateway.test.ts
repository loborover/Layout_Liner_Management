import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RecordStore } from '../src/data/records';
import { Dataset, createDatasets, indexRows, loadConfig, parseConfig, toField } from './datasets';
import { csvRows, isReadQuery, parseCsv, secret } from './drivers';
import { createHandler } from './server';

const dir = mkdtempSync(join(tmpdir(), 'll-gw-'));

describe('data gateway drivers', () => {
  it('parses CSV with quotes, line breaks and a BOM', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\n"two\nlines",\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'he said "hi"'],
      ['two\nlines', ''],
    ]);
    expect(csvRows('id;name\n1;가\n', ';')).toEqual([{ id: '1', name: '가' }]);
  });

  it('accepts only single read queries', () => {
    expect(isReadQuery('SELECT tag, name FROM equipment WHERE active = 1;')).toBe(true);
    expect(isReadQuery('-- master\nWITH t AS (SELECT 1 AS k) SELECT * FROM t')).toBe(true);
    expect(isReadQuery("SELECT replace(name, 'a', 'b') AS n FROM t")).toBe(true);
    expect(isReadQuery("SELECT * FROM t WHERE note = 'drop table'")).toBe(true);
    expect(isReadQuery('DELETE FROM equipment')).toBe(false);
    expect(isReadQuery('SELECT 1; DROP TABLE equipment')).toBe(false);
    expect(isReadQuery('SELECT * INTO backup FROM equipment')).toBe(false);
    expect(isReadQuery('WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x')).toBe(false);
  });

  it('reads secrets from the environment', () => {
    expect(secret('env:DB_URL', { DB_URL: 'postgres://u:p@h/db' })).toBe('postgres://u:p@h/db');
    expect(secret('plain')).toBe('plain');
    expect(() => secret('env:MISSING_VAR_X', {})).toThrow('MISSING_VAR_X');
  });

  it('normalises database values', () => {
    expect(toField(new Date('2024-01-02T03:04:05Z'))).toBe('2024-01-02T03:04:05.000Z');
    expect(toField(12n)).toBe(12);
    expect(toField(2n ** 70n)).toBe('1180591620717411303424');
    expect(toField(undefined)).toBeNull();
    expect(toField({ a: 1 })).toBe('{"a":1}');
    const { records, fields } = indexRows([{ k: 'A', v: 1 }, { k: 'A', v: 2 }, { k: '', v: 3 }, { k: ' B ', v: 4 }], 'k', ['v']);
    expect([...records]).toEqual([['A', { v: 1 }], ['B', { v: 4 }]]);
    expect(fields).toEqual(['v']);
  });
});

describe('data gateway config', () => {
  it('validates datasets with clear messages', () => {
    expect(parseConfig({}).datasets).toEqual({});
    expect(parseConfig({}).host).toBe('127.0.0.1');
    expect(() => parseConfig({ datasets: { 'bad name': { driver: 'csv', file: 'x', key: 'k' } } })).toThrow('이름');
    expect(() => parseConfig({ datasets: { a: { driver: 'oracle', key: 'k' } } })).toThrow('driver');
    expect(() => parseConfig({ datasets: { a: { driver: 'postgres', key: 'k', connection: 'env:X', query: 'UPDATE t SET a=1' } } })).toThrow('SELECT');
    expect(() => parseConfig({ datasets: { a: { driver: 'csv', key: 'k' } } })).toThrow('file');
    expect(() => parseConfig({ datasets: { a: { driver: 'csv', key: 'k', file: 'a.csv', encoding: 'nope-enc' } } })).toThrow('encoding');
    const c = parseConfig({ datasets: { a: { driver: 'csv', key: 'k', file: 'a.csv', refreshMs: 10, encoding: 'euc-kr' } } });
    expect(c.datasets.a.refreshMs).toBe(5000);
  });

  it('serves the example datasets', async () => {
    const path = join(__dirname, 'example', 'datasets.json');
    const config = await loadConfig(path);
    const sets = createDatasets(config, path);
    const eq = sets.get('equipment')!;
    await eq.ready();
    expect(eq.info()).toMatchObject({ name: 'equipment', key: '설비번호', count: 5 });
    expect(eq.get('MC-1')).toMatchObject({ 설비명: '5축 가공기' });
    const rooms = sets.get('rooms')!;
    await rooms.ready();
    expect(rooms.get('B-201')).toEqual({ roomNo: 'B-201', name: '검사실', department: '품질팀', cleanClass: 'ISO 7', manager: '정품질' });
    expect(rooms.keys('a-1', 10)).toEqual(['A-101', 'A-102']);
  });

  it('reads Korean CSV exports and SQLite files read-only', async () => {
    // "설비" in EUC-KR (CP949), as Excel on Korean Windows saves CSV.
    writeFileSync(join(dir, 'kr.csv'), Buffer.concat([Buffer.from('id,'), Buffer.from([0xbc, 0xb3, 0xba, 0xf1]), Buffer.from('\nA,1\n')]));
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(dir, 'plant.db'));
    db.exec("CREATE TABLE equipment (tag TEXT, name TEXT, kw REAL); INSERT INTO equipment VALUES ('MC-1', '가공기', 22.5), ('MC-2', '선반', NULL);");
    db.close();
    const config = parseConfig({
      datasets: {
        kr: { driver: 'csv', file: 'kr.csv', encoding: 'euc-kr', key: 'id' },
        plant: { driver: 'sqlite', file: 'plant.db', query: 'SELECT tag, name, kw FROM equipment', key: 'tag' },
      },
    });
    const sets = createDatasets(config, join(dir, 'datasets.json'));
    await sets.get('kr')!.ready();
    expect(sets.get('kr')!.get('A')).toEqual({ id: 'A', 설비: '1' });
    await sets.get('plant')!.ready();
    expect(sets.get('plant')!.get('MC-2')).toEqual({ tag: 'MC-2', name: '선반', kw: null });
  });

  it('keeps the last good data when a refresh fails and reports the error', async () => {
    let now = 1_000_000;
    const file = join(dir, 'live.json');
    writeFileSync(file, JSON.stringify([{ k: 'A', v: 1 }]));
    const ds = new Dataset('live', parseConfig({ datasets: { live: { driver: 'json', file, key: 'k', refreshMs: 5000 } } }).datasets.live, (f) => f, () => now);
    await ds.ready();
    expect(ds.get('A')).toEqual({ k: 'A', v: 1 });
    writeFileSync(file, 'not json');
    now += 6000;
    await ds.ready();
    await new Promise((r) => setTimeout(r, 20));
    expect(ds.get('A')).toEqual({ k: 'A', v: 1 });
    expect(ds.info().error).toBeTruthy();
  });
});

describe('data gateway HTTP', () => {
  const path = join(__dirname, 'example', 'datasets.json');
  let server: ReturnType<typeof createServer> | undefined;
  afterAll(() => server?.close());

  async function start() {
    const config = await loadConfig(path);
    const handler = createHandler(config, createDatasets(config, path));
    server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('answers the editor client and refuses writes', async () => {
    const base = await start();
    const store = new RecordStore(base);
    const list = await store.datasets();
    expect(list.map((d) => d.name)).toEqual(['equipment', 'rooms']);
    expect(await store.get('equipment', 'CV-1')).toMatchObject({ status: 'ok', fields: { 설비명: '메인 컨베이어' } });
    expect(await store.get('equipment', 'XX-9')).toEqual({ status: 'missing' });
    expect(await store.keys('equipment', 'MC')).toEqual(['MC-1', 'MC-2']);
    const nope = await store.get('unknown', 'A');
    expect(nope.status === 'error' && nope.message).toContain('데이터셋이 없습니다');
    expect((await fetch(`${base}/datasets`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${base}/datasets/equipment/records`)).status).toBe(400);
    const many = new URLSearchParams(Array.from({ length: 101 }, (_, i) => ['key', `K${i}`]));
    expect((await fetch(`${base}/datasets/equipment/records?${many}`)).status).toBe(400);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });
});
