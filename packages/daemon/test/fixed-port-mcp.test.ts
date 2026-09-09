import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getOrCreateMcpToken } from '../src/paths.ts';
import { createHttpApp, createHandler } from '../src/http.ts';

let root = '';

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

describe('Daemon fixed port MCP routing (Option B)', () => {
  test('persists and reuses stable token across calls', () => {
    root = join(tmpdir(), `writer-room-token-test-${Date.now()}`);
    const token1 = getOrCreateMcpToken(root);
    expect(token1).toBeTruthy();
    expect(token1.length).toBeGreaterThanOrEqual(24);

    const token2 = getOrCreateMcpToken(root);
    expect(token2).toBe(token1);
  });

  test('routes JSON-RPC over POST /api/spy/mcp and /api/writer/mcp with Bearer token', async () => {
    root = await mkdtemp(join(tmpdir(), 'writer-room-fixed-mcp-'));
    process.env.WRITER_ROOM_DATA_DIR = root;

    const app = await createHttpApp();
    const handler = createHandler(app);

    const token = getOrCreateMcpToken(root);

    // 1. GET /api/spy/mcp returns stable URL and token
    const getRes = await handler(new Request('http://127.0.0.1:4187/api/spy/mcp', {
      method: 'GET',
    }));
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as { url: string; token: string };
    expect(getBody.url).toBe('http://127.0.0.1:4187/api/spy/mcp');
    expect(getBody.token).toBe(token);

    // 2. OPTIONS /api/spy/mcp returns CORS headers
    const optionsRes = await handler(new Request('http://127.0.0.1:4187/api/spy/mcp', {
      method: 'OPTIONS',
    }));
    expect(optionsRes.status).toBe(204);
    expect(optionsRes.headers.get('Access-Control-Allow-Origin')).toBe('*');

    // 3. POST /api/spy/mcp without token returns 401
    const unauthRes = await handler(new Request('http://127.0.0.1:4187/api/spy/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }));
    expect(unauthRes.status).toBe(401);

    // 4. POST /api/spy/mcp with Bearer token lists tools
    const spyToolsRes = await handler(new Request('http://127.0.0.1:4187/api/spy/mcp', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    }));
    expect(spyToolsRes.status).toBe(200);
    const spyToolsBody = (await spyToolsRes.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(spyToolsBody.result.tools.some((t) => t.name === 'spy_channel_start')).toBe(true);
    expect(spyToolsBody.result.tools.some((t) => t.name === 'spy_video_download_audio')).toBe(true);

    // 5. POST /api/writer/mcp with Bearer token lists tools
    const writerToolsRes = await handler(new Request('http://127.0.0.1:4187/api/writer/mcp', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
    }));
    expect(writerToolsRes.status).toBe(200);
    const writerToolsBody = (await writerToolsRes.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(writerToolsBody.result.tools.length).toBe(17);
    expect(writerToolsBody.result.tools.some((t) => t.name === 'writer_health')).toBe(true);

    // 6. POST /api/general-pack/mcp with Bearer token lists tools
    const gpToolsRes = await handler(new Request('http://127.0.0.1:4187/api/general-pack/mcp', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list' }),
    }));
    expect(gpToolsRes.status).toBe(200);
    const gpToolsBody = (await gpToolsRes.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(gpToolsBody.result.tools.some((t) => t.name === 'pack_list')).toBe(true);

    // Clean up app servers
    app.spyMcp?.stop();
    app.writerMcp?.stop();
    app.generalPackMcp?.stop();
    app.harness.dispose();
  });
});
