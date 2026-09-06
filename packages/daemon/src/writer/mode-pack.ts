/**
 * Mode pack (SDD 006 §5). ONE fixed file — like the persona pack, no per-channel
 * directory: `writer/mode-pack.md`, present or absent.
 *
 * The mode pack is where a beat's `mode` and `turn` (SDD 006 §3) get real quotes
 * and craft instructions. STUDY only sees a short definition table in its prompt
 * (no quotes — it only picks, never performs); WRITE and REPAIR are the stages
 * that actually read this file, the same way they read the general pack.
 *
 * Deliberately fail-closed, unlike the persona pack: a missing or incomplete mode
 * pack means WRITE cannot know how to play the modes STUDY committed to, so
 * `dispatchWrite`/`dispatchRepair` must refuse to dispatch rather than silently
 * write without it. See `validateModePack`.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writerRoot } from '../paths.ts';
import { WRITER_BEAT_MODES, WRITER_BEAT_TURNS } from './video-plan.ts';

const MODE_PACK_FILENAME = 'mode-pack.md';

export interface ModePack {
  /** Always `mode-pack.md` — kept as a field so call sites don't hardcode it. */
  path: string;
  hash: string;
  markdown: string;
}

export function hashModePack(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex');
}

/**
 * Returns `null` for the two states that both mean "this run has no mode
 * pack": the file does not exist (ENOENT), or it exists but is empty/
 * whitespace-only. Any OTHER read failure (permissions, I/O error, a
 * directory where a file was expected, …) is a real problem, not an absence,
 * so it is re-thrown rather than swallowed — same shape as `persona-pack.ts`'s
 * `getPersonaPack`.
 */
export async function getModePack(dataDir?: string): Promise<ModePack | null> {
  const path = join(writerRoot(dataDir), MODE_PACK_FILENAME);
  let markdown: string;
  try {
    markdown = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(
      `[mode-pack] failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  if (!markdown.trim()) return null;
  return { path: MODE_PACK_FILENAME, hash: hashModePack(markdown), markdown };
}

/**
 * Fail-closed structural check (SDD 006 §5): every one of the 6 modes and 6
 * lateral turns must have its own `## Mode: <id>` / `## Phép lật: <id>` heading
 * at the start of a line. The heading may carry a trailing ` — Tên` label; only
 * the `<id>` token right after the colon is matched. Content quality (real
 * quotes, "khi nào KHÔNG dùng", …) is a human editorial concern, not something
 * this parser checks — it only refuses to let WRITE run on a file missing a
 * whole section outright.
 */
export function validateModePack(markdown: string): { ok: true } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  for (const mode of WRITER_BEAT_MODES) {
    const heading = new RegExp(`^##\\s*Mode:\\s*${mode}\\b`, 'm');
    if (!heading.test(markdown)) missing.push(`Mode: ${mode}`);
  }
  for (const turn of WRITER_BEAT_TURNS) {
    const heading = new RegExp(`^##\\s*Phép lật:\\s*${turn}\\b`, 'm');
    if (!heading.test(markdown)) missing.push(`Phép lật: ${turn}`);
  }
  return missing.length > 0 ? { ok: false, missing } : { ok: true };
}
