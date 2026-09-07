/**
 * Writer MCP — the surface an EXTERNAL orchestrator (skill `writer-orchestrate`
 * on 1DevTool) uses to take a Writer v2 post from title to DONE without the app
 * (plan `writer-external-orchestrator-plan.md` §3).
 *
 * Every tool is a thin wrapper over the same functions the HTTP routes in
 * `http.ts` call, with the same deps, so behaviour is identical whichever door a
 * caller comes through. Nothing here reads or validates `out/result.json`: the
 * daemon stays the only settle machine (plan §0 decision 3).
 *
 * Transport is a copy of the `McpSpyServer` skeleton in `spy-mcp.ts` (random
 * bearer token, 127.0.0.1:0, JSON-RPC over POST). It is deliberately not shared:
 * that file belongs to another lane and each MCP keeps its own narrow surface.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { McpServerInfo } from '@writer-room/shared';
import type { LaneScheduler } from './pipeline/lane-scheduler.ts';
import type { TeamWorkflow } from './team/workflow.ts';
import { listWriterPacks } from './writer-packs.ts';
import { getWriterRunV2 } from './writer/run-store-v2.ts';
import {
  DEFAULT_AGENT_IDS,
  continueWriterRunV2,
  createWriterPostV2,
  readStyledVersion,
  runWriterRoomV2,
  startRestyle,
  updateWriterPostV2,
  withWriterV2Progress,
  type DefaultAgentId,
  type ExternalRef,
  type WriterRunV2,
  type WriterSubstrate,
  type WriterV2Phase,
} from './writer/writer-run-v2.ts';
import { selectHook, startHookClarify, startHookSuggest } from './writer/hook-board.ts';
import {
  ExternalTurnError,
  completeWriterTurn,
  getOpenWriterTurns,
  noteWriterTurnProgress,
} from './writer/external-turn.ts';
import { countScriptWords } from './writer/script-checks.ts';

const PROTOCOL_VERSION = '2025-03-26';
const SERVER_NAME = 'writer-room-writer';
const WAIT_POLL_MS = 2_000;
const WAIT_DEFAULT_SEC = 120;
const WAIT_MAX_SEC = 600;
const STATUS_TIMELINE_ENTRIES = 10;
const TERMINAL_STATUSES: ReadonlySet<WriterRunV2['status']> = new Set(['DONE', 'FAILED', 'FAILED_GATE']);

export interface WriterMcpHealth {
  ok: boolean;
  agents: number;
  spyMcp: boolean;
}

export interface McpWriterServerDeps {
  scheduler: LaneScheduler;
  workflow: TeamWorkflow;
  dataDir: string;
  /** What `writer_health` reports. Defaults to `{ ok: true, agents: 0, spyMcp: false }` for tests. */
  health?: () => WriterMcpHealth;
}

/** Tool names in catalog order (plan §3 A2). The skill `writer-orchestrate` uses exactly these. */
export const WRITER_MCP_TOOL_NAMES = [
  'writer_health',
  'writer_packs_list',
  'writer_post_create',
  'writer_post_configure',
  'writer_hook_clarify',
  'writer_hook_answer',
  'writer_hook_candidates',
  'writer_hook_select',
  'writer_run_start',
  'writer_status',
  'writer_wait',
  'writer_continue',
  'writer_stage_next',
  'writer_stage_progress',
  'writer_stage_complete',
  'writer_restyle',
  'writer_get_script',
] as const;

export type WriterMcpToolName = (typeof WRITER_MCP_TOOL_NAMES)[number];

/** Non-`ExternalTurnError` failures are mapped onto these so a caller can branch without parsing prose. */
export type WriterMcpErrorCode =
  | 'RUN_NOT_FOUND'
  | 'TURN_NOT_OPEN'
  | 'SUBSTRATE_NOT_EXTERNAL'
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'INVALID_STATE';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

type ToolArgs = Record<string, unknown>;

interface WriterToolDef {
  name: WriterMcpToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: ToolArgs) => Promise<unknown>;
}

/** Thrown by argument readers; surfaces as `INVALID_INPUT`. */
class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

// ── Argument readers ──────────────────────────────────────────────────────

function requireString(args: ToolArgs, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) throw new ToolInputError(`${key} bắt buộc (chuỗi không rỗng)`);
  return value.trim();
}

function optionalString(args: ToolArgs, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ToolInputError(`${key} phải là chuỗi`);
  return value;
}

function requireInteger(args: ToolArgs, key: string): number {
  const value = Number(args[key]);
  if (args[key] === undefined || args[key] === null || !Number.isInteger(value)) {
    throw new ToolInputError(`${key} phải là số nguyên`);
  }
  return value;
}

function optionalInteger(args: ToolArgs, key: string): number | undefined {
  if (args[key] === undefined || args[key] === null) return undefined;
  return requireInteger(args, key);
}

function optionalNumber(args: ToolArgs, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new ToolInputError(`${key} phải là số (số từ)`);
  return n;
}

function isDefaultAgentId(v: unknown): v is DefaultAgentId {
  return typeof v === 'string' && (DEFAULT_AGENT_IDS as readonly string[]).includes(v);
}

function agentIdOr(args: ToolArgs, key: string, fallback: DefaultAgentId): DefaultAgentId {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (!isDefaultAgentId(value)) {
    throw new ToolInputError(`${key} không hợp lệ — phải là một trong: ${DEFAULT_AGENT_IDS.join(', ')}`);
  }
  return value;
}

function isWriterSubstrate(v: unknown): v is WriterSubstrate {
  return v === 'terminal' || v === 'external';
}

function substrateOr(args: ToolArgs, fallback: WriterSubstrate | undefined): WriterSubstrate | undefined {
  const value = args['substrate'];
  if (value === undefined || value === null) return fallback;
  if (!isWriterSubstrate(value)) throw new ToolInputError('substrate không hợp lệ — phải là terminal hoặc external');
  return value;
}

/** `{ runId?, teamId?, memberId?, terminalId? }` — string fields only, anything else dropped (same as `http.ts`). */
function readExternalRef(v: unknown): ExternalRef | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const raw = v as Record<string, unknown>;
  const ref: ExternalRef = {};
  for (const key of ['runId', 'teamId', 'memberId', 'terminalId'] as const) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim()) ref[key] = value.trim();
  }
  return Object.keys(ref).length > 0 ? ref : undefined;
}

// ── Error mapping ─────────────────────────────────────────────────────────

/** Domain failures become `{ errorCode, reason }`; the server itself never throws to the transport. */
export function writerMcpErrorCode(err: unknown): WriterMcpErrorCode {
  if (err instanceof ExternalTurnError) return err.code;
  if (err instanceof ToolInputError) return 'INVALID_INPUT';
  const message = err instanceof Error ? err.message : String(err);
  if (/Writer v2 (post|run|room) không tồn tại/i.test(message)) return 'RUN_NOT_FOUND';
  if (/không tồn tại/i.test(message)) return 'NOT_FOUND';
  return 'INVALID_STATE';
}

const EXTERNAL_REF_SCHEMA = {
  type: 'object',
  description: 'Nơi orchestrator đang chạy turn (1DevTool run/team/member/terminal id) — chỉ để hiển thị',
  properties: {
    runId: { type: 'string' },
    teamId: { type: 'string' },
    memberId: { type: 'string' },
    terminalId: { type: 'string' },
  },
};

const AGENT_ID_SCHEMA = { type: 'string', enum: [...DEFAULT_AGENT_IDS] };

/**
 * Every `tools/call` appends one line here: the only record of what the
 * orchestrator decided and when (its own transcript lives in a 1DevTool tab).
 * Args are summarised (strings cut at 160 chars) — never the full script.
 */
export function mcpCallLogPath(dataDir: string): string {
  return join(dataDir, 'writer', 'mcp-calls.jsonl');
}

const CALL_LOG_STRING_MAX = 160;

function summarizeArgs(args: ToolArgs): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string') {
      out[key] = value.length > CALL_LOG_STRING_MAX ? `${value.slice(0, CALL_LOG_STRING_MAX)}…(${value.length})` : value;
    } else if (Array.isArray(value)) {
      out[key] = `[${value.length} items]`;
    } else if (value && typeof value === 'object') {
      out[key] = summarizeArgs(value as ToolArgs);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export interface McpCallLogEntry {
  at: string;
  tool: string;
  /** `runId` or `postId` from the args, whichever the tool takes. */
  runId?: string;
  args: Record<string, unknown>;
  ms: number;
  ok: boolean;
  errorCode?: string;
}

function appendCallLog(dataDir: string, entry: McpCallLogEntry): void {
  try {
    const path = mcpCallLogPath(dataDir);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (err) {
    // Logging must never break a tool call.
    console.warn('[writer-mcp] không ghi được mcp-calls.jsonl:', err instanceof Error ? err.message : String(err));
  }
}

/** Written next to the per-agent configs so `1devtool-agent … --mcp-config` can mount this server. */
export function orchestratorMcpConfigPath(dataDir: string): string {
  return join(dataDir, 'agents', 'mcp-orchestrator.json');
}

/** Same shape as `AgentHarness.writeMcpConfig` (`agents/index.ts`). Overwritten on every daemon start: the token changes. */
export function writeOrchestratorMcpConfig(dataDir: string, servers: Record<string, McpServerInfo>): string {
  const path = orchestratorMcpConfigPath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(
      {
        mcpServers: Object.fromEntries(Object.entries(servers).map(([name, info]) => [name, {
          type: 'http',
          url: info.url,
          headers: { Authorization: `Bearer ${info.token}` },
        }])),
      },
      null,
      2,
    ),
  );
  return path;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<JsonRpcRequest> {
  let body = '';
  for await (const chunk of req) body += String(chunk);
  return JSON.parse(body || '{}') as JsonRpcRequest;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class McpWriterServer {
  readonly token = randomBytes(24).toString('hex');
  private server: Server | null = null;
  private url = '';
  private readonly tools: Map<string, WriterToolDef>;
  private readonly deps: McpWriterServerDeps;

  constructor(deps: McpWriterServerDeps) {
    this.deps = deps;
    this.tools = new Map(this.buildTools().map((tool) => [tool.name, tool]));
  }

  info(): McpServerInfo | null {
    return this.url ? { url: this.url, token: this.token } : null;
  }

  start(): Promise<McpServerInfo> {
    if (this.server) return Promise.resolve(this.info()!);
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => void this.handle(req, res));
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') return reject(new Error('Không lấy được cổng Writer MCP'));
        this.server = server;
        this.url = `http://127.0.0.1:${address.port}/mcp`;
        resolve(this.info()!);
      });
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    this.url = '';
  }

  // ── Shared readers ────────────────────────────────────────────────────

  private runDeps(): { scheduler: LaneScheduler; dataDir: string } {
    return { scheduler: this.deps.scheduler, dataDir: this.deps.dataDir };
  }

  private async requireRun(runId: string): Promise<WriterRunV2> {
    const run = await getWriterRunV2(runId, this.deps.dataDir);
    if (!run) throw new ExternalTurnError('RUN_NOT_FOUND', `Writer v2 run không tồn tại: ${runId}`);
    return run;
  }

  /** The projection `GET /api/writer/v2/runs/:id` returns, with the timeline cut to its newest entries. */
  private statusSnapshot(run: WriterRunV2) {
    const view = withWriterV2Progress(run, this.deps.scheduler.listOpenTurns(run.id));
    return { ...view, timeline: (run.timeline ?? []).slice(-STATUS_TIMELINE_ENTRIES) };
  }

  private async status(runId: string) {
    return this.statusSnapshot(await this.requireRun(runId));
  }

  private hookView(run: WriterRunV2) {
    return {
      hookClarify: run.hookClarify ?? null,
      hookCandidates: run.hookCandidates ?? [],
      selectedHook: run.selectedHook ?? null,
      generatingHook: run.generatingHook ?? null,
      hookError: run.hookError ?? null,
    };
  }

  // ── Tool catalog ──────────────────────────────────────────────────────

  private buildTools(): WriterToolDef[] {
    const deps = this.deps;
    return [
      {
        name: 'writer_health',
        description: 'Kiểm tra daemon còn sống và MCP đã mount. Gọi đầu tiên; kết quả phải có ok: true.',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => deps.health?.() ?? { ok: true, agents: 0, spyMcp: false },
      },
      {
        name: 'writer_packs_list',
        description: 'Danh sách Source Pack (topic pack) có thể gắn vào post — nguồn sự thật duy nhất cho STUDY.',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => ({ packs: await listWriterPacks(deps.dataDir) }),
      },
      {
        name: 'writer_post_create',
        description:
          'Tạo post Writer v2 và lưu cấu hình ngay (như POST /posts rồi PUT /posts/:id). '
          + 'Mặc định substrate external, agentId claude, editorAgentId codex. Trả projection của post.',
        inputSchema: {
          type: 'object',
          properties: {
            channelId: { type: 'string', description: 'Id hồ sơ kênh' },
            brief: { type: 'string' },
            packId: { type: 'string', description: 'Id Source Pack (xem writer_packs_list)' },
            generalPack: { type: 'string', description: 'Đường dẫn general pack, vd "hieu-tv.md"' },
            title: { type: 'string' },
            audience: { type: 'string' },
            targetWords: { type: 'number', description: 'Số từ mục tiêu (≥ 200)' },
            agentId: { ...AGENT_ID_SCHEMA, description: 'Writer agent, mặc định claude' },
            editorAgentId: { ...AGENT_ID_SCHEMA, description: 'Editor agent, mặc định codex; phải khác agentId' },
            substrate: { type: 'string', enum: ['terminal', 'external'], description: 'Mặc định external' },
          },
          required: ['channelId', 'brief', 'packId', 'generalPack'],
        },
        handler: async (args) => {
          const channelId = requireString(args, 'channelId');
          const brief = requireString(args, 'brief');
          const packId = requireString(args, 'packId');
          const generalPack = requireString(args, 'generalPack');
          const agentId = agentIdOr(args, 'agentId', 'claude');
          const editorAgentId = agentIdOr(args, 'editorAgentId', 'codex');
          const substrate = substrateOr(args, 'external');
          const title = optionalString(args, 'title');
          const audience = optionalString(args, 'audience');
          const targetWords = optionalNumber(args, 'targetWords');
          const post = await createWriterPostV2(this.runDeps());
          const configured = await updateWriterPostV2(this.runDeps(), post.id, {
            channelId,
            brief,
            packId,
            generalPack,
            agentId,
            editorAgentId,
            ...(substrate ? { substrate } : {}),
            ...(title !== undefined ? { title } : {}),
            ...(audience !== undefined ? { audience } : {}),
            ...(targetWords !== undefined ? { targetWords } : {}),
          });
          return withWriterV2Progress(configured);
        },
      },
      {
        name: 'writer_post_configure',
        description:
          'Cập nhật cấu hình một post còn DRAFT (như PUT /posts/:id). Field bỏ qua giữ giá trị hiện tại của post. '
          + 'Đổi title sẽ xoá hook đã chọn.',
        inputSchema: {
          type: 'object',
          properties: {
            postId: { type: 'string' },
            channelId: { type: 'string' },
            brief: { type: 'string' },
            packId: { type: 'string' },
            generalPack: { type: 'string' },
            title: { type: 'string' },
            audience: { type: 'string' },
            targetWords: { type: 'number' },
            agentId: AGENT_ID_SCHEMA,
            editorAgentId: AGENT_ID_SCHEMA,
            substrate: { type: 'string', enum: ['terminal', 'external'], description: 'Chỉ đổi được khi còn DRAFT' },
          },
          required: ['postId'],
        },
        handler: async (args) => {
          const postId = requireString(args, 'postId');
          const current = await getWriterRunV2(postId, deps.dataDir);
          if (!current) throw new ExternalTurnError('RUN_NOT_FOUND', `Writer v2 post không tồn tại: ${postId}`);
          const title = optionalString(args, 'title') ?? current.requestedTitle;
          const audience = optionalString(args, 'audience') ?? current.audience;
          const targetWords = optionalNumber(args, 'targetWords') ?? current.targetWords;
          const substrate = substrateOr(args, undefined);
          const post = await updateWriterPostV2(this.runDeps(), postId, {
            channelId: optionalString(args, 'channelId') ?? current.channelId ?? '',
            brief: optionalString(args, 'brief') ?? current.brief,
            packId: optionalString(args, 'packId') ?? current.packId,
            generalPack: optionalString(args, 'generalPack') ?? current.generalPackPath,
            agentId: agentIdOr(args, 'agentId', current.agentId),
            editorAgentId: agentIdOr(args, 'editorAgentId', current.editorAgentId),
            ...(substrate ? { substrate } : {}),
            ...(title !== undefined ? { title } : {}),
            ...(audience !== undefined ? { audience } : {}),
            ...(targetWords !== undefined ? { targetWords } : {}),
          });
          return withWriterV2Progress(post);
        },
      },
      {
        name: 'writer_hook_clarify',
        description: 'Mở turn hook-clarify-v1: agent đặt câu hỏi làm rõ title. Post phải DRAFT, đã có title.',
        inputSchema: { type: 'object', properties: { postId: { type: 'string' } }, required: ['postId'] },
        handler: async (args) => {
          const run = await startHookClarify(this.runDeps(), requireString(args, 'postId'));
          return { generatingHook: run.generatingHook ?? null };
        },
      },
      {
        name: 'writer_hook_answer',
        description: 'Trả lời câu hỏi làm rõ rồi mở turn hook-suggest-v1 để agent đề xuất hook. Một câu trả lời cho mỗi câu hỏi, đúng thứ tự.',
        inputSchema: {
          type: 'object',
          properties: {
            postId: { type: 'string' },
            answers: { type: 'array', items: { type: 'string' } },
          },
          required: ['postId', 'answers'],
        },
        handler: async (args) => {
          const postId = requireString(args, 'postId');
          if (!Array.isArray(args['answers'])) throw new ToolInputError('answers phải là mảng chuỗi');
          const answers = args['answers'].map((a) => String(a ?? ''));
          const run = await startHookSuggest(this.runDeps(), postId, answers);
          return { generatingHook: run.generatingHook ?? null };
        },
      },
      {
        name: 'writer_hook_candidates',
        description: 'Trạng thái vòng hook của post: câu hỏi làm rõ, danh sách hook đề xuất, hook đã chọn, turn đang chạy, lỗi.',
        inputSchema: { type: 'object', properties: { postId: { type: 'string' } }, required: ['postId'] },
        handler: async (args) => this.hookView(await this.requireRun(requireString(args, 'postId'))),
      },
      {
        name: 'writer_hook_select',
        description: 'Chọn một hook trong hookCandidates theo id. Bình thường người chọn trên app; chỉ gọi khi prompt ghi hookStrategy: auto.',
        inputSchema: {
          type: 'object',
          properties: { postId: { type: 'string' }, selectedId: { type: 'string' } },
          required: ['postId', 'selectedId'],
        },
        handler: async (args) => {
          const run = await selectHook(deps.dataDir, requireString(args, 'postId'), requireString(args, 'selectedId'));
          return { selectedHook: run.selectedHook ?? null };
        },
      },
      {
        name: 'writer_run_start',
        description: 'Run một post DRAFT/READY đã chọn hook: mở turn STUDY. Trả projection với status RUNNING, phase STUDY.',
        inputSchema: { type: 'object', properties: { postId: { type: 'string' } }, required: ['postId'] },
        handler: async (args) => {
          const run = await runWriterRoomV2(this.runDeps(), requireString(args, 'postId'));
          return this.statusSnapshot(run);
        },
      },
      {
        name: 'writer_status',
        description: 'Projection của run: status, phase, progressPercent, currentTurn (turn đang mở), 10 entry timeline cuối, gateResults, errorCode.',
        inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] },
        handler: async (args) => this.status(requireString(args, 'runId')),
      },
      {
        name: 'writer_wait',
        description:
          'Chờ (poll 2 giây) tới khi: until=turn — có turn mở hoặc run kết thúc; until=phase — phase/status đổi so với fromPhase '
          + '(mặc định phase lúc gọi) hoặc run kết thúc; until=terminal — status DONE/FAILED/FAILED_GATE. '
          + 'Trả snapshot như writer_status kèm timedOut. timedOut: true là bình thường, chỉ gọi lại.',
        inputSchema: {
          type: 'object',
          properties: {
            runId: { type: 'string' },
            until: { type: 'string', enum: ['turn', 'phase', 'terminal'] },
            timeoutSec: { type: 'integer', description: `Mặc định ${WAIT_DEFAULT_SEC}, tối đa ${WAIT_MAX_SEC}` },
            fromPhase: { type: 'string', description: 'Chỉ dùng với until=phase: phase coi là "chưa đổi"' },
          },
          required: ['runId', 'until'],
        },
        handler: async (args) => this.wait(args),
      },
      {
        name: 'writer_continue',
        description: 'Tiếp tục run FAILED/RUNNING bị ngắt từ stage thích hợp (như POST /runs/:id/continue). Trả projection.',
        inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] },
        handler: async (args) => {
          const run = await continueWriterRunV2(this.runDeps(), requireString(args, 'runId'));
          return this.statusSnapshot(run);
        },
      },
      {
        name: 'writer_stage_next',
        description:
          'Các turn đang mở của run (research có thể có tối đa 5). `turn` giữ phần tử đầu để tương thích client cũ; '
          + 'client mới dùng `turns`. Agent đọc promptPath, chỉ ghi resultPath, cwd là itemRunDir.',
        inputSchema: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] },
        handler: async (args) => {
          const runId = requireString(args, 'runId');
          const opens = await getOpenWriterTurns(deps, runId);
          const run = await this.requireRun(runId);
          const project = (open: (typeof opens)[number]) => ({
            turnId: open.turnId,
            stage: open.stage,
            attempt: open.attempt,
            // `agentId` is the TEMPLATE id (`claude`, `codex`): the value an
            // external substrate passes to `1devtool-agent run --to=`.
            agentId: open.templateId,
            cloneId: open.agentId,
            itemRunDir: open.itemRunDir,
            promptPath: open.promptPath,
            resultPath: open.resultPath,
            assignmentText: open.assignmentText,
            startedAt: open.startedAt,
            deadlineAt: open.deadlineAt,
          });
          const turns = opens.map(project);
          return {
            turn: turns[0] ?? null,
            turns,
            phase: run.phase,
            status: run.status,
          };
        },
      },
      {
        name: 'writer_stage_progress',
        description: 'Ghi một note tiến độ vào timeline của run (app hiển thị). turnId nếu có phải đang mở; bỏ turnId khi turn đã đóng.',
        inputSchema: {
          type: 'object',
          properties: {
            runId: { type: 'string' },
            turnId: { type: 'integer' },
            text: { type: 'string' },
            external: EXTERNAL_REF_SCHEMA,
          },
          required: ['runId', 'text'],
        },
        handler: async (args) => {
          const runId = requireString(args, 'runId');
          const text = requireString(args, 'text');
          const turnId = optionalInteger(args, 'turnId');
          const external = readExternalRef(args['external']);
          await noteWriterTurnProgress(deps, runId, {
            text,
            ...(turnId !== undefined ? { turnId } : {}),
            ...(external ? { external } : {}),
          });
          return { ok: true };
        },
      },
      {
        name: 'writer_stage_complete',
        description:
          'Báo agent của turn đã thoát với exitCode (0 = xong, -1 = bị giết/thất bại). Daemon tự validate out/result.json, '
          + 'kiểm sandbox, chạy gate và chuyển phase. Chỉ nhận run substrate external.',
        inputSchema: {
          type: 'object',
          properties: {
            runId: { type: 'string' },
            turnId: { type: 'integer' },
            exitCode: { type: 'integer' },
            external: EXTERNAL_REF_SCHEMA,
          },
          required: ['runId', 'turnId', 'exitCode'],
        },
        handler: async (args) => {
          const runId = requireString(args, 'runId');
          const turnId = requireInteger(args, 'turnId');
          const exitCode = requireInteger(args, 'exitCode');
          const external = readExternalRef(args['external']);
          return completeWriterTurn(deps, runId, { turnId, exitCode, ...(external ? { external } : {}) });
        },
      },
      {
        name: 'writer_restyle',
        description: 'Mở turn restyle-v1 trên run DONE theo một channel style (vd "nhan-vat-xuyen-suot.md"). Bản gốc finalScript không đổi.',
        inputSchema: {
          type: 'object',
          properties: { runId: { type: 'string' }, styleId: { type: 'string' } },
          required: ['runId', 'styleId'],
        },
        handler: async (args) => {
          const run = await startRestyle(this.runDeps(), requireString(args, 'runId'), requireString(args, 'styleId'));
          return { restyling: run.restyling ?? null };
        },
      },
      {
        name: 'writer_get_script',
        description: 'Lấy script: version "final" (mặc định) là finalScript của run DONE; một số nguyên là bản styled tương ứng.',
        inputSchema: {
          type: 'object',
          properties: {
            runId: { type: 'string' },
            version: { description: '"final" hoặc số thứ tự bản styled (1, 2, …)', oneOf: [{ type: 'string', enum: ['final'] }, { type: 'integer' }] },
          },
          required: ['runId'],
        },
        handler: async (args) => this.getScript(args),
      },
    ];
  }

  private async wait(args: ToolArgs) {
    const runId = requireString(args, 'runId');
    const until = args['until'];
    if (until !== 'turn' && until !== 'phase' && until !== 'terminal') {
      throw new ToolInputError('until phải là turn, phase hoặc terminal');
    }
    const requested = optionalInteger(args, 'timeoutSec') ?? WAIT_DEFAULT_SEC;
    const timeoutMs = Math.max(0, Math.min(requested, WAIT_MAX_SEC)) * 1000;
    const fromPhase = optionalString(args, 'fromPhase') as WriterV2Phase | undefined;

    const initial = await this.requireRun(runId);
    const basePhase = fromPhase ?? initial.phase;
    const baseStatus = initial.status;
    const deadline = Date.now() + timeoutMs;
    let run = initial;
    for (;;) {
      const terminal = TERMINAL_STATUSES.has(run.status);
      const satisfied = terminal || (
        until === 'turn'
          ? this.deps.scheduler.listOpenTurns(run.id).length > 0
          : until === 'phase'
            ? run.phase !== basePhase || run.status !== baseStatus
            : false
      );
      if (satisfied) return { ...this.statusSnapshot(run), timedOut: false };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { ...this.statusSnapshot(run), timedOut: true };
      await sleep(Math.min(WAIT_POLL_MS, remaining));
      run = await this.requireRun(runId);
    }
  }

  private async getScript(args: ToolArgs) {
    const runId = requireString(args, 'runId');
    const version = args['version'] ?? 'final';
    const run = await this.requireRun(runId);
    const title = run.draft?.title ?? run.requestedTitle ?? run.packTitle;
    if (version === 'final') {
      if (!run.finalScript) throw new Error(`Run ${runId} chưa có finalScript (hiện: ${run.status}/${run.phase})`);
      return { title, script: run.finalScript, words: countScriptWords(run.finalScript) };
    }
    const n = Number(version);
    if (!Number.isInteger(n) || n < 1) throw new ToolInputError('version phải là "final" hoặc số nguyên ≥ 1');
    const script = await readStyledVersion(runId, n, this.deps.dataDir);
    if (script === null) throw new Error(`Bản styled v${n} không tồn tại trên run ${runId}`);
    const styled = run.styled?.find((entry) => entry.version === n);
    return { title, script, words: styled?.words ?? countScriptWords(script), styleId: styled?.styleId ?? null };
  }

  // ── Transport (copied from McpSpyServer) ──────────────────────────────

  private authorized(req: IncomingMessage): boolean {
    return req.headers.authorization === `Bearer ${this.token}`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') return send(res, 405, { error: 'POST required' });
    if (!this.authorized(req)) return send(res, 401, { error: 'Unauthorized' });
    let rpc: JsonRpcRequest;
    try {
      rpc = await readJson(req);
    } catch {
      return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    try {
      const result = await this.dispatch(rpc.method ?? '', rpc.params ?? {});
      send(res, 200, { jsonrpc: '2.0', id: rpc.id ?? null, result });
    } catch (err) {
      const rpcCode = (err as { rpcCode?: number }).rpcCode ?? -32603;
      send(res, 200, {
        jsonrpc: '2.0', id: rpc.id ?? null,
        error: { code: rpcCode, message: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: '0.1.0' },
        };
      case 'ping': return {};
      case 'tools/list':
        return {
          tools: [...this.tools.values()].map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        };
      case 'tools/call': return this.callTool(String(params['name'] ?? ''), (params['arguments'] ?? {}) as ToolArgs);
      default: {
        const err = new Error(`method not found: ${method}`) as Error & { rpcCode: number };
        err.rpcCode = -32601;
        throw err;
      }
    }
  }

  private async callTool(name: string, args: ToolArgs): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) {
      const err = new Error(`tool not found: ${name}`) as Error & { rpcCode: number };
      err.rpcCode = -32602;
      throw err;
    }
    const safeArgs = args && typeof args === 'object' ? args : {};
    const startedAt = Date.now();
    const logBase = {
      at: new Date(startedAt).toISOString(),
      tool: name,
      ...(typeof safeArgs['runId'] === 'string'
        ? { runId: safeArgs['runId'] as string }
        : typeof safeArgs['postId'] === 'string' ? { runId: safeArgs['postId'] as string } : {}),
      args: summarizeArgs(safeArgs),
    };
    try {
      const result = await tool.handler(safeArgs);
      appendCallLog(this.deps.dataDir, { ...logBase, ms: Date.now() - startedAt, ok: true });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      const errorCode = writerMcpErrorCode(err);
      appendCallLog(this.deps.dataDir, { ...logBase, ms: Date.now() - startedAt, ok: false, errorCode });
      return {
        isError: true,
        content: [{
          type: 'text',
          text: JSON.stringify({
            errorCode,
            reason: err instanceof Error ? err.message : String(err),
          }),
        }],
      };
    }
  }
}
