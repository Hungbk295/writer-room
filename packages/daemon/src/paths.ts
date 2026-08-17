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

/**
 * Writer product root (runs + taste cases) — separate from Source Pack staging
 * under `exports/writer` and from Training under `training/`. ADR-FM10: Writer
 * never shares a store with Formula artifacts.
 */
export function writerRoot(root = dataRoot()): string {
  return join(root, 'writer');
}

/**
 * General packs (Write Loop v2 Phase 2) — one hand-curated markdown file per
 * channel (`hieu-tv.md`), describing HOW that channel makes moves: taste DNA plus
 * one entry per video (hook / outline / example + provenance tags / payoff /
 * boundary). Deliberately a plain file store, not a DB: it is edited by a human,
 * reviewed by a human, and pinned by content hash on every run that uses it.
 * Never a source of facts — facts come only from the topic pack.
 */
export function generalPacksRoot(root = dataRoot()): string {
  return join(root, 'general-packs');
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
