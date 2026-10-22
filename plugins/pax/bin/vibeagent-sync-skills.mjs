#!/usr/bin/env node
/**
 * 스킬 동기화(2.0.0 · 자동 갱신·보호 2.0.4) — `get_project_skills` 번들을 저장소 최상위의 `.claude/skills/pax-*`(Claude Code)·
 * `.agents/skills/pax-*`(Codex) 에 쓴다.
 *
 * 실행 모드:
 *  - CLI(기본): 연결 직후(`vibeagent-connect.mjs`)·로컬 세팅 스킬·`/pax-preview:sync-skills` 가 부른다. 출력 마지막 줄
 *    `[스킬 동기화] 추가 n 갱신 m 삭제 k 건너뜀 s`, 종료 코드 계약(2 폴더·3 미연결·1 번들·5 샌드박스)은 2.0.0 그대로.
 *  - `--hook`: Claude Code 를 열 때(SessionStart 훅, hooks/pax-hooks.json). **항상 exit 0**, 출력은 JSON 한 번
 *    (`systemMessage` = 사용자에게 보이는 안내, `hookSpecificOutput.additionalContext` = 모델에게 주는 규칙).
 *    CLI 동기화가 한 번이라도 성공한 폴더(등록부 `synced-folders.json`)에서만 동작한다 — 폴더의 remote·`.git` 은 내려받은 폴더가
 *    마음대로 적을 수 있어, 등록부 없이 돌면 사용자 조작 없이 남의 폴더에 쓰게 된다.
 *
 * 안전 규칙:
 *  - git 저장소가 아니면 거부(추적 검사·exclude 불가). remote 가 GitHub 가 아니면 거부(토큰 선택 불가). git 호출은 `core.fsmonitor=false`.
 *  - 디렉터리 이름 `^pax-[a-z][a-z0-9-]*[a-z0-9]$`. 참조 경로는 `references/…` 만, 세그먼트에 `..`·`:`·`\`·Windows 예약 이름·끝 점/공백 금지.
 *  - `<dir>` 부터 대상까지 **모든 구성요소를 lstat** — 하나라도 심볼릭 링크면 그 스킬 skip(reason symlink). realpath 봉인.
 *  - git 이 추적 중인 경로(`git ls-files`)는 덮어쓰지 않고 경고. 파일 0644(실행 비트 없음).
 *  - 삭제는 `.pax-managed` 마커가 일반 파일인 `pax-*` 디렉터리만. degraded·도구 오류(킬스위치 deny 포함)면 삭제 0건. skipped 이름은 삭제 제외.
 *  - 교체는 `pax-x.new-<pid>` 조립 → 기존 `.old-<pid>` rename → new→final → old 삭제. 캡 50개·1MB·파일당 100KB. 셸 디렉티브 재검사.
 *  - 잠금·안내 스탬프·보관본은 저장소 밖 `~/.config/vibeagent/<instance>/state/<폴더 해시>/`(0700) — `.git` 아래에 두면
 *    `.git` 파일의 `gitdir:` 이나 심볼릭 링크로 홈의 다른 파일을 덮어쓰는 경로가 된다.
 *  - 마커 v2(`v=2`·`instance=<pax|pax-id>`·`file=<sha256> <path>`)로 **이 PC 에서 고친 사본**을 알아보고, 되돌리기 전에 보관한다.
 *    instance 가 다른 플러그인(같은 PC 의 `pax`·`pax-<id>`)의 사본은 지우지도 덮어쓰지도 않는다.
 *  - `.git/info/exclude` 에 두 패턴 append(CLI 만, 저장소 루트 기준, worktree 경로 대응, CRLF 유지).
 */
import { execFileSync } from 'node:child_process';
import {
  lstatSync, realpathSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, readdirSync, existsSync, appendFileSync, statSync,
  openSync, closeSync, copyFileSync,
} from 'node:fs';
import { join, resolve, sep, relative, isAbsolute, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { selectToken, instanceDir, readJson, writeJsonAtomic } from './lib/store.mjs';
import { detectGithubRemote, repoToplevel } from './lib/gitRemote.mjs';
import { callTool, resultText, PLUGIN_ID } from './lib/rpc.mjs';
import { containsShellDirective } from './lib/skillGuard.mjs';

const MCP_URL = process.env.CLAUDE_CODE_MCP_SERVER_URL || 'https://owen-vibeagent-git-develop-polaris-office.vercel.app/api/local-ai/mcp';
const PLUGIN_VERSION = '2.1.0';
/** 이 플러그인의 설치 이름 — 마커 `instance=` 에 기록(원본도 명시값: 빈 값이면 마커 없는 옛 사본과 구분이 안 된다). */
const PLUGIN_NAME = PLUGIN_ID ? `pax-${PLUGIN_ID}` : 'pax';
const MAX_SKILLS = 50;
const MAX_TOTAL = 1024 * 1024;
const MAX_FILE = 100 * 1024;
const NAME_RE = /^pax-[a-z][a-z0-9-]*[a-z0-9]$/;
const TMP_RE = /^(pax-[a-z][a-z0-9-]*[a-z0-9])\.(new|old)-\d+$/;
const SEG_RE = /^[\p{L}\p{N} ._-]{1,128}$/u;
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const ROOTS = [
  { rel: join('.claude', 'skills'), tag: 'claude' },
  { rel: join('.agents', 'skills'), tag: 'agents' },
];
const MARKER = '.pax-managed';
const BACKUP_KEEP = 5;
const LOCK_STALE_MS = 60_000;
/** 서버 `src/lib/pluginSkillMd.ts` DELIVERED_NOTICE_START/END 와 같은 값 — 옛 사본 비교 때 머리 안내를 뗀다. */
const NOTICE_START = '<!-- pax:managed-notice:start -->';
const NOTICE_END = '<!-- pax:managed-notice:end -->';
/** 모델에게 매 세션 주는 규칙 — 서버 문자열은 섞지 않는다(고정문). */
const RULE_LINE =
  "이 프로젝트의 `.claude/skills/pax-*`·`.agents/skills/pax-*` 는 PAX가 관리하는 사본이다 — 고치거나 지우지 말 것(다음 동기화 때 되돌아간다). " +
  "사용자가 바꾸길 원하면 회사 스킬은 PAX 관리자에게 요청하고, 개인 스킬은 PAX 채팅 입력창의 ＋ → 도구 관리 → 내 도구에서 고치도록 안내한다. " +
  '이 프로젝트에만 필요한 보완은 `pax-`로 시작하지 않는 새 스킬로 만든다.';
const REASON_TEXT = {
  limit: '개수 한도 초과', size: '용량 초과', base_name: '기본 스킬과 이름이 겹침', name_conflict: '회사 스킬과 이름이 겹침',
  secret: '비밀값으로 보이는 내용', placeholder: '예약 문자열 포함', shell_directive: '셸 실행 표기 포함', invalid: '형식 오류',
  bad_name: '이름 형식 오류', invalid_file: '파일 형식 오류', no_skill_md: 'SKILL.md 없음',
};

const HOOK = process.argv.includes('--hook');

class Stop extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
/** CLI: stderr 에 사유 + 종료 코드. hook: 조용히 끝(모든 실패를 무출력으로). */
const die = (code, msg) => { throw new Stop(code, msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const today = () => new Date().toISOString().slice(0, 10);
const tildify = (p) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);

// 출력 모음 — CLI 는 줄 단위로 stdout, hook 은 마지막에 JSON 한 번.
const cliLines = [];
const userLines = [];
const modelLines = [];
const say = (line) => { if (HOOK) userLines.push(line); else cliLines.push(line); };

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }

async function readHookInput() {
  if (!HOOK || process.stdin.isTTY) return {};
  const chunks = [];
  const done = new Promise((res) => {
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', res);
    process.stdin.on('error', res);
  });
  // 대기 타이머는 반드시 치운다 — 남겨 두면 입력이 바로 끝나도 프로세스가 1초를 더 살아 훅마다 1초씩 늦어진다.
  let timer;
  await Promise.race([done, new Promise((r) => { timer = setTimeout(r, 1000); })]);
  clearTimeout(timer);
  // 입력이 닫히지 않은 채 남으면 이벤트 루프가 살아 있어 훅이 시간 제한까지 끝나지 않는다 — 읽은 뒤 닫는다.
  try { process.stdin.destroy(); } catch { /* ignore */ }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) ?? {}; } catch { return {}; }
}

function git(cwd, args, timeout = 3000) {
  return execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
    encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  });
}

// ─── 저장소 밖 상태(등록부·잠금·스탬프·보관) ────────────────────────────────────
function registryPath() { return join(instanceDir(MCP_URL), 'synced-folders.json'); }
function readRegistry() {
  const j = readJson(registryPath());
  return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
}
function writeRegistry(folder, slug) {
  const all = readRegistry();
  all[folder] = { slug, at: new Date().toISOString() };
  writeJsonAtomic(registryPath(), all);
}
/** 폴더별 상태 폴더 — 심볼릭 링크면 거부(다른 곳에 쓰게 되므로). */
function ensureStateDir(folder) {
  const dir = join(instanceDir(MCP_URL), 'state', sha256(folder).slice(0, 16));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (let cur = dir; cur.startsWith(instanceDir(MCP_URL)); cur = dirname(cur)) {
    if (lstatSync(cur).isSymbolicLink()) throw new Error(`상태 폴더 경로에 심볼릭 링크가 있어요: ${cur}`);
    if (cur === instanceDir(MCP_URL)) break;
  }
  return dir;
}
/** 같은 안내를 하루 한 번만 — hook 에서 매 세션 같은 경고가 쌓이지 않게. */
function onceADay(stateDir, key) {
  const p = join(stateDir, 'notices.json');
  const all = readJson(p) ?? {};
  const k = sha256(key).slice(0, 16);
  if (all[k] === today()) return false;
  all[k] = today();
  try { writeJsonAtomic(p, all); } catch { /* 스탬프 실패는 한 번 더 알리는 것뿐 */ }
  return true;
}
function acquireLock(stateDir) {
  const p = join(stateDir, 'sync.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(p, 'wx', 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return p;
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      let stale = false;
      try { stale = Date.now() - statSync(p).mtimeMs > LOCK_STALE_MS; } catch { stale = true; }
      if (!stale) return null;
      // 두 프로세스가 동시에 stale 로 보면 둘 다 지우고 둘 다 잡을 수 있다 — 자기 이름으로 옮긴 쪽만 지운다.
      const moved = `${p}.stale-${process.pid}`;
      try { renameSync(p, moved); rmSync(moved, { force: true }); } catch { /* 다른 쪽이 먼저 치웠다 */ }
    }
  }
  return null;
}

// ─── 마커 ─────────────────────────────────────────────────────────────────────
function parseMarker(dirPath) {
  let text;
  try { text = readFileSync(join(dirPath, MARKER), 'utf8'); } catch { return null; }
  const out = { v: 1, instance: null, files: new Map() };
  for (const raw of text.split(/\r?\n/)) {
    if (raw === 'v=2') out.v = 2;
    else if (raw.startsWith('instance=')) out.instance = raw.slice('instance='.length);
    else if (raw.startsWith('file=')) {
      const rest = raw.slice('file='.length);
      const sp = rest.indexOf(' '); // 첫 공백에서만 — 파일명에 공백이 허용된다
      if (sp === 64) out.files.set(rest.slice(sp + 1).normalize('NFC'), rest.slice(0, sp));
    }
  }
  return out;
}
function markerText(source, files) {
  const lines = ['v=2', `instance=${PLUGIN_NAME}`, `source=${source}`, `synced=${new Date().toISOString()}`];
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) lines.push(`file=${sha256(f.content)} ${f.path.normalize('NFC')}`);
  return `${lines.join('\n')}\n`;
}
/** 관리 폴더의 현재 파일(마커 제외) — 심볼릭 링크가 섞이면 따라가지 않고 `hasLink` 로 알린다. */
function readPresent(dirPath) {
  const files = new Map();
  let hasLink = false;
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) { hasLink = true; continue; }
      if (st.isDirectory()) walk(p);
      else {
        const rel = relative(dirPath, p).split(sep).join('/').normalize('NFC');
        if (rel !== MARKER) files.set(rel, readFileSync(p, 'utf8'));
      }
    }
  };
  walk(dirPath);
  return { files, hasLink };
}
function stripNotice(text) {
  const s = text.indexOf(NOTICE_START);
  const e = text.indexOf(NOTICE_END);
  if (s < 0 || e < s) return text;
  return text.slice(0, s) + text.slice(e + NOTICE_END.length).replace(/^\n\n/, '');
}
/** 로컬에서 고쳤는가 — v2 는 기록한 해시와, v1 은 서버 내용(머리말 제외)과 비교. */
function localEditState(marker, present, desiredFiles) {
  if (present.hasLink) return 'modified';
  if (marker?.v === 2) {
    if (present.files.size !== marker.files.size) return 'modified';
    for (const [p, c] of present.files) if (marker.files.get(p) !== sha256(c)) return 'modified';
    return 'clean';
  }
  // v1(해시 없음): 머리말만 다른 옛 사본이면 고친 게 아니다. 그 밖엔 서버 변경인지 로컬 수정인지 알 수 없다.
  const want = new Map(desiredFiles.map((f) => [f.path.normalize('NFC'), f.path === 'SKILL.md' ? stripNotice(f.content) : f.content]));
  if (present.files.size === want.size && [...present.files].every(([p, c]) => want.get(p) === c)) return 'clean';
  return 'unknown';
}
/**
 * 보관 폴더 이름 = `<스킬>@<YYYYMMDDTHHmmssSSSZ>[-n]`. 구분자 `@` 는 스킬 이름(NAME_RE)에 올 수 없어 `pax-design` 과
 * `pax-design-review` 의 보관본이 서로 섞이지 않는다(접두 비교로 거르면 짧은 이름 쪽 보관본이 긴 이름 몫으로 지워졌다).
 * 밀리초까지 넣고, 그래도 겹치면 `-2`… 를 붙인다(같은 초에 두 번 보관하면 앞 보관본을 덮어쓰던 문제).
 */
function backupNameRe(name) {
  return new RegExp(`^${name}@\\d{8}T\\d{9}Z(-\\d+)?$`); // name 은 NAME_RE 통과값 — 정규식 특수문자 없음
}
function backupCopy(stateDir, tag, name, srcDir) {
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  const base = join(stateDir, 'backups', tag);
  let dest = join(base, `${name}@${stamp}`);
  for (let n = 2; existsSync(dest); n++) dest = join(base, `${name}@${stamp}-${n}`);
  const copy = (from, to) => {
    mkdirSync(to, { recursive: true, mode: 0o700 });
    for (const n of readdirSync(from)) {
      const p = join(from, n);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) continue; // 링크는 따라가지 않는다(보관이 다른 파일을 끌어오지 않게)
      if (st.isDirectory()) copy(p, join(to, n));
      else if (st.isFile()) copyFileSync(p, join(to, n));
    }
  };
  copy(srcDir, dest);
  // 스킬별 최근 BACKUP_KEEP 개만 — 이 스킬 이름 형식에 정확히 맞는 것만 세고, 방금 만든 보관본은 절대 지우지 않는다.
  const re = backupNameRe(name);
  const justMade = dest.slice(base.length + 1);
  const mine = readdirSync(base).filter((n) => re.test(n)).sort();
  for (const old of mine.slice(0, Math.max(0, mine.length - BACKUP_KEEP))) {
    if (old !== justMade) rmSync(join(base, old), { recursive: true, force: true });
  }
  return dest;
}

// ─── 본체 ─────────────────────────────────────────────────────────────────────
async function main() {
  const input = await readHookInput();
  const source = HOOK ? String(input.source ?? 'startup') : 'cli';
  const dir = resolve(HOOK ? (input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd()) : (arg('--project-dir') || process.cwd()));
  try { realpathSync(dir); } catch { die(2, `no_dir: 폴더가 없어요 — ${dir}`); }

  const toplevel = repoToplevel(dir);
  if (!toplevel) die(2, 'not_git_repo: git 저장소 폴더가 아니에요 — clone 한 프로젝트 폴더에서 실행하세요(추적·exclude 검사를 할 수 없어요).');
  // 대상 = 저장소 최상위(하위 폴더에서 시작한 세션이 엉뚱한 곳에 새 .claude/skills 를 만들지 않게). 경로 조립·git 은 realpath 기준.
  const realDir = realpathSync(toplevel);
  const remote = detectGithubRemote(realDir);
  if (!remote) die(2, 'no_github_remote: 이 폴더의 origin 이 GitHub 저장소가 아니에요.');

  if (HOOK) {
    const reg = readRegistry()[realDir];
    if (!reg || reg.slug !== remote.slug) return; // 연결·동기화한 적 없는 폴더(또는 remote 가 바뀐 폴더) — 무동작
  }
  const hasManaged = ROOTS.some(({ rel }) => {
    try { return readdirSync(join(realDir, rel)).some((n) => NAME_RE.test(n) && existsSync(join(realDir, rel, n, MARKER))); } catch { return false; }
  });
  if (HOOK && hasManaged) modelLines.push(RULE_LINE);
  if (HOOK && (source === 'clear' || source === 'compact')) return; // 대화 정리 뒤엔 규칙만 다시 준다(네트워크 없음)

  const sel = selectToken({ mcpUrl: MCP_URL, cwd: realDir });
  if (sel.kind !== 'project') {
    if (HOOK) {
      if (sel.reason === 'expired' && hasManaged && onceADay(openStateDir(realDir), 'auth-expired')) {
        say('연결한 지 12시간이 지나 오늘은 스킬 업데이트를 확인하지 못했어요. 최신 스킬이 필요하면 /pax-preview:connect 로 다시 연결하세요.');
      }
      return;
    }
    // 미연결 판정을 상태 폴더보다 먼저 — 쓰기 제한 환경에서도 "연결 없음" 이 정확한 사유로 나가게.
    die(3, `not_connected: ${remote.slug} 에 대한 PAX 연결이 없어요(${sel.reason ?? sel.kind}). /pax-preview:connect 로 이 프로젝트를 연결하세요.`);
  }

  // 잠금은 토큰을 고른 뒤에 — 같이 설치된 다른 인스턴스(연결 안 된 쪽)가 잠금을 선점하지 않게.
  const stateDir = openStateDir(realDir);
  let lock = lockOrSandbox(stateDir);
  if (!lock && !HOOK) {
    for (let i = 0; i < 33 && !lock; i++) { await sleep(300); lock = lockOrSandbox(stateDir); }
  }
  if (!lock) {
    if (!HOOK) say('다른 스킬 동기화가 진행 중이에요. 잠시 뒤 다시 실행하세요.');
    return;
  }
  try {
    await syncUnderLock({ realDir, remote, sel, stateDir, hasManaged });
  } finally {
    rmSync(lock, { force: true });
  }
}

const isPermissionError = (e) => e?.code === 'EPERM' || e?.code === 'EACCES' || e?.code === 'EROFS';
const SANDBOX_STATE_MESSAGE = (code) =>
  `sandbox: 상태 폴더(~/.config/vibeagent)에 쓸 수 없어요(${code}) — 샌드박스 제한으로 보여요. 터미널에서 직접 실행하거나 샌드박스를 끄고 재시도하세요.`;
/** 상태 폴더 열기 — 쓰기 권한 오류는 CLI 계약의 `sandbox:`(exit 5)로 분류한다(훅은 어차피 조용히 끝). */
function openStateDir(realDir) {
  try { return ensureStateDir(realDir); } catch (e) {
    if (isPermissionError(e)) die(5, SANDBOX_STATE_MESSAGE(e.code));
    throw e;
  }
}
function lockOrSandbox(stateDir) {
  try { return acquireLock(stateDir); } catch (e) {
    if (isPermissionError(e)) die(5, SANDBOX_STATE_MESSAGE(e.code));
    throw e;
  }
}

async function syncUnderLock({ realDir, remote, sel, stateDir, hasManaged }) {
  const call = await callTool(MCP_URL, sel.entry.token, 'get_project_skills', {}, { pluginVersion: PLUGIN_VERSION, timeoutMs: HOOK ? 5000 : 30_000 })
    .catch((e) => ({ ok: false, message: e?.message ?? String(e) }));
  if (!call.ok) {
    if (HOOK) {
      // 401 = 서버에서 취소된 연결 — 만료와 같은 조건(관리 사본이 있을 때만)·같은 안내(하루 1회). 그 밖의 실패(네트워크·일시 장애)는 조용히.
      if (call.status === 401 && hasManaged && onceADay(stateDir, 'auth-expired')) {
        say('PAX 연결이 끊겨 오늘은 스킬 업데이트를 확인하지 못했어요. 최신 스킬이 필요하면 /pax-preview:connect 로 다시 연결하세요.');
      }
      return;
    }
    die(1, `bundle_error: ${call.message}`);
  }
  const result = call.result;
  const bundle = result?.structuredContent;
  if (result?.isError || !bundle || !Array.isArray(bundle.skills)) {
    if (HOOK) return;
    die(1, `bundle_error: ${resultText(result) || '스킬 번들을 받지 못했어요'}`);
  }
  const degraded = bundle.degraded === true;
  const skippedServer = Array.isArray(bundle.skipped) ? bundle.skipped : [];

  // ── 검증 ───────────────────────────────────────────────────────────────────
  // 서버 문자열(이름·사유)은 출력 전에 형식을 확인한다 — 훅 출력은 모델·사용자에게 그대로 간다.
  const skipped = skippedServer.map((s) => ({ name: String(s?.name ?? ''), reason: String(s?.reason ?? '') }));
  const desired = [];
  let total = 0;
  for (const skill of bundle.skills.slice(0, MAX_SKILLS)) {
    const name = String(skill?.name ?? '');
    if (!NAME_RE.test(name)) { skipped.push({ name, reason: 'bad_name' }); continue; }
    const files = [];
    let ok = true;
    for (const f of Array.isArray(skill.files) ? skill.files : []) {
      const p = String(f?.path ?? '');
      const content = typeof f?.content === 'string' ? f.content : null;
      if (content === null || Buffer.byteLength(content) > MAX_FILE) { ok = false; break; }
      if (p !== 'SKILL.md') {
        if (!p.startsWith('references/')) { ok = false; break; }
        const segs = p.split('/').slice(1);
        if (segs.length === 0 || segs.length > 5) { ok = false; break; }
        if (segs.some((s) => !s || s === '.' || s === '..' || !SEG_RE.test(s) || s.startsWith('.') || /[.\s]$/.test(s) || WIN_RESERVED.test(s) || s.includes(':') || s.includes('\\'))) { ok = false; break; }
        if (segs[segs.length - 1].toLowerCase() === 'skill.md') { ok = false; break; }
      }
      if (containsShellDirective(content)) { skipped.push({ name, reason: 'shell_directive' }); ok = false; break; }
      files.push({ path: p, content });
    }
    if (!ok) { if (!skipped.some((s) => s.name === name)) skipped.push({ name, reason: 'invalid_file' }); continue; }
    if (!files.some((f) => f.path === 'SKILL.md')) { skipped.push({ name, reason: 'no_skill_md' }); continue; }
    const size = files.reduce((n, f) => n + Buffer.byteLength(f.content) + f.path.length, 0);
    if (total + size > MAX_TOTAL) { skipped.push({ name, reason: 'size' }); continue; }
    total += size;
    desired.push({ name, source: skill.source === 'user' ? 'user' : 'tenant', files });
  }
  for (const extra of bundle.skills.slice(MAX_SKILLS)) skipped.push({ name: String(extra?.name ?? '?'), reason: 'limit' });
  const skippedNames = new Set(skipped.map((s) => s.name));
  const desiredNames = new Set(desired.map((d) => d.name));

  // ── 파일시스템 안전 ──────────────────────────────────────────────────────────
  function noSymlinkWalk(target) {
    // realDir 부터 target 까지 각 구성요소 lstat — 심볼릭 링크면 false. 존재하지 않는 구성요소는 통과(생성 예정).
    const rel = relative(realDir, target);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false;
    let cur = realDir;
    for (const seg of rel.split(sep)) {
      cur = join(cur, seg);
      try {
        if (lstatSync(cur).isSymbolicLink()) return false;
      } catch {
        return true; // 이하 생성 예정
      }
    }
    return true;
  }
  function sealed(target) {
    try { return realpathSync(target).startsWith(realDir + sep); } catch { return true; }
  }
  function tracked(relPath) {
    try { return git(realDir, ['ls-files', '--', relPath]).trim().length > 0; } catch { return false; }
  }
  function isManaged(path) {
    try { return lstatSync(path).isDirectory() && lstatSync(join(path, MARKER)).isFile(); } catch { return false; }
  }
  const warn = (text) => {
    if (!HOOK) { say(`(주의) ${text}`); return; }
    if (onceADay(stateDir, `warn:${text}`)) say(`(주의) ${text}`);
  };

  // 개수는 **스킬 이름** 기준 — 같은 스킬이 두 위치(.claude·.agents)에 놓이므로 위치마다 세면 두 배가 된다.
  const addedSet = new Set(), updatedSet = new Set(), deletedSet = new Set();
  const reverted = []; // { name, where } — 이 PC 에서 고쳐진 사본을 되돌린 것
  let permissionError = null;
  let createdClaudeRoot = false;

  for (const { rel: rootRel, tag } of ROOTS) {
    const root = join(realDir, rootRel);
    if (!noSymlinkWalk(root)) { warn(`${rootRel}: 경로에 심볼릭 링크가 있어 건너뛰었어요`); continue; }
    try {
      if (tag === 'claude' && !existsSync(root)) createdClaudeRoot = true;
      mkdirSync(root, { recursive: true });
    } catch (e) {
      if (e?.code === 'EPERM' || e?.code === 'EACCES') { permissionError = e; break; }
      warn(`${rootRel}: 폴더를 만들 수 없어요(${e?.code ?? e})`); continue;
    }

    // 강제 종료 흔적 정리 — `pax-x.new-<pid>`(조립 중)는 지우고, `.old-<pid>`(교체 중)는 본래 폴더가 없으면 되살린다.
    // 이름 정규식에 안 맞아 아래 삭제 루프가 못 치우고, Claude Code 는 SKILL.md 가 있으면 스킬로 불러온다.
    for (const n of readdirSync(root)) {
      const m = n.match(TMP_RE);
      if (!m) continue;
      const p = join(root, n);
      if (!noSymlinkWalk(p) || lstatSync(p).isSymbolicLink()) continue;
      // git 이 추적하는 폴더는 건드리지 않는다(정식 사본 쓰기·삭제와 같은 규칙) — 우리 흔적이 아니라 저장소의 파일이다.
      if (tracked(join(rootRel, n))) { warn(`${join(rootRel, n)}: git 이 추적 중인 폴더라 정리하지 않았어요`); continue; }
      const final = join(root, m[1]);
      try {
        if (m[2] === 'old' && !existsSync(final)) renameSync(p, final);
        else rmSync(p, { recursive: true, force: true });
      } catch { /* 다음 동기화 때 다시 */ }
    }

    for (const skill of desired) {
      const final = join(root, skill.name);
      const relFinal = join(rootRel, skill.name);
      if (!noSymlinkWalk(final) || !sealed(final)) { warn(`${relFinal}: 심볼릭 링크 경로라 건너뛰었어요`); skippedNames.add(skill.name); continue; }
      if (tracked(relFinal)) { warn(`${relFinal}: git 이 추적 중인 파일이 있어 덮어쓰지 않았어요(수동 정리 필요)`); skippedNames.add(skill.name); continue; }
      const existed = existsSync(final);
      if (existed && !isManaged(final)) { warn(`${relFinal}: PAX 가 만든 폴더가 아니라 보존했어요(.pax-managed 없음)`); skippedNames.add(skill.name); continue; }
      const marker = existed ? parseMarker(final) : null;
      if (marker?.instance && marker.instance !== PLUGIN_NAME) {
        warn(`${relFinal}: 다른 PAX 플러그인(${marker.instance})이 관리하는 사본이라 건드리지 않았어요`);
        skippedNames.add(skill.name);
        continue;
      }

      let present = null;
      if (existed) {
        try { present = readPresent(final); } catch { present = { files: new Map(), hasLink: true }; }
      }
      const want = new Map(skill.files.map((f) => [f.path.normalize('NFC'), f.content]));
      const same = !!present && !present.hasLink && present.files.size === want.size
        && [...present.files].every(([p, c]) => want.get(p) === c);
      if (same) {
        // 내용이 같아도 마커가 v2·우리 instance·현재 해시가 아니면 마커만 다시 쓴다 — 안 그러면 수정 감지가 영영 켜지지 않는다.
        const fresh = marker?.v === 2 && marker.instance === PLUGIN_NAME && marker.files.size === want.size
          && [...want].every(([p, c]) => marker.files.get(p) === sha256(c));
        if (!fresh) {
          try { writeFileSync(join(final, MARKER), markerText(skill.source, skill.files), { mode: 0o644 }); } catch { /* 다음 번에 */ }
        }
        continue;
      }

      if (existed) {
        const edit = localEditState(marker, present, skill.files);
        if (edit !== 'clean') {
          try {
            const where = backupCopy(stateDir, tag, skill.name, final);
            if (edit === 'modified') reverted.push({ name: skill.name, where: tildify(where) });
          } catch (e) {
            // 보관에 실패하면 되돌리지 않는다 — 고친 내용을 잃는 것보다 한 번 더 늦게 맞추는 편이 낫다.
            warn(`${relFinal}: 고친 내용을 보관하지 못해 이번엔 되돌리지 않았어요(${e?.code ?? e?.message ?? e})`);
            skippedNames.add(skill.name);
            continue;
          }
        }
      }

      const tmpNew = join(root, `${skill.name}.new-${process.pid}`);
      const tmpOld = join(root, `${skill.name}.old-${process.pid}`);
      try {
        rmSync(tmpNew, { recursive: true, force: true });
        mkdirSync(tmpNew, { recursive: true });
        for (const f of skill.files) {
          const target = join(tmpNew, ...f.path.split('/'));
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, f.content, { mode: 0o644 });
        }
        writeFileSync(join(tmpNew, MARKER), markerText(skill.source, skill.files), { mode: 0o644 });
        if (existed) renameSync(final, tmpOld);
        renameSync(tmpNew, final);
        if (existed) rmSync(tmpOld, { recursive: true, force: true });
        if (existed) updatedSet.add(skill.name); else addedSet.add(skill.name);
      } catch (e) {
        rmSync(tmpNew, { recursive: true, force: true });
        if (!existsSync(final) && existsSync(tmpOld)) { try { renameSync(tmpOld, final); } catch { /* ignore */ } }
        if (e?.code === 'EPERM' || e?.code === 'EACCES') { permissionError = e; break; }
        warn(`${relFinal}: 쓰기 실패(${e?.code ?? e?.message ?? e})`);
      }
    }
    if (permissionError) break;

    // 삭제 — degraded·오류면 0건. 마커 있는 pax-* 만, desired·skipped 밖, 우리 instance(또는 옛 마커)만.
    // git 추적 중이면 쓰기와 같은 규칙으로 보존(경고). 이 PC 에서 고친 사본은 지우기 전에 보관.
    if (!degraded) {
      for (const name of readdirSync(root)) {
        if (!NAME_RE.test(name) || desiredNames.has(name) || skippedNames.has(name)) continue;
        const p = join(root, name);
        if (!isManaged(p) || !noSymlinkWalk(p) || !sealed(p)) continue;
        const marker = parseMarker(p);
        if (marker?.instance && marker.instance !== PLUGIN_NAME) continue; // 다른 플러그인의 사본
        if (tracked(join(rootRel, name))) { warn(`${join(rootRel, name)}: git 이 추적 중인 파일이 있어 지우지 않았어요(수동 정리 필요)`); continue; }
        try {
          let present;
          try { present = readPresent(p); } catch { present = { files: new Map(), hasLink: true }; }
          const edited = marker?.v === 2 ? localEditState(marker, present, []) : 'unknown';
          if (edited !== 'clean') {
            const where = backupCopy(stateDir, tag, name, p);
            if (edited === 'modified') reverted.push({ name, where: tildify(where) });
          }
          rmSync(p, { recursive: true, force: false });
          deletedSet.add(name);
        } catch (e) { warn(`${join(rootRel, name)}: 삭제 실패(${e?.code ?? e})`); }
      }
    }
  }
  if (permissionError) {
    if (HOOK) { say(`스킬 파일을 쓸 수 없어요(${permissionError.code}) — 샌드박스 제한으로 보여요.`); return; }
    die(5, `sandbox: 스킬 파일을 쓸 수 없어요(${permissionError.code}) — 샌드박스 제한으로 보여요. 터미널에서 직접 실행하거나 샌드박스를 끄고 재시도하세요.`);
  }

  // ── .git/info/exclude (CLI 만 — 훅은 저장소 설정 경로에 쓰지 않는다) ─────────────
  if (!HOOK) {
    try {
      const gitPath = git(realDir, ['rev-parse', '--git-path', 'info/exclude']).trim();
      const excludePath = isAbsolute(gitPath) ? gitPath : resolve(realDir, gitPath);
      mkdirSync(dirname(excludePath), { recursive: true });
      const patterns = ROOTS.map(({ rel }) => `/${rel.split(sep).join('/')}/pax-*/`);
      const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
      const eol = existing.includes('\r\n') ? '\r\n' : '\n';
      const lines = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
      const missing = patterns.filter((p) => !lines.has(p));
      if (missing.length) {
        const lead = existing.length && !existing.endsWith('\n') ? eol : '';
        appendFileSync(excludePath, `${lead}${missing.join(eol)}${eol}`);
      }
    } catch (e) {
      warn(`.git/info/exclude 갱신 실패(${e?.code ?? e?.message ?? e}) — git status 에 .claude/skills/pax-* 가 보일 수 있어요`);
    }
  }

  // 등록부 — 이 폴더는 이제 Claude Code 를 열 때 자동으로 맞춘다.
  // 훅은 이미 등록된 폴더에서만 도므로 다시 쓰지 않는다 — 읽고-고치고-쓰는 사이 동시에 돈 CLI 의 새 폴더 등록을 덮어쓰지 않게.
  if (!HOOK) {
    try { writeRegistry(realDir, remote.slug); } catch { /* 등록 실패는 자동 갱신이 안 될 뿐 */ }
  }

  // ── 출력 ──────────────────────────────────────────────────────────────────
  // 한 위치엔 새로 놓이고 다른 위치엔 갱신되는 경우(한쪽만 지워졌던 사본)는 "새로 받음"으로 센다.
  for (const n of addedSet) updatedSet.delete(n);
  const added = addedSet.size, updated = updatedSet.size, deleted = deletedSet.size;
  const addedNames = [...addedSet];
  // 같은 스킬을 두 위치(.claude·.agents)에서 되돌렸으면 안내는 한 번, 보관 위치는 모두 적는다 — 한쪽만 적으면 다른 쪽 수정본을 찾을 길이 없다.
  const revertedByName = new Map();
  for (const r of reverted) revertedByName.set(r.name, [...(revertedByName.get(r.name) ?? []), r.where]);
  // 스킬 이름 뒤에 조사를 붙이지 않는다 — 받침 유무에 따라 '가/이' 가 갈려 틀린 문장이 된다("pax-login 가").
  for (const [name, wheres] of revertedByName) {
    const where = wheres.join(', ');
    say(`(주의) 이 PC에서 고쳐진 스킬(${name})을 PAX에 등록된 내용으로 되돌렸어요. 고친 내용은 ${where} 에 보관했어요.`);
    if (HOOK) modelLines.push(`PAX 스킬 동기화가 이 PC에서 고쳐진 스킬(${name})을 PAX에 등록된 내용으로 되돌렸다. 고친 내용은 ${where} 에 보관돼 있다.`);
  }
  const shownSkipped = skipped.filter((s) => NAME_RE.test(s.name) && REASON_TEXT[s.reason]);
  if (HOOK) {
    for (const s of shownSkipped) if (onceADay(stateDir, `skip:${s.name}:${s.reason}`)) say(`(건너뜀) ${s.name}: ${REASON_TEXT[s.reason]}`);
    if (degraded && onceADay(stateDir, 'degraded')) say('(주의) 서버 조회가 일부 실패해 이번엔 지우지 않았어요.');
    const parts = [];
    if (added) parts.push(`새로 받음 ${added}(${addedNames.slice(0, 3).join(', ')}${addedNames.length > 3 ? ' …' : ''})`);
    if (updated) parts.push(`바뀜 ${updated}`);
    if (deleted) parts.push(`빠짐 ${deleted}`);
    if (parts.length) {
      userLines.unshift(`[PAX 스킬] ${parts.join(' · ')}`);
      if (createdClaudeRoot) userLines.push('새 스킬이 보이지 않으면 /reload-skills 를 실행하세요.');
    }
    return;
  }
  for (const s of skipped) say(`(건너뜀) ${NAME_RE.test(s.name) ? s.name : '(이름 오류)'}: ${REASON_TEXT[s.reason] ?? s.reason}`);
  if (degraded) say('(주의) 서버 조회가 일부 실패해 삭제는 하지 않았어요.');
  say(`[스킬 동기화] 추가 ${added} 갱신 ${updated} 삭제 ${deleted} 건너뜀 ${skipped.length}${desired.length ? ` — 스킬은 pax-* 이름으로 자동 등장해요` : ''}`);
}

try {
  await main();
} catch (e) {
  if (e instanceof Stop) {
    if (!HOOK) {
      for (const l of cliLines) process.stdout.write(`${l}\n`);
      cliLines.length = 0;
      process.stderr.write(`${e.message}\n`);
      process.exitCode = e.code;
    }
  } else if (!HOOK) {
    process.stderr.write(`sync_error: ${e?.message ?? e}\n`);
    process.exitCode = 1;
  }
}
if (HOOK) {
  const payload = {};
  if (userLines.length) payload.systemMessage = userLines.join('\n');
  if (modelLines.length) payload.hookSpecificOutput = { hookEventName: 'SessionStart', additionalContext: modelLines.join('\n') };
  if (Object.keys(payload).length) process.stdout.write(JSON.stringify(payload));
  process.exitCode = 0;
} else {
  for (const l of cliLines) process.stdout.write(`${l}\n`);
}
