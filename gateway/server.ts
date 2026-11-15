/**
 * @file server.ts (data gateway)
 *
 * Read-only HTTP gateway between drawings and source databases ("원본 데이터 연결", docs/DATA_SOURCES.md).
 * The editor and the monitoring viewer ask it for records by dataset and key; it answers from the in-memory
 * cache of each dataset (datasets.ts), which it fills by running only the queries in its config file. Database
 * credentials stay on the host (environment variables), and browsers never send SQL.
 *
 *   npm run data:gateway -- --config gateway/example/datasets.json
 *   GET /health
 *   GET /datasets                                    → { datasets: DatasetInfo[] }
 *   GET /datasets/:name/records?key=A&key=B          → { records: { A: {...} }, missing: ["B"] }
 *   GET /datasets/:name/keys?q=CNC&limit=50          → { keys: [...] }
 *
 * In Docker it runs as its own service behind the editor's Nginx at /data/ (deploy/docker-compose.yml).
 */
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { MAX_KEYS_PER_REQUEST, MAX_RECORD_KEY, type RecordFields, type RecordsResponse } from '../src/data/records';
import { type Dataset, type GatewayConfig, createDatasets, loadConfig, parseConfig } from './datasets';

const MAX_KEY_LIST = 500;

/** Request handler of the gateway (exported for tests). */
export function createHandler(config: GatewayConfig, datasets: Map<string, Dataset>) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (config.allowOrigin) res.setHeader('Access-Control-Allow-Origin', config.allowOrigin);
      res.end(JSON.stringify(body));
    };
    if (req.method === 'OPTIONS' && config.allowOrigin) {
      res.statusCode = 204;
      res.setHeader('Access-Control-Allow-Origin', config.allowOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'GET');
      res.end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, { error: '읽기 전용 게이트웨이입니다(GET만 허용).' });
    const url = new URL(req.url ?? '/', 'http://gateway');
    let parts: string[];
    try {
      parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      return send(400, { error: '주소의 % 인코딩이 잘못되었습니다.' });
    }
    try {
      if (parts.length === 1 && parts[0] === 'health') return send(200, { ok: true, datasets: datasets.size });
      if (parts.length === 1 && parts[0] === 'datasets') {
        await Promise.all([...datasets.values()].map((d) => d.ready()));
        return send(200, { datasets: [...datasets.values()].map((d) => d.info()) });
      }
      if (parts.length === 3 && parts[0] === 'datasets') {
        const ds = datasets.get(parts[1]);
        if (!ds) return send(404, { error: `데이터셋이 없습니다: ${parts[1]}` });
        await ds.ready();
        const info = ds.info();
        if (info.error && info.count === 0) return send(503, { error: info.error });
        if (parts[2] === 'records') {
          const keys = [...new Set(url.searchParams.getAll('key'))];
          if (keys.length === 0) return send(400, { error: 'key 매개변수가 필요합니다.' });
          if (keys.length > MAX_KEYS_PER_REQUEST) return send(400, { error: `한 번에 ${MAX_KEYS_PER_REQUEST}개까지 조회할 수 있습니다.` });
          const out: RecordsResponse = { records: {} as Record<string, RecordFields>, missing: [] };
          for (const k of keys) {
            const rec = k.length <= MAX_RECORD_KEY ? ds.get(k) : undefined;
            if (rec) out.records[k] = rec;
            else out.missing.push(k);
          }
          return send(200, out);
        }
        if (parts[2] === 'keys') {
          const limit = Math.min(MAX_KEY_LIST, Math.max(1, Number(url.searchParams.get('limit')) || 50));
          return send(200, { keys: ds.keys(url.searchParams.get('q') ?? '', limit) });
        }
      }
      return send(404, { error: '없는 주소입니다.' });
    } catch (err) {
      return send(500, { error: err instanceof Error ? err.message : String(err) });
    }
  };
}

/** Starts the gateway from a config file; the address comes from the config or the --host/--port options. */
export async function start(configPath: string, overrides: { host?: string; port?: number } = {}) {
  // Without a config the gateway still starts (empty), so a Docker deployment without data sources stays healthy.
  const config = existsSync(configPath) ? await loadConfig(configPath) : parseConfig({});
  if (!existsSync(configPath)) console.warn(`설정 파일이 없어 데이터셋 없이 시작합니다: ${configPath} (docs/DATA_SOURCES.md)`);
  if (overrides.host) config.host = overrides.host;
  if (overrides.port) config.port = overrides.port;
  const datasets = createDatasets(config, configPath);
  const handler = createHandler(config, datasets);
  // The handler answers its own errors; this only keeps an unexpected one from stopping the process.
  const server = createServer((req, res) =>
    handler(req, res).catch((err: unknown) => {
      console.error(err);
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    }),
  );
  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
  // Fill every cache once at start so the first browser request is answered from memory.
  for (const d of datasets.values()) void d.ready().then(() => {
    const info = d.info();
    console.log(info.error ? `  ${d.name}: 오류 - ${info.error}` : `  ${d.name}: ${info.count}건 (${d.config.driver})`);
  });
  console.log(`데이터 게이트웨이: http://${config.host}:${config.port}/datasets (데이터셋 ${datasets.size}개, 읽기 전용)`);
  return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const configPath = arg('--config') ?? process.env.LL_DATA_CONFIG ?? 'datasets.json';
  start(configPath, { host: arg('--host') ?? process.env.LL_DATA_HOST, port: Number(arg('--port') ?? process.env.LL_DATA_PORT) || undefined }).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
