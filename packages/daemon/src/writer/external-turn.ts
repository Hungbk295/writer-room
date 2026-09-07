/**
 * Writer v2 — the surface an EXTERNAL caller uses to run a turn the daemon
 * dispatched with `substrate: 'external'` (plan writer-external-orchestrator §2 B3).
 *
 * The daemon stays the only settle machine: this file never reads or validates
 * `out/result.json`. It only (a) tells the caller which turn is open and where
 * its files are, (b) records the caller's progress notes on the run, and
 * (c) hands the caller's exit code to `workflow.turnComplete`, after which the
 * existing commit rule, validators, sandbox check and phase advance run exactly
 * as they do for a terminal turn. HTTP routes in `http.ts` and the Writer MCP
 * (plan §3) are thin wrappers over these three functions.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LaneScheduler, OpenTurn } from '../pipeline/lane-scheduler.ts';
import type { TeamWorkflow } from '../team/workflow.ts';
import { getWriterRunV2, saveWriterRunV2 } from './run-store-v2.ts';
import { appendWriterTimeline, type ExternalRef, type WriterRunV2 } from './writer-run-v2.ts';

export interface ExternalTurnDeps {
  scheduler: LaneScheduler;
  workflow: TeamWorkflow;
  dataDir: string;
}

export type ExternalTurnErrorCode = 'RUN_NOT_FOUND' | 'TURN_NOT_OPEN' | 'SUBSTRATE_NOT_EXTERNAL';

export class ExternalTurnError extends Error {
  constructor(readonly code: ExternalTurnErrorCode, message: string) {
    super(message);
    this.name = 'ExternalTurnError';
  }
}

/**
 * Where 1DevTool keeps one `meta.json` per run (`status`, `exitCode`,
 * `submittedAt`, `durationSeconds`, `sessionId`). Overridable for tests.
 */
export function onedevtoolRunsDir(): string {
  return process.env['ONEDEVTOOL_RUNS_DIR'] || join(homedir(), '.1devtool', 'orchestration', 'runs');
}

/** `<dataDir>/writer/external-meta/<writerRunId>/<stage>-turn<turnId>.json` — outside the stage
 * workspace on purpose: the sandbox tree-diff must not see a daemon-written file there. */
export function externalMetaCopyPath(dataDir: string, writerRunId: string, stage: string, turnId: number): string {
  return join(dataDir, 'writer', 'external-meta', writerRunId, `${stage}-turn${turnId}.json`);
}

/**
 * Best-effort copy of the 1DevTool `meta.json` for a finished turn. That
 * directory is not ours and may be pruned; the copy keeps the real exit code,
 * `submittedAt` and the terminal `sessionId` next to the run. Never throws.
 */
export function copyOnedevtoolMeta(
  dataDir: string,
  writerRunId: string,
  stage: string,
  turnId: number,
  onedevtoolRunId: string,
): string | null {
  try {
    const src = join(onedevtoolRunsDir(), onedevtoolRunId, 'meta.json');
    if (!existsSync(src)) return null;
    const dest = externalMetaCopyPath(dataDir, writerRunId, stage, turnId);
    mkdirSync(join(dest, '..'), { recursive: true });
    copyFileSync(src, dest);
    return dest;
  } catch (err) {
    console.warn('[writer-v2] không sao chép được meta.json của 1DevTool:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** `OpenTurn` plus the two paths the stage contract is built on. */
export interface OpenWriterTurn extends OpenTurn {
  /** `<itemRunDir>/prompt.md` — the agent reads this. */
  promptPath: string;
  /** `<itemRunDir>/out/result.json` — the only file the agent writes. */
  resultPath: string;
}

async function requireRun(dataDir: string, runId: string): Promise<WriterRunV2> {
  const run = await getWriterRunV2(runId, dataDir);
  if (!run) throw new ExternalTurnError('RUN_NOT_FOUND', `Writer v2 run không tồn tại: ${runId}`);
  return run;
}

function requireOpenTurn(scheduler: LaneScheduler, runId: string, turnId: number): OpenTurn {
  const open = scheduler.listOpenTurns(runId).find((turn) => turn.turnId === turnId);
  if (!open) throw new ExternalTurnError('TURN_NOT_OPEN', `turn ${turnId} không mở cho run ${runId}`);
  return open;
}

/** All open turns of `runId`. Research fan-out may expose up to five at once. */
export async function getOpenWriterTurns(
  deps: ExternalTurnDeps,
  runId: string,
): Promise<OpenWriterTurn[]> {
  await requireRun(deps.dataDir, runId);
  return deps.scheduler.listOpenTurns(runId).map((open) => ({
    ...open,
    promptPath: join(open.itemRunDir, 'prompt.md'),
    resultPath: join(open.itemRunDir, 'out', 'result.json'),
  }));
}

/** Legacy singular view: the first open turn, or `null`. */
export async function getOpenWriterTurn(
  deps: ExternalTurnDeps,
  runId: string,
): Promise<OpenWriterTurn | null> {
  return (await getOpenWriterTurns(deps, runId))[0] ?? null;
}

/** Append a progress note to `run.timeline`. `turnId`, when given, must be open. */
export async function noteWriterTurnProgress(
  deps: ExternalTurnDeps,
  runId: string,
  input: { turnId?: number; text: string; external?: ExternalRef },
): Promise<WriterRunV2> {
  const run = await requireRun(deps.dataDir, runId);
  const open = input.turnId !== undefined ? requireOpenTurn(deps.scheduler, runId, input.turnId) : undefined;
  appendWriterTimeline(run, {
    at: new Date().toISOString(),
    ...(open ? { turnId: open.turnId, stage: open.stage } : {}),
    kind: input.external ? 'external' : 'note',
    text: input.text,
    ...(input.external ? { external: input.external } : {}),
  });
  run.updatedAt = new Date().toISOString();
  await saveWriterRunV2(run, deps.dataDir);
  return run;
}

/**
 * Report that the external agent finished `turnId`. Validation of
 * `out/result.json`, the sandbox tree-diff and the gate all happen on the
 * existing settle path behind `workflow.turnComplete` — nothing here decides
 * whether the stage passed.
 */
export async function completeWriterTurn(
  deps: ExternalTurnDeps,
  runId: string,
  input: { turnId: number; exitCode: number; external?: ExternalRef },
): Promise<{ ok: true; turnId: number }> {
  const run = await requireRun(deps.dataDir, runId);
  if (run.substrate !== 'external') {
    throw new ExternalTurnError(
      'SUBSTRATE_NOT_EXTERNAL',
      `run ${runId} chạy substrate ${run.substrate ?? 'terminal'} — turn do bridge trong app settle, không nhận báo cáo ngoài`,
    );
  }
  const open = requireOpenTurn(deps.scheduler, runId, input.turnId);
  if (input.external) {
    appendWriterTimeline(run, {
      at: new Date().toISOString(),
      turnId: open.turnId,
      stage: open.stage,
      kind: 'external',
      text: `${open.stage} xong với exit ${input.exitCode}`,
      external: input.external,
    });
    run.updatedAt = new Date().toISOString();
    await saveWriterRunV2(run, deps.dataDir);
  }
  if (input.external?.runId) {
    copyOnedevtoolMeta(deps.dataDir, runId, open.stage, open.turnId, input.external.runId);
  }
  deps.workflow.turnComplete(open.turnId, { exitCode: input.exitCode });
  return { ok: true, turnId: open.turnId };
}
