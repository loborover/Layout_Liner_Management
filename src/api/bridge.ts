/**
 * @file bridge.ts
 *
 * Browser side of the MCP live bridge. When the user presses "AI 연결" (ribbon AI·API tab), the editor opens a
 * WebSocket to the MCP server (mcp/server.ts, default ws://127.0.0.1:7820) and answers its JSON-RPC requests
 * with the editor's own EditorApi, so an AI's edits appear live and are undoable like the user's.
 * Protocol: the server sends {jsonrpc:'2.0', id, method, params}; the editor replies with handleJsonRpc's result.
 * The first message from the editor is {type:'hello', app:'layout-liner-editor'}.
 */
import type { EditorApi } from './editorApi';
import { handleJsonRpc } from './rpc';

export type BridgeState = 'closed' | 'connecting' | 'open';

export class BridgeClient {
  private socket: WebSocket | null = null;

  constructor(
    private readonly api: EditorApi,
    private readonly onState: (state: BridgeState, detail?: string) => void,
    /** Called after each call that may have changed the drawing (e.g. to show a status message). */
    private readonly onCall: (method: string) => void = () => {},
  ) {}

  get state(): BridgeState {
    if (!this.socket) return 'closed';
    return this.socket.readyState === WebSocket.OPEN ? 'open' : this.socket.readyState === WebSocket.CONNECTING ? 'connecting' : 'closed';
  }

  connect(url: string): void {
    this.disconnect();
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      this.onState('closed', `주소가 잘못되었습니다: ${String(err)}`);
      return;
    }
    this.socket = socket;
    this.onState('connecting');
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'hello', app: 'layout-liner-editor' }));
      this.onState('open');
    });
    socket.addEventListener('close', () => {
      if (this.socket === socket) this.socket = null;
      this.onState('closed');
    });
    socket.addEventListener('error', () => this.onState('closed', 'MCP 서버에 연결할 수 없습니다. npm run mcp 로 서버를 실행했는지 확인하십시오.'));
    socket.addEventListener('message', (ev) => {
      let msg: { id?: unknown; method?: unknown; params?: unknown };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (typeof msg.method !== 'string') return;
      socket.send(JSON.stringify(handleJsonRpc(this.api, msg)));
      this.onCall(msg.method);
    });
  }

  disconnect(): void {
    const s = this.socket;
    this.socket = null;
    s?.close();
  }
}
