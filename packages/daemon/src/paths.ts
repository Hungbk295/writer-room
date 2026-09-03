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

/**
 * Staging area for general-pack MCP drafts (agent-generated TASTE DNA / per-video
 * entries that have already passed deterministic grounding validation but have not
 * been reviewed and committed into the pinned channel file yet). Separate from
 * `generalPacksRoot` so a half-reviewed draft can never be picked up as the live
 * pack a writer run hashes and pins.
 */
export function generalPackStagingRoot(root = dataRoot()): string {
  return join(generalPacksRoot(root), '.staging');
}

/**
 * Channel styles (Writer v2 restyle) — one hand-curated markdown file per style
 * (`nhan-vat-xuyen-suot.md`), telling the writer HOW the user's own channel
 * sounds: person and address, cast, beat labels, rhetorical budgets, ending
 * contract, boundaries. Same plain-file store as `generalPacksRoot` and for the
 * same reason: edited by a human, reviewed by a human, pinned by content hash.
 * Lives under the data root — not under `.claude/` — because the daemon reads it
 * and may run from a different cwd. Never a source of facts.
 */
export function channelStylesRoot(root = dataRoot()): string {
  return join(root, 'channel-styles');
}

/**
 * Publishing-channel profiles and their human-authored editorial notebooks.
 * This is deliberately separate from Spy topics and harvested YouTube channels:
 * one publishing channel can research many topics, and one topic can feed more
 * than one publishing channel.
 */
export function publishingChannelsRoot(root = dataRoot()): string {
  return join(root, 'channels');
}

/**
 * User-authored reusable Writer procedures in the native Codex skill shape.
 * Keeping these below the data root makes them portable with the user's clean
 * Writer Room data package instead of baking learned procedures into the app.
 */
export function writerProceduresRoot(root = dataRoot()): string {
  return join(root, '.agents', 'skills');
}

/**
 * Competitor hook libraries (Writer v2 pre-write). One markdown file of hook
 * formulas mined from other channels — craft frames only, never facts. The
 * agent reads this when suggesting a few openings; the UI does not browse it.
 * Same plain-file store as general packs / channel styles, pinned by hash.
 */
export function hookLibrariesRoot(root = dataRoot()): string {
  return join(root, 'hook-libraries');
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
