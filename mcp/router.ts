/**
 * @file router.ts
 *
 * Core of the Layout Liner MCP server, without any transport so it can be unit-tested.
 * Routes every API call either to a live editor tab connected over the bridge WebSocket (the AI edits what the
 * user sees, undoable in the browser) or, when no editor is connected, to a headless document in this process
 * that is read from and saved to a drawing file (.json). Both paths run the same EditorApi + METHODS table
 * (src/api), so behaviour is identical.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ApiError, EditorApi } from '../src/api/editorApi';
import { METHODS, dispatch } from '../src/api/rpc';
import { serialize } from '../src/io/serialize';
import { History } from '../src/model/commands';
import { DocumentModel } from '../src/model/document';

/** Minimal socket shape (the `ws` WebSocket satisfies it); lets tests use a fake. */
export interface EditorSocket {
  send(data: string): void;
  close(): void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface RouterOptions {
  /** Drawing file used by the headless document. */
  file?: string;
  /** Save the file after every change made headlessly. Default true. */
  autosave?: boolean;
  /** How long to wait for the editor to answer, ms. */
  timeoutMs?: number;
}

export class Router {
  readonly doc = new DocumentModel();
  readonly history = new History(this.doc);
  readonly api = new EditorApi(this.doc, this.history);
  file: string | undefined;
  private editor: EditorSocket | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;

  constructor(private readonly options: RouterOptions = {}) {
    this.file = options.file ? resolve(options.file) : undefined;
  }

  get connected(): boolean {
    return this.editor !== null;
  }

  /** Uses a newly connected editor tab; a previous one is dropped (one live editor at a time). */
  attach(socket: EditorSocket): void {
    if (this.editor && this.editor !== socket) this.editor.close();
    this.editor = socket;
  }

  detach(socket: EditorSocket): void {
    if (this.editor !== socket) return;
    this.editor = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new ApiError('편집기 연결이 끊겼습니다.'));
    }
    this.pending.clear();
  }

  /** Feeds a message received from the editor socket (a JSON-RPC response). */
  receive(text: string): void {
    let msg: { id?: number; result?: unknown; error?: { message: string } };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof msg.id !== 'number') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new ApiError(msg.error.message));
    else p.resolve(msg.result);
  }

  /** Runs an API method on the live editor if one is connected, else on the headless document. */
  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!Object.hasOwn(METHODS, method)) throw new ApiError(`알 수 없는 메서드입니다: ${method}`);
    if (this.editor) return this.remote(method, params);
    const result = dispatch(this.api, method, params);
    if (METHODS[method].mutates && this.file && this.options.autosave !== false) await this.save();
    return result;
  }

  private remote(method: string, params: unknown): Promise<unknown> {
    const editor = this.editor!;
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ApiError('편집기가 응답하지 않습니다. 브라우저 탭이 열려 있는지 확인하십시오.'));
      }, this.options.timeoutMs ?? 15000);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      editor.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  /** Opens a drawing file: into the live editor when connected, else as the headless document. */
  async openFile(path: string): Promise<{ file: string; objects: number }> {
    const file = resolve(path);
    const text = await readFile(file, 'utf8');
    await this.call('loadDocument', { data: text });
    this.file = file;
    const summary = (await this.call('summary')) as { objects: Record<string, number> };
    return { file, objects: Object.values(summary.objects).reduce((a, b) => a + b, 0) };
  }

  /** Writes the current drawing (live or headless) to a file; defaults to the opened file. */
  async saveFile(path?: string): Promise<{ file: string }> {
    const file = path ? resolve(path) : this.file;
    if (!file) throw new ApiError('저장할 파일 경로가 없습니다. path를 지정하십시오.');
    const data = await this.call('getDocument');
    await writeFile(file, serialize(data as never), 'utf8');
    this.file = file;
    return { file };
  }

  /** Starts an empty drawing (headless or live). */
  async newDrawing(): Promise<{ ok: true }> {
    const blank = new DocumentModel().toData();
    await this.call('loadDocument', { data: blank });
    return { ok: true };
  }

  status() {
    return {
      target: this.editor ? '브라우저 편집기 (실시간)' : '헤드리스 문서',
      editorConnected: this.connected,
      file: this.file ?? null,
      autosave: this.options.autosave !== false,
    };
  }

  private async save(): Promise<void> {
    await writeFile(this.file!, serialize(this.doc.toData()), 'utf8');
  }
}
