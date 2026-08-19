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
  'spy_read_transcript',
  'spy_read_video_material',
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
      url: { type: 'string' },
      selection_mode: { type: 'string', enum: ['popular', 'latest'] },
      top_n: { type: 'integer', minimum: 1, maximum: 20 },
      scan_limit: { type: 'integer', minimum: 1, maximum: 500 },
      rank_by: { type: 'string', enum: ['velocity', 'views'] },
      depth: { type: 'string', enum: ['metadata', 'transcript'] },
    },
    required: ['url'],
  },
  spy_video_start: {
    type: 'object',
    properties: { url: { type: 'string' }, depth: { type: 'string', enum: ['metadata', 'transcript'] } },
    required: ['url'],
  },
  spy_get_status: {
    type: 'object', properties: { operation_id: { type: 'string' } }, required: ['operation_id'],
  },
  spy_wait: {
    type: 'object',
    properties: { operation_id: { type: 'string' }, max_wait_seconds: { type: 'integer', minimum: 1, maximum: 600 } },
    required: ['operation_id'],
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
  readonly token = randomBytes(24).toString('hex');
  private server: Server | null = null;
  private url = '';
  private readonly tools: Map<string, SpyToolDef>;
  private readonly spy: SpyService;

  constructor(spy: SpyService) {
    this.spy = spy;
    this.tools = new Map(
      spyTools(spy)
        .filter((tool) => EXPOSED_TOOL_NAMES.has(tool.name))
        .map((tool) => [tool.name, tool]),
    );
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
