#!/usr/bin/env node
/**
 * 스킬 동기화(2.0.0) — `get_project_skills` 번들을 clone 폴더의 `.claude/skills/pax-*`(Claude Code)·`.agents/skills/pax-*`(Codex) 에 쓴다.
 *
 * 안전 규칙(계획 C6):
 *  - git 저장소가 아니면 거부(추적 검사·exclude 불가). remote 가 GitHub 가 아니면 거부(토큰 선택 불가).
 *  - 디렉터리 이름 `^pax-[a-z][a-z0-9-]*[a-z0-9]$`. 참조 경로는 `references/…` 만, 세그먼트에 `..`·`:`·`\`·Windows 예약 이름·끝 점/공백 금지.
 *  - `<dir>` 부터 대상까지 **모든 구성요소를 lstat** — 하나라도 심볼릭 링크면 그 스킬 skip(reason symlink). realpath 봉인.
 *  - git 이 추적 중인 경로(`git ls-files`)는 덮어쓰지 않고 경고. 파일 0644(실행 비트 없음).
 *  - 삭제는 `.pax-managed` 마커가 일반 파일인 `pax-*` 디렉터리만. degraded·도구 오류(킬스위치 deny 포함)면 삭제 0건. skipped 이름은 삭제 제외.
 *  - 교체는 `pax-x.new-<pid>` 조립 → 기존 `.old-<pid>` rename → new→final → old 삭제. 캡 50개·1MB·파일당 100KB. 셸 디렉티브 재검사.
 *  - `.git/info/exclude` 에 두 패턴 append(저장소 루트 기준, worktree 경로 대응, CRLF 유지).
 * 출력 마지막 줄 `[스킬 동기화] 추가 n 갱신 m 삭제 k 건너뜀 s`.
 */
import { execFileSync } from 'node:child_process';
import {
  lstatSync, realpathSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, readdirSync, existsSync, appendFileSync, statSync,
} from 'node:fs';
import { join, resolve, sep, relative, isAbsolute, dirname } from 'node:path';
import { selectToken } from './lib/store.mjs';
import { detectGithubRemote, repoToplevel } from './lib/gitRemote.mjs';
import { callTool, resultText } from './lib/rpc.mjs';
import { containsShellDirective } from './lib/skillGuard.mjs';

const MCP_URL = process.env.CLAUDE_CODE_MCP_SERVER_URL || 'https://owen-vibeagent-git-develop-polaris-office.vercel.app/api/local-ai/mcp';
const PLUGIN_VERSION = '2.0.0';
const MAX_SKILLS = 50;
const MAX_TOTAL = 1024 * 1024;
const MAX_FILE = 100 * 1024;
const NAME_RE = /^pax-[a-z][a-z0-9-]*[a-z0-9]$/;
const SEG_RE = /^[\p{L}\p{N} ._-]{1,128}$/u;
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const ROOTS = [join('.claude', 'skills'), join('.agents', 'skills')];
const MARKER = '.pax-managed';

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }
const dir = resolve(arg('--project-dir') || process.cwd());
const out = (s) => process.stdout.write(`${s}\n`);
const die = (code, msg) => { process.stderr.write(`${msg}\n`); process.exit(code); };
// 모든 경로 조립·git 호출은 realpath 기준 — `--project-dir` 가 심볼릭 링크면 논리 경로로 만든 대상이 realDir 밖(`..`)으로 보여 전부 skip 되던 결함.
let realDir;
try { realDir = realpathSync(dir); } catch { die(2, `no_dir: 폴더가 없어요 — ${dir}`); }

const toplevel = repoToplevel(dir);
if (!toplevel) die(2, 'not_git_repo: git 저장소 폴더가 아니에요 — clone 한 프로젝트 폴더에서 실행하세요(추적·exclude 검사를 할 수 없어요).');
const remote = detectGithubRemote(dir);
if (!remote) die(2, 'no_github_remote: 이 폴더의 origin 이 GitHub 저장소가 아니에요.');
const sel = selectToken({ mcpUrl: MCP_URL, cwd: dir });
if (sel.kind !== 'project') die(3, `not_connected: ${remote.slug} 에 대한 PAX 연결이 없어요(${sel.reason ?? sel.kind}). /pax-preview:connect 로 이 프로젝트를 연결하세요.`);

const call = await callTool(MCP_URL, sel.entry.token, 'get_project_skills', {}, { pluginVersion: PLUGIN_VERSION, timeoutMs: 30_000 }).catch((e) => ({ ok: false, message: e?.message ?? String(e) }));
if (!call.ok) die(1, `bundle_error: ${call.message}`);
const result = call.result;
const bundle = result?.structuredContent;
if (result?.isError || !bundle || !Array.isArray(bundle.skills)) die(1, `bundle_error: ${resultText(result) || '스킬 번들을 받지 못했어요'}`);
const degraded = bundle.degraded === true;
const skippedServer = Array.isArray(bundle.skipped) ? bundle.skipped : [];

// ── 검증 ─────────────────────────────────────────────────────────────────────
const skipped = skippedServer.map((s) => ({ name: String(s.name), reason: String(s.reason) }));
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
  desired.push({ name, source: skill.source, files });
}
for (const extra of bundle.skills.slice(MAX_SKILLS)) skipped.push({ name: String(extra?.name ?? '?'), reason: 'limit' });
const skippedNames = new Set(skipped.map((s) => s.name));
const desiredNames = new Set(desired.map((d) => d.name));

// ── 파일시스템 안전 ────────────────────────────────────────────────────────────
function noSymlinkWalk(target) {
  // dir 부터 target 까지 각 구성요소 lstat — 심볼릭 링크면 false. 존재하지 않는 구성요소는 통과(생성 예정).
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
  try {
    const o = execFileSync('git', ['-C', realDir, 'ls-files', '--', relPath], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    return o.trim().length > 0;
  } catch { return false; }
}
function isManaged(path) {
  try { return lstatSync(path).isDirectory() && lstatSync(join(path, MARKER)).isFile(); } catch { return false; }
}

let added = 0, updated = 0, deleted = 0, warnings = [];
let permissionError = null;
for (const rootRel of ROOTS) {
  const root = join(realDir, rootRel);
  if (!noSymlinkWalk(root)) { warnings.push(`${rootRel}: 경로에 심볼릭 링크가 있어 건너뜀`); continue; }
  try {
    mkdirSync(root, { recursive: true });
  } catch (e) {
    if (e?.code === 'EPERM' || e?.code === 'EACCES') { permissionError = e; break; }
    warnings.push(`${rootRel}: 폴더를 만들 수 없어요(${e?.code ?? e})`); continue;
  }
  for (const skill of desired) {
    const final = join(root, skill.name);
    const relFinal = join(rootRel, skill.name);
    if (!noSymlinkWalk(final) || !sealed(final)) { warnings.push(`${relFinal}: 심볼릭 링크 경로라 건너뜀`); skippedNames.add(skill.name); continue; }
    if (tracked(relFinal)) { warnings.push(`${relFinal}: git 이 추적 중인 파일이 있어 덮어쓰지 않았어요(수동 정리 필요)`); skippedNames.add(skill.name); continue; }
    const existed = existsSync(final);
    if (existed && !isManaged(final)) { warnings.push(`${relFinal}: PAX 가 만든 폴더가 아니라 보존했어요(.pax-managed 없음)`); skippedNames.add(skill.name); continue; }
    // 변경 없음 검사 — 같은 내용이면 건드리지 않는다(갱신 카운트 0).
    let same = existed;
    if (existed) {
      try {
        for (const f of skill.files) {
          if (readFileSync(join(final, ...f.path.split('/')), 'utf8') !== f.content) { same = false; break; }
        }
        if (same) {
          const walk = (d, acc, base) => { for (const n of readdirSync(d)) { const p = join(d, n); if (lstatSync(p).isDirectory()) walk(p, acc, base); else acc.push(relative(base, p).split(sep).join('/')); } return acc; };
          const present = walk(final, [], final).filter((p) => p !== MARKER).sort();
          const want = skill.files.map((f) => f.path).sort();
          same = JSON.stringify(present) === JSON.stringify(want);
        }
      } catch { same = false; }
    }
    if (same) continue;
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
      writeFileSync(join(tmpNew, MARKER), `source=${skill.source}\nsynced=${new Date().toISOString()}\n`, { mode: 0o644 });
      if (existed) renameSync(final, tmpOld);
      renameSync(tmpNew, final);
      if (existed) rmSync(tmpOld, { recursive: true, force: true });
      if (existed) updated++; else added++;
    } catch (e) {
      rmSync(tmpNew, { recursive: true, force: true });
      if (!existsSync(final) && existsSync(tmpOld)) { try { renameSync(tmpOld, final); } catch { /* ignore */ } }
      if (e?.code === 'EPERM' || e?.code === 'EACCES') { permissionError = e; break; }
      warnings.push(`${relFinal}: 쓰기 실패(${e?.code ?? e?.message ?? e})`);
    }
  }
  if (permissionError) break;
  // 삭제 — degraded·오류면 0건. 마커 있는 pax-* 만, desired·skipped 밖. git 추적 중이면 쓰기와 같은 규칙으로 보존(경고).
  if (!degraded) {
    for (const name of readdirSync(root)) {
      if (!NAME_RE.test(name) || desiredNames.has(name) || skippedNames.has(name)) continue;
      const p = join(root, name);
      if (!isManaged(p) || !noSymlinkWalk(p) || !sealed(p)) continue;
      if (tracked(join(rootRel, name))) { warnings.push(`${join(rootRel, name)}: git 이 추적 중인 파일이 있어 지우지 않았어요(수동 정리 필요)`); continue; }
      try { rmSync(p, { recursive: true, force: false }); deleted++; } catch (e) { warnings.push(`${join(rootRel, name)}: 삭제 실패(${e?.code ?? e})`); }
    }
  }
}
if (permissionError) {
  die(5, `sandbox: 스킬 파일을 쓸 수 없어요(${permissionError.code}) — 샌드박스 제한으로 보여요. 터미널에서 직접 실행하거나 샌드박스를 끄고 재시도하세요.`);
}

// ── .git/info/exclude ─────────────────────────────────────────────────────────
try {
  const gitPath = execFileSync('git', ['-C', realDir, 'rev-parse', '--git-path', 'info/exclude'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
  const excludePath = isAbsolute(gitPath) ? gitPath : resolve(realDir, gitPath);
  mkdirSync(dirname(excludePath), { recursive: true });
  const prefix = relative(realpathSync(toplevel), realDir).split(sep).filter(Boolean).join('/');
  const patterns = ROOTS.map((r) => `/${prefix ? `${prefix}/` : ''}${r.split(sep).join('/')}/pax-*/`);
  const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const lines = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = patterns.filter((p) => !lines.has(p));
  if (missing.length) {
    const lead = existing.length && !existing.endsWith('\n') ? eol : '';
    appendFileSync(excludePath, `${lead}${missing.join(eol)}${eol}`);
  }
} catch (e) {
  warnings.push(`.git/info/exclude 갱신 실패(${e?.code ?? e?.message ?? e}) — git status 에 .claude/skills/pax-* 가 보일 수 있어요`);
}

for (const w of warnings) out(`(주의) ${w}`);
for (const s of skipped) out(`(건너뜀) ${s.name}: ${s.reason}`);
if (degraded) out('(주의) 서버 조회가 일부 실패해 삭제는 하지 않았어요.');
out(`[스킬 동기화] 추가 ${added} 갱신 ${updated} 삭제 ${deleted} 건너뜀 ${skipped.length}${desired.length ? ` — 스킬은 pax-* 이름으로 자동 등장해요` : ''}`);
