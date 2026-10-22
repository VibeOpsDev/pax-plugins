---
description: "PAX(preview) · 이 프로젝트의 회사·개인 스킬을 PAX에 등록된 최신 내용으로 맞춥니다(관리자가 스킬을 바꿨을 때)."
allowed-tools: Bash(node "*/bin/vibeagent-sync-skills.mjs"*)
---
이 프로젝트 폴더의 PAX 스킬(`.claude/skills/pax-*`·`.agents/skills/pax-*`)을 PAX에 등록된 내용으로 맞춥니다. Claude Code 를 새로 열 때도 자동으로 맞춰지지만, 지금 바로 받고 싶을 때 씁니다.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/vibeagent-sync-skills.mjs"
```

- 출력 마지막 줄(`[스킬 동기화] 추가 n 갱신 m 삭제 k 건너뜀 s`)을 사용자에게 한 줄로 알리세요. `(주의)` 줄이 있으면 함께 전하세요(이 PC 에서 고쳐진 스킬을 되돌리고 보관한 위치 등).
- `not_connected:` 로 끝나면 "연결이 만료됐거나 이 폴더가 연결되지 않았어요. `/pax-preview:connect` 로 다시 연결하면 스킬도 함께 받아요." 라고 안내하세요.
- `sandbox:` 로 끝나면 "샌드박스를 끄거나 터미널에서 실행" 을 안내하세요.
- 새 스킬이 보이지 않으면 `/reload-skills` 를 실행하라고 안내하세요.
- `pax-*` 스킬 파일은 고치지 마세요 — 다음 동기화 때 되돌아갑니다. 내용을 바꾸려면 회사 스킬은 PAX 관리자에게, 개인 스킬은 PAX 채팅 입력창의 ＋ → 도구 관리 → 내 도구에서 고치도록 안내하세요.
