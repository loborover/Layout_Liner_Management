# 데이터 모델 (도면 파일 형식)

도면은 하나의 JSON 파일(`*.json`)입니다. 타입 정의의 원본은 [`src/model/types.ts`](../src/model/types.ts), 검증과 버전 변환은 [`src/io/serialize.ts`](../src/io/serialize.ts)입니다. 이 문서와 코드가 다르면 코드가 맞습니다. 문서를 고쳐 주십시오.

## 단위와 좌표

- 길이는 모두 **mm**, 각도는 **도(°), 반시계 방향**입니다.
- 월드 Y축은 **위쪽**입니다(화면과 SVG는 아래쪽이라 변환할 때 뒤집습니다).
- **Z(높이)는 위쪽**이며 점의 `z`는 그 점이 속한 층의 바닥(`elevation`)에서 잰 높이입니다. 없으면 0입니다.
- id는 문자열이며 파일 안에서 유일해야 합니다.

## 최상위 구조 (version 5)

```jsonc
{
  "format": "layout-liner",
  "version": 6,
  "units": "mm",
  "points": [ { "id": "p1", "x": 0, "y": 0, "z": 0 } ],
  "entities": [ /* 아래 객체들, 배열 순서 = 그리기 순서 = 트리 순서 */ ],
  "constraints": [ { "id": "c1", "kind": "horizontal", "refs": ["l1"] }, { "id": "c2", "kind": "coincident", "refs": ["p1", "p9"] } ],
  "floors":  [ { "id": "floor-1", "name": "1층", "elevation": 0, "height": 4000 } ],
  "folders": [ { "id": "f1", "name": "작업구역", "floor": "floor-1", "visible": true, "locked": false },
               { "id": "f2", "name": "협력사", "floor": "floor-1", "parent": "f1", "visible": true, "locked": false } ],
  "layers":  [ { "id": "layer-0", "name": "0", "color": "#1e293b", "visible": true, "locked": false, "floor": "floor-1", "folder": "f2" } ],
  "activeFloor": "floor-1",
  "equipmentTypes": [ { "id": "st-stair", "name": "계단", "width": 1200, "depth": 4200, "prefix": "ST", "category": "stair" } ],
  "underlay": { "src": "data:image/png;base64,…", "x": 0, "y": 0, "width": 30000, "height": 20000, "opacity": 0.5, "visible": true, "locked": false }
}
```

## 계층: 층 > 폴더 (> 폴더 …) > 레이어 > 객체

| 단위 | 필드 | 설명 |
| --- | --- | --- |
| 층 `Floor` | `elevation`, `height` | 다층 건물의 한 층. `height`(층고)는 계단 단수와 경사로 기울기 계산에 쓰입니다. 활성 층(`activeFloor`)만 보이고 편집됩니다. |
| 폴더 `Folder` | `floor`, `parent?`, `visible`, `locked` | 한 층 안에서 레이어와 다른 폴더를 묶습니다. `parent`(같은 층의 폴더 id, 버전 6)가 있으면 그 폴더 안에 있고, 없으면 층 바로 아래에 있습니다. 숨김·잠금은 안의 폴더와 레이어 전체에 깊이와 관계없이 적용됩니다. |
| 레이어 `Layer` | `floor`, `folder?`, `color` | 객체가 속하는 단위. `folder`가 없으면 층 바로 아래에 있습니다. |
| 객체 `Entity` | `layer` | 객체의 층은 레이어의 층입니다. |

폴더와 레이어의 **이름은 겹쳐도 됩니다**(예: 회사마다 "설비" 레이어). 구분은 `id`로 합니다. id는 파일 안에서 종류별로 유일해야 하며, 같은 id가 둘이면 파일을 열 때 거부합니다. API `summary`는 각 폴더·레이어에 사람이 읽는 위치 `path`(예: `1층 / 작업구역 / 협력사 / A사 / 설비`)를 덧붙여 돌려주므로, AI나 연결된 시스템은 `id`로 지정하고 `path`로 확인하면 됩니다. 다른 층의 폴더나 없는 폴더를 가리키는 `parent`, 순환하는 `parent`는 열 때 끊습니다.

## 객체 (entities)

모든 객체의 공통 필드: `id`, `kind`, `layer`, `name?`(사용자 이름), `binding?`(모니터링 키, [VIEWER.md](VIEWER.md)), `record?`(원본 데이터 참조 `{ dataset, key? }`, [DATA_SOURCES.md](DATA_SOURCES.md)).
`record`는 데이터 게이트웨이의 데이터셋 이름(영문·숫자·`_-.` 64자 이내)과 레코드 키(200자 이내)입니다. `key`가 없으면 설비 번호(`tag`), 없으면 `name`이 키입니다. 원본 값은 파일에 저장하지 않습니다. 형식이 잘못된 `record`는 열 때 버려집니다. 버전 5에 더해진 선택 필드라 그때 `version`을 올리지 않았으며, 이전 편집기는 이 필드를 무시합니다.
`line`, `circle`, `equipment`, `shape`와 설비 종류(`equipmentTypes`)에는 3D 보기용 `height?`(mm, 0 이상)가 있습니다. 점 객체, 라벨, 치수에는 높이가 없습니다(점의 높이는 `z`).

| kind | 필드 | 설명 |
| --- | --- | --- |
| `point` | `at` | 독립 점 객체(기준점, 측량점, 센서 위치 등). |
| `line` | `p1`, `p2`, `stroke?` | 시작점·중간점·끝점과 선의 묶음. 시작점과 끝점은 저장된 점이고, 중간점은 둘의 평균으로 계산됩니다. 편집기와 API에서는 중간점도 `<선 id>~mid` id의 점으로 선택·이동할 수 있으며(선 전체가 이동), 파일에는 저장하지 않습니다. |
| `circle` | `center`, `radius`, `stroke?` | 원. `stroke`는 원의 테두리 띠입니다(안쪽 = 중심 쪽). |
| `dimension` | `p1`, `p2`, `offset`, `value?` | 정렬 치수. `value`가 있으면 구동 치수(형상을 그 길이로 고정)입니다. |
| `equipment` | `type`, `at`, `rotation`, `tag`, `props?` | 설비 또는 구조 프리셋 배치. 크기는 종류(`equipmentTypes`)에서 옵니다. 회전 0°에서 너비는 X, 앞면은 -Y. |
| `shape` | `points`, `edges`, `fill?`, `fillOpacity?`, `fillImage?`, `label?` | 닫힌 도형(면). `points[i]` → `points[i+1]`을 잇는 선이 `edges[i]`이고 마지막 점은 `points[0]`으로 돌아갑니다. 도형의 테두리는 변 선들의 `stroke`입니다. |
| `label` | `at`, `items`, `size?`, `anchor?`, `color?`, `opacity?`, `visible?` | 독립 라벨(version 5). `items`는 `{ "title", "value" }` 행 목록으로 "제목: 내용"으로 표시됩니다(제목이 비면 내용만). `size`는 글자 높이 mm(기본 300, 도면 크기라 확대·인쇄 시 실제 크기), `anchor`는 글 상자의 어느 쪽이 점에 오는지입니다(`top`이면 점 아래로 매달림). |

### 테두리(Border, 선 양식) `stroke` (version 4에서 `opacity`, `pattern` 추가)

```json
{ "width": 300, "align": "inside", "color": "#FFCC00", "opacity": 1,
  "pattern": { "stripes": [ { "color": "#FFCC00", "size": 1 }, { "color": "#1A1A1A", "size": 1 } ], "unit": 50, "angle": 45 } }
```

- `width`(Weight): 띠 두께 mm. 0이면 `color`로 그린 가는 선입니다.
- `align`: `center`(기준선 중앙), `inside`(도형 안쪽, 도형이 없으면 p1→p2 진행 방향 왼쪽, 원은 중심 쪽), `outside`(반대쪽).
- `join`(version 5): 같은 두께·위치의 다른 띠와 만나는 모서리의 **바깥쪽** 처리. `miter`(뾰족, 기본, 너무 뾰족하면 띠 두께의 4배에서 모따기로 잘림), `round`(라운드), `bevel`(모따기, Chamfer). 모서리의 **안쪽**은 두 띠의 경계선이 만나는 곳에서 정확히 잘리고, 기준선 자체(오프셋 0)는 늘 꼭짓점에서 만납니다. 그래서 `inside` 띠는 아무리 뾰족한 모서리에서도 기준선 밖으로, `outside` 띠는 도형 안으로 나가지 않습니다(2026-11-15 사용자 요청, [`src/model/strokes.ts`](../src/model/strokes.ts)). 같은 점을 공유하거나 일치 구속으로 같은 자리에 있는 두 선이 만나는 곳에 적용되며, 세 선 이상이 만나는 곳과 자유 끝은 직각으로 끝납니다.
- `color`(Color): 없으면 레이어 색입니다. 패턴이 있으면 띠의 외곽선과 가는 선의 색입니다.
- `opacity`: 0~1 불투명도(편집기에서는 투명도 % = 100 − 불투명도×100). 없으면 띠 0.85, 가는 선 1입니다.
- `pattern`(Pattern): 띠를 채우는 줄무늬. `stripes`(1~16개, 순서대로 반복)의 각 줄무늬 폭은 `size × unit` mm(실제 바닥 치수)입니다. `angle`은 선의 진행 방향 기준 각도(원은 X축 기준)이며 0이면 선과 나란한 줄, 90이면 선을 가로지르는 줄입니다. 두께가 0이면 패턴은 보이지 않습니다.
- 템플릿(편집기·[`src/model/borders.ts`](../src/model/borders.ts), 2026-11-15 사용자 요청): **구역색** 단색 노랑 `#FFCC00`, **설비구역색** 노랑:검정 = 1:1 × 50 mm, 45°, **안전구역색** 하양:빨강 = 1:1 × 50 mm, 45°. 템플릿을 고르면 색·패턴과 불투명도 1이 들어가고, 두께가 0이었으면 100 mm가 됩니다. 파일에는 템플릿 이름이 아니라 값이 저장됩니다.

### 면 `fill`, `fillOpacity`, `fillImage` (version 4에서 `fillOpacity`, `fillImage` 추가)

- `fill`: 면 색. 없으면 레이어 색을 옅게 칠합니다.
- `fillOpacity`: 면만의 0~1 불투명도(테두리에는 영향 없음). 없으면 색·이미지가 있을 때 0.35, 없을 때 0.06입니다.
- `fillImage`: `{ "src": "data:image/png;base64,…", "fit": "stretch" | "tile", "size"?: 1000 }`. `stretch`는 도형의 외곽 상자에 맞추고, `tile`은 `size` mm 너비로 반복합니다. 밑그림처럼 **`data:` URL만 허용**합니다(파일을 열 때 외부 주소를 불러오지 않도록).

### 도형 라벨 `label` (version 5)

```json
{ "items": [ { "title": "담당", "value": "생산1팀" } ], "showName": true, "showArea": true,
  "anchor": "center", "dx": 0, "dy": 0, "opacity": 1, "visible": true }
```

- 모든 필드는 생략할 수 있고, 생략하면 기본값입니다. `label`이 없으면 **이름과 면적을 도형 면적의 중심**(면적 중심, L·U자처럼 면적 중심이 도형 밖이면 도형 안에서 외곽선과 가장 먼 점)에 표시합니다.
- `items`: 이름·면적 아래에 붙는 "제목: 내용" 행(최대 50개, 각 500자).
- `anchor`: `center`(면적 중심), `top`·`bottom`(외곽 상자 위·아래 가장자리 안쪽, 가로는 면적 중심), `left`·`right`(왼쪽·오른쪽 가장자리 안쪽, 세로는 면적 중심). `dx`·`dy`는 거기서 옮길 거리(mm, X 오른쪽·Y 위쪽 +).
- `opacity`: 글자 불투명도 0~1, `visible`: `false`면 그리지 않습니다(SVG·DXF·인쇄에서도 빠짐).

### 점 공유와 일치 구속 `coincident` (version 4)

- 한 번에 그린 객체(연속 선의 선분들, 사각형의 네 변과 도형)는 점을 공유합니다.
- 다른 객체의 점에서 선·사각형·점 객체를 시작하거나 끝내면, 새 객체는 **자기 점**을 갖고 두 점을 `coincident` 구속(`refs`: 점 id 2개 이상)으로 묶습니다. 그래서 함께 움직이지만 언제든 구속 해제나 `분리`로 떼어 낼 수 있습니다(2026-11-15 사용자 요청). Ctrl을 누르고 그리면 예전처럼 점을 공유합니다(닫힌 고리 → 도형).
- `분리`(`detachPoints`, [`src/model/edit.ts`](../src/model/edit.ts))는 공유된 점을 객체마다 따로 나누고 그 점의 일치 구속을 지웁니다. 도형과 그 변은 하나로 취급해 계속 공유합니다. 치수는 재는 형상의 점을 그대로 공유합니다.

### 높이 `height`와 점의 `z` (version 3)

객체는 점의 `z`에서 시작해 `height`만큼 위로 솟습니다. **높이의 기본값은 항상 0**입니다(설비는 종류에 `height`가 있으면 그 값). 높이가 0이면 3D에서 바닥에 평평하게 놓이고, 사용자가 높이를 주면 솟습니다([`src/model/heights.ts`](../src/model/heights.ts)).

| 객체 | 높이 0일 때 | 높이가 있을 때 |
| --- | --- | --- |
| 양식이 있는 선(`stroke.width` > 0, 벽) | 바닥의 띠 | 띠를 높이만큼 올린 벽 |
| 양식이 없는 선 | 3D 선 | 얇은 패널 |
| 원 | 고리 | 원기둥 |
| 도형 | 바닥 면 | 각기둥 |
| 일반 설비 | 바닥의 외곽 면 | 상자 |
| 구조 프리셋 | 바닥의 외곽 면 | 기둥(원형은 원기둥), 계단은 단, 경사로는 쐐기, 리프트는 반투명 상자 |
| 점 객체 | 점의 X, Y, Z에 작은 3D 십자 | (높이 없음) |

층은 `elevation`대로 쌓입니다. 치수는 높이가 없습니다.

### 도형 규칙

- `points`와 `edges`의 길이가 같고 3 이상이어야 합니다.
- `edges[i]`는 `points[i]`와 `points[(i+1) % n]`을 잇는 `line`이어야 합니다(방향은 상관없음). 검증에 실패하면 파일을 열지 않습니다.
- 도형을 지우면 변 선도 지워지고, 선을 지우면 그 선을 쓰는 도형도 지워집니다.

### 구조 프리셋과 특성 `props`

설비 종류의 `category`가 `column`, `stair`, `ramp`, `lift` 중 하나면 구조 프리셋입니다(없거나 `equipment`면 일반 설비). 특성 정의는 [`src/model/presets.ts`](../src/model/presets.ts)의 `PROP_DEFS`이며 API `presetSchema`로도 받을 수 있습니다. 값은 **객체의 `props` → 종류의 `props` → 정의의 기본값** 순서로 찾습니다.

| 범주 | 주요 특성 |
| --- | --- |
| 기둥 `column` | `shape`(rect/round/hbeam), `webThickness`·`flangeThickness`(H형강 tw·tf, mm), `material`(RC/S/SRC), `bearing`, `fireHours` |
| 계단 `stair` | `toFloor`(연결 층), `direction`, `riser`, `tread`, 검토값 `maxRiser`, `minTread` |
| 경사로 `ramp` | `toFloor`, `rise`(0이면 층고), 검토값 `maxSlope`(1/n), `minWidth` |
| 리프트 `lift` | `liftKind`, `capacity`, `speed`, `floors`(운행 층 id를 쉼표로) |

계단·경사로·리프트가 다른 층과 연결되면 그 층에서 점선으로 표시됩니다.

H형강 기둥(`shape: "hbeam"`, version 5)은 종류의 `width`가 춤 H(웨브 방향, 로컬 X), `depth`가 플랜지 폭 B이고, 회전 0°에서 H자 모양입니다(I자로 쓰려면 90° 회전). 기본 종류 `st-column-h`는 H-300×300×10×15이며, 편집 가능한 시작값으로 임의로 고른 일반적인 치수입니다. 리본의 **기둥 생성기**(API `placeColumn`)는 같은 단면·크기·재료의 종류가 있으면 그것을, 없으면 새 종류(이름 예: `H형강 기둥 H-400×400×13×21`)를 추가해 배치합니다.

> 검토값의 기본값(단높이 180 mm 이하, 단너비 260 mm 이상, 경사로 1/12, 폭 1.2 m)은 국내 규정을 설명한 2차 자료를 참고한 편집 가능한 기본값입니다. 실제 설계에는 반드시 [국가법령정보센터](https://www.law.go.kr)의 현행 「건축물의 피난·방화구조 등의 기준에 관한 규칙」, 「장애인·노인·임산부 등의 편의증진 보장에 관한 법률 시행규칙」 등 원문으로 확인하십시오.

## 버전 변환

| 버전 | 내용 |
| --- | --- |
| 1 | 레이어, 점, 선·원·치수·설비, 구속, 밑그림 |
| 2 | 층, 폴더, 도형, 선 양식, 구조 프리셋과 특성, `name`·`binding` |
| 3 | 점의 `z`, 객체와 설비 종류의 `height`, 점 객체(`point`) |
| 4 | 테두리 `opacity`·`pattern`, 원의 `stroke`, 도형의 `fillOpacity`·`fillImage`, `coincident` 구속, 밑그림 `locked` |
| 5 | 테두리 `join`, 도형의 `label`, 라벨 객체(`label`), 기둥 `shape: "hbeam"`과 `webThickness`·`flangeThickness`, 기본 종류 `st-column-h` |
| 6 | 중첩 폴더(폴더의 `parent`) |

버전 1 파일은 열 때 자동으로 변환됩니다. 모든 레이어가 `1층`(`floor-1`)에 들어가고 구조 프리셋 종류가 라이브러리에 추가됩니다. 버전 2~4 파일은 그대로 열립니다(새 필드가 없으면 기본값). 버전 5보다 오래된 파일에는 H형강 기둥 종류(`st-column-h`)가 라이브러리에 추가됩니다. 버전 5 파일은 그대로 열립니다(모든 폴더가 층 바로 아래). 저장하면 버전 6이 됩니다. 버전 6 파일은 이전 버전 편집기에서 열리지 않습니다.

## 형식을 바꿀 때 (체크리스트)

1. `src/model/types.ts`의 타입을 고치고, 필요하면 `version`을 올립니다.
2. `src/io/serialize.ts`에서 새 필드를 검증하고, 예전 버전 파일을 새 형식으로 변환합니다. **예전 파일은 계속 열려야 합니다.**
3. `src/model/document.ts`의 `toData()`/`load()`와, 새 객체 종류라면 `pointIdsOf`·`bboxOf`를 고칩니다.
4. 이 문서의 표와 예시를 고칩니다.
5. `tests/serialize.test.ts`에 왕복(저장 → 열기)과 변환 테스트를 추가합니다(버전 4 필드는 `tests/borders.test.ts`에도 있습니다).
