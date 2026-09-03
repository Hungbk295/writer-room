/**
 * Persona pack (Write Loop v2, optional). ONE fixed file — unlike the general
 * pack store, there is no per-channel directory: `writer/persona-pack.md`,
 * present or absent.
 *
 * A general pack describes HOW a reference channel makes moves (craft). A
 * persona pack is a second, orthogonal ledger: the narrator's fixed IDENTITY —
 * a stance registry (consistent opinions across every piece) and a bank of
 * adapted experience archetypes the writer may draw personal material from.
 * Never a source of topic facts; those still come only from `factsLedger`.
 *
 * OPTIONAL and backward-compatible on purpose: when the file is absent this
 * module returns `null` and the WRITE stage runs exactly as it did before
 * persona packs existed — no prompt section, no staged file, no pinned hash.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writerRoot } from '../paths.ts';
import { filterApprovedPersonaMarkdown } from './assertion-boundary.ts';

const PERSONA_PACK_FILENAME = 'persona-pack.md';

export interface PersonaPack {
  /** Always `persona-pack.md` — kept as a field so call sites don't hardcode it. */
  path: string;
  hash: string;
  /** What the model may READ: staged to `input/persona-pack.md` and hashed into
   * the turn key. Includes each approved entry verbatim. */
  markdown: string;
  /** What the model may CITE: see `FilteredPersonaPack.citableText`. Only set by
   * `getApprovedPersonaPack`; the raw `getPersonaPack` has no approval state and
   * therefore licenses nothing. */
  citableText?: string;
}

export function hashPersonaPack(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex');
}

/**
 * Returns `null` for the two states that both mean "this run has no persona
 * pack": the file does not exist (ENOENT), or it exists but is empty/
 * whitespace-only. Any OTHER read failure (permissions, I/O error, a
 * directory where a file was expected, …) is a real problem, not an absence,
 * so it is re-thrown rather than swallowed — the caller (`dispatchWrite`)
 * turns it into a visible `PERSONA_PACK_UNREADABLE` run failure instead of
 * silently writing without the narrator's identity. Decision: eng review
 * 2026-09-02.
 */
export async function getPersonaPack(dataDir?: string): Promise<PersonaPack | null> {
  const path = join(writerRoot(dataDir), PERSONA_PACK_FILENAME);
  let markdown: string;
  try {
    markdown = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(
      `[persona-pack] failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  if (!markdown.trim()) return null;
  return { path: PERSONA_PACK_FILENAME, hash: hashPersonaPack(markdown), markdown };
}

/**
 * `getPersonaPack` + T1's fail-closed filter, composed: load the raw file,
 * then strip it down to only APPROVED entries (plus the shared preamble and
 * the personal-vocabulary tail) via `filterApprovedPersonaMarkdown`. The
 * filtered markdown is the only thing that may ever reach the model or pin a
 * turn key, so it is also the only thing this function's hash is ever taken
 * of — callers must never hash/stage the raw file from `getPersonaPack`.
 *
 * `null` covers three states identically on purpose: no file, an empty file,
 * and a file with zero APPROVED entries — all three mean "this run has no
 * persona pack". A read error other than ENOENT still propagates unchanged
 * (see `getPersonaPack`).
 */
export async function getApprovedPersonaPack(dataDir?: string): Promise<PersonaPack | null> {
  const raw = await getPersonaPack(dataDir);
  if (!raw) return null;
  const filtered = filterApprovedPersonaMarkdown(raw.markdown);
  if (!filtered) {
    // Deliberately loud: "persona file on disk, run behaves as if there were
    // none" looks exactly like a bug from the outside. It is the fail-closed
    // rule working — say so.
    console.warn(
      `[writer-v2] persona pack "${raw.path}" tồn tại nhưng 0 entry APPROVED — run chạy như KHÔNG có persona (fail-closed). Duyệt entry bằng marker [ĐÃ DUYỆT].`,
    );
    return null;
  }
  // Hashing the FILTERED markdown has a deliberate, useful consequence for the
  // turn key: editing a PENDING/REJECTED entry changes nothing the model sees,
  // so it does NOT change this hash — the owner can draft unapproved entries
  // without breaking cache. APPROVING an entry does change the hash, forcing a
  // fresh turn. Both are intended; neither is a bug.
  return {
    path: raw.path,
    hash: hashPersonaPack(filtered.markdown),
    markdown: filtered.markdown,
    citableText: filtered.citableText,
  };
}
