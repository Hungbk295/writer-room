import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { SpyStore } from '../src/store.ts';
import { HarvestService } from '../src/harvest.ts';
import type { VideoSnapshot } from '../src/schema.ts';
import type { YoutubePort, YoutubeTranscript } from '../src/adapters/ytdlp.ts';
import { OperationManager } from '../src/operations.ts';
import { DeterministicStubLlm } from '../src/adapters/llm.ts';

let tempDir = '';
let store: SpyStore;

afterEach(async () => {
  store?.close();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

async function setup() {
  tempDir = await mkdtemp(join(tmpdir(), 'spy-harvest-'));
  store = new SpyStore(join(tempDir, 'spy.sqlite'));
  const op = store.createOrGetOperation({
    kind: 'acquire_channel',
    ownerSubject: 'test',
    idempotencyKey: 'harvest-setup-key',
    request: {},
  });
  const run = store.createSpyRun({
    operationId: op.operation.id,
    kind: 'channel',
    canonicalSource: 'https://www.youtube.com/@demo/videos',
    sourceIdentity: 'youtube:channel:/@demo',
    config: { depth: 'metadata' },
  });
  const now = Date.now();
  const mk = (id: string, views: number, daysAgo: number, duration: number): VideoSnapshot => ({
    id: randomUUID(),
    spyRunId: run.id,
    sourceVideoId: id,
    canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
    title: `Video ${id}`,
    channelTitle: 'Demo',
    rank: 1,
    viewCount: views,
    likeCount: 10,
    commentCount: 2,
    durationSec: duration,
    publishedAt: new Date(now - daysAgo * 86_400_000).toISOString(),
    tags: [],
    transcriptStatus: 'ok',
    transcriptSource: 'manual',
    frameStatus: 'skipped',
    thumbnail: null,
    createdAt: new Date().toISOString(),
  });
  // Old high views vs new high velocity
  store.insertVideoSnapshot(mk('AAAAAAAAAAA', 100_000, 400, 600));
  store.insertVideoSnapshot(mk('BBBBBBBBBBB', 10_000, 3, 600));
  store.insertVideoSnapshot(mk('CCCCCCCCCCC', 5_000, 10, 180));
  return run;
}

describe('harvest listChannelVideos', () => {
  test('default velocity ranks newer video above older with more views', async () => {
    const run = await setup();
    const harvest = new HarvestService(
      store,
      {} as YoutubePort,
      new OperationManager(store),
      new DeterministicStubLlm(),
    );
    const result = harvest.listChannelVideos({ spyRunId: run.id, orderBy: 'velocity', limit: 10 });
    expect(result.videos[0]!.videoId).toBe('BBBBBBBBBBB');
    expect(result.total).toBe(3);
  });

  test('views order puts old video first', async () => {
    const run = await setup();
    const harvest = new HarvestService(
      store,
      {} as YoutubePort,
      new OperationManager(store),
      new DeterministicStubLlm(),
    );
    const result = harvest.listChannelVideos({ spyRunId: run.id, orderBy: 'views', limit: 10 });
    expect(result.videos[0]!.videoId).toBe('AAAAAAAAAAA');
  });
});

describe('transcript idempotency', () => {
  test('second fetch skips when video_transcripts exists', async () => {
    await setup();
    let calls = 0;
    const youtube: YoutubePort = {
      inspectVideo: async () => { throw new Error('unused'); },
      listChannel: async () => [],
      streamUrl: async () => '',
      thumbnail: async () => ({ bytes: new Uint8Array(), mimeType: 'image/jpeg' }),
      fetchTranscript: async (): Promise<YoutubeTranscript> => {
        calls += 1;
        return {
          status: 'ok',
          language: 'vi',
          source: 'manual',
          segments: [{ startSec: 0, endSec: 1, text: 'xin chào thế giới' }],
        };
      },
    };
    const harvest = new HarvestService(store, youtube, new OperationManager(store), new DeterministicStubLlm());
    const first = await harvest.fetchTranscriptsSync({
      videoIds: ['AAAAAAAAAAA'],
      idempotencyKey: 'fetch-1-aaaaaaa',
    });
    const second = await harvest.fetchTranscriptsSync({
      videoIds: ['AAAAAAAAAAA'],
      idempotencyKey: 'fetch-2-aaaaaaa',
    });
    expect(first.fetched).toBe(1);
    expect(second.skipped).toBe(1);
    expect(calls).toBe(1);
  });
});
