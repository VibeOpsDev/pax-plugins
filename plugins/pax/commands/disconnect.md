---
description: "PAX(preview) · 이 프로젝트의 PAX 연결을 끊습니다(서버 취소 + 토큰 파일 삭제)."
allowed-tools: Bash(node "*/bin/vibeagent-connect.mjs"*)
---
현재 폴더의 PAX 연결을 끊습니다.

1. 먼저 `pable-pax-preview` MCP 의 **`disconnect`** 도구를 호출해 서버에서 토큰을 취소하세요(도구가 "연결되어 있지 않아요"·만료라고 답해도 그대로 2번으로).
2. 로컬 토큰 파일을 지웁니다:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/vibeagent-connect.mjs" --disconnect
```

3. 출력(`끊음: owner/name` 또는 `이 폴더에 연결된 프로젝트 토큰이 없어요.`)을 사용자에게 한 줄로 알리고, "다시 쓰려면 `/pax-preview:connect` 를 실행하세요." 를 덧붙이세요. 프로젝트 폴더에 내려온 스킬(`.claude/skills/pax-*`)은 지우지 않습니다(다음 연결 때 갱신됩니다).
