# 아키텍처

이 문서는 코드를 고치기 전에 읽는 지도입니다. 파일 하나하나의 목적은 각 파일 첫 줄의 `@file` 주석에 있고, 여기서는 모듈 사이의 관계와 데이터 흐름, 확장 지점을 설명합니다.

## 한눈에 보기

```
            ┌─────────────── index.html (편집기) ───────────────┐   ┌──── viewer.html (모니터링 앱) ────┐
 사용자 ──▶ │ ui/ (리본, 사이드바, 트리, 속성)  ◀─ App(src/app.ts) │   │ viewer/main.ts ◀─ viewer/sources │ ◀── 호스트 서버
            │ tools/ (그리기·선택·측정·뷰어 클릭)   │             │   │   (WebSocket / REST / 모의)       │     (값)
            └──────────────┬────────────────────────┼─────────────┘   └──────────────┬───────────────────┘
                           ▼                        ▼                                 ▼
                 model/ (DocumentModel, Command, History, SpatialIndex)  ◀── 같은 모델·렌더러 재사용
                           │            ▲                 ▲
                           ▼            │                 │
                 view/ (Viewport, Renderer)   constraints/ (planegcs)   io/ (JSON, DXF, SVG, CSV)
                 view3d/ (three.js, 필요할 때만 로딩) ◀─ model/scene3d.ts (3D 장면, DOM 없음)
                           ▲
 AI ──▶ MCP(mcp/server.ts) ─┬─▶ 실시간 브리지(ws) ─▶ 브라우저의 api/ (EditorApi + METHODS 표)
                            └─▶ 헤드리스: 파일을 직접 편집 (같은 EditorApi)
```

## 계층과 규칙

| 계층 | 폴더 | DOM 사용 | 역할 |
| --- | --- | --- | --- |
| 기하 | `src/geom/` | 금지 | 벡터, 교차, 다각형, 치수·설비 외곽 계산. 순수 함수. |
| 모델 | `src/model/` | 금지 | 도면 데이터(`DocumentModel`), 명령(`Command`)과 실행 취소(`History`), 공간 색인, 편집 연산(복사·배열·도형 찾기), 선 양식 띠 계산, 구조 프리셋. |
| 구속 | `src/constraints/` | 금지 | planegcs(WebAssembly) 기반 2D 구속 해석. |
| 입출력 | `src/io/` | 금지(파일 선택 UI 제외) | JSON 직렬화·검증·버전 변환, DXF 가져오기/내보내기, SVG, 설비 CSV. |
| API | `src/api/` | 금지(bridge.ts의 WebSocket 제외) | AI와 스크립트용 편집 API. |
| 화면 | `src/view/` | Canvas | 화면 좌표 변환(`Viewport`), 그리기(`Renderer`). |
| 3D 화면 | `src/view3d/` | WebGL | `scene3d`를 three.js로 그리는 위·정면·측면·등각·4분할 보기. 3D 보기를 처음 열 때 `import()`로 불러와 평면 편집기는 가볍게 유지됩니다. `mesh.ts`는 DOM 없이 버퍼만 만듭니다. |
| 테마 | `src/theme.ts` | 없음 | 색 디자인 토큰(Ink wash 팔레트)의 단일 원천. CSS 변수, 캔버스, 3D, 뷰어가 모두 여기서 색을 가져옵니다. |
| 도구 | `src/tools/` | 포인터 이벤트만 | 마우스 입력 → 명령. 도구는 `ToolContext`만 통해 앱과 대화합니다. |
| UI | `src/ui/`, `src/app.ts` | 사용 | 리본, 사이드바, 트리, 속성 패널, 정보 카드. `App`이 모든 것을 묶습니다. |
| 뷰어 앱 | `src/viewer/` | 사용 | 읽기 전용 모니터링 페이지. |
| MCP | `mcp/` | 없음(Node) | MCP 서버, 라우터, HTTP JSON-RPC. |

DOM을 쓰지 않는 계층(geom, model, constraints, io, api)은 Node에서 그대로 실행되므로 테스트와 MCP 헤드리스 모드가 같은 코드를 씁니다. 이 경계를 지키십시오.

## 데이터 흐름

1. **편집은 항상 명령으로.** 도구·UI·API는 `Command`(`src/model/commands.ts`)를 만들어 `history.run()`에 넘깁니다. `DocumentModel`을 직접 바꾸면 실행 취소가 깨집니다. 여러 명령을 한 단계로 묶을 때는 `Batch`, 사후에 묶을 때는 `history.squash()`를 씁니다.
2. **변경 알림.** 명령이 실행되면 `doc.changed()`가 `rev`를 올리고 구독자(`doc.onChange`)를 부릅니다. 공간 색인(`SpatialIndex`)과 선 띠 계산(`StrokeGeometry`)은 `rev`가 바뀔 때만 다시 계산합니다.
3. **구속.** 구속이 걸린 형상을 끌거나 구동 치수 값을 바꾸면 `ConstraintService`(`src/constraints/service.ts`)가 planegcs로 나머지 점을 다시 풀고, 결과 형상을 실행 취소 가능한 명령(`SetGeometry` 등)으로 기록합니다.
4. **그리기.** `App.render()`가 requestAnimationFrame마다 한 번 `Renderer.render(state)`를 부릅니다. 순서: 밑그림 → 그리드 → 다른 층의 연결 구조(점선) → 도형 면 채움(그리기 순서대로) → 선(양식별로 묶어서) → 설비·구조 기호 → 치수 → 이름표 → 선택·호버 → 도구 미리보기.

## 핵심 개념

- **공유 점.** 선·치수·원·설비는 좌표 대신 점 id를 참조합니다. 두 선이 한 점을 공유하면 함께 움직입니다. 이것이 "점 → 선 → 면 → 도형" 계층의 바탕입니다.
- **도형(`shape`).** 닫힌 고리를 이루는 선들의 id(`edges`)와 점 id(`points`)를 가진 객체입니다. 선 도구로 시작점에 돌아오거나 사각형 도구를 쓰면 자동으로 생기고, 선택한 선에서 `makeShapes`로도 만듭니다. 도형을 지우면 변 선도, 선을 지우면 그 선을 쓰는 도형도 함께 지워집니다.
- **선 양식.** 그린 선은 기준선이고, `stroke.width` mm 띠를 안쪽·중앙·바깥쪽에 놓습니다. 안쪽은 도형 내부 방향(도형이 없으면 진행 방향의 왼쪽)입니다. 같은 양식의 이웃 선과는 마이터로 이어집니다(`src/model/strokes.ts`).
- **계층.** 층 > 폴더 > 레이어 > 객체. 활성 층만 보이고 편집됩니다. 폴더를 숨기거나 잠그면 안의 레이어가 모두 숨거나 잠깁니다. 판단은 `doc.isVisible(e)`, `doc.isEditable(e)` 한 곳에서 합니다.
- **그리기 순서 = 트리 순서.** `doc.entities`(Map)의 삽입 순서가 그리기 순서이자 객체 트리의 순서입니다. 순서 변경은 `ReorderEntities` 명령입니다.
- **구조 프리셋.** 기둥·계단·경사로·리프트는 `category`가 있는 설비 종류입니다. 특성 정의는 `PROP_DEFS`, 값은 객체 → 종류 → 기본값 순으로 찾습니다(`propValue`). 계단 단수, 경사로 기울기 같은 계산·검토는 `presetInfo`에 있습니다.
- **점 선택.** 선택(`Selection`)에는 객체 id와 함께 점 id도 들어갈 수 있습니다. 꼭짓점 위를 클릭하면 선보다 점이 먼저 선택되고(`SpatialIndex.pickPoint`), 점을 끌면 그 점을 쓰는 형상이 함께 움직입니다. 점을 지우면 그 점을 쓰는 객체가 지워집니다(`deletionTargets`). 점이 보이고 편집 가능한지는 `doc.isPointVisible`, `doc.isPointEditable`(점을 쓰는 객체 기준)이 판단합니다.
- **Ctrl 점 스냅과 닫힌 도형.** 선 도구에서 Ctrl(맥은 Cmd)을 누르면 스냅이 보이는 객체의 점만 잡습니다(`SnapQuery.pointsOnly`). 그 상태로 기존 점에 선을 이어 고리가 닫히면 `linePath`(선 그래프 최단 경로)로 고리를 찾아 도형을 만듭니다.
- **좌표와 높이.** 점은 X, Y와 층 바닥에서의 높이 Z를 가집니다. 속성 패널과 API `setPoint`로 고칩니다. X, Y는 구속이 있으면 구속 해석을 거쳐 옮기고(`ConstraintService.setPoint`), Z는 `SetPoints` 명령으로 바꿉니다. 객체의 높이는 `height`, 없으면 `src/model/heights.ts`의 기본값입니다.
- **3D 장면.** `buildScene`(`src/model/scene3d.ts`)이 문서를 입체(바닥 외곽선 + 꼭짓점별 아래·위 Z)와 3D 선으로 바꿉니다. 렌더러에 독립적이라 브라우저(`src/view3d/`)와 호스트 서버가 같은 결과를 씁니다. 무거운 도면은 API `scene3d`로 장면을 받아 서버에서 렌더링하거나 glTF 등으로 변환하는 것을 전제로 합니다([VIEW3D.md](VIEW3D.md)).
- **테마.** 색은 `src/theme.ts`에만 씁니다. `style.css`의 `:root` 변수는 `cssVariables()`와 같아야 하고 그 밖에는 색 값을 쓰지 않습니다(`tests/theme.test.ts`가 검사).
- **모드.** 편집 모드와 뷰어 모드(`App.setMode`). 뷰어 모드에서는 `InspectTool`만 쓰이고, 변경 API 호출이 막히며, `.edit-only` UI가 숨겨집니다.

## 확장 지점

| 하고 싶은 일 | 고칠 곳 |
| --- | --- |
| 새 객체 종류 | `model/types.ts` → `model/document.ts`(`pointIdsOf`, `bboxOf`) → `model/spatial.ts`(선택) → `view/renderer.ts` → `io/serialize.ts` → `io/svg.ts`, `io/dxfExport.ts` → `ui/properties.ts`, `ui/tree.ts` → `docs/DATA_MODEL.md` |
| 새 도구 | `tools/`에 `Tool` 구현 → `app.ts`의 도구 표 → `index.html` 리본 버튼(`data-tool`) |
| 새 구조 프리셋 범주 | `StructureCategory` → `PROP_DEFS`, `CATEGORY_LABELS`, `DEFAULT_STRUCTURE_TYPES` → `presetInfo` → `model/symbols.ts`의 평면 기호 |
| 새 API 메서드 | `api/editorApi.ts` → `api/rpc.ts`의 `METHODS` → `npm run docs:api` → `tests/api.test.ts` |
| 새 데이터 소스(뷰어) | `viewer/sources.ts`에 `DataSource` 구현 → `sourceFor` → `docs/VIEWER.md` |
| 새 3D 모양 | `model/scene3d.ts`(입체·선 만들기) → 필요하면 `model/heights.ts`의 기본 높이 → `tests/scene3d.test.ts` |
| 색 바꾸기 | `src/theme.ts` → `style.css`의 `:root`(테스트가 알려 줍니다) |
| 파일 형식 변경 | `docs/DATA_MODEL.md`의 "형식을 바꿀 때" 절 |

## 테스트

`npm test`(Vitest)는 모델·기하·입출력·API·뷰어 데이터 파싱을 Node에서 검사하고, `mcp/router.test.ts`는 MCP 라우터를 검사합니다. 화면은 Playwright로 스크린샷을 찍어 확인합니다(Chromium이 설치된 환경에서 `npm run dev` 후). `docs/API-METHODS.md`는 자동 생성 파일이며 오래되면 테스트가 실패합니다.
