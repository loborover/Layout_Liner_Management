/**
 * @file rpc.ts
 *
 * Method table of the editing API: name, description and JSON Schema of the parameters for every EditorApi
 * call. It is the single source of truth for every transport:
 * - `dispatch()` runs a call (browser `layoutLiner.call`, the MCP bridge, HTTP JSON-RPC);
 * - mcp/server.ts turns each entry into an MCP tool;
 * - docs/API.md documents the same list.
 * To add a method: implement it in EditorApi, add an entry here, update docs/API.md and tests/api.test.ts.
 */
import { ApiError, type EditorApi } from './editorApi';

type Schema = Record<string, unknown>;

export interface MethodSpec {
  description: string;
  params: Schema;
  /** Changes the drawing (an MCP client may ask before running it). */
  mutates: boolean;
  run: (api: EditorApi, params: Record<string, unknown>, call: (method: string, params: unknown) => unknown) => unknown;
}

const num = (description: string): Schema => ({ type: 'number', description });
const str = (description: string): Schema => ({ type: 'string', description });
const xy: Schema = {
  description: '좌표 [x, y] 또는 {x, y} (mm, Y 위쪽)',
  oneOf: [
    { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
    { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
  ],
};
const ids: Schema = { type: 'array', items: { type: 'string' }, minItems: 1, description: '객체 id 목록' };
const stroke: Schema = {
  type: ['object', 'null'],
  description: '선 양식. width(mm, 0=가는 선), align(center|inside|outside: 그린 선 기준 띠 위치), color(#rrggbb). null이면 지움',
  properties: { width: { type: 'number', minimum: 0 }, align: { enum: ['center', 'inside', 'outside'] }, color: { type: 'string' } },
};
const obj = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: 'object', properties, required, additionalProperties: false });

/** Every API method. Keep descriptions in Korean+English terms an AI can map to the UI. */
export const METHODS: Record<string, MethodSpec> = {
  summary: {
    description: '도면 개요: 층·폴더·레이어(객체 수), 객체 종류별 수, 라이브러리(설비·구조 종류), 범위. 작업 전에 먼저 호출하십시오.',
    params: obj({}),
    mutates: false,
    run: (api) => api.summary(),
  },
  getDocument: {
    description: '도면 전체를 파일 형식(JSON, docs/DATA_MODEL.md)으로 반환합니다.',
    params: obj({}),
    mutates: false,
    run: (api) => api.getDocument(),
  },
  loadDocument: {
    description: '도면 전체를 교체합니다(파일 열기와 같은 검증). 실행 취소 기록이 지워집니다.',
    params: obj({ data: { description: '도면 JSON 객체 또는 문자열' } }, ['data']),
    mutates: true,
    run: (api, p) => api.loadDocument(p as never),
  },
  listEntities: {
    description: '객체 목록(좌표·길이·면적·검토 결과 포함). floor, layer, kind로 거를 수 있습니다.',
    params: obj({
      floor: str('층 id'),
      layer: str('레이어 id'),
      kind: { enum: ['line', 'circle', 'dimension', 'equipment', 'shape'] },
      limit: num('최대 개수 (기본 500, 최대 5000)'),
    }),
    mutates: false,
    run: (api, p) => api.listEntities(p as never),
  },
  getEntity: {
    description: '객체 하나의 상세 정보.',
    params: obj({ id: str('객체 id') }, ['id']),
    mutates: false,
    run: (api, p) => api.getEntity(p as never),
  },
  addLines: {
    description: '점들을 잇는 연속 선을 그립니다. closed=true면 닫고 도형(면)을 만듭니다. 기존 끝점과 0.5 mm 안이면 연결됩니다.',
    params: obj(
      {
        points: { type: 'array', items: xy, minItems: 2 },
        closed: { type: 'boolean' },
        layer: str('레이어 id (생략 시 현재 레이어)'),
        stroke,
        name: str('도형 이름 (closed일 때)'),
        fill: str('도형 채우기 색 #rrggbb (closed일 때)'),
      },
      ['points'],
    ),
    mutates: true,
    run: (api, p) => api.addLines(p as never),
  },
  addRectangle: {
    description: '왼쪽 아래 모서리 (x, y)에서 width×height 사각형(선 4개 + 도형)을 그립니다. 방·구역에 쓰십시오.',
    params: obj(
      { x: num('mm'), y: num('mm'), width: num('mm'), height: num('mm'), layer: str('레이어 id'), stroke, name: str('도형 이름'), fill: str('#rrggbb') },
      ['x', 'y', 'width', 'height'],
    ),
    mutates: true,
    run: (api, p) => api.addRectangle(p as never),
  },
  addCircle: {
    description: '원을 그립니다.',
    params: obj({ x: num('중심 mm'), y: num('중심 mm'), radius: num('mm'), layer: str('레이어 id'), name: str('이름') }, ['x', 'y', 'radius']),
    mutates: true,
    run: (api, p) => api.addCircle(p as never),
  },
  addDimension: {
    description: '두 점 사이 정렬 치수를 추가합니다. 기존 끝점에 붙으면 형상을 따라 값이 바뀝니다.',
    params: obj({ from: xy, to: xy, offset: num('치수선 간격 mm (왼쪽 +)'), layer: str('레이어 id') }, ['from', 'to']),
    mutates: true,
    run: (api, p) => api.addDimension(p as never),
  },
  placeEquipment: {
    description: '설비 또는 구조 프리셋(기둥·계단·경사로·리프트)을 중심 (x, y)에 배치합니다. type은 라이브러리 id나 이름.',
    params: obj(
      {
        type: str('종류 id 또는 이름 (예: st-stair, 계단)'),
        x: num('mm'),
        y: num('mm'),
        rotation: num('도, 반시계'),
        tag: str('번호 (생략 시 자동)'),
        layer: str('레이어 id'),
        props: { type: 'object', description: '프리셋 특성 (presetSchema 참고)' },
        name: str('이름'),
        binding: str('모니터링 키'),
      },
      ['type', 'x', 'y'],
    ),
    mutates: true,
    run: (api, p) => api.placeEquipment(p as never),
  },
  updateEntity: {
    description: '객체 속성 변경: name, layer, binding(모니터링 키), stroke(선), fill(도형), tag/rotation/props(설비·구조), radius(원). null은 지움.',
    params: obj(
      {
        id: str('객체 id'),
        name: { type: ['string', 'null'] },
        layer: str('같은 층의 레이어 id'),
        binding: { type: ['string', 'null'] },
        stroke,
        fill: { type: ['string', 'null'] },
        tag: { type: 'string' },
        rotation: { type: 'number' },
        radius: { type: 'number' },
        props: { type: ['object', 'null'] },
      },
      ['id'],
    ),
    mutates: true,
    run: (api, p) => api.updateEntity(p as never),
  },
  setStroke: {
    description: '선과 도형의 변에 선 양식(벽 두께 등)을 지정합니다. stroke=null이면 지웁니다.',
    params: obj({ ids, stroke }, ['ids', 'stroke']),
    mutates: true,
    run: (api, p) => api.setStroke(p as never),
  },
  moveEntities: {
    description: '객체를 (dx, dy)만큼 옮깁니다. 공유된 점에 연결된 형상도 따라 움직입니다.',
    params: obj({ ids, dx: num('mm'), dy: num('mm') }, ['ids', 'dx', 'dy']),
    mutates: true,
    run: (api, p) => api.moveEntities(p as never),
  },
  rotateEntities: {
    description: '90° 단위로 회전합니다. 설비만 선택하면 제자리 회전입니다.',
    params: obj({ ids, angle: num('90의 배수, 기본 90') }, ['ids']),
    mutates: true,
    run: (api, p) => api.rotateEntities(p as never),
  },
  copyEntities: {
    description: '객체를 (dx, dy)만큼 떨어뜨려 복사합니다. columns·rows를 주면 그 간격의 배열 복사입니다.',
    params: obj({ ids, dx: num('mm'), dy: num('mm'), columns: num('열 수'), rows: num('행 수') }, ['ids', 'dx', 'dy']),
    mutates: true,
    run: (api, p) => api.copyEntities(p as never),
  },
  deleteEntities: {
    description: '객체를 삭제합니다. 도형은 변 선과 함께, 선은 그 선을 쓰는 도형과 함께 지워집니다.',
    params: obj({ ids }, ['ids']),
    mutates: true,
    run: (api, p) => api.deleteEntities(p as never),
  },
  makeShapes: {
    description: '선들 중 닫힌 고리를 도형(면)으로 만듭니다.',
    params: obj({ lineIds: ids, name: str('도형 이름') }, ['lineIds']),
    mutates: true,
    run: (api, p) => api.makeShapes(p as never),
  },
  reorder: {
    description: '그리기 순서(트리 순서) 변경: front(맨 앞), back(맨 뒤), forward, backward.',
    params: obj({ ids, move: { enum: ['front', 'back', 'forward', 'backward'] } }, ['ids', 'move']),
    mutates: true,
    run: (api, p) => api.reorder(p as never),
  },
  addFloor: {
    description: '층을 추가합니다(레이어 "0" 포함). elevation 생략 시 가장 높은 층 위.',
    params: obj({ name: str('예: 2층'), elevation: num('바닥 높이 mm'), height: num('층고 mm') }, ['name']),
    mutates: true,
    run: (api, p) => api.addFloor(p as never),
  },
  setActiveFloor: {
    description: '표시·편집할 층을 바꿉니다. 이후 새 객체는 이 층에 그려집니다.',
    params: obj({ floor: str('층 id') }, ['floor']),
    mutates: false,
    run: (api, p) => api.setActiveFloor(p as never),
  },
  addFolder: {
    description: '층 안에 레이어를 묶는 폴더를 추가합니다.',
    params: obj({ name: str('폴더 이름'), floor: str('층 id (생략 시 현재 층)') }, ['name']),
    mutates: true,
    run: (api, p) => api.addFolder(p as never),
  },
  addLayer: {
    description: '레이어를 추가합니다. folder를 주면 그 폴더(와 층)에 들어갑니다.',
    params: obj({ name: str('레이어 이름'), floor: str('층 id'), folder: str('폴더 id'), color: str('#rrggbb') }, ['name']),
    mutates: true,
    run: (api, p) => api.addLayer(p as never),
  },
  updateLayer: {
    description: '레이어 이름·색·표시·잠금·폴더 변경. folder=null이면 폴더에서 뺍니다.',
    params: obj(
      { id: str('레이어 id'), name: { type: 'string' }, color: { type: 'string' }, visible: { type: 'boolean' }, locked: { type: 'boolean' }, folder: { type: ['string', 'null'] } },
      ['id'],
    ),
    mutates: true,
    run: (api, p) => api.updateLayer(p as never),
  },
  addEquipmentType: {
    description: '라이브러리에 설비 종류나 구조 프리셋(category: column|stair|ramp|lift)을 추가합니다.',
    params: obj(
      {
        name: str('이름'),
        width: num('mm'),
        depth: num('mm'),
        prefix: str('번호 접두어'),
        category: { enum: ['equipment', 'column', 'stair', 'ramp', 'lift'] },
        props: { type: 'object' },
      },
      ['name', 'width', 'depth'],
    ),
    mutates: true,
    run: (api, p) => api.addEquipmentType(p as never),
  },
  presetSchema: {
    description: '구조 프리셋 범주별 특성 정의(키, 단위, 선택지, 기본값).',
    params: obj({}),
    mutates: false,
    run: (api) => api.presetSchema(),
  },
  undo: { description: '실행 취소.', params: obj({}), mutates: true, run: (api) => api.undo() },
  redo: { description: '다시 실행.', params: obj({}), mutates: true, run: (api) => api.redo() },
  batch: {
    description: '여러 호출을 한 번의 실행 취소 단계로 묶어 실행합니다. 하나라도 실패하면 모두 되돌립니다.',
    params: obj(
      { calls: { type: 'array', items: { type: 'object', properties: { method: { type: 'string' }, params: { type: 'object' } }, required: ['method'] } } },
      ['calls'],
    ),
    mutates: true,
    run: (api, p, call) => api.batch(p as never, call),
  },
  exportSvg: { description: '보이는 층을 SVG 문자열로 내보냅니다.', params: obj({}), mutates: false, run: (api) => api.exportSvg() },
  exportDxf: { description: '도면을 DXF R12 문자열로 내보냅니다.', params: obj({}), mutates: false, run: (api) => api.exportDxf() },
  exportEquipmentCsv: { description: '설비 목록 CSV 문자열.', params: obj({}), mutates: false, run: (api) => api.exportEquipmentCsv() },
};

export interface RpcError {
  code: number;
  message: string;
}

/** Runs one method. Throws ApiError for unknown methods or invalid input. */
export function dispatch(api: EditorApi, method: string, params: unknown = {}): unknown {
  const spec = Object.hasOwn(METHODS, method) ? METHODS[method] : undefined;
  if (!spec) throw new ApiError(`알 수 없는 메서드입니다: ${method}. 사용 가능: ${Object.keys(METHODS).join(', ')}`);
  if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
    throw new ApiError('params는 객체여야 합니다.');
  }
  // Nested batches would make undo grouping ambiguous.
  const inner = (m: string, p: unknown) => {
    if (m === 'batch') throw new ApiError('batch 안에 batch를 넣을 수 없습니다.');
    return dispatch(api, m, p);
  };
  return spec.run(api, (params ?? {}) as Record<string, unknown>, inner);
}

/** JSON-RPC 2.0 handling shared by the bridge and the HTTP endpoint. */
export function handleJsonRpc(api: EditorApi, msg: { id?: unknown; method?: unknown; params?: unknown }) {
  try {
    if (typeof msg.method !== 'string') throw new ApiError('method가 없습니다.');
    return { jsonrpc: '2.0', id: msg.id ?? null, result: dispatch(api, msg.method, msg.params) };
  } catch (err) {
    const error: RpcError = err instanceof ApiError ? { code: -32602, message: err.message } : { code: -32603, message: String(err) };
    return { jsonrpc: '2.0', id: msg.id ?? null, error };
  }
}
