/**
 * Human pack (SDD 007 §2). ONE fixed file — same shape as the mode pack and
 * the persona pack: `writer/human-pack.md`, present or absent, no per-channel
 * directory.
 *
 * A mode pack answers "which FORM does this beat take". A human pack answers
 * a different question: which sentence-level GESTURE, dropped in anywhere,
 * makes a listener believe a real person is thinking out loud (self-correcting,
 * admitting a gap, narrowing their own claim, leaving the listener a way out).
 * These are cử chỉ (gestures) — the DIRECTION a gesture points (a stance, a
 * claimed standard) comes from the persona pack, never from here. The human
 * pack carries no facts and licenses no claim on its own.
 *
 * Deliberately OPTIONAL, unlike the mode pack: a human pack is seasoning, not
 * the frame a beat is built on. `dispatchWrite`/`dispatchRepair` must run WITHOUT
 * one when the file is simply absent — only a file that EXISTS but is missing a
 * required heading is a configuration error worth failing the run over (a
 * broken file is not the same state as "no file yet"). See `validateHumanPack`.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writerRoot } from '../paths.ts';

const HUMAN_PACK_FILENAME = 'human-pack.md';

/** SDD 007 §2 mục 2: the 8 fixed gesture ids, in the file's own order. */
export const HUMAN_PACK_GESTURE_IDS = [
  'lech-chuan',
  'duong-may',
  'khong-biet',
  'rao-pham-vi',
  'cua-lui',
  'guong-soi',
  'zoom-chu-cau',
  'cuc-tri-cau',
] as const;

export type HumanPackGestureId = typeof HUMAN_PACK_GESTURE_IDS[number];

export interface HumanPack {
  /** Always `human-pack.md` — kept as a field so call sites don't hardcode it. */
  path: string;
  hash: string;
  markdown: string;
}

export function hashHumanPack(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex');
}

/**
 * Returns `null` for the two states that both mean "this run has no human
 * pack": the file does not exist (ENOENT), or it exists but is empty/
 * whitespace-only. Any OTHER read failure (permissions, I/O error, a
 * directory where a file was expected, …) is a real problem, not an absence,
 * so it is re-thrown rather than swallowed — same shape as `mode-pack.ts`'s
 * `getModePack` and `persona-pack.ts`'s `getPersonaPack`.
 */
export async function getHumanPack(dataDir?: string): Promise<HumanPack | null> {
  const path = join(writerRoot(dataDir), HUMAN_PACK_FILENAME);
  let markdown: string;
  try {
    markdown = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(
      `[human-pack] failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  if (!markdown.trim()) return null;
  return { path: HUMAN_PACK_FILENAME, hash: hashHumanPack(markdown), markdown };
}

/**
 * Fail-closed structural check (SDD 007 §2 mục 2/4): every one of the 8
 * gestures must have its own `## Cử chỉ: <id>` heading at the start of a
 * line. The heading may carry a trailing ` — Tên` label; only the `<id>`
 * token right after the colon is matched. Content quality (real quotes,
 * "khi nào KHÔNG dùng", "cần lập trường gì", …) is a human editorial concern,
 * not something this parser checks — it only refuses to let a caller treat a
 * file missing a whole gesture as complete.
 *
 * Unlike the mode pack, a MISSING file is not itself a failure here — see
 * `getHumanPack`'s `null` return and the doc comment above. This function is
 * only reached once a file is known to exist, to tell a present-but-broken
 * file apart from a genuinely absent one.
 */
export function validateHumanPack(markdown: string): { ok: true } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  for (const id of HUMAN_PACK_GESTURE_IDS) {
    const heading = new RegExp(`^##\\s*Cử chỉ:\\s*${id}\\b`, 'm');
    if (!heading.test(markdown)) missing.push(`Cử chỉ: ${id}`);
  }
  return missing.length > 0 ? { ok: false, missing } : { ok: true };
}
