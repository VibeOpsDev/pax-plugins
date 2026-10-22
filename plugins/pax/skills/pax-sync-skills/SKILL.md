---
name: pax-sync-skills
description: "PAX(preview) · 이 프로젝트의 회사·개인 PAX 스킬을 최신 내용으로 맞춥니다. 사용자가 \"스킬 업데이트해줘\", \"스킬 동기화\", \"PAX 스킬 새로 받아줘\", \"관리자가 스킬 바꿨대\" 를 요청할 때 사용. (Codex 의 기본 경로 — Claude 에선 /pax-preview:sync-skills 명령도 가능하고, Claude Code 를 새로 열 때 자동으로도 맞춰진다.)"
user-invocable: false
---
# PAX 스킬 동기화

프로젝트 폴더의 PAX 스킬(`.claude/skills/pax-*`·`.agents/skills/pax-*`)을 PAX에 등록된 최신 내용으로 맞춥니다. 관리자가 끈 스킬은 지워지고, 이 PC 에서 고쳐진 사본은 되돌리기 전에 보관됩니다.

## 실행
프로젝트 폴더(git clone 한 폴더)에서:
```bash
node "${CLAUDE_PLUGIN_ROOT:-$PLUGIN_ROOT}/bin/vibeagent-sync-skills.mjs" --project-dir "<프로젝트 폴더>"
```
- Codex 에서 두 환경변수가 모두 없으면 **이 SKILL.md 가 있는 폴더 기준 `../../bin/vibeagent-sync-skills.mjs`** 경로를 쓰세요.

## 결과 전달
- 출력 마지막 줄(`[스킬 동기화] 추가 n 갱신 m 삭제 k 건너뜀 s`)을 사용자에게 한 줄로 알리세요. `(주의)` 줄이 있으면 함께 전하세요.
- `not_connected:` → "연결이 만료됐거나 이 폴더가 연결되지 않았어요. 다시 연결하면 스킬도 함께 받아요." 와 함께 연결 방법(Claude Code 는 `/pax-preview:connect`, Codex 는 `/pax-preview:pax-connect`)을 안내하세요.
- `not_git_repo:`·`no_github_remote:` → 프로젝트를 clone 한 폴더에서 다시 실행하라고 안내하세요.
- `sandbox:` → "샌드박스를 끄거나 터미널에서 실행" 을 안내하세요.

## 지킬 것
- `pax-*` 스킬 파일은 **고치거나 지우지 마세요** — 다음 동기화 때 되돌아가고, 고친 내용은 다른 구성원에게 전달되지도 않습니다.
- 사용자가 스킬 내용을 바꾸길 원하면: 회사 스킬은 PAX 관리자에게 요청하고, 개인 스킬은 PAX 채팅 입력창의 ＋ → 도구 관리 → 내 도구에서 고치도록 안내하세요. 이 프로젝트에만 필요한 보완은 `pax-`로 시작하지 않는 새 스킬로 만드세요.
