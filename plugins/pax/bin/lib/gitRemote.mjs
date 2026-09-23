/**
 * 폴더의 GitHub remote 해석 — 토큰 파일 선택·연결 힌트·스킬 동기화가 공용으로 쓴다.
 * 셸 없이 `git -C <cwd> config --get remote.origin.url`(1s). git 부재·safe.directory 오류·비저장소는 "remote 없음"(null).
 * GitHub **만** 인정(다른 호스트·`github.com.evil.com`·3세그먼트 이상 거부) → `owner/name` 소문자 slug.
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';

/**
 * `dir` 가 `root` 자신이거나 그 아래인가(논리 경로·realpath 양쪽으로 대조). 프록시·연결 스크립트가 **플러그인 설치 폴더 안**에서
 * 실행될 때(Codex 는 플러그인 루트를 cwd 로 띄운다) 마켓플레이스 clone 의 remote(`<org>/pax-plugins`)를 프로젝트로 오인하지 않게 쓴다.
 */
export function isInsideDir(dir, root) {
  if (!dir || !root) return false;
  const under = (a, b) => a === b || a.startsWith(b + sep);
  const d = resolve(dir);
  const r = resolve(root);
  if (under(d, r)) return true;
  try { return under(realpathSync(d), realpathSync(r)); } catch { return false; }
}

// https://github.com/O/R(.git)?/? · https://user(:pw)?@github.com/O/R.git · git@github.com:O/R(.git)? · ssh://git@github.com(:22)?/O/R · github.com:O/R
const GITHUB_REMOTE_RE =
  /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|(?:[^@/]+@)?)github\.com(?::\d+)?[:/]([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/;

/** remote URL → `owner/name`(소문자) | null. 순수 함수(테스트 대상). */
export function parseGithubRemote(url) {
  if (typeof url !== 'string') return null;
  const m = url.trim().match(GITHUB_REMOTE_RE);
  if (!m) return null;
  const name = m[2];
  if (!name || name === '.' || name === '..') return null;
  return `${m[1]}/${name}`.toLowerCase();
}

const cache = new Map(); // cwd → { at, value }
const CACHE_MS = 60_000;
let warned = false;

/** 폴더의 origin remote (GitHub 만). 실패는 null — 한 번만 stderr 안내. */
export function detectGithubRemote(cwd) {
  if (!cwd) return null;
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  let value = null;
  try {
    const out = execFileSync('git', ['-C', cwd, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const slug = parseGithubRemote(out);
    value = slug ? { slug, url: out.trim() } : null;
  } catch (e) {
    // ENOENT(git 없음)·비저장소(exit 1)·safe.directory 거부 — 전부 "remote 없음"
    if (e?.code === 'ENOENT' && !warned) {
      warned = true;
      process.stderr.write('[pax] git 을 찾을 수 없어 폴더의 remote 를 확인하지 못했어요(최근 연결로 동작).\n');
    }
    value = null;
  }
  cache.set(cwd, { at: Date.now(), value });
  return value;
}

/** 저장소 최상위 경로 | null. */
export function repoToplevel(cwd) {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    }).trim() || null;
  } catch {
    return null;
  }
}
