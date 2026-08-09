/**
 * MCP Team Server — streamable HTTP trên 127.0.0.1, port ngẫu nhiên + bearer
 * token per-run (decision 0010 ADR-5). JSON-RPC tối giản (initialize,
 * tools/list, tools/call, ping) — streamable HTTP + compatibility SSE cho Agy;
 * chạy được cả Bun (runtime) lẫn Node 22 (test) qua node:http.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { McpServerInfo, TeamMessage } from '@writer-room/shared';
import type { TeamStore } from './store.ts';

const PROTOCOL_VERSION = '2025-03-26';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: 'team_send_message',
    description: 'Gửi message vào team channel. Mention agent khác qua trường mentions (danh sách agent id).',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string' },
        senderAgentId: { type: 'string' },
        body: { type: 'string' },
        mentions: { type: 'array', items: { type: 'string' } },
        replyTo: { type: 'string' },
        idempotencyKey: { type: 'string', description: 'retry không tạo message trùng' },
      },
      required: ['channel', 'senderAgentId', 'body'],
    },
  },
  {
    name: 'team_read_messages',
    description: 'Đọc messages trong channel sau một cursor (monotonic).',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string' },
        afterCursor: { type: 'number' },
        limit: { type: 'number' },
      },
      required: ['channel'],
    },
  },
  {
    name: 'team_ack_messages',
    description: 'Đánh dấu đã đọc tới cursor.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string' },
        agentId: { type: 'string' },
        throughCursor: { type: 'number' },
      },
      required: ['channel', 'agentId', 'throughCursor'],
    },
  },
  {
    name: 'team_get_assignment',
    description: 'Lấy assignment hiện tại của agent.',
    inputSchema: {
      type: 'object',
      properties: { agentId: { type: 'string' } },
      required: ['agentId'],
    },
  },
  {
    name: 'team_update_status',
    description: 'Cập nhật trạng thái agent (idle/running/paused/error) + summary ngắn.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
        status: { type: 'string', enum: ['idle', 'running', 'paused', 'error'] },
        summary: { type: 'string' },
      },
      required: ['agentId', 'status'],
    },
  },
  {
    name: 'team_turn_complete',
    description: 'Báo Orchestrator rằng turn interactive đã ghi xong artifact (hoặc thất bại). Chỉ gọi sau khi hoàn tất nhiệm vụ được giao.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
        turnId: { type: 'number' },
        status: { type: 'string', enum: ['done', 'failed'] },
        summary: { type: 'string' },
      },
      required: ['agentId', 'turnId', 'status'],
    },
  },
];

export interface McpTurnCompleteRequest {
  agentId: string;
  turnId: number;
  status: 'done' | 'failed';
  summary?: string;
}

export class McpTeamServer {
  readonly token = randomBytes(24).toString('hex');
  private server: Server | null = null;
  private url = '';
  private sseClients = new Map<string, ServerResponse>();

  constructor(
    private store: TeamStore,
    /** hook để workflow route mentions khi agent gửi message qua MCP */
    private onMessage: (msg: TeamMessage) => void = () => {},
    /** hook để một agent interactive chốt đúng turn đang chạy */
    private onTurnComplete: (request: McpTurnCompleteRequest) => void = () => {},
  ) {}

  info(): McpServerInfo | null {
    return this.url ? { url: this.url, token: this.token } : null;
  }

  start(): Promise<McpServerInfo> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => this.handle(req, res));
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') return reject(new Error('mcp listen failed'));
        this.url = `http://127.0.0.1:${addr.port}/mcp`;
        this.server = server;
        resolve({ url: this.url, token: this.token });
      });
    });
  }

  stop(): void {
    for (const response of this.sseClients.values()) {
      try { response.end(); } catch { /* already closed */ }
    }
    this.sseClients.clear();
    this.server?.close();
    this.server = null;
    this.url = '';
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Claude/Codex/Agy gửi bearer header; query token chỉ giữ tương thích với
    // các client SSE cũ. Vẫn bind loopback và token ngẫu nhiên mỗi sidecar run.
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad url' }));
      return;
    }
    const queryToken = parsedUrl.searchParams.get('token') ?? '';
    if (req.headers.authorization !== `Bearer ${this.token}` && queryToken !== this.token) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (req.method === 'GET' && (
      (req.headers.accept ?? '').includes('text/event-stream')
      || parsedUrl.pathname.endsWith('/sse')
    )) {
      // Compatibility endpoint for Antigravity/Agy, whose mcp_config.json
      // transport is SSE. Streamable-HTTP clients continue using POST/JSON.
      const sessionId = randomBytes(12).toString('hex');
      const endpoint = new URL(parsedUrl.toString());
      endpoint.searchParams.set('sessionId', sessionId);
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      this.sseClients.set(sessionId, res);
      res.write(`event: endpoint\ndata: ${endpoint.toString()}\n\n`);
      res.on('close', () => this.sseClients.delete(sessionId));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' });
      res.end();
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    let rpc: JsonRpcRequest;
    try {
      rpc = JSON.parse(body) as JsonRpcRequest;
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
      return;
    }
    const responseFor = (payload: unknown): void => {
      const sessionId = parsedUrl.searchParams.get('sessionId');
      const stream = sessionId ? this.sseClients.get(sessionId) : undefined;
      if (stream) {
        stream.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
        res.writeHead(202);
        res.end();
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      }
    };
    // notification (không id) → 202
    if (rpc.id === undefined || rpc.id === null) {
      res.writeHead(202);
      res.end();
      return;
    }
    try {
      const result = this.dispatch(rpc.method ?? '', rpc.params ?? {});
      responseFor({ jsonrpc: '2.0', id: rpc.id, result });
    } catch (err) {
      const code = (err as { rpcCode?: number }).rpcCode ?? -32603;
      responseFor({ jsonrpc: '2.0', id: rpc.id, error: { code, message: (err as Error).message } });
    }
  }

  private dispatch(method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'writer-room-team', version: '0.1.0' },
        };
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: TOOLS };
      case 'tools/call':
        return this.callTool(String(params['name'] ?? ''), (params['arguments'] ?? {}) as Record<string, unknown>);
      default: {
        const err = new Error(`method not found: ${method}`) as Error & { rpcCode: number };
        err.rpcCode = -32601;
        throw err;
      }
    }
  }

  private callTool(name: string, args: Record<string, unknown>): unknown {
    const text = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });
    switch (name) {
      case 'team_send_message': {
        const msg = this.store.send({
          channel: String(args['channel'] ?? ''),
          senderAgentId: String(args['senderAgentId'] ?? ''),
          body: String(args['body'] ?? ''),
          mentions: Array.isArray(args['mentions']) ? (args['mentions'] as string[]) : [],
          replyTo: typeof args['replyTo'] === 'string' ? args['replyTo'] : undefined,
          idempotencyKey: typeof args['idempotencyKey'] === 'string' ? args['idempotencyKey'] : undefined,
        });
        this.onMessage(msg);
        return text({ ok: true, cursor: msg.cursor, id: msg.id });
      }
      case 'team_read_messages':
        return text(
          this.store.read({
            channel: String(args['channel'] ?? ''),
            afterCursor: Number(args['afterCursor'] ?? 0),
            limit: args['limit'] === undefined ? undefined : Number(args['limit']),
          }),
        );
      case 'team_ack_messages':
        this.store.ack(String(args['channel'] ?? ''), String(args['agentId'] ?? ''), Number(args['throughCursor'] ?? 0));
        return text({ ok: true });
      case 'team_get_assignment':
        return text(this.store.getAssignment(String(args['agentId'] ?? '')));
      case 'team_update_status':
        this.store.setAgentState(
          String(args['agentId'] ?? ''),
          String(args['status'] ?? 'idle') as 'idle' | 'running' | 'paused' | 'error',
          typeof args['summary'] === 'string' ? args['summary'] : undefined,
        );
        return text({ ok: true });
      case 'team_turn_complete': {
        const turnId = Number(args['turnId']);
        const agentId = String(args['agentId'] ?? '');
        const status = String(args['status'] ?? '');
        if (!Number.isInteger(turnId) || turnId <= 0) throw new Error('turnId không hợp lệ');
        if (status !== 'done' && status !== 'failed') throw new Error('status phải là done hoặc failed');
        this.onTurnComplete({
          agentId,
          turnId,
          status,
          ...(typeof args['summary'] === 'string' ? { summary: args['summary'] } : {}),
        });
        return text({ ok: true, turnId, status });
      }
      default: {
        const err = new Error(`tool not found: ${name}`) as Error & { rpcCode: number };
        err.rpcCode = -32602;
        throw err;
      }
    }
  }
}
