# 뷰어 모드와 모니터링 앱

보기 전용 화면은 두 가지입니다.

| | 편집기의 뷰어 모드 | 모니터링 앱 |
| --- | --- | --- |
| 주소 | `index.html` 빠른 실행 바의 **뷰어** 전환, 또는 `index.html?mode=view` | `viewer.html` |
| 용도 | 그린 도면을 편집 없이 둘러보고 객체 정보 확인 | 호스트 서버의 값을 받아 실시간 감시(관제 화면) |
| 편집 | 막힘(변경 API도 거부) | 편집 코드 경로 없음 |
| 실시간 값 | 편집기에 들어온 값 표시 | WebSocket 푸시, REST 폴링, 모의 데이터 |

두 화면 모두 클릭하면 객체 정보 카드(이름, 종류, 크기, 구조 특성 계산값, 모니터링 값)를 보여 주고, 드래그로 화면을 옮기고, 휠로 확대·축소합니다.

## 모니터링 키 (binding)

도면의 어떤 객체든 **모니터링 키**를 가질 수 있습니다. 편집기의 속성 패널에서 "모니터링 키"를 입력하거나, API로 `updateEntity({ id, binding: "line1.temp" })`를 부르십시오. 모니터링 앱은 키가 있는 객체를 상태 색으로 칠하고 값을 표시하며, 오른쪽 목록에 심각도 순(경보 → 주의 → 수신 없음 → 정상)으로 보여 줍니다.

| 상태 | 색 | 의미 |
| --- | --- | --- |
| `ok` | 초록 | 정상 |
| `warn` | 주황 | 주의 |
| `alarm` | 빨강 | 경보 |
| `offline` | 회색 | 값이 없거나 오래됨 |

## 모니터링 앱 실행

```
viewer.html?drawing=/plans/factory.json&source=ws://host:8080/live
viewer.html?drawing=/plans/factory.json&source=https://host/api/values&interval=2000
viewer.html?drawing=/plans/factory.json&source=mock
viewer.html?config=/plans/monitor.json
```

| 매개변수 | 설명 |
| --- | --- |
| `drawing` | 도면 JSON 주소(같은 출처이거나 CORS 허용 필요). 없으면 **도면 열기**로 파일을 고릅니다. |
| `source` | `ws://`·`wss://` → WebSocket 푸시, `http(s)://` 또는 `/`로 시작 → REST 폴링, `mock` → 모의 데이터 |
| `interval` | 폴링 주기(ms, 기본 2000, 최소 250) |
| `floor` | 처음 보여 줄 층 id |
| `config` | 아래 설정 파일 주소. URL 매개변수가 설정 파일 값보다 우선합니다. |

설정 파일 예:

```json
{
  "drawing": "/plans/factory.json",
  "source": "wss://host.example/live",
  "interval": 2000,
  "staleMs": 10000,
  "thresholds": {
    "line1.temp": { "warn": 60, "alarm": 80 },
    "pressure*": { "low": 2, "warn": 8, "alarm": 10 }
  }
}
```

- `thresholds`: 서버가 `status`를 보내지 않을 때 숫자 값으로 상태를 정합니다. 키 이름 그대로 또는 `*`로 끝나는 접두사. 값 ≥ `alarm` → 경보, ≥ `warn` → 주의, ≤ `low` → 경보. 서버가 보낸 `status`가 항상 우선합니다.
- `staleMs`: 마지막 수신 후 이 시간이 지나면 `offline`으로 표시(기본: 폴링 주기의 3배, 최소 10초).

## 호스트 서버가 보낼 JSON

WebSocket 메시지 하나, 또는 REST 응답 하나가 아래 세 형식 중 하나면 됩니다. 일부 키만 보내도 되며, 받은 키만 갱신됩니다.

```jsonc
// 1) values 객체 (권장)
{ "values": { "line1.temp": 72.5, "mc1.state": { "value": "RUN", "status": "ok", "unit": "" } } }

// 2) 평평한 객체
{ "line1.temp": 72.5, "line1.pressure": 6.1 }

// 3) 배열
[ { "key": "line1.temp", "value": 72.5, "status": "warn", "unit": "°C", "at": 1761400000000 } ]
```

- `value`: 숫자, 문자열, 불리언 무엇이든 됩니다(임계값은 숫자에만 적용).
- `status`: `ok`, `warn`, `alarm`, `offline` 중 하나(선택).
- `unit`: 표시 단위(선택). `at`: 측정 시각, 1970년 기준 ms(선택, 없으면 받은 시각).

WebSocket은 끊기면 1초부터 최대 30초까지 간격을 늘려 다시 연결합니다. REST 폴링은 앞 요청이 끝난 뒤 다음 요청을 보냅니다(겹치지 않음).

## 예제 호스트 서버

실제 장비 없이 시험하려면:

```bash
npm run demo:host -- --port 7830 --keys line1.temp,line1.pressure,lift-1
# viewer.html?drawing=…&source=ws://127.0.0.1:7830/live
# viewer.html?drawing=…&source=http://127.0.0.1:7830/values
```

[`scripts/demoHost.ts`](../scripts/demoHost.ts)는 같은 값을 REST(`/values`)와 WebSocket(`/live`)으로 제공합니다. 실제 호스트 서버(PLC 게이트웨이, MES, SCADA 등)는 위 JSON 형식만 맞추면 됩니다.

## 배포와 보안

- `npm run build` 결과(`dist/`)에 `index.html`과 `viewer.html`이 함께 들어갑니다. Docker 이미지에서는 `/viewer.html`로 열립니다.
- 관제 화면만 배포하려면 `viewer.html`과 그 자산만 공개해도 됩니다.
- 뷰어는 값을 읽기만 하며 서버로 아무것도 보내지 않습니다. 인증이 필요한 호스트라면 같은 출처의 역방향 프록시(쿠키 인증)나 `wss://` 토큰 주소를 쓰십시오. 페이지에 비밀 값을 넣지 마십시오.

## 코드

- [`src/viewer/sources.ts`](../src/viewer/sources.ts): 데이터 소스와 JSON 해석(`normalize`), 임계값(`applyThresholds`). DOM 없이 테스트됩니다(`tests/viewer.test.ts`).
- [`src/viewer/main.ts`](../src/viewer/main.ts): 모니터링 앱 화면. 편집기의 모델, 렌더러, `InspectTool`, 정보 카드를 재사용합니다.
- 새 소스(예: MQTT over WebSocket, SSE)를 넣으려면 `DataSource`를 구현하고 `sourceFor`에 연결하십시오.
