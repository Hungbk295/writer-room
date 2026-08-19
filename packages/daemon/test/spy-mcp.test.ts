import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpyService } from '@writer-room/spy';
import { McpSpyServer } from '../src/spy-mcp.ts';

let root = '';
let server: McpSpyServer | undefined;
let spy: SpyService | undefined;

afterEach(async () => {
  server?.stop();
  spy?.store.close();
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
  server = undefined;
  spy = undefined;
});

describe('Spy MCP server', () => {
  test('requires bearer auth and advertises only the acquisition/read workflow', async () => {
    root = await mkdtemp(join(tmpdir(), 'writer-room-spy-mcp-'));
    spy = new SpyService({ dataRoot: root });
    await spy.init();
    server = new McpSpyServer(spy);
    const info = await server.start();

    const unauthenticated = await fetch(info.url, {
      method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(unauthenticated.status).toBe(401);

    const response = await fetch(info.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    const payload = await response.json() as { result: { tools: Array<{ name: string }> } };
    expect(payload.result.tools.map((tool) => tool.name).sort()).toEqual([
      'spy_channel_start', 'spy_find_videos', 'spy_get_status', 'spy_read_transcript',
      'spy_read_video_material', 'spy_run_manifest', 'spy_video_start', 'spy_wait',
    ]);
  });
});
