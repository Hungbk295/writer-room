/**
 * Channel style store (Writer v2 restyle).
 *
 * A channel style is ONE markdown file saying how the USER'S OWN channel sounds:
 * person and address, the recurring cast, beat labels, rhetorical budgets, the
 * ending contract, and what it refuses to do. It is the input to "restyle": take
 * the `finalScript` of a DONE run and rewrite it in that voice, into a new file —
 * the sourced original is never touched.
 *
 * Same shape as the general pack store on purpose, but the two are not the same
 * thing and must not be merged:
 *  - A general pack DESCRIBES a reference channel (Hieu TV) — read-only craft
 *    notes derived from that channel's transcripts, evidence about someone else.
 *  - A channel style PRESCRIBES the user's own channel — instructions, and on
 *    voice it OVERRIDES the general pack. When the reference channel opens one
 *    way and the style says open another way, the style wins.
 *
 * Two hard properties, inherited from the general pack store:
 *  - One file per style. A run pins exactly one; A/B means two runs, not a merge.
 *  - Pinned by content hash (`hashChannelStyle`), so editing a style mid-flight
 *    can never silently change what an old restyle claims it applied.
 *
 * Never a source of facts — facts come only from the topic pack / facts ledger.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join, normalize } from 'node:path';
import { channelStylesRoot, ensureDir } from '../paths.ts';

export interface ChannelStyleSummary {
  /** Path relative to the channel-styles root, e.g. `nhan-vat-xuyen-suot.md`. */
  path: string;
  /** `<!-- version: N -->` from the file header, when present. */
  version: number | null;
  title: string;
  wordCount: number;
  hash: string;
}

export interface ChannelStyle extends ChannelStyleSummary {
  markdown: string;
}

/** Refuse anything that could escape the channel-styles directory. */
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

export function hashChannelStyle(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex');
}

export async function listChannelStyles(dataDir?: string): Promise<ChannelStyleSummary[]> {
  const root = channelStylesRoot(dataDir);
  await ensureDir(root);
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const out: ChannelStyleSummary[] = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    try {
      const markdown = await readFile(join(root, name), 'utf8');
      out.push({
        path: name,
        version: parseVersion(markdown),
        title: parseTitle(markdown, basename(name, '.md')),
        wordCount: markdown.split(/\s+/).filter(Boolean).length,
        hash: hashChannelStyle(markdown),
      });
    } catch {
      // skip unreadable
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

export async function getChannelStyle(relPath: string, dataDir?: string): Promise<ChannelStyle | null> {
  const cleaned = resolveRelativePath(relPath);
  if (!cleaned) return null;
  try {
    const markdown = await readFile(join(channelStylesRoot(dataDir), cleaned), 'utf8');
    return {
      path: cleaned,
      version: parseVersion(markdown),
      title: parseTitle(markdown, basename(cleaned, '.md')),
      wordCount: markdown.split(/\s+/).filter(Boolean).length,
      hash: hashChannelStyle(markdown),
      markdown,
    };
  } catch {
    return null;
  }
}
