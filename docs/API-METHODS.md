# API 메서드 목록

<!-- 자동 생성 파일입니다. 직접 고치지 말고 src/api/rpc.ts를 고친 뒤 `npm run docs:api`를 실행하십시오. -->

모든 전송 방식(브라우저 `layoutLiner.call`, MCP 도구, HTTP JSON-RPC, 실시간 브리지)이 같은 목록을 씁니다. 사용법은 [API.md](API.md)를 보십시오.
좌표와 길이는 mm, Y축은 위쪽입니다. "변경"이 예인 메서드는 실행 취소(undo) 한 단계로 기록됩니다.

| 메서드 | 변경 | 설명 |
| --- | --- | --- |
| [`summary`](#summary) |  | 도면 개요: 층·폴더·레이어(객체 수), 객체 종류별 수, 라이브러리(설비·구조 종류), 범위. 작업 전에 먼저 호출하십시오. |
| [`getDocument`](#getdocument) |  | 도면 전체를 파일 형식(JSON, docs/DATA_MODEL.md)으로 반환합니다. |
| [`loadDocument`](#loaddocument) | 예 | 도면 전체를 교체합니다(파일 열기와 같은 검증). 실행 취소 기록이 지워집니다. |
| [`listEntities`](#listentities) |  | 객체 목록(좌표·길이·면적·검토 결과 포함). floor, layer, kind로 거를 수 있습니다. |
| [`getEntity`](#getentity) |  | 객체 하나의 상세 정보. |
| [`addLines`](#addlines) | 예 | 점들을 잇는 연속 선을 그립니다. closed=true면 닫고 도형(면)을 만듭니다. 기존 끝점과 0.5 mm 안이면 연결됩니다. |
| [`addRectangle`](#addrectangle) | 예 | 왼쪽 아래 모서리 (x, y)에서 width×height 사각형(선 4개 + 도형)을 그립니다. 방·구역에 쓰십시오. |
| [`addPoint`](#addpoint) | 예 | 독립 점 객체(기준점, 측량점, 센서 위치 등)를 놓습니다. 기존 점과 0.5 mm 안이면 그 점을 공유합니다. |
| [`addCircle`](#addcircle) | 예 | 원을 그립니다. |
| [`addDimension`](#adddimension) | 예 | 두 점 사이 정렬 치수를 추가합니다. 기존 끝점에 붙으면 형상을 따라 값이 바뀝니다. |
| [`placeEquipment`](#placeequipment) | 예 | 설비 또는 구조 프리셋(기둥·계단·경사로·리프트)을 중심 (x, y)에 배치합니다. type은 라이브러리 id나 이름. |
| [`updateEntity`](#updateentity) | 예 | 객체 속성 변경: name, layer, binding(모니터링 키), stroke(선), fill(도형), tag/rotation/props(설비·구조), radius(원), height(3D 높이 mm). null은 지움. |
| [`setPoint`](#setpoint) | 예 | 점(꼭짓점)을 X·Y·Z(mm) 위치로 옮깁니다. 이 점을 쓰는 선·도형·치수가 함께 바뀝니다. Z는 층 바닥 기준 높이. 점 id는 getEntity의 start/middle/end/position/polygon에 있습니다. 선의 중간점(middle)을 옮기면 선 전체가 옮겨집니다. |
| [`setStroke`](#setstroke) | 예 | 선과 도형의 변에 선 양식(벽 두께 등)을 지정합니다. stroke=null이면 지웁니다. |
| [`moveEntities`](#moveentities) | 예 | 객체를 (dx, dy)만큼 옮깁니다. 공유된 점에 연결된 형상도 따라 움직입니다. |
| [`rotateEntities`](#rotateentities) | 예 | 90° 단위로 회전합니다. 설비만 선택하면 제자리 회전입니다. |
| [`copyEntities`](#copyentities) | 예 | 객체를 (dx, dy)만큼 떨어뜨려 복사합니다. columns·rows를 주면 그 간격의 배열 복사입니다. |
| [`deleteEntities`](#deleteentities) | 예 | 객체를 삭제합니다. 도형은 변 선과 함께, 선은 그 선을 쓰는 도형과 함께 지워집니다. |
| [`makeShapes`](#makeshapes) | 예 | 선들 중 닫힌 고리를 도형(면)으로 만듭니다. |
| [`reorder`](#reorder) | 예 | 그리기 순서(트리 순서) 변경: front(맨 앞), back(맨 뒤), forward, backward. |
| [`addFloor`](#addfloor) | 예 | 층을 추가합니다(레이어 "0" 포함). elevation 생략 시 가장 높은 층 위. |
| [`setActiveFloor`](#setactivefloor) |  | 표시·편집할 층을 바꿉니다. 이후 새 객체는 이 층에 그려집니다. |
| [`addFolder`](#addfolder) | 예 | 층 안에 레이어를 묶는 폴더를 추가합니다. |
| [`addLayer`](#addlayer) | 예 | 레이어를 추가합니다. folder를 주면 그 폴더(와 층)에 들어갑니다. |
| [`updateLayer`](#updatelayer) | 예 | 레이어 이름·색·표시·잠금·폴더 변경. folder=null이면 폴더에서 뺍니다. |
| [`addEquipmentType`](#addequipmenttype) | 예 | 라이브러리에 설비 종류나 구조 프리셋(category: column\|stair\|ramp\|lift)을 추가합니다. |
| [`presetSchema`](#presetschema) |  | 구조 프리셋 범주별 특성 정의(키, 단위, 선택지, 기본값). |
| [`scene3d`](#scene3d) |  | 3D 장면(벽·설비·계단 등을 높이 있는 입체와 3D 선으로 바꾼 것, mm, Z 위쪽)을 반환합니다. 호스트 서버에서 렌더링하거나 glTF 등으로 변환할 때 씁니다. |
| [`undo`](#undo) | 예 | 실행 취소. |
| [`redo`](#redo) | 예 | 다시 실행. |
| [`batch`](#batch) | 예 | 여러 호출을 한 번의 실행 취소 단계로 묶어 실행합니다. 하나라도 실패하면 모두 되돌립니다. |
| [`exportSvg`](#exportsvg) |  | 보이는 층을 SVG 문자열로 내보냅니다. |
| [`exportDxf`](#exportdxf) |  | 도면을 DXF R12 문자열로 내보냅니다. |
| [`exportEquipmentCsv`](#exportequipmentcsv) |  | 설비 목록 CSV 문자열. |

## summary

도면 개요: 층·폴더·레이어(객체 수), 객체 종류별 수, 라이브러리(설비·구조 종류), 범위. 작업 전에 먼저 호출하십시오.

매개변수 없음.

## getDocument

도면 전체를 파일 형식(JSON, docs/DATA_MODEL.md)으로 반환합니다.

매개변수 없음.

## loadDocument

도면 전체를 교체합니다(파일 열기와 같은 검증). 실행 취소 기록이 지워집니다.

| 매개변수 | 형식 | 필수 | 설명 |
| --- | --- | --- | --- |
| `data` | any | 예 | 도면 JSON 객체 또는 문자열 |

## listEntities

객체 목록(좌표·길이·면적·검토 결과 포함). floor, layer, kind로 거를 수 있습니다.

| 매개변수 | 형식 | 필수 | 설명 |
| --- | --- | --- | --- |
| `floor` | string |  | 층 id |
| `layer` | string |  | 레이어 id |
| `kind` | line \| circle \| dimension \| equipment \| shape |  |  |
| `limit` | number |  | 최대 개수 (기본 500, 최대 5000) |

## getEntity

객체 하나의 상세 정보.

| 매개변수 | 형식 | 필수 | 설명 |
| --- | --- | --- | --- |
| `id` | string | 예 | 객체 id |

## addLines

점들을 잇는 연속 선을 그립니다. closed=true면 닫고 도형(면)을 만듭니다. 기존 끝점과 0.5 mm 안이면 연결됩니다.

| 매개변수 | 형식 | 필수 | 설명 |
| --- | --- | --- | --- |
| `points` | number[] \| {x, y}[] | 예 |  |
| `closed` | boolean |  |  |
| `layer` | string |  | 레이어 id (생략 시 현재 레이어) |
| `stroke` | object \| null |  | 선 양식. width(mm, 0=가는 선), align(center\|inside\|outside: 그린 선 기준 띠 위치), color(#rrggbb). null이면 지움 |
| `name` | string |  | 도형 이름 (closed일 때) |
| `fill` | string |  | 도형 채우기 색 #rrggbb (closed일 때) |

## addRectangle

왼쪽 아래 모서리 (x, y)에서 width×height 사각형(선 4개 + 도형)을 그립니다. 방·구역에 쓰십시오.

| 매개변수 | 형식 | 필수 | 설명 |
| --- | --- | --- | --- |
| `x` | number | 예 | mm |
| `y` | number | 예 | mm |
| `width` | number | 예 | mm |
| `height` | number | 예 | mm |
| `layer` | string |  | 레이어 id |
| `stroke` | object \| null |  | 선 양식. width(mm, 0=가는 선), align(center\|inside\|outside: 그린 선 기준 띠 위치), color(#rrggbb). null이면 지움 |
| `name` | string |  | 도형 이름 |
| `fill` | string |  | #rrggbb |

## addPoint

독립 점 객체(기준점, 측량점, 센서 위치 등)를 놓습니다. 기존 점과 0.5 mm 안이면 그 점을 공유합니다.

| 매개변수 | 형식 | 필수 | 설명 |
| --- | --- | --- | --- |
| `x` | number | 예 | mm |
| `y` | number | 예 | mm |
| `z` | number |  | 층 바닥 기준 높이 mm |
| `layer` | string |  | 레이어 id |
| `name` | string |  | 이름 |

## addCircle

원을 그립니다.

| 매개변수 | 형식 | 필수 | 설명 |
| --- | --- | --- | --- |
| `x` | number | 예 | 중심 mm |
| `y` | number | 예 | 중심 mm |
| `radius` | number | 예 | mm |
| `layer` | string |  | 레이어 id |
| `name` | string |  | 이름 |

## addDimension

두 점 사이 정렬 치수를 추가합니다. 기존 끝점에 붙으면 형상을 따라 값이 바뀝니다.

| 매개변수 | 형식 | 필수 | 설명 |
| --- | --- | --- | --- |
| `from` | number[] \| {x, y} | 예 | 좌표 [x, y] 또는 {x, y} (mm, Y 위쪽) |
| `to` | number[] \| {x, y} | 예 | 좌표 [x, y] 또는 {x, y} (mm, Y 위쪽) |
| `offset` | number |  | 치수선 간격 mm (왼쪽 +) |
| `layer` | string |  | 레이어 id |

## placeEquipment

설비 또는 구조 프리셋(기둥·계단·경사로·리프트)을 중심 (x, y)에 배치합니다. type은 라이브러리 id나 이름.

| 매개변수 | 형식 | 필수 | 설명 |
| --- | --- | --- | --- |
| `type` | string | 예 | 종류 id 또는 이름 (예: st-stair, 계단) |
| `x` | number | 예 | mm |
| `y` | number | 예 | mm |
| `rotation` | number |  | 도, 반시계 |
| `tag` | string |  | 번호 (생략 시 자동) |
| `layer` | string |  | 레이어 id |
| `props` | object |  | 프리셋 특성 (presetSchema 참고) |
| `name` | string |  | 이름 |
| `binding` | string |  | 모니터링 키 |

## updateEntity

객체 속성 변경: name, layer, binding(모니터링 키), stroke(선), fill(도형), tag/rotation/props(설비·구조), radius(원), height(3D 높이 mm). null은 지움.

| 매개변수 | 형식 | 필수 | 설명 |
| --- | --- | --- | --- |
| `id` | string | 예 | 객체 id |
| `name` | string \| null |  |  |
| `layer` | string |  | 같은 층의 레이어 id |
| `binding` | string \| null |  |  |
| `stroke` | object \| null |  | 선 양식. width(mm, 0=가는 선), align(center\|inside\|outside: 그린 선 기준 띠 위치), color(#rrggbb). null이면 지움 |
| `fill` | string \| null |  |  |
| `tag` | string |  |  |
| `rotation` | number |  |  |
| `radius` | number |  |  |
| `props` | object \| null |  |  |
| `height` | number \| null |  | 3D 높이(mm). null이면 기본값(벽·구조물은 층고, 설비 1000) |

## setPoint

점(꼭짓점)을 X·Y·Z(mm) 위치로 옮깁니다. 이 점을 쓰는 선·도형·치수가 함께 바뀝니다. Z는 층 바닥 기준 높이. 점 id는 getEntity의 start/middle/end/position/polygon에 있습니다. 선의 중간점(middle)을 옮기면 선 전체가 옮겨집니다.

| 매개변수 | 형식 | 필수 | 설명 |
| --- | --- | --- | --- |
| `id` | string | 예 | 점 id |
| `x` | number |  | X (mm) |
| `y` | number |  | Y (mm) |
| `z` | number |  | Z: 층 바닥 기준 높이 (mm) |

## setStroke

선과 도형의 변에 선 양식(벽 두께 등)을 지정합니다. stroke=null이면 지웁니다.

| 매개변수 | 형식 | 필수 | 설명 |
| --- | --- | --- | --- |
| `ids` | string[] | 예 | 객체 id 목록 |
| `stroke` | object \| null | 예 | 선 양식. width(mm, 0=가는 선), align(center\|inside\|outside: 그린 선 기준 띠 위치), color(#rrggbb). null이면 지움 |

## moveEntities

객체를 (dx, dy)만큼 옮깁니다. 공유된 점에 연결된 형상도 따라 움직입니다.

| 매개변수 | 형식 | 필수 | 설명 |
| --- | --- | --- | --- |
| `ids` | string[] | 예 | 객체 id 목록 |
| `dx` | number | 예 | mm |
| `dy` | number | 예 | mm |

## rotateEntities

90° 단위로 회전합니다. 설비만 선택하면 제자리 회전입니다.

| 매개변수 | 형식 | 필수 | 설명 |
| --- | --- | --- | --- |
| `ids` | string[] | 예 | 객체 id 목록 |
| `angle` | number |  | 90의 배수, 기본 90 |

## copyEntities

객체를 (dx, dy)만큼 떨어뜨려 복사합니다. columns·rows를 주면 그 간격의 배열 복사입니다.

| 매개변수 | 형식 | 필수 | 설명 |
| --- | --- | --- | --- |
| `ids` | string[] | 예 | 객체 id 목록 |
| `dx` | number | 예 | mm |
| `dy` | number | 예 | mm |
| `columns` | number |  | 열 수 |
| `rows` | number |  | 행 수 |

## deleteEntities

객체를 삭제합니다. 도형은 변 선과 함께, 선은 그 선을 쓰는 도형과 함께 지워집니다.

| 매개변수 | 형식 | 필수 | 설명 |
| --- | --- | --- | --- |
| `ids` | string[] | 예 | 객체 id 목록 |

## makeShapes

선들 중 닫힌 고리를 도형(면)으로 만듭니다.

| 매개변수 | 형식 | 필수 | 설명 |
| --- | --- | --- | --- |
| `lineIds` | string[] | 예 | 객체 id 목록 |
| `name` | string |  | 도형 이름 |

## reorder

그리기 순서(트리 순서) 변경: front(맨 앞), back(맨 뒤), forward, backward.

| 매개변수 | 형식 | 필수 | 설명 |
| --- | --- | --- | --- |
| `ids` | string[] | 예 | 객체 id 목록 |
| `move` | front \| back \| forward \| backward | 예 |  |

## addFloor

층을 추가합니다(레이어 "0" 포함). elevation 생략 시 가장 높은 층 위.

| 매개변수 | 형식 | 필수 | 설명 |
| --- | --- | --- | --- |
| `name` | string | 예 | 예: 2층 |
| `elevation` | number |  | 바닥 높이 mm |
| `height` | number |  | 층고 mm |

## setActiveFloor

표시·편집할 층을 바꿉니다. 이후 새 객체는 이 층에 그려집니다.

| 매개변수 | 형식 | 필수 | 설명 |
| --- | --- | --- | --- |
| `floor` | string | 예 | 층 id |

## addFolder

층 안에 레이어를 묶는 폴더를 추가합니다.

| 매개변수 | 형식 | 필수 | 설명 |
| --- | --- | --- | --- |
| `name` | string | 예 | 폴더 이름 |
| `floor` | string |  | 층 id (생략 시 현재 층) |

## addLayer

레이어를 추가합니다. folder를 주면 그 폴더(와 층)에 들어갑니다.

| 매개변수 | 형식 | 필수 | 설명 |
| --- | --- | --- | --- |
| `name` | string | 예 | 레이어 이름 |
| `floor` | string |  | 층 id |
| `folder` | string |  | 폴더 id |
| `color` | string |  | #rrggbb |

## updateLayer

레이어 이름·색·표시·잠금·폴더 변경. folder=null이면 폴더에서 뺍니다.

| 매개변수 | 형식 | 필수 | 설명 |
| --- | --- | --- | --- |
| `id` | string | 예 | 레이어 id |
| `name` | string |  |  |
| `color` | string |  |  |
| `visible` | boolean |  |  |
| `locked` | boolean |  |  |
| `folder` | string \| null |  |  |

## addEquipmentType

라이브러리에 설비 종류나 구조 프리셋(category: column|stair|ramp|lift)을 추가합니다.

| 매개변수 | 형식 | 필수 | 설명 |
| --- | --- | --- | --- |
| `name` | string | 예 | 이름 |
| `width` | number | 예 | mm |
| `depth` | number | 예 | mm |
| `prefix` | string |  | 번호 접두어 |
| `category` | equipment \| column \| stair \| ramp \| lift |  |  |
| `props` | object |  |  |

## presetSchema

구조 프리셋 범주별 특성 정의(키, 단위, 선택지, 기본값).

매개변수 없음.

## scene3d

3D 장면(벽·설비·계단 등을 높이 있는 입체와 3D 선으로 바꾼 것, mm, Z 위쪽)을 반환합니다. 호스트 서버에서 렌더링하거나 glTF 등으로 변환할 때 씁니다.

| 매개변수 | 형식 | 필수 | 설명 |
| --- | --- | --- | --- |
| `floors` | all \| active |  | all: 모든 층을 표고대로 쌓음(기본), active: 현재 층만 |

## undo

실행 취소.

매개변수 없음.

## redo

다시 실행.

매개변수 없음.

## batch

여러 호출을 한 번의 실행 취소 단계로 묶어 실행합니다. 하나라도 실패하면 모두 되돌립니다.

| 매개변수 | 형식 | 필수 | 설명 |
| --- | --- | --- | --- |
| `calls` | object[] | 예 |  |

## exportSvg

보이는 층을 SVG 문자열로 내보냅니다.

매개변수 없음.

## exportDxf

도면을 DXF R12 문자열로 내보냅니다.

매개변수 없음.

## exportEquipmentCsv

설비 목록 CSV 문자열.

매개변수 없음.
