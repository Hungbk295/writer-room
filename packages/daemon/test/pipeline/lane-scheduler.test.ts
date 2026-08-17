/**
 * Lane scheduler walking-skeleton tests (SDD 002 M0.5).
 *
 * There is no real turnBridge client in this test process, and we must not spawn a
 * real Claude/Codex CLI (cost, non-determinism, needs auth). Instead these tests use
 * a fake bridge: after `dispatchItem`, they read the real `spawnTurn` SSE event
 * (proving `requestTurn` actually dispatched a distinct clone), then — standing in
 * only for the OS-process-spawn step a real turnBridge would own — run
 * `runStubAgent` in-process against the real `itemRunDir`, and call the real
 * `workflow.turnComplete(turnId, { exitCode })` themselves. Everything else
 * (requestTurn -> spawnTurn -> turnComplete -> onTurnSettled -> commit rule) is the
 * real production code path.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStubAgent } from '@writer-room/pipeline-core';
import { createAgentHarness, type AgentHarness } from '../../src/harness.ts';
import { LaneScheduler, type DispatchItemParams, type DispatchItemResult, type ItemSettledResult } from '../../src/pipeline/lane-scheduler.ts';
import type { TeamEvent } from '../../src/team/workflow.ts';

const BATCH = 'batch-1';
const STAGE = 'analyze';

function baseParams(overrides: Partial<DispatchItemParams> = {}): DispatchItemParams {
  return {
    batchId: BATCH,
    itemId: 'item-1',
    stage: STAGE,
    attempt: 1,
    templateId: 'claude',
    promptMarkdown: 'Do the analysis and write out/result.json.',
    envelope: { taskKind: 'test' },
    inputHashes: ['hash-1'],
    promptVersion: 'v1',
    ...overrides,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
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

/** Fake turnBridge for one dispatched item: waits for the real spawnTurn event,
 * then hands off to the stub agent + a manual turnComplete call. */
async function dispatchAndSettle(
  h: AgentHarness,
  scheduler: LaneScheduler,
  params: DispatchItemParams,
  mode: string,
): Promise<{ dispatch: DispatchItemResult; settled: ItemSettledResult }> {
  const events: TeamEvent[] = [];
  const unsubEvents = h.subscribe((e) => events.push(e));
  const settledPromise = waitForSettled(scheduler, params.itemId);
  const dispatch = await scheduler.dispatchItem(params);
  if (dispatch.status !== 'RUNNING' || dispatch.turnId === undefined) {
    unsubEvents();
    throw new Error(`expected RUNNING, got ${dispatch.status} (${dispatch.reason ?? ''})`);
  }
  // Let the async spec-build -> spawnTurn microtask chain flush.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const spawn = events.find((e) => e.kind === 'spawnTurn' && e.turnId === dispatch.turnId);
  unsubEvents();
  if (!spawn || spawn.kind !== 'spawnTurn') throw new Error(`no spawnTurn event observed for turn ${dispatch.turnId}`);
  const stub = await runStubAgent(dispatch.itemRunDir, mode);
  h.workflow.turnComplete(dispatch.turnId, { exitCode: stub.exitCode });
  const settled = await settledPromise;
  return { dispatch, settled };
}

let dir: string;
let harness: AgentHarness;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wr-pipeline-'));
  harness = await createAgentHarness({ dataDir: dir, defaultProjectRoot: dir });
});

afterEach(() => {
  harness.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe('LaneScheduler — commit rule + clone lifecycle', () => {
  test('stages companion source files outside the compact JSON envelope', async () => {
    const scheduler = harness.pipeline.scheduler;
    const sourceText = '# Source\n\nMột dòng có thể được Read theo dòng.\n';
    const { dispatch, settled } = await dispatchAndSettle(
      harness,
      scheduler,
      baseParams({
        itemId: 'item-companion-input',
        envelope: { sourcePack: { contentFile: 'input/source-pack.md' } },
        inputFiles: [{ path: 'source-pack.md', content: sourceText }],
      }),
      'ok',
    );

    expect(settled.outcome).toBe('COMMITTED');
    expect(await readFile(join(dispatch.itemRunDir, 'input', 'source-pack.md'), 'utf8')).toBe(sourceText);
    const envelope = JSON.parse(await readFile(join(dispatch.itemRunDir, 'input', 'envelope.json'), 'utf8'));
    expect(envelope).toEqual({ sourcePack: { contentFile: 'input/source-pack.md' } });
    expect(JSON.stringify(envelope)).not.toContain(sourceText.trim());
  });

  test('happy path: ok stub commits artifact, reaps clone', async () => {
    const scheduler = harness.pipeline.scheduler;
    const { dispatch, settled } = await dispatchAndSettle(harness, scheduler, baseParams(), 'ok');

    expect(settled.outcome).toBe('COMMITTED');
    expect(settled.artifactHash).toBeTruthy();

    const manifestRaw = await readFile(join(dispatch.itemRunDir, 'item-manifest.json'), 'utf8');
    const manifest = JSON.parse(manifestRaw) as { hash: string; stage: string; version: number };
    expect(manifest.hash).toBe(settled.artifactHash as string);
    expect(manifest.stage).toBe(STAGE);
    expect(manifest.version).toBe(1);

    // Clone is reaped: no ephemeral agent left, and GET-style filtering would show none.
    expect(harness.listAgents().some((a) => a.ephemeral)).toBe(false);

    const row = harness.pipeline.ledger.all().find((r) => r.itemId === 'item-1' && r.stage === STAGE);
    expect(row?.status).toBe('terminal');
    expect(row?.outcome).toBe('COMMITTED');
  });

  test('exit-nonzero: FAILED AGENT_EXIT, no commit, clone still reaped', async () => {
    const scheduler = harness.pipeline.scheduler;
    const { dispatch, settled } = await dispatchAndSettle(harness, scheduler, baseParams({ itemId: 'item-2' }), 'exit-nonzero');

    expect(settled.outcome).toBe('FAILED');
    expect(settled.errorCode).toBe('AGENT_EXIT');
    expect(await exists(join(dispatch.itemRunDir, 'item-manifest.json'))).toBe(false);
    expect(harness.listAgents().some((a) => a.ephemeral)).toBe(false);
  });

  test('no-output: FAILED AGENT_NO_OUTPUT', async () => {
    const scheduler = harness.pipeline.scheduler;
    const { settled } = await dispatchAndSettle(harness, scheduler, baseParams({ itemId: 'item-3' }), 'no-output');
    expect(settled.outcome).toBe('FAILED');
    expect(settled.errorCode).toBe('AGENT_NO_OUTPUT');
  });

  test('bad-schema: FAILED AGENT_SCHEMA', async () => {
    const scheduler = harness.pipeline.scheduler;
    const { settled } = await dispatchAndSettle(harness, scheduler, baseParams({ itemId: 'item-4' }), 'bad-schema');
    expect(settled.outcome).toBe('FAILED');
    expect(settled.errorCode).toBe('AGENT_SCHEMA');
  });

  test('write-outside: FAILED AGENT_SANDBOX_VIOLATION (tree-diff actually catches it)', async () => {
    const scheduler = harness.pipeline.scheduler;
    const { dispatch, settled } = await dispatchAndSettle(harness, scheduler, baseParams({ itemId: 'item-5' }), 'write-outside');
    expect(settled.outcome).toBe('FAILED');
    expect(settled.errorCode).toBe('AGENT_SANDBOX_VIOLATION');
    // The stub really did escape — prove the fixture, not just the detector's opinion.
    expect(await exists(join(dispatch.itemRunDir, '..', 'escaped.txt'))).toBe(true);
    expect(await exists(join(dispatch.itemRunDir, 'item-manifest.json'))).toBe(false);
  });

  test('write-in-cwd: COMMITTED — a file inside the turn\'s own stage dir (outside out/) is not a violation', async () => {
    // §5.7 regression guard: real Grok Build turns write `.grok/config.toml` into
    // their own cwd (daemon-owned MCP wiring, not agent misbehavior — Grok has no
    // `--mcp-config` flag). That is contained within `{stage}/`, unlike `write-outside`
    // above which escapes it — must COMMIT, not fail AGENT_SANDBOX_VIOLATION.
    const scheduler = harness.pipeline.scheduler;
    const { dispatch, settled } = await dispatchAndSettle(harness, scheduler, baseParams({ itemId: 'item-6' }), 'write-in-cwd');
    expect(settled.outcome).toBe('COMMITTED');
    expect(await exists(join(dispatch.itemRunDir, '.grok', 'config.toml'))).toBe(true);
    expect(await exists(join(dispatch.itemRunDir, 'item-manifest.json'))).toBe(true);
  });
});

describe('LaneScheduler — content-retry on validateContent rejection (2026-08-10)', () => {
  /** Drives a dispatch through however many rounds it actually takes (1 + retries),
   * completing every new `spawnTurn` with the stub agent until `onItemSettled`
   * finally fires — unlike `dispatchAndSettle` above, which assumes exactly one
   * round. Every round reuses the SAME `itemRunDir` (retries keep the same
   * `attempt`), so one stub invocation per round against that same dir is correct. */
  async function dispatchThroughRetries(
    h: AgentHarness,
    scheduler: LaneScheduler,
    params: DispatchItemParams,
    mode: string,
  ): Promise<{ settled: ItemSettledResult; rounds: number; itemRunDir: string }> {
    const handled = new Set<number>();
    let rounds = 0;
    let settled: ItemSettledResult | undefined;
    const unsubSettled = scheduler.onItemSettled((r) => {
      if (r.itemId === params.itemId) settled = r;
    });
    const events: TeamEvent[] = [];
    const unsubEvents = h.subscribe((e) => events.push(e));

    const dispatch = await scheduler.dispatchItem(params);
    if (dispatch.status !== 'RUNNING' || dispatch.turnId === undefined) {
      unsubEvents(); unsubSettled();
      throw new Error(`expected RUNNING, got ${dispatch.status} (${dispatch.reason ?? ''})`);
    }

    for (let guard = 0; guard < 20 && !settled; guard++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const spawn = events.find((e) => e.kind === 'spawnTurn' && !handled.has(e.turnId));
      if (spawn && spawn.kind === 'spawnTurn') {
        handled.add(spawn.turnId);
        rounds += 1;
        const stub = await runStubAgent(dispatch.itemRunDir, mode);
        h.workflow.turnComplete(spawn.turnId, { exitCode: stub.exitCode });
      }
    }
    unsubEvents(); unsubSettled();
    if (!settled) throw new Error('never settled within guard rounds');
    return { settled, rounds, itemRunDir: dispatch.itemRunDir };
  }

  test('rejects once then accepts: auto-retries with correction, COMMITTED, exactly one onItemSettled', async () => {
    const scheduler = harness.pipeline.scheduler;
    let calls = 0;
    const params = baseParams({
      itemId: 'item-retry-ok',
      validateContent: () => {
        calls += 1;
        if (calls === 1) return { ok: false, errorCode: 'AGENT_UNGROUNDED', reason: 'quote not found in transcript' };
        return { ok: true };
      },
    });
    const { settled, rounds, itemRunDir } = await dispatchThroughRetries(harness, scheduler, params, 'ok');

    expect(rounds).toBe(2); // 1 rejected + 1 corrected retry
    expect(calls).toBe(2);
    expect(settled.outcome).toBe('COMMITTED');

    // The FIRST attempt's own ledger row is terminal/FAILED (accurate bookkeeping)...
    const rows = harness.pipeline.ledger.all().filter((r) => r.itemId === 'item-retry-ok');
    expect(rows.some((r) => r.outcome === 'FAILED' && r.errorCode === 'AGENT_UNGROUNDED')).toBe(true);
    // ...but only the retry's COMMITTED becomes the final artifact.
    expect(await exists(join(itemRunDir, 'item-manifest.json'))).toBe(true);
  });

  test('exhausts retries (maxContentRetries: 1) then FAILs for real — exactly one onItemSettled', async () => {
    const scheduler = harness.pipeline.scheduler;
    let calls = 0;
    const params = baseParams({
      itemId: 'item-retry-exhausted',
      maxContentRetries: 1,
      validateContent: () => {
        calls += 1;
        return { ok: false, errorCode: 'AGENT_UNGROUNDED', reason: `still wrong (call ${calls})` };
      },
    });
    const { settled, rounds } = await dispatchThroughRetries(harness, scheduler, params, 'ok');

    expect(rounds).toBe(2); // 1 original + 1 retry (maxContentRetries: 1), then give up
    expect(calls).toBe(2);
    expect(settled.outcome).toBe('FAILED');
    expect(settled.errorCode).toBe('AGENT_UNGROUNDED');
  });

  test('maxContentRetries: 0 preserves the old fail-immediately behavior', async () => {
    const scheduler = harness.pipeline.scheduler;
    let calls = 0;
    const params = baseParams({
      itemId: 'item-retry-disabled',
      maxContentRetries: 0,
      validateContent: () => {
        calls += 1;
        return { ok: false, errorCode: 'AGENT_UNGROUNDED', reason: 'nope' };
      },
    });
    const { settled, rounds } = await dispatchThroughRetries(harness, scheduler, params, 'ok');

    expect(rounds).toBe(1);
    expect(calls).toBe(1);
    expect(settled.outcome).toBe('FAILED');
  });
});

describe('LaneScheduler — lane admission (GAP-3 / backpressure)', () => {
  test('two different items dispatch concurrently under maxParallel=2: distinct turns/clones, no merge', async () => {
    const scheduler = new LaneScheduler({
      agents: harness.agents, workflow: harness.workflow, ledger: harness.pipeline.ledger, dataDir: dir, maxParallel: 2,
    });
    try {
      const events: TeamEvent[] = [];
      const unsub = harness.subscribe((e) => events.push(e));

      const [resultA, resultB] = await Promise.all([
        scheduler.dispatchItem(baseParams({ itemId: 'item-a' })),
        scheduler.dispatchItem(baseParams({ itemId: 'item-b' })),
      ]);

      expect(resultA.status).toBe('RUNNING');
      expect(resultB.status).toBe('RUNNING');
      expect(resultA.turnId).toBeDefined();
      expect(resultB.turnId).toBeDefined();
      expect(resultA.turnId).not.toBe(resultB.turnId);

      // Both clones existed simultaneously in agents.list() before either settled —
      // proves GAP-3 (queued-turn dedup only collides within one agent id) is moot
      // here because each item got its own clone id.
      const ephemeralIds = harness.listAgents().filter((a) => a.ephemeral).map((a) => a.id);
      expect(ephemeralIds.length).toBe(2);
      expect(new Set(ephemeralIds).size).toBe(2);

      await new Promise((resolve) => setTimeout(resolve, 0));
      unsub();
      const spawnTurnIds = new Set(
        events.filter((e) => e.kind === 'spawnTurn').map((e) => (e as { turnId: number }).turnId),
      );
      expect(spawnTurnIds.size).toBe(2); // never merged into one turn

      const settledA = waitForSettled(scheduler, 'item-a');
      const settledB = waitForSettled(scheduler, 'item-b');
      const stubA = await runStubAgent(resultA.itemRunDir, 'ok');
      harness.workflow.turnComplete(resultA.turnId!, { exitCode: stubA.exitCode });
      const stubB = await runStubAgent(resultB.itemRunDir, 'ok');
      harness.workflow.turnComplete(resultB.turnId!, { exitCode: stubB.exitCode });
      const [sa, sb] = await Promise.all([settledA, settledB]);
      expect(sa.outcome).toBe('COMMITTED');
      expect(sb.outcome).toBe('COMMITTED');
      expect(harness.listAgents().some((a) => a.ephemeral)).toBe(false);
    } finally {
      scheduler.dispose();
    }
  });

  test('maxParallel=1: second item WAITING_LANE (never FAILED), first item unaffected', async () => {
    const scheduler = new LaneScheduler({
      agents: harness.agents, workflow: harness.workflow, ledger: harness.pipeline.ledger, dataDir: dir, maxParallel: 1,
    });
    try {
      const resultA = await scheduler.dispatchItem(baseParams({ itemId: 'item-a1' }));
      expect(resultA.status).toBe('RUNNING');
      expect(scheduler.getLiveCloneCount()).toBe(1);

      const resultB = await scheduler.dispatchItem(baseParams({ itemId: 'item-b1' }));
      expect(resultB.status).toBe('WAITING_LANE');
      expect(resultB.reason).toBe('LANE_BUSY');
      expect(resultB.turnId).toBeUndefined();

      // First item's dispatch is unaffected: still occupies the one lane, still settles normally.
      expect(scheduler.getLiveCloneCount()).toBe(1);
      const settledA = waitForSettled(scheduler, 'item-a1');
      const stubA = await runStubAgent(resultA.itemRunDir, 'ok');
      harness.workflow.turnComplete(resultA.turnId!, { exitCode: stubA.exitCode });
      const sa = await settledA;
      expect(sa.outcome).toBe('COMMITTED');
      expect(scheduler.getLiveCloneCount()).toBe(0);
    } finally {
      scheduler.dispose();
    }
  });
});

describe('LaneScheduler — idempotent dispatch (turn_key dedup, §6.6 step 2)', () => {
  test('re-dispatching identical params before settling returns the same turnId, no second clone/row', async () => {
    const scheduler = harness.pipeline.scheduler;
    const params = baseParams({ itemId: 'item-dup' });

    const first = await scheduler.dispatchItem(params);
    expect(first.status).toBe('RUNNING');
    expect(first.turnId).toBeDefined();

    const second = await scheduler.dispatchItem(params);
    expect(second.status).toBe('RUNNING');
    expect(second.turnId).toBe(first.turnId);

    // Only one clone acquired for this item.
    const ephemeralForItem = harness.listAgents().filter((a) => a.ephemeral && a.name.endsWith('· item-dup'));
    expect(ephemeralForItem.length).toBe(1);

    // Only one ledger row for this (itemId, stage, attempt).
    const rows = harness.pipeline.ledger.all().filter((r) => r.itemId === 'item-dup' && r.stage === STAGE && r.attempt === 1);
    expect(rows.length).toBe(1);

    // Clean up: settle it so the harness doesn't leak a running turn/clone.
    const settled = waitForSettled(scheduler, 'item-dup');
    const stub = await runStubAgent(first.itemRunDir, 'ok');
    harness.workflow.turnComplete(first.turnId!, { exitCode: stub.exitCode });
    await settled;
  });
});
