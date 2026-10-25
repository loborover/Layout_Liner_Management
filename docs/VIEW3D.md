# 3D 보기

편집기는 평면(Top view) 외에 3D로 도면을 볼 수 있습니다. 모든 3D 보기는 CAD처럼 **직교 투영**입니다.

| 보기 | 버튼 | 카메라 |
| --- | --- | --- |
| 평면 | 평면 | 기존 2D 편집 화면(Canvas 2D) |
| 등각 | 등각 | 등각 투영(isometric). 왼쪽 드래그로 돌려 볼 수 있습니다. |
| 위 | 위 | 위에서 내려다본 3D(벽 높이와 겹침 확인용) |
| 정면 | 정면 | 앞(-Y 쪽)에서 본 입면 |
| 측면 | 측면 | 오른쪽(+X 쪽)에서 본 입면 |
| 4분할 | 4분할 | 위·정면·측면·등각을 한 화면에 |

조작: 휠은 커서 위치로 확대·축소, 드래그는 이동, 등각 보기에서 왼쪽 드래그는 회전(Shift·가운데 버튼 드래그는 이동), 더블클릭이나 `F`는 전체 맞춤입니다. 클릭한 객체는 선택되어 속성 패널에서 바로 고칠 수 있고, 평면으로 돌아가도 선택이 유지됩니다. 보기 탭의 "모든 층"을 끄면 현재 층만 보입니다.

3D 보기에서는 그리기 도구가 쉬고 선택·속성 편집만 됩니다. 좌표(X, Y, Z)와 높이를 바꾸면 3D 화면이 바로 갱신됩니다.

## 무엇이 어떻게 보이나

객체는 점의 `z`에서 시작해 `height`만큼 솟습니다. 기본 높이와 모양은 [DATA_MODEL.md](DATA_MODEL.md)의 "높이 `height`와 점의 `z`" 표를 보십시오. 층은 `elevation`대로 쌓이고, 선택한 객체와 뷰어의 상태 색이 3D에도 같은 색으로 칠해집니다.

## 구조

```
DocumentModel ──▶ buildScene (src/model/scene3d.ts, DOM 없음) ──▶ Scene3D { solids, lines, min, max }
                                                                    │
                     브라우저: src/view3d/mesh.ts (버퍼 병합) ──▶ src/view3d/view3d.ts (three.js, WebGL)
                     호스트 서버: API scene3d ──▶ 원하는 렌더러·변환기 (glTF, 이미지 등)
```

- **Scene3D**는 렌더러에 독립적인 결과입니다. 입체(`Solid`)는 바닥 외곽선(mm)과 꼭짓점마다 아래·위 Z를 가진 수직 기둥이고, 계단 단·경사로 쐐기·벽 띠가 모두 이 하나의 형태로 표현됩니다. 높이가 없는 선과 원은 3D 선(`Line3`)입니다.
- **가볍게 유지.** three.js([threejs.org](https://threejs.org), MIT)는 3D 보기를 처음 열 때만 `import()`로 불러옵니다. 빌드에서 별도 묶음(`view3d-*.js`)으로 나뉘어 평면 편집기의 첫 로딩 크기는 늘지 않습니다.
- **그리기 비용.** `sceneBuffers`가 같은 색·투명도의 입체를 하나의 버퍼로 합쳐 건물 전체가 몇 번의 draw call로 그려집니다. 삼각형마다 객체 id를 기록해 클릭 선택에 씁니다.

## 호스트 서버에서 무거운 처리

설비가 수만 개인 공장처럼 브라우저가 감당하기 어려운 도면은 호스트 서버가 처리한다는 전제로 설계했습니다.

1. 서버에서 같은 코드로 장면을 만듭니다. `buildScene`은 DOM을 쓰지 않으므로 Node에서 그대로 실행됩니다. HTTP JSON-RPC나 MCP로는 `scene3d` 메서드를 부르면 됩니다([API.md](API.md), [API-METHODS.md](API-METHODS.md)).

   ```json
   { "jsonrpc": "2.0", "id": 1, "method": "scene3d", "params": { "floors": "all" } }
   ```

2. 받은 `solids`·`lines`를 서버의 렌더러(three.js를 headless로, Blender 등)로 이미지를 만들거나 glTF로 변환해 배포합니다. 좌표는 mm, Z 위쪽입니다(glTF는 Y 위쪽·미터이므로 변환할 때 축과 단위를 바꾸십시오).

브라우저 3D 보기를 서버 결과로 대체하는 기능(서버가 만든 glTF나 이미지 받아 보기)은 아직 없습니다. 필요해지면 `src/view3d/`에 불러오기 경로를 추가하면 됩니다.

## 고칠 때

| 하고 싶은 일 | 고칠 곳 |
| --- | --- |
| 새 객체나 프리셋의 3D 모양 | `src/model/scene3d.ts` → `tests/scene3d.test.ts` |
| 기본 높이 | `src/model/heights.ts` → `docs/DATA_MODEL.md` 표 |
| 새 카메라 보기 | `src/view3d/view3d.ts`의 `ViewName`, `VIEW_LABELS`, 카메라 설정 → `index.html`의 `data-view` 버튼 |
| 3D 색 | `src/theme.ts`(직접 색 값을 쓰지 마십시오) |
