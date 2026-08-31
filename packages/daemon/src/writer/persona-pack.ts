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

const PERSONA_PACK_FILENAME = 'persona-pack.md';

export interface PersonaPack {
  /** Always `persona-pack.md` — kept as a field so call sites don't hardcode it. */
  path: string;
  hash: string;
  markdown: string;
}

export function hashPersonaPack(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex');
}

/** Returns `null` when the file does not exist — the caller's only branch point. */
export async function getPersonaPack(dataDir?: string): Promise<PersonaPack | null> {
  try {
    const markdown = await readFile(join(writerRoot(dataDir), PERSONA_PACK_FILENAME), 'utf8');
    return { path: PERSONA_PACK_FILENAME, hash: hashPersonaPack(markdown), markdown };
  } catch {
    return null;
  }
}
