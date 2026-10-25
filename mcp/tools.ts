/**
 * @file tools.ts
 *
 * MCP tool definitions, generated from the API method table (src/api/rpc.ts) so tools never drift from the
 * API, plus the file/bridge tools that only exist in the MCP server.
 */
import { METHODS } from '../src/api/rpc';

export const FILE_TOOLS: Record<string, { description: string; inputSchema: Record<string, unknown> }> = {
  open_file: {
    description: '도면 파일(.json)을 엽니다. 브라우저 편집기가 연결되어 있으면 그 화면에 엽니다.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: '파일 경로' } }, required: ['path'] },
  },
  save_file: {
    description: '현재 도면을 파일(.json)로 저장합니다. path를 생략하면 연 파일에 저장합니다.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
  new_drawing: { description: '빈 도면으로 시작합니다.', inputSchema: { type: 'object', properties: {} } },
  bridge_status: {
    description: '편집 대상(브라우저 실시간 편집기 또는 헤드리스 파일)과 연결 상태.',
    inputSchema: { type: 'object', properties: {} },
  },
};

export function toolList() {
  return [
    ...Object.entries(METHODS).map(([name, m]) => ({
      name,
      description: m.description,
      inputSchema: m.params,
      annotations: { readOnlyHint: !m.mutates, destructiveHint: name === 'deleteEntities' || name === 'loadDocument' },
    })),
    ...Object.entries(FILE_TOOLS).map(([name, t]) => ({ name, ...t })),
  ];
}
