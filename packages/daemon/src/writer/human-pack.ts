/**
 * Human pack v2 (SDD 007 §2, merged with the retired persona pack on
 * 2026-09-08). ONE fixed file — same shape as the mode pack: `writer/human-pack.md`,
 * present or absent, no per-channel directory. It is now the ONLY file about the
 * narrator, and it carries three regions:
 *
 * - Phần A — **cử chỉ** (craft): sentence-level gestures that make a listener
 *   believe a real person is thinking out loud. A gesture is a MOVEMENT, not a
 *   claim, so it needs no approval — and licenses nothing: it can never make a
 *   number or a name sayable.
 * - Phần B — **lập trường kênh** (stances) and Phần C — **trải nghiệm phóng tác**
 *   (adapted experiences): channel-owned material that DOES assert something in
 *   the channel's name, so each entry stays fail-closed behind its own
 *   `[ĐÃ DUYỆT]` marker (ADR-004, unchanged). Only these may ever be cited.
 *
 * A mode pack answers "which FORM does this beat take"; this file answers "who
 * is speaking, and how does that person move". Still never a source of topic
 * facts — those come only from `factsLedger`.
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
import { filterApprovedNarratorMarkdown } from './assertion-boundary.ts';

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

export interface ApprovedHumanPack extends HumanPack {
  /** What the model may CITE: the APPROVED Phần B/C entries' own text, never the
   * craft region and never an unapproved entry. See
   * `FilteredNarratorPack.citableText`. */
  citableText: string;
  /** How many Phần B/C entries carry an `[ĐÃ DUYỆT]` marker. `0` is a normal
   * state — the gestures still work, the narrator just has no signed-off
   * opinion to lean on yet. */
  approvedStanceCount: number;
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
 * `getModePack`.
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

/**
 * `getHumanPack` + ADR-004's fail-closed filter, composed: load the raw file,
 * then strip Phần B/C down to only APPROVED entries via
 * `filterApprovedNarratorMarkdown`, keeping Phần A (craft) untouched. The
 * filtered markdown is the only thing that may ever reach the model or pin a
 * turn key, so it is also the only thing this function's hash is ever taken of —
 * callers must never hash/stage the raw file from `getHumanPack`.
 *
 * Hashing the FILTERED markdown has a deliberate, useful consequence for the
 * turn key: editing a PENDING/REJECTED entry changes nothing the model sees, so
 * it does NOT change this hash — the owner can draft unapproved stances without
 * breaking cache. APPROVING an entry does change the hash, forcing a fresh turn.
 * Both are intended; neither is a bug.
 *
 * `null` means what it has always meant: no file, or an empty file. It does NOT
 * mean "nothing approved" — that is the difference from the retired persona
 * pack, where zero approvals collapsed into absence. Here the craft half of the
 * file is real and unconditional, so a pack with zero approved stances is still
 * a pack; it just cites nothing.
 */
export async function getApprovedHumanPack(dataDir?: string): Promise<ApprovedHumanPack | null> {
  const raw = await getHumanPack(dataDir);
  if (!raw) return null;
  const filtered = filterApprovedNarratorMarkdown(raw.markdown);
  return {
    path: raw.path,
    hash: hashHumanPack(filtered.markdown),
    markdown: filtered.markdown,
    citableText: filtered.citableText,
    approvedStanceCount: filtered.approvedCount,
  };
}
