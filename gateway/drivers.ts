/**
 * @file drivers.ts (data gateway)
 *
 * Readers that turn one configured dataset into rows: CSV and JSON files, SQLite (Node's built-in node:sqlite),
 * PostgreSQL (pg), MySQL/MariaDB (mysql2), SQL Server (mssql) and an existing HTTP/JSON API. Every reader is
 * read-only: SQL sources run only the SELECT the gateway's owner wrote in the config, SQLite files are opened
 * read-only, and nothing a browser sends ever reaches a query. The database client packages are not dependencies
 * of the editor; they are loaded on demand and installed in the gateway image (gateway/Dockerfile).
 * See gateway/datasets.ts for the config and cache, docs/DATA_SOURCES.md for the user guide.
 */
import { readFile } from 'node:fs/promises';

/** One row as read from a source, before values are normalised. */
export type Row = Record<string, unknown>;

export type DriverName = 'csv' | 'json' | 'sqlite' | 'postgres' | 'mysql' | 'mssql' | 'http';
export const DRIVERS: DriverName[] = ['csv', 'json', 'sqlite', 'postgres', 'mysql', 'mssql', 'http'];

/** The parts of a dataset's config a driver uses (validated in datasets.ts). */
export interface SourceConfig {
  driver: DriverName;
  /** csv, json, sqlite: file path (relative to the config file). */
  file?: string;
  /** csv: text encoding, e.g. "euc-kr" for an Excel export in Korean Windows; utf-8 when absent. */
  encoding?: string;
  /** csv: field separator; ',' when absent. */
  delimiter?: string;
  /** postgres, mysql, mssql: connection string, or "env:NAME" to read it from an environment variable. */
  connection?: string;
  /** sqlite, postgres, mysql, mssql: the SELECT that produces the rows. */
  query?: string;
  /** http: address of a JSON API returning an array of objects (or an object holding one, see `path`). */
  url?: string;
  /** http: request headers; values may be "env:NAME". */
  headers?: Record<string, string>;
  /** json, http: dotted path to the array inside the document, e.g. "data.items". */
  path?: string;
  /** Rows beyond this are refused (protects the gateway's memory). */
  maxRows: number;
}

/** Resolves "env:NAME" to that environment variable (so secrets stay out of config files). */
export function secret(v: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (v === undefined) return undefined;
  const m = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(v);
  if (!m) return v;
  const value = env[m[1]];
  if (value === undefined) throw new Error(`환경 변수 ${m[1]}가 없습니다.`);
  return value;
}

/**
 * True when a SQL text is a single read query (SELECT or WITH … SELECT). A guard against configuration
 * mistakes, not a security boundary: give the gateway a database account that can only read.
 */
export function isReadQuery(sql: string): boolean {
  const text = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim()
    .replace(/;\s*$/, '');
  if (text.includes(';')) return false;
  if (!/^(select|with)\b/i.test(text)) return false;
  return !/\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|exec|execute|call|into)\b/i.test(text.replace(/'(?:[^']|'')*'/g, "''"));
}

/** Parses CSV text (RFC 4180: quoted fields, doubled quotes, line breaks inside quotes) into rows of cells. */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c !== ''));
}

/** Rows of a CSV whose first line is the header. */
export function csvRows(text: string, delimiter = ','): Row[] {
  const [header, ...body] = parseCsv(text, delimiter);
  if (!header) return [];
  const names = header.map((h) => h.trim());
  return body.map((cells) => Object.fromEntries(names.map((n, i) => [n, cells[i] ?? ''])));
}

/** Follows a dotted path ("data.items") into a JSON document. */
function at(doc: unknown, path: string | undefined): unknown {
  if (!path) return doc;
  let v: unknown = doc;
  for (const part of path.split('.')) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[part] : undefined;
  return v;
}

function asRows(v: unknown, where: string): Row[] {
  if (!Array.isArray(v)) throw new Error(`${where}에서 객체 배열을 찾지 못했습니다(path 설정 확인).`);
  return v.filter((r): r is Row => !!r && typeof r === 'object' && !Array.isArray(r));
}

/** Loads an optional client package, with an install hint when it is missing. */
async function optional(name: string): Promise<any> {
  try {
    return await import(name);
  } catch {
    throw new Error(`${name} 패키지가 설치되어 있지 않습니다. 데이터 게이트웨이 Docker 이미지를 쓰거나 'npm install ${name}'을 실행하십시오.`);
  }
}

/** Reads all rows of a source. `baseDir` resolves relative file paths. */
export async function readRows(c: SourceConfig, resolvePath: (file: string) => string): Promise<Row[]> {
  const sql = () => {
    if (!c.query || !isReadQuery(c.query)) throw new Error('query는 SELECT(또는 WITH … SELECT) 한 문장이어야 합니다.');
    return c.query;
  };
  let rows: Row[];
  switch (c.driver) {
    case 'csv': {
      const bytes = await readFile(resolvePath(c.file!));
      rows = csvRows(new TextDecoder(c.encoding ?? 'utf-8').decode(bytes), c.delimiter ?? ',');
      break;
    }
    case 'json':
      rows = asRows(at(JSON.parse(await readFile(resolvePath(c.file!), 'utf8')), c.path), c.file!);
      break;
    case 'sqlite': {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(resolvePath(c.file!), { readOnly: true });
      try {
        rows = db.prepare(sql()).all() as Row[];
      } finally {
        db.close();
      }
      break;
    }
    case 'postgres': {
      const pg = await optional('pg');
      const client = new (pg.default ?? pg).Client({ connectionString: secret(c.connection) });
      await client.connect();
      try {
        rows = (await client.query(sql())).rows;
      } finally {
        await client.end();
      }
      break;
    }
    case 'mysql': {
      const mysql = await optional('mysql2/promise');
      const conn = await (mysql.default ?? mysql).createConnection(secret(c.connection));
      try {
        [rows] = await conn.query(sql());
      } finally {
        await conn.end();
      }
      break;
    }
    case 'mssql': {
      const mod = await optional('mssql');
      const mssql = mod.default ?? mod;
      const pool = await new mssql.ConnectionPool(secret(c.connection)).connect();
      try {
        rows = (await pool.request().query(sql())).recordset;
      } finally {
        await pool.close();
      }
      break;
    }
    case 'http': {
      const headers: Record<string, string> = { Accept: 'application/json' };
      for (const [k, v] of Object.entries(c.headers ?? {})) headers[k] = secret(v)!;
      const res = await fetch(secret(c.url)!, { headers });
      if (!res.ok) throw new Error(`원본 API가 HTTP ${res.status}로 응답했습니다.`);
      rows = asRows(at(await res.json(), c.path), 'API 응답');
      break;
    }
  }
  if (rows.length > c.maxRows) throw new Error(`행이 ${rows.length}개로 maxRows(${c.maxRows})를 넘습니다. 조회를 좁히거나 maxRows를 늘리십시오.`);
  return rows;
}
