# Docker 배포 (compose pull로 업데이트)

`main`에 PR이 병합되면 GitHub Actions(`.github/workflows/docker-publish.yml`)가 이미지를 빌드해
`ghcr.io/loborover/layout-liner-management`에 올립니다. 서버에는 소스 코드 없이 `docker-compose.yml` 하나만 두면 됩니다.

## 처음 한 번만 할 일 (GitHub)

1. **Actions 쓰기 권한**: 저장소 `Settings → Actions → General → Workflow permissions`에서
   `Read and write permissions`를 고릅니다. 워크플로 파일에 `packages: write`를 적어 두었으므로 기본값(읽기 전용)이어도
   대개 동작하지만, 조직 정책 등으로 막혀 있으면 이 설정이 필요합니다.
2. **첫 이미지 확인**: 병합 후 `Actions` 탭에서 `Docker image` 실행이 성공했는지 봅니다.
   성공하면 프로필의 `Packages`에 `layout-liner-management`가 생깁니다.
3. **패키지 공개 여부**: GHCR 패키지는 처음에 **비공개(private)** 로 만들어집니다. 둘 중 하나를 고르십시오.
   - 공개로 전환: 패키지 페이지 `Package settings → Danger Zone → Change visibility → Public`.
     서버에서 로그인 없이 `docker compose pull`이 됩니다. (저장소가 비공개여도 이미지 안의 빌드 결과물은 누구나 받을 수 있게 됩니다.)
   - 비공개 유지: GitHub에서 `read:packages` 권한만 있는 Personal access token (classic)을 만들고 서버에서 한 번 로그인합니다.
     ```bash
     echo <토큰> | docker login ghcr.io -u loborover --password-stdin
     ```

## 서버 설정 (예: 192.168.0.50)

```bash
mkdir -p ~/layout-liner && cd ~/layout-liner
curl -fsSLO https://raw.githubusercontent.com/loborover/layout_liner_management/main/deploy/docker-compose.yml
docker compose pull && docker compose up -d
```

저장소가 비공개라 `curl`이 안 되면 `deploy/docker-compose.yml` 내용을 서버에 직접 붙여 넣으면 됩니다.
브라우저에서 `http://192.168.0.50:8080`으로 접속합니다.

## 업데이트

```bash
cd ~/layout-liner
docker compose pull && docker compose up -d
docker image prune -f   # 선택: 이전 이미지 정리
```

화면 오른쪽 아래 상태 표시줄의 `v0.1.0 · a1b2c3d` 라벨로 서버가 어떤 버전·커밋인지 확인할 수 있습니다.
라벨에 마우스를 올리면 빌드 시각도 보입니다. `index.html`은 캐시하지 않도록 설정했으므로 새로고침만 하면 새 버전이 뜹니다.

## 옵션

같은 폴더에 `.env` 파일을 두면 compose가 읽습니다.

```dotenv
LAYOUT_LINER_PORT=8080          # 서버에서 열 포트
LAYOUT_LINER_VERSION=latest     # 특정 버전에 고정: 0.1.0, sha-a1b2c3d 등
```

## 원본 데이터(DB) 연결 (선택)

compose 파일에는 읽기 전용 데이터 게이트웨이 `layout-liner-data`가 함께 들어 있습니다. 설정이 없으면 빈 상태로 떠 있으므로 그대로 두어도 됩니다.
DB를 연결하려면 compose 폴더에 `data/datasets.json`(설정)과 `data.env`(DB 접속 문자열 등 비밀 값)를 두고 다시 올립니다.

```bash
cd ~/layout-liner
mkdir -p data && nano data/datasets.json        # 형식은 docs/DATA_SOURCES.md
printf 'LL_DB_URL=postgres://layout_reader:비밀번호@host.docker.internal:5432/plant\n' > data.env && chmod 600 data.env
docker compose pull && docker compose up -d
docker compose logs layout-liner-data          # 데이터셋별로 읽은 건수 확인
```

게이트웨이는 포트를 밖에 열지 않고 편집기의 `/data/` 주소로만 노출됩니다. DB 계정은 읽기 권한만 주십시오.
GHCR 패키지 `layout-liner-data`도 처음에는 비공개이므로, 위 "패키지 공개 여부"와 같은 방법으로 공개하거나 로그인하십시오.

## 이미지 태그

| 태그 | 언제 갱신되나 |
| --- | --- |
| `latest` | `main`에 푸시(병합)될 때마다 |
| `0.1.0` (package.json 버전) | `main`에 푸시될 때마다 같은 태그를 덮어씀 |
| `sha-a1b2c3d` | 커밋마다 하나씩, 되돌리기용 |
| `1.2.3`, `1.2` | `v1.2.3` 같은 git 태그를 푸시했을 때 |

데이터 게이트웨이 이미지 `ghcr.io/loborover/layout-liner-data`도 같은 태그로 함께 올라갑니다.
PR에서는 이미지를 빌드만 해 보고 올리지는 않습니다.

## 로컬에서 직접 빌드

```bash
docker build -t layout-liner .
docker run --rm -p 8080:80 layout-liner
```
