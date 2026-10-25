/**
 * @file server.ts
 *
 * Layout Liner MCP server ("AI가 편집툴을 사용할 수 있도록 MCP 제공").
 *
 *   npm run mcp -- [--file plan.json] [--port 7820] [--no-autosave] [--no-bridge]
 *
 * - MCP over stdio: one tool per API method (src/api/rpc.ts METHODS) plus open_file, save_file, new_drawing and
 *   bridge_status. Any MCP client (Claude Code via .mcp.json, Claude Desktop, other agents) can use it.
 * - Live bridge on ws://127.0.0.1:<port>: an editor tab that presses "AI 연결" receives the calls, so edits
 *   appear in the browser immediately and can be undone there.
 * - HTTP JSON-RPC on http://127.0.0.1:<port>/rpc for scripts and non-MCP tools: POST {"jsonrpc":"2.0","id":1,
 *   "method":"summary","params":{}}.
 * Logs go to stderr because stdout carries the MCP protocol. See docs/API.md.
 */
import { createServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { WebSocketServer } from 'ws';
import { METHODS } from '../src/api/rpc';
import { Router } from './router';
import { FILE_TOOLS, toolList } from './tools';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const log = (...m: unknown[]) => console.error('[layout-liner-mcp]', ...m);

const router = new Router({ file: value('--file'), autosave: !flag('--no-autosave') });
const port = Number(value('--port') ?? process.env.LAYOUT_LINER_PORT ?? 7820);

async function runTool(name: string, params: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'open_file':
      return router.openFile(String(params.path));
    case 'save_file':
      return router.saveFile(params.path === undefined ? undefined : String(params.path));
    case 'new_drawing':
      return router.newDrawing();
    case 'bridge_status':
      return router.status();
    default:
      return router.call(name, params);
  }
}

// ---- MCP over stdio ----
const mcp = new Server(
  { name: 'layout-liner', version: '0.2.0' },
  {
    capabilities: { tools: {} },
    instructions:
      'Layout Liner 평면도 편집 도구입니다. 좌표는 mm, Y축 위쪽. 먼저 summary로 층·레이어·라이브러리를 확인하고, ' +
      '방·구역은 addRectangle 또는 addLines(closed), 벽 두께는 stroke(width, align), 기둥·계단·경사로·리프트는 placeEquipment로 배치하십시오. ' +
      '여러 단계는 batch로 묶으면 한 번에 실행 취소됩니다. 브라우저 편집기가 "AI 연결"로 붙어 있으면 그 화면을, 아니면 --file 도면을 편집합니다.',
  },
);
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolList() }));
mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  if (!Object.hasOwn(METHODS, name) && !Object.hasOwn(FILE_TOOLS, name)) {
    return { isError: true, content: [{ type: 'text', text: `알 수 없는 도구: ${name}` }] };
  }
  try {
    const result = await runTool(name, (req.params.arguments ?? {}) as Record<string, unknown>);
    return { content: [{ type: 'text', text: JSON.stringify(result ?? null, null, 2) }] };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
  }
});

// ---- bridge (WebSocket) and HTTP JSON-RPC on 127.0.0.1 ----
if (!flag('--no-bridge')) {
  const http = createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/status')) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(router.status()));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/rpc') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 20e6) req.destroy();
    });
    req.on('end', async () => {
      let msg: { id?: unknown; method?: unknown; params?: unknown };
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 형식이 아닙니다.' } }));
        return;
      }
      const reply = async () => {
        try {
          return { jsonrpc: '2.0', id: msg.id ?? null, result: await runTool(String(msg.method), (msg.params ?? {}) as Record<string, unknown>) };
        } catch (err) {
          return { jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32602, message: err instanceof Error ? err.message : String(err) } };
        }
      };
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(await reply()));
    });
  });
  // Browsers send an Origin header; only pages served from localhost may drive the bridge.
  const wss = new WebSocketServer({
    server: http,
    verifyClient: ({ origin }: { origin?: string }) => !origin || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin) || process.env.LAYOUT_LINER_ALLOW_ORIGIN === origin,
  });
  wss.on('connection', (socket) => {
    router.attach(socket);
    log('편집기가 연결되었습니다.');
    socket.on('message', (data) => router.receive(String(data)));
    socket.on('close', () => {
      router.detach(socket);
      log('편집기 연결이 끊겼습니다.');
    });
  });
  // A port already in use must not take the MCP server down: it keeps working on the file.
  wss.on('error', () => {});
  http.on('error', (err) => log(`브리지를 열 수 없습니다 (포트 ${port}): ${err.message}. 헤드리스 모드로만 동작합니다.`));
  http.listen(port, '127.0.0.1', () => log(`브리지: ws://127.0.0.1:${port}  JSON-RPC: http://127.0.0.1:${port}/rpc`));
}

if (router.file) {
  router.openFile(router.file).then(
    (r) => log(`도면을 열었습니다: ${r.file} (객체 ${r.objects}개)`),
    (err) => log(`도면을 열 수 없어 새 도면으로 시작합니다 (${router.file}): ${err instanceof Error ? err.message : String(err)}`),
  );
}

// The client closing stdio ends the session; don't linger on the bridge port.
mcp.onclose = () => process.exit(0);
await mcp.connect(new StdioServerTransport());
log('MCP 서버가 stdio에서 실행 중입니다.');
