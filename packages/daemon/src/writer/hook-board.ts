/**
 * Writer v2 pre-write hook loop: clarify title → suggest a few hooks → human
 * picks one. Status stays DRAFT. Separate settle listener from the main loop
 * (which early-returns on anything that is not RUNNING) and from restyle
 * (which only runs on DONE).
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ItemSettledResult, LaneScheduler } from '../pipeline/lane-scheduler.ts';
import {
  buildClarifyPrompt,
  buildSuggestPrompt,
  validateClarifyOutput,
  validateSuggestOutput,
  type HookCandidate,
  type SelectedHook,
} from './hook-doi-thu.ts';
import { DEFAULT_HOOK_LIBRARY, getHookLibrary } from './hook-library.ts';
import { getWriterRunV2, listWriterRunsV2, saveWriterRunV2 } from './run-store-v2.ts';
import type { WriterRunV2 } from './writer-run-v2.ts';

/** Same item id as the main Writer v2 loop (`WRITER_V2_ITEM_ID`). Duplicated so
 * this file can `import type` writer-run-v2 without a runtime cycle. */
const WRITER_V2_ITEM_ID = 'piece';

export const HOOK_CLARIFY_STAGE = 'hook-clarify-v1';
export const HOOK_SUGGEST_STAGE = 'hook-suggest-v1';

const HOOK_CLARIFY_PROMPT_VERSION = 'writer-v2-hook-clarify-v1';
const HOOK_SUGGEST_PROMPT_VERSION = 'writer-v2-hook-suggest-v1';
const HOOK_PTY_SESSION_GROUP = 'writer-v2-hook';

interface HookDeps {
  scheduler: LaneScheduler;
  dataDir: string;
}

function envelopeHash(envelope: unknown): string {
  return createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function titleOf(run: WriterRunV2): string {
  return (run.requestedTitle ?? '').trim();
}

function assertDraftIdle(run: WriterRunV2): void {
  if (run.status !== 'DRAFT') {
    throw new Error(`Chỉ làm hook trên post DRAFT (hiện: ${run.status}/${run.phase})`);
  }
  if (run.generatingHook) {
    throw new Error(
      `Đang ${run.generatingHook.step === 'clarify' ? 'hỏi làm rõ title' : 'gợi ý hook'}; chờ turn đó settle trước`,
    );
  }
}

export function clearHookState(run: WriterRunV2): void {
  delete run.hookClarify;
  delete run.hookCandidates;
  delete run.selectedHook;
  delete run.hookError;
  delete run.hookLibraryHash;
  delete run.generatingHook;
}

async function recordHookError(
  dataDir: string,
  run: WriterRunV2,
  code: string,
  reason: string,
): Promise<void> {
  run.hookError = { code, reason, at: new Date().toISOString() };
  delete run.generatingHook;
  run.updatedAt = new Date().toISOString();
  await saveWriterRunV2(run, dataDir);
}

function nextAttempt(run: WriterRunV2): number {
  const attempt = (run.hookTurnAttempt ?? 0) + 1;
  run.hookTurnAttempt = attempt;
  return attempt;
}

function hookOutResultPath(
  dataDir: string,
  runId: string,
  stage: string,
  attempt: number,
): string {
  return join(
    dataDir,
    'workspaces',
    'pipeline',
    runId,
    WRITER_V2_ITEM_ID,
    'attempts',
    String(attempt),
    stage,
    'out',
    'result.json',
  );
}

export async function startHookClarify(deps: HookDeps, runId: string): Promise<WriterRunV2> {
  const run = await getWriterRunV2(runId, deps.dataDir);
  if (!run) throw new Error('Writer v2 post không tồn tại');
  assertDraftIdle(run);
  const title = titleOf(run);
  if (!title) throw new Error('Cần Title đã Save trước khi làm rõ hook');

  const attempt = nextAttempt(run);
  run.generatingHook = { step: 'clarify', attempt, startedAt: new Date().toISOString() };
  run.hookError = undefined;
  delete run.hookClarify;
  delete run.hookCandidates;
  delete run.selectedHook;
  run.updatedAt = new Date().toISOString();
  await saveWriterRunV2(run, deps.dataDir);

  const audience = run.audience ?? '';
  const envelope = {
    contract: {
      role: 'Writer v2 — HOOK CLARIFY',
      instruction: 'ask 1–4 questions to make the title specific; do not write hooks yet',
    },
    title,
    brief: run.brief,
    audience,
  };

  const dispatch = await deps.scheduler.dispatchItem({
    batchId: run.id,
    itemId: WRITER_V2_ITEM_ID,
    stage: HOOK_CLARIFY_STAGE,
    attempt,
    templateId: run.agentId,
    promptMarkdown: buildClarifyPrompt({ title, brief: run.brief, audience }),
    envelope,
    inputHashes: [envelopeHash(envelope)],
    promptVersion: HOOK_CLARIFY_PROMPT_VERSION,
    sessionGroup: HOOK_PTY_SESSION_GROUP,
    interactivePty: true,
    budgetScope: `${run.id}:hook:clarify:${attempt}`,
    freshContext: true,
    validateContent: (parsed) => {
      const v = validateClarifyOutput(parsed);
      return v.ok ? { ok: true as const } : { ok: false as const, errorCode: v.errorCode, reason: v.reason };
    },
  });

  if (dispatch.status !== 'RUNNING') {
    await recordHookError(
      deps.dataDir,
      run,
      dispatch.reason ?? 'HOOK_CLARIFY_DISPATCH_FAILED',
      `Không dispatch được làm rõ title (${dispatch.status})`,
    );
  }
  return (await getWriterRunV2(run.id, deps.dataDir)) ?? run;
}

export async function startHookSuggest(
  deps: HookDeps,
  runId: string,
  answers: string[],
): Promise<WriterRunV2> {
  const run = await getWriterRunV2(runId, deps.dataDir);
  if (!run) throw new Error('Writer v2 post không tồn tại');
  assertDraftIdle(run);
  const title = titleOf(run);
  if (!title) throw new Error('Cần Title đã Save trước khi gợi ý hook');
  const questions = run.hookClarify?.questions ?? [];
  if (questions.length === 0) {
    throw new Error('Chưa có câu hỏi làm rõ title — bấm Làm rõ title trước');
  }
  if (!Array.isArray(answers) || answers.length !== questions.length) {
    throw new Error(`Cần đúng ${questions.length} câu trả lời, theo thứ tự câu hỏi`);
  }
  const trimmed = answers.map((a) => String(a ?? '').trim());
  if (trimmed.some((a) => !a)) {
    throw new Error('Mỗi câu hỏi cần một câu trả lời không rỗng');
  }

  const library = await getHookLibrary(DEFAULT_HOOK_LIBRARY, deps.dataDir);
  if (!library) {
    throw new Error(`Hook library không tồn tại: ${DEFAULT_HOOK_LIBRARY}`);
  }

  const attempt = nextAttempt(run);
  run.hookClarify = { questions, answers: trimmed };
  run.generatingHook = { step: 'suggest', attempt, startedAt: new Date().toISOString() };
  run.hookError = undefined;
  delete run.hookCandidates;
  delete run.selectedHook;
  run.hookLibraryHash = library.hash;
  run.updatedAt = new Date().toISOString();
  await saveWriterRunV2(run, deps.dataDir);

  const audience = run.audience ?? '';
  const qa = questions.map((question, i) => ({ question, answer: trimmed[i]! }));
  const envelope = {
    contract: {
      role: 'Writer v2 — HOOK SUGGEST',
      instruction: 'propose 3–5 new openings; human will pick one',
    },
    title,
    brief: run.brief,
    audience,
    answers: qa,
    libraryFile: 'input/hook-library.md',
  };

  const dispatch = await deps.scheduler.dispatchItem({
    batchId: run.id,
    itemId: WRITER_V2_ITEM_ID,
    stage: HOOK_SUGGEST_STAGE,
    attempt,
    templateId: run.agentId,
    promptMarkdown: buildSuggestPrompt({ title, brief: run.brief, audience, answers: qa }),
    envelope,
    inputFiles: [{ path: 'hook-library.md', content: library.markdown }],
    inputHashes: [envelopeHash(envelope), contentHash(library.markdown)],
    promptVersion: HOOK_SUGGEST_PROMPT_VERSION,
    sessionGroup: HOOK_PTY_SESSION_GROUP,
    interactivePty: true,
    budgetScope: `${run.id}:hook:suggest:${attempt}`,
    freshContext: true,
    validateContent: (parsed) => {
      const v = validateSuggestOutput(parsed);
      return v.ok ? { ok: true as const } : { ok: false as const, errorCode: v.errorCode, reason: v.reason };
    },
  });

  if (dispatch.status !== 'RUNNING') {
    await recordHookError(
      deps.dataDir,
      run,
      dispatch.reason ?? 'HOOK_SUGGEST_DISPATCH_FAILED',
      `Không dispatch được gợi ý hook (${dispatch.status})`,
    );
  }
  return (await getWriterRunV2(run.id, deps.dataDir)) ?? run;
}

export async function selectHook(
  dataDir: string,
  runId: string,
  selectedId: string,
): Promise<WriterRunV2> {
  const run = await getWriterRunV2(runId, dataDir);
  if (!run) throw new Error('Writer v2 post không tồn tại');
  if (run.status !== 'DRAFT') {
    throw new Error(`Chỉ chọn hook trên post DRAFT (hiện: ${run.status}/${run.phase})`);
  }
  if (run.generatingHook) {
    throw new Error('Đang gợi ý hook; chờ xong rồi chọn');
  }
  const id = selectedId.trim();
  const picked = (run.hookCandidates ?? []).find((c) => c.id === id);
  if (!picked) throw new Error('selectedId không khớp hook nào trên post này');
  const selected: SelectedHook = {
    id: picked.id,
    type: picked.type,
    typeLabel: picked.typeLabel,
    text: picked.text,
  };
  run.selectedHook = selected;
  run.hookError = undefined;
  run.updatedAt = new Date().toISOString();
  await saveWriterRunV2(run, dataDir);
  return run;
}

export function registerWriterV2HookListener(
  scheduler: LaneScheduler,
  deps: { dataDir: string },
): () => void {
  return scheduler.onItemSettled((event) => {
    if (event.stage !== HOOK_CLARIFY_STAGE && event.stage !== HOOK_SUGGEST_STAGE) return;
    void handleHookSettle(deps.dataDir, event).catch((err) => {
      console.error('[writer-v2] hook settle failed:', (err as Error).message);
    });
  });
}

async function handleHookSettle(dataDir: string, event: ItemSettledResult): Promise<void> {
  const run = await getWriterRunV2(event.batchId, dataDir);
  if (!run) return;
  if (!run.generatingHook || run.generatingHook.attempt !== event.attempt) return;
  const step = run.generatingHook.step;
  const expectedStage = step === 'clarify' ? HOOK_CLARIFY_STAGE : HOOK_SUGGEST_STAGE;
  if (event.stage !== expectedStage) return;

  if (event.outcome !== 'COMMITTED' || !event.artifactHash) {
    await recordHookError(
      dataDir,
      run,
      event.errorCode ?? 'HOOK_FAILED',
      event.errorReason ?? (step === 'clarify' ? 'Làm rõ title không hoàn tất' : 'Gợi ý hook không hoàn tất'),
    );
    return;
  }

  const parsed = await readCommittedArtifact(dataDir, event);
  if (step === 'clarify') {
    const validated = validateClarifyOutput(parsed);
    if (!validated.ok) {
      await recordHookError(dataDir, run, validated.errorCode, validated.reason);
      return;
    }
    run.hookClarify = { questions: validated.questions };
    delete run.generatingHook;
    run.hookError = undefined;
    run.updatedAt = new Date().toISOString();
    await saveWriterRunV2(run, dataDir);
    return;
  }

  const validated = validateSuggestOutput(parsed);
  if (!validated.ok) {
    await recordHookError(dataDir, run, validated.errorCode, validated.reason);
    return;
  }
  run.hookCandidates = validated.candidates;
  delete run.generatingHook;
  run.hookError = undefined;
  run.updatedAt = new Date().toISOString();
  await saveWriterRunV2(run, dataDir);
}

async function readCommittedArtifact(dataDir: string, event: ItemSettledResult): Promise<unknown> {
  const raw = await readFile(
    join(
      dataDir,
      'workspaces',
      'pipeline',
      event.batchId,
      WRITER_V2_ITEM_ID,
      'attempts',
      String(event.attempt),
      event.stage,
      'out',
      'result.json',
    ),
    'utf8',
  );
  return JSON.parse(raw) as unknown;
}

/**
 * Boot recovery for hook turns left `generatingHook` when the daemon died.
 * Status stays DRAFT in every outcome.
 */
export async function recoverInterruptedHooks(dataDir: string): Promise<void> {
  const summaries = await listWriterRunsV2(dataDir);
  for (const summary of summaries) {
    try {
      const run = await getWriterRunV2(summary.id, dataDir);
      if (!run?.generatingHook) continue;
      const { step, attempt } = run.generatingHook;
      const stage = step === 'clarify' ? HOOK_CLARIFY_STAGE : HOOK_SUGGEST_STAGE;
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(hookOutResultPath(dataDir, run.id, stage, attempt), 'utf8'));
      } catch (err) {
        await recordHookError(
          dataDir,
          run,
          'HOOK_INTERRUPTED',
          `Hook ${step} bị ngắt (daemon restart) và không đọc được out/result.json: ${(err as Error).message}`,
        );
        continue;
      }
      if (step === 'clarify') {
        const validated = validateClarifyOutput(parsed);
        if (!validated.ok) {
          await recordHookError(
            dataDir,
            run,
            'HOOK_INTERRUPTED',
            `Làm rõ title bị ngắt; out/result.json không hợp lệ (${validated.errorCode}): ${validated.reason}`,
          );
          continue;
        }
        run.hookClarify = { questions: validated.questions };
        delete run.generatingHook;
        run.hookError = undefined;
        run.updatedAt = new Date().toISOString();
        await saveWriterRunV2(run, dataDir);
        continue;
      }
      const validated = validateSuggestOutput(parsed);
      if (!validated.ok) {
        await recordHookError(
          dataDir,
          run,
          'HOOK_INTERRUPTED',
          `Gợi ý hook bị ngắt; out/result.json không hợp lệ (${validated.errorCode}): ${validated.reason}`,
        );
        continue;
      }
      run.hookCandidates = validated.candidates;
      delete run.generatingHook;
      run.hookError = undefined;
      run.updatedAt = new Date().toISOString();
      await saveWriterRunV2(run, dataDir);
    } catch (err) {
      console.error(
        `[writer-v2] recoverInterruptedHooks bỏ qua run ${summary.id}:`,
        (err as Error).message,
      );
    }
  }
}

export type { HookCandidate, SelectedHook };
