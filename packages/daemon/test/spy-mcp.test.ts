import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpyService } from '@writer-room/spy';
import type { VideoSnapshot } from '@writer-room/spy';
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
      'spy_find_videos', 'spy_get_status', 'spy_read_transcript', 'spy_read_video_material',
      'spy_run_manifest', 'spy_title_patterns', 'spy_video_comments', 'spy_video_metrics',
      'spy_video_start', 'spy_wait',
    ]);
    expect(tools.map((tool) => tool.name)).not.toEqual(expect.arrayContaining([
      'spy_cancel', 'spy_competitors_update', 'spy_discover_channels', 'spy_discover_videos',
      'spy_expand_graph', 'spy_niche_set', 'spy_scan_candidates', 'spy_transcript_fetch',
      'spy_transcript_normalize',
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
});
