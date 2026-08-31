import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpyService } from '@writer-room/spy';
import type { VideoSnapshot, YoutubePort } from '@writer-room/spy';
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

async function callMcp(info: { url: string; token: string }, id: number, method: string, params?: Record<string, unknown>) {
  const response = await fetch(info.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ result: { content?: Array<{ text: string }>; tools?: Array<{ name: string; inputSchema: Record<string, unknown> }> } }>;
}

async function callMcpRaw(info: { url: string; token: string }, id: number, method: string, params?: Record<string, unknown>) {
  const response = await fetch(info.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    result?: { tools?: Array<{ name: string }>; content?: Array<{ text: string }> };
    error?: { code: number; message: string };
  }>;
}

function addVideoSnapshot(spyService: SpyService): { spyRunId: string; snapshot: VideoSnapshot } {
  const operation = spyService.store.createOrGetOperation({
    kind: 'acquire_channel', ownerSubject: 'test', idempotencyKey: `mcp-${randomUUID()}`, request: {},
  });
  const run = spyService.store.createSpyRun({
    operationId: operation.operation.id,
    kind: 'channel',
    canonicalSource: 'https://www.youtube.com/@demo/videos',
    sourceIdentity: 'youtube:channel:/@demo',
    config: {},
  });
  const snapshot: VideoSnapshot = {
    id: randomUUID(), spyRunId: run.id, sourceVideoId: 'AABBCCDDEEF',
    canonicalUrl: 'https://www.youtube.com/watch?v=AABBCCDDEEF', title: 'Video đã quét',
    channelTitle: 'Kênh Demo', rank: 1, viewCount: 1234, likeCount: 12, commentCount: 3,
    durationSec: 120, publishedAt: '2026-01-01T00:00:00.000Z', tags: [],
    transcriptStatus: 'ok', transcriptSource: 'manual', frameStatus: 'skipped', thumbnail: null,
    createdAt: new Date().toISOString(),
  };
  spyService.store.insertVideoSnapshot(snapshot);
  return { spyRunId: run.id, snapshot };
}

describe('Spy MCP server', () => {
  test('requires bearer auth and advertises only approved acquisition and read intelligence tools', async () => {
    root = await mkdtemp(join(tmpdir(), 'writer-room-spy-mcp-'));
    spy = new SpyService({ dataRoot: root });
    await spy.init();
    server = new McpSpyServer(spy);
    const info = await server.start();

    const unauthenticated = await fetch(info.url, {
      method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(unauthenticated.status).toBe(401);

    const payload = await callMcp(info, 2, 'tools/list');
    const tools = payload.result.tools!;
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'spy_channel_momentum', 'spy_channel_outliers', 'spy_channel_profile', 'spy_channel_start',
      'spy_channel_videos', 'spy_competitors_list', 'spy_corpus_channels', 'spy_corpus_videos',
      'spy_find_videos', 'spy_get_status', 'spy_global_video_search', 'spy_loop_inbox', 'spy_loop_report',
      'spy_loop_status', 'spy_read_transcript', 'spy_read_video_material',
      'spy_run_manifest', 'spy_title_patterns', 'spy_topics_list', 'spy_video_comments',
      'spy_video_metrics', 'spy_video_start', 'spy_wait',
    ]);
    // Mutation tools must never appear in the allowlist.
    expect(tools.map((tool) => tool.name)).not.toEqual(expect.arrayContaining([
      'spy_cancel', 'spy_competitors_update', 'spy_discover_channels', 'spy_discover_videos',
      'spy_expand_graph', 'spy_niche_set', 'spy_scan_candidates', 'spy_transcript_fetch',
      'spy_transcript_normalize',
      // spy.loop.write tools — intentionally excluded from allowlist
      'spy_loop_decide', 'spy_loop_tick',
    ]));

    const channelVideos = tools.find((tool) => tool.name === 'spy_channel_videos')!.inputSchema;
    expect(channelVideos).toMatchObject({
      anyOf: [{ required: ['channel_id'] }, { required: ['spy_run_id'] }],
      properties: {
        order_by: { enum: ['views', 'velocity', 'published_at', 'duration', 'engagement'] },
        limit: { minimum: 1, maximum: 100 },
      },
    });
    const comments = tools.find((tool) => tool.name === 'spy_video_comments')!.inputSchema;
    expect(comments).toMatchObject({
      anyOf: [{ required: ['video_id'] }, { required: ['channel_id'] }],
      properties: { max_results: { minimum: 1, maximum: 100 }, order: { enum: ['relevance', 'time'] } },
    });
    const globalSearch = tools.find((tool) => tool.name === 'spy_global_video_search')!.inputSchema;
    expect(globalSearch).toMatchObject({
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { minLength: 1, maxLength: 200 },
        limit: { minimum: 1, maximum: 50, default: 20 },
        language: { default: 'vi' },
        region: { default: 'VN' },
      },
    });
  });

  test('routes read intelligence through the existing Spy service without starting a new operation', async () => {
    root = await mkdtemp(join(tmpdir(), 'writer-room-spy-mcp-'));
    spy = new SpyService({ dataRoot: root });
    await spy.init();
    const { spyRunId, snapshot } = addVideoSnapshot(spy);
    server = new McpSpyServer(spy);
    const info = await server.start();

    const videosPayload = await callMcp(info, 3, 'tools/call', {
      name: 'spy_channel_videos', arguments: { spy_run_id: spyRunId, order_by: 'views' },
    });
    const videos = JSON.parse(videosPayload.result.content![0]!.text) as {
      total: number; videos: Array<{ videoId: string; views: number }>; sampleMeta: { spyRunId: string };
    };
    expect(videos).toMatchObject({
      total: 1,
      videos: [{ videoId: snapshot.sourceVideoId, views: snapshot.viewCount }],
      sampleMeta: { spyRunId },
    });

    const corpusPayload = await callMcp(info, 4, 'tools/call', {
      name: 'spy_corpus_videos', arguments: { title_query: 'đã quét' },
    });
    const corpus = JSON.parse(corpusPayload.result.content![0]!.text) as {
      count: number; videos: Array<{ sourceVideoId: string }>;
    };
    expect(corpus).toMatchObject({ count: 1, videos: [{ sourceVideoId: snapshot.sourceVideoId }] });
    expect(spy.store.listVideoSnapshots(spyRunId)).toHaveLength(1);
  });

  test('routes global keyword search and preserves provider provenance', async () => {
    root = await mkdtemp(join(tmpdir(), 'writer-room-spy-mcp-global-search-'));
    const youtube = {
      async searchVideos(query: string, limit: number) {
        expect({ query, limit }).toEqual({ query: 'tài chính việt nam', limit: 7 });
        return [{
          sourceVideoId: 'abc123def45',
          canonicalUrl: 'https://www.youtube.com/watch?v=abc123def45',
          title: 'Video tiếng Việt',
          channelTitle: 'Kênh Việt',
          channelId: 'UCviet',
          viewCount: 987,
          durationSec: 321,
          publishedAt: '2026-08-03',
          thumbnailUrl: null,
        }];
      },
    } as YoutubePort;
    spy = new SpyService({ dataRoot: join(root, 'spy'), youtube });
    await spy.init();
    server = new McpSpyServer(spy);
    const info = await server.start();

    const payload = await callMcp(info, 6, 'tools/call', {
      name: 'spy_global_video_search', arguments: { query: 'tài chính việt nam', limit: 7 },
    });
    const result = JSON.parse(payload.result.content![0]!.text) as {
      providerUsed: string; fallbackReason: string | null; videos: Array<Record<string, unknown>>;
    };

    expect(result).toMatchObject({
      providerUsed: 'ytdlp',
      localeHintsApplied: false,
      fallbackReason: 'youtube_data_api_not_configured',
      videos: [{
        videoId: 'abc123def45',
        title: 'Video tiếng Việt',
        channelTitle: 'Kênh Việt',
        canonicalUrl: 'https://www.youtube.com/watch?v=abc123def45',
        viewCount: 987,
        durationSec: 321,
        publishedAt: '2026-08-03',
      }],
    });
    expect(JSON.stringify(result)).not.toContain('youtubeDataApiKey');
  });

  /**
   * Hard gate G6 (`plan/codex/spy-autoloop-hardgate.md`).
   * `SCOPES` đã chứa `spy.start`, nên `assertScopes` KHÔNG chặn được mutation —
   * `EXPOSED_TOOL_NAMES` là gate duy nhất. Vắng mặt trong tools/list là chưa đủ:
   * phải chứng minh gọi thẳng cũng bị từ chối và DB không đổi.
   */
  test('allowlist: MCP không với tới được loop mutation tool (G6)', async () => {
    root = await mkdtemp(join(tmpdir(), 'writer-room-spy-mcp-g6-'));
    spy = new SpyService({ dataRoot: root });
    await spy.init();
    server = new McpSpyServer(spy);
    const info = await server.start();

    const listed = await callMcpRaw(info, 20, 'tools/list');
    const names = (listed.result?.tools ?? []).map((tool) => tool.name);
    expect(names).not.toContain('spy_loop_decide');
    expect(names).not.toContain('spy_loop_tick');
    // Read tool của loop có mặt → vắng mặt ở trên là chủ ý, không phải cả họ chưa tồn tại.
    expect(names).toContain('spy_loop_inbox');

    const topicId = 'finance-vi';
    spy.store.upsertTopic({ topicId, label: 'Tài chính cá nhân VI', market: 'vi', language: 'vi' });
    const channelsBefore = Object.values(spy.store.countTopicChannelsByStatus(topicId))
      .reduce((sum, n) => sum + n, 0);
    const tickBefore = spy.store.getLastTick(topicId);

    for (const [index, toolName] of ['spy_loop_decide', 'spy_loop_tick'].entries()) {
      const denied = await callMcpRaw(info, 21 + index, 'tools/call', {
        name: toolName,
        arguments: { topic_id: topicId, channel_ids: ['UCzzzzzzzzzzzzzzzzzzzzzz'], status: 'shortlisted' },
      });
      expect(denied.result).toBeUndefined();
      expect(denied.error?.code).toBe(-32602);
      expect(denied.error?.message).toContain('tool not found');
    }

    expect(Object.values(spy.store.countTopicChannelsByStatus(topicId)).reduce((sum, n) => sum + n, 0))
      .toBe(channelsBefore);
    expect(spy.store.getLastTick(topicId)).toEqual(tickBefore);
  });

  test('spy_loop_report trả null khi không có loop, không bắt đầu operation', async () => {
    root = await mkdtemp(join(tmpdir(), 'writer-room-spy-mcp-loop-'));
    spy = new SpyService({ dataRoot: root });
    await spy.init();
    server = new McpSpyServer(spy);
    const info = await server.start();

    const runsBefore = spy.store.listSpyRuns(undefined, 100);

    const payload = await callMcp(info, 5, 'tools/call', {
      name: 'spy_loop_report', arguments: {},
    });
    const result = JSON.parse(payload.result.content![0]!.text) as { report: unknown; note?: string };

    // spy.loop chưa có hoặc không có reports → report là null hoặc undefined
    expect(result.report === null || result.report === undefined).toBe(true);
    // Không có operation mới được tạo
    const runsAfter = spy.store.listSpyRuns(undefined, 100);
    expect(runsAfter.length).toBe(runsBefore.length);
  });
});
