---
name: pax-github-local-auth
description: 로컬에서 private GitHub repo를 clone/push 하기 위한 GitHub 인증 안내. "GitHub 로그인", "clone 권한 없음", "push가 안 됨" 등에 사용.
---
# 로컬 GitHub 인증

private repo는 **사용자 본인의 GitHub 인증**으로 clone/push 합니다. PAX 서버는 GitHub 토큰을 내려주지 않습니다.

- 확인: `git ls-remote <repoUrl>` 성공 = 인증 있음(여기서 끝). 실패 시에만 아래 진행.
- gh 미설치면 **AI가 직접 설치하세요**: macOS `brew install gh` / Windows `winget install --id GitHub.cli` / Linux 배포판 패키지(sudo 필요 시 명령 제시 후 사용자 실행). 패키지 매니저 없으면 https://cli.github.com 안내로 폴백.
- 로그인은 **AI가 디바이스 플로우를 돌려 채팅으로 유도**하세요 — "로그인하세요"로 끝내지 말 것:
  1. `gh auth login --hostname github.com --git-protocol https --web`을 **백그라운드로 실행**(완료까지 블로킹되므로 포그라운드 금지).
  2. 출력의 1회용 코드(XXXX-XXXX)를 사용자에게 전달: "브라우저에서 https://github.com/login/device 를 열고 이 코드를 입력하세요."
  3. 완료 답을 받으면 `gh auth status`로 검증. (코드는 약 15분 후 만료 — 만료 시 같은 명령 재실행.)
  - 백그라운드 실행이 안 되는 환경이면 같은 명령을 사용자가 터미널에 직접 붙여넣도록 안내. 편집기(VS Code 등)의 GitHub 로그인도 대안.
- push는 **develop 브랜치로만**. main 직접 push 금지(Vercel 비멤버 author 차단 + 배포 정책).
- gh CLI는 **clone/push 인증 + 조회 전용**입니다. **조회는 허용** — `gh run list`/`gh run view`/`gh pr checks`/`gh pr view --comments` 로 빌드·게이트 로그를 더 깊이 볼 수 있습니다(인프라 디버깅용). 하지만 **PR 생성·머지(`gh pr create`/`gh pr merge`)는 금지** — develop에 push 하면 워크플로우가 PR·보안 게이트·머지를 자동 처리합니다(수동 PR은 충돌·게이트 우회).
- 권한 오류(403/404)면 사용자의 GitHub 계정이 해당 org repo 멤버인지, SAML SSO 인가가 유효한지 확인하도록 안내.
- **PAX 서버의 GitHub 토큰을 요청하지 마세요.**
