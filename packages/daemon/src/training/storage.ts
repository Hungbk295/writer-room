/**
 * Formula persistence — JSON-per-record under `trainingRoot()/formulas`, mirrors
 * `packages/daemon/src/writer-packs.ts`'s file-storage idiom exactly (directory
 * scan, sorted by createdAt desc) rather than inventing a different scheme.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FormulaArtifact } from '@writer-room/training-core';
import { ensureDir, trainingRoot } from '../paths.ts';
// `import type` only — no runtime dependency, so this does not create a real module
// cycle even though `training-lab.ts` imports `saveTrainingLabRun`/`getTrainingLabRun`
// from this file (SDD §12a: `TrainingLabRun` is defined in `training-lab.ts`, storage
// mirrors the existing `saveFormula`/`getFormula`/`listFormulas` pattern for it below).
import type { TrainingLabRun } from './training-lab.ts';

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

/**
 * Training Lab (SDD §12a) run persistence — same JSON-per-record-under-a-subdir
 * idiom as `formulas` above, at `trainingRoot()/lab-runs`. The orchestrator
 * (`training-lab.ts`) re-reads via `getTrainingLabRun` at the start of handling every
 * settle event, mutates in memory, and re-saves — there is no separate in-memory-only
 * run registry that could desync from disk (see `training-lab.ts`'s doc comment).
 */
export interface TrainingLabRunSummary {
  id: string;
  videoSnapshotId: string;
  channelTitle: string;
  status: TrainingLabRun['status'];
  roundCount: number;
  createdAt: string;
  updatedAt: string;
}

function labRunsDir(dataDir?: string): string {
  return join(trainingRoot(dataDir), 'lab-runs');
}

function labRunPath(id: string, dataDir?: string): string {
  return join(labRunsDir(dataDir), `${id}.json`);
}

export async function saveTrainingLabRun(run: TrainingLabRun, dataDir?: string): Promise<void> {
  await ensureDir(labRunsDir(dataDir));
  await writeFile(labRunPath(run.id, dataDir), `${JSON.stringify(run, null, 2)}\n`, 'utf8');
}

export async function getTrainingLabRun(id: string, dataDir?: string): Promise<TrainingLabRun | null> {
  try {
    const raw = await readFile(labRunPath(id, dataDir), 'utf8');
    return JSON.parse(raw) as TrainingLabRun;
  } catch {
    return null;
  }
}

export async function listTrainingLabRuns(dataDir?: string): Promise<TrainingLabRunSummary[]> {
  const root = labRunsDir(dataDir);
  await ensureDir(root);
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const summaries: TrainingLabRunSummary[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(root, name), 'utf8');
      const run = JSON.parse(raw) as TrainingLabRun;
      summaries.push({
        id: run.id,
        videoSnapshotId: run.videoSnapshotId,
        channelTitle: run.channelTitle,
        status: run.status,
        roundCount: run.rounds.length,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      });
    } catch {
      // skip corrupt
    }
  }
  summaries.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return summaries;
}
