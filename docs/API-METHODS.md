# API 메서드 목록

<!-- 자동 생성 파일입니다. 직접 고치지 말고 src/api/rpc.ts를 고친 뒤 `npm run docs:api`를 실행하십시오. -->

모든 전송 방식(브라우저 `layoutLiner.call`, MCP 도구, HTTP JSON-RPC, 실시간 브리지)이 같은 목록을 씁니다. 사용법은 [API.md](API.md)를 보십시오.
좌표와 길이는 mm, Y축은 위쪽입니다. "변경"이 예인 메서드는 실행 취소(undo) 한 단계로 기록됩니다.

| 메서드 | 변경 | 설명 |
| --- | --- | --- |
| [`summary`](#summary) |  | 도면 개요: 층·폴더·레이어(id, 위치 path, 객체 수), 객체 종류별 수, 라이브러리(설비·구조 종류), 범위. 폴더는 parent로 중첩됩니다. 이름은 겹칠 수 있으니 id로 지정하십시오. 작업 전에 먼저 호출하십시오. |
| [`getDocument`](#getdocument) |  | 도면 전체를 파일 형식(JSON, docs/DATA_MODEL.md)으로 반환합니다. |
| [`loadDocument`](#loaddocument) | 예 | 도면 전체를 교체합니다(파일 열기와 같은 검증). 실행 취소 기록이 지워집니다. |
| [`listEntities`](#listentities) |  | 객체 목록(좌표·길이·면적·검토 결과 포함). floor, layer, kind로 거를 수 있습니다. |
| [`getEntity`](#getentity) |  | 객체 하나의 상세 정보. |
| [`addLines`](#addlines) | 예 | 점들을 잇는 연속 선을 그립니다. closed=true면 닫고 도형(면)을 만듭니다. 기존 끝점과 0.5 mm 안이면 연결됩니다. |
| [`addRectangle`](#addrectangle) | 예 | 왼쪽 아래 모서리 (x, y)에서 width×height 사각형(선 4개 + 도형)을 그립니다. 방·구역에 쓰십시오. |
| [`addPoint`](#addpoint) | 예 | 독립 점 객체(기준점, 측량점, 센서 위치 등)를 놓습니다. 기존 점과 0.5 mm 안이면 그 점을 공유합니다. |
| [`addLabel`](#addlabel) | 예 | 독립 라벨 객체(제목: 내용 행 목록 또는 text)를 x, y에 놓습니다. 글자 높이 size(mm, 기본 300)는 도면 크기라 확대해도 실제 크기를 유지합니다. anchor는 글 상자의 어느 쪽이 점에 오는지(top이면 점 아래로 매달림). |
| [`placeColumn`](#placecolumn) | 예 | 기둥 생성기: 단면(section: rect 사각, round 원형, hbeam H형강)과 크기로 기둥을 x, y에 놓습니다. 같은 단면·크기·재료의 라이브러리 종류가 있으면 그것을, 없으면 새 종류를 추가해 씁니다. H형강은 width=춤 H(웨브 방향, 로컬 X), depth=플랜지 폭 B, webThickness=tw, flangeThickness=tf. 회전 0에서 H자 모양. |
| [`addCircle`](#addcircle) | 예 | 원을 그립니다. |
| [`addDimension`](#adddimension) | 예 | 두 점 사이 정렬 치수를 추가합니다. 기존 끝점에 붙으면 형상을 따라 값이 바뀝니다. |
| [`placeEquipment`](#placeequipment) | 예 | 설비 또는 구조 프리셋(기둥·계단·경사로·리프트)을 중심 (x, y)에 배치합니다. type은 라이브러리 id나 이름. |
| [`updateEntity`](#updateentity) | 예 | 객체 속성 변경: name, layer, binding(모니터링 키), record(원본 데이터 연결 {dataset, key?}), stroke(선·원의 테두리), fill/fillOpacity(도형 면 색·면 불투명도 0~1), tag/rotation/props(설비·구조), radius(원), height(3D 높이 mm), label(도형 라벨·라벨 객체 설정). null은 지움. |
| [`setPoint`](#setpoint) | 예 | 점(꼭짓점)을 X·Y·Z(mm) 위치로 옮깁니다. 이 점을 쓰는 선·도형·치수가 함께 바뀝니다. Z는 층 바닥 기준 높이. 점 id는 getEntity의 start/middle/end/position/polygon에 있습니다. 선의 중간점(middle)을 옮기면 선 전체가 옮겨집니다. |
| [`linkRecords`](#linkrecords) | 예 | 객체들을 원본 데이터(DB) 데이터셋의 레코드에 연결합니다(읽기 전용 참조, docs/DATA_SOURCES.md). key를 생략하면 각 객체의 설비 번호(없으면 이름)가 레코드 키입니다. dataset: null이면 연결을 해제합니다. |
| [`setStroke`](#setstroke) | 예 | 선·원과 도형의 변에 테두리(벽 두께, 바닥 표시 줄무늬 등)를 지정합니다. stroke=null이면 지웁니다. |
| [`moveEntities`](#moveentities) | 예 | 객체를 (dx, dy)만큼 옮깁니다. 공유된 점에 연결된 형상도 따라 움직입니다. |
| [`rotateEntities`](#rotateentities) | 예 | 90° 단위로 회전합니다. 설비만 선택하면 제자리 회전입니다. |
| [`copyEntities`](#copyentities) | 예 | 객체를 (dx, dy)만큼 떨어뜨려 복사합니다. columns·rows를 주면 그 간격의 배열 복사입니다. 복사본은 속성이 같고, 이름이 있으면 겹치지 않게 "이름 (2)"처럼 새 이름을 받습니다. |
| [`deleteEntities`](#deleteentities) | 예 | 객체를 삭제합니다. 도형은 변 선과 함께, 선은 그 선을 쓰는 도형과 함께 지워집니다. |
| [`editCorner`](#editcorner) | 예 | 두 선이 만나는 꼭짓점(point id)에 필렛(mode=fillet, size=반지름 mm) 또는 모따기(mode=chamfer, size=각 변을 따라 자를 거리 mm)를 적용합니다. 그 꼭짓점의 도형도 함께 바뀝니다. 필렛은 호를 따라 짧은 선들로 만듭니다. |
| [`insertVertex`](#insertvertex) | 예 | 선(도형의 변 포함)에서 x, y에 가장 가까운 자리에 꼭짓점을 넣어 선을 둘로 나눕니다. |
| [`removeVertex`](#removevertex) | 예 | 두 선이 만나는 꼭짓점을 지우고 두 선을 하나로 잇습니다(도형은 꼭짓점 3개 이상 유지). |
| [`makeShapes`](#makeshapes) | 예 | 선들 중 닫힌 고리를 도형(면)으로 만듭니다. |
| [`reorder`](#reorder) | 예 | 그리기 순서(트리 순서) 변경: front(맨 앞), back(맨 뒤), forward, backward. |
| [`addFloor`](#addfloor) | 예 | 층을 추가합니다(레이어 "0" 포함). elevation 생략 시 가장 높은 층 위. |
| [`setActiveFloor`](#setactivefloor) |  | 표시·편집할 층을 바꿉니다. 이후 새 객체는 이 층에 그려집니다. |
| [`addFolder`](#addfolder) | 예 | 층 안에, 또는 다른 폴더 안(parent)에 폴더를 추가합니다. 폴더·레이어 이름은 겹쳐도 되며 id로 구분합니다. 돌려주는 path는 "층 / 폴더 / …" 위치입니다. |
| [`updateFolder`](#updatefolder) | 예 | 폴더 이름·표시·잠금 변경, 또는 안의 폴더·레이어와 함께 옮기기. parent=폴더 id면 그 안으로, parent=null이면 층 바로 아래로(floor를 주면 그 층으로). 자기 하위 폴더 안으로는 옮길 수 없습니다. |
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

도면 개요: 층·폴더·레이어(id, 위치 path, 객체 수), 객체 종류별 수, 라이브러리(설비·구조 종류), 범위. 폴더는 parent로 중첩됩니다. 이름은 겹칠 수 있으니 id로 지정하십시오. 작업 전에 먼저 호출하십시오.

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
| `stroke` | object \| null |  | 테두리(Border, 선 양식). width(mm, Weight, 0=가는 선), align(center\|inside\|outside: 그린 선 기준 띠 위치), color(#rrggbb), opacity(0~1, 불투명도), join(miter\|round\|bevel: 다른 띠와 만나는 모서리의 바깥쪽 처리), pattern(줄무늬: stripes[{color, size(상대 크기)}], unit(크기 1의 폭 mm), angle(선 방향 기준 °)). null이면 지움. 템플릿: 구역색 color #FFCC00; 설비구역색 pattern stripes [#FFCC00×1, #1A1A1A×1], unit 50, angle 45; 안전구역색 [#FFFFFF×1, #D32F2F×1], unit 50, angle 45 |
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
| `stroke` | object \| null |  | 테두리(Border, 선 양식). width(mm, Weight, 0=가는 선), align(center\|inside\|outside: 그린 선 기준 띠 위치), color(#rrggbb), opacity(0~1, 불투명도), join(miter\|round\|bevel: 다른 띠와 만나는 모서리의 바깥쪽 처리), pattern(줄무늬: stripes[{color, size(상대 크기)}], unit(크기 1의 폭 mm), angle(선 방향 기준 °)). null이면 지움. 템플릿: 구역색 color #FFCC00; 설비구역색 pattern stripes [#FFCC00×1, #1A1A1A×1], unit 50, angle 45; 안전구역색 [#FFFFFF×1, #D32F2F×1], unit 50, angle 45 |
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

## addLabel

독립 라벨 객체(제목: 내용 행 목록 또는 text)를 x, y에 놓습니다. 글자 높이 size(mm, 기본 300)는 도면 크기라 확대해도 실제 크기를 유지합니다. anchor는 글 상자의 어느 쪽이 점에 오는지(top이면 점 아래로 매달림).

| 매개변수 | 형식 | 필수 | 설명 |
| --- | --- | --- | --- |
| `x` | number | 예 | mm |
| `y` | number | 예 | mm |
| `items` | object[] |  | "제목: 내용" 행 목록. 제목이 비면 내용만 표시 |
| `text` | string |  | items 대신 쓸 글(줄바꿈으로 여러 행) |
| `size` | number |  | 글자 높이 mm |
| `anchor` | center \| top \| bottom \| left \| right |  | 배치 기준: center(중심), top(상단), bottom(하단), left(좌측), right(우측) |
| `color` | string |  | #rrggbb (기본: 레이어 색) |
| `opacity` | number |  | 불투명도 0~1 |
| `visible` | boolean |  | false면 숨김 |
| `layer` | string |  | 레이어 id |
| `name` | string |  | 이름 |

## placeColumn

기둥 생성기: 단면(section: rect 사각, round 원형, hbeam H형강)과 크기로 기둥을 x, y에 놓습니다. 같은 단면·크기·재료의 라이브러리 종류가 있으면 그것을, 없으면 새 종류를 추가해 씁니다. H형강은 width=춤 H(웨브 방향, 로컬 X), depth=플랜지 폭 B, webThickness=tw, flangeThickness=tf. 회전 0에서 H자 모양.

| 매개변수 | 형식 | 필수 | 설명 |
| --- | --- | --- | --- |
| `section` | rect \| round \| hbeam | 예 |  |
| `width` | number | 예 | mm (원형은 지름, H형강은 춤 H) |
| `depth` | number |  | mm (H형강은 플랜지 폭 B, 원형은 무시) |
| `webThickness` | number |  | H형강 웨브 두께 tw mm (기본 10) |
| `flangeThickness` | number |  | H형강 플랜지 두께 tf mm (기본 15) |
| `material` | RC \| S \| SRC |  |  |
| `x` | number | 예 | 중심 mm |
| `y` | number | 예 | 중심 mm |
| `rotation` | number |  | °, 반시계 |
| `tag` | string |  | 번호 (생략 시 자동) |
| `layer` | string |  | 레이어 id |

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

객체 속성 변경: name, layer, binding(모니터링 키), record(원본 데이터 연결 {dataset, key?}), stroke(선·원의 테두리), fill/fillOpacity(도형 면 색·면 불투명도 0~1), tag/rotation/props(설비·구조), radius(원), height(3D 높이 mm), label(도형 라벨·라벨 객체 설정). null은 지움.

| 매개변수 | 형식 | 필수 | 설명 |
| --- | --- | --- | --- |
| `id` | string | 예 | 객체 id |
| `name` | string \| null |  |  |
| `layer` | string |  | 같은 층의 레이어 id |
| `binding` | string \| null |  |  |
| `record` | object \| null |  | 원본 데이터(DB) 레코드 참조. dataset은 데이터 게이트웨이의 데이터셋 이름, key를 생략하면 설비 번호(없으면 이름)가 키. null이면 연결 해제 |
| `stroke` | object \| null |  | 테두리(Border, 선 양식). width(mm, Weight, 0=가는 선), align(center\|inside\|outside: 그린 선 기준 띠 위치), color(#rrggbb), opacity(0~1, 불투명도), join(miter\|round\|bevel: 다른 띠와 만나는 모서리의 바깥쪽 처리), pattern(줄무늬: stripes[{color, size(상대 크기)}], unit(크기 1의 폭 mm), angle(선 방향 기준 °)). null이면 지움. 템플릿: 구역색 color #FFCC00; 설비구역색 pattern stripes [#FFCC00×1, #1A1A1A×1], unit 50, angle 45; 안전구역색 [#FFFFFF×1, #D32F2F×1], unit 50, angle 45 |
| `fill` | string \| null |  |  |
| `fillOpacity` | number \| null |  | 도형 면만의 불투명도(0~1). null이면 기본값 |
| `tag` | string |  |  |
| `rotation` | number |  |  |
| `radius` | number |  |  |
| `props` | object \| null |  |  |
| `height` | number \| null |  | 3D 높이(mm). null이면 기본값(벽·구조물은 층고, 설비 1000) |
| `label` | object \| null |  | 라벨. 도형: items(추가 행), showName, showArea, anchor, dx/dy(mm 이동), opacity(0~1), visible을 기존 값에 덮어씀(null이면 기본: 이름·면적을 면적 중심에). 라벨 객체: items, size(mm), anchor, color, opacity, visible. |

## setPoint

점(꼭짓점)을 X·Y·Z(mm) 위치로 옮깁니다. 이 점을 쓰는 선·도형·치수가 함께 바뀝니다. Z는 층 바닥 기준 높이. 점 id는 getEntity의 start/middle/end/position/polygon에 있습니다. 선의 중간점(middle)을 옮기면 선 전체가 옮겨집니다.

| 매개변수 | 형식 | 필수 | 설명 |
| --- | --- | --- | --- |
| `id` | string | 예 | 점 id |
| `x` | number |  | X (mm) |
| `y` | number |  | Y (mm) |
| `z` | number |  | Z: 층 바닥 기준 높이 (mm) |

## linkRecords

객체들을 원본 데이터(DB) 데이터셋의 레코드에 연결합니다(읽기 전용 참조, docs/DATA_SOURCES.md). key를 생략하면 각 객체의 설비 번호(없으면 이름)가 레코드 키입니다. dataset: null이면 연결을 해제합니다.

| 매개변수 | 형식 | 필수 | 설명 |
| --- | --- | --- | --- |
| `ids` | string[] | 예 | 객체 id 목록 |
| `dataset` | string \| null | 예 | 데이터셋 이름(영문·숫자·_-.). null은 연결 해제 |
| `key` | string |  | 레코드 키 (객체 하나일 때만) |

## setStroke

선·원과 도형의 변에 테두리(벽 두께, 바닥 표시 줄무늬 등)를 지정합니다. stroke=null이면 지웁니다.

| 매개변수 | 형식 | 필수 | 설명 |
| --- | --- | --- | --- |
| `ids` | string[] | 예 | 객체 id 목록 |
| `stroke` | object \| null | 예 | 테두리(Border, 선 양식). width(mm, Weight, 0=가는 선), align(center\|inside\|outside: 그린 선 기준 띠 위치), color(#rrggbb), opacity(0~1, 불투명도), join(miter\|round\|bevel: 다른 띠와 만나는 모서리의 바깥쪽 처리), pattern(줄무늬: stripes[{color, size(상대 크기)}], unit(크기 1의 폭 mm), angle(선 방향 기준 °)). null이면 지움. 템플릿: 구역색 color #FFCC00; 설비구역색 pattern stripes [#FFCC00×1, #1A1A1A×1], unit 50, angle 45; 안전구역색 [#FFFFFF×1, #D32F2F×1], unit 50, angle 45 |

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

객체를 (dx, dy)만큼 떨어뜨려 복사합니다. columns·rows를 주면 그 간격의 배열 복사입니다. 복사본은 속성이 같고, 이름이 있으면 겹치지 않게 "이름 (2)"처럼 새 이름을 받습니다.

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

## editCorner

두 선이 만나는 꼭짓점(point id)에 필렛(mode=fillet, size=반지름 mm) 또는 모따기(mode=chamfer, size=각 변을 따라 자를 거리 mm)를 적용합니다. 그 꼭짓점의 도형도 함께 바뀝니다. 필렛은 호를 따라 짧은 선들로 만듭니다.

| 매개변수 | 형식 | 필수 | 설명 |
| --- | --- | --- | --- |
| `point` | string | 예 | 꼭짓점 id (getEntity의 polygon/start/end) |
| `mode` | fillet \| chamfer | 예 |  |
| `size` | number | 예 | mm |

## insertVertex

선(도형의 변 포함)에서 x, y에 가장 가까운 자리에 꼭짓점을 넣어 선을 둘로 나눕니다.

| 매개변수 | 형식 | 필수 | 설명 |
| --- | --- | --- | --- |
| `line` | string | 예 | 선 id |
| `x` | number | 예 | mm |
| `y` | number | 예 | mm |

## removeVertex

두 선이 만나는 꼭짓점을 지우고 두 선을 하나로 잇습니다(도형은 꼭짓점 3개 이상 유지).

| 매개변수 | 형식 | 필수 | 설명 |
| --- | --- | --- | --- |
| `point` | string | 예 | 꼭짓점 id |

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

층 안에, 또는 다른 폴더 안(parent)에 폴더를 추가합니다. 폴더·레이어 이름은 겹쳐도 되며 id로 구분합니다. 돌려주는 path는 "층 / 폴더 / …" 위치입니다.

| 매개변수 | 형식 | 필수 | 설명 |
| --- | --- | --- | --- |
| `name` | string | 예 | 폴더 이름 |
| `floor` | string |  | 층 id (생략 시 현재 층) |
| `parent` | string |  | 상위 폴더 id (생략 시 층 바로 아래) |

## updateFolder

폴더 이름·표시·잠금 변경, 또는 안의 폴더·레이어와 함께 옮기기. parent=폴더 id면 그 안으로, parent=null이면 층 바로 아래로(floor를 주면 그 층으로). 자기 하위 폴더 안으로는 옮길 수 없습니다.

| 매개변수 | 형식 | 필수 | 설명 |
| --- | --- | --- | --- |
| `id` | string | 예 | 폴더 id |
| `name` | string |  |  |
| `visible` | boolean |  |  |
| `locked` | boolean |  |  |
| `parent` | string \| null |  |  |
| `floor` | string |  | 층 id |

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
