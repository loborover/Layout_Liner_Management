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
| 원본 데이터 | `src/data/`, `gateway/` | 없음 | 객체가 외부 DB 레코드를 참조하는 읽기 전용 연결. `src/data/records.ts`는 참조 형식과 클라이언트(`RecordStore`), `gateway/`는 호스트에서 도는 Node 데이터 게이트웨이([DATA_SOURCES.md](DATA_SOURCES.md)). |

DOM을 쓰지 않는 계층(geom, model, constraints, io, api)은 Node에서 그대로 실행되므로 테스트와 MCP 헤드리스 모드가 같은 코드를 씁니다. 이 경계를 지키십시오.

## 데이터 흐름

1. **편집은 항상 명령으로.** 도구·UI·API는 `Command`(`src/model/commands.ts`)를 만들어 `history.run()`에 넘깁니다. `DocumentModel`을 직접 바꾸면 실행 취소가 깨집니다. 여러 명령을 한 단계로 묶을 때는 `Batch`, 사후에 묶을 때는 `history.squash()`를 씁니다.
2. **변경 알림.** 명령이 실행되면 `doc.changed()`가 `rev`를 올리고 구독자(`doc.onChange`)를 부릅니다. 공간 색인(`SpatialIndex`)과 선 띠 계산(`StrokeGeometry`)은 `rev`가 바뀔 때만 다시 계산합니다.
3. **구속.** 구속이 걸린 형상을 끌거나 구동 치수 값을 바꾸면 `ConstraintService`(`src/constraints/service.ts`)가 planegcs로 나머지 점을 다시 풀고, 결과 형상을 실행 취소 가능한 명령(`SetGeometry` 등)으로 기록합니다. 거리·각도 치수 구속(`distance`, `angle`)의 선택 규칙·측정·각도 방향·그리기 위치는 DOM 없는 `src/constraints/dimensions.ts` 한 곳에 있어 솔버, 렌더러, 선택 도구(값 더블클릭), 속성 패널이 같은 정의를 씁니다. 파라미터와 수식(`src/model/params.ts`, 직접 만든 파서로 `eval` 없음)은 구동 치수의 `expression`이 되고, `ConstraintService.setParameters`·`reapplyParameters`가 값을 다시 계산해 형상을 한 번에 풉니다. 외부 값(DB 등)은 `ConstraintService.functions`에 함수로 더합니다.
4. **그리기.** `App.render()`가 requestAnimationFrame마다 한 번 `Renderer.render(state)`를 부릅니다. 순서: 밑그림 → 그리드 → 다른 층의 연결 구조(점선) → 도형 면 채움(그리기 순서대로) → 선(양식별로 묶어서) → 설비·구조 기호 → 치수 → 이름표 → 선택·호버 → 도구 미리보기.

## 핵심 개념

- **공유 점과 일치 구속.** 선·치수·원·설비는 좌표 대신 점 id를 참조합니다. 두 선이 한 점을 공유하면 함께 움직입니다. 이것이 "점 → 선 → 면 → 도형" 계층의 바탕입니다. 다만 공유는 **한 객체 안**(한 번에 그린 연속 선, 도형과 그 변)에서만 기본입니다. 다른 객체의 점에서 그리기 시작하거나 끝내면 새 객체는 자기 점을 갖고 `coincident` 구속으로 묶여(`src/tools/draw.ts`), 함께 움직이되 구속 해제나 `분리`(`detachPoints`, `src/model/edit.ts`)로 떼어 낼 수 있습니다(2026-11-15 사용자 요청). Ctrl을 누르고 그리면 점을 공유합니다. 일치 구속이 있는 형상을 끌면 planegcs가 짝 점을 따라오게 풉니다(`p2p_coincident`).
- **테두리(Border)와 면.** 선·원의 `stroke`가 테두리입니다(두께·색·불투명도·줄무늬 패턴). 도형의 테두리는 변 선들의 테두리입니다. 줄무늬는 `stripePieces`(`src/model/borders.ts`)가 실제 mm로 계산하고, 캔버스는 띠로 잘라(clip) 칠하며 SVG는 `<pattern>`을 씁니다. 구역색·설비구역색·안전구역색 템플릿도 같은 파일에 있습니다. 도형의 면은 색 또는 내장 이미지와 면 전용 불투명도를 가집니다. 면은 자기 변의 띠 아래에 칠해집니다(`doc.paintOrder()`).
- **도형(`shape`).** 닫힌 고리를 이루는 선들의 id(`edges`)와 점 id(`points`)를 가진 객체입니다. 선 도구로 시작점에 돌아오거나 사각형 도구를 쓰면 자동으로 생기고, 선택한 선에서 `makeShapes`로도 만듭니다. 도형을 지우면 변 선도, 선을 지우면 그 선을 쓰는 도형도 함께 지워집니다.
- **선 양식.** 그린 선은 기준선이고, `stroke.width` mm 띠를 안쪽·중앙·바깥쪽에 놓습니다. 안쪽은 도형 내부 방향(도형이 없으면 진행 방향의 왼쪽)입니다. 같은 두께·위치의 이웃 선(점 공유 또는 같은 자리)과 만나는 모서리는 안쪽을 정확한 교점에서 자르고, 바깥쪽은 `stroke.join`(뾰족·라운드·모따기)으로 처리합니다. 그래서 안쪽 테두리는 뾰족한 모서리에서도 기준선 밖으로 나가지 않습니다(`src/model/strokes.ts`).
- **모서리·꼭짓점 편집.** 필렛·모따기·꼭짓점 추가/삭제는 `src/model/corners.ts`에 있고 각각 하나의 명령을 돌려줍니다. 필렛은 별도 호 객체 대신 약 10°마다 끊은 짧은 선들이라, 면적·테두리·3D·내보내기가 그대로 동작합니다. 리본 "그리기 > 모서리·꼭짓점", 도구 `vertex`, API `editCorner`·`insertVertex`·`removeVertex`. 속성 패널에는 두지 않습니다(속성 패널은 속성만, 연산은 리본; 2026-11-15 사용자 요청).
- **라벨.** 도형 라벨(`shape.label`)과 라벨 객체(`kind: 'label'`)의 배치·행 계산은 `src/model/labels.ts` 한 곳에 있어 캔버스·SVG·DXF·선택이 같은 자리를 씁니다. 도형 라벨은 기본으로 면적 중심(`polygonLabelPoint`, `src/geom/polygon.ts`)에 화면 크기 글자로, 라벨 객체는 도면 크기(mm) 글자로 그립니다. 도구 `label`(T).
- **계층.** 층 > 폴더 (> 폴더 …) > 레이어 > 객체. 폴더는 `parent`로 중첩됩니다(2026-11-15 사용자 요청, 예: 작업구역 > 협력사 > 회사별). 활성 층만 보이고 편집됩니다. 폴더를 숨기거나 잠그면 그 안이 깊이와 관계없이 모두 숨거나 잠깁니다(`doc.folderChain`). 판단은 `doc.isVisible(e)`, `doc.isEditable(e)` 한 곳에서 합니다. 폴더·레이어 옮기기와 삭제는 `src/model/layerTree.ts`(`moveFolder`, `moveLayer`, `removeFolder`)가 트리 사본을 고치고, `layerTreeCommand`(`src/model/edit.ts`)가 `SetLayerTree`로 기록합니다. 레이어가 다른 층으로 가면 그 객체가 남는 객체와 공유하던 점을 나누고 두 층에 걸칠 일치 구속을 지우는 것도 같은 실행 취소 단계에 넣습니다. 폴더를 지우면 안의 것은 한 단계 위로 올라갑니다.
- **이름과 id.** 폴더·레이어 이름은 겹쳐도 되고, 구분은 id로 합니다(파일에서 중복 id는 거부). 사람에게는 `doc.treePath(id)`("1층 / 작업구역 / 협력사 / A사")를 트리 툴팁, 속성 패널의 레이어 목록, API `summary`의 `path`로 보여 줍니다.
- **객체 트리는 부모 아래에 한 번만.** 객체는 바로 위 부모 아래에만 나옵니다. 도형의 변은 도형 아래에 나오고 레이어 바로 아래에는 다시 나오지 않습니다(변이 도형과 다른 레이어에 있으면 그 레이어에 나옴). 폴더는 현재 레이어를 품고 있을 때만 처음부터 펼쳐져 폴더가 많아도 트리가 짧습니다.
- **그리기 순서 = 트리 순서.** `doc.entities`(Map)의 삽입 순서가 그리기 순서이자 객체 트리의 순서입니다. 순서 변경은 `ReorderEntities` 명령입니다.
- **구조 프리셋.** 기둥·계단·경사로·리프트는 `category`가 있는 설비 종류입니다. 기둥은 리본 "삽입 > 기둥 생성기"(`columnTypeFor`, API `placeColumn`)로 단면(사각·원형·H형강)과 크기를 정해 놓으며, 같은 종류가 있으면 재사용합니다. 기둥 평면 외곽(H형강 포함)은 `planSymbol(...).polygon`이 SVG·DXF·3D에 공통으로 줍니다. 특성 정의는 `PROP_DEFS`, 값은 객체 → 종류 → 기본값 순으로 찾습니다(`propValue`). 계단 단수, 경사로 기울기 같은 계산·검토는 `presetInfo`에 있습니다.
- **점은 객체입니다.** 선은 시작점·중간점·끝점과 선의 묶음(Assembly)입니다. 시작점·끝점은 저장된 점, 중간점은 계산되는 점(`midpointId(lineId)`, `doc.vertex`, `doc.vertexPoints`)이며, 셋 모두 클릭·트리·API로 선택하고 좌표를 고칠 수 있습니다. 중간점을 옮기면 두 끝점이 함께 움직여 선 전체가 이동합니다. 홀로 있는 점은 점 객체(`kind: 'point'`, 점 도구 P)로 레이어에 놓입니다.
- **점 선택.** 선택(`Selection`)에는 객체 id와 함께 점 id(중간점 포함, `doc.isVertex`)도 들어갈 수 있습니다. 꼭짓점 위를 클릭하면 선보다 점이 먼저 선택되고(`SpatialIndex.pickPoint`), 점을 끌면 그 점을 쓰는 형상이 함께 움직입니다. 점을 지우면 그 점을 쓰는 객체가 지워집니다(`deletionTargets`). 점이 보이고 편집 가능한지는 `doc.isPointVisible`, `doc.isPointEditable`(점을 쓰는 객체 기준)이 판단합니다.
- **Ctrl 점 스냅과 닫힌 도형.** 선 도구에서 Ctrl(맥은 Cmd)을 누르면 스냅이 보이는 객체의 점만 잡습니다(`SnapQuery.pointsOnly`). 그 상태로 기존 점에 선을 이어 고리가 닫히면 `linePath`(선 그래프 최단 경로)로 고리를 찾아 도형을 만듭니다.
- **좌표와 높이.** 점은 X, Y와 층 바닥에서의 높이 Z를 가집니다. 속성 패널과 API `setPoint`로 고칩니다. X, Y는 구속이 있으면 구속 해석을 거쳐 옮기고(`ConstraintService.setPoint`), Z는 `SetPoints` 명령으로 바꿉니다. 객체의 높이는 `height`이며 기본값은 0입니다(`src/model/heights.ts`).
- **3D 장면.** `buildScene`(`src/model/scene3d.ts`)이 문서를 입체(바닥 외곽선 + 꼭짓점별 아래·위 Z)와 3D 선으로 바꿉니다. 렌더러에 독립적이라 브라우저(`src/view3d/`)와 호스트 서버가 같은 결과를 씁니다. 무거운 도면은 API `scene3d`로 장면을 받아 서버에서 렌더링하거나 glTF 등으로 변환하는 것을 전제로 합니다([VIEW3D.md](VIEW3D.md)).
- **테마.** 색은 `src/theme.ts`에만 씁니다. `style.css`의 `:root` 변수는 `cssVariables()`와 같아야 하고 그 밖에는 색 값을 쓰지 않습니다(`tests/theme.test.ts`가 검사).
- **밑그림 선택.** 밑그림 이미지는 객체가 아니지만 선택 id `UNDERLAY_ID`로 선택 도구에서 객체처럼 클릭·끌기·Delete가 됩니다(객체가 없는 곳을 클릭할 때만). 잠그면(`underlay.locked`) 선택되지 않습니다. 위치·크기·투명도는 속성 패널에서 고칩니다.
- **복사와 이름.** 복사(배열 복사, Alt/Ctrl+Alt+드래그, 객체 트리 Alt+끌기)는 모두 `duplicateItems`(`src/model/edit.ts`)를 거칩니다. 복사본은 원본의 속성(테두리, 면, 라벨, 높이, 바인딩 등)을 그대로 갖고, 이름이 있으면 `uniqueName`으로 "이름 (2)"처럼 도면 전체에서 겹치지 않는 이름을 받습니다. 설비 번호도 새로 매깁니다.
- **수정자 드래그.** 선택 도구는 포토샵 이동 도구처럼 Ctrl+드래그(누른 곳과 관계없이, 다른 객체 위에서 눌러도 선택 이동; 끌지 않고 Ctrl+클릭하면 그 객체 선택), Alt 또는 Ctrl+Alt+드래그(복사본을 만들어 이동, 취소하면 복사본도 사라짐), 드래그 중 Shift(수평·수직 고정)를 지원합니다(`src/tools/select.ts`). 그리기 도구에서 Ctrl은 계속 "점 공유"입니다.
- **객체 트리 끌어 놓기.** 객체 행을 레이어·폴더·층 행에 놓으면 `transferItems`로 옮기고 Alt를 누르면 `duplicateItems`로 복사합니다. 폴더·층은 `layerForDrop`이 정한 레이어(현재 레이어가 그 안에 있으면 그것, 아니면 첫 레이어)로 갑니다. 다른 층으로 옮기면 남는 객체와 공유하던 점을 나누고, 두 층에 걸치게 될 일치 구속을 지웁니다.
- **속성 패널 편집은 id로.** 명령은 객체를 새 객체로 바꾸므로 패널을 만들 때 잡아 둔 객체는 낡을 수 있습니다. 패널의 변경은 `editEntities`로 문서의 현재 객체를 고칩니다(낡은 사본을 고치면 그 사이의 변경, 예컨대 라벨 항목이 사라지던 버그). 입력 중이라 미뤄 둔 다시 그리기는 포커스가 패널 입력란을 떠날 때 합니다.
- **눈금자.** `Renderer.showRulers`가 켜지면 위·왼쪽 가장자리에 눈금자를 그리고 큰 격자선마다 원점(0,0)에서의 거리를 적습니다(`rulerTicks`, `rulerUnit`, `src/view/viewport.ts`). 단위는 큰 격자 간격이 정수가 되는 가장 큰 단위(mm·cm·m)로 모서리에 표시합니다. 표시 여부는 보기 탭 "눈금자"이며 브라우저에 기억합니다.
- **축척 표시.** 캔버스 왼쪽 아래에 축척 막대(1-2-5 단위 길이)와 화면 축척 근삿값 1:N(96 px/inch 기준)을 그립니다(`scaleBarLength`, `screenScaleRatio`, `src/view/viewport.ts`). SVG·인쇄에는 항상 축척 막대가 들어가고, 파일 탭에서 1:50~1:1000을 고르면 그 축척 크기로 출력하며 축척 값을 적습니다.
- **좁은 화면과 터치.** 720 px 이하에서는 빠른 실행 바와 리본이 한 줄 가로 스크롤이 되고, 사이드바는 캔버스 아래 시트가 됩니다(`src/style.css` 끝의 반응형 규칙). 터치는 손가락을 떼거나 움직일 때까지 도구에 넘기지 않아, 두 번째 손가락이 닿으면 그리기 대신 두 손가락 확대·이동이 됩니다(`App.bindCanvas`).
- **원본 데이터 연결.** 객체의 `record`(`{ dataset, key? }`)는 데이터 게이트웨이의 레코드를 가리킵니다. 브라우저는 `RecordStore`(`src/data/records.ts`)로 `/data/`(Nginx가 게이트웨이로 프록시)에 키만 물어 보고, 게이트웨이는 설정 파일의 `SELECT`로 읽어 둔 메모리 캐시에서 답합니다. 읽기 전용이며(2026-11-15 사용자 결정) 도면에는 참조만 저장합니다. 화면은 `src/ui/recordPanel.ts`(속성 패널 칸, 정보 카드).
- **모드.** 편집 모드와 뷰어 모드(`App.setMode`). 뷰어 모드에서는 `InspectTool`만 쓰이고, 변경 API 호출이 막히며, `.edit-only` UI가 숨겨집니다.

## 확장 지점

| 하고 싶은 일 | 고칠 곳 |
| --- | --- |
| 새 객체 종류 | `model/types.ts` → `model/document.ts`(`pointIdsOf`, `bboxOf`) → `model/spatial.ts`(선택) → `view/renderer.ts` → `io/serialize.ts` → `io/svg.ts`, `io/dxfExport.ts` → `ui/properties.ts`, `ui/tree.ts` → `docs/DATA_MODEL.md` |
| 새 도구 | `tools/`에 `Tool` 구현 → `app.ts`의 도구 표 → `index.html` 리본 버튼(`data-tool`) |
| 새 구조 프리셋 범주 | `StructureCategory` → `PROP_DEFS`, `CATEGORY_LABELS`, `DEFAULT_STRUCTURE_TYPES` → `presetInfo` → `model/symbols.ts`의 평면 기호 |
| 새 API 메서드 | `api/editorApi.ts` → `api/rpc.ts`의 `METHODS` → `npm run docs:api` → `tests/api.test.ts` |
| 새 원본 데이터 종류(DB 등) | `gateway/drivers.ts`(`readRows`) → `gateway/datasets.ts`(`parseConfig`) → `gateway/gateway.test.ts` → `docs/DATA_SOURCES.md` |
| 새 데이터 소스(뷰어) | `viewer/sources.ts`에 `DataSource` 구현 → `sourceFor` → `docs/VIEWER.md` |
| 새 3D 모양 | `model/scene3d.ts`(입체·선 만들기) → 필요하면 `model/heights.ts`의 기본 높이 → `tests/scene3d.test.ts` |
| 색 바꾸기 | `src/theme.ts` → `style.css`의 `:root`(테스트가 알려 줍니다) |
| 새 테두리 템플릿 | `src/model/borders.ts`의 `BORDER_TEMPLATES`(색은 `src/theme.ts`의 `MARKING`) → `index.html`의 `#style-template` |
| 파일 형식 변경 | `docs/DATA_MODEL.md`의 "형식을 바꿀 때" 절 |

## 테스트

`npm test`(Vitest)는 모델·기하·입출력·API·뷰어 데이터 파싱을 Node에서 검사하고, `mcp/router.test.ts`는 MCP 라우터를, `gateway/gateway.test.ts`는 데이터 게이트웨이(CSV·JSON·SQLite, HTTP)를 검사합니다. 화면은 Playwright로 스크린샷을 찍어 확인합니다(Chromium이 설치된 환경에서 `npm run dev` 후). `docs/API-METHODS.md`는 자동 생성 파일이며 오래되면 테스트가 실패합니다.
