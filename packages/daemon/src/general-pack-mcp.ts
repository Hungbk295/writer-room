/**
 * Narrow local MCP surface for composing General Pack files (Write Loop v2
 * Phase 2's "hand-curated CÁCH LÀM file per channel"). Deliberately its own
 * server/process, mounted alongside `spy-mcp.ts` (as `general_pack`, next to
 * `writer_room`) rather than folded into it: an agent drafting pack entries
 * needs transcript reads plus grounding/staging/commit tools, not the rest of
 * Spy's research surface, and vice versa.
 *
 * Design note (checked into the general-pack MCP design doc, approved 2026-08-31):
 * this server never calls an LLM itself. Grounding is enforced by CODE
 * (`quoteIsGrounded` in `writer/general-pack.ts`) exactly like `validateStudyArtifact`
 * already does for Writer v2 — the calling agent reads the transcript and drafts
 * the entry text; this server only validates, stages, and (on `pack_commit`)
 * writes the pinned channel file.
 *
 * `pack_generate_batch` / `pack_batch_status` (spawn one agent turn per transcript,
 * mirroring `writer-run-v2.ts`'s STUDY/WRITE calls) are intentionally NOT wired in
 * this cut — that needs a new pipeline lane + settle listener the same size as
 * Write Loop v2 Phase 3, not something to bolt on inside a tool handler. Every
 * tool below this comment works standalone today; an agent (or a human) drives
 * the read -> draft -> validate -> stage -> commit loop by hand until that lane
 * exists.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import type { ChannelSpyInput, SpyService } from '@writer-room/spy';
import type { McpServerInfo } from '@writer-room/shared';
import {
  GENERAL_PACK_EXAMPLE_TAGS,
  commitGeneralPack,
  getGeneralPack,
  isGeneralPackExampleTag,
  listGeneralPacks,
  readStagingState,
  stageEntry,
  stageTasteDna,
  validateGeneralPackEntryDraft,
  validateTasteDnaDraft,
  type GeneralPackEntryDraft,
  type TasteDnaPrincipleDraft,
} from './writer/general-pack.ts';
import { listWriterRunsV2 } from './writer/run-store-v2.ts';

const PROTOCOL_VERSION = '2025-03-26';
const SUBJECT = 'writer-room-general-pack-mcp';
/** Every tool below needs `general_pack.read`; drafting needs `.stage`; only
 * `pack_commit` needs `.commit`. All three are granted to any holder of this
 * server's bearer token today (see design-doc open question: per-agent scope
 * split, so batch-draft agents never receive `.commit`, is not wired yet — it
 * needs `appMcpProvision(agentId)` to mount a second, commit-less instance for
 * non-reviewer agents). */
const SCOPES = new Set(['general_pack.read', 'general_pack.stage', 'general_pack.commit']);

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface ToolDef {
  name: string;
  description: string;
  requiredScopes: string[];
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => unknown | Promise<unknown>;
}

function rpcError(code: number, message: string): Error & { rpcCode: number } {
  const err = new Error(message) as Error & { rpcCode: number };
  err.rpcCode = code;
  return err;
}

function requireString(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  if (typeof v !== 'string' || v.trim() === '') throw rpcError(-32602, `${name} phải là string không rỗng`);
  return v;
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const v = args[name];
  return typeof v === 'string' ? v : undefined;
}

function requireStringArray(args: Record<string, unknown>, name: string): string[] {
  const v = args[name];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw rpcError(-32602, `${name} phải là mảng string`);
  return v as string[];
}

function requireObject(args: Record<string, unknown>, name: string): Record<string, unknown> {
  const v = args[name];
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw rpcError(-32602, `${name} phải là object`);
  return v as Record<string, unknown>;
}

function requireArray(args: Record<string, unknown>, name: string): unknown[] {
  const v = args[name];
  if (!Array.isArray(v)) throw rpcError(-32602, `${name} phải là mảng`);
  return v;
}

function parseTasteDnaPrinciples(raw: unknown): TasteDnaPrincipleDraft[] {
  if (!Array.isArray(raw)) throw rpcError(-32602, 'principles phải là mảng');
  return raw.map((p, i) => {
    if (typeof p !== 'object' || p === null) throw rpcError(-32602, `principles[${i}] phải là object`);
    const obj = p as Record<string, unknown>;
    const title = obj['title'];
    const note = obj['note'];
    const quotes = obj['quotes'];
    if (typeof title !== 'string' || typeof note !== 'string' || !Array.isArray(quotes)) {
      throw rpcError(-32602, `principles[${i}] cần title/note (string) + quotes (mảng)`);
    }
    return {
      title,
      note,
      quotes: quotes.map((q, qi) => {
        if (typeof q !== 'object' || q === null) throw rpcError(-32602, `principles[${i}].quotes[${qi}] phải là object`);
        const qo = q as Record<string, unknown>;
        if (typeof qo['videoId'] !== 'string' || typeof qo['text'] !== 'string') {
          throw rpcError(-32602, `principles[${i}].quotes[${qi}] cần videoId + text (string)`);
        }
        return { videoId: qo['videoId'], text: qo['text'] };
      }),
    };
  });
}

function parseEntryDraft(args: Record<string, unknown>): GeneralPackEntryDraft {
  const videoId = requireString(args, 'videoId');
  const hookRaw = requireObject(args, 'hook');
  const payoffRaw = requireObject(args, 'payoff');
  const boundaryRaw = requireObject(args, 'boundary');
  const beatsRaw = requireArray(args, 'beats');
  const examplesRaw = requireArray(args, 'examples');

  const beats = beatsRaw.map((b, i) => {
    if (typeof b !== 'object' || b === null) throw rpcError(-32602, `beats[${i}] phải là object`);
    const bo = b as Record<string, unknown>;
    if (typeof bo['beat'] !== 'string' || typeof bo['newInformation'] !== 'string' || !Array.isArray(bo['quotes'])) {
      throw rpcError(-32602, `beats[${i}] cần beat/newInformation (string) + quotes (mảng string)`);
    }
    return { beat: bo['beat'], newInformation: bo['newInformation'], quotes: bo['quotes'] as string[] };
  });

  const examples = examplesRaw.map((e, i) => {
    if (typeof e !== 'object' || e === null) throw rpcError(-32602, `examples[${i}] phải là object`);
    const eo = e as Record<string, unknown>;
    if (typeof eo['text'] !== 'string' || !isGeneralPackExampleTag(eo['tag'])) {
      throw rpcError(-32602, `examples[${i}] cần text (string) + tag ∈ [${GENERAL_PACK_EXAMPLE_TAGS.join(', ')}]`);
    }
    return { text: eo['text'], tag: eo['tag'], recurringAcrossBeats: eo['recurringAcrossBeats'] === true };
  });

  return {
    videoId,
    title: optionalString(args, 'title'),
    views: typeof args['views'] === 'number' ? args['views'] : undefined,
    durationMinutes: typeof args['durationMinutes'] === 'number' ? args['durationMinutes'] : undefined,
    hook: { quote: requireString(hookRaw, 'quote'), debt: requireString(hookRaw, 'debt') },
    beats,
    examples,
    payoff: { quote: requireString(payoffRaw, 'quote'), note: requireString(payoffRaw, 'note') },
    boundary: { quote: requireString(boundaryRaw, 'quote'), note: requireString(boundaryRaw, 'note') },
  };
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

export class McpGeneralPackServer {
  readonly token = randomBytes(24).toString('hex');
  private server: Server | null = null;
  private url = '';
  private readonly tools: Map<string, ToolDef>;
  private readonly spy: SpyService;
  private readonly dataDir: string | undefined;

  constructor(spy: SpyService, dataDir?: string) {
    this.spy = spy;
    this.dataDir = dataDir;
    this.tools = new Map(this.buildTools().map((t) => [t.name, t]));
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
        if (!address || typeof address === 'string') return reject(new Error('Không lấy được cổng General Pack MCP'));
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
          capabilities: {
            tools: { listChanged: false },
            resources: { listChanged: false },
          },
          serverInfo: { name: 'writer-room-general-pack', version: '0.1.0' },
        };
      case 'ping': return {};
      case 'resources/list':
        return {
          resources: await this.listResources(),
        };
      case 'resources/read':
        return {
          contents: [await this.readResource(requireString(params, 'uri'))],
        };
      case 'tools/list':
        return {
          tools: [...this.tools.values()].map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        };
      case 'tools/call': return this.callTool(String(params['name'] ?? ''), (params['arguments'] ?? {}) as Record<string, unknown>);
      default: throw rpcError(-32601, `method not found: ${method}`);
    }
  }

  private async listResources(): Promise<Array<{ uri: string; name: string; description?: string; mimeType?: string }>> {
    const packs = await listGeneralPacks(this.dataDir);
    const resources: Array<{ uri: string; name: string; description?: string; mimeType?: string }> = [
      {
        uri: 'general-pack://schema/example-tags',
        name: 'General Pack Example Tags',
        description: '11 tags quy chuẩn bắt buộc cho entry kịch bản (Hook/Beats/Example/Payoff/Boundary)',
        mimeType: 'application/json',
      },
    ];
    for (const pack of packs) {
      const channel = pack.path.slice(0, -3);
      resources.push({
        uri: `general-pack://channels/${encodeURIComponent(channel)}`,
        name: `General Pack: ${channel}`,
        description: `Tệp CÁCH LÀM kênh ${channel} v${pack.version ?? 1} (${pack.wordCount} từ, hash ${pack.hash.slice(0, 8)})`,
        mimeType: 'text/markdown',
      });
    }
    return resources;
  }

  private async readResource(uri: string): Promise<{ uri: string; mimeType: string; text: string }> {
    if (uri === 'general-pack://schema/example-tags') {
      return {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify({
          tags: GENERAL_PACK_EXAMPLE_TAGS,
          description: 'Mọi example trong entry kịch bản phải gán đúng 1 trong 11 tag này và trích dẫn verbatim từ transcript.',
        }, null, 2),
      };
    }
    if (uri.startsWith('general-pack://channels/')) {
      const channel = decodeURIComponent(uri.slice('general-pack://channels/'.length));
      const pack = await getGeneralPack(`${channel}.md`, this.dataDir);
      if (!pack) throw rpcError(-32002, `Không tìm thấy general pack cho kênh: ${channel}`);
      return {
        uri,
        mimeType: 'text/markdown',
        text: pack.markdown,
      };
    }
    throw rpcError(-32002, `URI tài nguyên không hợp lệ hoặc không tồn tại: ${uri}`);
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw rpcError(-32602, `tool not found: ${name}`);
    for (const scope of tool.requiredScopes) {
      if (!SCOPES.has(scope)) throw rpcError(-32001, `thiếu scope ${scope}`);
    }
    try {
      const result = await tool.handler(args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }],
      };
    }
  }

  private buildTools(): ToolDef[] {
    const spy = this.spy;
    const dataDir = this.dataDir;

    return [
      {
        name: 'pack_list',
        description: 'Liệt kê mọi general pack (1 file/kênh) kèm version, hash, số từ.',
        requiredScopes: ['general_pack.read'],
        inputSchema: { type: 'object', properties: {} },
        handler: () => listGeneralPacks(dataDir),
      },
      {
        name: 'pack_get',
        description: 'Đọc trạng thái parse của 1 pack: version, hash, header entries x/y, markdown đầy đủ.',
        requiredScopes: ['general_pack.read'],
        inputSchema: { type: 'object', required: ['channel'], properties: { channel: { type: 'string' } } },
        handler: async (args) => {
          const channel = requireString(args, 'channel');
          const pack = await getGeneralPack(`${channel}.md`, dataDir);
          if (!pack) return { exists: false, channel };
          return { exists: true, ...pack };
        },
      },
      {
        name: 'pack_list_candidate_videos',
        description:
          'Rank video nguồn để chọn 5-10 video soạn pack. source=spy_run: liệt kê video đã Spy trong 1 spy_run_id. '
          + 'source=channel_url: kích hoạt Spy channel acquisition trước (như spy_channel_start) rồi trả operationId — '
          + 'poll bằng spy_wait/spy_get_status trên MCP writer_room, xong rồi gọi lại tool này với source=spy_run.',
        requiredScopes: ['general_pack.read'],
        inputSchema: {
          type: 'object',
          required: ['source'],
          properties: {
            source: { type: 'string', enum: ['spy_run', 'channel_url'] },
            spy_run_id: { type: 'string' },
            channel_url: { type: 'string' },
            top_n: { type: 'integer', minimum: 1, maximum: 30, default: 10 },
            rank_by: { type: 'string', enum: ['views', 'velocity', 'recency'], default: 'views' },
            require_transcript: { type: 'boolean', default: true },
          },
        },
        handler: (args) => {
          const source = requireString(args, 'source');
          if (source === 'channel_url') {
            const url = requireString(args, 'channel_url');
            const topN = typeof args['top_n'] === 'number' ? args['top_n'] : 10;
            const rankBy = args['rank_by'] === 'velocity' ? 'velocity' : 'views';
            const input: ChannelSpyInput = {
              url, topN, selectionMode: 'popular', scanLimit: 60, rankBy, minDurationSec: 60, depth: 'transcript',
              idempotencyKey: `general-pack-mcp-${randomUUID()}`,
            };
            const op = spy.channelSpy(input);
            return { status: 'SPYING', operationId: op.operationId, note: 'poll qua spy_wait/spy_get_status (MCP writer_room), rồi gọi lại pack_list_candidate_videos(source=spy_run, spy_run_id=...)' };
          }
          const spyRunId = requireString(args, 'spy_run_id');
          const topN = typeof args['top_n'] === 'number' ? args['top_n'] : 10;
          const rankBy = typeof args['rank_by'] === 'string' ? args['rank_by'] : 'views';
          const requireTranscript = args['require_transcript'] !== false;
          const now = Date.now();
          let rows = spy.store.listVideoSnapshots(spyRunId);
          if (requireTranscript) rows = rows.filter((r) => r.transcriptStatus === 'ok');
          const scored = rows.map((r) => {
            const ageDays = r.publishedAt ? Math.max(1, (now - new Date(r.publishedAt).getTime()) / 86_400_000) : null;
            return {
              row: r,
              score: rankBy === 'views' ? r.viewCount
                : rankBy === 'velocity' ? (ageDays ? r.viewCount / ageDays : 0)
                : (r.publishedAt ? new Date(r.publishedAt).getTime() : 0),
            };
          });
          scored.sort((a, b) => b.score - a.score);
          const videos = scored.slice(0, topN).map(({ row }) => ({
            videoId: row.id,
            sourceVideoId: row.sourceVideoId,
            title: row.title,
            views: row.viewCount,
            publishedAt: row.publishedAt,
            durationSec: row.durationSec,
            hasTranscript: row.transcriptStatus === 'ok',
          }));
          return { videos, note: 'videoId = Spy video_snapshot_id (dùng cho pack_get_transcript/pack_validate_entry), khác YouTube sourceVideoId' };
        },
      },
      {
        name: 'pack_get_transcript',
        description: 'Đọc transcript đầy đủ (hoặc 1 lát cắt limitChars từ offset) của các video đã chọn, để agent tự soạn entry.',
        requiredScopes: ['general_pack.read'],
        inputSchema: {
          type: 'object',
          required: ['videoIds'],
          properties: {
            videoIds: { type: 'array', items: { type: 'string' }, maxItems: 5 },
            offset: { type: 'integer', minimum: 0, default: 0 },
            limitChars: { type: 'integer', minimum: 1000, maximum: 200_000, default: 20_000 },
          },
        },
        handler: (args) => {
          const videoIds = requireStringArray(args, 'videoIds');
          if (videoIds.length === 0 || videoIds.length > 5) throw rpcError(-32602, 'videoIds phải có 1..5 phần tử');
          const offset = typeof args['offset'] === 'number' ? args['offset'] : 0;
          const limitChars = typeof args['limitChars'] === 'number' ? args['limitChars'] : 20_000;
          return videoIds.map((videoId) => {
            const full = spy.getTranscriptText(videoId);
            const slice = full.text.slice(offset, offset + limitChars);
            return {
              videoId,
              text: slice,
              totalChars: full.text.length,
              nextOffset: offset + limitChars < full.text.length ? offset + limitChars : null,
            };
          });
        },
      },
      {
        name: 'pack_validate_taste_dna',
        description:
          'Validate draft TASTE DNA cấp kênh (5-8 nguyên tắc, mỗi nguyên tắc >=1 quote). Mọi quote phải là substring '
          + 'nguyên văn transcript của đúng videoId khai báo. KHÔNG ghi gì — chỉ trả violations/warnings để agent sửa.',
        requiredScopes: ['general_pack.read'],
        inputSchema: {
          type: 'object',
          required: ['sourceVideoIds', 'principles'],
          properties: {
            sourceVideoIds: { type: 'array', items: { type: 'string' }, minItems: 3 },
            principles: { type: 'array', minItems: 5, maxItems: 8 },
          },
        },
        handler: (args) => {
          const sourceVideoIds = requireStringArray(args, 'sourceVideoIds');
          const principles = parseTasteDnaPrinciples(args['principles']);
          const transcripts = Object.fromEntries(sourceVideoIds.map((id) => [id, spy.getTranscriptText(id).text]));
          return validateTasteDnaDraft(principles, sourceVideoIds, transcripts);
        },
      },
      {
        name: 'pack_validate_entry',
        description:
          'Validate draft 1 entry (Hook/Beat[]/Example/Payoff/Boundary) cho 1 video. Mọi quote phải là substring '
          + 'nguyên văn transcript của video đó. examples[].tag phải thuộc 11 tag cố định. KHÔNG ghi gì.',
        requiredScopes: ['general_pack.read'],
        inputSchema: {
          type: 'object',
          required: ['videoId', 'hook', 'beats', 'examples', 'payoff', 'boundary'],
          properties: {
            videoId: { type: 'string' },
            title: { type: 'string' },
            views: { type: 'number' },
            durationMinutes: { type: 'number' },
            hook: { type: 'object', required: ['quote', 'debt'], properties: { quote: { type: 'string' }, debt: { type: 'string' } } },
            beats: { type: 'array', minItems: 2, maxItems: 8 },
            examples: { type: 'array' },
            payoff: { type: 'object', required: ['quote', 'note'], properties: { quote: { type: 'string' }, note: { type: 'string' } } },
            boundary: { type: 'object', required: ['quote', 'note'], properties: { quote: { type: 'string' }, note: { type: 'string' } } },
          },
        },
        handler: (args) => {
          const draft = parseEntryDraft(args);
          const transcript = spy.getTranscriptText(draft.videoId).text;
          return validateGeneralPackEntryDraft(draft, transcript);
        },
      },
      {
        name: 'pack_stage_taste_dna',
        description: 'Validate lại (server-side) rồi ghi draft TASTE DNA vào staging (general-packs/.staging/<channel>/). Chưa đụng file thật.',
        requiredScopes: ['general_pack.stage'],
        inputSchema: {
          type: 'object',
          required: ['channel', 'sourceVideoIds', 'principles'],
          properties: {
            channel: { type: 'string' },
            sourceVideoIds: { type: 'array', items: { type: 'string' }, minItems: 3 },
            principles: { type: 'array', minItems: 5, maxItems: 8 },
          },
        },
        handler: async (args) => {
          const channel = requireString(args, 'channel');
          const sourceVideoIds = requireStringArray(args, 'sourceVideoIds');
          const principles = parseTasteDnaPrinciples(args['principles']);
          const transcripts = Object.fromEntries(sourceVideoIds.map((id) => [id, spy.getTranscriptText(id).text]));
          return stageTasteDna(channel, sourceVideoIds, principles, transcripts, dataDir);
        },
      },
      {
        name: 'pack_stage_entry',
        description: 'Validate lại (server-side) rồi ghi draft entry 1 video vào staging. Chưa đụng file thật.',
        requiredScopes: ['general_pack.stage'],
        inputSchema: {
          type: 'object',
          required: ['channel', 'videoId', 'hook', 'beats', 'examples', 'payoff', 'boundary'],
          properties: {
            channel: { type: 'string' },
            videoId: { type: 'string' },
            title: { type: 'string' },
            views: { type: 'number' },
            durationMinutes: { type: 'number' },
            hook: { type: 'object', required: ['quote', 'debt'] },
            beats: { type: 'array', minItems: 2, maxItems: 8 },
            examples: { type: 'array' },
            payoff: { type: 'object', required: ['quote', 'note'] },
            boundary: { type: 'object', required: ['quote', 'note'] },
          },
        },
        handler: async (args) => {
          const channel = requireString(args, 'channel');
          const draft = parseEntryDraft(args);
          const transcript = spy.getTranscriptText(draft.videoId).text;
          return stageEntry(channel, draft, transcript, dataDir);
        },
      },
      {
        name: 'pack_commit',
        description:
          'Ghi các mảnh đã stage (và ok:true) vào file kênh thật; bump version + hash. Chặn nếu có WriterRunV2 đang RUNNING '
          + 'pin đúng hash cũ — truyền force=true mới ghi đè. Bắt buộc reviewerNote (bằng chứng đã soi tag nguồn gốc Example + dòng Ranh giới).',
        requiredScopes: ['general_pack.commit'],
        inputSchema: {
          type: 'object',
          required: ['channel', 'reviewerNote'],
          properties: {
            channel: { type: 'string' },
            includeTasteDna: { type: 'boolean', default: false },
            videoIds: { type: 'array', items: { type: 'string' } },
            reviewerNote: { type: 'string', minLength: 1 },
            force: { type: 'boolean', default: false },
          },
        },
        handler: async (args) => {
          const channel = requireString(args, 'channel');
          const includeTasteDna = args['includeTasteDna'] === true;
          const videoIds = Array.isArray(args['videoIds']) ? (args['videoIds'] as string[]) : [];
          const reviewerNote = requireString(args, 'reviewerNote');
          const force = args['force'] === true;

          const existing = await getGeneralPack(`${channel}.md`, dataDir);
          if (existing) {
            const runs = await listWriterRunsV2(dataDir);
            const blocking = runs.filter((r) => r.status === 'RUNNING' && r.generalPackHash === existing.hash);
            if (blocking.length > 0 && !force) {
              return {
                committed: false,
                reason: 'GENERAL_PACK_CHANGED_WOULD_BREAK_RUNNING_RUN',
                blockedRunningRuns: blocking.map((r) => r.id),
              };
            }
          }
          return commitGeneralPack(channel, { includeTasteDna, videoIds, reviewerNote }, dataDir);
        },
      },
      {
        name: 'pack_health',
        description: 'Số liệu sức khỏe pack: quote-ratio (ngưỡng khoẻ ~60%), tổng từ, số entry đã có/đang stage.',
        requiredScopes: ['general_pack.read'],
        inputSchema: { type: 'object', required: ['channel'], properties: { channel: { type: 'string' } } },
        handler: async (args) => {
          const channel = requireString(args, 'channel');
          const pack = await getGeneralPack(`${channel}.md`, dataDir);
          const staging = await readStagingState(channel, dataDir);
          return {
            channel,
            live: pack ? { version: pack.version, wordCount: pack.wordCount, hash: pack.hash } : null,
            staged: {
              tasteDna: staging.tasteDna ? { ok: staging.tasteDna.validation.ok, quoteCharRatio: staging.tasteDna.validation.quoteCharRatio } : null,
              entries: Object.fromEntries(
                Object.entries(staging.entries).map(([id, e]) => [id, { ok: e.validation.ok, quoteCharRatio: e.validation.quoteCharRatio }]),
              ),
            },
          };
        },
      },
    ];
  }
}
