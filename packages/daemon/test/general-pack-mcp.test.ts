import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpyService } from '@writer-room/spy';
import { McpGeneralPackServer } from '../src/general-pack-mcp.ts';
import { commitGeneralPack, stageEntry } from '../src/writer/general-pack.ts';

let root = '';
let server: McpGeneralPackServer | undefined;
let spy: SpyService | undefined;

afterEach(async () => {
  server?.stop();
  spy?.store.close();
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
  server = undefined;
  spy = undefined;
});

async function callMcp(info: { url: string; token: string }, id: number, method: string, params?: Record<string, unknown>) {
  const response = await fetch(info.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    result: {
      content?: Array<{ text: string }>;
      tools?: Array<{ name: string; inputSchema: Record<string, unknown> }>;
      resources?: Array<{ uri: string; name: string; description?: string; mimeType?: string }>;
      contents?: Array<{ uri: string; mimeType: string; text: string }>;
      capabilities?: Record<string, unknown>;
    };
  }>;
}

describe('General Pack MCP server', () => {
  test('authenticates and exposes tools and MCP resources', async () => {
    root = await mkdtemp(join(tmpdir(), 'writer-room-genpack-mcp-'));
    spy = new SpyService({ dataRoot: join(root, 'spy') });
    await spy.init();

    server = new McpGeneralPackServer(spy, root);
    const info = await server.start();

    // 1. Unauthorized
    const unauth = await fetch(info.url, {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(unauth.status).toBe(401);

    // 2. Initialize advertises resources and tools capabilities
    const initPayload = await callMcp(info, 2, 'initialize');
    expect(initPayload.result.capabilities).toMatchObject({
      tools: { listChanged: false },
      resources: { listChanged: false },
    });

    // 3. Tools list has all 10 pack tools
    const toolsPayload = await callMcp(info, 3, 'tools/list');
    const toolNames = toolsPayload.result.tools!.map((t) => t.name).sort();
    expect(toolNames).toEqual([
      'pack_commit',
      'pack_get',
      'pack_get_transcript',
      'pack_health',
      'pack_list',
      'pack_list_candidate_videos',
      'pack_stage_entry',
      'pack_stage_taste_dna',
      'pack_validate_entry',
      'pack_validate_taste_dna',
    ]);

    // 4. Resources list returns example tags schema by default
    const resListPayload = await callMcp(info, 4, 'resources/list');
    const resources = resListPayload.result.resources!;
    expect(resources.some((r) => r.uri === 'general-pack://schema/example-tags')).toBe(true);

    // 5. Read example-tags resource
    const readTagsPayload = await callMcp(info, 5, 'resources/read', { uri: 'general-pack://schema/example-tags' });
    const content = readTagsPayload.result.contents![0]!;
    expect(content.uri).toBe('general-pack://schema/example-tags');
    expect(content.mimeType).toBe('application/json');
    const parsed = JSON.parse(content.text) as { tags: string[] };
    expect(parsed.tags.length).toBe(11);

    // 6. Stage and commit a pack, then verify it appears in resources/list
    const transcript = 'Day la transcript thuc te de test grounding.';
    await stageEntry('kenh-demo', {
      videoId: 'v1',
      title: 'Video 1',
      hook: { quote: 'Day la transcript', debt: 'Tao to mo ban dau' },
      beats: [
        { beat: 'B1', newInformation: 'Info 1', quotes: ['thuc te'] },
        { beat: 'B2', newInformation: 'Info 2', quotes: ['de test'] },
      ],
      examples: [{ text: 'Day la transcript', tag: 'kinh nghiệm host' }],
      payoff: { quote: 'grounding.', note: 'Ket thuc' },
      boundary: { quote: 'de test', note: 'Ranh gioi' },
    }, transcript, root);

    await commitGeneralPack('kenh-demo', {
      reviewerNote: 'Da kiem tra day du 11 tags va quote grounding',
      includeTasteDna: false,
      videoIds: ['v1'],
    }, root);

    const updatedResList = await callMcp(info, 6, 'resources/list');
    const packResource = updatedResList.result.resources!.find((r) => r.uri.includes('kenh-demo'));
    expect(packResource).toBeDefined();
    expect(packResource!.name).toBe('General Pack: kenh-demo');

    // 7. Read channel pack resource
    const readPackPayload = await callMcp(info, 7, 'resources/read', { uri: packResource!.uri });
    const packContent = readPackPayload.result.contents![0]!;
    expect(packContent.mimeType).toBe('text/markdown');
    expect(packContent.text).toContain('Video 1');
  });
});
