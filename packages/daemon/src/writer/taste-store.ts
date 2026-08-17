/**
 * Taste decision case persistence — JSON-per-record under `writerRoot()/taste-cases`.
 * Capture-only in FM2 (no retrieval index yet). ADR-FM12.
 */
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TasteDecisionCase } from '@writer-room/training-core';
import { ensureDir, writerRoot } from '../paths.ts';

export interface TasteCaseSummary {
  id: string;
  decisionType: TasteDecisionCase['decisionType'];
  situation: string;
  writerRunId?: string;
  createdAt: string;
}

function tasteDir(dataDir?: string): string {
  return join(writerRoot(dataDir), 'taste-cases');
}

function tastePath(id: string, dataDir?: string): string {
  return join(tasteDir(dataDir), `${id}.json`);
}

export async function saveTasteCase(c: TasteDecisionCase, dataDir?: string): Promise<void> {
  await ensureDir(tasteDir(dataDir));
  await writeFile(tastePath(c.id, dataDir), `${JSON.stringify(c, null, 2)}\n`, 'utf8');
}

export async function getTasteCase(id: string, dataDir?: string): Promise<TasteDecisionCase | null> {
  try {
    const raw = await readFile(tastePath(id, dataDir), 'utf8');
    return JSON.parse(raw) as TasteDecisionCase;
  } catch {
    return null;
  }
}

export async function listTasteCases(dataDir?: string): Promise<TasteCaseSummary[]> {
  const root = tasteDir(dataDir);
  await ensureDir(root);
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const out: TasteCaseSummary[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(root, name), 'utf8');
      const c = JSON.parse(raw) as TasteDecisionCase;
      out.push({
        id: c.id,
        decisionType: c.decisionType,
        situation: c.situation,
        writerRunId: c.writerRunId,
        createdAt: c.createdAt,
      });
    } catch {
      // skip corrupt
    }
  }
  out.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
  return out;
}

export async function deleteTasteCase(id: string, dataDir?: string): Promise<boolean> {
  try {
    await unlink(tastePath(id, dataDir));
    return true;
  } catch {
    return false;
  }
}
