/**
 * General pack store (Write Loop v2 Phase 2/3).
 *
 * A general pack is ONE channel's craft file: taste DNA + one entry per video
 * saying how that video opened, what each beat added, what kind of example it
 * used (with a provenance tag), how it paid off, and what it deliberately did
 * not do. It replaces Taste RAG in the writer: retrieval by editorial-decision
 * embedding returned neighbours that were topically close and craft-irrelevant,
 * and it could not express "this example is a fictional character — do NOT copy
 * this move". A curated file can, and a human can audit it in one sitting.
 *
 * Two hard properties:
 *  - One file per channel. Merging channels averages two tastes into neither.
 *  - Pinned by content hash on every run (`generalPackHash`), so editing the file
 *    mid-flight can never silently change what an old run claims it used.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join, normalize } from 'node:path';
import { ensureDir, generalPacksRoot } from '../paths.ts';

export interface GeneralPackSummary {
  /** Path relative to the general-packs root, e.g. `hieu-tv.md`. */
  path: string;
  /** `<!-- version: N -->` from the file header, when present. */
  version: number | null;
  title: string;
  wordCount: number;
  hash: string;
}

export interface GeneralPack extends GeneralPackSummary {
  markdown: string;
}

/** Refuse anything that could escape the general-packs directory. */
function resolveRelativePath(relPath: string): string | null {
  const cleaned = normalize(relPath).replace(/^[/\\]+/, '');
  if (!cleaned || cleaned.includes('..')) return null;
  if (!cleaned.endsWith('.md')) return null;
  return cleaned;
}

function parseVersion(markdown: string): number | null {
  const m = markdown.match(/<!--\s*version:\s*(\d+)/i);
  return m ? Number(m[1]) : null;
}

function parseTitle(markdown: string, fallback: string): string {
  const m = markdown.match(/^#\s+(.+)$/m);
  return m?.[1]?.trim() || fallback;
}

export function hashGeneralPack(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex');
}

export async function listGeneralPacks(dataDir?: string): Promise<GeneralPackSummary[]> {
  const root = generalPacksRoot(dataDir);
  await ensureDir(root);
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const out: GeneralPackSummary[] = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    try {
      const markdown = await readFile(join(root, name), 'utf8');
      out.push({
        path: name,
        version: parseVersion(markdown),
        title: parseTitle(markdown, basename(name, '.md')),
        wordCount: markdown.split(/\s+/).filter(Boolean).length,
        hash: hashGeneralPack(markdown),
      });
    } catch {
      // skip unreadable
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

export async function getGeneralPack(relPath: string, dataDir?: string): Promise<GeneralPack | null> {
  const cleaned = resolveRelativePath(relPath);
  if (!cleaned) return null;
  try {
    const markdown = await readFile(join(generalPacksRoot(dataDir), cleaned), 'utf8');
    return {
      path: cleaned,
      version: parseVersion(markdown),
      title: parseTitle(markdown, basename(cleaned, '.md')),
      wordCount: markdown.split(/\s+/).filter(Boolean).length,
      hash: hashGeneralPack(markdown),
      markdown,
    };
  } catch {
    return null;
  }
}
