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
import type { ItemSettledResult, LaneScheduler } from '../../src/pipeline/lane-scheduler.ts';
import type { PipelineLedgerRow } from '../../src/pipeline/ledger.ts';
import { listJobNotifications } from '../../src/notifications.ts';
import { saveFormula } from '../../src/training/storage.ts';
import { createWriterPack } from '../../src/writer-packs.ts';
import { getWriterRunV2, listWriterRunsV2, saveWriterRunV2 } from '../../src/writer/run-store-v2.ts';
import {
  continueWriterRunV2,
  EDIT_REVIEW_STAGE,
  readStyledVersion,
  REPAIR_STAGE,
  registerWriterV2RestyleListener,
  registerWriterV2SettleListener,
  RESTYLE_STAGE,
  startRestyle,
  startWriterRunV2,
  STUDY_STAGE,
  validateEditorReview,
  validateStudyArtifact,
  validateWriterV2Draft,
  WRITE_STAGE,
  WRITER_V2_ITEM_ID,
} from '../../src/writer/writer-run-v2.ts';

let dir: string;
let harness: AgentHarness;
let turnLaunches: Map<number, { mode: string; interactiveRequired?: boolean; forceHeadless: boolean }>;
let turnAgents: Map<number, string>;
let stageAgents: Map<string, string>;

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
  mkdirSync(join(dir, 'channel-styles'), { recursive: true });
  writeFileSync(join(dir, 'channel-styles', STYLE_ID), CHANNEL_STYLE, 'utf8');
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
  expect(run.editorAgentId).not.toBe(run.agentId);
  return run.id;
}

describe('Writer v2 — STUDY validation', () => {
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

    // The large source must stay as ordinary Markdown, never as one escaped JSON
    // string line. This is the contract Claude/Codex Read can actually paginate.
    expect(await Bun.file(join(itemRunDir(runId, STUDY_STAGE), 'input', 'topic-pack.md')).text()).toBe(PACK_MARKDOWN);
    const studyEnvelope = JSON.parse(
      await Bun.file(join(itemRunDir(runId, STUDY_STAGE), 'input', 'envelope.json')).text(),
    ) as { topicPack: { contentFile: string; markdown?: string } };
    expect(studyEnvelope.topicPack.contentFile).toBe('input/topic-pack.md');
    expect(studyEnvelope.topicPack.markdown).toBeUndefined();

    expect((await completeStage(runId, STUDY_STAGE, STUDY_RESULT)).outcome).toBe('COMMITTED');
    const afterStudy = await waitUntil(() => getWriterRunV2(runId, dir), (r) => r?.phase === 'WRITE');
    expect(afterStudy!.study!.factsLedger).toHaveLength(3);
    expect(await Bun.file(join(itemRunDir(runId, WRITE_STAGE), 'input', 'general-pack.md')).text())
      .toContain('## TASTE DNA');
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

  test('editing the general pack mid-run stops the run instead of silently switching', async () => {
    const runId = await startRun();
    writeFileSync(join(dir, 'general-packs', 'hieu-tv.md'), '# Hieu TV\n<!-- version: 2 -->\n', 'utf8');
    await completeStage(runId, STUDY_STAGE, STUDY_RESULT);
    const failed = await waitUntil(() => getWriterRunV2(runId, dir), (r) => r != null && r.status !== 'RUNNING');
    expect(failed!.status).toBe('FAILED');
    expect(failed!.errorCode).toBe('GENERAL_PACK_CHANGED');
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
});
