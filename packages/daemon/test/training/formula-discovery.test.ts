/**
 * Formula Discovery orchestrator + aggregation tests (SDD 002 M1).
 *
 * Uses the same fake-bridge pattern `packages/daemon/test/pipeline/lane-scheduler.test.ts`
 * established for M0.5: `runFormulaDiscovery` dispatches a REAL turn through the
 * real `LaneScheduler`/`TeamWorkflow`, and the test stands in for the (not-yet-built)
 * turnBridge by writing `out/result.json` by hand and calling
 * `workflow.turnComplete(turnId, { exitCode })` directly. Everything downstream of
 * that (commit rule, including the new `validateContent` grounding check, then the
 * settle-listener that builds and saves a Formula) is real production code.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SpyService } from '@writer-room/spy';
import { createAgentHarness, type AgentHarness } from '../../src/harness.ts';
import type { ItemSettledResult, LaneScheduler } from '../../src/pipeline/lane-scheduler.ts';
import { ANALYZE_STAGE, registerTrainingSettleListener } from '../../src/training/aggregator.ts';
import { runFormulaDiscovery } from '../../src/training/orchestrator.ts';
import { getFormula, listFormulas } from '../../src/training/storage.ts';
import { seedVideo } from './fixtures.ts';

let dir: string;
let harness: AgentHarness;
let spy: SpyService;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wr-training-formula-'));
  harness = await createAgentHarness({ dataDir: dir, defaultProjectRoot: dir });
  spy = new SpyService({ dataRoot: join(dir, 'spy') });
  await spy.init();
  // Registered exactly once per test, mirroring the one-time `http.ts` registration.
  registerTrainingSettleListener(harness.pipeline.scheduler, { dataDir: dir, spy });
});

afterEach(() => {
  harness.dispose();
  rmSync(dir, { recursive: true, force: true });
});

function itemRunDir(batchId: string, videoSnapshotId: string): string {
  return join(dir, 'workspaces', 'pipeline', batchId, videoSnapshotId, 'attempts', '1', ANALYZE_STAGE);
}

function waitForSettled(scheduler: LaneScheduler, itemId: string): Promise<ItemSettledResult> {
  return new Promise((resolve) => {
    const unsub = scheduler.onItemSettled((r) => {
      if (r.itemId !== itemId) return;
      unsub();
      resolve(r);
    });
  });
}

async function waitUntil<T>(
  fn: () => Promise<T> | T,
  predicate: (value: T) => boolean,
  { timeoutMs = 2000, intervalMs = 10 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (predicate(value)) return value;
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe('runFormulaDiscovery — happy path', () => {
  test('a fully-grounded result.json commits and produces a TRIAL Formula', async () => {
    const { videoSnapshotId, segments } = await seedVideo(spy);
    const batchId = randomUUID();

    const dispatch = await runFormulaDiscovery(
      { spy, agents: harness.agents, scheduler: harness.pipeline.scheduler },
      { batchId, videoSnapshotId },
    );
    expect(dispatch.status).toBe('DISPATCHED');
    expect(dispatch.turnId).toBeDefined();

    const settledPromise = waitForSettled(harness.pipeline.scheduler, videoSnapshotId);

    // Fake bridge: write a well-formed, fully-grounded result.json — every quote is
    // a real substring of the segment it cites.
    const runDir = itemRunDir(batchId, videoSnapshotId);
    const firstSegment = segments[0]!;
    const quote = firstSegment.text.slice(0, 20);
    await Bun.write(
      join(runDir, 'out', 'result.json'),
      JSON.stringify({
        rules: [
          {
            id: 'rule-1',
            role: 'payoff',
            statement: 'Opens with a direct question to the viewer.',
            evidence: [{ segmentIds: [firstSegment.id], quote }],
          },
        ],
      }),
    );
    harness.workflow.turnComplete(dispatch.turnId!, { exitCode: 0 });

    const settled = await settledPromise;
    expect(settled.outcome).toBe('COMMITTED');
    expect(settled.artifactHash).toBeTruthy();

    const formulas = await waitUntil(() => listFormulas(dir), (list) => list.length > 0);
    expect(formulas.length).toBe(1);
    expect(formulas[0]!.status).toBe('TRIAL');

    const formula = await getFormula(formulas[0]!.id, dir);
    expect(formula).not.toBeNull();
    expect(formula!.status).toBe('TRIAL');
    expect(formula!.includedArtifacts).toEqual([
      { videoSnapshotId, analysisArtifactHash: settled.artifactHash! },
    ]);
    expect(formula!.warnings.some((w) => w.includes('LOW_SAMPLE'))).toBe(true);
    expect(formula!.origin).toBe('ANALYZED');
    expect(formula!.version).toBe(1);
    expect(formula!.videoSnapshotId).toBe(videoSnapshotId);
    expect(formula!.channelTitle).toBe('Test Channel');
    expect(formula!.rules.length).toBe(1);
  });
});

describe('runFormulaDiscovery — ungrounded rejection', () => {
  function fabricatedResult(): string {
    return JSON.stringify({
      rules: [
        {
          id: 'rule-1',
          role: 'payoff',
          statement: 'Claims something the transcript never says.',
          evidence: [{
            segmentIds: [`seg-fabricated`],
            quote: 'this exact sentence never appears anywhere in the transcript',
          }],
        },
      ],
    });
  }

  /** Same lookup as `dispatch.turnId`, but for the NEXT ledger row `LaneScheduler`'s
   * automatic content-retry creates for this (batchId, itemId, stage, attempt) —
   * added 2026-08-10 alongside `retryWithCorrection`: a retry keeps the same
   * `attempt`/stage, so it needs a distinct `turnId`, not a distinct `attempt`, to
   * find. Excludes the WHOLE set of previously-seen turnIds (not just the
   * immediately-prior one) — with 2+ retries there's an older, already-terminal row
   * that also isn't the most recent one, and `.find()` would otherwise latch onto
   * that stale row instead of waiting for the genuinely new one. */
  async function waitForRetryTurnId(batchId: string, itemId: string, seenTurnIds: Set<number>): Promise<number> {
    const row = await waitUntil(
      () => harness.pipeline.ledger.all().find((r) =>
        r.batchId === batchId && r.itemId === itemId && r.stage === ANALYZE_STAGE
        && r.attempt === 1 && !seenTurnIds.has(Number(r.turnId))
      ),
      (r) => r !== undefined,
    );
    const turnId = Number(row!.turnId);
    seenTurnIds.add(turnId);
    return turnId;
  }

  test('a fabricated quote survives retries then fails the item as AGENT_UNGROUNDED, saves no Formula', async () => {
    const { videoSnapshotId } = await seedVideo(spy);
    const batchId = randomUUID();

    const dispatch = await runFormulaDiscovery(
      { spy, agents: harness.agents, scheduler: harness.pipeline.scheduler },
      { batchId, videoSnapshotId },
    );
    expect(dispatch.status).toBe('DISPATCHED');

    const settledPromise = waitForSettled(harness.pipeline.scheduler, videoSnapshotId);
    const runDir = itemRunDir(batchId, videoSnapshotId);
    const resultPath = join(runDir, 'out', 'result.json');

    const seenTurnIds = new Set<number>([dispatch.turnId!]);

    // Original — fabricated quote, rejected, auto-retried by the scheduler
    // (`DEFAULT_MAX_CONTENT_RETRIES = 2`).
    await Bun.write(resultPath, fabricatedResult());
    harness.workflow.turnComplete(dispatch.turnId!, { exitCode: 0 });

    // Retry 1/2 — still fabricated.
    let turnId = await waitForRetryTurnId(batchId, videoSnapshotId, seenTurnIds);
    await Bun.write(resultPath, fabricatedResult());
    harness.workflow.turnComplete(turnId, { exitCode: 0 });

    // Retry 2/2 — still fabricated; retries now exhausted, this is the FINAL settle.
    turnId = await waitForRetryTurnId(batchId, videoSnapshotId, seenTurnIds);
    await Bun.write(resultPath, fabricatedResult());
    harness.workflow.turnComplete(turnId, { exitCode: 0 });

    const settled = await settledPromise;
    expect(settled.outcome).toBe('FAILED');
    expect(settled.errorCode).toBe('AGENT_UNGROUNDED');

    // 3 ledger rows total (original + 2 retries), all FAILED.
    const rows = harness.pipeline.ledger.all()
      .filter((r) => r.batchId === batchId && r.itemId === videoSnapshotId && r.stage === ANALYZE_STAGE);
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.outcome === 'FAILED' && r.errorCode === 'AGENT_UNGROUNDED')).toBe(true);

    // Give the (fire-and-forget) aggregation listener a beat to run — it should be
    // a no-op since the item never reached COMMITTED.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const formulas = await listFormulas(dir);
    expect(formulas.length).toBe(0);
  });

  test('a fabricated quote fixed on retry commits and saves a Formula', async () => {
    const { videoSnapshotId, segments } = await seedVideo(spy);
    const batchId = randomUUID();

    const dispatch = await runFormulaDiscovery(
      { spy, agents: harness.agents, scheduler: harness.pipeline.scheduler },
      { batchId, videoSnapshotId },
    );
    expect(dispatch.status).toBe('DISPATCHED');

    const settledPromise = waitForSettled(harness.pipeline.scheduler, videoSnapshotId);
    const runDir = itemRunDir(batchId, videoSnapshotId);
    const resultPath = join(runDir, 'out', 'result.json');

    // Original — fabricated quote, rejected, auto-retried.
    await Bun.write(resultPath, fabricatedResult());
    harness.workflow.turnComplete(dispatch.turnId!, { exitCode: 0 });

    // Retry 1/2 — agent fixes its own mistake: a real, grounded quote this time.
    const turnId = await waitForRetryTurnId(batchId, videoSnapshotId, new Set([dispatch.turnId!]));
    await Bun.write(resultPath, JSON.stringify({
      rules: [
        {
          id: 'rule-1',
          role: 'payoff',
          statement: 'Opens with a concrete claim from the transcript.',
          evidence: [{ segmentIds: [segments[0]!.id], quote: segments[0]!.text.slice(0, 15) }],
        },
      ],
    }));
    harness.workflow.turnComplete(turnId, { exitCode: 0 });

    const settled = await settledPromise;
    expect(settled.outcome).toBe('COMMITTED');

    const rows = harness.pipeline.ledger.all()
      .filter((r) => r.batchId === batchId && r.itemId === videoSnapshotId && r.stage === ANALYZE_STAGE);
    expect(rows.length).toBe(2);
    expect(rows.filter((r) => r.outcome === 'FAILED').length).toBe(1);
    expect(rows.filter((r) => r.outcome === 'COMMITTED').length).toBe(1);

    const formula = await waitUntil(
      () => listFormulas(dir).then((fs) => fs.find((f) => f.sourceBatchId === batchId)),
      (f) => f !== undefined,
    );
    expect(formula).toBeTruthy();
  });
});

describe('runFormulaDiscovery — preflight short-circuit', () => {
  test('a video with no transcript is BLOCKED before any dispatch happens', async () => {
    const { videoSnapshotId } = await seedVideo(spy, { transcriptStatus: 'missing', segmentTexts: [] });
    const batchId = randomUUID();

    const result = await runFormulaDiscovery(
      { spy, agents: harness.agents, scheduler: harness.pipeline.scheduler },
      { batchId, videoSnapshotId },
    );

    expect(result.status).toBe('BLOCKED');
    expect(result.blockers?.some((b) => b.code === 'INPUT_MISSING_TRANSCRIPT')).toBe(true);
    expect(result.turnId).toBeUndefined();

    // No ledger row and no ephemeral clone — nothing was dispatched.
    const rows = harness.pipeline.ledger.all().filter((r) => r.itemId === videoSnapshotId);
    expect(rows.length).toBe(0);
    expect(harness.listAgents().some((a) => a.ephemeral)).toBe(false);
  });
});
