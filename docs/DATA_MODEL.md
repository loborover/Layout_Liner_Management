# 데이터 모델 (도면 파일 형식)

도면은 하나의 JSON 파일(`*.json`)입니다. 타입 정의의 원본은 [`src/model/types.ts`](../src/model/types.ts), 검증과 버전 변환은 [`src/io/serialize.ts`](../src/io/serialize.ts)입니다. 이 문서와 코드가 다르면 코드가 맞습니다. 문서를 고쳐 주십시오.

## 단위와 좌표

- 길이는 모두 **mm**, 각도는 **도(°), 반시계 방향**입니다.
- 월드 Y축은 **위쪽**입니다(화면과 SVG는 아래쪽이라 변환할 때 뒤집습니다).
- id는 문자열이며 파일 안에서 유일해야 합니다.

## 최상위 구조 (version 2)

```jsonc
{
  "format": "layout-liner",
  "version": 2,
  "units": "mm",
  "points": [ { "id": "p1", "x": 0, "y": 0 } ],
  "entities": [ /* 아래 객체들, 배열 순서 = 그리기 순서 = 트리 순서 */ ],
  "constraints": [ { "id": "c1", "kind": "horizontal", "refs": ["l1"] } ],
  "floors":  [ { "id": "floor-1", "name": "1층", "elevation": 0, "height": 4000 } ],
  "folders": [ { "id": "f1", "name": "구조", "floor": "floor-1", "visible": true, "locked": false } ],
  "layers":  [ { "id": "layer-0", "name": "0", "color": "#1e293b", "visible": true, "locked": false, "floor": "floor-1", "folder": "f1" } ],
  "activeFloor": "floor-1",
  "equipmentTypes": [ { "id": "st-stair", "name": "계단", "width": 1200, "depth": 4200, "prefix": "ST", "category": "stair" } ],
  "underlay": { "src": "data:image/png;base64,…", "x": 0, "y": 0, "width": 30000, "height": 20000, "opacity": 0.5, "visible": true }
}
```

## 계층: 층 > 폴더 > 레이어 > 객체

| 단위 | 필드 | 설명 |
| --- | --- | --- |
| 층 `Floor` | `elevation`, `height` | 다층 건물의 한 층. `height`(층고)는 계단 단수와 경사로 기울기 계산에 쓰입니다. 활성 층(`activeFloor`)만 보이고 편집됩니다. |
| 폴더 `Folder` | `floor`, `visible`, `locked` | 한 층 안에서 레이어를 묶습니다. 숨김·잠금이 안의 레이어에 모두 적용됩니다. |
| 레이어 `Layer` | `floor`, `folder?`, `color` | 객체가 속하는 단위. `folder`가 없으면 층 바로 아래에 있습니다. |
| 객체 `Entity` | `layer` | 객체의 층은 레이어의 층입니다. |

## 객체 (entities)

모든 객체의 공통 필드: `id`, `kind`, `layer`, `name?`(사용자 이름), `binding?`(모니터링 키, [VIEWER.md](VIEWER.md)).

| kind | 필드 | 설명 |
| --- | --- | --- |
| `line` | `p1`, `p2`, `stroke?` | 점 id 두 개를 잇는 선. 중점은 계산값입니다. |
| `circle` | `center`, `radius` | 원. |
| `dimension` | `p1`, `p2`, `offset`, `value?` | 정렬 치수. `value`가 있으면 구동 치수(형상을 그 길이로 고정)입니다. |
| `equipment` | `type`, `at`, `rotation`, `tag`, `props?` | 설비 또는 구조 프리셋 배치. 크기는 종류(`equipmentTypes`)에서 옵니다. 회전 0°에서 너비는 X, 앞면은 -Y. |
| `shape` | `points`, `edges`, `fill?` | 닫힌 도형. `points[i]` → `points[i+1]`을 잇는 선이 `edges[i]`이고 마지막 점은 `points[0]`으로 돌아갑니다. |

### 선 양식 `stroke`

```json
{ "width": 200, "align": "inside", "color": "#64748b" }
```

- `width`: 띠 두께 mm. 0이면 `color`로 그린 가는 선입니다.
- `align`: `center`(기준선 중앙), `inside`(도형 안쪽, 도형이 없으면 p1→p2 진행 방향 왼쪽), `outside`(반대쪽).
- `color`: 없으면 레이어 색입니다.

### 도형 규칙

- `points`와 `edges`의 길이가 같고 3 이상이어야 합니다.
- `edges[i]`는 `points[i]`와 `points[(i+1) % n]`을 잇는 `line`이어야 합니다(방향은 상관없음). 검증에 실패하면 파일을 열지 않습니다.
- 도형을 지우면 변 선도 지워지고, 선을 지우면 그 선을 쓰는 도형도 지워집니다.

### 구조 프리셋과 특성 `props`

설비 종류의 `category`가 `column`, `stair`, `ramp`, `lift` 중 하나면 구조 프리셋입니다(없거나 `equipment`면 일반 설비). 특성 정의는 [`src/model/presets.ts`](../src/model/presets.ts)의 `PROP_DEFS`이며 API `presetSchema`로도 받을 수 있습니다. 값은 **객체의 `props` → 종류의 `props` → 정의의 기본값** 순서로 찾습니다.

| 범주 | 주요 특성 |
| --- | --- |
| 기둥 `column` | `shape`(rect/round), `material`(RC/S/SRC), `bearing`, `fireHours` |
| 계단 `stair` | `toFloor`(연결 층), `direction`, `riser`, `tread`, 검토값 `maxRiser`, `minTread` |
| 경사로 `ramp` | `toFloor`, `rise`(0이면 층고), 검토값 `maxSlope`(1/n), `minWidth` |
| 리프트 `lift` | `liftKind`, `capacity`, `speed`, `floors`(운행 층 id를 쉼표로) |

계단·경사로·리프트가 다른 층과 연결되면 그 층에서 점선으로 표시됩니다.

> 검토값의 기본값(단높이 180 mm 이하, 단너비 260 mm 이상, 경사로 1/12, 폭 1.2 m)은 국내 규정을 설명한 2차 자료를 참고한 편집 가능한 기본값입니다. 실제 설계에는 반드시 [국가법령정보센터](https://www.law.go.kr)의 현행 「건축물의 피난·방화구조 등의 기준에 관한 규칙」, 「장애인·노인·임산부 등의 편의증진 보장에 관한 법률 시행규칙」 등 원문으로 확인하십시오.

## 버전 변환

| 버전 | 내용 |
| --- | --- |
| 1 | 레이어, 점, 선·원·치수·설비, 구속, 밑그림 |
| 2 | 층, 폴더, 도형, 선 양식, 구조 프리셋과 특성, `name`·`binding` |

버전 1 파일은 열 때 자동으로 변환됩니다. 모든 레이어가 `1층`(`floor-1`)에 들어가고 구조 프리셋 종류가 라이브러리에 추가됩니다. 저장하면 버전 2가 됩니다.

## 형식을 바꿀 때 (체크리스트)

1. `src/model/types.ts`의 타입을 고치고, 필요하면 `version`을 올립니다.
2. `src/io/serialize.ts`에서 새 필드를 검증하고, 예전 버전 파일을 새 형식으로 변환합니다. **예전 파일은 계속 열려야 합니다.**
3. `src/model/document.ts`의 `toData()`/`load()`와, 새 객체 종류라면 `pointIdsOf`·`bboxOf`를 고칩니다.
4. 이 문서의 표와 예시를 고칩니다.
5. `tests/serialize.test.ts`에 왕복(저장 → 열기)과 변환 테스트를 추가합니다.
