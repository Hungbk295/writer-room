/**
 * Writer run persistence — JSON-per-record under `writerRoot()/runs`.
 * Separate from Formula / Training Lab stores (ADR-FM10).
 */
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDir, writerRoot } from '../paths.ts';
import type { WriterRun } from './writer-run.ts';

export interface WriterRunSummary {
  id: string;
  status: WriterRun['status'];
  phase?: WriterRun['phase'];
  brief: string;
  requestedTitle?: string;
  targetWords?: number;
  packTitle: string;
  profileLabel: string;
  profileId: string;
  agentId: string;
  createdAt: string;
  updatedAt: string;
  hasDraft: boolean;
  editCount: number;
  decisionCount?: number;
}

function runsDir(dataDir?: string): string {
  return join(writerRoot(dataDir), 'runs');
}

function runPath(id: string, dataDir?: string): string {
  return join(runsDir(dataDir), `${id}.json`);
}

export async function saveWriterRun(run: WriterRun, dataDir?: string): Promise<void> {
  await ensureDir(runsDir(dataDir));
  await writeFile(runPath(run.id, dataDir), `${JSON.stringify(run, null, 2)}\n`, 'utf8');
}

export async function getWriterRun(id: string, dataDir?: string): Promise<WriterRun | null> {
  try {
    const raw = await readFile(runPath(id, dataDir), 'utf8');
    const run = JSON.parse(raw) as WriterRun;
    // Read-time defaults for runs written before Taste RAG / without edits array.
    return {
      ...run,
      phase: run.phase ?? (run.draft ? 'DONE' : run.status === 'FAILED' ? 'FAILED' : 'PLANNING'),
      editorialDecisions: Array.isArray(run.editorialDecisions) ? run.editorialDecisions : [],
      videoPlan: run.videoPlan ?? null,
      edits: Array.isArray(run.edits) ? run.edits : [],
      tastePrecedents: Array.isArray(run.tastePrecedents) ? run.tastePrecedents : [],
      tasteRagWarnings: Array.isArray(run.tasteRagWarnings) ? run.tasteRagWarnings : [],
      qualityChecklist: Array.isArray(run.qualityChecklist) ? run.qualityChecklist : [],
      qualityAntiPatterns: Array.isArray(run.qualityAntiPatterns) ? run.qualityAntiPatterns : [],
      qualityThreshold: Number.isFinite(run.qualityThreshold) ? run.qualityThreshold : 70,
      qualityReviews: Array.isArray(run.qualityReviews) ? run.qualityReviews : [],
      refineArtifactHash: run.refineArtifactHash ?? null,
    };
  } catch {
    return null;
  }
}

export async function listWriterRuns(dataDir?: string): Promise<WriterRunSummary[]> {
  const root = runsDir(dataDir);
  await ensureDir(root);
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const out: WriterRunSummary[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(root, name), 'utf8');
      const run = JSON.parse(raw) as WriterRun;
      out.push({
        id: run.id,
        status: run.status,
        phase: run.phase,
        brief: run.brief,
        ...(run.requestedTitle ? { requestedTitle: run.requestedTitle } : {}),
        ...(run.targetWords !== undefined ? { targetWords: run.targetWords } : {}),
        packTitle: run.packTitle,
        profileLabel: run.profileLabel,
        profileId: run.profileId,
        agentId: run.agentId,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        hasDraft: Boolean(run.draft?.script),
        editCount: Array.isArray(run.edits) ? run.edits.length : 0,
        decisionCount: Array.isArray(run.editorialDecisions) ? run.editorialDecisions.length : 0,
      });
    } catch {
      // skip corrupt
    }
  }
  out.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
  return out;
}

export async function deleteWriterRun(id: string, dataDir?: string): Promise<boolean> {
  try {
    await unlink(runPath(id, dataDir));
    return true;
  } catch {
    return false;
  }
}
