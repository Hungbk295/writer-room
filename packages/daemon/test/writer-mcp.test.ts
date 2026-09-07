/**
 * Writer MCP (plan writer-external-orchestrator §3 A4).
 *
 * Same real-harness setup as `test/writer/writer-run-v2.test.ts`: every stage
 * dispatches a REAL turn through the real `LaneScheduler`/`TeamWorkflow`; the
 * test plays the external orchestrator through the MCP tools only, hand-writes
 * `out/result.json`, and reports the exit code. The settle machine and the
 * validators are production code.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentHarness, type AgentHarness } from '../src/harness.ts';
import { createWriterPack } from '../src/writer-packs.ts';
import { McpWriterServer, WRITER_MCP_TOOL_NAMES } from '../src/writer-mcp.ts';
import { registerWriterV2HookListener } from '../src/writer/hook-board.ts';
import { getWriterRunV2, saveWriterRunV2 } from '../src/writer/run-store-v2.ts';
import { createChannelProfile } from '../src/writer/channel-profile.ts';
import { HUMAN_PACK_GESTURE_IDS } from '../src/writer/human-pack.ts';
import { WRITER_BEAT_MODES, WRITER_BEAT_TURNS } from '../src/writer/video-plan.ts';
import {
  registerWriterV2PostmortemListener,
  registerWriterV2RestyleListener,
  registerWriterV2SettleListener,
  STUDY_STAGE,
  WRITE_STAGE,
  type WriterRunV2,
  type WriterV2CurrentTurn,
} from '../src/writer/writer-run-v2.ts';

let dir = '';
let harness: AgentHarness;
let server: McpWriterServer;
let info: { url: string; token: string };

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

const MODE_PACK_MARKDOWN = [
  '# Mode pack (test fixture)',
  '<!-- version: 1 -->',
  '',
  ...WRITER_BEAT_MODES.map((mode) => `## Mode: ${mode} — Tên\n**Phải có:** x. **Cấm:** y.\n`),
  ...WRITER_BEAT_TURNS.map((turn) => `## Phép lật: ${turn} — Tên\nGhi chú.\n`),
].join('\n');

const HUMAN_PACK_MARKDOWN = [
  '# Human pack (test fixture)',
  '<!-- version: 1 -->',
  '',
  ...HUMAN_PACK_GESTURE_IDS.map((id) => `## Cử chỉ: ${id} — Tên\nGhi chú.\n`),
].join('\n');

const OUTLINE = {
  coreInsight: 'Chi phí cố định quyết định quyền lựa chọn, không phải mức lương',
  memoryAnchor: { kind: 'contrast' as const, value: 'lương tăng vs quyền chọn giảm' },
  frame: { kind: 'con-so' as const, value: 'khoản chi phí cố định hằng tháng' },
  progression: [
    {
      beat: 'mở', newInformation: 'đặt câu hỏi ngân sách', characterOrArgumentChange: 'a', visualAnchor: 'b',
      mode: 'canh' as const, turn: 'doi-thoi-diem' as const,
      familiarObject: 'bảng sao kê ngân hàng cuối tháng', whyNotEarlier: 'chưa có con số để neo câu hỏi',
    },
    {
      beat: 'giữa', newInformation: 'cố định phình', characterOrArgumentChange: 'c', visualAnchor: 'd',
      mode: 'mo-so' as const, turn: 'doi-thang' as const,
      familiarObject: 'khoản trả góp hằng tháng', whyNotEarlier: 'cần cảnh mở trước để con số có bối cảnh',
    },
  ],
  endingPayoff: {
    resolvesOpening: 'quay lại câu hỏi mở', audienceCanDo: 'trừ nghĩa vụ khỏi thu nhập',
    directAnswer: 'có, lương tăng vẫn đủ sống',
    reframedQuestion: 'quyền lựa chọn của bạn còn lại bao nhiêu sau các khoản cố định?',
  },
  cutList: ['mẹo đầu tư'],
};

const STUDY_RESULT = {
  coverageMap: [{
    videoId: VIDEO_ID, mainClaim: 'các nguyên tắc chi tiêu', angle: 'nguyên tắc',
    sequence: ['canh', 'mo-so', 'phan-bac'] as const,
  }],
  gap: 'chưa video nào nói về việc mất quyền lựa chọn khi chi phí cố định phình',
  outline: OUTLINE,
  factsLedger: [
    { fact: 'nguyên tắc chi tiêu gắn với việc biết mình trả cho cái gì', videoId: VIDEO_ID, quote: PACK_QUOTE },
    { fact: 'ít người tính tổng khoản cố định', videoId: VIDEO_ID, quote: PACK_QUOTE_2 },
    { fact: 'mốc 25 lần chi phí năm', videoId: VIDEO_ID, quote: PACK_QUOTE_3 },
  ],
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wr-writer-mcp-'));
  harness = await createAgentHarness({ dataDir: dir, defaultProjectRoot: dir });
  registerWriterV2SettleListener(harness.pipeline.scheduler, { dataDir: dir });
  registerWriterV2RestyleListener(harness.pipeline.scheduler, { dataDir: dir });
  registerWriterV2PostmortemListener(harness.pipeline.scheduler, { dataDir: dir });
  registerWriterV2HookListener(harness.pipeline.scheduler, { dataDir: dir });
  mkdirSync(join(dir, 'hook-libraries'), { recursive: true });
  writeFileSync(
    join(dir, 'hook-libraries', 'anh-ba-ong-chu.md'),
    '# Hook đối thủ\n<!-- version: 1 -->\n\nKhung crisis-by-hour, forked-paths, stat-open.\n',
    'utf8',
  );
  await createChannelProfile({ id: 'finance', displayName: 'Kênh Tài chính', topic: 'Tài chính cá nhân' }, dir);
  mkdirSync(join(dir, 'writer'), { recursive: true });
  writeFileSync(join(dir, 'writer', 'mode-pack.md'), MODE_PACK_MARKDOWN, 'utf8');
  writeFileSync(join(dir, 'writer', 'human-pack.md'), HUMAN_PACK_MARKDOWN, 'utf8');
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
  server = new McpWriterServer({
    scheduler: harness.pipeline.scheduler,
    workflow: harness.workflow,
    dataDir: dir,
    health: () => ({ ok: true, agents: harness.listAgents().length, spyMcp: false }),
  });
  info = await server.start();
});

afterEach(() => {
  server.stop();
  harness.dispose();
  rmSync(dir, { recursive: true, force: true });
});

async function callMcp(id: number, method: string, params?: Record<string, unknown>) {
  const response = await fetch(info.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    result: {
      isError?: boolean;
      content?: Array<{ text: string }>;
      tools?: Array<{ name: string; inputSchema: Record<string, unknown> }>;
    };
    error?: { code: number; message: string };
  }>;
}

let nextId = 1;

/** `tools/call` → parsed JSON text of the first content block, plus `isError`. */
async function callTool<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; body: T }> {
  const rpc = await callMcp(nextId++, 'tools/call', { name, arguments: args });
  expect(rpc.error).toBeUndefined();
  const text = rpc.result.content?.[0]?.text ?? '';
  return { isError: rpc.result.isError === true, body: JSON.parse(text) as T };
}

async function createExternalPost(packId: string, substrate: 'external' | 'terminal' = 'external'): Promise<WriterRunV2> {
  const created = await callTool<WriterRunV2>('writer_post_create', {
    channelId: 'finance',
    brief: 'Vì sao lương tăng mà vẫn hết tiền',
    title: 'Lương tăng, quyền chọn giảm',
    packId,
    generalPack: 'hieu-tv.md',
    substrate,
  });
  expect(created.isError).toBe(false);
  return created.body;
}

async function seedSelectedHook(postId: string): Promise<void> {
  const post = (await getWriterRunV2(postId, dir))!;
  post.selectedHook = {
    id: 'h1',
    type: 'direct-question',
    typeLabel: 'Câu hỏi trực diện',
    text: 'Bạn có bao giờ tính tổng khoản cố định chưa?',
  };
  await saveWriterRunV2(post, dir);
}

async function makePack(): Promise<string> {
  const pack = await createWriterPack(
    { title: 'Hieu pack', markdown: PACK_MARKDOWN, videoIds: [VIDEO_ID], channelTitle: 'Hieu Nguyen' },
    dir,
  );
  return pack.id;
}

type StageNext = {
  turn: {
    turnId: number; stage: string; attempt: number; agentId: string; cloneId: string; itemRunDir: string;
    promptPath: string; resultPath: string; assignmentText: string; startedAt: string; deadlineAt: string;
  } | null;
  turns: Array<NonNullable<StageNext['turn']>>;
  phase: string;
  status: string;
};

type Snapshot = WriterRunV2 & { currentTurn: WriterV2CurrentTurn | null; progressPercent: number; timedOut?: boolean };

describe('Writer MCP — transport', () => {
  test('tools/list exposes exactly the 17 catalog tools, each with an object inputSchema', async () => {
    const listed = await callMcp(1, 'tools/list');
    const names = listed.result.tools!.map((tool) => tool.name);
    expect(names).toEqual([...WRITER_MCP_TOOL_NAMES]);
    expect(names).toHaveLength(17);
    for (const tool of listed.result.tools!) expect(tool.inputSchema['type']).toBe('object');
  });

  test('initialize names the server writer-room-writer', async () => {
    const init = await callMcp(2, 'initialize', { protocolVersion: '2025-03-26' });
    expect((init.result as unknown as { serverInfo: { name: string } }).serverInfo.name).toBe('writer-room-writer');
  });

  test('wrong token → 401', async () => {
    const response = await fetch(info.url, {
      method: 'POST',
      headers: { Authorization: 'Bearer nope', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);
  });

  test('writer_health reports the injected health', async () => {
    const health = await callTool<{ ok: boolean; agents: number; spyMcp: boolean }>('writer_health');
    expect(health.isError).toBe(false);
    expect(health.body).toEqual({ ok: true, agents: harness.listAgents().length, spyMcp: false });
  });

  test('every tools/call appends one JSONL line to writer/mcp-calls.jsonl (ok and error alike)', async () => {
    await callTool('writer_health');
    await callTool('writer_status', { runId: 'no-such-run' });
    const lines = (await Bun.file(join(dir, 'writer', 'mcp-calls.jsonl')).text()).trim().split('\n');
    const entries = lines.map((line) => JSON.parse(line) as { tool: string; ok: boolean; errorCode?: string; runId?: string; ms: number; at: string });
    const health = entries.find((e) => e.tool === 'writer_health');
    const status = entries.find((e) => e.tool === 'writer_status');
    expect(health?.ok).toBe(true);
    expect(typeof health?.ms).toBe('number');
    expect(status?.ok).toBe(false);
    expect(status?.errorCode).toBe('RUN_NOT_FOUND');
    expect(status?.runId).toBe('no-such-run');
  });

  test('unknown tool → JSON-RPC -32602; missing argument → isError INVALID_INPUT', async () => {
    const unknown = await callMcp(3, 'tools/call', { name: 'writer_nope', arguments: {} });
    expect(unknown.error?.code).toBe(-32602);
    const missing = await callTool<{ errorCode: string }>('writer_status', {});
    expect(missing.isError).toBe(true);
    expect(missing.body.errorCode).toBe('INVALID_INPUT');
    const gone = await callTool<{ errorCode: string }>('writer_status', { runId: 'no-such-run' });
    expect(gone.isError).toBe(true);
    expect(gone.body.errorCode).toBe('RUN_NOT_FOUND');
  });
});

describe('Writer MCP — post → run → external STUDY turn', () => {
  test('writer_post_create (external) is a READY draft; writer_stage_next is null while DRAFT', async () => {
    const packId = await makePack();
    const packs = await callTool<{ packs: Array<{ id: string }> }>('writer_packs_list');
    expect(packs.body.packs.map((p) => p.id)).toContain(packId);

    const post = await createExternalPost(packId);
    expect(post.status).toBe('DRAFT');
    expect(post.phase).toBe('READY');
    expect(post.substrate).toBe('external');
    expect(post.agentId).toBe('claude');
    expect(post.editorAgentId).toBe('codex');

    const next = await callTool<StageNext>('writer_stage_next', { runId: post.id });
    expect(next.isError).toBe(false);
    expect(next.body).toEqual({ turn: null, turns: [], phase: 'READY', status: 'DRAFT' });

    const hooks = await callTool<{ selectedHook: unknown; hookCandidates: unknown[] }>('writer_hook_candidates', { postId: post.id });
    expect(hooks.body.selectedHook).toBeNull();
    expect(hooks.body.hookCandidates).toEqual([]);
    expect(harness.pipeline.scheduler.getLiveCloneCount()).toBe(0);
  });

  test('writer_post_configure keeps omitted fields and only changes what is passed', async () => {
    const packId = await makePack();
    const post = await createExternalPost(packId);
    const configured = await callTool<WriterRunV2>('writer_post_configure', { postId: post.id, targetWords: 1234 });
    expect(configured.isError).toBe(false);
    expect(configured.body.targetWords).toBe(1234);
    expect(configured.body.requestedTitle).toBe('Lương tăng, quyền chọn giảm');
    expect(configured.body.packId).toBe(packId);
    expect(configured.body.substrate).toBe('external');
    expect(configured.body.phase).toBe('READY');
  });

  test(
    'run_start → wait turn → stage_next STUDY → result.json → stage_complete → wait phase → WRITE turn open',
    async () => {
      const packId = await makePack();
      const post = await createExternalPost(packId);
      await seedSelectedHook(post.id);

      const started = await callTool<Snapshot>('writer_run_start', { postId: post.id });
      expect(started.isError).toBe(false);
      expect(started.body.status).toBe('RUNNING');
      expect(started.body.phase).toBe('STUDY');

      const waited = await callTool<Snapshot>('writer_wait', { runId: post.id, until: 'turn', timeoutSec: 10 });
      expect(waited.isError).toBe(false);
      expect(waited.body.timedOut).toBe(false);
      expect(waited.body.currentTurn?.stage).toBe(STUDY_STAGE);

      const next = await callTool<StageNext>('writer_stage_next', { runId: post.id });
      expect(next.body.phase).toBe('STUDY');
      const turn = next.body.turn!;
      expect(turn.stage).toBe(STUDY_STAGE);
      expect(turn.attempt).toBe(1);
      // Template id of the writer agent — `1devtool-agent run --to=<agentId>` targets it.
      expect(turn.agentId).toBe('claude');
      expect(turn.cloneId).toMatch(/^claude/);
      expect(existsSync(turn.itemRunDir)).toBe(true);
      expect(turn.promptPath).toBe(join(turn.itemRunDir, 'prompt.md'));
      expect(existsSync(turn.promptPath)).toBe(true);
      expect(turn.resultPath).toBe(join(turn.itemRunDir, 'out', 'result.json'));
      expect(turn.assignmentText.length).toBeGreaterThan(0);

      // The orchestrator's progress note lands on the run's timeline.
      const noted = await callTool<{ ok: boolean }>('writer_stage_progress', {
        runId: post.id, turnId: turn.turnId, text: 'đã mở agent STUDY', external: { terminalId: 'term-1' },
      });
      expect(noted.body).toEqual({ ok: true });
      const afterNote = await callTool<Snapshot>('writer_status', { runId: post.id });
      expect(afterNote.body.timeline?.at(-1)).toMatchObject({
        kind: 'external', turnId: turn.turnId, stage: STUDY_STAGE, text: 'đã mở agent STUDY', external: { terminalId: 'term-1' },
      });
      expect(afterNote.body.currentTurn).toMatchObject({ turnId: turn.turnId, stage: STUDY_STAGE, external: { terminalId: 'term-1' } });

      await Bun.write(turn.resultPath, JSON.stringify(STUDY_RESULT));
      const completed = await callTool<{ ok: boolean; turnId: number }>('writer_stage_complete', {
        runId: post.id, turnId: turn.turnId, exitCode: 0, external: { terminalId: 'term-1' },
      });
      expect(completed.isError).toBe(false);
      expect(completed.body).toEqual({ ok: true, turnId: turn.turnId });

      const phased = await callTool<Snapshot>('writer_wait', { runId: post.id, until: 'phase', fromPhase: 'STUDY', timeoutSec: 20 });
      expect(phased.body.timedOut).toBe(false);
      expect(phased.body.phase).toBe('WRITE');
      expect(phased.body.status).toBe('RUNNING');
      expect(phased.body.study?.gap).toBe(STUDY_RESULT.gap);

      // Phase flips before the WRITE turn is registered; wait for the turn itself.
      const writeTurn = await callTool<Snapshot>('writer_wait', { runId: post.id, until: 'turn', timeoutSec: 20 });
      expect(writeTurn.body.timedOut).toBe(false);
      const status = await callTool<Snapshot>('writer_status', { runId: post.id });
      expect(status.body.phase).toBe('WRITE');
      expect(status.body.currentTurn?.stage).toBe(WRITE_STAGE);
      expect(status.body.timeline!.length).toBeLessThanOrEqual(10);
      expect((await callTool<StageNext>('writer_stage_next', { runId: post.id })).body.turn?.stage).toBe(WRITE_STAGE);

      // No script yet: get_script is a domain error, not a crash.
      const script = await callTool<{ errorCode: string }>('writer_get_script', { runId: post.id });
      expect(script.isError).toBe(true);
      expect(script.body.errorCode).toBe('INVALID_STATE');
    },
    30_000,
  );

  test('writer_wait until:terminal times out on a running run and says so', async () => {
    const packId = await makePack();
    const post = await createExternalPost(packId);
    await seedSelectedHook(post.id);
    await callTool('writer_run_start', { postId: post.id });
    const waited = await callTool<Snapshot>('writer_wait', { runId: post.id, until: 'terminal', timeoutSec: 0 });
    expect(waited.isError).toBe(false);
    expect(waited.body.timedOut).toBe(true);
    expect(waited.body.status).toBe('RUNNING');
    const bad = await callTool<{ errorCode: string }>('writer_wait', { runId: post.id, until: 'never' });
    expect(bad.isError).toBe(true);
    expect(bad.body.errorCode).toBe('INVALID_INPUT');
  });

  test('writer_stage_complete with an unknown turnId → TURN_NOT_OPEN', async () => {
    const packId = await makePack();
    const post = await createExternalPost(packId);
    await seedSelectedHook(post.id);
    await callTool('writer_run_start', { postId: post.id });
    const next = await callTool<StageNext>('writer_stage_next', { runId: post.id });
    const wrong = await callTool<{ errorCode: string; reason: string }>('writer_stage_complete', {
      runId: post.id, turnId: next.body.turn!.turnId + 1000, exitCode: 0,
    });
    expect(wrong.isError).toBe(true);
    expect(wrong.body.errorCode).toBe('TURN_NOT_OPEN');
    expect(wrong.body.reason).toContain('không mở');
    // The real turn is still open.
    expect((await callTool<StageNext>('writer_stage_next', { runId: post.id })).body.turn?.turnId).toBe(next.body.turn!.turnId);
  });

  test('writer_stage_complete on a terminal-substrate run → SUBSTRATE_NOT_EXTERNAL', async () => {
    const packId = await makePack();
    const post = await createExternalPost(packId, 'terminal');
    expect(post.substrate).toBe('terminal');
    await seedSelectedHook(post.id);
    await callTool('writer_run_start', { postId: post.id });
    const next = await callTool<StageNext>('writer_stage_next', { runId: post.id });
    expect(next.body.turn?.stage).toBe(STUDY_STAGE);
    const refused = await callTool<{ errorCode: string }>('writer_stage_complete', {
      runId: post.id, turnId: next.body.turn!.turnId, exitCode: 0,
    });
    expect(refused.isError).toBe(true);
    expect(refused.body.errorCode).toBe('SUBSTRATE_NOT_EXTERNAL');
  });

  test('writer_run_start on a post without a hook → INVALID_STATE, nothing dispatched', async () => {
    const packId = await makePack();
    const post = await createExternalPost(packId);
    const refused = await callTool<{ errorCode: string; reason: string }>('writer_run_start', { postId: post.id });
    expect(refused.isError).toBe(true);
    expect(refused.body.errorCode).toBe('INVALID_STATE');
    expect(refused.body.reason).toMatch(/Chưa chọn hook/);
    expect(harness.pipeline.scheduler.getLiveCloneCount()).toBe(0);
  });
});
