import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataRoot, ensureDir } from './paths.ts';

export interface DaemonLock {
  pid: number;
  port: number;
  startedAt: string;
  version: string;
}

export function lockPath(root = dataRoot()): string {
  return join(root, '.daemon.lock');
}

export async function readLock(root = dataRoot()): Promise<DaemonLock | null> {
  try {
    return JSON.parse(await readFile(lockPath(root), 'utf8')) as DaemonLock;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Single-process lock. Returns existing endpoint if another daemon is alive. */
export async function acquireLock(
  port: number,
  root = dataRoot(),
  version = '2.0.0',
): Promise<{ ok: true; lock: DaemonLock } | { ok: false; existing: DaemonLock }> {
  await ensureDir(root);
  const existing = await readLock(root);
  if (existing && pidAlive(existing.pid)) {
    return { ok: false, existing };
  }
  if (existing) await unlink(lockPath(root)).catch(() => {});
  const lock: DaemonLock = {
    pid: process.pid,
    port,
    startedAt: new Date().toISOString(),
    version,
  };
  try {
    await writeFile(lockPath(root), `${JSON.stringify(lock, null, 2)}\n`, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const raced = await readLock(root);
    if (raced && pidAlive(raced.pid)) return { ok: false, existing: raced };
    await unlink(lockPath(root)).catch(() => {});
    await writeFile(lockPath(root), `${JSON.stringify(lock, null, 2)}\n`, { flag: 'wx' });
  }
  return { ok: true, lock };
}

export async function releaseLock(root = dataRoot()): Promise<void> {
  const existing = await readLock(root);
  if (existing && existing.pid === process.pid) {
    await unlink(lockPath(root)).catch(() => {});
  }
}
