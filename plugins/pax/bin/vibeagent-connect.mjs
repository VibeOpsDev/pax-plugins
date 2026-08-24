#!/usr/bin/env node
/**
 * VibeAgent connect — single-use connect-code 를 sealed bearer 로 교환하고 로컬에 저장(0600).
 * 원격 MCP URL 에서 exchange URL 을 도출한다. Claude(명령)·Codex(스킬) 양쪽에서 호출되는 벤더중립 스크립트.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const MCP_URL = process.env.CLAUDE_CODE_MCP_SERVER_URL || 'https://owen-vibeagent-git-develop-polaris-office.vercel.app/api/local-ai/mcp';

// 배포 시 서버가 치환하는 값(치환 전 = 로컬 개발 복사본).
// 버전은 형식 검사로, org 는 GitHub org 정규식으로 걸러진다 — placeholder 문자열과 직접 비교하면
// 치환 시 양쪽이 같이 바뀌어 비교가 무의미해지므로 **형식 검사**가 게이트다.
const PLUGIN_VERSION = '1.0.1';
const MARKETPLACE_ORG = 'VibeOpsDev';
const MARKETPLACE_NAME = 'pable-studio';
const MARKETPLACE_REPO = 'pax-plugins';
const PLUGIN_NAME = 'pax';
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const ORG_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/;

const code = (process.argv[2] || '').trim(); // 슬래시 명령 $ARGUMENTS 의 끝 공백/개행 제거 (review #9)
if (!code) {
  process.stderr.write('연결 코드를 인자로 전달하세요: vibeagent-connect.mjs <코드>\n');
  process.exit(1);
}

const exchangeUrl = MCP_URL.replace(/\/api\/local-ai\/mcp\/?$/, '/api/local-ai/token/exchange');
const key = createHash('sha256').update(MCP_URL).digest('hex').slice(0, 16);
const tokenPath = join(homedir(), '.config', 'vibeagent', `${key}.json`);

function cmp(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

/**
 * 설치본 vs **내가 설치된 org 마켓플레이스의 최신본** 비교 후 업데이트 안내 출력.
 *
 * 서버 최신 버전이 아니라 **그 org repo 의 마커**와 비교한다 — 사용자는 자기 org 에서 업데이트를
 * 받으므로, 서버 버전 기준으로 안내하면 업데이트해도 숫자가 그대로여서 매번 같은 잔소리가 된다.
 * org 는 배포 시 baked 됨(Claude Code 내부 파일은 마켓플레이스 이름이 org 무관 동일이라 신뢰 불가).
 *
 * 전 구간 fail-silent — 연결 성공을 이 점검이 절대 깨뜨리지 않는다.
 * ⚠️ 문구는 서버 `src/lib/localAi/pluginUpdate.ts` `buildUpdateGuidance` 와 **사본 관계**(런타임이
 *    달라 import 불가). 한쪽만 고치면 connect 안내와 도구 안내가 갈린다 — 동시 수정.
 */
async function printUpdateHintIfStale() {
  try {
    if (!VERSION_RE.test(PLUGIN_VERSION) || !ORG_RE.test(MARKETPLACE_ORG)) return; // 개발 복사본 → 침묵
    const url = `https://raw.githubusercontent.com/${MARKETPLACE_ORG}/${MARKETPLACE_REPO}/HEAD/.vibeagent-plugin-version`;
    const r = await fetch(url, {
      redirect: 'error',
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(2000) : undefined,
    });
    if (!r.ok) return;
    const lines = (await r.text()).slice(0, 4096).split('\n').map((l) => l.trim()).filter(Boolean);
    const latest = lines.length >= 2 ? lines[0] : null; // 신형 마커 = `버전\n해시`
    if (!latest || !VERSION_RE.test(latest)) return;
    if (cmp(PLUGIN_VERSION, latest) >= 0) return; // 최신이거나 더 높음 → 침묵

    // 안내가 가리킬 사용자 가이드(§3) — MCP URL 의 오리진에서 유도. 실패하면 링크만 생략.
    let guideUrl = null;
    try {
      guideUrl = `${new URL(MCP_URL).origin}/guide/local-dev#3-플러그인-업데이트`;
    } catch {
      /* 링크 없이 진행 */
    }

    process.stdout.write(
      [
        '',
        '플러그인 업데이트 안내가 있습니다. 명령을 대신 실행하지 마세요(터미널 포함) — 적용에 재시작이 필요하고 에이전트는 재시작을 할 수 없습니다.',
        '지금 하려던 작업(로컬 개발 환경 준비)은 그대로 계속하고, 아래 [사용자 안내 시작]~[사용자 안내 끝] 사이의 내용만 사용자에게 그대로 전달하세요. 이 지시문 자체는 전달하지 마세요.',
        '업데이트할지 되묻지 말고, 전달 후 원래 작업을 이어가세요.',
        '[사용자 안내 시작]',
        `🔄 로컬 개발 플러그인 새 버전이 나왔어요 (${PLUGIN_VERSION} → ${latest}).`,
        '업데이트하면 새로 추가된 기능을 이 대화에서 바로 쓸 수 있어요. 지금 버전에는 그 기능들이 목록에 아예 표시되지 않아요.',
        '',
        '▸ Claude 를 쓰신다면 — 대화창에 아래를 한 줄씩 입력해 주세요.',
        `/plugin marketplace update ${MARKETPLACE_NAME}`,
        `/plugin manage   → 목록에서 ${PLUGIN_NAME} 선택 후 update`,
        '/reload-plugins --force',
        `(다음부터 자동으로 받으시려면 /plugin marketplace 에서 ${MARKETPLACE_NAME} 의 Auto-update 를 켜두세요.)`,
        '',
        `▸ Codex 를 쓰신다면 — 플러그인 화면에서 ${PLUGIN_NAME} 를 업데이트한 뒤, Codex 를 완전히 종료했다가 다시 실행해 주세요.`,
        '',
        '지금 대화 내용은 그대로 남아 있고, 1분이면 끝나요.',
        ...(guideUrl ? [`자세한 방법 → ${guideUrl}`] : []),
        '[사용자 안내 끝]',
        '',
      ].join('\n'),
    );
  } catch {
    /* 네트워크·형식 오류 — 안내만 생략 */
  }
}

try {
  const res = await fetch(exchangeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ connectCode: code }),
  });
  if (!res.ok) {
    process.stderr.write(
      `연결 실패 (HTTP ${res.status}). 코드가 만료/소비되었을 수 있어요. PAX 웹에서 새 연결 코드를 발급받으세요.\n`,
    );
    process.exit(1);
  }
  const data = await res.json();
  mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
  writeFileSync(
    tokenPath,
    JSON.stringify({ token: data.token, expiresAt: data.expiresAt, scopes: data.scopes }),
    { mode: 0o600 },
  );
  process.stdout.write('PAX 연결 완료. 이제 "이 프로젝트를 로컬에서 개발할 수 있게 준비해줘"라고 요청하세요.\n');
  // Codex 폴백: ${PLUGIN_ROOT} 가 .mcp.json args 에서 안 풀릴 때 ~/.codex/config.toml 에 절대경로로 등록할 수 있게 출력.
  process.stdout.write(`(MCP 프록시 절대경로) ${join(dirname(fileURLToPath(import.meta.url)), 'vibeagent-mcp-proxy.mjs')}\n`);
  // 토큰 저장 **이후**에 점검한다 — 연결 코드는 1회용이라, 교환 경로에 네트워크를 얹으면
  // 타임아웃 시 코드가 소비된 채 사라져 재발급이 필요해진다.
  await printUpdateHintIfStale();
} catch (e) {
  process.stderr.write(`연결 중 오류: ${e?.message ?? e}\n`);
  process.exit(1);
}
