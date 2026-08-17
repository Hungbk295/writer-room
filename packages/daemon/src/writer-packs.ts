/** Lightweight Writer staging — Source Packs saved under data/exports/writer. */

import { readdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writerExportsRoot, ensureDir } from './paths.ts';

export interface WriterPack {
  id: string;
  title: string;
  markdown: string;
  videoIds: string[];
  spyRunId: string;
  channelTitle: string;
  wordCount: number;
  warnings: string[];
  createdAt: string;
}

export interface WriterPackSummary {
  id: string;
  title: string;
  channelTitle: string;
  wordCount: number;
  videoCount: number;
  spyRunId: string;
  createdAt: string;
  warnings: string[];
}

function packPath(id: string, dataDir?: string): string {
  return join(writerExportsRoot(dataDir), `${id}.json`);
}

function packMdPath(id: string, dataDir?: string): string {
  return join(writerExportsRoot(dataDir), `${id}.md`);
}

function countWords(markdown: string): number {
  return markdown.split(/\s+/).filter(Boolean).length;
}

async function persistWriterPack(pack: WriterPack, dataDir?: string): Promise<void> {
  await ensureDir(writerExportsRoot(dataDir));
  await writeFile(packPath(pack.id, dataDir), `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
  await writeFile(packMdPath(pack.id, dataDir), pack.markdown, 'utf8');
}

export async function listWriterPacks(dataDir?: string): Promise<WriterPackSummary[]> {
  const root = writerExportsRoot(dataDir);
  await ensureDir(root);
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const packs: WriterPackSummary[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(root, name), 'utf8');
      const pack = JSON.parse(raw) as WriterPack;
      packs.push({
        id: pack.id,
        title: pack.title,
        channelTitle: pack.channelTitle,
        wordCount: pack.wordCount,
        videoCount: pack.videoIds?.length ?? 0,
        spyRunId: pack.spyRunId,
        createdAt: pack.createdAt,
        warnings: pack.warnings ?? [],
      });
    } catch {
      // skip corrupt
    }
  }
  packs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return packs;
}

export async function getWriterPack(id: string, dataDir?: string): Promise<WriterPack | null> {
  try {
    const raw = await readFile(packPath(id, dataDir), 'utf8');
    return JSON.parse(raw) as WriterPack;
  } catch {
    return null;
  }
}

export async function createWriterPack(input: {
  title?: string;
  markdown: string;
  videoIds?: string[];
  spyRunId?: string;
  channelTitle?: string;
  wordCount?: number;
  warnings?: string[];
}, dataDir?: string): Promise<WriterPack> {
  const id = randomUUID();
  const pack: WriterPack = {
    id,
    title: input.title?.trim() || input.channelTitle?.trim() || 'Source Pack',
    markdown: input.markdown,
    videoIds: input.videoIds ?? [],
    spyRunId: input.spyRunId ?? '',
    channelTitle: input.channelTitle ?? '',
    wordCount: input.wordCount ?? countWords(input.markdown),
    warnings: input.warnings ?? [],
    createdAt: new Date().toISOString(),
  };
  await persistWriterPack(pack, dataDir);
  return pack;
}

/**
 * Rename display title only — does not touch markdown / channelTitle / provenance.
 */
export async function renameWriterPack(
  id: string,
  title: string,
  dataDir?: string,
): Promise<WriterPack | null> {
  const next = title.trim();
  if (!next) throw new Error('Tên pack không được rỗng');
  const pack = await getWriterPack(id, dataDir);
  if (!pack) return null;
  pack.title = next;
  await persistWriterPack(pack, dataDir);
  return pack;
}

/**
 * Split markdown into per-video `## …` sections (header before first H2 is dropped).
 * Used by merge so we append only video bodies, not a second UNTRUSTED header.
 */
export function videoSectionsFromMarkdown(
  markdown: string,
): Array<{ videoId: string | null; body: string }> {
  const matches = [...markdown.matchAll(/^## .+$/gm)];
  if (matches.length === 0) return [];
  const sections: Array<{ videoId: string | null; body: string }> = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i]!.index!;
    const end = i + 1 < matches.length ? matches[i + 1]!.index! : markdown.length;
    const body = markdown.slice(start, end).trim();
    if (!body) continue;
    const idMatch = body.match(/- videoId:\s*`([^`]+)`/i);
    sections.push({ videoId: idMatch?.[1] ?? null, body });
  }
  return sections;
}

export interface MergeIntoWriterPackInput {
  markdown: string;
  videoIds?: string[];
  spyRunId?: string;
  channelTitle?: string;
  warnings?: string[];
}

/**
 * Append videos from a fresh Spy export into an existing pack.
 * Dedupes by `videoId`; skips sections already present.
 * Multi-channel: channelTitle becomes "A · B" when sources differ.
 */
export async function mergeIntoWriterPack(
  targetId: string,
  input: MergeIntoWriterPackInput,
  dataDir?: string,
): Promise<WriterPack | null> {
  const pack = await getWriterPack(targetId, dataDir);
  if (!pack) return null;
  if (!input.markdown?.trim()) throw new Error('markdown bắt buộc khi merge');

  const existingIds = new Set(pack.videoIds ?? []);
  const incoming = videoSectionsFromMarkdown(input.markdown);
  const toAppend: string[] = [];
  const addedIds: string[] = [];

  for (const sec of incoming) {
    if (sec.videoId && existingIds.has(sec.videoId)) continue;
    if (sec.videoId) {
      existingIds.add(sec.videoId);
      addedIds.push(sec.videoId);
    } else {
      // No videoId in section — still append (manual packs / older format).
      toAppend.push(sec.body);
      continue;
    }
    toAppend.push(sec.body);
  }

  // Cover videoIds listed but missing as H2 sections (unlikely).
  for (const id of input.videoIds ?? []) {
    if (!existingIds.has(id)) {
      existingIds.add(id);
      if (!addedIds.includes(id)) addedIds.push(id);
    }
  }

  if (toAppend.length === 0) {
    const note = 'merge: không có video mới (đã có trong pack)';
    pack.warnings = [...(pack.warnings ?? []), note];
    await persistWriterPack(pack, dataDir);
    return pack;
  }

  const stamp = new Date().toISOString();
  const fromLabel = [
    input.channelTitle?.trim(),
    input.spyRunId ? `spy ${input.spyRunId.slice(0, 8)}` : null,
  ].filter(Boolean).join(' · ') || 'unknown source';

  pack.markdown = [
    pack.markdown.trimEnd(),
    '',
    '---',
    '',
    `<!-- merged ${stamp} · ${fromLabel} · +${addedIds.length || toAppend.length} section(s) -->`,
    '',
    ...toAppend,
    '',
  ].join('\n');

  pack.videoIds = [...existingIds];
  pack.wordCount = countWords(pack.markdown);

  const incomingChannel = input.channelTitle?.trim();
  if (incomingChannel) {
    if (!pack.channelTitle?.trim()) {
      pack.channelTitle = incomingChannel;
    } else if (
      pack.channelTitle !== incomingChannel
      && !pack.channelTitle.split(/\s*·\s*/).includes(incomingChannel)
    ) {
      pack.channelTitle = `${pack.channelTitle} · ${incomingChannel}`;
    }
  }

  const mergeNote =
    `merged +${addedIds.length || toAppend.length} video/section(s) from ${fromLabel}`;
  pack.warnings = [
    ...(pack.warnings ?? []),
    ...(input.warnings ?? []),
    mergeNote,
  ];

  await persistWriterPack(pack, dataDir);
  return pack;
}

export async function deleteWriterPack(id: string, dataDir?: string): Promise<boolean> {
  let ok = false;
  try {
    await unlink(packPath(id, dataDir));
    ok = true;
  } catch {
    // missing json
  }
  try {
    await unlink(packMdPath(id, dataDir));
  } catch {
    // optional sidecar
  }
  return ok;
}
