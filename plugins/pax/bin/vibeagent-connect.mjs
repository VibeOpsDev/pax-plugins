#!/usr/bin/env node
/**
 * PAX 연결(2.0.0) — 코드 붙여넣기 없음. Claude(명령)·Codex(스킬) 양쪽에서 호출되는 벤더중립 스크립트.
 *
 * 흐름: 진행 상태 파일(`pending-*.json`) 점검 →
 *   · `done`(10분 이내) → 결과 소비(출력·스킬 동기화·파일 삭제) 후 종료 — 리스너 기동 없음
 *   · `waiting`/`exchanging` 이고 exp 미도래 → **이어 붙기**(리스너·브라우저 탭을 새로 열지 않음, 주소·확인값 재출력) → `--wait` 면 폴링
 *   · `failed`·exp 도래·10분 초과 → 파일만 삭제(pid 는 건드리지 않음 — 리스너는 exp 에 스스로 끝나고, pid 는 재사용될 수 있다).
 *     10분 이내 `failed` 는 아무도 기다리지 않을 때 실패한 것이라 사유 한 줄을 먼저 보여 주고 새로 시작한다
 * → 살아있는 대기가 없을 때만 리스너(이중 fork) 기동 → 상태 `waiting` 확인(10s, exit 4) →
 * `https://<pax>/local-ai/connect#port=;nonce=;exp=[;repo=]` + 확인값 출력 + 브라우저 열기 → **기본은 곧바로 exit 0**(명령이 사용자에게 안내) →
 * 명령이 `--wait 30` 으로 재실행하며 폴링(이어 붙기) → done: 결과 출력 + (폴더 remote == 연결 repo 면) 스킬 동기화 / failed: 안내 /
 * 미완: `waiting` 출력 후 exit 0(다시 `--wait 30`).
 * `--restart` 는 살아있는 대기를 종료하고 새로 시작. 인자는 무시한다(옛 `<코드>` 형식이면 한 줄 안내). `--print-proxy-path` 는 Codex 예비 절차용.
 */
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, unlinkSync, statSync, openSync, closeSync, mkdirSync } from 'node:fs';
import { platform, release } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { instanceDir, readJson, readProjectToken, readRecent, readLegacy, listProjectTokens, repoUrlToSlug, isUsable, isValidRepoSlug, selectToken, deleteProjectToken, readFolderBinding, writeFolderBinding, deleteFolderBinding, deleteDeploymentBypass } from './lib/store.mjs';
import { detectGithubRemote, isInsideDir } from './lib/gitRemote.mjs';

const MCP_URL = process.env.CLAUDE_CODE_MCP_SERVER_URL || 'https://owen-vibeagent-git-develop-polaris-office.vercel.app/api/local-ai/mcp';
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..');
/**
 * `--wait [초]` 폴링 길이(기본 30s, 최대 100s). 기본 실행은 **기다리지 않는다** — Claude Code 의 Bash 도구는 명령이 끝나야 출력을 보여 주므로,
 * 첫 실행이 길게 대기하면 주소·확인값이 사용자에게 늦게 도달하고 "멈춘 것" 처럼 보인다(2026-09-21 실측). 명령이 짧은 폴링을 반복한다.
 */
const WAIT_MS = (() => {
  const i = process.argv.indexOf('--wait');
  const raw = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(raw) && raw > 0 ? Math.min(100, Math.max(5, Math.floor(raw))) * 1000 : 30_000;
})();
const LISTENER_LIFETIME_MS = 600_000;
const PENDING_MAX_AGE_MS = 10 * 60_000;
const STARTING_GRACE_MS = 15_000;

// 플러그인 설치 폴더 안(Codex 는 플러그인 루트를 cwd 로 띄운다)이면 그 폴더의 remote(마켓플레이스 clone)는 프로젝트가 아니다.
const cwd = isInsideDir(process.cwd(), PLUGIN_ROOT) ? null : process.cwd();
const projectDirHint = process.env.CLAUDE_PROJECT_DIR && !isInsideDir(process.env.CLAUDE_PROJECT_DIR, PLUGIN_ROOT) ? process.env.CLAUDE_PROJECT_DIR : undefined;

if (process.argv.includes('--print-proxy-path')) {
  process.stdout.write(`${join(HERE, 'vibeagent-mcp-proxy.mjs')}\n`);
  process.exit(0);
}
// `/pax-preview:disconnect` — 로컬 토큰 파일만 삭제(서버 취소는 명령이 먼저 `disconnect` 도구로 한다).
if (process.argv.includes('--disconnect')) {
  const sel = selectToken({ mcpUrl: MCP_URL, cwd, projectDirHint });
  if (cwd) deleteFolderBinding(MCP_URL, cwd); // 이 폴더의 바인딩도 함께 — 다음 도구 호출이 "미연결" 로 답하게
  if (sel.slug) {
    deleteProjectToken(MCP_URL, sel.slug);
    process.stdout.write(`끊음: ${sel.slug}\n`);
  } else {
    process.stdout.write('이 폴더에 연결된 프로젝트 토큰이 없어요.\n');
  }
  // 이 인스턴스에 남은 연결이 없으면 배포 보호 우회 값(프리뷰)도 지운다 — 다음 연결이 서버에서 다시 받는다.
  if (listProjectTokens(MCP_URL).length === 0) deleteDeploymentBypass(MCP_URL);
  process.exit(0);
}
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (positional[0] && /^[A-Za-z0-9_-]{16,}$/.test(positional[0])) {
  process.stdout.write('2.0 부터 연결 코드 붙여넣기는 없어졌어요 — 인자 없이 진행합니다(브라우저에서 프로젝트를 고르면 연결돼요).\n');
}
// 기본 = 기다리지 않음(주소·확인값을 곧바로 돌려준다). `--wait [초]` 일 때만 폴링. 구 `--no-wait` 는 무해한 no-op.
const wait = process.argv.includes('--wait');
const restart = process.argv.includes('--restart');

const dir = instanceDir(MCP_URL);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const remove = (p) => { try { unlinkSync(p); } catch { /* ignore */ } };
const remote = (cwd ? detectGithubRemote(cwd) : null) ?? (projectDirHint && projectDirHint !== cwd ? detectGithubRemote(projectDirHint) : null);

// ── 1) 진행 상태 파일 점검 — done 소비 / 살아있는 대기 이어 붙기 / 나머지 정리 ─────────────────────────────────────
let attachPath = null;
let attachState = null;
if (existsSync(dir)) {
  const now = Date.now();
  const entries = [];
  for (const name of readdirSync(dir)) {
    if (!name.startsWith('pending-') || !name.endsWith('.json')) continue;
    const p = join(dir, name);
    let mtime = 0;
    try { mtime = statSync(p).mtimeMs || 0; } catch { continue; }
    entries.push({ path: p, st: readJson(p), age: now - mtime });
  }
  entries.sort((a, b) => a.age - b.age); // 최신 먼저
  let done = null;
  let live = null;
  for (const e of entries) {
    const st = e.st;
    const fresh = e.age <= PENDING_MAX_AGE_MS;
    const notExpired = Number(st?.exp) > now;
    const isLive = fresh && notExpired && (st?.status === 'waiting' || st?.status === 'exchanging' || (st?.status === 'starting' && e.age <= STARTING_GRACE_MS));
    if (!restart && fresh && st?.status === 'done' && !done) { done = e; continue; }
    if (!restart && isLive && !live) { live = e; continue; }
    if (restart && isLive && st.status !== 'starting') await stopListener(st);
    if (!restart && fresh && st?.status === 'failed' && st.message) process.stdout.write(`이전 연결 시도가 실패했어요(${String(st.message).slice(0, 200)}) — 새로 시작합니다.\n`);
    remove(e.path);
  }
  if (done) consumeDone(done.st, done.path); // exit 0
  if (live) { attachPath = live.path; attachState = live.st; }
}

// ── 2) 이어 붙기 — 리스너는 새로 띄우지 않는다. 사용자가 다시 실행한 경우(`--wait` 없음)에만 같은 주소를 브라우저에 다시 연다;
//     `--wait` 폴링은 열지 않는다(30초마다 탭이 늘어나면 안 된다).
if (attachPath) {
  let st = attachState;
  if (st.status === 'starting') {
    // 직전 실행이 띄운 리스너가 아직 포트를 여는 중 — 잠시만 기다린다.
    const until = Date.now() + 10_000;
    while (st && st.status === 'starting' && Date.now() < until) { await sleep(200); st = readJson(attachPath); }
  }
  if (st && (st.status === 'waiting' || st.status === 'exchanging') && Number(st.exp) > Date.now()) {
    const mins = Math.max(1, Math.ceil((Number(st.exp) - Date.now()) / 60_000));
    const url = typeof st.url === 'string' && isConnectUrl(st.url) ? st.url : null;
    const reopened = !wait && url ? openBrowser(url) : false;
    process.stdout.write(
      `진행 중인 연결 대기에 이어 붙었어요(남은 ${mins}분).` +
      (reopened
        ? ` 같은 연결 주소를 브라우저에 다시 열었어요 — 프로젝트를 고르고 [연결]을 누르세요: ${url}\n`
        : url
          ? ` 브라우저 탭에서 프로젝트를 고르고 [연결]을 누르세요. 탭을 닫았다면 이 주소를 이 PC 의 브라우저에서 여세요: ${url}\n`
          : ' 브라우저 탭에서 프로젝트를 고르고 [연결]을 누르세요. 탭을 닫았다면 이 명령을 `--restart` 로 다시 실행하세요.\n') +
      (url ? `${checkValueLine(url)}\n` : ''),
    );
    if (!wait) process.exit(0);
    await waitLoop(attachPath); // exit
  }
  if (st && st.status === 'done') consumeDone(st, attachPath); // exit 0
  if (st && st.status === 'failed') { remove(attachPath); process.stderr.write(`연결 실패 — ${st.message ?? '알 수 없는 오류'}\n`); process.exit(1); }
  remove(attachPath); // 뜨지 못했거나 그 사이 만료 — 새로 시작
}

// ── 3) 힌트 + previousJti ────────────────────────────────────────────────────────────────────────────────────
//   · 폴더 remote(강한 힌트) → `repo=` — 페이지가 그 프로젝트로 목록을 잠근다.
//   · remote 없음(빈 폴더·Codex 플러그인 폴더) → 최근 연결을 `recent=`(약한 힌트) — 페이지는 전체 목록을 보여 주고 그 항목만 미리 선택.
//     (2026-09-21: 둘을 같은 `repo=` 로 보내 빈 폴더에서도 최근 프로젝트 하나로 잠기던 문제)
let hintSlug = remote?.slug ?? null; // 강한 힌트
let recentSlug = null; // 약한 힌트
let previousJti = null;
if (hintSlug) {
  previousJti = readProjectToken(MCP_URL, hintSlug)?.jti ?? null;
} else {
  // 이 폴더에서 전에 연결한 프로젝트(폴더 바인딩) > 인스턴스 전체의 최근 연결 — 둘 다 약한 힌트(선택만).
  const bound = cwd ? readFolderBinding(MCP_URL, cwd) : null;
  const recent = bound ?? readRecent(MCP_URL); // slug 형식이 깨진 recent.json 은 null
  if (recent?.slug) { recentSlug = recent.slug; previousJti = readProjectToken(MCP_URL, recent.slug)?.jti ?? null; }
  else {
    const latest = listProjectTokens(MCP_URL).sort((a, b) => b.mtime - a.mtime)[0];
    if (latest?.repoUrl) { recentSlug = repoUrlToSlug(latest.repoUrl); previousJti = latest.jti ?? null; }
  }
}
if (hintSlug && !isValidRepoSlug(hintSlug)) hintSlug = null;
if (recentSlug && !isValidRepoSlug(recentSlug)) recentSlug = null;
if (!previousJti) {
  const legacy = readLegacy(MCP_URL);
  if (isUsable(legacy) && legacy.jti) previousJti = legacy.jti;
}

// ── 4) 리스너 기동 (이중 fork) ────────────────────────────────────────────────────────────────────────────────
let origin;
try { origin = new URL(MCP_URL).origin; } catch { process.stderr.write('MCP 주소가 올바르지 않아요(로컬 개발 복사본?).\n'); process.exit(1); }
const nonce = randomBytes(24).toString('base64url'); // 32자
const exp = Date.now() + LISTENER_LIFETIME_MS;
const statePath = join(dir, `pending-${nonce.slice(0, 8)}.json`);
const logPath = join(dir, `listener-${nonce.slice(0, 8)}.log`);
const listener = join(HERE, 'vibeagent-connect-listener.mjs');
// 포트는 리스너가 고르므로 `{port}` 슬롯 템플릿을 넘기고, 리스너가 채운 최종 주소를 상태 파일 `url` 로 되돌려 받는다.
const urlTemplate = `${origin}/local-ai/connect#port={port};nonce=${nonce};exp=${exp}${hintSlug ? `;repo=${hintSlug}` : recentSlug ? `;recent=${recentSlug}` : ''}`;
if (!isConnectUrl(urlTemplate.replace('{port}', '1'))) {
  process.stderr.write('연결 주소 조립에 실패했어요.\n');
  process.exit(1);
}
{
  let logFd = 'ignore';
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    logFd = openSync(logPath, 'a', 0o600);
  } catch { logFd = 'ignore'; }
  const args = [listener, '--spawn', '--nonce', nonce, '--state', statePath, '--exp', String(exp), '--url', urlTemplate];
  if (previousJti) args.push('--previous-jti', previousJti);
  // remote 없는 폴더(빈 폴더·remote 없는 저장소)만 — 교환 성공 시 리스너가 이 폴더 ↔ 고른 프로젝트를 묶는다. remote 폴더는 remote 핀이라 불필요.
  if (cwd && !remote?.slug) args.push('--bind-dir', cwd);
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true, env: process.env });
  child.unref();
  if (typeof logFd === 'number') { try { closeSync(logFd); } catch { /* ignore */ } }
}
{
  const until = Date.now() + 10_000;
  let st = readJson(statePath);
  while ((!st || st.status === 'starting') && Date.now() < until) { await sleep(200); st = readJson(statePath); }
  if (!st || st.status !== 'waiting' || !st.port) {
    process.stderr.write(`listener_failed: 연결 대기 프로세스를 시작하지 못했어요${st?.message ? ` (${st.message})` : ''}. 로그: ${logPath}\n`);
    process.exit(4);
  }
  // ── 5) 연결 주소 출력 + 브라우저 ───────────────────────────────────────────────────────────────────────────
  const url = typeof st.url === 'string' ? st.url : urlTemplate.replace('{port}', String(st.port));
  if (!isConnectUrl(url)) {
    process.stderr.write('연결 주소 조립에 실패했어요.\n');
    process.exit(1);
  }
  process.stdout.write(`브라우저에서 연결을 진행하세요: ${url}\n${checkValueLine(url)}\n`);
  if (!openBrowser(url)) {
    process.stdout.write('브라우저를 자동으로 열지 못했어요 — 위 주소를 `#` 뒤까지 모두 복사해 **이 PC** 의 브라우저에서 여세요.\n');
  }
}

// ── 6) 대기 ────────────────────────────────────────────────────────────────────────────────────────────────
if (!wait) process.exit(0);
await waitLoop(statePath);

// ─── helpers ──────────────────────────────────────────────────────────────────────────────────────────────
function isConnectUrl(url) {
  return /^https?:\/\/[A-Za-z0-9.-]+(:\d+)?\/local-ai\/connect#[A-Za-z0-9=;._/-]+$/.test(url);
}

/**
 * 대조값 한 줄 — 연결 페이지가 같은 값(nonce 앞 8자)을 보여 준다(포트는 비개발자에게 뜻 없는 숫자라 양쪽 다 내지 않는다). 서버는 (port, nonce) 를 세션에 묶지 않으므로
 * 남이 만든 프래그먼트 링크로 열린 화면을 사용자가 눈으로 가려내는 장치. nonce 앞 8자는 상태·로그 파일 이름에 이미 쓰인다.
 */
function checkValueLine(url) {
  const m = /[#;]nonce=([A-Za-z0-9_-]{8})/.exec(String(url));
  return m ? `확인값 ${m[1]} — 브라우저 화면의 확인값과 같은지 사용자에게 확인시키세요(다르면 그 탭을 닫고 다시 실행).` : '';
}

/** `--restart` 전용 — exp 미도래·waiting/exchanging 인 리스너만 SIGTERM. POSIX 에선 그 pid 가 우리 리스너인지 ps 로 한 번 더 확인. */
async function stopListener(st) {
  const pid = Number(st?.pid);
  if (!Number.isInteger(pid) || pid <= 1) return;
  if (platform() !== 'win32') {
    try {
      const r = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
      if (!r.error && r.status === 0 && !String(r.stdout ?? '').includes('vibeagent-connect-listener')) return; // 다른 프로세스(pid 재사용)
    } catch { /* ps 없음 — exp 게이트만으로 진행 */ }
  }
  try { process.kill(pid, 'SIGTERM'); } catch { /* 이미 없음 */ }
  await sleep(200); // 리스너가 상태 파일에 failed(superseded) 를 쓰고 끝날 시간
}

function consumeDone(st, path) {
  const repoUrl = st.result?.repoUrl ?? '';
  remove(path);
  process.stdout.write(`PAX 연결 완료: ${repoUrl}\n`);
  const connectedSlug = repoUrlToSlug(repoUrl);
  // 폴더 바인딩 — remote 가 없거나 연결 프로젝트와 같을 때만 이 폴더 ↔ 프로젝트를 묶는다(프록시가 이 폴더에서 이 토큰만 쓴다).
  // 정본 기록은 리스너(`--bind-dir`, 교환 성공 시점)이고 여기는 멱등 보조 — done 을 늦게 소비해도 같은 값.
  // remote 가 다른 프로젝트면 묶지 않는다(remote 가 우선이고, 아래 안내대로 사용자가 폴더를 고른다).
  if (cwd && connectedSlug && (!remote?.slug || remote.slug === connectedSlug)) {
    try { writeFolderBinding(MCP_URL, cwd, { slug: connectedSlug, repoUrl }); } catch { /* 바인딩 실패는 치명 아님 — 다음 호출이 미연결로 안내 */ }
  }
  if (remote?.slug && connectedSlug && remote.slug !== connectedSlug) {
    // 폴더 ≠ 고른 프로젝트 — 이 폴더에선 아무것도 하지 않는다(바인딩·스킬 없음, 프록시는 remote 로 핀). 대신 옆 폴더 clone 을 제안한다:
    // 명령/스킬이 `folder_mismatch:` 줄을 읽어 사용자에게 1회 묻고, 예면 `git clone <repo> <suggest>` + 스킬 동기화 후 그 폴더로 안내.
    const base = cwd ?? projectDirHint ?? process.cwd();
    // 폴더명은 저장소의 원래 대소문자(slug 는 소문자 — 대소문자 구분 파일시스템에서 기존 `MyApp` clone 을 못 알아보고 `myapp` 을 또 제안한다).
    const name = String(repoUrl).replace(/\/+$/, '').split('/').pop() || connectedSlug.split('/')[1];
    const suggest = join(dirname(base), name);
    const exists = existsSync(join(suggest, '.git'));
    process.stdout.write(
      `지금 열린 폴더는 **${remote.slug}** 인데 브라우저에서 **${connectedSlug}** 를 골랐어요. 이 폴더에서는 ${connectedSlug} 를 쓰지 않아요. ` +
      (exists ? `${suggest} 에 이미 그 프로젝트가 있어요 — 그 폴더를 열고 새 대화에서 이어가세요.` : `${connectedSlug} 를 ${suggest} 에 내려받아 준비할 수 있어요.`) +
      ` ${remote.slug} 를 쓰려면 /pax-preview:connect 를 다시 실행해 ${remote.slug} 를 고르세요.\n` +
      `folder_mismatch: repo=${repoUrl} suggest="${suggest}"${exists ? ' exists=1' : ''}\n`,
    );
  } else if (remote?.slug && connectedSlug === remote.slug) {
    const r = spawnSync(process.execPath, [join(HERE, 'vibeagent-sync-skills.mjs'), '--project-dir', cwd ?? projectDirHint], { encoding: 'utf8', timeout: 60_000, windowsHide: true, env: process.env });
    process.stdout.write(String(r.stdout ?? ''));
    if (r.status !== 0) process.stdout.write(`(스킬 동기화 실패 — ${String(r.stderr ?? '').trim().slice(0, 300)})\n`);
  } else {
    process.stdout.write('이제 "이 프로젝트를 로컬에서 개발할 수 있게 준비해줘"라고 요청하세요(clone 뒤 스킬이 자동으로 내려와요).\n');
  }
  process.exit(0);
}

async function waitLoop(path) {
  const until = Date.now() + WAIT_MS;
  let st = readJson(path);
  while (st && (st.status === 'waiting' || st.status === 'exchanging' || st.status === 'starting') && Date.now() < until) { await sleep(500); st = readJson(path); }
  if (!st) { process.stderr.write('상태 파일이 사라졌어요. /pax-preview:connect 를 다시 실행하세요.\n'); process.exit(1); }
  if (st.status === 'done') consumeDone(st, path); // exit 0
  if (st.status === 'failed') {
    remove(path);
    process.stderr.write(`연결 실패 — ${st.message ?? '알 수 없는 오류'}\n`);
    process.exit(1);
  }
  process.stdout.write('waiting: 아직 브라우저에서 연결이 완료되지 않았어요. 사용자가 브라우저에서 프로젝트를 고르고 [연결]을 누르면 완료돼요 — 이 명령을 `--wait 30` 으로 다시 실행하세요(진행 중인 대기에 이어 붙고, 새 탭은 열리지 않아요).\n');
  process.exit(0);
}

function openBrowser(url) {
  try {
    const isWsl = platform() === 'linux' && (process.env.WSL_DISTRO_NAME || /microsoft/i.test(release()));
    let cmd, args;
    if (platform() === 'darwin') { cmd = 'open'; args = [url]; }
    else if (platform() === 'win32') { cmd = 'powershell'; args = ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath '${url.replace(/'/g, "''")}'`]; }
    else if (isWsl) { cmd = 'cmd.exe'; args = ['/c', 'start', '', url.replace(/&/g, '^&')]; }
    else { cmd = 'xdg-open'; args = [url]; }
    const r = spawnSync(cmd, args, { stdio: 'ignore', timeout: 5000, windowsHide: true });
    return !r.error && (r.status === 0 || r.status === null);
  } catch {
    return false;
  }
}
