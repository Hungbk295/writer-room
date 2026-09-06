/**
 * Write Loop v2 — Phase 3 + Phase 4 acceptance.
 *
 * Same fake-bridge pattern as `training-lab.test.ts`: every stage dispatches a REAL
 * turn through the real `LaneScheduler`/`TeamWorkflow`; the test hand-writes
 * `out/result.json` and calls `workflow.turnComplete()`. The settle machine,
 * validators and the deterministic gate are all production code.
 *
 * The headline case is the last one: a script shaped like run `86de3ca5` (an
 * invented character with invented numbers) must never reach `DONE`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FormulaArtifact } from '@writer-room/training-core';
import { createAgentHarness, type AgentHarness } from '../../src/harness.ts';
import type { DispatchItemParams, ItemSettledResult, LaneScheduler } from '../../src/pipeline/lane-scheduler.ts';
import type { PipelineLedgerRow } from '../../src/pipeline/ledger.ts';
import { listJobNotifications } from '../../src/notifications.ts';
import { saveFormula } from '../../src/training/storage.ts';
import { createWriterPack } from '../../src/writer-packs.ts';
import {
  HOOK_CLARIFY_STAGE,
  HOOK_SUGGEST_STAGE,
  recoverInterruptedHooks,
  registerWriterV2HookListener,
  selectHook,
  startHookClarify,
  startHookSuggest,
} from '../../src/writer/hook-board.ts';
import { getWriterRunV2, listWriterRunsV2, saveWriterRunV2 } from '../../src/writer/run-store-v2.ts';
import { filterApprovedPersonaMarkdown } from '../../src/writer/assertion-boundary.ts';
import { createChannelProfile, listEditorialSuggestions, updateChannelProfile } from '../../src/writer/channel-profile.ts';
import { createReusableProcedure } from '../../src/writer/reusable-procedure.ts';
import { hashPersonaPack } from '../../src/writer/persona-pack.ts';
import {
  computeWriterV2Progress,
  createWriterPostV2,
  createWriterRoomV2,
  continueWriterRunV2,
  EDIT_REVIEW_STAGE,
  evaluateWriterDraftVerdict,
  readStyledVersion,
  recoverInterruptedRestyles,
  recoverInterruptedWriterRuns,
  POSTMORTEM_STAGE,
  recoverInterruptedPostmortems,
  REPAIR_STAGE,
  registerWriterV2PostmortemListener,
  registerWriterV2RestyleListener,
  registerWriterV2SettleListener,
  runWriterRoomV2,
  RESTYLE_STAGE,
  startRestyle,
  startWriterPostmortem,
  startWriterRunV2,
  STUDY_STAGE,
  splitExactSourceParts,
  validateEditorReview,
  validateStudyArtifact,
  validateWriterV2Draft,
  validatePostmortem,
  updateWriterPostV2,
  WRITE_STAGE,
  WRITER_V2_ITEM_ID,
} from '../../src/writer/writer-run-v2.ts';

let dir: string;
let harness: AgentHarness;
let turnLaunches: Map<number, { mode: string; interactiveRequired?: boolean; forceHeadless: boolean }>;
let turnAgents: Map<number, string>;
let stageAgents: Map<string, string>;
/** Every `dispatchItem` call the production code made this test, in order. Lets a
 * test assert on the dispatch *parameters* (call budget, context isolation), which
 * the ledger and the settle events do not carry. */
let dispatches: DispatchItemParams[];

const VIDEO_ID = 'PJPhR58LBYA';
const PACK_QUOTE = 'nguyên tắc chi tiêu chỉ có ý nghĩa khi bạn biết mình đang trả cho cái gì';
const PACK_QUOTE_2 = 'phần lớn người đi làm chưa từng tính tổng các khoản cố định của mình';
const PACK_QUOTE_3 = 'tự do tài chính cần khoảng 25 lần chi phí sinh hoạt một năm';
const PACK_MARKDOWN = [
  '# Source Pack — UNTRUSTED REFERENCE MATERIAL',
  '',
  '## 9 nguyên tắc chi tiêu',
  '',
  `- videoId: \`${VIDEO_ID}\``,
  '',
  '### Transcript',
  '',
  `${PACK_QUOTE}. ${PACK_QUOTE_2}. ${PACK_QUOTE_3}.`,
].join('\n');

const STYLE_ID = 'nhan-vat-xuyen-suot.md';
const CHANNEL_STYLE = [
  '# Nhân vật xuyên suốt',
  '<!-- version: 2 -->',
  '',
  '## Ngôi kể',
  'Ngôi thứ hai, gọi khán giả là "bạn".',
  '',
  '## Nhân vật',
  'Một nhân vật hư cấu tên Vy đi xuyên suốt bài.',
].join('\n');

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wr-writer-v2-'));
  harness = await createAgentHarness({ dataDir: dir, defaultProjectRoot: dir });
  // Record dispatch parameters without changing behaviour: every call still runs
  // the real scheduler. The harness is rebuilt per test, so the patch dies with it.
  dispatches = [];
  const scheduler = harness.pipeline.scheduler;
  const realDispatchItem = scheduler.dispatchItem.bind(scheduler);
  scheduler.dispatchItem = (params: DispatchItemParams) => {
    dispatches.push(params);
    return realDispatchItem(params);
  };
  turnLaunches = new Map();
  turnAgents = new Map();
  stageAgents = new Map();
  harness.subscribe((event) => {
    if (event.kind === 'spawnTurn') {
      turnAgents.set(event.turnId, event.agentId);
      turnLaunches.set(event.turnId, {
        mode: event.spec.mode,
        interactiveRequired: event.interactiveRequired,
        forceHeadless: event.forceHeadless,
      });
    }
  });
  registerWriterV2SettleListener(harness.pipeline.scheduler, { dataDir: dir });
  registerWriterV2RestyleListener(harness.pipeline.scheduler, { dataDir: dir });
  registerWriterV2PostmortemListener(harness.pipeline.scheduler, { dataDir: dir });
  registerWriterV2HookListener(harness.pipeline.scheduler, { dataDir: dir });
  mkdirSync(join(dir, 'channel-styles'), { recursive: true });
  writeFileSync(join(dir, 'channel-styles', STYLE_ID), CHANNEL_STYLE, 'utf8');
  mkdirSync(join(dir, 'hook-libraries'), { recursive: true });
  writeFileSync(
    join(dir, 'hook-libraries', 'anh-ba-ong-chu.md'),
    '# Hook đối thủ\n<!-- version: 1 -->\n\nKhung crisis-by-hour, forked-paths, stat-open.\n',
    'utf8',
  );
  await createChannelProfile({
    id: 'finance',
    displayName: 'Kênh Tài chính',
    topic: 'Tài chính cá nhân',
  }, dir);
  mkdirSync(join(dir, 'general-packs'), { recursive: true });
  writeFileSync(
    join(dir, 'general-packs', 'hieu-tv.md'),
    [
      '# Hieu TV — Source Pack General',
      '<!-- version: 1 -->',
      '',
      '## TASTE DNA',
      '1. Chính sách cá nhân, lệch chuẩn có chủ đích.',
      '',
      '## Một video nào đó | 200k views | 20 phút',
      '- **Hook**: mở bằng một câu hỏi ngân sách',
      '- **Payoff**: trả lại đúng con số đã mở',
    ].join('\n'),
    'utf8',
  );
});

afterEach(() => {
  harness.dispose();
  rmSync(dir, { recursive: true, force: true });
});

function itemRunDir(batchId: string, stage: string, attempt = 1): string {
  return join(dir, 'workspaces', 'pipeline', batchId, WRITER_V2_ITEM_ID, 'attempts', String(attempt), stage);
}

async function waitUntil<T>(
  fn: () => Promise<T> | T,
  predicate: (value: T) => boolean,
  { timeoutMs = 4000, intervalMs = 10 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (predicate(value)) return value;
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function waitForLedgerRow(batchId: string, stage: string, attempt = 1): Promise<PipelineLedgerRow> {
  const row = await waitUntil(
    () => harness.pipeline.ledger.all().find((r) =>
      r.batchId === batchId && r.itemId === WRITER_V2_ITEM_ID && r.stage === stage && r.attempt === attempt
    ),
    (r) => r !== undefined,
  );
  return row!;
}

function waitForSettled(scheduler: LaneScheduler, stage: string, attempt = 1): Promise<ItemSettledResult> {
  return new Promise((resolve) => {
    const unsub = scheduler.onItemSettled((r) => {
      if (r.stage !== stage || r.attempt !== attempt) return;
      unsub();
      resolve(r);
    });
  });
}

/** Hand the pipeline a stage result and wait for it to settle. */
async function completeStage(
  runId: string,
  stage: string,
  result: unknown,
  attempt = 1,
): Promise<ItemSettledResult> {
  const row = await waitForLedgerRow(runId, stage, attempt);
  const launch = await waitUntil(
    () => turnLaunches.get(Number(row.turnId)),
    (value) => value !== undefined,
  );
  expect(launch).toEqual({ mode: 'interactive', interactiveRequired: true, forceHeadless: false });
  stageAgents.set(`${runId}:${stage}`, turnAgents.get(Number(row.turnId))!);
  await Bun.write(join(itemRunDir(runId, stage, attempt), 'out', 'result.json'), JSON.stringify(result));
  const settled = waitForSettled(harness.pipeline.scheduler, stage, attempt);
  harness.workflow.turnComplete(Number(row.turnId), { exitCode: 0 });
  return settled;
}

function makeFormula(): FormulaArtifact {
  return {
    id: 'formula-v2-test',
    status: 'TRIAL',
    origin: 'ANALYZED',
    version: 3,
    channelTitle: 'Hieu Nguyen',
    videoSnapshotId: 'snap-1',
    rules: [
      { id: 'rule-1', statement: 'Mở bằng một con số có nguồn.', evidence: [] },
      { id: 'rule-2', role: 'payoff', statement: 'Kết bằng đúng con số đã mở.', evidence: [] },
    ],
    includedArtifacts: [],
    lineage: {},
    warnings: [],
    createdAt: '2026-08-14T00:00:00.000Z',
  } as FormulaArtifact;
}

const OUTLINE = {
  coreInsight: 'Chi phí cố định quyết định quyền lựa chọn, không phải mức lương',
  memoryAnchor: { kind: 'contrast' as const, value: 'lương tăng vs quyền chọn giảm' },
  progression: [
    { beat: 'mở', newInformation: 'đặt câu hỏi ngân sách', characterOrArgumentChange: 'a', visualAnchor: 'b' },
    { beat: 'giữa', newInformation: 'cố định phình', characterOrArgumentChange: 'c', visualAnchor: 'd' },
  ],
  endingPayoff: { resolvesOpening: 'quay lại câu hỏi mở', audienceCanDo: 'trừ nghĩa vụ khỏi thu nhập' },
  cutList: ['mẹo đầu tư'],
};

const STUDY_RESULT = {
  coverageMap: [{ videoId: VIDEO_ID, mainClaim: 'các nguyên tắc chi tiêu', angle: 'nguyên tắc' }],
  gap: 'chưa video nào nói về việc mất quyền lựa chọn khi chi phí cố định phình',
  outline: OUTLINE,
  factsLedger: [
    { fact: 'nguyên tắc chi tiêu gắn với việc biết mình trả cho cái gì', videoId: VIDEO_ID, quote: PACK_QUOTE },
    { fact: 'ít người tính tổng khoản cố định', videoId: VIDEO_ID, quote: PACK_QUOTE_2 },
    { fact: 'mốc 25 lần chi phí năm', videoId: VIDEO_ID, quote: PACK_QUOTE_3 },
  ],
};

const ANCHOR_1 = 'Bạn có bao giờ ngồi tính tổng các khoản cố định của mình chưa?';
const ANCHOR_2 = 'Phần cố định phình lên là chỗ quyền lựa chọn biến mất.';

/** A clean script: no digits, no invented names, both anchors verbatim, in band. */
function cleanScript(): string {
  const filler = Array.from({ length: 850 }, (_, i) => `từ${i}`).join(' ');
  return `${ANCHOR_1} ${ANCHOR_2} ${filler}`;
}

/** A script shaped like run 86de3ca5: an invented character with invented numbers. */
function fabricatedScript(): string {
  const filler = Array.from({ length: 840 }, (_, i) => `từ${i}`).join(' ');
  return [
    ANCHOR_1,
    'Chín giờ tối, Minh nhìn số dư 380.000 đồng trong ứng dụng ngân hàng.',
    ANCHOR_2,
    filler,
  ].join(' ');
}

async function startRun(): Promise<string> {
  const pack = await createWriterPack(
    { title: 'Hieu pack', markdown: PACK_MARKDOWN, videoIds: [VIDEO_ID], channelTitle: 'Hieu Nguyen' },
    dir,
  );
  await saveFormula(makeFormula(), dir);
  const run = await startWriterRunV2(
    { scheduler: harness.pipeline.scheduler, dataDir: dir },
    {
      channelId: 'finance',
      brief: 'Vì sao lương tăng mà vẫn hết tiền',
      title: 'Lương tăng, quyền chọn giảm',
      packId: pack.id,
      generalPack: 'hieu-tv.md',
      formulaId: 'formula-v2-test',
      agentId: 'codex',
    },
  );
  expect(run.status).toBe('RUNNING');
  expect(run.phase).toBe('STUDY');
  // The general pack is pinned by content hash, and the editor is not the writer.
  expect(run.generalPackHash).toHaveLength(64);
  expect(run.generalPackVersion).toBe(1);
  expect(run.channelId).toBe('finance');
  expect(run.editorialHash).toHaveLength(64);
  expect(run.editorAgentId).not.toBe(run.agentId);
  return run.id;
}

describe('Writer v2 post — create, configure, review, then explicit run', () => {
  async function fixtures(): Promise<{ packId: string }> {
    const pack = await createWriterPack(
      { title: 'Room pack', markdown: PACK_MARKDOWN, videoIds: [VIDEO_ID], channelTitle: 'Evidence' }, dir,
    );
    await saveFormula(makeFormula(), dir);
    return { packId: pack.id };
  }

  test('creates a blank DRAFT post without a clone or turn', async () => {
    const post = await createWriterPostV2(
      { scheduler: harness.pipeline.scheduler, dataDir: dir },
    );
    expect(post.status).toBe('DRAFT');
    expect(post.phase).toBe('CONFIGURING');
    expect(post.brief).toBe('');
    expect(post.packId).toBe('');
    expect(harness.pipeline.scheduler.getLiveCloneCount()).toBe(0);
    expect(harness.workflow.status().totalTurns).toBe(0);
  });

  test('saves and reloads the exact pinned configuration without dispatching', async () => {
    const { packId } = await fixtures();
    const post = await createWriterPostV2(
      { scheduler: harness.pipeline.scheduler, dataDir: dir },
    );
    const saved = await updateWriterPostV2(
      { scheduler: harness.pipeline.scheduler, dataDir: dir }, post.id,
      {
        channelId: 'finance',
        brief: 'Kiểm tra post trước khi chạy', title: 'Một title đã chuẩn bị',
        audience: 'Người đi làm', targetWords: 1_234,
        packId, generalPack: 'hieu-tv.md', formulaId: 'formula-v2-test',
        agentId: 'codex', editorAgentId: 'claude',
      },
    );
    expect(saved.status).toBe('DRAFT');
    expect(saved.phase).toBe('READY');
    expect(saved.requestedTitle).toBe('Một title đã chuẩn bị');
    expect(saved.audience).toBe('Người đi làm');
    expect(saved.targetWords).toBe(1_234);
    expect(saved.packId).toBe(packId);
    expect(saved.packHash).toHaveLength(64);
    expect(saved.generalPackPath).toBe('hieu-tv.md');
    expect(saved.generalPackHash).toHaveLength(64);
    expect(saved.generalPackVersion).toBe(1);
    expect(saved.formulaId).toBe('formula-v2-test');
    expect(saved.formulaVersion).toBe(3);
    expect(saved.formulaHash).toHaveLength(64);
    expect((await getWriterRunV2(post.id, dir))).toEqual(saved);
    const listed = (await listWriterRunsV2(dir)).find((item) => item.id === post.id);
    expect(listed?.audience).toBe('Người đi làm');
    expect(listed?.packHash).toBe(saved.packHash);
    expect(listed?.generalPackHash).toBe(saved.generalPackHash);
    expect(listed?.formulaHash).toBe(saved.formulaHash);
    expect(harness.pipeline.scheduler.getLiveCloneCount()).toBe(0);
    expect(harness.workflow.status().totalTurns).toBe(0);
  });

  test('rejects Run for incomplete config without dispatching', async () => {
    const post = await createWriterPostV2(
      { scheduler: harness.pipeline.scheduler, dataDir: dir },
    );
    await updateWriterPostV2(
      { scheduler: harness.pipeline.scheduler, dataDir: dir }, post.id,
      {
        channelId: 'finance',
        brief: 'Có brief nhưng thiếu pack', packId: '', generalPack: '', formulaId: '',
        agentId: 'codex', editorAgentId: 'claude',
      },
    );
    await expect(runWriterRoomV2(
      { scheduler: harness.pipeline.scheduler, dataDir: dir }, post.id,
    )).rejects.toThrow('Chỉ chạy được room DRAFT/READY');
    expect(harness.pipeline.scheduler.getLiveCloneCount()).toBe(0);
    expect(harness.workflow.status().totalTurns).toBe(0);
  });

  test('dispatches exactly one STUDY clone only after Run on a complete saved post', async () => {
    const { packId } = await fixtures();
    const post = await createWriterPostV2(
      { scheduler: harness.pipeline.scheduler, dataDir: dir },
    );
    await updateWriterPostV2(
      { scheduler: harness.pipeline.scheduler, dataDir: dir }, post.id,
      {
        channelId: 'finance',
        brief: 'Kiểm tra room trước khi chạy', title: 'Một title đã chuẩn bị',
        packId, generalPack: 'hieu-tv.md', formulaId: 'formula-v2-test',
        agentId: 'codex', editorAgentId: 'claude',
      },
    );
    await expect(runWriterRoomV2(
      { scheduler: harness.pipeline.scheduler, dataDir: dir }, post.id,
    )).rejects.toThrow(/Chưa chọn hook/);

    const ready = (await getWriterRunV2(post.id, dir))!;
    ready.selectedHook = {
      id: 'h1',
      type: 'direct-question',
      typeLabel: 'Câu hỏi trực diện',
      text: 'Bạn có bao giờ tính tổng khoản cố định chưa?',
    };
    await saveWriterRunV2(ready, dir);

    const started = await runWriterRoomV2(
      { scheduler: harness.pipeline.scheduler, dataDir: dir }, post.id,
    );
    expect(started.status).toBe('RUNNING');
    expect(started.phase).toBe('STUDY');
    expect(harness.pipeline.scheduler.getLiveCloneCount()).toBe(1);
    expect(harness.workflow.status().totalTurns).toBe(1);
    await expect(runWriterRoomV2(
      { scheduler: harness.pipeline.scheduler, dataDir: dir }, post.id,
    )).rejects.toThrow('Chỉ chạy được room DRAFT/READY');
  });

  test('legacy configured room helper remains compatible and does not dispatch', async () => {
    const { packId } = await fixtures();
    const room = await createWriterRoomV2(
      { scheduler: harness.pipeline.scheduler, dataDir: dir },
      {
        channelId: 'finance',
        brief: 'Legacy external caller', packId, generalPack: 'hieu-tv.md',
        formulaId: 'formula-v2-test', agentId: 'codex',
      },
    );
    expect(room.status).toBe('DRAFT');
    expect(room.phase).toBe('READY');
    expect(harness.pipeline.scheduler.getLiveCloneCount()).toBe(0);
  });

  test('recovers a validated orphan STUDY only after restart, then dispatches WRITE once', async () => {
    const runId = await startRun();
    await waitForLedgerRow(runId, STUDY_STAGE, 1);
    await Bun.write(
      join(itemRunDir(runId, STUDY_STAGE, 1), 'out', 'result.json'),
      JSON.stringify(STUDY_RESULT),
    );

    await expect(continueWriterRunV2(
      { scheduler: harness.pipeline.scheduler, dataDir: dir }, runId,
    )).rejects.toThrow('STUDY agent vẫn còn live');

    harness.dispose();
    harness = await createAgentHarness({ dataDir: dir, defaultProjectRoot: dir });
    registerWriterV2SettleListener(harness.pipeline.scheduler, { dataDir: dir });
    registerWriterV2RestyleListener(harness.pipeline.scheduler, { dataDir: dir });
    registerWriterV2HookListener(harness.pipeline.scheduler, { dataDir: dir });

    // The old daemon watchdog may have marked the run FAILED before the owner
    // restarts. Recovery accepts that shape too, but still revalidates the file.
    const interrupted = (await getWriterRunV2(runId, dir))!;
    interrupted.status = 'FAILED';
    interrupted.phase = 'FAILED';
    interrupted.errorCode = 'AGENT_TIMEOUT';
    interrupted.errorReason = 'turn timed out before team_turn_complete';
    await saveWriterRunV2(interrupted, dir);

    const recovered = await continueWriterRunV2(
      { scheduler: harness.pipeline.scheduler, dataDir: dir }, runId,
    );
    expect(recovered.status).toBe('RUNNING');
    expect(recovered.phase).toBe('WRITE');
    expect(recovered.study?.gap).toBe(STUDY_RESULT.gap);
    expect(harness.pipeline.scheduler.getLiveCloneCount()).toBe(1);
    expect(harness.workflow.status().totalTurns).toBe(1);
    await waitForLedgerRow(runId, WRITE_STAGE, 1);
  });

  test('retries an interrupted STUDY with no artifact as attempt 2 on the same post', async () => {
    const runId = await startRun();
    await waitForLedgerRow(runId, STUDY_STAGE, 1);

    await expect(continueWriterRunV2(
      { scheduler: harness.pipeline.scheduler, dataDir: dir }, runId,
    )).rejects.toThrow('STUDY agent vẫn còn live');

    harness.dispose();
    harness = await createAgentHarness({ dataDir: dir, defaultProjectRoot: dir });
    let restartInteractive: boolean | undefined;
    harness.subscribe((event) => {
      if (event.kind === 'spawnTurn') restartInteractive = event.restartInteractive;
    });
    registerWriterV2SettleListener(harness.pipeline.scheduler, { dataDir: dir });
    registerWriterV2RestyleListener(harness.pipeline.scheduler, { dataDir: dir });
    registerWriterV2HookListener(harness.pipeline.scheduler, { dataDir: dir });

    const retried = await continueWriterRunV2(
      { scheduler: harness.pipeline.scheduler, dataDir: dir }, runId,
    );
    expect(retried.status).toBe('RUNNING');
    expect(retried.phase).toBe('STUDY');
    expect(retried.study).toBeNull();
    expect(harness.pipeline.scheduler.getLiveCloneCount()).toBe(1);
    await waitForLedgerRow(runId, STUDY_STAGE, 2);
    expect(await waitUntil(
      () => restartInteractive,
      (value) => value !== undefined,
    )).toBe(true);
  });
});

describe('Writer v2 — STUDY validation', () => {
  test('stages giant physical lines as byte-exact Read-safe parts', () => {
    const source = `# Pack\n\n${'nghề kiếm tiền '.repeat(20_000)}\n🙂 evidence cuối`;
    const parts = splitExactSourceParts(source, 16_000);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join('')).toBe(source);
    expect(parts.every((part) => Buffer.byteLength(part, 'utf8') <= 16_000)).toBe(true);
  });

  test('a ledger quote that is not verbatim in the pack is rejected', () => {
    const result = validateStudyArtifact(
      { ...STUDY_RESULT, factsLedger: [{ fact: 'x', quote: 'câu này không có trong pack' }] },
      { packMarkdown: PACK_MARKDOWN, videoIds: [VIDEO_ID] },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('STUDY_LEDGER');
  });

  test('a coverageMap that skips a pack video is rejected', () => {
    const result = validateStudyArtifact(
      { ...STUDY_RESULT, coverageMap: [{ videoId: 'other', mainClaim: 'x', angle: 'y' }] },
      { packMarkdown: PACK_MARKDOWN, videoIds: [VIDEO_ID] },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('STUDY_COVERAGE');
  });

  test('a thin ledger is rejected', () => {
    const result = validateStudyArtifact(
      { ...STUDY_RESULT, factsLedger: STUDY_RESULT.factsLedger.slice(0, 1) },
      { packMarkdown: PACK_MARKDOWN, videoIds: [VIDEO_ID] },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('STUDY_LEDGER');
  });

  test('the real shape passes', () => {
    const result = validateStudyArtifact(STUDY_RESULT, { packMarkdown: PACK_MARKDOWN, videoIds: [VIDEO_ID] });
    expect(result.ok).toBe(true);
  });
});

describe('Writer v2 — WRITE validation', () => {
  const base = {
    outline: OUTLINE,
    wordRange: { minWords: 800, maxWords: 1500 },
    forbiddenNames: ['Hiếu'],
    requireOutlineChanges: true,
  };

  test('one anchor per beat, each an exact substring', () => {
    const result = validateWriterV2Draft(
      {
        title: 't',
        script: cleanScript(),
        outlineChanges: ['giữ nguyên outline'],
        beatAnchors: [ANCHOR_1, ANCHOR_2],
      },
      base,
    );
    expect(result.ok).toBe(true);
  });

  test('a paraphrased anchor is rejected', () => {
    const result = validateWriterV2Draft(
      {
        title: 't',
        script: cleanScript(),
        outlineChanges: ['x'],
        beatAnchors: [ANCHOR_1, 'phần cố định phình lên khiến quyền lựa chọn biến mất'],
      },
      base,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('BEAT_ANCHORS');
  });

  test('a missing anchor is rejected (a dropped beat)', () => {
    const result = validateWriterV2Draft(
      { title: 't', script: cleanScript(), outlineChanges: ['x'], beatAnchors: [ANCHOR_1] },
      base,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('BEAT_ANCHORS');
  });
});

describe('Writer v2 — editor review validation', () => {
  test('a defect quoting prose that is not in the script is rejected', () => {
    const result = validateEditorReview(
      { defects: [{ quote: 'không có câu này', severity: 'HIGH', note: 'x' }] },
      cleanScript(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('AGENT_UNGROUNDED');
  });

  test('zero defects is a valid answer', () => {
    const result = validateEditorReview({ defects: [] }, cleanScript());
    expect(result.ok).toBe(true);
  });
});

describe('Writer v2 — one pure draft verdict boundary', () => {
  const draft = { script: cleanScript() };

  test('the four live/recovery entry paths cannot produce different verdicts for identical state', () => {
    const identicalState = {
      phase: 'GATE' as const,
      gateResults: [{ passed: true, violations: [] }],
      editorDefects: null,
    };
    const entryPaths = ['live-settle', 'boot-write', 'boot-gate', 'boot-repair'] as const;
    const verdicts = Object.fromEntries(entryPaths.map((path) => [
      path,
      evaluateWriterDraftVerdict(structuredClone(identicalState), draft, true),
    ]));
    expect(verdicts).toEqual({
      'live-settle': { kind: 'DONE', finalScript: draft.script },
      'boot-write': { kind: 'DONE', finalScript: draft.script },
      'boot-gate': { kind: 'DONE', finalScript: draft.script },
      'boot-repair': { kind: 'DONE', finalScript: draft.script },
    });
  });

  test('preserves the legacy pre-review, post-review, and post-repair decisions', () => {
    const cleanGate = [{ passed: true, violations: [] }];
    const dirtyGate = [{
      passed: false,
      violations: [{ code: 'NUMBER_UNSOURCED' as const, detail: 'missing amount' }],
    }];

    expect(evaluateWriterDraftVerdict({
      phase: 'GATE', gateResults: dirtyGate, editorDefects: null,
    }, draft, false)).toEqual({ kind: 'EDIT_REVIEW' });
    expect(evaluateWriterDraftVerdict({
      phase: 'EDIT_REVIEW', gateResults: cleanGate, editorDefects: [],
    }, draft, false)).toEqual({ kind: 'DONE', finalScript: draft.script });
    expect(evaluateWriterDraftVerdict({
      phase: 'EDIT_REVIEW', gateResults: cleanGate,
      editorDefects: [{ quote: ANCHOR_1, severity: 'MEDIUM', note: 'flat' }],
    }, draft, false)).toEqual({ kind: 'REPAIR' });
    expect(evaluateWriterDraftVerdict({
      phase: 'GATE', gateResults: dirtyGate, editorDefects: [],
    }, draft, true)).toEqual({
      kind: 'FAILED_GATE',
      violations: dirtyGate[0]!.violations,
    });
  });
});

describe('Writer v2 — end to end', () => {
  test('continues an orphaned WRITE as attempt 2 without rerunning STUDY', async () => {
    const runId = await startRun();
    await completeStage(runId, STUDY_STAGE, STUDY_RESULT);
    await waitUntil(() => getWriterRunV2(runId, dir), (r) => r?.phase === 'WRITE');

    const firstWrite = await waitForLedgerRow(runId, WRITE_STAGE, 1);
    const orphanScript = cleanScript();
    await Bun.write(
      join(itemRunDir(runId, WRITE_STAGE, 1), 'out', 'result.json'),
      JSON.stringify({
        title: 'Lương tăng, quyền chọn giảm',
        script: orphanScript,
        outlineChanges: ['giữ nguyên outline'],
        beatAnchors: [ANCHOR_1, ANCHOR_2],
      }),
    );
    const firstSettled = waitForSettled(harness.pipeline.scheduler, WRITE_STAGE, 1);
    harness.workflow.turnComplete(Number(firstWrite.turnId), { exitCode: -1 });
    expect((await firstSettled).errorCode).toBe('AGENT_EXIT');
    await waitUntil(() => getWriterRunV2(runId, dir), (r) => r?.status === 'FAILED');

    const resumed = await continueWriterRunV2(
      { scheduler: harness.pipeline.scheduler, dataDir: dir },
      runId,
    );
    expect(resumed.status).toBe('RUNNING');
    expect(resumed.phase).toBe('WRITE');
    expect(resumed.study).toEqual(expect.objectContaining({ gap: STUDY_RESULT.gap }));
    expect(resumed.draft).toBeNull();

    const secondWrite = await waitForLedgerRow(runId, WRITE_STAGE, 2);
    expect(await Bun.file(join(itemRunDir(runId, WRITE_STAGE, 2), 'input', 'previous-draft.md')).text())
      .toContain(ANCHOR_1);
    const continuationEnvelope = JSON.parse(
      await Bun.file(join(itemRunDir(runId, WRITE_STAGE, 2), 'input', 'envelope.json')).text(),
    ) as { continuation: { previousDraftFile: string; previousWordCount: number } };
    expect(continuationEnvelope.continuation.previousDraftFile).toBe('input/previous-draft.md');
    expect(continuationEnvelope.continuation.previousWordCount).toBe(orphanScript.trim().split(/\s+/).length);
    expect(await Bun.file(join(itemRunDir(runId, WRITE_STAGE, 2), 'prompt.md')).text())
      .toContain('Continue a failed WRITE turn');

    // Finish the test's recovery turn so its settle is not left live during teardown.
    const secondSettled = waitForSettled(harness.pipeline.scheduler, WRITE_STAGE, 2);
    harness.workflow.turnComplete(Number(secondWrite.turnId), { exitCode: -1 });
    expect((await secondSettled).errorCode).toBe('AGENT_EXIT');
  });

  test('STUDY → WRITE → GATE → EDIT_REVIEW → DONE when everything is clean', async () => {
    const runId = await startRun();

    // The source stays byte-exact but is split below Read's per-call ceiling. A
    // transcript may contain one enormous physical line that offset/limit cannot
    // paginate, so the envelope owns the ordered part list.
    const studyEnvelope = JSON.parse(
      await Bun.file(join(itemRunDir(runId, STUDY_STAGE), 'input', 'envelope.json')).text(),
    ) as { topicPack: { contentFiles: string[]; markdown?: string } };
    const stagedParts = await Promise.all(
      studyEnvelope.topicPack.contentFiles.map((relativePath) =>
        Bun.file(join(itemRunDir(runId, STUDY_STAGE), relativePath)).text()),
    );
    const stagedPack = stagedParts.join('');
    expect(stagedPack).toBe(PACK_MARKDOWN);
    expect(studyEnvelope.topicPack.contentFiles).toHaveLength(1);
    expect(studyEnvelope.topicPack.markdown).toBeUndefined();
    expect(await Bun.file(join(itemRunDir(runId, STUDY_STAGE), 'input', 'editorial.md')).exists()).toBe(false);

    expect((await completeStage(runId, STUDY_STAGE, STUDY_RESULT)).outcome).toBe('COMMITTED');
    const afterStudy = await waitUntil(() => getWriterRunV2(runId, dir), (r) => r?.phase === 'WRITE');
    expect(afterStudy!.study!.factsLedger).toHaveLength(3);
    expect(await Bun.file(join(itemRunDir(runId, WRITE_STAGE), 'input', 'general-pack.md')).text())
      .toContain('## TASTE DNA');
    expect(await Bun.file(join(itemRunDir(runId, WRITE_STAGE), 'input', 'editorial.md')).text())
      .toContain('Sổ tay biên tập');
    const writeEnvelope = JSON.parse(
      await Bun.file(join(itemRunDir(runId, WRITE_STAGE), 'input', 'envelope.json')).text(),
    ) as { generalPack: { contentFile: string; markdown?: string } };
    expect(writeEnvelope.generalPack.contentFile).toBe('input/general-pack.md');
    expect(writeEnvelope.generalPack.markdown).toBeUndefined();

    expect((await completeStage(runId, WRITE_STAGE, {
      title: 'Lương tăng, quyền chọn giảm',
      script: cleanScript(),
      outlineChanges: ['giữ nguyên outline', 'hook học từ entry mở bằng câu hỏi ngân sách'],
      beatAnchors: [ANCHOR_1, ANCHOR_2],
    })).outcome).toBe('COMMITTED');

    const afterWrite = await waitUntil(() => getWriterRunV2(runId, dir), (r) => r?.phase === 'EDIT_REVIEW');
    // Layer 0 ran and found nothing.
    expect(afterWrite!.gateResults).toHaveLength(1);
    expect(afterWrite!.gateResults[0]!.passed).toBe(true);

    expect((await completeStage(runId, EDIT_REVIEW_STAGE, { defects: [] })).outcome).toBe('COMMITTED');

    const done = await waitUntil(() => getWriterRunV2(runId, dir), (r) => r?.status === 'DONE');
    expect(done!.phase).toBe('DONE');
    expect(done!.finalScript).toContain(ANCHOR_1);
    // The author keeps a single interactive pane across STUDY/WRITE; the editor
    // always gets its own pane, even if a caller chooses the same base agent.
    expect(stageAgents.get(`${runId}:${STUDY_STAGE}`)).toBe(stageAgents.get(`${runId}:${WRITE_STAGE}`));
    expect(stageAgents.get(`${runId}:${EDIT_REVIEW_STAGE}`)).not.toBe(stageAgents.get(`${runId}:${WRITE_STAGE}`));
    expect(await listJobNotifications(dir)).toEqual([
      expect.objectContaining({ kind: 'writer-v2', jobId: runId, readAt: null }),
    ]);

    const summaries = await listWriterRunsV2(dir);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.hasScript).toBe(true);
  });

  test('STUDY and WRITE spend exactly one model call per dispatch, each in a fresh context', async () => {
    const runId = await startRun();
    await completeStage(runId, STUDY_STAGE, STUDY_RESULT);
    await waitUntil(() => getWriterRunV2(runId, dir), (r) => r?.phase === 'WRITE');

    const study = dispatches.filter((d) => d.stage === STUDY_STAGE);
    const write = dispatches.filter((d) => d.stage === WRITE_STAGE);
    expect(study).toHaveLength(1);
    expect(write).toHaveLength(1);

    // The run has a hard ceiling of model calls after hook selection, and the
    // coordinator counts dispatches. The scheduler's default content-retry is 2,
    // which the coordinator cannot see: leaving it on turns one counted dispatch
    // into up to three uncounted model calls. Retrying still exists — it moved up
    // to the coordinator (STUDY attempt 2, WRITE continuation), where it is counted.
    expect(study[0]!.maxContentRetries).toBe(0);
    expect(write[0]!.maxContentRetries).toBe(0);

    // Blindness is a property of the turn, not only of the envelope. The author
    // keeps one visible pane across STUDY and WRITE, so without freshContext the
    // initial WRITE would resume the very CLI context that just read the source
    // the WRITE envelope deliberately withholds.
    expect(study[0]!.freshContext).not.toBe(false);
    expect(write[0]!.freshContext).toBe(true);
  });

  test('WRITE runs exactly as before when no persona pack file exists (backward compatible)', async () => {
    const runId = await startRun();
    await completeStage(runId, STUDY_STAGE, STUDY_RESULT);
    await waitUntil(() => getWriterRunV2(runId, dir), (r) => r?.phase === 'WRITE');

    expect(await Bun.file(join(itemRunDir(runId, WRITE_STAGE), 'input', 'persona-pack.md')).exists())
      .toBe(false);
    const writeEnvelope = JSON.parse(
      await Bun.file(join(itemRunDir(runId, WRITE_STAGE), 'input', 'envelope.json')).text(),
    ) as { personaPack?: unknown };
    expect(writeEnvelope.personaPack).toBeUndefined();
    expect(await Bun.file(join(itemRunDir(runId, WRITE_STAGE), 'prompt.md')).text())
      .not.toContain('## Persona pack');

    await completeStage(runId, WRITE_STAGE, {
      title: 'Lương tăng, quyền chọn giảm',
      script: cleanScript(),
      outlineChanges: ['giữ nguyên outline'],
      beatAnchors: [ANCHOR_1, ANCHOR_2],
    });
    await completeStage(runId, EDIT_REVIEW_STAGE, { defects: [] });
    const done = await waitUntil(() => getWriterRunV2(runId, dir), (r) => r?.status === 'DONE');
    expect(done!.personaPackHash).toBeUndefined();
  });

  test('WRITE stages persona-pack.md and adds a Persona pack prompt section when the file exists', async () => {
    const personaMarkdown = [
      '# Persona Pack — Danh tính narrator kênh',
      '<!-- version: 1 -->',
      '',
      '## 1. Bộ quan điểm (stance registry)',
      '### 1.1 Quỹ dự phòng bao lâu — `[ĐÃ DUYỆT]`',
      '**Lập trường kênh**: 1 năm chi phí sinh hoạt.',
    ].join('\n');
    mkdirSync(join(dir, 'writer'), { recursive: true });
    writeFileSync(join(dir, 'writer', 'persona-pack.md'), personaMarkdown, 'utf8');
    // Only APPROVED entries survive staging (T1) — with the single stance
    // above marked `[ĐÃ DUYỆT]`, the filtered pack keeps the shared preamble
    // and that entry, re-serialized (not a byte-identical copy of the file).
    const filtered = filterApprovedPersonaMarkdown(personaMarkdown)!;
    expect(filtered.approvedCount).toBe(1);

    const runId = await startRun();
    await completeStage(runId, STUDY_STAGE, STUDY_RESULT);
    await waitUntil(() => getWriterRunV2(runId, dir), (r) => r?.phase === 'WRITE');

    expect(await Bun.file(join(itemRunDir(runId, WRITE_STAGE), 'input', 'persona-pack.md')).text())
      .toBe(filtered.markdown);
    const writeEnvelope = JSON.parse(
      await Bun.file(join(itemRunDir(runId, WRITE_STAGE), 'input', 'envelope.json')).text(),
    ) as { personaPack: { contentFile: string; path: string; hash: string } };
    expect(writeEnvelope.personaPack.contentFile).toBe('input/persona-pack.md');
    expect(writeEnvelope.personaPack.path).toBe('persona-pack.md');
    expect(writeEnvelope.personaPack.hash).toBe(hashPersonaPack(filtered.markdown));
    const prompt = await Bun.file(join(itemRunDir(runId, WRITE_STAGE), 'prompt.md')).text();
    expect(prompt).toContain('## Persona pack');
    expect(prompt).toContain('stance registry');

    await completeStage(runId, WRITE_STAGE, {
      title: 'Lương tăng, quyền chọn giảm',
      script: cleanScript(),
      outlineChanges: ['giữ nguyên outline'],
      beatAnchors: [ANCHOR_1, ANCHOR_2],
    });
    await completeStage(runId, EDIT_REVIEW_STAGE, { defects: [] });
    const done = await waitUntil(() => getWriterRunV2(runId, dir), (r) => r?.status === 'DONE');
    expect(done!.personaPackHash).toBe(writeEnvelope.personaPack.hash);
  });

  test('a persona pack with zero APPROVED entries runs exactly like no persona pack at all', async () => {
    // No `[ĐÃ DUYỆT]`/`[APPROVED]` marker anywhere — under T2 this stays
    // PENDING (stance and experience alike), so nothing survives filtering.
    const pendingOnlyMarkdown = [
      '# Persona Pack — chưa có gì được duyệt',
      '### 1.1 Một lập trường chưa duyệt',
      '**Lập trường kênh**: Với tôi, đây là một lựa chọn.',
    ].join('\n');
    mkdirSync(join(dir, 'writer'), { recursive: true });
    writeFileSync(join(dir, 'writer', 'persona-pack.md'), pendingOnlyMarkdown, 'utf8');
    expect(filterApprovedPersonaMarkdown(pendingOnlyMarkdown)).toBeNull();

    const runId = await startRun();
    await completeStage(runId, STUDY_STAGE, STUDY_RESULT);
    await waitUntil(() => getWriterRunV2(runId, dir), (r) => r?.phase === 'WRITE');

    expect(await Bun.file(join(itemRunDir(runId, WRITE_STAGE), 'input', 'persona-pack.md')).exists())
      .toBe(false);
    const writeEnvelope = JSON.parse(
      await Bun.file(join(itemRunDir(runId, WRITE_STAGE), 'input', 'envelope.json')).text(),
    ) as { personaPack?: unknown };
    expect(writeEnvelope.personaPack).toBeUndefined();
    expect(await Bun.file(join(itemRunDir(runId, WRITE_STAGE), 'prompt.md')).text())
      .not.toContain('## Persona pack');

    await completeStage(runId, WRITE_STAGE, {
      title: 'Lương tăng, quyền chọn giảm',
      script: cleanScript(),
      outlineChanges: ['giữ nguyên outline'],
      beatAnchors: [ANCHOR_1, ANCHOR_2],
    });
    await completeStage(runId, EDIT_REVIEW_STAGE, { defects: [] });
    const done = await waitUntil(() => getWriterRunV2(runId, dir), (r) => r?.status === 'DONE');
    expect(done!.personaPackHash).toBeUndefined();
  });

  test('a fabricated case never reaches DONE — it ends FAILED_GATE', async () => {
    const runId = await startRun();
    await completeStage(runId, STUDY_STAGE, STUDY_RESULT);
    await waitUntil(() => getWriterRunV2(runId, dir), (r) => r?.phase === 'WRITE');

    await completeStage(runId, WRITE_STAGE, {
      title: 'Lương tăng, quyền chọn giảm',
      script: fabricatedScript(),
      outlineChanges: ['thêm một case cụ thể cho dễ hình dung'],
      beatAnchors: [ANCHOR_1, ANCHOR_2],
    });

    const afterGate = await waitUntil(() => getWriterRunV2(runId, dir), (r) => r?.phase === 'EDIT_REVIEW');
    const gate = afterGate!.gateResults[0]!;
    expect(gate.passed).toBe(false);
    expect(gate.violations.map((v) => v.code)).toContain('NUMBER_UNSOURCED');
    expect(gate.violations.map((v) => v.code)).toContain('PROPER_NOUN_UNSOURCED');

    // The editor reports something too; either way a repair round is dispatched.
    await completeStage(runId, EDIT_REVIEW_STAGE, {
      defects: [{ quote: ANCHOR_2, severity: 'MEDIUM', note: 'đoạn này chưa có thông tin mới' }],
    });
    await waitUntil(() => getWriterRunV2(runId, dir), (r) => r?.phase === 'REPAIR');

    // The repair does not actually remove the fabrication.
    await completeStage(runId, REPAIR_STAGE, {
      title: 'Lương tăng, quyền chọn giảm',
      script: fabricatedScript(),
      beatAnchors: [ANCHOR_1, ANCHOR_2],
    });

    const failed = await waitUntil(() => getWriterRunV2(runId, dir), (r) => r != null && r.status !== 'RUNNING');
    expect(failed!.status).toBe('FAILED_GATE');
    expect(failed!.errorCode).toBe('WRITER_V2_GATE');
    expect(failed!.finalScript).toBeNull();
    expect(failed!.errorReason).toContain('NUMBER_UNSOURCED');
    // Exactly two gate runs: after WRITE and after REPAIR. No third chance.
    expect(failed!.gateResults).toHaveLength(2);
    expect(await listJobNotifications(dir)).toEqual([]);
  });

  test('a repair that actually fixes the facts reaches DONE', async () => {
    const runId = await startRun();
    await completeStage(runId, STUDY_STAGE, STUDY_RESULT);
    await waitUntil(() => getWriterRunV2(runId, dir), (r) => r?.phase === 'WRITE');

    await completeStage(runId, WRITE_STAGE, {
      title: 'Lương tăng, quyền chọn giảm',
      script: fabricatedScript(),
      outlineChanges: ['thêm case'],
      beatAnchors: [ANCHOR_1, ANCHOR_2],
    });
    await waitUntil(() => getWriterRunV2(runId, dir), (r) => r?.phase === 'EDIT_REVIEW');
    await completeStage(runId, EDIT_REVIEW_STAGE, { defects: [] });
    await waitUntil(() => getWriterRunV2(runId, dir), (r) => r?.phase === 'REPAIR');

    await completeStage(runId, REPAIR_STAGE, {
      title: 'Lương tăng, quyền chọn giảm',
      script: cleanScript(),
      beatAnchors: [ANCHOR_1, ANCHOR_2],
    });

    const done = await waitUntil(() => getWriterRunV2(runId, dir), (r) => r != null && r.status !== 'RUNNING');
    expect(done!.status).toBe('DONE');
    expect(done!.finalScript).toBe(cleanScript());
    expect(done!.gateResults.at(-1)!.passed).toBe(true);
    expect(stageAgents.get(`${runId}:${REPAIR_STAGE}`)).toBe(stageAgents.get(`${runId}:${WRITE_STAGE}`));
    expect(await listJobNotifications(dir)).toEqual([
      expect.objectContaining({ kind: 'writer-v2', jobId: runId, readAt: null }),
    ]);
  });

  test('an ungrounded EDIT_REVIEW answer fails the run without a second content-retry dispatch', async () => {
    const runId = await startRun();
    await completeStage(runId, STUDY_STAGE, STUDY_RESULT);
    await waitUntil(() => getWriterRunV2(runId, dir), (r) => r?.phase === 'WRITE');
    await completeStage(runId, WRITE_STAGE, {
      title: 'Lương tăng, quyền chọn giảm',
      script: cleanScript(),
      outlineChanges: ['giữ nguyên outline'],
      beatAnchors: [ANCHOR_1, ANCHOR_2],
    });
    await waitUntil(() => getWriterRunV2(runId, dir), (r) => r?.phase === 'EDIT_REVIEW');

    // A defect quoting prose that is not in the script fails `validateEditorReview`
    // inside the scheduler's own `validateContent`, before this ever reaches
    // `handleWriterV2Settle`'s EDIT_REVIEW branch.
    const settled = await completeStage(runId, EDIT_REVIEW_STAGE, {
      defects: [{ quote: 'không có câu này trong script', severity: 'HIGH', note: 'x' }],
    });
    expect(settled.outcome).toBe('FAILED');
    expect(settled.errorCode).toBe('AGENT_UNGROUNDED');

    const failed = await waitUntil(() => getWriterRunV2(runId, dir), (r) => r?.status === 'FAILED');
    expect(failed!.phase).toBe('FAILED');
    expect(failed!.errorCode).toBe('AGENT_UNGROUNDED');

    // maxContentRetries: 0 means the scheduler never re-dispatched the editor to
    // fix its own answer — exactly one EDIT_REVIEW dispatch, no attempt 2 row.
    const editReviewDispatches = dispatches.filter((d) => d.stage === EDIT_REVIEW_STAGE);
    expect(editReviewDispatches).toHaveLength(1);
    expect(editReviewDispatches[0]!.maxContentRetries).toBe(0);
    expect(harness.pipeline.ledger.all().find((r) =>
      r.batchId === runId && r.itemId === WRITER_V2_ITEM_ID && r.stage === EDIT_REVIEW_STAGE && r.attempt === 2
    )).toBeUndefined();
  });

  test('a malformed REPAIR draft fails the run without a second content-retry dispatch', async () => {
    const runId = await startRun();
    await completeStage(runId, STUDY_STAGE, STUDY_RESULT);
    await waitUntil(() => getWriterRunV2(runId, dir), (r) => r?.phase === 'WRITE');

    await completeStage(runId, WRITE_STAGE, {
      title: 'Lương tăng, quyền chọn giảm',
      script: fabricatedScript(),
      outlineChanges: ['thêm case'],
      beatAnchors: [ANCHOR_1, ANCHOR_2],
    });
    await waitUntil(() => getWriterRunV2(runId, dir), (r) => r?.phase === 'EDIT_REVIEW');
    await completeStage(runId, EDIT_REVIEW_STAGE, { defects: [] });
    await waitUntil(() => getWriterRunV2(runId, dir), (r) => r?.phase === 'REPAIR');

    // Drops a beat anchor — fails `validateWriterV2Draft` inside the scheduler's
    // own `validateContent`, before this ever reaches `handleWriterV2Settle`'s
    // REPAIR branch.
    const settled = await completeStage(runId, REPAIR_STAGE, {
      title: 'Lương tăng, quyền chọn giảm',
      script: fabricatedScript(),
      beatAnchors: [ANCHOR_1],
    });
    expect(settled.outcome).toBe('FAILED');
    expect(settled.errorCode).toBe('BEAT_ANCHORS');

    const failed = await waitUntil(() => getWriterRunV2(runId, dir), (r) => r?.status === 'FAILED');
    expect(failed!.phase).toBe('FAILED');
    expect(failed!.errorCode).toBe('BEAT_ANCHORS');

    const repairDispatches = dispatches.filter((d) => d.stage === REPAIR_STAGE);
    expect(repairDispatches).toHaveLength(1);
    expect(repairDispatches[0]!.maxContentRetries).toBe(0);
    expect(harness.pipeline.ledger.all().find((r) =>
      r.batchId === runId && r.itemId === WRITER_V2_ITEM_ID && r.stage === REPAIR_STAGE && r.attempt === 2
    )).toBeUndefined();
  });

  test('editing the general pack mid-run stops the run instead of silently switching', async () => {
    const runId = await startRun();
    writeFileSync(join(dir, 'general-packs', 'hieu-tv.md'), '# Hieu TV\n<!-- version: 2 -->\n', 'utf8');
    await completeStage(runId, STUDY_STAGE, STUDY_RESULT);
    const failed = await waitUntil(() => getWriterRunV2(runId, dir), (r) => r != null && r.status !== 'RUNNING');
    expect(failed!.status).toBe('FAILED');
    expect(failed!.errorCode).toBe('GENERAL_PACK_CHANGED');
  });

  test('editing the channel notebook mid-run stops WRITE instead of silently switching', async () => {
    const runId = await startRun();
    writeFileSync(
      join(dir, 'channels', 'finance', 'editorial.md'),
      '# Sổ tay biên tập\n\n- Một quyết định mới giữa run.\n',
      'utf8',
    );
    await completeStage(runId, STUDY_STAGE, STUDY_RESULT);
    const failed = await waitUntil(() => getWriterRunV2(runId, dir), (run) => run != null && run.status !== 'RUNNING');
    expect(failed!.status).toBe('FAILED');
    expect(failed!.errorCode).toBe('EDITORIAL_CHANGED');
  });

  test('a channel default procedure is pinned and staged only in WRITE', async () => {
    const procedure = await createReusableProcedure({
      id: 'finance-checklist',
      description: 'Dùng khi viết bài tài chính để kiểm tra các phép tính và lời kêu gọi hành động.',
      instructions: '# Checklist tài chính\n\n1. Tính lại mọi con số.\n2. Đọc riêng phần kết trước khi giao.',
    }, dir);
    await updateChannelProfile('finance', {
      id: 'finance', displayName: 'Kênh Tài chính', topic: 'Tài chính cá nhân',
      defaultProcedure: procedure.id,
    }, dir);
    const runId = await startRun();
    const started = (await getWriterRunV2(runId, dir))!;
    expect(started.procedureId).toBe(procedure.id);
    expect(started.procedureHash).toBe(procedure.hash);
    expect(await Bun.file(join(itemRunDir(runId, STUDY_STAGE), 'input', 'procedure.md')).exists()).toBe(false);

    await completeStage(runId, STUDY_STAGE, STUDY_RESULT);
    await waitUntil(() => getWriterRunV2(runId, dir), (run) => run?.phase === 'WRITE');
    const row = await waitForLedgerRow(runId, WRITE_STAGE, 1);
    expect(await Bun.file(join(itemRunDir(runId, WRITE_STAGE), 'input', 'procedure.md')).text())
      .toContain('Tính lại mọi con số');

    const settled = waitForSettled(harness.pipeline.scheduler, WRITE_STAGE, 1);
    harness.workflow.turnComplete(Number(row.turnId), { exitCode: -1 });
    await settled;
  });
});

describe('Writer v2 — tổng kết sau bài', () => {
  const deps = () => ({ scheduler: harness.pipeline.scheduler, dataDir: dir });

  test('validates a compact 1–3 lesson proposal', () => {
    expect(validatePostmortem({ lessons: [] }).ok).toBe(false);
    expect(validatePostmortem({
      lessons: [{ kind: 'KEEP', text: 'Giữ câu hỏi tự soi ở phần mở đầu.', reason: 'Hook tạo đúng món nợ cho phần kết.' }],
    }).ok).toBe(true);
  });

  test('a DONE run can generate suggestions without editing editorial.md', async () => {
    const runId = await startRun();
    await completeStage(runId, STUDY_STAGE, STUDY_RESULT);
    await waitUntil(() => getWriterRunV2(runId, dir), (run) => run?.phase === 'WRITE');
    await completeStage(runId, WRITE_STAGE, {
      title: 'Lương tăng, quyền chọn giảm', script: cleanScript(),
      outlineChanges: ['giữ nguyên outline'], beatAnchors: [ANCHOR_1, ANCHOR_2],
    });
    await waitUntil(() => getWriterRunV2(runId, dir), (run) => run?.phase === 'EDIT_REVIEW');
    await completeStage(runId, EDIT_REVIEW_STAGE, { defects: [] });
    await waitUntil(() => getWriterRunV2(runId, dir), (run) => run?.status === 'DONE');

    const beforeEditorial = await Bun.file(join(dir, 'channels', 'finance', 'editorial.md')).text();
    const started = await startWriterPostmortem(deps(), runId);
    expect(started.reviewingPostmortem?.attempt).toBe(1);
    expect(await Bun.file(join(itemRunDir(runId, POSTMORTEM_STAGE), 'input', 'article.md')).text())
      .toContain(ANCHOR_1);

    const lesson = {
      kind: 'KEEP' as const,
      text: 'Giữ câu hỏi tự soi ở phần mở đầu để phần kết trả lại đúng món nợ.',
      reason: 'Hook và ending cùng quay lại câu hỏi về khoản chi cố định.',
    };
    expect((await completeStage(runId, POSTMORTEM_STAGE, { lessons: [lesson] })).outcome).toBe('COMMITTED');
    const reviewed = await waitUntil(() => getWriterRunV2(runId, dir), (run) => Boolean(run?.postmortem));
    expect(reviewed!.status).toBe('DONE');
    expect(reviewed!.postmortem?.lessons).toEqual([lesson]);
    expect(await Bun.file(join(dir, 'channels', 'finance', 'editorial.md')).text()).toBe(beforeEditorial);
    expect(await listEditorialSuggestions('finance', dir)).toEqual([
      { ...lesson, sourceRunId: runId },
    ]);
  });
});

describe('Writer v2 — restyle', () => {
  /** Drive a run all the way to DONE: restyle only ever starts from one of those. */
  async function runToDone(): Promise<string> {
    const runId = await startRun();
    await completeStage(runId, STUDY_STAGE, STUDY_RESULT);
    await waitUntil(() => getWriterRunV2(runId, dir), (r) => r?.phase === 'WRITE');
    await completeStage(runId, WRITE_STAGE, {
      title: 'Lương tăng, quyền chọn giảm',
      script: cleanScript(),
      outlineChanges: ['giữ nguyên outline'],
      beatAnchors: [ANCHOR_1, ANCHOR_2],
    });
    await waitUntil(() => getWriterRunV2(runId, dir), (r) => r?.phase === 'EDIT_REVIEW');
    await completeStage(runId, EDIT_REVIEW_STAGE, { defects: [] });
    await waitUntil(() => getWriterRunV2(runId, dir), (r) => r?.status === 'DONE');
    return runId;
  }

  /** A restyled script: different voice, same length band, no host-identity leak. */
  function styledScript(marker: string): string {
    const filler = Array.from({ length: 848 }, (_, i) => `chữ${i}`).join(' ');
    return `${marker} Vy ngồi xuống và mở bảng chi tiêu của chính mình. ${filler}`;
  }

  const deps = () => ({ scheduler: harness.pipeline.scheduler, dataDir: dir });

  test('startRestyle dispatches restyle-v1 as attempt 1 in its own interactive pane', async () => {
    const runId = await runToDone();
    const before = (await getWriterRunV2(runId, dir))!;

    const started = await startRestyle(deps(), runId, STYLE_ID);
    expect(started.restyling).toEqual({
      version: 1,
      styleId: STYLE_ID,
      startedAt: expect.any(String),
    });
    // Untouched, even while a restyle is in flight.
    expect(started.status).toBe('DONE');
    expect(started.finalScript).toBe(before.finalScript);

    const row = await waitForLedgerRow(runId, RESTYLE_STAGE, 1);
    expect(row.stage).toBe(RESTYLE_STAGE);
    expect(row.attempt).toBe(1);
    const launch = await waitUntil(
      () => turnLaunches.get(Number(row.turnId)),
      (value) => value !== undefined,
    );
    expect(launch).toEqual({ mode: 'interactive', interactiveRequired: true, forceHeadless: false });

    // Both large inputs are staged as ordinary Markdown, not escaped into the envelope.
    const inputDir = join(itemRunDir(runId, RESTYLE_STAGE, 1), 'input');
    expect(await Bun.file(join(inputDir, 'source.md')).text()).toBe(before.finalScript!);
    expect(await Bun.file(join(inputDir, 'style.md')).text()).toBe(CHANNEL_STYLE);
    const envelope = JSON.parse(await Bun.file(join(inputDir, 'envelope.json')).text()) as {
      sourceFile: string; styleFile: string; factsLedger: unknown[]; script?: string;
    };
    expect(envelope.sourceFile).toBe('input/source.md');
    expect(envelope.styleFile).toBe('input/style.md');
    expect(envelope.factsLedger).toHaveLength(3);
    expect(envelope.script).toBeUndefined();

    // Leave nothing live for teardown.
    await completeStage(runId, RESTYLE_STAGE, { title: 'x', script: styledScript('A.') }, 1);
    await waitUntil(() => getWriterRunV2(runId, dir), (r) => (r?.styled?.length ?? 0) === 1);
  });

  test('a committed restyle writes a versioned file and leaves the run DONE', async () => {
    const runId = await runToDone();
    const before = (await getWriterRunV2(runId, dir))!;

    await startRestyle(deps(), runId, STYLE_ID);
    const script = styledScript('Chín giờ tối.');
    expect((await completeStage(runId, RESTYLE_STAGE, { title: 'Bản của Vy', script }, 1)).outcome)
      .toBe('COMMITTED');

    const after = await waitUntil(
      () => getWriterRunV2(runId, dir),
      (r) => (r?.styled?.length ?? 0) === 1,
    );
    expect(after!.styled![0]).toEqual({
      version: 1,
      styleId: STYLE_ID,
      styleVersion: 2,
      styleHash: expect.any(String),
      agentId: before.agentId,
      path: `writer/styled/${runId}/v1.md`,
      words: script.trim().split(/\s+/).length,
      createdAt: expect.any(String),
    });
    expect(after!.restyling).toBeUndefined();
    expect(after!.restyleError).toBeUndefined();

    // The whole point: the sourced original survives the operation intact.
    expect(after!.status).toBe('DONE');
    expect(after!.phase).toBe('DONE');
    expect(after!.finalScript).toBe(before.finalScript);

    const markdown = await readStyledVersion(runId, 1, dir);
    expect(markdown).toBe(`# Bản của Vy\n\n${script}\n`);
    expect(await Bun.file(join(dir, 'writer', 'styled', runId, 'v1.md')).text()).toBe(markdown!);
    expect(await readStyledVersion(runId, 2, dir)).toBeNull();
    expect(await readStyledVersion(runId, 0, dir)).toBeNull();
    expect(await readStyledVersion(runId, 1.5, dir)).toBeNull();

    const summaries = await listWriterRunsV2(dir);
    expect(summaries[0]!.styledCount).toBe(1);
  });

  test('a failed restyle records restyleError without failing the run', async () => {
    const runId = await runToDone();
    const before = (await getWriterRunV2(runId, dir))!;

    await startRestyle(deps(), runId, STYLE_ID);
    const row = await waitForLedgerRow(runId, RESTYLE_STAGE, 1);
    const settled = waitForSettled(harness.pipeline.scheduler, RESTYLE_STAGE, 1);
    harness.workflow.turnComplete(Number(row.turnId), { exitCode: -1 });
    expect((await settled).outcome).toBe('FAILED');

    const after = await waitUntil(() => getWriterRunV2(runId, dir), (r) => r?.restyleError !== undefined);
    expect(after!.restyleError!.code).toBe('AGENT_EXIT');
    expect(after!.restyling).toBeUndefined();
    expect(after!.styled).toEqual([]);
    expect(after!.status).toBe('DONE');
    expect(after!.finalScript).toBe(before.finalScript);
  });

  test('a second restyle is attempt 2 and appends a second version', async () => {
    const runId = await runToDone();

    await startRestyle(deps(), runId, STYLE_ID);
    await completeStage(runId, RESTYLE_STAGE, { title: 'v1', script: styledScript('Một.') }, 1);
    await waitUntil(() => getWriterRunV2(runId, dir), (r) => (r?.styled?.length ?? 0) === 1);

    const second = await startRestyle(deps(), runId, STYLE_ID);
    expect(second.restyling!.version).toBe(2);
    // A distinct `attempt` is what keeps the turn key from re-attaching to v1's turn.
    const row = await waitForLedgerRow(runId, RESTYLE_STAGE, 2);
    expect(row.attempt).toBe(2);
    expect(row.turnKey).not.toBe((await waitForLedgerRow(runId, RESTYLE_STAGE, 1)).turnKey);

    await completeStage(runId, RESTYLE_STAGE, { title: 'v2', script: styledScript('Hai.') }, 2);
    const after = await waitUntil(
      () => getWriterRunV2(runId, dir),
      (r) => (r?.styled?.length ?? 0) === 2,
    );
    expect(after!.styled!.map((s) => s.version)).toEqual([1, 2]);
    expect(after!.styled!.map((s) => s.path)).toEqual([
      `writer/styled/${runId}/v1.md`,
      `writer/styled/${runId}/v2.md`,
    ]);
    expect(await readStyledVersion(runId, 2, dir)).toContain('# v2');
    expect(after!.status).toBe('DONE');
  });

  test('guards: unknown run, a run still RUNNING, no finalScript, already restyling', async () => {
    expect(startRestyle(deps(), 'no-such-run', STYLE_ID)).rejects.toThrow('không tồn tại');

    const runningId = await startRun();
    expect(startRestyle(deps(), runningId, STYLE_ID)).rejects.toThrow(/DONE/);
    // Finish the STUDY turn so nothing is live at teardown.
    await completeStage(runningId, STUDY_STAGE, STUDY_RESULT);
    await waitUntil(() => getWriterRunV2(runningId, dir), (r) => r?.phase === 'WRITE');
    const writeRow = await waitForLedgerRow(runningId, WRITE_STAGE, 1);
    const writeSettled = waitForSettled(harness.pipeline.scheduler, WRITE_STAGE, 1);
    harness.workflow.turnComplete(Number(writeRow.turnId), { exitCode: -1 });
    await writeSettled;

    const runId = await runToDone();
    expect(startRestyle(deps(), runId, 'khong-co-file-nay.md')).rejects.toThrow('không tồn tại');

    const stripped = (await getWriterRunV2(runId, dir))!;
    stripped.finalScript = null;
    await saveWriterRunV2(stripped, dir);
    expect(startRestyle(deps(), runId, STYLE_ID)).rejects.toThrow('finalScript');

    const restored = (await getWriterRunV2(runId, dir))!;
    restored.finalScript = cleanScript();
    await saveWriterRunV2(restored, dir);
    await startRestyle(deps(), runId, STYLE_ID);
    expect(startRestyle(deps(), runId, STYLE_ID)).rejects.toThrow('restyle');

    await completeStage(runId, RESTYLE_STAGE, { title: 'x', script: styledScript('Ba.') }, 1);
    await waitUntil(() => getWriterRunV2(runId, dir), (r) => (r?.styled?.length ?? 0) === 1);
  });

  test('a run recorded before restyle existed reads back without crashing', async () => {
    const runId = await runToDone();
    const raw = JSON.parse(
      await Bun.file(join(dir, 'writer', 'runs-v2', `${runId}.json`)).text(),
    ) as Record<string, unknown>;
    delete raw.styled;
    delete raw.restyling;
    delete raw.restyleError;
    await Bun.write(join(dir, 'writer', 'runs-v2', `${runId}.json`), JSON.stringify(raw));

    const reread = await getWriterRunV2(runId, dir);
    expect(reread!.styled).toEqual([]);
    expect(reread!.restyling).toBeUndefined();
    expect((await listWriterRunsV2(dir))[0]!.styledCount).toBe(0);

    // And a restyle on such a run still numbers itself v1.
    const started = await startRestyle(deps(), runId, STYLE_ID);
    expect(started.restyling!.version).toBe(1);
    await completeStage(runId, RESTYLE_STAGE, { title: 'x', script: styledScript('Bốn.') }, 1);
    await waitUntil(() => getWriterRunV2(runId, dir), (r) => (r?.styled?.length ?? 0) === 1);
  });

  describe('boot recovery', () => {
    /**
     * The state a daemon restart leaves behind, reproduced without a live turn:
     * `run.restyling` is set on disk, the ledger row is already terminal, and no
     * `onItemSettled` will ever arrive — exactly what `reconcileOnBoot` produces.
     */
    async function stranded(version = 1): Promise<string> {
      const runId = await runToDone();
      const run = (await getWriterRunV2(runId, dir))!;
      run.restyling = { version, styleId: STYLE_ID, startedAt: '2026-08-19T17:08:40.000Z' };
      await saveWriterRunV2(run, dir);
      return runId;
    }

    /** Whatever the agent left in `out/result.json` before the daemon went down. */
    async function writeOutResult(runId: string, body: string, version = 1): Promise<void> {
      await Bun.write(join(itemRunDir(runId, RESTYLE_STAGE, version), 'out', 'result.json'), body);
    }

    test('a finished out/result.json is committed as a styled version', async () => {
      const runId = await stranded();
      const before = (await getWriterRunV2(runId, dir))!;
      const script = styledScript('Bảy giờ sáng.');
      await writeOutResult(runId, JSON.stringify({ title: 'Bản cứu được', script }));

      await recoverInterruptedRestyles(dir);

      const after = (await getWriterRunV2(runId, dir))!;
      expect(after.styled).toHaveLength(1);
      expect(after.styled![0]).toEqual({
        version: 1,
        styleId: STYLE_ID,
        styleVersion: 2,
        styleHash: expect.any(String),
        agentId: before.agentId,
        path: `writer/styled/${runId}/v1.md`,
        words: script.trim().split(/\s+/).length,
        createdAt: expect.any(String),
      });
      expect(after.restyling).toBeUndefined();
      expect(after.restyleError).toBeUndefined();
      expect(await readStyledVersion(runId, 1, dir)).toBe(`# Bản cứu được\n\n${script}\n`);

      // The invariant: recovery is an addition, never a verdict change.
      expect(after.status).toBe('DONE');
      expect(after.phase).toBe('DONE');
      expect(after.finalScript).toBe(before.finalScript);
    });

    test('no out/result.json at all → RESTYLE_INTERRUPTED, run still DONE', async () => {
      const runId = await stranded();
      const before = (await getWriterRunV2(runId, dir))!;

      await recoverInterruptedRestyles(dir);

      const after = (await getWriterRunV2(runId, dir))!;
      expect(after.restyleError!.code).toBe('RESTYLE_INTERRUPTED');
      expect(after.restyleError!.reason).toContain('out/result.json');
      expect(after.restyling).toBeUndefined();
      expect(after.styled).toEqual([]);
      expect(after.status).toBe('DONE');
      expect(after.phase).toBe('DONE');
      expect(after.finalScript).toBe(before.finalScript);
    });

    test('an out/result.json outside the word band → RESTYLE_INTERRUPTED, not a styled version', async () => {
      const runId = await stranded();
      const before = (await getWriterRunV2(runId, dir))!;
      await writeOutResult(runId, JSON.stringify({ title: 'Quá ngắn', script: 'Vy ngồi xuống.' }));

      await recoverInterruptedRestyles(dir);

      const after = (await getWriterRunV2(runId, dir))!;
      expect(after.restyleError!.code).toBe('RESTYLE_INTERRUPTED');
      expect(after.restyleError!.reason).toContain('RESTYLE_LENGTH');
      expect(after.restyling).toBeUndefined();
      expect(after.styled).toEqual([]);
      expect(await readStyledVersion(runId, 1, dir)).toBeNull();
      expect(after.status).toBe('DONE');
      expect(after.phase).toBe('DONE');
      expect(after.finalScript).toBe(before.finalScript);
    });

    test('a run with no restyling in flight is not touched at all', async () => {
      const runId = await runToDone();
      const before = (await getWriterRunV2(runId, dir))!;
      expect(before.restyling).toBeUndefined();

      await recoverInterruptedRestyles(dir);

      // Whole record, byte for byte — `updatedAt` included, so a stray save would show.
      expect(await getWriterRunV2(runId, dir)).toEqual(before);
    });

    test('a torn out/result.json on one run does not stop the next run from recovering', async () => {
      const broken = await stranded();
      await writeOutResult(broken, '{"title":"cụt","scr');
      const good = await stranded();
      const script = styledScript('Mười giờ.');
      await writeOutResult(good, JSON.stringify({ title: 'Bản tốt', script }));

      await recoverInterruptedRestyles(dir);

      const brokenAfter = (await getWriterRunV2(broken, dir))!;
      expect(brokenAfter.restyleError!.code).toBe('RESTYLE_INTERRUPTED');
      expect(brokenAfter.restyling).toBeUndefined();
      expect(brokenAfter.status).toBe('DONE');

      const goodAfter = (await getWriterRunV2(good, dir))!;
      expect(goodAfter.styled).toHaveLength(1);
      expect(goodAfter.restyling).toBeUndefined();
      expect(goodAfter.status).toBe('DONE');
    });

    test('a second boot after a recovered restyle is a no-op', async () => {
      const runId = await stranded();
      await writeOutResult(runId, JSON.stringify({ title: 'Một lần', script: styledScript('Sáu.') }));

      await recoverInterruptedRestyles(dir);
      const afterFirst = (await getWriterRunV2(runId, dir))!;
      await recoverInterruptedRestyles(dir);

      // `restyling` is gone, so the sweep skips the run — no duplicate v1 entry.
      expect(await getWriterRunV2(runId, dir)).toEqual(afterFirst);
      expect(afterFirst.styled).toHaveLength(1);
    });
  });
});

describe('Writer v2 — weighted progress + main-loop boot recovery', () => {
  test('computeWriterV2Progress follows Director Board weights', () => {
    const base = {
      agentId: 'codex' as const,
      editorAgentId: 'claude' as const,
      study: null,
      draft: null,
      gateResults: [] as [],
      editorDefects: null,
    };
    expect(computeWriterV2Progress({ ...base, status: 'DRAFT', phase: 'READY' }).progressPercent).toBe(10);
    expect(computeWriterV2Progress({ ...base, status: 'RUNNING', phase: 'STUDY' })).toEqual({
      progressPercent: 22,
      activeRole: { kind: 'author', label: 'Author: codex', agentId: 'codex' },
    });
    expect(computeWriterV2Progress({ ...base, status: 'RUNNING', phase: 'WRITE' }).progressPercent).toBe(52);
    expect(computeWriterV2Progress({ ...base, status: 'RUNNING', phase: 'GATE' }).activeRole.kind).toBe('gate');
    expect(computeWriterV2Progress({ ...base, status: 'RUNNING', phase: 'EDIT_REVIEW' }).activeRole).toEqual({
      kind: 'critic',
      label: 'Critic: claude',
      agentId: 'claude',
    });
    expect(computeWriterV2Progress({ ...base, status: 'DONE', phase: 'DONE' }).progressPercent).toBe(100);
  });

  test('recoverInterruptedWriterRuns clears a zombie STUDY with no artifact', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'wr-writer-v2-recover-'));
    try {
      const h = await createAgentHarness({ dataDir: tmp, defaultProjectRoot: tmp });
      registerWriterV2SettleListener(h.pipeline.scheduler, { dataDir: tmp });
      await createChannelProfile({ id: 'finance', displayName: 'Kênh Tài chính', topic: 'Tài chính' }, tmp);
      mkdirSync(join(tmp, 'general-packs'), { recursive: true });
      writeFileSync(join(tmp, 'general-packs', 'hieu-tv.md'), '# gp\n<!-- version: 1 -->\n', 'utf8');
      const formula = makeFormula();
      await saveFormula(formula, tmp);
      const pack = await createWriterPack({
        title: 'Pack',
        channelTitle: 'Ch',
        markdown: PACK_MARKDOWN,
        videoIds: [VIDEO_ID],
      }, tmp);
      const run = await createWriterRoomV2(
        { scheduler: h.pipeline.scheduler, dataDir: tmp },
        {
          channelId: 'finance',
          brief: 'brief',
          title: 'title',
          packId: pack.id,
          generalPack: 'hieu-tv.md',
          formulaId: formula.id,
          agentId: 'codex',
          editorAgentId: 'claude',
        },
      );
      run.selectedHook = {
        id: 'h1', type: 'direct-question', typeLabel: 'Câu hỏi trực diện', text: 'title',
      };
      await saveWriterRunV2(run, tmp);
      await runWriterRoomV2({ scheduler: h.pipeline.scheduler, dataDir: tmp }, run.id);
      h.dispose();

      const zombie = (await getWriterRunV2(run.id, tmp))!;
      expect(zombie.status).toBe('RUNNING');
      expect(zombie.phase).toBe('STUDY');

      await recoverInterruptedWriterRuns(tmp);

      const after = (await getWriterRunV2(run.id, tmp))!;
      expect(after.status).toBe('FAILED');
      expect(after.phase).toBe('FAILED');
      expect(after.errorCode).toBe('STUDY_INTERRUPTED');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('recoverInterruptedWriterRuns commits a finished STUDY artifact and can continue WRITE', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'wr-writer-v2-recover-study-'));
    let h: AgentHarness | undefined;
    try {
      h = await createAgentHarness({ dataDir: tmp, defaultProjectRoot: tmp });
      registerWriterV2SettleListener(h.pipeline.scheduler, { dataDir: tmp });
      await createChannelProfile({ id: 'finance', displayName: 'Kênh Tài chính', topic: 'Tài chính' }, tmp);
      mkdirSync(join(tmp, 'general-packs'), { recursive: true });
      writeFileSync(
        join(tmp, 'general-packs', 'hieu-tv.md'),
        [
          '# Hieu TV',
          '<!-- version: 1 -->',
          '',
          '## TASTE DNA',
          '1. Chính sách cá nhân.',
          '',
          '## Ví dụ | 200k views | 20 phút',
          '- **Hook**: mở bằng ngân sách',
        ].join('\n'),
        'utf8',
      );
      const formula = makeFormula();
      await saveFormula(formula, tmp);
      const pack = await createWriterPack({
        title: 'Pack',
        channelTitle: 'Ch',
        markdown: PACK_MARKDOWN,
        videoIds: [VIDEO_ID],
      }, tmp);
      const room = await createWriterRoomV2(
        { scheduler: h.pipeline.scheduler, dataDir: tmp },
        {
          channelId: 'finance',
          brief: 'brief',
          title: 'title',
          packId: pack.id,
          generalPack: 'hieu-tv.md',
          formulaId: formula.id,
          agentId: 'codex',
          editorAgentId: 'claude',
        },
      );
      room.selectedHook = {
        id: 'h1', type: 'direct-question', typeLabel: 'Câu hỏi trực diện', text: 'title',
      };
      await saveWriterRunV2(room, tmp);
      await runWriterRoomV2({ scheduler: h.pipeline.scheduler, dataDir: tmp }, room.id);
      await Bun.write(
        join(tmp, 'workspaces', 'pipeline', room.id, WRITER_V2_ITEM_ID, 'attempts', '1', STUDY_STAGE, 'out', 'result.json'),
        JSON.stringify(STUDY_RESULT),
      );
      h.dispose();
      h = undefined;

      // Without scheduler: commit STUDY into the record and clear the RUNNING zombie.
      await recoverInterruptedWriterRuns(tmp);
      const rescued = (await getWriterRunV2(room.id, tmp))!;
      expect(rescued.study?.gap).toBe(STUDY_RESULT.gap);
      expect(rescued.status).toBe('FAILED');
      expect(rescued.errorCode).toBe('STUDY_INTERRUPTED');

      h = await createAgentHarness({ dataDir: tmp, defaultProjectRoot: tmp });
      registerWriterV2SettleListener(h.pipeline.scheduler, { dataDir: tmp });
      const continued = await continueWriterRunV2(
        { scheduler: h.pipeline.scheduler, dataDir: tmp },
        room.id,
      );
      expect(continued.status).toBe('RUNNING');
      expect(continued.phase).toBe('WRITE');
      expect(continued.study?.gap).toBe(STUDY_RESULT.gap);
    } finally {
      h?.dispose();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('Writer v2 hook loop (clarify → suggest → select)', () => {
  const deps = () => ({ scheduler: harness.pipeline.scheduler, dataDir: dir });

  async function readyPost(): Promise<string> {
    const pack = await createWriterPack(
      { title: 'Room pack', markdown: PACK_MARKDOWN, videoIds: [VIDEO_ID], channelTitle: 'Evidence' },
      dir,
    );
    await saveFormula(makeFormula(), dir);
    const post = await createWriterPostV2(deps());
    await updateWriterPostV2(deps(), post.id, {
      channelId: 'finance',
      brief: 'Vì sao lương tăng mà vẫn hết tiền',
      title: 'Lương tăng, quyền chọn giảm',
      packId: pack.id,
      generalPack: 'hieu-tv.md',
      formulaId: 'formula-v2-test',
      agentId: 'codex',
      editorAgentId: 'claude',
    });
    return post.id;
  }

  test('clarify stays DRAFT, then commits questions', async () => {
    const postId = await readyPost();
    const started = await startHookClarify(deps(), postId);
    expect(started.status).toBe('DRAFT');
    expect(started.generatingHook?.step).toBe('clarify');
    expect(started.generatingHook?.attempt).toBe(1);

    const envelope = JSON.parse(
      await Bun.file(join(itemRunDir(postId, HOOK_CLARIFY_STAGE, 1), 'input', 'envelope.json')).text(),
    ) as { title: string };
    expect(envelope.title).toBe('Lương tăng, quyền chọn giảm');

    expect((await completeStage(postId, HOOK_CLARIFY_STAGE, {
      questions: ['Video này nói với ai?', 'Món nợ mở bài là gì?'],
    }, 1)).outcome).toBe('COMMITTED');

    const after = await waitUntil(
      () => getWriterRunV2(postId, dir),
      (r) => r?.hookClarify?.questions?.length === 2 && !r.generatingHook,
    );
    expect(after!.status).toBe('DRAFT');
    expect(after!.hookClarify!.questions).toEqual(['Video này nói với ai?', 'Món nợ mở bài là gì?']);
  });

  test('suggest writes 3–5 candidates; select pins one; STUDY envelope carries it', async () => {
    const postId = await readyPost();
    await startHookClarify(deps(), postId);
    await completeStage(postId, HOOK_CLARIFY_STAGE, {
      questions: ['Ai xem?', 'Góc nào?'],
    }, 1);
    await waitUntil(() => getWriterRunV2(postId, dir), (r) => Boolean(r?.hookClarify));

    const suggesting = await startHookSuggest(deps(), postId, ['Người đi làm', 'Câu hỏi tự soi']);
    expect(suggesting.status).toBe('DRAFT');
    expect(suggesting.generatingHook?.step).toBe('suggest');
    const lib = await Bun.file(
      join(itemRunDir(postId, HOOK_SUGGEST_STAGE, 2), 'input', 'hook-library.md'),
    ).text();
    expect(lib).toContain('Hook đối thủ');

    await completeStage(postId, HOOK_SUGGEST_STAGE, {
      candidates: [
        { id: 'h1', type: 'direct-question', text: 'Bạn có bao giờ tính tổng khoản cố định chưa?' },
        { id: 'h2', type: 'crisis-by-hour', text: 'Hai giờ sáng, một người mở app ngân hàng.' },
        { id: 'h3', type: 'forked-paths', text: 'Hai người cùng lương mười năm trước.' },
      ],
    }, 2);
    const listed = await waitUntil(
      () => getWriterRunV2(postId, dir),
      (r) => (r?.hookCandidates?.length ?? 0) === 3 && !r?.generatingHook,
    );
    expect(listed!.status).toBe('DRAFT');

    const picked = await selectHook(dir, postId, 'h1');
    expect(picked.selectedHook).toEqual({
      id: 'h1',
      type: 'direct-question',
      typeLabel: 'Câu hỏi trực diện',
      text: 'Bạn có bao giờ tính tổng khoản cố định chưa?',
    });

    const started = await runWriterRoomV2(deps(), postId);
    expect(started.phase).toBe('STUDY');
    const studyEnvelope = JSON.parse(
      await Bun.file(join(itemRunDir(postId, STUDY_STAGE, 1), 'input', 'envelope.json')).text(),
    ) as { selectedHook?: { text: string } };
    expect(studyEnvelope.selectedHook?.text).toBe('Bạn có bao giờ tính tổng khoản cố định chưa?');
    const studyPrompt = await Bun.file(join(itemRunDir(postId, STUDY_STAGE, 1), 'prompt.md')).text();
    expect(studyPrompt).toContain('Bạn có bao giờ tính tổng khoản cố định chưa?');

    await completeStage(postId, STUDY_STAGE, STUDY_RESULT);
    await waitUntil(() => getWriterRunV2(postId, dir), (r) => r?.phase === 'WRITE');
    const writeRow = await waitForLedgerRow(postId, WRITE_STAGE, 1);
    const writeSettled = waitForSettled(harness.pipeline.scheduler, WRITE_STAGE, 1);
    harness.workflow.turnComplete(Number(writeRow.turnId), { exitCode: -1 });
    await writeSettled;
  });

  test('changing title clears hook state; failed suggest does not fail the post', async () => {
    const postId = await readyPost();
    const post = (await getWriterRunV2(postId, dir))!;
    post.selectedHook = {
      id: 'h1', type: 'direct-question', typeLabel: 'Câu hỏi trực diện', text: 'hook cũ',
    };
    post.hookClarify = { questions: ['x?'], answers: ['y'] };
    await saveWriterRunV2(post, dir);

    await updateWriterPostV2(deps(), postId, {
      channelId: 'finance',
      brief: post.brief,
      title: 'Title mới hoàn toàn',
      packId: post.packId,
      generalPack: post.generalPackPath,
      formulaId: post.formulaId,
      agentId: post.agentId,
      editorAgentId: post.editorAgentId,
    });
    const cleared = (await getWriterRunV2(postId, dir))!;
    expect(cleared.selectedHook).toBeUndefined();
    expect(cleared.hookClarify).toBeUndefined();

    await startHookClarify(deps(), postId);
    await completeStage(postId, HOOK_CLARIFY_STAGE, { questions: ['Ai?'] }, 1);
    await waitUntil(() => getWriterRunV2(postId, dir), (r) => Boolean(r?.hookClarify));
    await startHookSuggest(deps(), postId, ['Người đi làm']);
    const row = await waitForLedgerRow(postId, HOOK_SUGGEST_STAGE, 2);
    const settled = waitForSettled(harness.pipeline.scheduler, HOOK_SUGGEST_STAGE, 2);
    harness.workflow.turnComplete(Number(row.turnId), { exitCode: -1 });
    expect((await settled).outcome).toBe('FAILED');
    const after = await waitUntil(() => getWriterRunV2(postId, dir), (r) => r?.hookError !== undefined);
    expect(after!.status).toBe('DRAFT');
    expect(after!.generatingHook).toBeUndefined();
    expect(after!.hookError!.code).toBe('AGENT_EXIT');
  });

  test('recoverInterruptedHooks commits a finished clarify result', async () => {
    const postId = await readyPost();
    await startHookClarify(deps(), postId);
    await Bun.write(
      join(itemRunDir(postId, HOOK_CLARIFY_STAGE, 1), 'out', 'result.json'),
      JSON.stringify({ questions: ['Còn thiếu góc nào?'] }),
    );
    const stuck = (await getWriterRunV2(postId, dir))!;
    expect(stuck.generatingHook?.step).toBe('clarify');
    await recoverInterruptedHooks(dir);
    const rescued = (await getWriterRunV2(postId, dir))!;
    expect(rescued.status).toBe('DRAFT');
    expect(rescued.generatingHook).toBeUndefined();
    expect(rescued.hookClarify?.questions).toEqual(['Còn thiếu góc nào?']);

    const row = await waitForLedgerRow(postId, HOOK_CLARIFY_STAGE, 1);
    const settled = waitForSettled(harness.pipeline.scheduler, HOOK_CLARIFY_STAGE, 1);
    harness.workflow.turnComplete(Number(row.turnId), { exitCode: -1 });
    await settled;
  });
});
