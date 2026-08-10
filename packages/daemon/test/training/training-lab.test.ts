/**
 * Training Lab (SDD 002 §12a) orchestrator tests — same fake-bridge pattern as
 * `formula-discovery.test.ts` (this session's closest precedent): each stage
 * dispatches a REAL turn through the real `LaneScheduler`/`TeamWorkflow`, and the
 * test hand-writes `out/result.json` and calls `workflow.turnComplete(turnId, ...)`
 * to stand in for the (not-yet-built) turnBridge. Everything downstream — commit
 * rule, `validateContent` grounding checks, and the `training-lab.ts` settle-listener
 * state machine — is real production code.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpyService } from '@writer-room/spy';
import { formulaFromSingleAnalysis, type FormulaArtifact } from '@writer-room/training-core';
import { createAgentHarness, type AgentHarness } from '../../src/harness.ts';
import type { ItemSettledResult, LaneScheduler } from '../../src/pipeline/lane-scheduler.ts';
import type { PipelineLedgerRow } from '../../src/pipeline/ledger.ts';
import { getTrainingLabRun, listTrainingLabRuns } from '../../src/training/storage.ts';
import { registerTrainingLabSettleListener, startTrainingLabRun } from '../../src/training/training-lab.ts';
import { seedVideo } from './fixtures.ts';

let dir: string;
let harness: AgentHarness;
let spy: SpyService;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wr-training-lab-'));
  harness = await createAgentHarness({ dataDir: dir, defaultProjectRoot: dir });
  spy = new SpyService({ dataRoot: join(dir, 'spy') });
  await spy.init();
  // Registered exactly once per test, mirroring the one-time `http.ts` registration
  // (and coexisting with the M1 ANALYZE listener in production, though that listener
  // is not registered in these tests since nothing here dispatches an `analyze` stage).
  registerTrainingLabSettleListener(harness.pipeline.scheduler, { dataDir: dir, spy });
});

afterEach(() => {
  harness.dispose();
  rmSync(dir, { recursive: true, force: true });
});

function itemRunDir(batchId: string, itemId: string, stage: string, attempt: number): string {
  return join(dir, 'workspaces', 'pipeline', batchId, itemId, 'attempts', String(attempt), stage);
}

/** DRAFT's minimum-length check (2026-08-10, `validateDraftShape`) requires a HARD
 * 70% of the target word count, and the smallest possible target (a very short
 * seeded fixture transcript) is still clamped to a 600-word floor
 * (`draftTargetWordCount`) — so every fixture draft script needs ≥420 words. Test
 * fixtures only care about a short QUOTABLE snippet for CRITIQUE's `draftEvidence`
 * assertions; pad with filler ahead of the real content so the whole thing clears
 * the floor (with margin) without changing what's quotable. */
function padScript(realContent: string): string {
  const filler = Array.from({ length: 500 }, (_, i) => `filler${i}`).join(' ');
  return `${filler} ${realContent}`;
}

async function waitUntil<T>(
  fn: () => Promise<T> | T,
  predicate: (value: T) => boolean,
  { timeoutMs = 3000, intervalMs = 10 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (predicate(value)) return value;
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function waitForLedgerRow(
  batchId: string, itemId: string, stage: string, attempt: number,
): Promise<PipelineLedgerRow> {
  const row = await waitUntil(
    () => harness.pipeline.ledger.all().find((r) =>
      r.batchId === batchId && r.itemId === itemId && r.stage === stage && r.attempt === attempt
    ),
    (r) => r !== undefined,
  );
  return row!;
}

/** Same idea as `waitForLedgerRow`, but for the NEXT ledger row for a given
 * (batchId, itemId, stage, attempt) not already in `seenTurnIds` — added
 * 2026-08-10 alongside `LaneScheduler`'s automatic content-retry
 * (`retryWithCorrection`): a retry keeps the SAME `attempt` (it is the same
 * logical round, just resubmitted), so it lands a NEW row with a DIFFERENT
 * `turnId` rather than a new `attempt` number. Excludes the WHOLE set of
 * previously-seen turnIds (not just the immediately-prior one) — with 2+ retries
 * there can be an older, already-terminal row that also isn't the most recent one,
 * and `.find()` would otherwise latch onto that stale row instead of waiting for
 * the genuinely new one. */
async function waitForRetryLedgerRow(
  batchId: string, itemId: string, stage: string, attempt: number, seenTurnIds: Set<string>,
): Promise<PipelineLedgerRow> {
  const row = await waitUntil(
    () => harness.pipeline.ledger.all().find((r) =>
      r.batchId === batchId && r.itemId === itemId && r.stage === stage && r.attempt === attempt
      && !seenTurnIds.has(r.turnId)
    ),
    (r) => r !== undefined,
  );
  seenTurnIds.add(row!.turnId);
  return row!;
}

function waitForSettled(
  scheduler: LaneScheduler, itemId: string, stage: string, attempt: number,
): Promise<ItemSettledResult> {
  return new Promise((resolve) => {
    const unsub = scheduler.onItemSettled((r) => {
      if (r.itemId !== itemId || r.stage !== stage || r.attempt !== attempt) return;
      unsub();
      resolve(r);
    });
  });
}

function makeStartingFormula(videoSnapshotId: string, segmentId: string, quote: string): FormulaArtifact {
  return formulaFromSingleAnalysis(
    {
      videoSnapshotId,
      channelTitle: 'Test Channel',
      rules: [
        {
          id: 'rule-1',
          statement: 'Opens with a direct question to the viewer.',
          evidence: [{ segmentIds: [segmentId], quote }],
        },
      ],
      createdAt: new Date().toISOString(),
    },
    { videoSnapshotId, analysisArtifactHash: 'deadbeef' },
    'seed-batch',
  );
}

describe('startTrainingLabRun — happy path', () => {
  test('a 3-round run where every DRAFT/CRITIQUE/REFINE settles cleanly reaches DONE', async () => {
    const { videoSnapshotId, segments } = await seedVideo(spy);
    const sourceQuote = segments[0]!.text.slice(0, 20);
    const startingFormula = makeStartingFormula(videoSnapshotId, segments[0]!.id, sourceQuote);

    // §12a session-identity regression guard (2026-08-10, user: "2 agent chạy thì chỉ
    // chạy ở 2 session thôi") — track which clone/agent id every dispatched turn used;
    // matched back to a stage below via each stage's ledger row `turnId`.
    const turnIdToAgentId = new Map<number, string>();
    const unsub = harness.subscribe((e) => {
      if (e.kind === 'spawnTurn') turnIdToAgentId.set(e.turnId, e.agentId);
    });

    const run = await startTrainingLabRun(
      { spy, scheduler: harness.pipeline.scheduler, dataDir: dir },
      { videoSnapshotId, startingFormula, draftAgent: 'grok', critiqueAgent: 'grok' },
    );
    expect(run.status).toBe('RUNNING');
    expect(run.rounds.length).toBe(1);
    expect(run.rounds[0]!.formulaVersionIn.version).toBe(1);
    expect(run.rounds[0]!.formulaVersionIn.lineage.parentFormulaId).toBeUndefined();

    const draftAgentIds = new Set<string>();
    const critiqueAgentIds = new Set<string>();
    const refineAgentIds = new Set<string>();

    for (let round = 1; round <= 3; round++) {
      const draftScript = padScript(`Round ${round} script. It contains a specific detail worth quoting here.`);
      const draftEvidenceQuote = 'specific detail worth quoting';

      // DRAFT
      const draftRow = await waitForLedgerRow(run.id, videoSnapshotId, 'draft', round);
      draftAgentIds.add(turnIdToAgentId.get(Number(draftRow.turnId))!);
      await Bun.write(
        join(itemRunDir(run.id, videoSnapshotId, 'draft', round), 'out', 'result.json'),
        JSON.stringify({ title: `Round ${round} title`, script: draftScript, appliedRules: ['rule-1'] }),
      );
      const draftSettled = waitForSettled(harness.pipeline.scheduler, videoSnapshotId, 'draft', round);
      harness.workflow.turnComplete(Number(draftRow.turnId), { exitCode: 0 });
      await draftSettled;

      // CRITIQUE
      const critiqueRow = await waitForLedgerRow(run.id, videoSnapshotId, 'critique', round);
      critiqueAgentIds.add(turnIdToAgentId.get(Number(critiqueRow.turnId))!);
      await Bun.write(
        join(itemRunDir(run.id, videoSnapshotId, 'critique', round), 'out', 'result.json'),
        JSON.stringify({
          positivePatterns: [
            {
              id: 'p1',
              ruleId: 'rule-1',
              description: 'Draft matches the source opening pattern.',
              sourceEvidence: [{ segmentIds: [segments[0]!.id], quote: sourceQuote }],
              draftEvidence: [{ quote: draftEvidenceQuote }],
            },
          ],
          negativePatterns: [],
        }),
      );
      const critiqueSettled = waitForSettled(harness.pipeline.scheduler, videoSnapshotId, 'critique', round);
      harness.workflow.turnComplete(Number(critiqueRow.turnId), { exitCode: 0 });
      await critiqueSettled;

      // REFINE
      const refineRow = await waitForLedgerRow(run.id, videoSnapshotId, 'refine', round);
      refineAgentIds.add(turnIdToAgentId.get(Number(refineRow.turnId))!);
      await Bun.write(
        join(itemRunDir(run.id, videoSnapshotId, 'refine', round), 'out', 'result.json'),
        JSON.stringify({
          rules: [
            {
              id: 'rule-1',
              statement: `Opens with a direct question to the viewer (round ${round} refinement).`,
              evidence: [{ segmentIds: [segments[0]!.id], quote: sourceQuote }],
            },
          ],
          changeLog: [`kept rule-1: pattern p1 confirms it works (round ${round})`],
        }),
      );
      const refineSettled = waitForSettled(harness.pipeline.scheduler, videoSnapshotId, 'refine', round);
      harness.workflow.turnComplete(Number(refineRow.turnId), { exitCode: 0 });
      await refineSettled;
    }
    unsub();

    // §12a session identity: exactly 2 total agent identities across all 9 turns —
    // one stable for DRAFT across all 3 rounds, one stable and SHARED by CRITIQUE and
    // REFINE across all 3 rounds (added 2026-08-10; previously CRITIQUE/REFINE only
    // shared an identity WITHIN one round, giving 4 total across a 3-round run).
    expect(draftAgentIds.size).toBe(1);
    expect(critiqueAgentIds.size).toBe(1);
    expect(refineAgentIds.size).toBe(1);
    expect([...critiqueAgentIds]).toEqual([...refineAgentIds]);
    expect([...draftAgentIds][0]).not.toBe([...critiqueAgentIds][0]);

    const finalRun = await waitUntil(
      () => getTrainingLabRun(run.id, dir),
      (r) => r?.status === 'DONE',
    );
    expect(finalRun).not.toBeNull();
    expect(finalRun!.rounds.length).toBe(3);

    for (let i = 0; i < 3; i++) {
      const round = finalRun!.rounds[i]!;
      expect(round.status).toBe('DONE');
      expect(round.formulaVersionOut).not.toBeNull();
      expect(round.formulaVersionOut!.version).toBe(i + 2); // v1 -> round1 out v2, round2 out v3, round3 out v4
      expect(round.formulaVersionOut!.status).toBe('TRIAL');
      expect(round.formulaVersionOut!.lineage.parentFormulaId).toBe(round.formulaVersionIn.id);
      expect(round.formulaVersionOut!.origin).toBe('REFINED');
      if (i < 2) {
        expect(finalRun!.rounds[i + 1]!.formulaVersionIn).toEqual(round.formulaVersionOut!);
      }
    }
  });
});

describe('startTrainingLabRun — CRITIQUE grounding rejection', () => {
  /** Same ungrounded `draftEvidence` quote every round — used to prove that even
   * with `LaneScheduler`'s automatic content-retry (2026-08-10, `DEFAULT_MAX_
   * CONTENT_RETRIES = 2`), a genuinely-bad citation the agent never fixes still
   * ultimately fails the round after retries are exhausted, not silently forever. */
  function badCritiqueResult(sourceQuote: string, segmentId: string): string {
    return JSON.stringify({
      positivePatterns: [
        {
          id: 'p1',
          description: 'Claims a match that is not actually in the draft.',
          sourceEvidence: [{ segmentIds: [segmentId], quote: sourceQuote }],
          draftEvidence: [{ quote: 'this exact sentence never appears in the draft script' }],
        },
      ],
      negativePatterns: [],
    });
  }

  test('an ungrounded draftEvidence quote survives retries then fails the round and stops the run', async () => {
    const { videoSnapshotId, segments } = await seedVideo(spy);
    const sourceQuote = segments[0]!.text.slice(0, 20);
    const startingFormula = makeStartingFormula(videoSnapshotId, segments[0]!.id, sourceQuote);

    const run = await startTrainingLabRun(
      { spy, scheduler: harness.pipeline.scheduler, dataDir: dir },
      { videoSnapshotId, startingFormula, draftAgent: 'grok', critiqueAgent: 'grok' },
    );

    const draftScript = padScript('Round 1 script with only this real content in it.');
    const draftRow = await waitForLedgerRow(run.id, videoSnapshotId, 'draft', 1);
    await Bun.write(
      join(itemRunDir(run.id, videoSnapshotId, 'draft', 1), 'out', 'result.json'),
      JSON.stringify({ title: 'Round 1 title', script: draftScript, appliedRules: ['rule-1'] }),
    );
    const draftSettled = waitForSettled(harness.pipeline.scheduler, videoSnapshotId, 'draft', 1);
    harness.workflow.turnComplete(Number(draftRow.turnId), { exitCode: 0 });
    await draftSettled;

    const critiqueDir = join(itemRunDir(run.id, videoSnapshotId, 'critique', 1), 'out', 'result.json');
    const critiqueSettled = waitForSettled(harness.pipeline.scheduler, videoSnapshotId, 'critique', 1);

    const seenTurnIds = new Set<string>();

    // Round 1 (original) — bad quote, rejected, auto-retried by the scheduler.
    let row = await waitForLedgerRow(run.id, videoSnapshotId, 'critique', 1);
    seenTurnIds.add(row.turnId);
    await Bun.write(critiqueDir, badCritiqueResult(sourceQuote, segments[0]!.id));
    harness.workflow.turnComplete(Number(row.turnId), { exitCode: 0 });

    // Retry 1/2 — still bad, rejected, auto-retried again.
    row = await waitForRetryLedgerRow(run.id, videoSnapshotId, 'critique', 1, seenTurnIds);
    await Bun.write(critiqueDir, badCritiqueResult(sourceQuote, segments[0]!.id));
    harness.workflow.turnComplete(Number(row.turnId), { exitCode: 0 });

    // Retry 2/2 — still bad; retries now exhausted, this is the FINAL settle.
    row = await waitForRetryLedgerRow(run.id, videoSnapshotId, 'critique', 1, seenTurnIds);
    await Bun.write(critiqueDir, badCritiqueResult(sourceQuote, segments[0]!.id));
    harness.workflow.turnComplete(Number(row.turnId), { exitCode: 0 });

    const settled = await critiqueSettled;
    expect(settled.outcome).toBe('FAILED');
    expect(settled.errorCode).toBe('AGENT_UNGROUNDED');

    // Exactly 3 ledger rows for this round's critique stage (original + 2 retries),
    // all FAILED — proving the retry loop ran and did not silently drop attempts.
    const critiqueRows = harness.pipeline.ledger.all()
      .filter((r) => r.batchId === run.id && r.itemId === videoSnapshotId && r.stage === 'critique' && r.attempt === 1);
    expect(critiqueRows.length).toBe(3);
    expect(critiqueRows.every((r) => r.outcome === 'FAILED' && r.errorCode === 'AGENT_UNGROUNDED')).toBe(true);

    const finalRun = await waitUntil(
      () => getTrainingLabRun(run.id, dir),
      (r) => r?.status === 'FAILED',
    );
    expect(finalRun!.rounds.length).toBe(1);
    expect(finalRun!.rounds[0]!.status).toBe('FAILED');
    expect(finalRun!.rounds[0]!.errorCode).toBe('AGENT_UNGROUNDED');

    // No REFINE stage was ever dispatched for this run.
    const refineRows = harness.pipeline.ledger.all().filter((r) => r.batchId === run.id && r.stage === 'refine');
    expect(refineRows.length).toBe(0);
  });

  test('an ungrounded draftEvidence quote fixed on retry lets the round proceed to REFINE', async () => {
    const { videoSnapshotId, segments } = await seedVideo(spy);
    const sourceQuote = segments[0]!.text.slice(0, 20);
    const startingFormula = makeStartingFormula(videoSnapshotId, segments[0]!.id, sourceQuote);

    const run = await startTrainingLabRun(
      { spy, scheduler: harness.pipeline.scheduler, dataDir: dir },
      { videoSnapshotId, startingFormula, draftAgent: 'grok', critiqueAgent: 'grok' },
    );

    const draftScript = padScript('Round 1 script with only this real content in it.');
    const draftRow = await waitForLedgerRow(run.id, videoSnapshotId, 'draft', 1);
    await Bun.write(
      join(itemRunDir(run.id, videoSnapshotId, 'draft', 1), 'out', 'result.json'),
      JSON.stringify({ title: 'Round 1 title', script: draftScript, appliedRules: ['rule-1'] }),
    );
    const draftSettled = waitForSettled(harness.pipeline.scheduler, videoSnapshotId, 'draft', 1);
    harness.workflow.turnComplete(Number(draftRow.turnId), { exitCode: 0 });
    await draftSettled;

    const critiqueDir = join(itemRunDir(run.id, videoSnapshotId, 'critique', 1), 'out', 'result.json');
    const critiqueSettled = waitForSettled(harness.pipeline.scheduler, videoSnapshotId, 'critique', 1);

    // Round 1 (original) — bad quote, rejected, auto-retried.
    const originalRow = await waitForLedgerRow(run.id, videoSnapshotId, 'critique', 1);
    await Bun.write(critiqueDir, badCritiqueResult(sourceQuote, segments[0]!.id));
    harness.workflow.turnComplete(Number(originalRow.turnId), { exitCode: 0 });

    // Retry 1/2 — agent fixes its own mistake this time: real draft-side quote.
    const retryRow = await waitForRetryLedgerRow(run.id, videoSnapshotId, 'critique', 1, new Set([originalRow.turnId]));
    await Bun.write(critiqueDir, JSON.stringify({
      positivePatterns: [
        {
          id: 'p1',
          description: 'Draft genuinely echoes the source opening.',
          sourceEvidence: [{ segmentIds: [segments[0]!.id], quote: sourceQuote }],
          draftEvidence: [{ quote: draftScript.slice(0, 20) }],
        },
      ],
      negativePatterns: [],
    }));
    harness.workflow.turnComplete(Number(retryRow.turnId), { exitCode: 0 });

    const settled = await critiqueSettled;
    expect(settled.outcome).toBe('COMMITTED');

    // Exactly 2 ledger rows (1 rejected original + 1 corrected retry that committed).
    const critiqueRows = harness.pipeline.ledger.all()
      .filter((r) => r.batchId === run.id && r.itemId === videoSnapshotId && r.stage === 'critique' && r.attempt === 1);
    expect(critiqueRows.length).toBe(2);
    expect(critiqueRows.filter((r) => r.outcome === 'FAILED').length).toBe(1);
    expect(critiqueRows.filter((r) => r.outcome === 'COMMITTED').length).toBe(1);

    // The round proceeded past CRITIQUE into REFINE — proving downstream (training-lab.ts)
    // only ever saw the ONE final settle event, not the intermediate rejection.
    const refineRow = await waitForLedgerRow(run.id, videoSnapshotId, 'refine', 1);
    expect(refineRow).toBeTruthy();
  });
});

describe('startTrainingLabRun — DRAFT failure stops the run', () => {
  test('a non-zero DRAFT exit fails round 1 and the run, with no further dispatch', async () => {
    const { videoSnapshotId, segments } = await seedVideo(spy);
    const sourceQuote = segments[0]!.text.slice(0, 20);
    const startingFormula = makeStartingFormula(videoSnapshotId, segments[0]!.id, sourceQuote);

    const run = await startTrainingLabRun(
      { spy, scheduler: harness.pipeline.scheduler, dataDir: dir },
      { videoSnapshotId, startingFormula, draftAgent: 'grok', critiqueAgent: 'grok' },
    );

    const draftRow = await waitForLedgerRow(run.id, videoSnapshotId, 'draft', 1);
    const draftSettled = waitForSettled(harness.pipeline.scheduler, videoSnapshotId, 'draft', 1);
    harness.workflow.turnComplete(Number(draftRow.turnId), { exitCode: 1 });

    const settled = await draftSettled;
    expect(settled.outcome).toBe('FAILED');
    expect(settled.errorCode).toBe('AGENT_EXIT');

    const finalRun = await waitUntil(
      () => getTrainingLabRun(run.id, dir),
      (r) => r?.status === 'FAILED',
    );
    expect(finalRun!.rounds.length).toBe(1);
    expect(finalRun!.rounds[0]!.status).toBe('FAILED');
    expect(finalRun!.rounds[0]!.errorCode).toBe('AGENT_EXIT');

    const critiqueRows = harness.pipeline.ledger.all().filter((r) => r.batchId === run.id && r.stage === 'critique');
    expect(critiqueRows.length).toBe(0);
  });
});

describe('listTrainingLabRuns / getTrainingLabRun — round-trip', () => {
  test('reflects an in-progress run correctly right after round 1 DRAFT settles', async () => {
    const { videoSnapshotId, segments } = await seedVideo(spy);
    const sourceQuote = segments[0]!.text.slice(0, 20);
    const startingFormula = makeStartingFormula(videoSnapshotId, segments[0]!.id, sourceQuote);

    const run = await startTrainingLabRun(
      { spy, scheduler: harness.pipeline.scheduler, dataDir: dir },
      { videoSnapshotId, startingFormula, draftAgent: 'grok', critiqueAgent: 'grok' },
    );

    const draftScript = padScript('Round 1 script with a quotable detail in it.');
    const draftRow = await waitForLedgerRow(run.id, videoSnapshotId, 'draft', 1);
    await Bun.write(
      join(itemRunDir(run.id, videoSnapshotId, 'draft', 1), 'out', 'result.json'),
      JSON.stringify({ title: 'Round 1 title', script: draftScript, appliedRules: ['rule-1'] }),
    );
    const draftSettled = waitForSettled(harness.pipeline.scheduler, videoSnapshotId, 'draft', 1);
    harness.workflow.turnComplete(Number(draftRow.turnId), { exitCode: 0 });
    await draftSettled;

    const partial = await waitUntil(
      () => getTrainingLabRun(run.id, dir),
      (r) => r?.rounds[0]?.draft !== null,
    );
    expect(partial).not.toBeNull();
    expect(partial!.status).toBe('RUNNING');
    expect(partial!.rounds.length).toBe(1);
    expect(partial!.rounds[0]!.status).toBe('CRITIQUING');
    expect(partial!.rounds[0]!.draft).toEqual({ title: 'Round 1 title', script: draftScript, appliedRules: ['rule-1'] });
    expect(partial!.rounds[0]!.draftArtifactHash).toBeTruthy();
    expect(partial!.rounds[0]!.critique).toBeNull();

    const summaries = await listTrainingLabRuns(dir);
    expect(summaries.length).toBe(1);
    expect(summaries[0]!.id).toBe(run.id);
    expect(summaries[0]!.videoSnapshotId).toBe(videoSnapshotId);
    expect(summaries[0]!.status).toBe('RUNNING');
    expect(summaries[0]!.roundCount).toBe(1);
  });
});
