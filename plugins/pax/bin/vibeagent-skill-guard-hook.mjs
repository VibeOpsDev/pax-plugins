#!/usr/bin/env node
/**
 * PreToolUse 훅(2.0.4) — 로컬 AI 가 PAX 관리 스킬 사본(`.claude/skills/pax-*`·`.agents/skills/pax-*`)을 편집하지 못하게 막는다.
 *
 * 동기화가 사본을 서버 내용으로 되돌리므로, 고쳐 봐야 다음 번에 사라지고 관리자·다른 구성원에게도 전달되지 않는다.
 * 사용자가 내용을 바꾸고 싶어 하면 바꾸는 곳(회사 스킬 = 관리자, 개인 스킬 = PAX 도구 관리 › 내 도구)을 안내하게 한다.
 *
 * 규칙:
 *  - 출력은 **거부(deny) 또는 무출력** 둘뿐이다. `allow` 는 절대 내지 않는다 — allow 는 사용자 권한 확인을 건너뛰게 한다.
 *  - 모든 오류는 무출력 exit 0(fail-open) — 이 훅의 결함이 일반 편집을 막으면 안 된다.
 *  - 편집기 직접 수정·Bash 우회는 막지 않는다. 실수 방지용이지 보안 경계가 아니다.
 *  - node 내장만 쓴다(편집마다 실행되므로 빠르게 뜨고 끝나야 한다).
 */
import { lstatSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const NAME_RE = /^pax-[a-z][a-z0-9-]*[a-z0-9]$/;
const MARKER = '.pax-managed';
const REASON =
  'PAX가 관리하는 스킬 사본이라 고칠 수 없어요 — 다음 동기화 때 PAX에 등록된 내용으로 되돌아가요. ' +
  'Bash 등 다른 방법으로 우회하지 말고, 사용자가 이 스킬을 바꾸길 원하면 안내하세요: 회사 스킬은 PAX 관리자에게 요청하고, ' +
  '개인 스킬은 PAX 채팅 입력창의 ＋ → 도구 관리 → 내 도구에서 고쳐요. 이 프로젝트에만 필요한 보완은 `pax-`로 시작하지 않는 새 스킬로 만드세요.';

async function readInput() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  const done = new Promise((res) => {
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', res);
    process.stdin.on('error', res);
  });
  // 대기 타이머는 반드시 치운다 — 남겨 두면 입력이 바로 끝나도 프로세스가 1초를 더 살아 편집할 때마다 1초씩 늦어진다.
  let timer;
  await Promise.race([done, new Promise((r) => { timer = setTimeout(r, 1000); })]);
  clearTimeout(timer);
  try { process.stdin.destroy(); } catch { /* ignore */ }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}

/** 경로가 관리 사본 폴더 안인가 — 구성요소를 대소문자 무시로 대조하고, 그 폴더에 마커가 일반 파일로 있어야 한다. */
function isManagedSkillPath(filePath, cwd) {
  if (typeof filePath !== 'string' || !filePath) return false;
  const abs = resolve(typeof cwd === 'string' && cwd ? cwd : process.cwd(), filePath);
  const segs = abs.split(sep);
  for (let i = 0; i + 2 < segs.length; i++) {
    const a = segs[i].toLowerCase();
    const b = segs[i + 1].toLowerCase();
    if ((a === '.claude' || a === '.agents') && b === 'skills' && NAME_RE.test(segs[i + 2].toLowerCase())) {
      const skillDir = segs.slice(0, i + 3).join(sep) || sep;
      try {
        if (lstatSync(`${skillDir}${sep}${MARKER}`).isFile()) return true;
      } catch { /* 마커 없음 = PAX 사본 아님 */ }
    }
  }
  return false;
}

try {
  const input = await readInput();
  const toolInput = input && typeof input === 'object' ? input.tool_input : null;
  const target = toolInput && typeof toolInput === 'object' ? (toolInput.file_path ?? toolInput.notebook_path) : null;
  if (isManagedSkillPath(target, input?.cwd)) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: REASON },
    }));
  }
} catch {
  /* fail-open */
}
process.exitCode = 0;
