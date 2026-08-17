/**
 * Writer v2 run persistence — JSON-per-record under `writerRoot()/runs-v2`.
 *
 * Deliberately a SEPARATE directory from v1's `runs/`: the two flows run side by
 * side during the migration (plan §Phase 3, "chạy song song flow cũ, không xoá
 * code cũ"), and a v2 record has no Profile, no rubric, and no quality reviews —
 * mixing them in one folder would force every reader to discriminate on shape.
 */
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDir, writerRoot } from '../paths.ts';
import type { WriterRunV2 } from './writer-run-v2.ts';

export interface WriterRunV2Summary {
  id: string;
  status: WriterRunV2['status'];
  phase: WriterRunV2['phase'];
  brief: string;
  requestedTitle?: string;
  targetWords?: number;
  packId: string;
  packTitle: string;
  generalPackPath: string;
  formulaId: string;
  formulaVersion: number;
  agentId: string;
  editorAgentId: string;
  createdAt: string;
  updatedAt: string;
  hasScript: boolean;
  gateViolationCount: number;
  defectCount: number;
}

function runsDir(dataDir?: string): string {
  return join(writerRoot(dataDir), 'runs-v2');
}

function runPath(id: string, dataDir?: string): string {
  return join(runsDir(dataDir), `${id}.json`);
}

export async function saveWriterRunV2(run: WriterRunV2, dataDir?: string): Promise<void> {
  await ensureDir(runsDir(dataDir));
  await writeFile(runPath(run.id, dataDir), `${JSON.stringify(run, null, 2)}\n`, 'utf8');
}

export async function getWriterRunV2(id: string, dataDir?: string): Promise<WriterRunV2 | null> {
  try {
    const raw = await readFile(runPath(id, dataDir), 'utf8');
    const run = JSON.parse(raw) as WriterRunV2;
    return {
      ...run,
      gateResults: Array.isArray(run.gateResults) ? run.gateResults : [],
      study: run.study ?? null,
      draft: run.draft ?? null,
      editorDefects: run.editorDefects ?? null,
      finalScript: run.finalScript ?? null,
    };
  } catch {
    return null;
  }
}

function summarize(run: WriterRunV2): WriterRunV2Summary {
  const latestGate = run.gateResults.at(-1);
  return {
    id: run.id,
    status: run.status,
    phase: run.phase,
    brief: run.brief,
    ...(run.requestedTitle ? { requestedTitle: run.requestedTitle } : {}),
    ...(run.targetWords !== undefined ? { targetWords: run.targetWords } : {}),
    packId: run.packId,
    packTitle: run.packTitle,
    generalPackPath: run.generalPackPath,
    formulaId: run.formulaId,
    formulaVersion: run.formulaVersion,
    agentId: run.agentId,
    editorAgentId: run.editorAgentId,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    hasScript: Boolean(run.finalScript ?? run.draft?.script),
    gateViolationCount: latestGate?.violations.length ?? 0,
    defectCount: run.editorDefects?.length ?? 0,
  };
}

export async function listWriterRunsV2(dataDir?: string): Promise<WriterRunV2Summary[]> {
  const root = runsDir(dataDir);
  await ensureDir(root);
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const out: WriterRunV2Summary[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(root, name), 'utf8');
      const run = JSON.parse(raw) as WriterRunV2;
      out.push(summarize({ ...run, gateResults: run.gateResults ?? [] }));
    } catch {
      // skip corrupt
    }
  }
  out.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
  return out;
}

export async function deleteWriterRunV2(id: string, dataDir?: string): Promise<boolean> {
  try {
    await unlink(runPath(id, dataDir));
    return true;
  } catch {
    return false;
  }
}
