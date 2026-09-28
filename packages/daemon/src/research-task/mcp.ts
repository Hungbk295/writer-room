/**
 * ResearchTask MCP — the door Hermes profiles use to drive a durable research
 * task (plan hermes-writer-room-runtime-redesign §4). Transport mirrors
 * `McpWriterServer` (JSON-RPC over POST on 127.0.0.1), with one deliberate
 * difference: the Bearer token is not a shared secret — it resolves through
 * `ResearchTokenRegistry` to a scoped actor ({role:'operator'} or
 * {role:'worker', profile}), which is the server-side ACL. `tools/list` is
 * filtered by role and every `tools/call` re-checks it, so a worker token can
 * never reach an operator tool even if it knows the name.
 *
 * Operator tools (task lifecycle): create, bind, instruct, pause, resume,
 * cancel, mark_unknown, get, list, events.
 * Worker tools (bound worker only): claim, heartbeat, reserve, round_complete,
 * artifact_register, ack (pause_ack/cancel_ack/block/fail), complete.
 * Read tools (get/list/events) are available to operator and worker.
 * Viewer grants (writer identity) get an EMPTY catalog — the token exists only
 * so Hermes provisioning can inject it into the writer profile .env; the
 * Research surface exposes no read or mutation to it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { McpServerInfo } from '@writer-room/shared';
import { ResearchTaskError, ResearchTaskStore, type Actor, type Phase } from './store.ts';
import type { ResearchTokenRegistry } from './tokens.ts';

const PROTOCOL_VERSION = '2025-03-26';
const SERVER_NAME = 'writer-room-research';

type ToolArgs = Record<string, unknown>;
type Role = 'operator' | 'worker' | 'read';

interface ResearchToolDef {
  name: string;
  role: Role;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (actor: Actor, args: ToolArgs) => unknown;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

class ToolInputError extends Error {}

const CMD = { type: 'string', description: 'Idempotency key — unique per logical command; replay returns the stored receipt' };
const VER = { type: 'integer', description: 'expectedVersion — optimistic lock; must equal task.version at call time' };
const TASK = { type: 'string', description: 'taskId' };
const MUTATION_PROPS = { commandId: CMD, taskId: TASK, expectedVersion: VER };

function reqStr(args: ToolArgs, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) throw new ToolInputError(`${key} bắt buộc (chuỗi không rỗng)`);
  return v.trim();
}
function optStr(args: ToolArgs, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new ToolInputError(`${key} phải là chuỗi`);
  return v;
}
function reqInt(args: ToolArgs, key: string): number {
  const v = Number(args[key]);
  if (args[key] === undefined || args[key] === null || !Number.isInteger(v)) throw new ToolInputError(`${key} phải là số nguyên`);
  return v;
}
function optInt(args: ToolArgs, key: string): number | undefined {
  if (args[key] === undefined || args[key] === null) return undefined;
  return reqInt(args, key);
}
function mutArgs(args: ToolArgs) {
  return { commandId: reqStr(args, 'commandId'), expectedVersion: reqInt(args, 'expectedVersion') };
}
function strList(args: ToolArgs, key: string): string[] {
  const v = args[key];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new ToolInputError(`${key} phải là mảng chuỗi`);
  return v as string[];
}
function videoList(args: ToolArgs): { videoId: string; spyRunId: string }[] {
  const v = args['videos'] ?? [];
  if (!Array.isArray(v)) throw new ToolInputError('videos phải là mảng {videoId, spyRunId}');
  return v.map((x) => {
    if (!x || typeof x !== 'object') throw new ToolInputError('videos phải là mảng {videoId, spyRunId}');
    return { videoId: reqStr(x as ToolArgs, 'videoId'), spyRunId: reqStr(x as ToolArgs, 'spyRunId') };
  });
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

const RESEARCH_PHASES: Phase[] = ['created','ready','running','pause_requested','paused','cancel_requested','cancelled','blocked','failed','completed','unknown'];

export class McpResearchServer {
  private server: Server | null = null;
  private url = '';
  private readonly tools: Map<string, ResearchToolDef>;

  constructor(
    private readonly store: ResearchTaskStore,
    private readonly registry: ResearchTokenRegistry,
  ) {
    this.tools = new Map(this.buildTools().map((t) => [t.name, t]));
  }

  async handleFetch(req: Request): Promise<Response> {
    const actor = this.actorFrom(req.headers.get('authorization'));
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: {
        'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type' } });
    }
    if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'POST required' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
    if (!actor) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    let rpc: JsonRpcRequest;
    try { rpc = (await req.json()) as JsonRpcRequest; }
    catch { return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }
    try {
      const result = await this.dispatch(actor, rpc.method ?? '', rpc.params ?? {});
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id ?? null, result }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (err) {
      const rpcCode = (err as { rpcCode?: number }).rpcCode ?? -32603;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id ?? null, error: { code: rpcCode, message: err instanceof Error ? err.message : String(err) } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  }

  info(): McpServerInfo | null {
    return this.url ? { url: this.url, token: '' } : null;
  }

  start(): Promise<McpServerInfo> {
    if (this.server) return Promise.resolve(this.info()!);
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => void this.handle(req, res));
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') return reject(new Error('Không lấy được cổng Research MCP'));
        this.server = server;
        this.url = `http://127.0.0.1:${address.port}/mcp`;
        resolve(this.info()!);
      });
    });
  }

  stop(): void { this.server?.close(); this.server = null; this.url = ''; }

  private actorFrom(header: string | null): Actor | null {
    if (!header?.startsWith('Bearer ')) return null;
    return this.registry.resolve(header.slice('Bearer '.length).trim());
  }

  // ── Tool catalog ──────────────────────────────────────────────────────

  private buildTools(): ResearchToolDef[] {
    const store = this.store;
    const taskId = (a: ToolArgs) => reqStr(a, 'taskId');
    return [
      // ── Shared reads (operator sees own tasks; worker sees bound tasks)
      { name: 'research_task_get', role: 'read',
        description: 'Projection của một ResearchTask: phase, version, budget (spent/reserved/uniqueVideos), workerBinding, leaseExpired, lastError.',
        inputSchema: { type: 'object', properties: { taskId: TASK }, required: ['taskId'] },
        handler: (a, args) => store.get(a, taskId(args)) },
      { name: 'research_task_list', role: 'read',
        description: 'Liệt kê task theo scope của token: operator thấy task mình sở hữu, worker thấy task đang bind. Lọc theo phase.',
        inputSchema: { type: 'object', properties: { phase: { type: 'string', enum: RESEARCH_PHASES }, limit: { type: 'integer' } } },
        handler: (a, args) => ({ tasks: store.list(a, { phase: optStr(args, 'phase') as Phase | undefined, limit: optInt(args, 'limit') }) }) },
      { name: 'research_task_events', role: 'read',
        description: 'Event log bền của task sau cursor (dùng cho progress watcher/outbox). Trả mảng {cursor,type,payload_json,created_at}.',
        inputSchema: { type: 'object', properties: { taskId: TASK, afterCursor: { type: 'integer' }, limit: { type: 'integer' } }, required: ['taskId'] },
        handler: (a, args) => ({ events: store.events(a, taskId(args), optInt(args, 'afterCursor') ?? 0, optInt(args, 'limit') ?? 100) }) },
      // ── Operator lifecycle
      { name: 'research_task_create', role: 'operator',
        description: 'Tạo ResearchTask ở phase created. budget mặc định 13 vòng / 1300 video / 1300 search. Idempotent theo commandId.',
        inputSchema: { type: 'object', properties: {
          commandId: CMD, taskId: { type: 'string' }, mode: { type: 'string', description: 'vd keyword, channel_list' },
          input: { type: 'object', description: 'Payload nghiệp vụ: keywords/channels, region, language, topic' },
          budget: { type: 'object', properties: { maxRounds: { type: 'integer' }, maxUniqueVideos: { type: 'integer' }, maxSearchCost: { type: 'integer' } } },
          factGateVersion: { type: 'integer', description: '1 (mặc định, structural only) | 2 (P3: manifest phải kèm claimsVersion=2 + claims[] structured, daemon verify fact claims theo Spy snapshot)' },
        }, required: ['commandId', 'mode', 'input'] },
        handler: (a, args) => ({ outcome: 'applied', task: store.create(a, {
          commandId: reqStr(args, 'commandId'), taskId: optStr(args, 'taskId'), mode: reqStr(args, 'mode'),
          input: args['input'] ?? {}, budget: args['budget'] as Record<string, number> | undefined,
          factGateVersion: optInt(args, 'factGateVersion') }) }) },
      { name: 'research_task_bind', role: 'operator',
        description: 'Giao task vào queue của một worker profile (ready). workerSubject bỏ trống = worker nào claim trước trên profile đó. Chỉ rebind được task running khi lease đã hết hạn.',
        inputSchema: { type: 'object', properties: { ...MUTATION_PROPS,
          profile: { type: 'string' }, workerSubject: { type: 'string' }, sessionRef: { type: 'string' }, leaseUntil: { type: 'string' } },
          required: ['commandId', 'taskId', 'expectedVersion', 'profile'] },
        handler: (a, args) => ({ outcome: 'applied', task: store.bind(a, taskId(args), { ...mutArgs(args),
          profile: reqStr(args, 'profile'), workerSubject: optStr(args, 'workerSubject'), sessionRef: optStr(args, 'sessionRef'), leaseUntil: optStr(args, 'leaseUntil') }) }) },
      { name: 'research_task_instruct', role: 'operator',
        description: 'Ghi chỉ dẫn bền giữa lúc chạy; áp dụng ở ranh giới vòng tiếp theo (event instruction_applied). Thay thế chỉ dẫn chưa áp dụng.',
        inputSchema: { type: 'object', properties: { ...MUTATION_PROPS, instruction: { type: 'string' } }, required: ['commandId', 'taskId', 'expectedVersion', 'instruction'] },
        handler: (a, args) => ({ outcome: 'applied', task: store.instruct(a, taskId(args), { ...mutArgs(args), instruction: reqStr(args, 'instruction') }) }) },
      // v1 has a single ready→running path: the worker's research_task_claim.
      // There is deliberately no research_task_start so an operator cannot
      // move a task to running before any worker is actually bound to it.
      ...(['pause','resume','cancel','mark_unknown'] as const).map((action): ResearchToolDef => ({
        name: `research_task_${action}`, role: 'operator',
        description: {
          pause: 'Yêu cầu pause: running → pause_requested; chỉ thành paused sau pause_ack của worker.',
          resume: 'Đánh thức task paused/blocked/unknown → running.',
          cancel: 'Yêu cầu cancel: → cancel_requested; chỉ thành cancelled sau cancel_ack của worker.',
          mark_unknown: 'Đánh dấu running/pause_requested → unknown khi lease worker đã hết hạn.',
        }[action],
        inputSchema: { type: 'object', properties: { ...MUTATION_PROPS, reason: { type: 'string' } }, required: ['commandId', 'taskId', 'expectedVersion'] },
        handler: (a, args) => ({ outcome: 'applied', task: store.transition(a, taskId(args), { ...mutArgs(args), action, reason: optStr(args, 'reason') }) }),
      })),
      // ── Worker tools
      { name: 'research_task_claim', role: 'worker',
        description: 'Claim task ready cũ nhất trên profile queue; bind worker_subject và mở lease (phase → running). Trả null nếu queue rỗng.',
        inputSchema: { type: 'object', properties: { commandId: CMD, profile: { type: 'string' }, sessionRef: { type: 'string' }, leaseUntil: { type: 'string', description: 'ISO timestamp trong tương lai' } }, required: ['commandId', 'profile', 'sessionRef', 'leaseUntil'] },
        handler: (a, args) => ({ outcome: 'applied', task: store.claim(a, { commandId: reqStr(args, 'commandId'), profile: reqStr(args, 'profile'), sessionRef: reqStr(args, 'sessionRef'), leaseUntil: reqStr(args, 'leaseUntil') }) }) },
      { name: 'research_task_heartbeat', role: 'worker',
        description: 'Gia hạn lease của task đang bind; không đổi owner/phase. Lease hết hạn khóa mọi worker mutation.',
        inputSchema: { type: 'object', properties: { ...MUTATION_PROPS, leaseUntil: { type: 'string' } }, required: ['commandId', 'taskId', 'expectedVersion', 'leaseUntil'] },
        handler: (a, args) => ({ outcome: 'applied', task: store.heartbeat(a, taskId(args), { ...mutArgs(args), leaseUntil: reqStr(args, 'leaseUntil') }) }) },
      { name: 'research_round_reserve', role: 'worker',
        description: 'Reserve ngân sách cho vòng roundIndex = round_index+1 trước khi dispatch Spy. Đây là ranh giới áp dụng instruction đang pending.',
        inputSchema: { type: 'object', properties: { ...MUTATION_PROPS, roundIndex: { type: 'integer' }, planHash: { type: 'string' }, searchCost: { type: 'integer' } }, required: ['commandId', 'taskId', 'expectedVersion', 'roundIndex', 'planHash', 'searchCost'] },
        handler: (a, args) => ({ outcome: 'applied', task: store.reserve(a, taskId(args), { ...mutArgs(args), roundIndex: reqInt(args, 'roundIndex'), planHash: reqStr(args, 'planHash'), searchCost: reqInt(args, 'searchCost') }) }) },
      { name: 'research_round_complete', role: 'worker',
        description: 'Settle một vòng reserved: đối chiếu actualSearch ≤ reservation, ghi Spy run refs và video IDs (dedupe theo (taskId,videoId)); settle/release budget trong một transaction.',
        inputSchema: { type: 'object', properties: { ...MUTATION_PROPS, roundIndex: { type: 'integer' }, actualSearch: { type: 'integer' },
          spyRunIds: { type: 'array', items: { type: 'string' } },
          videos: { type: 'array', items: { type: 'object', properties: { videoId: { type: 'string' }, spyRunId: { type: 'string' } }, required: ['videoId','spyRunId'] } } },
          required: ['commandId', 'taskId', 'expectedVersion', 'roundIndex', 'actualSearch', 'spyRunIds'] },
        handler: (a, args) => ({ outcome: 'settled', task: store.completeRound(a, taskId(args), { ...mutArgs(args), roundIndex: reqInt(args, 'roundIndex'), actualSearch: reqInt(args, 'actualSearch'), spyRunIds: strList(args, 'spyRunIds'), videos: videoList(args) }) }) },
      { name: 'research_artifact_register', role: 'worker',
        description: 'Đăng ký artifact (manifest/report/checkpoint/other) — file phải nằm trong task.artifactDir (canonical path daemon trả về qua get/claim); ghi sha256/size/type.',
        inputSchema: { type: 'object', properties: { ...MUTATION_PROPS, roundIndex: { type: 'integer' }, type: { type: 'string', enum: ['manifest','report','checkpoint','other'] }, path: { type: 'string' } }, required: ['commandId', 'taskId', 'expectedVersion', 'roundIndex', 'type', 'path'] },
        handler: (a, args) => ({ outcome: 'applied', artifact: store.registerArtifact(a, taskId(args), { ...mutArgs(args), roundIndex: reqInt(args, 'roundIndex'), type: reqStr(args, 'type') as 'manifest'|'report'|'checkpoint'|'other', path: reqStr(args, 'path') }) }) },
      { name: 'research_task_ack', role: 'worker',
        description: 'Worker ack cho transition do operator yêu cầu (pause_ack → paused, cancel_ack → cancelled) hoặc tự báo block/fail. cancel/fail giải phóng reservation còn treo.',
        inputSchema: { type: 'object', properties: { ...MUTATION_PROPS, action: { type: 'string', enum: ['pause_ack','cancel_ack','block','fail'] }, reason: { type: 'string' } }, required: ['commandId', 'taskId', 'expectedVersion', 'action'] },
        handler: (a, args) => {
          const action = reqStr(args, 'action') as 'pause_ack'|'cancel_ack'|'block'|'fail';
          if (!['pause_ack','cancel_ack','block','fail'].includes(action)) throw new ToolInputError('action phải là pause_ack/cancel_ack/block/fail');
          return { outcome: 'applied', task: store.transition(a, taskId(args), { ...mutArgs(args), action, reason: optStr(args, 'reason') }) };
        } },
      { name: 'research_outbox_poll', role: 'read',
        description: 'Poll durable outbox rows (worker wake signals / operator progress feed) above a cursor. audience=worker needs a worker token on the task profile; audience=operator needs the owning operator token.',
        inputSchema: { type: 'object', properties: { audience: { type: 'string', enum: ['worker', 'operator'] }, afterCursor: { type: 'integer' }, limit: { type: 'integer' } }, required: ['audience'] },
        handler: (a, args) => ({ items: store.outboxPoll(a, { audience: reqStr(args, 'audience') as 'worker' | 'operator', afterCursor: optInt(args, 'afterCursor'), limit: optInt(args, 'limit') }) }) },
      { name: 'research_outbox_ack', role: 'read',
        description: 'Delivery receipt: mark outbox rows ≤ throughCursor delivered (idempotent ack; delivery is at-least-once — store the transport message id as receipt BEFORE acking). Same audience scoping as poll.',
        inputSchema: { type: 'object', properties: { audience: { type: 'string', enum: ['worker', 'operator'] }, throughCursor: { type: 'integer' }, receipt: { type: 'string' }, expectedEpoch: { type: 'string', description: 'Epoch từ research_outbox_identity/poll row — bắt buộc cho relay; mismatch → EPOCH, không ack.' } }, required: ['audience', 'throughCursor'] },
        handler: (a, args) => store.outboxAck(a, { audience: reqStr(args, 'audience') as 'worker' | 'operator', throughCursor: reqInt(args, 'throughCursor'), receipt: optStr(args, 'receipt'), expectedEpoch: optStr(args, 'expectedEpoch') }) },
      { name: 'research_outbox_identity', role: 'read',
        description: 'Daemon-issued outbox epoch (UUID, persisted per research DB). Relay key transport receipt = epoch+audience+cursor; fail closed nếu epoch vắng/đổi (DB mới dùng lại cursor).',
        inputSchema: { type: 'object', properties: { audience: { type: 'string', enum: ['worker', 'operator'] } }, required: ['audience'] },
        handler: (a, args) => store.outboxIdentity(a, { audience: reqStr(args, 'audience') as 'worker' | 'operator' }) },
      { name: 'research_outbox_ack_one', role: 'read',
        description: 'Exact-row delivery receipt: delivers ONLY the row at cursor — a HOLD row earlier in the stream stays undelivered (no false ack). Idempotent; same audience scoping as poll.',
        inputSchema: { type: 'object', properties: { audience: { type: 'string', enum: ['worker', 'operator'] }, cursor: { type: 'integer' }, receipt: { type: 'string' }, expectedEpoch: { type: 'string', description: 'Epoch từ research_outbox_identity/poll row — bắt buộc cho relay; mismatch → EPOCH, không ack.' } }, required: ['audience', 'cursor'] },
        handler: (a, args) => store.outboxAckOne(a, { audience: reqStr(args, 'audience') as 'worker' | 'operator', cursor: reqInt(args, 'cursor'), receipt: optStr(args, 'receipt'), expectedEpoch: optStr(args, 'expectedEpoch') }) },
      { name: 'research_report_get', role: 'operator',
        description: 'Đọc rendered report đã pin (chỉ task completed, owner-scoped). Trả {sha256, renderedMarkdown, claims summary, conclusions, unverifiedAnalysis} — bytes trong DB, không render lại từ Spy live.',
        inputSchema: { type: 'object', properties: { taskId: TASK }, required: ['taskId'] },
        handler: (a, args) => store.reportGet(a, taskId(args)) },
      { name: 'research_task_complete', role: 'worker',
        description: 'Chốt task → completed. Gate: không còn reservation treo, mọi round completed, có ≥1 artifact manifest + 1 report, có ≥1 Spy run ref.',
        inputSchema: { type: 'object', properties: MUTATION_PROPS, required: ['commandId', 'taskId', 'expectedVersion'] },
        handler: (a, args) => ({ outcome: 'settled', task: store.completeTask(a, taskId(args), mutArgs(args)) }) },
    ];
  }

  // ── Transport (same skeleton as McpWriterServer; auth = token → actor) ──

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') return send(res, 405, { error: 'POST required' });
    const actor = this.actorFrom(req.headers.authorization ?? null);
    if (!actor) return send(res, 401, { error: 'Unauthorized' });
    let rpc: JsonRpcRequest;
    try { rpc = await readJson(req); }
    catch { return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    try {
      const result = await this.dispatch(actor, rpc.method ?? '', rpc.params ?? {});
      send(res, 200, { jsonrpc: '2.0', id: rpc.id ?? null, result });
    } catch (err) {
      const rpcCode = (err as { rpcCode?: number }).rpcCode ?? -32603;
      send(res, 200, { jsonrpc: '2.0', id: rpc.id ?? null, error: { code: rpcCode, message: err instanceof Error ? err.message : String(err) } });
    }
  }

  private async dispatch(actor: Actor, method: string, params: Record<string, unknown>): Promise<unknown> {
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
          tools: [...this.tools.values()].filter((t) => this.visible(actor, t)).map((t) => ({
            name: t.name, description: t.description, inputSchema: t.inputSchema,
          })),
        };
      case 'tools/call': return this.callTool(actor, String(params['name'] ?? ''), (params['arguments'] ?? {}) as ToolArgs);
      default: {
        const err = new Error(`method not found: ${method}`) as Error & { rpcCode: number };
        err.rpcCode = -32601;
        throw err;
      }
    }
  }

  // A viewer grant exists only so Hermes provisioning can inject the writer
  // token — the Research surface exposes NO tools to it (data-ACL: a writer
  // identity may not even enumerate tasks). 'read' tools are operator/worker.
  private visible(actor: Actor, tool: ResearchToolDef): boolean {
    if (actor.role === 'viewer') return false;
    return tool.role === 'read' || tool.role === actor.role;
  }

  private callTool(actor: Actor, name: string, args: ToolArgs): unknown {
    const tool = this.tools.get(name);
    if (!tool || !this.visible(actor, tool)) {
      const err = new Error(`tool not found: ${name}`) as Error & { rpcCode: number };
      err.rpcCode = -32602;
      throw err;
    }
    try {
      const result = tool.handler(actor, args && typeof args === 'object' ? args : {});
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      const errorCode = err instanceof ResearchTaskError ? err.code : err instanceof ToolInputError ? 'INVALID_INPUT' : 'INTERNAL';
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ errorCode, reason: err instanceof Error ? err.message : String(err) }) }] };
    }
  }
}
