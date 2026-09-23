/**
 * 토큰 파일 저장소 — 프록시·연결·동기화 공용 (2.0.0).
 *
 * 레이아웃: `~/.config/vibeagent/<instanceKey>/<owner--name>.json`(프로젝트별) + `recent.json`(최근 연결) + `pending-*.json`(연결 진행 상태).
 * instanceKey = sha256(MCP URL)[:16](1.x 와 동일 — 인스턴스 구분). 구 1.x 단일 파일 `~/.config/vibeagent/<instanceKey>.json` 은
 * **승격** 대상(JWT payload 무검증 디코드로 jti·repo_url_hash 만 얻고, 프록시가 첫 `status` 로 repoUrl 을 학습해 이관).
 *
 * 선택 규칙(`selectToken`): 폴더 remote 가 GitHub 로 해석되면 **그 키 파일만** 후보(없음·만료 = 재연결 안내, recent 폴백 금지 —
 * A 폴더에서 A 만료 시 B 토큰으로 쓰기 도구가 B 에 나가면 안 된다). recent/legacy 는 remote 가 없거나 GitHub 외 호스트일 때만
 * (Codex 플러그인 설치 폴더·비저장소 폴더). `process.cwd()` 1순위, `CLAUDE_PROJECT_DIR` 은 cwd 에 remote 가 없을 때만.
 * 만료 판정은 `expiresAt + 60s` 까지 시도하고 서버 401 을 권위로 둔다.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, existsSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { detectGithubRemote, repoToplevel } from './gitRemote.mjs';

export const CONFIG_ROOT = join(homedir(), '.config', 'vibeagent');
const EXPIRY_GRACE_MS = 60_000;

export function instanceKey(mcpUrl) {
  return createHash('sha256').update(String(mcpUrl)).digest('hex').slice(0, 16);
}
export function instanceDir(mcpUrl) {
  return join(CONFIG_ROOT, instanceKey(mcpUrl));
}
/** 1.x 단일 파일 경로(승격 원본). */
export function legacyTokenPath(mcpUrl) {
  return join(CONFIG_ROOT, `${instanceKey(mcpUrl)}.json`);
}
const REPO_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9._-]{1,100}$/;
/** `owner/name` 소문자 slug 형식 검사 — 파일 키·URL 힌트(`repo=`)에 넣기 전 게이트(깨진 recent.json 이 연결을 막지 않게). */
export function isValidRepoSlug(slug) {
  return typeof slug === 'string' && REPO_SLUG_RE.test(slug);
}
/** `owner/name` → 파일명 `owner--name`(소문자, 안전 문자만). */
export function localRepoKey(slug) {
  const s = String(slug).toLowerCase();
  if (!REPO_SLUG_RE.test(s)) throw new Error(`repo slug 형식이 아닙니다: ${slug}`);
  return s.replace('/', '--').replace(/[^a-z0-9._-]/g, '_');
}
export function repoUrlToSlug(repoUrl) {
  const m = String(repoUrl ?? '').match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)\/?$/i);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}
export function projectTokenPath(mcpUrl, slug) {
  return join(instanceDir(mcpUrl), `${localRepoKey(slug)}.json`);
}
export function recentPath(mcpUrl) {
  return join(instanceDir(mcpUrl), 'recent.json');
}

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** temp+rename 원자 쓰기 — dir 0700, file 0600. Windows 는 EPERM/EBUSY 시 50ms×5 재시도. */
export function writeJsonAtomic(path, obj, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj), { mode });
  let lastErr = null;
  for (let i = 0; i < 5; i++) {
    try {
      renameSync(tmp, path);
      return;
    } catch (e) {
      lastErr = e;
      if (e?.code !== 'EPERM' && e?.code !== 'EBUSY') break;
      const until = Date.now() + 50;
      while (Date.now() < until) { /* spin 50ms */ }
    }
  }
  try { unlinkSync(tmp); } catch { /* ignore */ }
  throw lastErr;
}

export function decodeJwtPayload(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

export function isUsable(entry) {
  if (!entry || typeof entry.token !== 'string' || !entry.token) return false;
  if (!entry.expiresAt) return true;
  const t = new Date(entry.expiresAt).getTime();
  return !Number.isFinite(t) || t + EXPIRY_GRACE_MS > Date.now();
}

export function readProjectToken(mcpUrl, slug) {
  try { return readJson(projectTokenPath(mcpUrl, slug)); } catch { return null; }
}
/** data = { token, expiresAt, scopes, jti, repoUrl } — 키는 **서버가 돌려준 repoUrl** 로 만든다. */
export function writeProjectToken(mcpUrl, data) {
  const slug = repoUrlToSlug(data.repoUrl);
  if (!slug) throw new Error('repoUrl 이 GitHub 주소가 아닙니다.');
  writeJsonAtomic(projectTokenPath(mcpUrl, slug), { ...data, savedAt: new Date().toISOString() });
  writeRecent(mcpUrl, { slug, repoUrl: data.repoUrl });
  return slug;
}
export function deleteProjectToken(mcpUrl, slug) {
  try { unlinkSync(projectTokenPath(mcpUrl, slug)); return true; } catch { return false; }
}
/** 최근 연결 — slug 가 형식에 안 맞으면(손상·수동 편집) 없는 것으로 본다. */
export function readRecent(mcpUrl) {
  const recent = readJson(recentPath(mcpUrl));
  return recent && isValidRepoSlug(recent.slug) ? recent : null;
}
export function writeRecent(mcpUrl, { slug, repoUrl }) {
  writeJsonAtomic(recentPath(mcpUrl), { slug, repoUrl, at: new Date().toISOString() });
}
export function readLegacy(mcpUrl) {
  const p = legacyTokenPath(mcpUrl);
  if (!existsSync(p)) return null;
  const entry = readJson(p);
  if (!entry || typeof entry.token !== 'string') return null;
  const payload = decodeJwtPayload(entry.token);
  return { ...entry, jti: entry.jti ?? payload?.jti ?? null, repoUrlHash: payload?.repo_url_hash ?? null, legacy: true };
}
/** 레거시 → 프로젝트 파일 이관(repoUrl 학습 후). 원본 삭제. */
export function promoteLegacy(mcpUrl, legacyEntry, repoUrl) {
  const slug = writeProjectToken(mcpUrl, {
    token: legacyEntry.token, expiresAt: legacyEntry.expiresAt ?? null, scopes: legacyEntry.scopes ?? [], jti: legacyEntry.jti ?? null, repoUrl,
  });
  try { unlinkSync(legacyTokenPath(mcpUrl)); } catch { /* ignore */ }
  return slug;
}

/**
 * 폴더 바인딩 — `folders.json`: { [폴더 realpath]: { slug, repoUrl, at } }. remote 가 없는 폴더(빈 폴더·상위 폴더)에서 연결이 끝나면
 * connect 스크립트가 기록하고, 프록시는 그 폴더에서만 그 프로젝트를 쓴다.
 * 2026-09-21: remote 없는 폴더가 전역 recent.json 을 보던 탓에 세션 두 개(빈 폴더 A·B)가 마지막 연결 프로젝트를 서로 공유해
 * B 세션이 A 프로젝트로 환경을 만들던 문제. recent 는 이제 cwd 가 없는 호출(Codex — 플러그인 폴더 실행)에만 쓴다.
 */
export function foldersPath(mcpUrl) {
  return join(instanceDir(mcpUrl), 'folders.json');
}
export function folderKey(dir) {
  // git 안이면 최상위 폴더로 정규화 — Bash 도구의 cwd 는 이전 `cd` 가 유지되므로 하위 폴더에서 연결이 끝나도 프록시(프로젝트 루트 cwd)와 같은 키를 본다.
  // 여기 오는 git 저장소는 remote 없는 것뿐(remote 가 있으면 selectToken 이 앞서 remote 로 핀). 비-git 폴더는 realpath 그대로.
  const base = repoToplevel(dir) ?? dir;
  try { return realpathSync(base); } catch { return resolve(base); }
}
function readFolders(mcpUrl) {
  const j = readJson(foldersPath(mcpUrl));
  return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
}
export function readFolderBinding(mcpUrl, dir) {
  if (!dir) return null;
  const b = readFolders(mcpUrl)[folderKey(dir)];
  return b && isValidRepoSlug(b.slug) ? b : null;
}
export function writeFolderBinding(mcpUrl, dir, { slug, repoUrl }) {
  // 읽기-수정-쓰기(파일 교체는 원자) — 두 연결이 같은 순간에 끝나면 한쪽 항목이 밀릴 수 있다(확률 극히 낮음, 재연결로 복구). 락은 두지 않는다.
  if (!dir || !isValidRepoSlug(slug)) return false;
  const all = readFolders(mcpUrl);
  all[folderKey(dir)] = { slug, repoUrl, at: new Date().toISOString() };
  writeJsonAtomic(foldersPath(mcpUrl), all);
  return true;
}
export function deleteFolderBinding(mcpUrl, dir) {
  if (!dir) return false;
  const all = readFolders(mcpUrl);
  const key = folderKey(dir);
  if (!(key in all)) return false;
  delete all[key];
  writeJsonAtomic(foldersPath(mcpUrl), all);
  return true;
}

/**
 * 어느 토큰을 쓸지 — { kind: 'project'|'folder'|'recent'|'legacy'|'none', entry, slug, remote, reason }.
 * 순서: ① 폴더 remote(GitHub) → 그 프로젝트 파일만 ② remote 없는 폴더 → **폴더 바인딩**(없으면 `none`/`no_folder_binding` — 다른 폴더의
 * 연결로 새지 않는다) ③ cwd 자체가 없는 호출(Codex 플러그인 폴더) → 최근 연결(recent) → 구 단일 파일.
 * `remote` 는 폴더에서 해석된 GitHub slug(없으면 null) — 호출자가 "지금 폴더 ≠ 연결 프로젝트" 안내에 쓴다.
 */
export function selectToken({ mcpUrl, cwd, projectDirHint }) {
  // cwd 는 null 허용 — 호출자가 "이 폴더의 remote 는 보지 말라"(플러그인 설치 폴더 등)고 할 때.
  let remote = cwd ? detectGithubRemote(cwd) : null;
  if (!remote && projectDirHint && projectDirHint !== cwd) remote = detectGithubRemote(projectDirHint);
  const slug = remote?.slug ?? null;
  if (slug) {
    const entry = readProjectToken(mcpUrl, slug);
    if (isUsable(entry)) return { kind: 'project', entry, slug, remote: slug };
    // 프로젝트 파일이 없을 때만 레거시(repoUrl 미상) 후보 — 프록시가 status 로 학습해 일치하면 승격, 불일치면 거부.
    const legacy = readLegacy(mcpUrl);
    if (!entry && isUsable(legacy)) return { kind: 'legacy', entry: legacy, slug: null, remote: slug };
    return { kind: 'none', entry: null, slug, remote: slug, reason: entry ? 'expired' : 'no_token_for_repo' };
  }
  if (cwd || projectDirHint) {
    // remote 없는 폴더 — 이 폴더에서 연결한 프로젝트만. 다른 세션이 최근에 연결한 프로젝트로 새지 않는다.
    const bound = readFolderBinding(mcpUrl, cwd) ?? (projectDirHint && projectDirHint !== cwd ? readFolderBinding(mcpUrl, projectDirHint) : null);
    if (bound) {
      const entry = readProjectToken(mcpUrl, bound.slug);
      if (isUsable(entry)) return { kind: 'folder', entry, slug: bound.slug, remote: null };
      return { kind: 'none', entry: null, slug: bound.slug, remote: null, reason: 'expired' };
    }
    return { kind: 'none', entry: null, slug: null, remote: null, reason: 'no_folder_binding' };
  }
  const recent = readRecent(mcpUrl);
  if (recent?.slug) {
    const entry = readProjectToken(mcpUrl, recent.slug);
    if (isUsable(entry)) return { kind: 'recent', entry, slug: recent.slug, remote: null };
  }
  const legacy = readLegacy(mcpUrl);
  if (isUsable(legacy)) return { kind: 'legacy', entry: legacy, slug: null, remote: null };
  return { kind: 'none', entry: null, slug: null, remote: null, reason: 'no_token' };
}

/** 이 인스턴스의 프로젝트 토큰 파일 목록(만료 포함) — 힌트·정리용. */
export function listProjectTokens(mcpUrl) {
  const dir = instanceDir(mcpUrl);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json') || name === 'recent.json' || name.startsWith('pending-')) continue;
    const entry = readJson(join(dir, name));
    if (entry?.repoUrl) out.push({ file: join(dir, name), ...entry, mtime: statSync(join(dir, name)).mtimeMs });
  }
  return out;
}
