/**
 * 스킬 본문 셸 디렉티브 차단 — 서버 `src/lib/skillDirectiveGuard.ts` 의 **사본**(런타임이 달라 import 불가).
 * `// @sync:SHELL_DIRECTIVE_RE` 다음 줄을 `scripts/generate-plugin-files.mjs` 가 서버 파일과 문자열 비교한다 — 동시 수정.
 * Claude Code 는 디스크 SKILL.md 의 !`cmd` · ```! 블록을 주입 전에 **실행**하므로 동기화 클라이언트가 마지막으로 한 번 더 거른다.
 */

// @sync:SHELL_DIRECTIVE_RE
export const SHELL_DIRECTIVE_RE = /(^|[^\\])!`[^`]*`|(^|\n)[ \t]*(?:```+|~~~+)[ \t]*!/;

export function containsShellDirective(text) {
  return SHELL_DIRECTIVE_RE.test(String(text ?? ''));
}
