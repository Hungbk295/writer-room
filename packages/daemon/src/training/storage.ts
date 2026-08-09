/**
 * Formula persistence — JSON-per-record under `trainingRoot()/formulas`, mirrors
 * `packages/daemon/src/writer-packs.ts`'s file-storage idiom exactly (directory
 * scan, sorted by createdAt desc) rather than inventing a different scheme.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FormulaArtifact } from '@writer-room/training-core';
import { ensureDir, trainingRoot } from '../paths.ts';

export interface FormulaSummary {
  id: string;
  status: FormulaArtifact['status'];
  scope: FormulaArtifact['scope'];
  channelTitles: string[];
  videoCount: number;
  createdAt: string;
  sourceBatchId?: string;
}

/**
 * `dataDir` is optional and threads through to `trainingRoot(root)` exactly like
 * every other `paths.ts` helper (`spyRoot(root = dataRoot())` etc) — passing it
 * explicitly is what lets tests (and `aggregator.ts`, which already has the
 * harness's real `dataDir`) point at an isolated temp dir instead of the process
 * default `dataRoot()`. Production HTTP routes call these with no argument, which
 * resolves to the same `dataRoot()` value `createHttpApp()` already used to build
 * the harness.
 */
function formulasDir(dataDir?: string): string {
  return join(trainingRoot(dataDir), 'formulas');
}

function formulaPath(id: string, dataDir?: string): string {
  return join(formulasDir(dataDir), `${id}.json`);
}

export async function saveFormula(formula: FormulaArtifact, dataDir?: string): Promise<void> {
  await ensureDir(formulasDir(dataDir));
  await writeFile(formulaPath(formula.id, dataDir), `${JSON.stringify(formula, null, 2)}\n`, 'utf8');
}

export async function getFormula(id: string, dataDir?: string): Promise<FormulaArtifact | null> {
  try {
    const raw = await readFile(formulaPath(id, dataDir), 'utf8');
    return JSON.parse(raw) as FormulaArtifact;
  } catch {
    return null;
  }
}

export async function listFormulas(dataDir?: string): Promise<FormulaSummary[]> {
  const root = formulasDir(dataDir);
  await ensureDir(root);
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const summaries: FormulaSummary[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(root, name), 'utf8');
      const formula = JSON.parse(raw) as FormulaArtifact;
      summaries.push({
        id: formula.id,
        status: formula.status,
        scope: formula.scope,
        channelTitles: formula.channelGroups.map((g) => g.channelTitle),
        videoCount: formula.includedArtifacts.length,
        createdAt: formula.createdAt,
        ...(formula.sourceBatchId ? { sourceBatchId: formula.sourceBatchId } : {}),
      });
    } catch {
      // skip corrupt
    }
  }
  summaries.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return summaries;
}
