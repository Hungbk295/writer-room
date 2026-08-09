import { mkdir, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const APP_ROOT = resolve(import.meta.dir, '../../..');

export function dataRoot(): string {
  return resolve(process.env.WRITER_ROOM_DATA_DIR || join(APP_ROOT, 'writer-room-data'));
}

export function configDir(root = dataRoot()): string {
  return join(root, 'config');
}

export function spyRoot(root = dataRoot()): string {
  return join(root, 'spy');
}

export function spyDbPath(root = dataRoot()): string {
  return join(spyRoot(root), 'spy.sqlite');
}

export function spyConfigPath(root = dataRoot()): string {
  return join(configDir(root), 'spy.json');
}

export function writerExportsRoot(root = dataRoot()): string {
  return join(root, 'exports', 'writer');
}

/** Root for Training (SDD 002 §M1) persisted Formula artifacts — mirrors
 * `writerExportsRoot`'s JSON-per-record-under-a-data-root shape (see
 * `packages/daemon/src/training/storage.ts`). */
export function trainingRoot(root = dataRoot()): string {
  return join(root, 'training');
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}
