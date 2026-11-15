# 원본 데이터 연결 (DB)

Layout Liner는 도면을 그리고 보는 시각 도구입니다. 설비 대장, 실 목록, 자산 정보 같은 **원본 데이터는 원래 시스템(DB, MES, ERP, 엑셀 파일)에 그대로 두고**, 도면의 객체가 그 레코드를 참조해 값을 보여 줍니다.

- **읽기 전용**입니다(2026-11-15 사용자 결정). 도면에서 원본 값을 고치거나 DB에 쓰지 않습니다. 값은 원본 시스템에서만 고칩니다.
- 브라우저는 DB에 직접 접속하지 않습니다. 호스트 서버의 **데이터 게이트웨이**(`gateway/`)가 관리자가 설정 파일에 적은 조회만 실행하고, 결과를 JSON으로 내줍니다. DB 계정과 비밀번호는 서버의 환경 변수에만 있습니다.
- 도면 파일에는 "어느 데이터셋의 어느 키"라는 참조만 저장됩니다(`record`). 원본 값은 파일에 복사되지 않습니다.

```
 편집기·뷰어(브라우저) ── GET /data/datasets/equipment/records?key=MC-1 ──▶ Nginx(편집기 컨테이너)
                                                                              │ /data/ → 프록시
                                                                              ▼
                                                     데이터 게이트웨이(layout-liner-data, 읽기 전용, 메모리 캐시)
                                                                              │ 설정된 SELECT만, 주기적으로
                                                                              ▼
                                         PostgreSQL · MySQL/MariaDB · SQL Server · SQLite · CSV · JSON · HTTP API
```

## 편집기에서 쓰기

원본 데이터는 **개체값(Parameter·치수 수식)으로 불러와 쓰는 것**이 목적입니다(2026-11-15 사용자 요청). 개체마다 붙는 설정 칸은 두지 않습니다.

1. 리본 **외부 연결** 탭의 "원본 데이터 (DB, 읽기 전용)"에서 게이트웨이 주소를 확인하고(기본 `/data`) **DB 연결**을 누릅니다. 상태에 "연결됨: 데이터셋 N개"가 나오고 사이드바의 **외부 데이터** 패널(원통 아이콘)이 열립니다. 주소는 이 브라우저에 기억됩니다.
2. 외부 데이터 패널에서 데이터셋을 고르고 키를 검색해 레코드를 엽니다. 각 필드의 **참조 복사**를 누르면 `DB("equipment", "MC-1", "정격전력(kW)")` 같은 참조가 클립보드에 복사됩니다.
3. 복사한 참조를 Parameter 값이나 치수 수식에 붙여 넣으면 원본 값이 쓰입니다. 예: `DB("equipment", "MC-1", "폭(mm)") + 600`. 숫자처럼 보이는 글자(CSV의 `"22"`, `"1,200"`)는 숫자로 바뀝니다.

`DB()` 값은 게이트웨이에서 비동기로 가져옵니다. 아직 도착하지 않았거나 게이트웨이가 꺼져 있으면 "값 없음"으로 처리되고 Parameter는 마지막으로 계산된 값을 유지합니다. 값이 도착하면 다시 계산됩니다. Parameter·수식 문법과 저장 형식은 치수 구속 문서를 따릅니다(`src/model/params.ts`).

AI·스크립트에서는 객체 하나를 레코드에 연결하는 `linkRecords({ ids, dataset, key? })`, `updateEntity({ id, record })`도 쓸 수 있습니다([API-METHODS.md](API-METHODS.md)). 연결된 객체는 뷰어 모드와 모니터링 앱의 정보 카드에 원본 필드가 함께 나옵니다.

### 모니터링 키와의 차이

| | 모니터링 키 (`binding`) | 원본 데이터 (`record`) |
| --- | --- | --- |
| 무엇 | 실시간으로 바뀌는 값(온도, 가동 상태) | 잘 바뀌지 않는 기준 정보(설비명, 제조사, 담당자) |
| 어디서 | 호스트 서버의 WebSocket/REST ([VIEWER.md](VIEWER.md)) | 데이터 게이트웨이(이 문서) |
| 표시 | 상태 색, 값, 감시 목록 | 속성 패널과 정보 카드의 필드 목록 |

한 객체에 둘 다 지정할 수 있습니다.

## 게이트웨이 설정 (`datasets.json`)

```jsonc
{
  "datasets": {
    "equipment": {
      "label": "설비 대장",
      "driver": "postgres",
      "connection": "env:LL_DB_URL",
      "query": "SELECT tag, name, maker, model, installed_on, power_kw FROM equipment WHERE active",
      "key": "tag",
      "refreshMs": 60000
    },
    "rooms": {
      "label": "실 목록",
      "driver": "csv",
      "file": "rooms.csv",
      "encoding": "euc-kr",
      "key": "실번호"
    }
  }
}
```

| 필드 | 설명 |
| --- | --- |
| 데이터셋 이름(객체의 키) | 영문·숫자·`_` `-` `.` 64자 이내. 도면에 이 이름이 저장됩니다. |
| `label` | 화면에 보일 이름(선택). |
| `driver` | `postgres`, `mysql`(MariaDB 포함), `mssql`, `sqlite`, `csv`, `json`, `http` |
| `key` | 레코드 키가 들어 있는 열 이름. 같은 키가 여러 행이면 첫 행을 씁니다. |
| `fields` | 보여 줄 열과 순서(선택). 없으면 모든 열. 내부용 열을 숨길 때 씁니다. |
| `refreshMs` | 원본을 다시 읽는 주기(ms, 기본 60000, 최소 5000). |
| `maxRows` | 이보다 행이 많으면 읽지 않습니다(기본 100000). |
| `connection` | `postgres`·`mysql`·`mssql`의 접속 문자열. **`env:변수명`으로 환경 변수에서 읽으십시오.** |
| `query` | `sqlite`·`postgres`·`mysql`·`mssql`의 조회문. `SELECT`(또는 `WITH … SELECT`) 한 문장만 허용합니다. |
| `file` | `csv`·`json`·`sqlite` 파일 경로(설정 파일 기준 상대 경로). SQLite는 읽기 전용으로 엽니다. |
| `encoding`, `delimiter` | `csv`의 문자 인코딩(한글 윈도우 엑셀은 `euc-kr`)과 구분자(기본 `,`). 첫 줄은 열 이름입니다. |
| `url`, `headers`, `path` | `http`: 객체 배열을 돌려주는 기존 API 주소, 요청 헤더(값에 `env:` 가능), 배열 위치(예: `data.items`). `json` 파일도 `path`를 씁니다. |

최상위의 `host`(기본 `127.0.0.1`), `port`(기본 7840), `allowOrigin`(다른 출처의 편집기가 직접 부를 때만)도 지정할 수 있습니다. Docker 이미지에서는 환경 변수 `LL_DATA_HOST=0.0.0.0`, `LL_DATA_PORT`, `LL_DATA_CONFIG=/config/datasets.json`이 기본입니다.

접속 문자열 예:

```dotenv
# deploy/data.env (Docker) 또는 셸 환경 변수
LL_DB_URL=postgres://layout_reader:비밀번호@db.example:5432/plant
# MySQL/MariaDB:  mysql://layout_reader:비밀번호@db.example:3306/plant
# SQL Server:     Server=db.example,1433;Database=plant;User Id=layout_reader;Password=비밀번호;Encrypt=true;TrustServerCertificate=true
```

### 보안 권장 사항

- 게이트웨이용 DB 계정은 **읽기 권한만** 주십시오(예: PostgreSQL `GRANT SELECT ON equipment TO layout_reader`). 조회문 검사(`SELECT`만 허용)는 실수를 막는 장치일 뿐 권한을 대신하지 않습니다.
- 브라우저가 보낼 수 있는 것은 데이터셋 이름과 키뿐이며, 조회문에 들어가지 않습니다(게이트웨이는 메모리 캐시에서 찾습니다). 그래서 SQL 주입 경로가 없습니다.
- 게이트웨이는 포트를 밖에 열지 않고 편집기 컨테이너의 `/data/`로만 노출됩니다. 원본 데이터를 볼 수 있는 사람을 제한하려면 편집기 주소 전체에 역방향 프록시 인증을 거십시오.
- 쓰기(수정·삭제) 요청은 모두 거부됩니다(GET만 허용).

## 실행

### Docker (서버)

`deploy/docker-compose.yml`에 `layout-liner-data` 서비스가 들어 있습니다. 서버의 compose 폴더에서:

```bash
mkdir -p data
cp datasets.json data/          # 위 형식의 설정 파일, CSV·JSON·SQLite 파일도 data/에
printf 'LL_DB_URL=postgres://…\n' > data.env && chmod 600 data.env
docker compose pull && docker compose up -d
docker compose logs layout-liner-data   # "equipment: 1234건 (postgres)"처럼 읽은 건수가 나옵니다
```

같은 서버(도커 호스트)에서 도는 DB는 `host.docker.internal`로 접속합니다. 설정을 바꾸면 `docker compose restart layout-liner-data`.

### 개발

```bash
npm run data:gateway -- --config gateway/example/datasets.json   # 예제 CSV·JSON 데이터셋
npm run dev                                                      # /data/ 가 게이트웨이(7840)로 프록시됩니다
```

예제 도면에서 가공기를 놓으면 번호가 `MC-1`이 되므로, `equipment` 데이터셋에 연결하면 바로 원본 필드가 보입니다. PostgreSQL·MySQL·SQL Server 드라이버는 편집기 의존성에 넣지 않았습니다. Docker 이미지에는 들어 있고, 로컬에서는 필요한 것만 `npm install --no-save pg`(또는 `mysql2`, `mssql`)로 설치하십시오.

### 다른 게이트웨이 주소

편집기와 모니터링 앱은 기본으로 같은 출처의 `/data`를 부릅니다. 다른 주소를 쓰려면 `index.html?data=http://10.0.0.5:7840` 또는 `viewer.html?…&data=…`처럼 지정하고, 게이트웨이 설정에 `"allowOrigin": "http://편집기주소"`를 넣으십시오.

## 게이트웨이 HTTP API

| 요청 | 응답 |
| --- | --- |
| `GET /health` | `{ "ok": true, "datasets": 2 }` |
| `GET /datasets` | `{ "datasets": [{ "name", "label?", "key", "fields", "count", "loadedAt?", "error?" }] }` |
| `GET /datasets/:name/records?key=A&key=B` | `{ "records": { "A": { "열": 값, … } }, "missing": ["B"] }` (한 번에 100개까지) |
| `GET /datasets/:name/keys?q=MC&limit=50` | `{ "keys": ["MC-1", "MC-2"] }` (키 후보, 최대 500) |

값은 문자열, 숫자, 불리언, `null` 중 하나입니다(날짜는 ISO 문자열). 원본을 읽지 못하면 마지막으로 읽은 값을 계속 내주고 `error`에 이유를 적습니다. 한 번도 읽지 못했으면 `503`과 `{ "error" }`를 돌려줍니다. 기존 MES·ERP가 이 형식의 API를 직접 제공해도 되고, 반대로 게이트웨이의 `http` 드라이버로 기존 API를 데이터셋으로 만들 수도 있습니다.

## 코드

| 파일 | 역할 |
| --- | --- |
| [`src/data/records.ts`](../src/data/records.ts) | 참조 형식(`RecordRef`) 검증, 키 규칙(`recordKey`), 응답 형식, 브라우저·Node 공용 클라이언트 `RecordStore`(같은 틱의 조회를 묶고 60초 캐시). DOM 없음 |
| [`src/data/recordValues.ts`](../src/data/recordValues.ts) | 수식 함수 `DB(dataset, key, field)`, 참조 서식·수집, 미리 가져오기. DOM 없음 |
| [`src/ui/recordPanel.ts`](../src/ui/recordPanel.ts) | 사이드바 "외부 데이터" 탐색기(`DataBrowser`), 정보 카드에 붙는 필드 목록 |
| [`gateway/server.ts`](../gateway/server.ts) | 게이트웨이 HTTP 서버(GET만) |
| [`gateway/datasets.ts`](../gateway/datasets.ts) | 설정 검증, 데이터셋 캐시와 주기적 갱신 |
| [`gateway/drivers.ts`](../gateway/drivers.ts) | 원본별 읽기(CSV, JSON, SQLite, PostgreSQL, MySQL, SQL Server, HTTP), 조회문 검사 |
| [`gateway/Dockerfile`](../gateway/Dockerfile) | 게이트웨이 이미지(`ghcr.io/loborover/layout-liner-data`) |

새 원본 종류를 넣으려면 `drivers.ts`의 `DriverName`·`readRows`와 `datasets.ts`의 `parseConfig` 필수 필드 검사를 고치고 `gateway/gateway.test.ts`에 테스트를 추가하십시오.

## 참고 자료

- PostgreSQL 클라이언트 `pg`: <https://node-postgres.com/apis/client>
- MySQL 클라이언트 `mysql2`: <https://sidorares.github.io/node-mysql2/docs>
- SQL Server 클라이언트 `mssql`: <https://github.com/tediousjs/node-mssql#readme>
- Node.js 내장 SQLite(`node:sqlite`, `readOnly` 옵션): <https://nodejs.org/api/sqlite.html>
- Nginx에서 변수로 `proxy_pass`할 때 `resolver`가 필요한 이유: <https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass>
