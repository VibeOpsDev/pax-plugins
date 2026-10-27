import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isInsideDir } from './gitRemote.mjs';

/** Explicit routing is authoritative: an invalid path must never become a fallback. */
export function validateProjectDir(value, pluginRoot) {
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value)) {
    throw new Error('projectDir: 현재 프로젝트 폴더의 절대 경로가 필요합니다.');
  }
  let dir;
  try {
    dir = realpathSync(value);
    if (!statSync(dir).isDirectory()) throw new Error();
  } catch {
    throw new Error('projectDir: 존재하는 프로젝트 폴더를 지정하세요.');
  }
  if (isInsideDir(dir, pluginRoot)) throw new Error('projectDir: 플러그인 설치 폴더는 프로젝트가 아닙니다.');
  return dir;
}

export function projectDirArgument(argv, pluginRoot) {
  const i = argv.indexOf('--project-dir');
  if (i >= 0) return validateProjectDir(argv[i + 1], pluginRoot);
  if (argv.includes('--require-project-dir')) {
    throw new Error('projectDir: --project-dir <현재 프로젝트 절대 경로>가 필요합니다.');
  }
  return null;
}
