---
name: pax-local-setup
description: PAX 프로젝트를 로컬에 clone하고 환경변수를 설정한 뒤 개발 서버를 실행합니다. "프로젝트 로컬 세팅", "이 프로젝트 클론해서 실행", "로컬 개발 준비" 같은 요청에 사용.
---
# PAX 로컬 개발 준비

사용자가 PAX 프로젝트를 로컬에서 이어 개발하려 합니다. 다음 순서로 진행하세요.

## 0. 전제
- PAX MCP에 연결돼 있어야 합니다(`/pax:connect <코드>` 완료). 연결이 없으면 먼저 안내하세요.
- 로컬에 `git`, `node`, `npm`이 필요합니다(`npm install`/`npm run dev`). 없으면 설치를 안내하세요(이건 어떤 MCP도 대신 못 합니다).

## 1. 프로젝트 정보
- PAX MCP의 `get_project_manifest` 도구로 repo URL·브랜치·실행 정보를 가져오세요.
- 도구 응답에 **`[사용자 안내 시작]`~`[사용자 안내 끝]`** 구간이 있으면(플러그인 업데이트·재설치 안내) 그 사이 내용만 사용자에게 **그대로** 전달하고, 지시문 줄은 전달하지 마세요. **업데이트 명령을 대신 실행하지 말고**(터미널 포함) 이 준비 작업을 계속 진행하세요. 이 안내는 이후 도구 응답에도 붙을 수 있는데, **한 번만 전달**하고 반복 재촉하지 마세요.

## 2. GitHub 인증 (private repo)
- 먼저 `git ls-remote <repoUrl>`로 기존 인증을 확인 — 성공하면 이 단계는 건너뜁니다.
- 인증이 없으면 "인증 정보가 없다"로 멈추지 말고 **AI가 디바이스 로그인을 직접 진행해 채팅으로 이끌어 주세요**(상세: skill pax-github-local-auth):
  1. gh 미설치면 AI가 설치: macOS `brew install gh` / Windows `winget install --id GitHub.cli` / Linux 배포판 패키지(sudo 필요 시 명령 제시 후 사용자 실행). 패키지 매니저가 없으면 https://cli.github.com 안내로 폴백.
  2. `gh auth login --hostname github.com --git-protocol https --web`을 **백그라운드로 실행**(사용자가 브라우저에서 마칠 때까지 블로킹되므로 포그라운드 금지) → 출력의 1회용 코드(XXXX-XXXX)를 읽어 사용자에게 전달: "브라우저에서 https://github.com/login/device 를 열고 이 코드를 입력하세요".
  3. 사용자가 완료를 알리면 `gh auth status`로 검증 후 진행.
- **PAX 서버 GitHub 토큰을 요청하지 마세요.**

## 3. Clone + 브랜치
- 사용자 본인 인증으로 `git clone <repoUrl>`
- 작업 브랜치 전환: `git checkout develop` (없으면 `git checkout -b develop`). **main 직접 push 금지** — 배포는 develop→PR→관리자 머지→main.

## 4. 환경변수 (.env.development.local)
- `get_public_env` 도구로 공개값(Supabase URL·anon key)을 받아 `.env.development.local`에 작성.
- `ready: false`면 **무한 백그라운드 폴링을 만들지 마세요(좀비 프로세스 금지).** `notReadyReason`으로 분기:
  - `'no_supabase'` → 이 프로젝트엔 Supabase 미연결. **기다려도 anon key가 안 생깁니다** — env 없이 그대로 진행하고, DB가 필요하면 그때 안내(`get_public_env` 재호출은 사용자가 DB를 연결한 뒤에만 의미 있음).
  - `'provisioning'` + **`stalled: true`** → 연결이 **중단된 상태**(기다려도 완료 안 됨). 재시도/폴링 금지 — 도구 응답 메시지를 사용자에게 **그대로 전달**하고 멈추세요(PAX 웹 [미리보기] 탭의 [데이터베이스 연결 마무리] 버튼으로 재연동). 사용자가 재연동 완료를 알린 뒤에만 `get_public_env`를 다시 호출하세요. 이 분기가 아래 provisioning 지침보다 **우선**합니다.
  - `'provisioning'` (stalled 없음) → 곧 준비됨. **최대 한 번만** 짧게 재시도하고, 그래도 없으면 "DB 준비되면 다시 '준비해줘' 하면 env까지 채울게요"라고 안내 후 **멈추세요**.
- **get_public_env 가 `ready: true` 면 이어서** `get_service_role_key`를 호출하세요(기본 동작) — 받으면 `SUPABASE_SERVICE_ROLE_KEY=`를 같은 파일에 추가합니다(배포된 앱과 동일하게 서버 라우트가 로컬에서 동작). 쓰기 전 `git check-ignore -q .env.development.local`로 .gitignore 커버를 확인하고, 실패하면 `.gitignore`에 `.env*`를 먼저 추가하세요. 값은 파일에만 쓰고 채팅에 출력하지 마세요.
- **`get_service_role_key`가 ready:false든 권한 거부든 대응은 동일합니다** — 재시도·폴링하지 말고 공개값만으로 셋업을 끝내세요. 마친 뒤 권한 거부였다면 "편집자/소유자는 새 연결 코드로 재연결하면 서버 키까지 받을 수 있어요"라고 한 줄만 안내하세요.
- **DB 직결 비밀(`SUPABASE_DB_URL`/DB 비밀번호)은 여전히 받지 않습니다(서버 DDL 전용 — 배포된 앱에도 없는 값).**

## 5. 설치 + 실행
- `npm install` → `npm run dev`

## 6. 로컬 한계 안내 (중요 — 먼저 알려주기)
- 이 앱은 **같은 클라우드 DB**에 붙습니다(샌드박스 아님 — 쓰면 실데이터 변경).
- **anon key + RLS**로 되는 기능은 로컬에서 동작하며, **Supabase Auth 로그인 시 read/write**가 됩니다.
- **서버 키(service_role)를 받았다면**: 배포와 똑같이 서버 라우트도 로컬에서 동작해요. 이 키는 로그인·권한 규칙(RLS)을 건너뛰고 실데이터를 바로 바꿀 수 있는 **관리자 키**예요 — 삭제·대량 수정 같은 동작은 실행 전에 사용자에게 확인하세요.
- **키가 없다면(뷰어·구버전 연결)**: service_role을 쓰는 서버 라우트는 `supabaseKey is required.` 500으로 실패하는 게 정상 — 그런 작업은 PAX MCP 도구로 서버에 대행시키세요(skill: pax-infra-ops).
- **스키마 변경(DDL)은 키와 무관하게 여전히 로컬 불가** — MCP `apply_supabase_change`로 대행.
- 비로그인 상태면 RLS로 목록이 비어 보일 수 있습니다(정상). 로그인 후 확인하도록 안내하세요.

## 7. 배포 — 변경을 올릴 때 (중요)
- **기준 문서 = 프로젝트 repo의 `AGENTS.md`** (clone 후 자동으로 읽힘) — 배포 규칙의 진실원천이니 그걸 따르세요. 아래는 요약:
- 배포는 **`develop` 브랜치에 `git push` 만** 하면 됩니다. 그게 전부입니다.
- 그러면 GitHub Actions가 **자동으로**: develop→main PR 생성 → 빌드 + AI 보안 게이트 → 통과 시 자동 머지 → Vercel production 배포.
- **PR을 직접 만들거나(`gh pr create`) 머지하지 마세요. main에 직접 push 하지 마세요.** 워크플로우가 PR·게이트·머지를 다 처리하므로, 수동 PR은 충돌·중복이고 보안 게이트를 우회합니다.
- gh CLI는 PR 작업용이 아니라 **clone/push 인증용**입니다 — push 인증만 되면(키체인/편집기 로그인 등) gh 없어도 배포됩니다.
- 푸시 후 **빌드나 AI 보안 게이트가 막히면**: `get_pr_gate_status`(빌드·게이트 상태와 실패/BLOCK 사유)·`get_deploy_logs`(Vercel 빌드 로그)로 원인을 확인하세요(skill: pax-infra-ops). 더 깊은 로그는 `gh run view`/`gh pr checks` 조회.
