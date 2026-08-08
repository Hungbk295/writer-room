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

function packPath(id: string): string {
  return join(writerExportsRoot(), `${id}.json`);
}

export async function listWriterPacks(): Promise<WriterPackSummary[]> {
  const root = writerExportsRoot();
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

export async function getWriterPack(id: string): Promise<WriterPack | null> {
  try {
    const raw = await readFile(packPath(id), 'utf8');
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
}): Promise<WriterPack> {
  await ensureDir(writerExportsRoot());
  const id = randomUUID();
  const pack: WriterPack = {
    id,
    title: input.title?.trim() || input.channelTitle?.trim() || 'Source Pack',
    markdown: input.markdown,
    videoIds: input.videoIds ?? [],
    spyRunId: input.spyRunId ?? '',
    channelTitle: input.channelTitle ?? '',
    wordCount: input.wordCount
      ?? input.markdown.split(/\s+/).filter(Boolean).length,
    warnings: input.warnings ?? [],
    createdAt: new Date().toISOString(),
  };
  await writeFile(packPath(id), `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
  // sidecar .md for manual open
  await writeFile(
    join(writerExportsRoot(), `${id}.md`),
    pack.markdown,
    'utf8',
  );
  return pack;
}

export async function deleteWriterPack(id: string): Promise<boolean> {
  let ok = false;
  try {
    await unlink(packPath(id));
    ok = true;
  } catch {
    // missing json
  }
  try {
    await unlink(join(writerExportsRoot(), `${id}.md`));
  } catch {
    // optional sidecar
  }
  return ok;
}
