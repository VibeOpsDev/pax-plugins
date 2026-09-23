---
name: pax-local-setup
description: "PAX(preview) · PAX 프로젝트를 로컬에 clone하고 환경변수를 설정한 뒤 개발 서버를 실행합니다. \"프로젝트 로컬 세팅\", \"이 프로젝트 클론해서 실행\", \"로컬 개발 준비\" 같은 요청에 사용."
---
# PAX 로컬 개발 준비

사용자가 PAX 프로젝트를 로컬에서 이어 개발하려 합니다. 다음 순서로 진행하세요.

## 0. 전제
- private repo 를 clone/push 하려면 이 PC 의 GitHub 인증(GitHub CLI `gh` 권장)이 필요합니다(PAX 연결 자체에는 필요 없음). `git ls-remote <repoUrl>` 이 성공하면 이미 준비된 것. 없으면 **`pax-github-local-auth`** 절차(설치 → `gh auth login … --web` 백그라운드 → 코드 안내 → `gh auth setup-git`)를 먼저 마치세요.
- PAX MCP에 연결돼 있어야 합니다(`/pax-preview:connect` 완료 — 코드 없음, 브라우저에서 프로젝트 선택). 연결이 없으면 먼저 안내하세요.
- 로컬에 `git`, `node`, `npm`이 필요합니다(`npm install`/`npm run dev`). 없으면 설치를 안내하세요(이건 어떤 MCP도 대신 못 합니다).

## 1. 프로젝트 정보
- PAX MCP의 `get_project_manifest` 도구로 repo URL·브랜치·실행 정보를 가져오세요. **연결이 끝난 뒤에 새로 호출**하세요 — 연결 전에 받아 둔 매니페스트가 있어도 버립니다.
- **대조(이 대화에서 `PAX 연결 완료: <저장소>` 를 받았을 때만)**: 그 저장소와 매니페스트의 `repoUrl` 이 **다르면 진행하지 말고** 사용자에게 두 값을 보여 준 뒤 멈추세요(다른 세션·폴더의 연결이 섞인 것 — 이 폴더에서 `/pax-preview:connect` 를 다시 하거나 그 프로젝트 폴더를 여세요). 이 대화에 연결 출력이 없으면(다른 대화에서 연결해 둔 폴더를 새로 연 경우 — 옆 폴더에 내려받은 뒤 새 대화로 온 경우가 대표적) 다시 연결하라고 하지 말고 다음 항목의 폴더 remote 대조만 하세요. 도구가 "이 폴더는 아직 PAX 에 연결되지 않았어요" 라고 답할 때만 `/pax-preview:connect` 를 안내하고 멈추세요.
- 이미 저장소 폴더 안이면 `git config --get remote.origin.url` 과 매니페스트 `repoUrl` 이 **같은 프로젝트**인지 확인하세요. 다르면(특히 Codex — 최근 연결이 쓰임) 사용자에게 "지금 폴더는 A 인데 연결은 B" 를 알리고 어느 쪽으로 갈지 물은 뒤 진행하세요.
- 도구 응답에 **`[사용자 안내 시작]`~`[사용자 안내 끝]`** 구간이 있으면(플러그인 업데이트·재설치 안내) 그 사이 내용만 사용자에게 **그대로** 전달하고, 지시문 줄은 전달하지 마세요. **업데이트 명령을 대신 실행하지 말고**(터미널 포함) 이 준비 작업을 계속 진행하세요. 이 안내는 이후 도구 응답에도 붙을 수 있는데, **한 번만 전달**하고 반복 재촉하지 마세요.

## 2. GitHub 인증 (private repo)
- 0번에서 마쳤으면 건너뜁니다. `git ls-remote <repoUrl>` 이 실패하면 `gh auth setup-git` 을 실행(멱등 — 비대화형 로그인은 git 자격증명 연결을 건너뛰어 `gh` 가 로그인돼 있어도 clone 이 실패합니다)하고 다시 확인하세요. 그래도 안 되면 skill pax-github-local-auth 절차 전체.
- **PAX 서버 GitHub 토큰을 요청하지 마세요.**

## 3. Clone + 브랜치 + 스킬
- 사용자 본인 인증으로 `git clone <repoUrl>` — **이미 그 저장소의 clone 폴더 안이면(remote 가 매니페스트 `repoUrl` 과 같음) clone 을 생략**하고 그 폴더에서 계속합니다(연결 스크립트가 옆 폴더에 미리 내려받아 둔 경우가 이렇습니다).
- 작업 브랜치 전환: `git checkout develop` (없으면 `git checkout -b develop`). **main 직접 push 금지** — 배포는 develop→PR→관리자 머지→main.
- clone 직후 **회사·개인 스킬을 프로젝트 폴더로 내려받으세요**(연결 스크립트가 같은 폴더에서 실행됐다면 이미 됐을 수 있음 — 다시 실행해도 안전):
  ```bash
  node "${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}/bin/vibeagent-sync-skills.mjs" --project-dir "<clone 폴더>"
  ```
  출력 `[스킬 동기화] 추가 n …` 을 사용자에게 한 줄로 알리세요. 스킬은 `.claude/skills/pax-*`(Claude)·`.agents/skills/pax-*`(Codex) 에 놓이며 `git status` 에 보이지 않습니다(`.git/info/exclude`). `sandbox:` 로 실패하면 "샌드박스를 끄거나 터미널에서 실행" 을 안내하세요. Claude Code 는 새 스킬 폴더를 곧 인식합니다(안 보이면 `/reload-skills`).

## 4. 환경변수 (.env.development.local)
- `get_public_env` 도구를 호출하세요. 응답은 두 묶음입니다 — **`publicKeys`**(앱 공개 설정값: `NEXT_PUBLIC_*`/`VITE_*`·`PORTAL_URL`·`SSO_SERVICE_ID`, **Supabase 연결 여부와 무관**)와 **Supabase 공개값**(`supabaseUrl`·`anonKey`, `ready: true` 일 때만).
- **`publicKeys` 가 하나라도 있으면 `.env.development.local` 을 항상 씁니다**(키=값 그대로). Supabase 미연결이라고 env 를 통째로 건너뛰지 마세요 — 미연결은 "DB 블록만 없음" 입니다.
- Supabase 블록(`NEXT_PUBLIC_SUPABASE_URL`·`NEXT_PUBLIC_SUPABASE_ANON_KEY`)은 `ready: true` 일 때만 같은 파일에 추가합니다. `ready: false` 면 **무한 백그라운드 폴링을 만들지 마세요(좀비 프로세스 금지).** `notReadyReason` 으로 분기:
  - `'no_supabase'` → 이 프로젝트엔 Supabase 미연결. **기다려도 anon key 가 안 생깁니다** — `publicKeys` 만 쓰고 DB 블록 없이 진행하고, DB 가 필요하면 그때 안내(`get_public_env` 재호출은 사용자가 DB 를 연결한 뒤에만 의미 있음).
  - `'provisioning'` + **`stalled: true`** → 연결이 **중단된 상태**(기다려도 완료 안 됨). 재시도/폴링 금지 — 도구 응답 메시지를 사용자에게 **그대로 전달**하고 멈추세요(PAX 웹 [미리보기] 탭의 [데이터베이스 연결 마무리] 버튼으로 재연동).
  - `'provisioning'` (stalled 없음) → 곧 준비됨. **최대 한 번만** 짧게 재시도하고, 그래도 없으면 "DB 준비되면 다시 '준비해줘' 하면 env까지 채울게요"라고 안내 후 **멈추세요**.
  - `'env_error'` → 설정값 파일 복호 실패(미연결 아님). 재연결 유도 금지, 관리자 문의를 안내하고 멈추세요.
- 그다음 `list_vercel_env` 로 배포 환경변수 **키 이름**을 조회해(값은 안 옵니다), 아직 로컬 파일에 없는 키가 있으면 사용자에게 알리세요: "다음 값은 비밀이라 자동으로 내려오지 않아요 — PAX 화면의 **설정값** 메뉴에서 확인해 `.env.development.local` 에 직접 넣어 주세요: `KEY1`, `KEY2`". **값을 추측해 넣지 마세요**(빈 값도 쓰지 마세요). Vercel 미연결(`connected: false`)이면 이 단계는 생략.
- `publicKeys` 에 `SSO_SERVICE_ID` 가 있으면 pable studio 로그인 앱입니다 — `SSO_SECRET` 은 내려오지 않으니 `pax-sso` 스킬의 로컬 규칙대로 `DEV_BYPASS_SSO=true` 를 함께 넣어 로그인 화면이 로컬에서 돌게 하세요(실제 pable studio 왕복은 배포에서만).
- **get_public_env 가 `ready: true` 면 이어서** `get_service_role_key`를 호출하세요(기본 동작) — 받으면 `SUPABASE_SERVICE_ROLE_KEY=`를 같은 파일에 추가합니다(배포된 앱과 동일하게 서버 라우트가 로컬에서 동작). 이 키는 `.env.development.local` 밖으로 옮기지 말고 커밋·공유하지 마세요(`pax-secret-safety`).
- **`get_service_role_key`가 ready:false든 권한 거부든 대응은 동일합니다** — 재시도·폴링하지 말고 공개값만으로 셋업을 끝내세요. 마친 뒤 권한 거부였다면 "편집자/소유자는 `/pax-preview:connect` 로 재연결하면 서버 키까지 받아요" 라고 한 줄 안내하세요.
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
