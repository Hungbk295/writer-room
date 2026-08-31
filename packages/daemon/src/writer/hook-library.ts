/**
 * Competitor hook-library store (Writer v2 pre-write).
 *
 * A hook library is ONE markdown file of opening frames mined from other
 * channels. The agent reads it when suggesting a few hooks; it is never a
 * source of facts and must not be merged into a general pack (one channel)
 * or a channel style (this channel's voice).
 *
 * Same two properties as the general-pack / channel-style stores:
 *  - One file. A run pins its hash.
 *  - Path confined to the hook-libraries root.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join, normalize } from 'node:path';
import { ensureDir, hookLibrariesRoot } from '../paths.ts';

export const DEFAULT_HOOK_LIBRARY = 'anh-ba-ong-chu.md';

export interface HookLibrarySummary {
  path: string;
  version: number | null;
  title: string;
  wordCount: number;
  hash: string;
}

export interface HookLibrary extends HookLibrarySummary {
  markdown: string;
}

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

export function hashHookLibrary(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex');
}

export async function listHookLibraries(dataDir?: string): Promise<HookLibrarySummary[]> {
  const root = hookLibrariesRoot(dataDir);
  await ensureDir(root);
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const out: HookLibrarySummary[] = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    try {
      const markdown = await readFile(join(root, name), 'utf8');
      out.push({
        path: name,
        version: parseVersion(markdown),
        title: parseTitle(markdown, basename(name, '.md')),
        wordCount: markdown.split(/\s+/).filter(Boolean).length,
        hash: hashHookLibrary(markdown),
      });
    } catch {
      // skip unreadable
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

export async function getHookLibrary(
  relPath: string,
  dataDir?: string,
): Promise<HookLibrary | null> {
  const cleaned = resolveRelativePath(relPath);
  if (!cleaned) return null;
  try {
    const markdown = await readFile(join(hookLibrariesRoot(dataDir), cleaned), 'utf8');
    return {
      path: cleaned,
      version: parseVersion(markdown),
      title: parseTitle(markdown, basename(cleaned, '.md')),
      wordCount: markdown.split(/\s+/).filter(Boolean).length,
      hash: hashHookLibrary(markdown),
      markdown,
    };
  } catch {
    return null;
  }
}
