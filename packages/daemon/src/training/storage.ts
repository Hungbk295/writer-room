/**
 * Formula persistence — JSON-per-record under `trainingRoot()/formulas`, mirrors
 * `packages/daemon/src/writer-packs.ts`'s file-storage idiom exactly (directory
 * scan, sorted by createdAt desc) rather than inventing a different scheme.
 */
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeFormula, sourceVideoCount, type FormulaArtifact } from '@writer-room/training-core';
import { ensureDir, trainingRoot } from '../paths.ts';
// `import type` only — no runtime dependency, so this does not create a real module
// cycle even though `training-lab.ts` imports `saveTrainingLabRun`/`getTrainingLabRun`
// from this file (SDD §12a: `TrainingLabRun` is defined in `training-lab.ts`, storage
// mirrors the existing `saveFormula`/`getFormula`/`listFormulas` pattern for it below).
import type { TrainingLabRun } from './training-lab.ts';

export interface FormulaSummary {
  id: string;
  status: FormulaArtifact['status'];
  origin: FormulaArtifact['origin'];
  version: number;
  /**
   * Display name: user `title` if set, else video title (ANALYZED/REFINED) or genre
   * (COMPOUND) — never prefers channel name over video title.
   */
  label: string;
  /** Distinct source videos behind it — 1 for ANALYZED/REFINED, N for COMPOUND. */
  videoCount: number;
  ruleCount: number;
  createdAt: string;
  sourceBatchId?: string;
  title?: string;
  videoTitle?: string;
  channelTitle?: string;
  videoSnapshotId?: string;
}

/** Prefer user rename → video title → genre/channel. Channel is last resort. */
export function formulaDisplayLabel(formula: FormulaArtifact): string {
  if (formula.title?.trim()) return formula.title.trim();
  if (formula.origin === 'COMPOUND') return formula.genre?.trim() || 'Compound';
  return formula.videoTitle?.trim() || formula.channelTitle?.trim() || 'Formula';
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
    return normalizeFormula(JSON.parse(raw) as FormulaArtifact);
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
      const formula = normalizeFormula(JSON.parse(raw) as FormulaArtifact);
      summaries.push({
        id: formula.id,
        status: formula.status,
        origin: formula.origin,
        version: formula.version,
        label: formulaDisplayLabel(formula),
        videoCount: formula.origin === 'COMPOUND' ? sourceVideoCount(formula.rules) : 1,
        ruleCount: formula.rules.length,
        createdAt: formula.createdAt,
        ...(formula.sourceBatchId ? { sourceBatchId: formula.sourceBatchId } : {}),
        ...(formula.title ? { title: formula.title } : {}),
        ...(formula.videoTitle ? { videoTitle: formula.videoTitle } : {}),
        ...(formula.channelTitle ? { channelTitle: formula.channelTitle } : {}),
        ...(formula.videoSnapshotId ? { videoSnapshotId: formula.videoSnapshotId } : {}),
      });
    } catch {
      // skip corrupt
    }
  }
  summaries.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
  return summaries;
}

/** Xoá file Formula. Không đụng lineage/version history của bản khác. */
export async function deleteFormula(id: string, dataDir?: string): Promise<boolean> {
  try {
    await unlink(formulaPath(id, dataDir));
    return true;
  } catch {
    return false;
  }
}

/**
 * Đổi tên hiển thị (`title`). Không đụng `videoTitle` / `channelTitle` / provenance.
 * Trả formula đã lưu, hoặc `null` nếu id không tồn tại.
 */
export async function renameFormula(
  id: string,
  title: string,
  dataDir?: string,
): Promise<FormulaArtifact | null> {
  const next = title.trim();
  if (!next) throw new Error('Tên formula không được rỗng');
  const formula = await getFormula(id, dataDir);
  if (!formula) return null;
  formula.title = next;
  await saveFormula(formula, dataDir);
  return formula;
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
  draftAgent: TrainingLabRun['draftAgent'];
  critiqueAgent: TrainingLabRun['critiqueAgent'];
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
    const run = JSON.parse(raw) as TrainingLabRun;
    // Backfill for runs saved before 2026-08-10 (agent choice was hardcoded to grok)
    // and before 2026-08-14 (forced-choice REFINE fields on each round).
    return {
      ...run,
      draftAgent: run.draftAgent ?? 'grok',
      critiqueAgent: run.critiqueAgent ?? 'grok',
      rounds: (run.rounds ?? []).map((round) => ({
        ...round,
        ruleChanges: round.ruleChanges ?? null,
        notARuleProblem: round.notARuleProblem ?? null,
      })),
    };
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
        // Older runs (before 2026-08-10) have no draftAgent/critiqueAgent on disk —
        // they were always dispatched as grok, so that is the correct label for them.
        draftAgent: run.draftAgent ?? 'grok',
        critiqueAgent: run.critiqueAgent ?? 'grok',
      });
    } catch {
      // skip corrupt
    }
  }
  summaries.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
  return summaries;
}

/** Xoá file Training Lab run. Settle event sau đó sẽ no-op nếu run đã mất. */
export async function deleteTrainingLabRun(id: string, dataDir?: string): Promise<boolean> {
  try {
    await unlink(labRunPath(id, dataDir));
    return true;
  } catch {
    return false;
  }
}
