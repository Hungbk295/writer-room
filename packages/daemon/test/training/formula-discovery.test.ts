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
    expect(formula!.channelGroups).toEqual([
      { channelTitle: 'Test Channel', videoSnapshotIds: [videoSnapshotId] },
    ]);
    expect(formula!.rules.length).toBe(1);
  });
});

describe('runFormulaDiscovery — ungrounded rejection', () => {
  test('a fabricated quote fails the item as AGENT_UNGROUNDED and saves no Formula', async () => {
    const { videoSnapshotId } = await seedVideo(spy);
    const batchId = randomUUID();

    const dispatch = await runFormulaDiscovery(
      { spy, agents: harness.agents, scheduler: harness.pipeline.scheduler },
      { batchId, videoSnapshotId },
    );
    expect(dispatch.status).toBe('DISPATCHED');

    const settledPromise = waitForSettled(harness.pipeline.scheduler, videoSnapshotId);

    const runDir = itemRunDir(batchId, videoSnapshotId);
    await Bun.write(
      join(runDir, 'out', 'result.json'),
      JSON.stringify({
        rules: [
          {
            id: 'rule-1',
            statement: 'Claims something the transcript never says.',
            evidence: [{
              segmentIds: [`seg-${videoSnapshotId}-1`],
              quote: 'this exact sentence never appears anywhere in the transcript',
            }],
          },
        ],
      }),
    );
    harness.workflow.turnComplete(dispatch.turnId!, { exitCode: 0 });

    const settled = await settledPromise;
    expect(settled.outcome).toBe('FAILED');
    expect(settled.errorCode).toBe('AGENT_UNGROUNDED');

    // Give the (fire-and-forget) aggregation listener a beat to run — it should be
    // a no-op since the item never reached COMMITTED.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const formulas = await listFormulas(dir);
    expect(formulas.length).toBe(0);
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
