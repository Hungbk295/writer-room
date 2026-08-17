/**
 * Formula Studio SYNTHESIZE (SDD §12b, ADR-13, P3) orchestrator tests — same
 * fake-bridge pattern as `training-lab.test.ts`: the SYNTHESIZE turn dispatches
 * through the REAL `LaneScheduler`/`TeamWorkflow`, and the test hand-writes
 * `out/result.json` + calls `workflow.turnComplete(turnId, ...)` to stand in for the
 * turnBridge. Everything downstream — commit rule, `validateContent`, and
 * `studio-synthesize.ts`'s settle handler (unknown-clusterId skip, empty-statement
 * rejection via `validateCompoundRule`, proposal creation) — is real production code.
 * No token spent.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FormulaArtifact } from '@writer-room/training-core';
import { createAgentHarness, type AgentHarness } from '../../src/harness.ts';
import type { ItemSettledResult, LaneScheduler } from '../../src/pipeline/lane-scheduler.ts';
import type { PipelineLedgerRow } from '../../src/pipeline/ledger.ts';
import { getFormula, saveFormula } from '../../src/training/storage.ts';
import {
  applyProposalDecision,
  createStudioSession,
  getStudioSession,
  promoteCompound,
  rebuildCompound,
  recomputeClusters,
  saveStudioSession,
  type StudioSession,
} from '../../src/training/studio.ts';
import {
  registerStudioSynthesizeSettleListener,
  startStudioSynthesize,
  SYNTHESIZE_ITEM_ID,
  SYNTHESIZE_STAGE,
} from '../../src/training/studio-synthesize.ts';

let dir: string;
let harness: AgentHarness;
let turnLaunches: Map<number, { mode: string; interactiveRequired?: boolean; forceHeadless: boolean }>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wr-studio-synthesize-'));
  harness = await createAgentHarness({ dataDir: dir, defaultProjectRoot: dir });
  turnLaunches = new Map();
  harness.subscribe((event) => {
    if (event.kind === 'spawnTurn') {
      turnLaunches.set(event.turnId, {
        mode: event.spec.mode,
        interactiveRequired: event.interactiveRequired,
        forceHeadless: event.forceHeadless,
      });
    }
  });
  // Registered exactly once per test, mirroring the one-time `http.ts` registration.
  registerStudioSynthesizeSettleListener(harness.pipeline.scheduler, { dataDir: dir });
});

afterEach(() => {
  harness.dispose();
  rmSync(dir, { recursive: true, force: true });
});

function itemRunDir(batchId: string, attempt: number): string {
  return join(dir, 'workspaces', 'pipeline', batchId, SYNTHESIZE_ITEM_ID, 'attempts', String(attempt), SYNTHESIZE_STAGE);
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

async function waitForLedgerRow(batchId: string, attempt: number): Promise<PipelineLedgerRow> {
  const row = await waitUntil(
    () => harness.pipeline.ledger.all().find((r) =>
      r.batchId === batchId && r.itemId === SYNTHESIZE_ITEM_ID && r.stage === SYNTHESIZE_STAGE && r.attempt === attempt
    ),
    (r) => r !== undefined,
  );
  return row!;
}

function waitForSettled(scheduler: LaneScheduler, batchId: string, attempt: number): Promise<ItemSettledResult> {
  return new Promise((resolve) => {
    const unsub = scheduler.onItemSettled((r) => {
      if (r.batchId !== batchId || r.itemId !== SYNTHESIZE_ITEM_ID || r.stage !== SYNTHESIZE_STAGE || r.attempt !== attempt) return;
      unsub();
      resolve(r);
    });
  });
}

function formula(overrides: Partial<FormulaArtifact> & { id: string; videoSnapshotId: string }): FormulaArtifact {
  return {
    status: 'TRIAL',
    origin: 'ANALYZED',
    version: 1,
    channelTitle: 'Sói Tài Chính',
    rules: [
      {
        id: 'rule-1',
        statement: 'Mở bài bằng một câu chuyện cá nhân có số liệu cụ thể',
        evidence: [{ segmentIds: ['seg-1'], quote: 'hồi đó tôi kiếm được 3 triệu' }],
      },
    ],
    includedArtifacts: [],
    lineage: {},
    warnings: [],
    createdAt: '2026-08-10T00:00:00.000Z',
    ...overrides,
  };
}

/** Seeds a session with one SIMILAR cluster (2 near-duplicate rules across 2 videos)
 * and one SINGLE cluster (1 unrelated rule) — enough to exercise both cluster kinds
 * in one SYNTHESIZE turn, same as the brief's "SYNTHESIZE must handle every cluster,
 * SINGLE included" requirement. */
async function seedSessionWithTwoClusters(): Promise<StudioSession> {
  await saveFormula(
    formula({
      id: 'f1',
      videoSnapshotId: 'v1',
      rules: [
        {
          id: 'rule-1',
          statement: 'Mở bài bằng một câu chuyện cá nhân có số liệu cụ thể',
          evidence: [{ segmentIds: ['seg-1'], quote: 'hồi đó tôi kiếm được 3 triệu' }],
        },
        {
          id: 'rule-2',
          statement: 'Chốt bài bằng khung ba khái niệm đã đặt tên',
          evidence: [{ segmentIds: ['seg-2'], quote: 'ba thứ bạn cần nhớ' }],
        },
      ],
    }),
    dir,
  );
  await saveFormula(
    formula({
      id: 'f2',
      videoSnapshotId: 'v2',
      channelTitle: 'Kênh Khác',
      rules: [
        {
          id: 'rule-9',
          statement: 'Mở bài bằng câu chuyện cá nhân kèm số liệu cụ thể',
          evidence: [{ segmentIds: ['seg-7'], quote: 'lương tôi 45 triệu' }],
        },
      ],
    }),
    dir,
  );

  const session = await createStudioSession('kể chuyện tài chính cá nhân', dir);
  session.picks = [
    { formulaId: 'f1', ruleId: 'rule-1' }, // SIMILAR (with f2/rule-9)
    { formulaId: 'f2', ruleId: 'rule-9' }, // SIMILAR
    { formulaId: 'f1', ruleId: 'rule-2' }, // SINGLE
  ];
  await recomputeClusters(session, dir);
  await saveStudioSession(session, dir);
  expect(session.clusters.filter((c) => c.kind === 'SIMILAR')).toHaveLength(1);
  expect(session.clusters.filter((c) => c.kind === 'SINGLE')).toHaveLength(1);
  return session;
}

describe('startStudioSynthesize — happy path', () => {
  test('a valid proposals array becomes PENDING proposals for both the SIMILAR and SINGLE cluster', async () => {
    const session = await seedSessionWithTwoClusters();
    const similarCluster = session.clusters.find((c) => c.kind === 'SIMILAR')!;
    const singleCluster = session.clusters.find((c) => c.kind === 'SINGLE')!;

    const started = await startStudioSynthesize(
      { scheduler: harness.pipeline.scheduler, dataDir: dir },
      session,
      'grok',
    );
    expect(started.synthesizeStatus).toBe('RUNNING');
    expect(started.synthesizeAttempt).toBe(1);

    const row = await waitForLedgerRow(session.id, 1);
    const launch = await waitUntil(
      () => turnLaunches.get(Number(row.turnId)),
      (value) => value !== undefined,
    );
    expect(launch).toEqual({ mode: 'interactive', interactiveRequired: true, forceHeadless: false });
    const settled = waitForSettled(harness.pipeline.scheduler, session.id, 1);
    await Bun.write(
      join(itemRunDir(session.id, 1), 'out', 'result.json'),
      JSON.stringify({
        proposals: [
          {
            clusterId: similarCluster.id,
            instruction: 'Mở bài bằng câu chuyện thật, gắn một con số cụ thể',
            when: 'Bài mở đầu bằng trải nghiệm cá nhân',
            priority: 'CORE',
          },
          { clusterId: singleCluster.id, instruction: 'Chốt bài bằng một khung khái niệm đã đặt tên' },
        ],
      }),
    );
    harness.workflow.turnComplete(Number(row.turnId), { exitCode: 0 });
    await settled;

    const finalSession = await waitUntil(
      () => getStudioSession(session.id, dir),
      (s) => s?.synthesizeStatus === 'IDLE',
    );
    expect(finalSession!.proposals).toHaveLength(2);
    const bySimilar = finalSession!.proposals.find((p) => p.clusterId === similarCluster.id)!;
    expect(bySimilar.decision).toBe('PENDING');
    expect(bySimilar.instruction).toBe('Mở bài bằng câu chuyện thật, gắn một con số cụ thể');
    // `when`/`priority` come straight off the LLM output; a missing `priority` (the
    // SINGLE-cluster proposal above) must default to OPTIONAL, never CORE.
    expect(bySimilar.when).toBe('Bài mở đầu bằng trải nghiệm cá nhân');
    expect(bySimilar.priority).toBe('CORE');
    const bySingleDefaultPriority = finalSession!.proposals.find((p) => p.clusterId === singleCluster.id)!;
    expect(bySingleDefaultPriority.priority).toBe('OPTIONAL');
    expect(bySingleDefaultPriority.when).toBeUndefined();
    // Sources are app-derived from the cluster's own members, never taken from the
    // LLM's output — this is what ADR-13 means by "the LLM never commits provenance".
    expect(bySimilar.sources).toHaveLength(2);
    expect(new Set(bySimilar.sources.map((s) => s.videoSnapshotId))).toEqual(new Set(['v1', 'v2']));

    const bySingle = finalSession!.proposals.find((p) => p.clusterId === singleCluster.id)!;
    expect(bySingle.decision).toBe('PENDING');
    expect(bySingle.sources).toHaveLength(1);
  });

  test('an unknown clusterId is skipped (logged, no ghost proposal) while the other valid entries still land', async () => {
    const session = await seedSessionWithTwoClusters();
    const similarCluster = session.clusters.find((c) => c.kind === 'SIMILAR')!;

    await startStudioSynthesize({ scheduler: harness.pipeline.scheduler, dataDir: dir }, session, 'grok');
    const row = await waitForLedgerRow(session.id, 1);
    const settled = waitForSettled(harness.pipeline.scheduler, session.id, 1);
    await Bun.write(
      join(itemRunDir(session.id, 1), 'out', 'result.json'),
      JSON.stringify({
        proposals: [
          { clusterId: 'c-does-not-exist', instruction: 'Một câu đề xuất cho cụm không tồn tại' },
          { clusterId: similarCluster.id, instruction: 'Mở bài bằng câu chuyện thật, gắn một con số cụ thể' },
        ],
      }),
    );
    harness.workflow.turnComplete(Number(row.turnId), { exitCode: 0 });
    await settled;

    const finalSession = await waitUntil(
      () => getStudioSession(session.id, dir),
      (s) => s?.synthesizeStatus === 'IDLE',
    );
    // Exactly one real proposal — the unknown clusterId produced no entry at all.
    expect(finalSession!.proposals).toHaveLength(1);
    expect(finalSession!.proposals[0]!.clusterId).toBe(similarCluster.id);
  });

  test('a proposal with an empty instruction is rejected by validateCompoundRule (STUDIO_RULE_UNGROUNDED) and never becomes a proposal', async () => {
    const session = await seedSessionWithTwoClusters();
    const similarCluster = session.clusters.find((c) => c.kind === 'SIMILAR')!;
    const singleCluster = session.clusters.find((c) => c.kind === 'SINGLE')!;

    await startStudioSynthesize({ scheduler: harness.pipeline.scheduler, dataDir: dir }, session, 'grok');
    const row = await waitForLedgerRow(session.id, 1);
    const settled = waitForSettled(harness.pipeline.scheduler, session.id, 1);
    await Bun.write(
      join(itemRunDir(session.id, 1), 'out', 'result.json'),
      JSON.stringify({
        proposals: [
          { clusterId: similarCluster.id, instruction: '   ' }, // whitespace-only, rejected
          { clusterId: singleCluster.id, instruction: 'Chốt bài bằng một khung khái niệm đã đặt tên' },
        ],
      }),
    );
    harness.workflow.turnComplete(Number(row.turnId), { exitCode: 0 });
    await settled;

    const finalSession = await waitUntil(
      () => getStudioSession(session.id, dir),
      (s) => s?.synthesizeStatus === 'IDLE',
    );
    expect(finalSession!.proposals).toHaveLength(1);
    expect(finalSession!.proposals[0]!.clusterId).toBe(singleCluster.id);
  });

  test('re-running SYNTHESIZE never clobbers an existing proposal, even a PENDING one from an earlier attempt', async () => {
    const session = await seedSessionWithTwoClusters();
    const similarCluster = session.clusters.find((c) => c.kind === 'SIMILAR')!;
    const singleCluster = session.clusters.find((c) => c.kind === 'SINGLE')!;

    // Attempt 1: only the SIMILAR cluster gets a proposal (simulates the model
    // dropping the SINGLE cluster's entry the first time around).
    await startStudioSynthesize({ scheduler: harness.pipeline.scheduler, dataDir: dir }, session, 'grok');
    const row1 = await waitForLedgerRow(session.id, 1);
    const settled1 = waitForSettled(harness.pipeline.scheduler, session.id, 1);
    await Bun.write(
      join(itemRunDir(session.id, 1), 'out', 'result.json'),
      JSON.stringify({ proposals: [{ clusterId: similarCluster.id, instruction: 'Đề xuất lượt 1' }] }),
    );
    harness.workflow.turnComplete(Number(row1.turnId), { exitCode: 0 });
    await settled1;
    const afterFirst = await waitUntil(
      () => getStudioSession(session.id, dir),
      (s) => s?.synthesizeStatus === 'IDLE',
    );
    expect(afterFirst!.proposals).toHaveLength(1);

    // Attempt 2: the model this time proposes BOTH — the SIMILAR one must be ignored
    // (a real proposal already exists for it, even though it is still PENDING).
    const started2 = await startStudioSynthesize({ scheduler: harness.pipeline.scheduler, dataDir: dir }, afterFirst!, 'grok');
    expect(started2.synthesizeAttempt).toBe(2);
    const row2 = await waitForLedgerRow(session.id, 2);
    const settled2 = waitForSettled(harness.pipeline.scheduler, session.id, 2);
    await Bun.write(
      join(itemRunDir(session.id, 2), 'out', 'result.json'),
      JSON.stringify({
        proposals: [
          { clusterId: similarCluster.id, instruction: 'Đề xuất lượt 2 — không được ghi đè' },
          { clusterId: singleCluster.id, instruction: 'Chốt bài bằng một khung khái niệm đã đặt tên' },
        ],
      }),
    );
    harness.workflow.turnComplete(Number(row2.turnId), { exitCode: 0 });
    await settled2;

    const finalSession = await waitUntil(
      () => getStudioSession(session.id, dir),
      (s) => s?.synthesizeAttempt === 2 && s?.synthesizeStatus === 'IDLE',
    );
    expect(finalSession!.proposals).toHaveLength(2);
    const bySimilar = finalSession!.proposals.find((p) => p.clusterId === similarCluster.id)!;
    expect(bySimilar.instruction).toBe('Đề xuất lượt 1'); // untouched by attempt 2
  });
});

describe('end-to-end: synthesize -> decide -> rebuildCompound -> promote', () => {
  test('accept / edit-then-accept / reject each land in the compound with the right mergeOrigin (or not at all)', async () => {
    await saveFormula(
      formula({
        id: 'f1', videoSnapshotId: 'v1', rules: [
          { id: 'rule-1', statement: 'Mở bài bằng một câu hỏi trực tiếp', evidence: [{ segmentIds: ['s1'], quote: 'q1' }] },
          { id: 'rule-2', statement: 'Chốt bài bằng lời kêu gọi hành động', evidence: [{ segmentIds: ['s2'], quote: 'q2' }] },
          { id: 'rule-3', statement: 'Dùng phép so sánh để giải thích khái niệm khó', evidence: [{ segmentIds: ['s3'], quote: 'q3' }] },
        ],
      }),
      dir,
    );
    const session = await createStudioSession('thể loại đa dạng', dir);
    session.picks = [
      { formulaId: 'f1', ruleId: 'rule-1' },
      { formulaId: 'f1', ruleId: 'rule-2' },
      { formulaId: 'f1', ruleId: 'rule-3' },
    ];
    await recomputeClusters(session, dir);
    expect(session.clusters).toHaveLength(3); // all SINGLE, nothing resembles anything else

    await startStudioSynthesize({ scheduler: harness.pipeline.scheduler, dataDir: dir }, session, 'grok');
    const row = await waitForLedgerRow(session.id, 1);
    const settled = waitForSettled(harness.pipeline.scheduler, session.id, 1);
    await Bun.write(
      join(itemRunDir(session.id, 1), 'out', 'result.json'),
      JSON.stringify({
        proposals: session.clusters.map((c, i) => ({ clusterId: c.id, instruction: `Đề xuất chung chung ${i + 1}` })),
      }),
    );
    harness.workflow.turnComplete(Number(row.turnId), { exitCode: 0 });
    await settled;

    let finalSession = (await waitUntil(
      () => getStudioSession(session.id, dir),
      (s) => s?.proposals.length === 3,
    ))!;

    const [acceptMe, editMe, rejectMe] = finalSession.proposals;
    applyProposalDecision(finalSession, acceptMe!.id, 'ACCEPTED');
    applyProposalDecision(finalSession, editMe!.id, 'ACCEPTED', { instruction: 'Câu chữ do người dùng viết lại' });
    applyProposalDecision(finalSession, rejectMe!.id, 'REJECTED');
    await rebuildCompound(finalSession, dir);
    await saveStudioSession(finalSession, dir);

    expect(finalSession.compound!.rules).toHaveLength(2); // reject stays out
    const accepted = finalSession.compound!.rules.find((r) => r.id === acceptMe!.id)!;
    expect(accepted.mergeOrigin).toBe('SYNTHESIZED');
    const edited = finalSession.compound!.rules.find((r) => r.id === editMe!.id)!;
    expect(edited.mergeOrigin).toBe('HUMAN_EDITED');
    expect(edited.statement).toBe('Câu chữ do người dùng viết lại');
    expect(finalSession.compound!.rules.some((r) => r.id === rejectMe!.id)).toBe(false);

    const promoted = await promoteCompound(finalSession, dir);
    await saveStudioSession(promoted, dir);
    const stored = await getFormula(promoted.compound!.id, dir);
    expect(stored!.status).toBe('TRIAL');
    expect(stored!.rules).toHaveLength(2);
  });
});
