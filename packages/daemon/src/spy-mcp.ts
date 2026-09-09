/**
 * Narrow local MCP surface for the Spy acquisition and evidence-reading flow.
 * It is intentionally separate from Team MCP: agents need not receive team
 * coordination tools merely to research a captured YouTube channel.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spyTools, type SpyService, type SpyToolDef } from '@writer-room/spy';
import type { McpServerInfo } from '@writer-room/shared';

const PROTOCOL_VERSION = '2025-03-26';
const SUBJECT = 'writer-room-spy-mcp';
const SCOPES = new Set(['spy.start', 'spy.read']);

const EXPOSED_TOOL_NAMES = new Set([
  'spy_channel_start',
  'spy_video_start',
  'spy_get_status',
  'spy_wait',
  'spy_run_manifest',
  'spy_find_videos',
  'spy_global_video_search',
  'spy_read_transcript',
  'spy_read_video_material',
  'spy_video_download_audio',
  // M0: existing intelligence, deliberately read-only. Keep discovery,
  // watchlist updates, and all other mutations off this local MCP surface.
  'spy_channel_videos',
  'spy_channel_outliers',
  'spy_channel_profile',
  'spy_video_metrics',
  'spy_title_patterns',
  'spy_video_comments',
  'spy_corpus_videos',
  'spy_corpus_channels',
  'spy_channel_momentum',
  'spy_competitors_list',
  // Spy Loop read tools (P0 — agy-2). Write tools (spy_loop_decide, spy_loop_tick)
  // deliberately excluded: they require scope spy.loop.write which is not in SCOPES.
  'spy_topics_list',
  'spy_loop_status',
  'spy_loop_inbox',
  'spy_loop_report',
]);

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

const inputSchemas: Record<string, Record<string, unknown>> = {
  spy_channel_start: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL kênh hoặc playlist YouTube' },
      selection_mode: { type: 'string', enum: ['popular', 'latest'], default: 'popular' },
      top_n: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
      scan_limit: { type: 'integer', minimum: 1, maximum: 500, default: 60 },
      rank_by: { type: 'string', enum: ['velocity', 'views'], default: 'velocity' },
      min_duration_sec: { type: 'integer', minimum: 0, maximum: 7200, default: 60, description: 'Thời lượng video tối thiểu tính bằng giây' },
      max_duration_sec: { type: 'integer', minimum: 0, maximum: 72000, description: 'Thời lượng video tối đa tính bằng giây' },
      published_after: { type: 'string', description: 'Chỉ lấy video đăng sau mốc ISO 8601 / YYYY-MM-DD' },
      published_before: { type: 'string', description: 'Chỉ lấy video đăng trước mốc ISO 8601 / YYYY-MM-DD' },
      depth: { type: 'string', enum: ['metadata', 'transcript'], default: 'transcript' },
      idempotency_key: { type: 'string', description: 'Khóa idempotency chống gọi lặp' },
    },
    required: ['url'],
  },
  spy_video_start: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL video YouTube (watch/shorts/youtu.be)' },
      depth: { type: 'string', enum: ['metadata', 'transcript'], default: 'transcript' },
      idempotency_key: { type: 'string', description: 'Khóa idempotency chống gọi lặp' },
    },
    required: ['url'],
  },
  spy_get_status: {
    type: 'object',
    properties: {
      operation_id: { type: 'string', description: 'ID tác vụ async do spy_*_start trả về' },
      run_id: { type: 'string', description: 'Alias của operation_id' },
    },
    anyOf: [{ required: ['operation_id'] }, { required: ['run_id'] }],
  },
  spy_wait: {
    type: 'object',
    properties: {
      operation_id: { type: 'string', description: 'ID tác vụ async do spy_*_start trả về' },
      run_id: { type: 'string', description: 'Alias của operation_id' },
      max_wait_seconds: { type: 'integer', minimum: 1, maximum: 600, default: 30, description: 'Thời gian chờ tối đa (giây)' },
    },
    anyOf: [{ required: ['operation_id'] }, { required: ['run_id'] }],
  },
  spy_run_manifest: {
    type: 'object', properties: { spy_run_id: { type: 'string' } }, required: ['spy_run_id'],
  },
  spy_find_videos: {
    type: 'object',
    properties: {
      spy_run_id: { type: 'string' },
      titles: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50 },
      match: { type: 'string', enum: ['exact', 'contains'] },
    },
    required: ['spy_run_id', 'titles'],
  },
  spy_global_video_search: {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 200 },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      language: { type: 'string', pattern: '^[A-Za-z]{2}$', default: 'vi' },
      region: { type: 'string', pattern: '^[A-Za-z]{2}$', default: 'VN' },
      refresh: {
        type: 'string',
        enum: ['never', 'if_stale', 'always'],
        default: 'if_stale',
        description: 'never: dùng cache bất kể tuổi (chỉ gọi API khi chưa từng search). if_stale: mặc định, làm tươi khi quá max_age_hours. always: bỏ qua cache.',
      },
      max_age_hours: {
        type: 'number',
        exclusiveMinimum: 0,
        default: 24,
        description: 'Áp dụng khi refresh=if_stale — tuổi tối đa (giờ) của kết quả cache trước khi gọi lại API.',
      },
    },
    required: ['query'],
  },
  spy_read_transcript: {
    type: 'object',
    properties: {
      video_snapshot_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5 },
      cursors: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } },
      limit_per_video: { type: 'integer', minimum: 1, maximum: 50 },
    },
    required: ['video_snapshot_ids'],
  },
  spy_read_video_material: {
    type: 'object',
    properties: {
      video_snapshot_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5 },
      cursors: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 } },
      limit_per_video: { type: 'integer', minimum: 1, maximum: 50 },
      include_thumbnail: { type: 'boolean', description: 'true: return thumbnail image content for visual analysis; false: transcript only' },
    },
    required: ['video_snapshot_ids', 'include_thumbnail'],
  },
  spy_video_download_audio: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL của video YouTube cần tải audio' },
      video_id: { type: 'string', description: 'YouTube video ID (11 ký tự)' },
      video_snapshot_id: { type: 'string', description: 'ID snapshot của video đã spy trong DB' },
      format: { type: 'string', enum: ['mp3', 'm4a', 'opus'], default: 'mp3', description: 'Định dạng audio' },
      quality: { type: 'string', description: 'Chất lượng audio (mặc định 0 - cao nhất)' },
      force: { type: 'boolean', default: false, description: 'Bắt buộc tải lại nếu file đã tồn tại trên đĩa' },
    },
    anyOf: [{ required: ['url'] }, { required: ['video_id'] }, { required: ['video_snapshot_id'] }],
  },
  spy_channel_videos: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', minLength: 1 },
      spy_run_id: { type: 'string', minLength: 1 },
      order_by: { type: 'string', enum: ['views', 'velocity', 'published_at', 'duration', 'engagement'] },
      direction: { type: 'string', enum: ['asc', 'desc'] },
      published_after: { type: 'string', format: 'date-time' },
      published_before: { type: 'string', format: 'date-time' },
      min_duration_sec: { type: 'integer', minimum: 0 },
      max_duration_sec: { type: 'integer', minimum: 0 },
      has_transcript: { type: 'boolean' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      cursor: { type: 'integer', minimum: 0, maximum: 100_000 },
    },
    anyOf: [{ required: ['channel_id'] }, { required: ['spy_run_id'] }],
  },
  spy_channel_outliers: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', minLength: 1 },
      spy_run_id: { type: 'string', minLength: 1 },
      min_score: { type: 'number', minimum: 0 },
    },
    anyOf: [{ required: ['channel_id'] }, { required: ['spy_run_id'] }],
  },
  spy_channel_profile: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', minLength: 1 },
      spy_run_id: { type: 'string', minLength: 1 },
    },
    anyOf: [{ required: ['channel_id'] }, { required: ['spy_run_id'] }],
  },
  spy_video_metrics: {
    type: 'object',
    properties: {
      video_id: { type: 'string', minLength: 1 },
      spy_run_id: { type: 'string', minLength: 1 },
    },
    required: ['video_id'],
  },
  spy_title_patterns: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', minLength: 1 },
      spy_run_id: { type: 'string', minLength: 1 },
    },
    anyOf: [{ required: ['channel_id'] }, { required: ['spy_run_id'] }],
  },
  spy_video_comments: {
    type: 'object',
    properties: {
      video_id: { type: 'string', minLength: 1 },
      channel_id: { type: 'string', minLength: 1 },
      max_results: { type: 'integer', minimum: 1, maximum: 100 },
      order: { type: 'string', enum: ['relevance', 'time'] },
      include_replies: { type: 'boolean' },
    },
    anyOf: [{ required: ['video_id'] }, { required: ['channel_id'] }],
  },
  spy_corpus_videos: {
    type: 'object',
    properties: {
      title_query: { type: 'string', minLength: 1 },
      transcript_query: { type: 'string', minLength: 1 },
      channel_ids: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
      min_views: { type: 'number', minimum: 0 },
      max_views: { type: 'number', minimum: 0 },
      min_duration_sec: { type: 'integer', minimum: 0 },
      max_duration_sec: { type: 'integer', minimum: 0 },
      published_after: { type: 'string', format: 'date-time' },
      published_before: { type: 'string', format: 'date-time' },
      has_transcript: { type: 'boolean' },
      min_outlier_score: { type: 'number', minimum: 0 },
      min_view_per_sub: { type: 'number', minimum: 0 },
      order_by: { type: 'string', enum: ['views', 'velocity', 'published_at', 'duration', 'engagement'] },
      direction: { type: 'string', enum: ['asc', 'desc'] },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      cursor: { type: 'integer', minimum: 0, maximum: 100_000 },
    },
  },
  spy_corpus_channels: {
    type: 'object',
    properties: {
      min_videos: { type: 'integer', minimum: 0 },
      min_avg_views: { type: 'number', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    },
  },
  spy_channel_momentum: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', minLength: 1 },
      window_days: { type: 'integer', minimum: 1, maximum: 365 },
    },
    required: ['channel_id'],
  },
  spy_competitors_list: {
    type: 'object',
    properties: {
      owner_channel_id: { type: 'string', minLength: 1 },
      channel_id: { type: 'string', minLength: 1, description: 'Alias of owner_channel_id' },
    },
    anyOf: [{ required: ['owner_channel_id'] }, { required: ['channel_id'] }],
  },
  // ── Spy Loop read tools ────────────────────────────────────────────────────
  spy_topics_list: {
    type: 'object',
    properties: {},
  },
  spy_loop_status: {
    type: 'object',
    properties: {
      topic_id: { type: 'string', minLength: 1, description: 'Lọc theo topic; bỏ trống = tất cả topic' },
    },
  },
  spy_loop_inbox: {
    type: 'object',
    properties: {
      topic_id: { type: 'string', minLength: 1 },
      status: { type: 'string', enum: ['new', 'shortlisted', 'rejected', 'studied'] },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      cursor: { type: 'integer', minimum: 0 },
    },
    required: ['topic_id'],
  },
  spy_loop_report: {
    type: 'object',
    properties: {
      topic_id: { type: 'string', minLength: 1, description: 'Lọc theo topic; bỏ trống = report mới nhất tất cả topic' },
      date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Ngày report YYYY-MM-DD; bỏ trống = mới nhất' },
    },
  },
};

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<JsonRpcRequest> {
  let body = '';
  for await (const chunk of req) body += String(chunk);
  return JSON.parse(body || '{}') as JsonRpcRequest;
}

export class McpSpyServer {
  readonly token: string;
  private server: Server | null = null;
  private url = '';
  private readonly tools: Map<string, SpyToolDef>;
  private readonly spy: SpyService;

  constructor(spy: SpyService, options?: { token?: string }) {
    this.token = options?.token ?? randomBytes(24).toString('hex');
    this.spy = spy;
    this.tools = new Map(
      spyTools(spy)
        .filter((tool) => EXPOSED_TOOL_NAMES.has(tool.name))
        .map((tool) => [tool.name, tool]),
    );
  }

  public async handleFetch(req: Request): Promise<Response> {
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        },
      });
    }
    if (req.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'POST required' }), {
        status: 405,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${this.token}`) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
    let rpc: JsonRpcRequest;
    try {
      rpc = (await req.json()) as JsonRpcRequest;
    } catch {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }), {
        status: 400,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
    try {
      const result = await this.dispatch(rpc.method ?? '', rpc.params ?? {});
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id ?? null, result }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (err) {
      const rpcCode = (err as { rpcCode?: number }).rpcCode ?? -32603;
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: rpc.id ?? null,
        error: { code: rpcCode, message: err instanceof Error ? err.message : String(err) },
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
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
        if (!address || typeof address === 'string') return reject(new Error('Không lấy được cổng Spy MCP'));
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
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'writer-room-spy', version: '0.1.0' },
        };
      case 'ping': return {};
      case 'tools/list':
        return {
          tools: [...this.tools.values()].map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: inputSchemas[tool.name] ?? { type: 'object', properties: {} },
          })),
        };
      case 'tools/call': return this.callTool(String(params['name'] ?? ''), (params['arguments'] ?? {}) as Record<string, unknown>);
      default: {
        const err = new Error(`method not found: ${method}`) as Error & { rpcCode: number };
        err.rpcCode = -32601;
        throw err;
      }
    }
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) {
      const err = new Error(`tool not found: ${name}`) as Error & { rpcCode: number };
      err.rpcCode = -32602;
      throw err;
    }
    try {
      const result = await tool.handler(args, { subject: SUBJECT, scopes: SCOPES });
      const content: Array<Record<string, string>> = [{ type: 'text', text: JSON.stringify(result) }];
      if (name === 'spy_read_video_material' && args['include_thumbnail'] === true) {
        const videoSnapshotIds = Array.isArray(args['video_snapshot_ids']) ? args['video_snapshot_ids'] : [];
        for (const id of videoSnapshotIds) {
          if (typeof id !== 'string') continue;
          const snapshot = this.spy.store.getVideoSnapshot(id);
          if (!snapshot?.thumbnail) continue;
          try {
            const bytes = await this.spy.artifacts.read(snapshot.thumbnail, 2 * 1024 * 1024);
            content.push({ type: 'image', data: bytes.toString('base64'), mimeType: snapshot.thumbnail.mimeType });
          } catch {
            // Text result already declares the thumbnail; an unavailable local
            // artifact must not make its transcript page unusable.
          }
        }
      }
      return { content };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }],
      };
    }
  }
}
