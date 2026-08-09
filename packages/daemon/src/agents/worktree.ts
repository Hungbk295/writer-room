/**
 * Isolated git worktree per agent (ADR-6).
 * Worktree lives under app data (`worktrees/<agentId>`), branch `writer-room/<agentId>`.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { exec } from '../exec.ts';

export function worktreePath(dataDir: string, agentId: string): string {
  return join(dataDir, 'worktrees', agentId);
}

export async function ensureWorktree(projectRoot: string, dataDir: string, agentId: string): Promise<string> {
  const dir = worktreePath(dataDir, agentId);
  if (existsSync(join(dir, '.git'))) return dir;
  mkdirSync(dirname(dir), { recursive: true });
  const branch = `writer-room/${agentId}`;
  try {
    await exec('git', ['-C', projectRoot, 'worktree', 'add', dir, '-b', branch], undefined, 30_000);
  } catch {
    await exec('git', ['-C', projectRoot, 'worktree', 'prune'], undefined, 30_000).catch(() => {});
    await exec('git', ['-C', projectRoot, 'worktree', 'add', dir, branch], undefined, 30_000);
  }
  return dir;
}

export async function removeWorktree(projectRoot: string, dataDir: string, agentId: string): Promise<void> {
  const dir = worktreePath(dataDir, agentId);
  if (!existsSync(dir)) return;
  await exec('git', ['-C', projectRoot, 'worktree', 'remove', '--force', dir], undefined, 30_000);
}
