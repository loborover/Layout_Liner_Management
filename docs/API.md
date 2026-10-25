# 편집 API와 MCP

AI와 스크립트가 편집기를 조작하는 방법입니다. 메서드는 하나의 표([`src/api/rpc.ts`](../src/api/rpc.ts)의 `METHODS`)에서 정의되고, 네 가지 전송 방식이 모두 그 표를 씁니다. 메서드별 매개변수는 자동 생성된 [API-METHODS.md](API-METHODS.md)를 보십시오.

| 전송 방식 | 쓰는 곳 | 진입점 |
| --- | --- | --- |
| 브라우저 전역 객체 | 개발자 도구, 브라우저 자동화(Playwright 등) | `window.layoutLiner.call(method, params)` |
| MCP(stdio) | Claude Code, Claude Desktop 등 MCP 클라이언트 | `npm run mcp` ([`mcp/server.ts`](../mcp/server.ts)) |
| HTTP JSON-RPC 2.0 | 스크립트, MCP가 아닌 도구 | `POST http://127.0.0.1:7820/rpc` |
| 실시간 브리지(WebSocket) | MCP 서버 → 열려 있는 편집기 탭 | 편집기 리본 "AI·API" 탭의 **AI 연결** |

## 공통 규칙

- 좌표와 길이는 mm, Y축은 위쪽, 각도는 도(반시계)입니다. 좌표는 `[x, y]` 또는 `{x, y}`로 줍니다.
- 새 객체는 **활성 층**의 현재 레이어(또는 `layer` 매개변수)에 그려집니다. 다른 층에 그리려면 먼저 `setActiveFloor`를 부르십시오.
- 변경 메서드 한 번은 실행 취소 한 단계입니다. 여러 호출을 한 단계로 묶으려면 `batch`를 쓰십시오. 중간에 하나라도 실패하면 전부 되돌립니다.
- 새 끝점이 같은 층의 기존 점과 0.5 mm 안에 있으면 그 점에 연결됩니다(공유 점).
- 오류는 한국어 메시지로 돌아옵니다(`ApiError`). 뷰어 모드인 편집기에서는 변경 메서드가 거부됩니다.
- 점 좌표 `z`는 층 바닥에서의 높이(mm, 위쪽)입니다. `setPoint`로 X·Y·Z를(선의 중간점 `middle.id`를 주면 선 전체가 이동), `updateEntity`의 `height`로 객체 높이를 고칩니다(`null`이면 기본값). 구속이 걸린 점의 X·Y는 API에서 바꿀 수 없습니다.
- `addPoint`는 독립 점 객체를 놓습니다. 높이(`height`)의 기본값은 모두 0입니다.
- `scene3d`는 3D 장면(입체와 3D 선, mm, Z 위쪽)을 돌려줍니다. 호스트 서버에서 렌더링·변환할 때 씁니다([VIEW3D.md](VIEW3D.md)).
- 작업 전에 `summary`를 먼저 불러 층·레이어·라이브러리 id를 확인하는 것을 권합니다.

## 1. 브라우저에서

```js
const { call, methods } = window.layoutLiner;
call('addRectangle', { x: 0, y: 0, width: 12000, height: 8000 });           // 방(선 4개 + 도형)
call('setStroke', { ids: ['…선 id…'], stroke: { width: 200, align: 'inside' } }); // 벽 두께
call('placeEquipment', { type: 'st-stair', x: 2000, y: 3000 });               // 계단 프리셋
Object.keys(methods);                                                          // 메서드 목록
```

## 2. MCP 서버

```bash
npm run mcp -- --file drawing.json   # 헤드리스로 drawing.json을 편집하고 자동 저장
```

| 옵션 | 기본값 | 설명 |
| --- | --- | --- |
| `--file <경로>` | 없음 | 시작할 때 열 도면. 변경할 때마다 자동 저장합니다. |
| `--no-autosave` | | 자동 저장을 끕니다(`save_file`로 저장). |
| `--port <번호>` | 7820 | 브리지 WebSocket과 HTTP JSON-RPC 포트(127.0.0.1에서만 열림). |
| `--no-bridge` | | 브리지와 HTTP를 열지 않습니다. |

저장소 루트의 [`.mcp.json`](../.mcp.json)이 Claude Code에 이 서버를 등록합니다. 다른 클라이언트(예: Claude Desktop)에서는 `command: "npx"`, `args: ["tsx", "<저장소 경로>/mcp/server.ts", "--file", "<도면 경로>"]`로 등록하십시오.

### 도구

- `METHODS`의 모든 메서드가 같은 이름의 도구가 됩니다. 변경하지 않는 메서드에는 `readOnlyHint` 주석이 붙습니다.
- 파일 도구: `open_file(path)`, `save_file(path?)`, `new_drawing()`, `bridge_status()`.

### 편집 대상 고르기 (라우터)

[`mcp/router.ts`](../mcp/router.ts)가 호출을 보낼 곳을 정합니다.

1. 편집기 탭이 브리지에 연결되어 있으면 **그 탭**으로 보냅니다. 사용자가 화면에서 바로 보고, 브라우저에서 실행 취소할 수 있습니다. 응답이 15초 안에 오지 않으면 오류입니다.
2. 연결된 탭이 없으면 서버 안의 **헤드리스 도면**을 편집하고, `--file`이 있으면 자동 저장합니다.

편집기를 연결하는 방법: `npm run dev`로 편집기를 열고 → 리본 **AI·API** 탭 → 주소 `ws://127.0.0.1:7820` 확인 → **AI 연결**.

## 3. HTTP JSON-RPC

```bash
curl -s http://127.0.0.1:7820/rpc -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"summary","params":{}}'
curl -s http://127.0.0.1:7820/status   # 편집 대상과 연결 상태
```

요청에는 `Content-Type: application/json`이 필요합니다. 브라우저에서 보낸 요청은 `localhost`/`127.0.0.1` 출처(또는 환경 변수 `LAYOUT_LINER_ALLOW_ORIGIN`에 지정한 출처)만 받고, 그 밖의 출처는 403으로 거부합니다. 다른 웹 페이지가 도면을 몰래 바꾸거나 덮어쓰지 못하게 하기 위해서입니다.

응답은 `{"jsonrpc":"2.0","id":1,"result":…}` 또는 `{"jsonrpc":"2.0","id":1,"error":{"code":…,"message":"…"}}`입니다. 라우팅은 MCP와 같습니다.

## 4. 브리지 프로토콜 (참고)

- 편집기가 연결되면 먼저 `{"type":"hello","app":"layout-liner-editor"}`를 보냅니다.
- 서버는 JSON-RPC 요청 `{"jsonrpc":"2.0","id":…,"method":…,"params":…}`을 보내고, 편집기는 같은 `id`의 JSON-RPC 응답을 돌려줍니다.
- 브리지는 `localhost`/`127.0.0.1` 출처의 페이지만 받습니다. 원격에서 쓰려면 별도의 인증 계층을 먼저 설계하십시오.

## 메서드를 추가하거나 바꿀 때

1. [`src/api/editorApi.ts`](../src/api/editorApi.ts)에 구현합니다(DOM을 쓰지 말고 명령으로 편집).
2. [`src/api/rpc.ts`](../src/api/rpc.ts)의 `METHODS`에 설명과 JSON Schema를 추가합니다. MCP 도구는 자동으로 생깁니다.
3. `npm run docs:api`로 [API-METHODS.md](API-METHODS.md)를 다시 만듭니다(오래되면 `tests/api.test.ts`가 실패합니다).
4. `tests/api.test.ts`에 테스트를 추가합니다.
