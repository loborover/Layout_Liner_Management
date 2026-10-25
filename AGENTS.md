# AGENTS.md

이 파일은 이 저장소에서 작업하는 **AI 코딩 에이전트**(Claude Code, Codex, Cursor, Gemini CLI 등)를 위한 안내서입니다.
사람을 위한 소개는 [README.md](README.md)에 있습니다. 형식은 [agents.md](https://agents.md/) 공개 규약을 따릅니다.
작업을 시작하기 전에 이 파일과 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)를 끝까지 읽으십시오.

## 1. 제품 한 줄 요약

공장·건물 평면도를 웹브라우저에서 그리고 설계하는 경량 2D CAD 툴입니다(Layout Liner).
설치 없이 정적 파일로 실행되며, 편집기(index.html), 실시간 모니터링 뷰어(viewer.html), AI용 MCP 서버(mcp/)로 구성됩니다.
개발과 유지보수는 AI가 맡는 것을 전제로 하므로, 코드와 문서만 보고 바로 작업에 착수할 수 있어야 합니다.

## 2. 명령어

```bash
npm ci               # 의존성 설치 (package-lock.json 기준)
npm run dev          # 개발 서버 (http://localhost:5173, 뷰어는 /viewer.html)
npm test             # 단위 테스트 (vitest, Node 환경, DOM 없음)
npm run typecheck    # 타입 검사 (tsc --noEmit)
npm run build        # 배포 빌드 (dist/), typecheck 포함
npm run mcp          # MCP 서버 실행 (stdio), docs/API.md 참고
npm run docs:api     # src/api/rpc.ts에서 docs/API-METHODS.md 생성 (API를 바꾸면 필수)
npm run demo:host    # 모니터링 앱 시험용 예제 호스트 서버
```

변경을 마치기 전에 **반드시 `npm run typecheck`와 `npm test`를 통과**시키십시오. 실패를 남긴 채 끝내지 마십시오.

## 3. 저장소 지도

| 경로 | 역할 |
| --- | --- |
| `src/model/` | 문서 모델(단일 진실 원천), 타입, 명령(undo), 편집 연산, 선택, 공간 인덱스. DOM 없음 |
| `src/geom/` | 순수 기하 함수. 문서·DOM 의존 금지 |
| `src/view/` | 뷰포트 변환, Canvas 2D 렌더러 |
| `src/tools/` | 마우스·키보드 입력을 명령으로 바꾸는 도구 |
| `src/snap/`, `src/constraints/` | 스냅 엔진, planegcs 구속 솔버 연동 |
| `src/io/` | JSON 저장·검증, DXF, SVG, CSV |
| `src/ui/` | 리본, 사이드바, 트리, 속성 패널 등 DOM 위젯 |
| `src/api/` | 외부 조작 API(`EditorApi`, JSON-RPC 디스패처). DOM 없음, 브라우저·Node 공용 |
| `src/viewer/` | 모니터링 뷰어 앱과 데이터 소스 어댑터 |
| `mcp/` | Node용 MCP 서버(파일 편집 + 브라우저 실시간 연결 브리지) |
| `tests/` | vitest 단위 테스트 |
| `scripts/` | 문서 자동 생성(`apiReference.ts`), 예제 호스트 서버(`demoHost.ts`) |
| `docs/` | 아키텍처, 데이터 모델, API(자동 생성 메서드 목록 포함), 뷰어 문서 |
| `deploy/`, `Dockerfile` | Docker/Nginx 배포 |

## 4. 반드시 지킬 규칙

1. **모든 문서 변경은 명령(Command)으로.** `src/model/commands.ts`의 명령을 `History.execute`로 실행해야 실행 취소가 됩니다. 드래그 미리보기처럼 직접 바꾼 경우에는 끝날 때 `History.record`로 기록합니다.
2. **좌표는 mm, Y축은 위쪽.** 화면 좌표(px, Y 아래)와의 변환은 `src/view/viewport.ts`만 담당합니다.
3. **점은 공유됩니다.** 선·치수·도형은 점 id를 참조하므로, 연결된 형상은 한 점을 옮기면 함께 움직입니다. 점을 복사할 때는 id 매핑을 유지하십시오(`copyItems` 참고).
4. **데이터 형식을 바꾸면** `src/model/types.ts` → `src/io/serialize.ts`(검증·이전 버전 변환) → `docs/DATA_MODEL.md` → `tests/serialize.test.ts`를 함께 고칩니다. 예전 파일은 계속 열려야 합니다.
5. **`src/model`, `src/geom`, `src/api`, `src/io`(DXF/JSON)는 DOM을 쓰지 않습니다.** MCP 서버가 Node에서 같은 코드를 사용합니다.
6. **새 기능에는 테스트를 추가합니다.** 순수 로직은 `tests/`에서 Node로 검증할 수 있게 설계하십시오.
7. **파일 머리 주석을 유지합니다.** 모든 소스 파일은 `/** @file ... */` 블록으로 목적·취지·관련 파일을 설명합니다. 새 파일에도 같은 형식으로 쓰고, 역할이 바뀌면 고칩니다.
8. **API를 바꾸면** `src/api/editorApi.ts`, `src/api/rpc.ts`의 메서드 표, `mcp/tools.ts`, `docs/API.md`를 함께 맞추고 `npm run docs:api`를 실행합니다.
9. **사용자에게 보이는 문구는 한국어**입니다. 코드 주석과 식별자는 영어입니다.
10. 의존성은 꼭 필요할 때만 추가합니다. 편집기는 브라우저에서 가볍게 실행되어야 합니다.

## 5. 코드 스타일

- TypeScript strict, ES 모듈, 2칸 들여쓰기, 작은따옴표, 세미콜론.
- 사용하지 않는 변수·매개변수는 컴파일 오류입니다(`noUnusedLocals`).
- 주석은 *무엇*보다 *왜*를 씁니다. 공개 함수·클래스에는 한 줄 이상의 JSDoc을 붙입니다.
- 사용자 오류는 예외 대신 `notify`(상태 표시줄) 메시지나 `{ ok: false, message }`로 돌려줍니다.

## 6. 작업 흐름

- 기능 단위로 브랜치를 만들고 PR로 올립니다. 커밋 메시지는 한 줄 요약(영어 또는 한국어) + 필요 시 본문.
- `main` 병합 시 GitHub Actions가 Docker 이미지를 GHCR에 올립니다(`.github/workflows/docker-publish.yml`).
- 큰 변경 전에는 `docs/ARCHITECTURE.md`의 해당 절을 먼저 읽고, 변경 후 문서를 갱신하십시오.

## 7. 보안 메모

- 도면 파일·API 입력은 모두 `deserialize`/`EditorApi` 검증을 거칩니다. 검증을 우회하는 경로를 만들지 마십시오.
- 밑그림 이미지는 `data:` URL만 허용합니다(파일을 열 때 외부 URL을 불러오지 않도록).
- MCP 브리지는 기본적으로 `127.0.0.1`에만 바인딩합니다.

## 8. 더 읽을 문서

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): 모듈 구조, 데이터 흐름, 확장 지점
- [docs/DATA_MODEL.md](docs/DATA_MODEL.md): 도면 파일 형식(층·폴더·레이어·객체)
- [docs/API.md](docs/API.md): 브라우저 API, JSON-RPC, MCP 도구
- [docs/VIEWER.md](docs/VIEWER.md): 모니터링 뷰어와 데이터 소스 형식
