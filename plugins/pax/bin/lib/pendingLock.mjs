import { openSync, closeSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readJson } from './store.mjs';

/** One lock for startup, completion and disconnect in the same pending scope. */
export function acquirePendingLock(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'connect.lock');
  const owner = { pid: process.pid, nonce: randomBytes(16).toString('hex') };
  const remove = (p) => { try { unlinkSync(p); } catch { /* already gone */ } };
  const create = () => {
    const fd = openSync(path, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(owner)); } finally { closeSync(fd); }
  };
  try { create(); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // Serialize dead-owner recovery so two contenders cannot unlink a new owner's lock.
    let recovery;
    try { recovery = openSync(`${path}.recovery`, 'wx', 0o600); }
    catch (err) { if (err.code === 'EEXIST') return null; throw err; }
    try {
      const previous = readJson(path);
      if (!Number.isInteger(previous?.pid) || previous.pid <= 1) return null;
      try { process.kill(previous.pid, 0); return null; }
      catch (err) { if (err.code !== 'ESRCH') return null; }
      remove(path);
      try { create(); }
      catch (err) { if (err.code === 'EEXIST') return null; throw err; }
    } finally { closeSync(recovery); remove(`${path}.recovery`); }
  }
  return () => { if (readJson(path)?.nonce === owner.nonce) remove(path); };
}
