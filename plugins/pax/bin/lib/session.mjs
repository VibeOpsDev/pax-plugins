/** Codex conversation identity comes from host metadata, never tool arguments. */
import { join } from 'node:path';
import { existsSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { instanceDir, instanceKey, readJson, writeJsonAtomic, isUsable, repoUrlToSlug, isValidRepoSlug } from './store.mjs';
export function validateSessionId(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    throw new Error('session_required: Codex 채팅 ID를 확인할 수 없어요. Codex를 업데이트하고 이 채팅에서 다시 연결하세요. 다른 채팅의 ID를 입력하지 마세요.');
  return id.toLowerCase();
}
export function sessionFromMeta(meta) { return validateSessionId(meta?.threadId); }
export function sessionDir(url, id) { return join(instanceDir(url), 'sessions', instanceKey(validateSessionId(id))); }
export function readSessionToken(url, id) { return readJson(join(sessionDir(url, id), 'token.json')); }
export function writeSessionToken(url, id, data) {
  if (!isValidRepoSlug(repoUrlToSlug(data.repoUrl)) || !isUsable(data)) throw new Error('invalid_session_token');
  writeJsonAtomic(join(sessionDir(url, id), 'token.json'), { ...data, savedAt: new Date().toISOString() });
}
export function deleteSessionToken(url, id) {
  try { unlinkSync(join(sessionDir(url, id), 'token.json')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
export function hasSessionTokens(url) {
  const dir = join(instanceDir(url), 'sessions');
  return existsSync(dir) && readdirSync(dir).some(n => existsSync(join(dir, n, 'token.json')));
}
/** Caller holds this session's pending lock. Cancellation survives late exchange responses. */
export function cancelSessionPending(url, id) {
  const dir = sessionDir(url, id);
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!/^pending-.*\.json$/.test(name)) continue;
    writeFileSync(join(dir, name + '.cancelled'), '', { mode: 0o600 });
    try { unlinkSync(join(dir, name)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}
