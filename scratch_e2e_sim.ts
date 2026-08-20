/**
 * E2E simulation — kiểm chứng luồng Writer v2 bằng CODE SẢN XUẤT THẬT + DỮ LIỆU THẬT.
 *
 * Không mock validator/gate/store nào. Chỉ mô phỏng phần agent: thay vì PTY thật,
 * script này ghi `out/result.json` bằng artifact THẬT của run d638638b (Bẫy trả góp,
 * DONE 16/08) rồi gọi `workflow.turnComplete` — đúng pattern fake-bridge của test suite.
 *
 * Kiểm chứng 4 nhánh:
 *   1. Happy path đầy đủ: STUDY → WRITE → GATE → EDIT_REVIEW → REPAIR → GATE → DONE
 *   2. Race staging: phase='WRITE' được save TRƯỚC khi dispatchWrite ghi input files?
 *   3. Negative: script chèn nhân vật + số bịa → không bao giờ DONE (FAILED_GATE)
 *   4. Restyle daemon path (chưa từng thành công trong production) với style thật
 *
 * Chạy: bun scratch_e2e_sim.ts
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentHarness, type AgentHarness } from './packages/daemon/src/harness.ts';
import type { ItemSettledResult, LaneScheduler } from './packages/daemon/src/pipeline/lane-scheduler.ts';
import type { PipelineLedgerRow } from './packages/daemon/src/pipeline/ledger.ts';
import { listJobNotifications } from './packages/daemon/src/notifications.ts';
import { getWriterRunV2, listWriterRunsV2 } from './packages/daemon/src/writer/run-store-v2.ts';
import {
  EDIT_REVIEW_STAGE,
  readStyledVersion,
  REPAIR_STAGE,
  registerWriterV2RestyleListener,
  registerWriterV2SettleListener,
  RESTYLE_STAGE,
  startRestyle,
  startWriterRunV2,
  STUDY_STAGE,
  WRITE_STAGE,
  WRITER_V2_ITEM_ID,
} from './packages/daemon/src/writer/writer-run-v2.ts';

const DATA = join(import.meta.dir, 'writer-room-data');
const REAL_RUN_ID = 'd638638b-9c86-45b9-8b7c-b790349ea81b';
const PACK_ID = '0fd69d20-0629-4151-a5f8-94534ff3b3f2';
const FORMULA_ID = '1c95764f-6921-4f5c-a135-7ff5b6351c6f';

// ---- sandbox data root, seeded with REAL assets ------------------------------
const dir = mkdtempSync(join(tmpdir(), 'wr-e2e-sim-'));
for (const [src, dst] of [
  [join(DATA, 'general-packs', 'hieu-tv.md'), join(dir, 'general-packs', 'hieu-tv.md')],
  [join(DATA, 'channel-styles', 'soi-tai-chinh.md'), join(dir, 'channel-styles', 'soi-tai-chinh.md')],
  [join(DATA, 'training', 'formulas', `${FORMULA_ID}.json`), join(dir, 'training', 'formulas', `${FORMULA_ID}.json`)],
  [join(DATA, 'exports', 'writer', `${PACK_ID}.json`), join(dir, 'exports', 'writer', `${PACK_ID}.json`)],
  [join(DATA, 'exports', 'writer', `${PACK_ID}.md`), join(dir, 'exports', 'writer', `${PACK_ID}.md`)],
] as const) {
  mkdirSync(join(dst, '..'), { recursive: true });
  cpSync(src, dst);
}

const real = JSON.parse(readFileSync(join(DATA, 'writer', 'runs-v2', `${REAL_RUN_ID}.json`), 'utf8')) as {
  brief: string; requestedTitle?: string; targetWords: number;
  study: { coverageMap: unknown[]; gap: string; outline: unknown; factsLedger: Array<{ quote: string }> };
  draft: { title: string; script: string; outlineChanges: string[]; beatAnchors: string[] };
  editorDefects: Array<Record<string, unknown>>;
  finalScript: string;
};

// ---- harness (same fake-bridge as the test suite) ----------------------------
const harness: AgentHarness = await createAgentHarness({ dataDir: dir, defaultProjectRoot: dir });
registerWriterV2SettleListener(harness.pipeline.scheduler, { dataDir: dir });
registerWriterV2RestyleListener(harness.pipeline.scheduler, { dataDir: dir });

const results: string[] = [];
const ok = (label: string, pass: boolean, detail = '') => {
  results.push(`${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  console.log(results.at(-1));
};

function itemRunDir(batchId: string, stage: string, attempt = 1): string {
  return join(dir, 'workspaces', 'pipeline', batchId, WRITER_V2_ITEM_ID, 'attempts', String(attempt), stage);
}
async function waitUntil<T>(fn: () => Promise<T> | T, pred: (v: T) => boolean, timeoutMs = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (pred(v)) return v;
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
async function waitForLedgerRow(batchId: string, stage: string, attempt = 1): Promise<PipelineLedgerRow> {
  return (await waitUntil(
    () => harness.pipeline.ledger.all().find((r) =>
      r.batchId === batchId && r.itemId === WRITER_V2_ITEM_ID && r.stage === stage && r.attempt === attempt),
    (r) => r !== undefined,
  ))!;
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
async function completeStage(runId: string, stage: string, result: unknown, attempt = 1): Promise<ItemSettledResult> {
  const row = await waitForLedgerRow(runId, stage, attempt);
  await Bun.write(join(itemRunDir(runId, stage, attempt), 'out', 'result.json'), JSON.stringify(result));
  const settled = waitForSettled(harness.pipeline.scheduler, stage, attempt);
  harness.workflow.turnComplete(Number(row.turnId), { exitCode: 0 });
  return settled;
}
async function startRun(): Promise<string> {
  const run = await startWriterRunV2(
    { scheduler: harness.pipeline.scheduler, dataDir: dir },
    {
      brief: real.brief,
      title: real.requestedTitle,
      packId: PACK_ID,
      generalPack: 'hieu-tv.md',
      formulaId: FORMULA_ID,
      agentId: 'codex',
      targetWords: real.targetWords,
    },
  );
  return run.id;
}

try {
  // ================= NHÁNH 1 + 2: happy path với artifact THẬT =================
  console.log('\n== Nhánh 1: happy path (artifact thật của run d638638b) ==');
  const runId = await startRun();
  const r0 = (await getWriterRunV2(runId, dir))!;
  ok('startWriterRunV2 pin hash', r0.generalPackHash?.length === 64 && r0.formulaHash?.length === 64,
    `packVersion=${r0.generalPackVersion} formulaVersion=${r0.formulaVersion}`);
  ok('topic-pack.md staged cho STUDY',
    existsSync(join(itemRunDir(runId, STUDY_STAGE), 'input', 'topic-pack.md')));

  const sStudy = await completeStage(runId, STUDY_STAGE, real.study);
  ok('STUDY commit + validate (34 facts thật)', sStudy.outcome === 'COMMITTED', `outcome=${sStudy.outcome} ${sStudy.errorCode ?? ''}`);

  // Race probe: ngay khoảnh khắc phase='WRITE' xuất hiện, input đã staged chưa?
  await waitUntil(() => getWriterRunV2(runId, dir), (r) => r?.phase === 'WRITE');
  const stagedAtFlip = existsSync(join(itemRunDir(runId, WRITE_STAGE), 'input', 'general-pack.md'));
  ok('RACE PROBE: general-pack.md đã tồn tại đúng lúc phase flip sang WRITE', stagedAtFlip,
    stagedAtFlip ? 'không race lần này' : 'TÁI HIỆN race của test e2e: phase save trước khi staging xong');
  await waitUntil(() => existsSync(join(itemRunDir(runId, WRITE_STAGE), 'input', 'general-pack.md')), (v) => v);

  const sWrite = await completeStage(runId, WRITE_STAGE, real.draft);
  ok('WRITE commit + validate draft thật (2624 từ)', sWrite.outcome === 'COMMITTED', `outcome=${sWrite.outcome} ${sWrite.errorCode ?? ''} ${sWrite.errorReason ?? ''}`);

  const afterGate = await waitUntil(() => getWriterRunV2(runId, dir), (r) => (r?.gateResults.length ?? 0) >= 1);
  const g1 = afterGate!.gateResults[0]!;
  ok('GATE lớp 0 trên bản final thật', g1.passed,
    g1.passed ? '0 violation' : JSON.stringify(g1.violations.map((v: { code: string; quote?: string }) => `${v.code}:${(v.quote ?? '').slice(0, 40)}`)));

  await waitUntil(() => getWriterRunV2(runId, dir), (r) => r?.phase === 'EDIT_REVIEW');
  // PHÁT HIỆN DATA: editorDefects lưu trong run được tạo trên draft TRƯỚC-repair,
  // còn run.draft là bản SAU-repair → quote có thể không còn là substring. Đo mức lệch:
  const grounded = real.editorDefects.filter((d) =>
    typeof d.quote === 'string' && real.draft.script.includes(d.quote as string));
  ok('DATA PROBE: editorDefects của run thật còn khớp draft đã lưu',
    grounded.length === real.editorDefects.length,
    `${grounded.length}/${real.editorDefects.length} defect có quote là substring của run.draft.script`);
  const defects = grounded.length > 0 ? grounded : [{
    severity: 'LOW',
    quote: real.draft.script.slice(0, real.draft.script.indexOf('.') + 1),
    note: 'defect mô phỏng: quote câu mở để ép vòng REPAIR',
  }];
  const sEdit = await completeStage(runId, EDIT_REVIEW_STAGE, { defects });
  ok(`EDIT_REVIEW commit với ${defects.length} defect grounded`, sEdit.outcome === 'COMMITTED', `${sEdit.errorCode ?? ''} ${sEdit.errorReason ?? ''}`);

  await waitUntil(() => getWriterRunV2(runId, dir), (r) => r?.phase === 'REPAIR');
  ok('4 defect (dù advisory) ép vòng REPAIR — xác nhận hành vi mọi-defect⇒repair', true);

  const sRepair = await completeStage(runId, REPAIR_STAGE, real.draft);
  ok('REPAIR commit', sRepair.outcome === 'COMMITTED', `${sRepair.errorCode ?? ''}`);

  const done = await waitUntil(() => getWriterRunV2(runId, dir), (r) => r?.status === 'DONE' || r?.status === 'FAILED_GATE');
  ok('Run kết thúc DONE, finalScript khớp draft', done!.status === 'DONE' && done!.finalScript === real.draft.script,
    `status=${done!.status} gates=${done!.gateResults.length}`);
  const notifs = await listJobNotifications(dir);
  ok('Notification writer-v2 được ghi', notifs.some((n) => n.kind === 'writer-v2' && n.jobId === runId));

  // ================= NHÁNH 4: restyle daemon path với style thật ===============
  console.log('\n== Nhánh 4: restyle daemon path (style soi-tai-chinh.md thật) ==');
  await startRestyle({ scheduler: harness.pipeline.scheduler, dataDir: dir }, runId, 'soi-tai-chinh.md');
  const restyleInput = join(itemRunDir(runId, RESTYLE_STAGE, 1), 'input');
  await waitUntil(() => existsSync(join(restyleInput, 'style.md')), (v) => v);
  ok('source.md + style.md staged', existsSync(join(restyleInput, 'source.md')));
  // Mô phỏng output restyle: đổi xưng hô "anh chị"→"anh em" (đúng luật S1 của style), giữ nguyên số
  const styledScript = real.finalScript.replaceAll('anh chị', 'anh em').replaceAll('Anh chị', 'Anh em');
  const sRestyle = await completeStage(runId, RESTYLE_STAGE, { title: 'Bản Sói Tài Chính', script: styledScript }, 1);
  ok('RESTYLE commit qua validate (word band + host leak)', sRestyle.outcome === 'COMMITTED', `${sRestyle.errorCode ?? ''} ${sRestyle.errorReason ?? ''}`);
  const afterRestyle = await waitUntil(() => getWriterRunV2(runId, dir), (r) => (r?.styled?.length ?? 0) === 1 || r?.restyleError !== undefined);
  const styledMd = await readStyledVersion(runId, 1, dir);
  ok('styled v1 ghi file + finalScript KHÔNG bị đổi',
    afterRestyle!.styled?.length === 1 && afterRestyle!.finalScript === real.draft.script && !!styledMd,
    `styledWords=${afterRestyle!.styled?.[0]?.words} err=${afterRestyle!.restyleError ?? 'none'}`);

  // ================= NHÁNH 3: script bịa không bao giờ DONE ====================
  console.log('\n== Nhánh 3: negative — chèn nhân vật + số bịa vào đúng script thật ==');
  const runB = await startRun();
  await completeStage(runB, STUDY_STAGE, real.study);
  await waitUntil(() => existsSync(join(itemRunDir(runB, WRITE_STAGE), 'input', 'general-pack.md')), (v) => v);
  const fabricated = {
    ...real.draft,
    script: real.draft.script.replace(
      'Chặng số 1:',
      'Chín giờ tối, anh Khoa 34 tuổi nhìn số dư 380.000 đồng và khoản nợ 47 triệu trong ứng dụng. Chặng số 1:',
    ),
  };
  await completeStage(runB, WRITE_STAGE, fabricated);
  const bAfterGate = await waitUntil(() => getWriterRunV2(runB, dir), (r) => (r?.gateResults.length ?? 0) >= 1);
  const gB = bAfterGate!.gateResults[0]!;
  ok('GATE đỏ với nhân vật/số bịa', !gB.passed,
    JSON.stringify(gB.violations.map((v: { code: string }) => v.code)));
  await waitUntil(() => getWriterRunV2(runB, dir), (r) => r?.phase === 'EDIT_REVIEW');
  await completeStage(runB, EDIT_REVIEW_STAGE, { defects: [] }); // editor "bỏ lọt" — gate vẫn phải chặn
  await waitUntil(() => getWriterRunV2(runB, dir), (r) => r?.phase === 'REPAIR');
  await completeStage(runB, REPAIR_STAGE, fabricated); // repair vẫn giữ đoạn bịa
  const endB = await waitUntil(() => getWriterRunV2(runB, dir), (r) => r?.status !== 'RUNNING');
  ok('Run bịa kết thúc FAILED_GATE, không có finalScript', endB!.status === 'FAILED_GATE' && !endB!.finalScript,
    `status=${endB!.status}`);

  // ================= tổng kết ==================================================
  const summaries = await listWriterRunsV2(dir);
  console.log(`\n== Tổng kết: ${summaries.length} run trong store mô phỏng ==`);
  const fails = results.filter((r) => r.startsWith('FAIL'));
  console.log(`\n${results.length - fails.length}/${results.length} PASS${fails.length ? `\n${fails.join('\n')}` : ''}`);
} finally {
  harness.dispose();
  rmSync(dir, { recursive: true, force: true });
}
