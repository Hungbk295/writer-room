import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { SpyStore } from '../src/store.ts';
import { buildSourcePack } from '../src/source-pack.ts';
import type { VideoSnapshot } from '../src/schema.ts';

let tempDir = '';
let store: SpyStore;

afterEach(async () => {
  store?.close();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

describe('buildSourcePack', () => {
  test('marks UNTRUSTED and includes transcript bodies', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'spy-pack-'));
    store = new SpyStore(join(tempDir, 'spy.sqlite'));
    const op = store.createOrGetOperation({
      kind: 'acquire_channel',
      ownerSubject: 'test',
      idempotencyKey: 'pack-key-12345678',
      request: {},
    });
    const run = store.createSpyRun({
      operationId: op.operation.id,
      kind: 'channel',
      canonicalSource: 'https://www.youtube.com/@demo/videos',
      sourceIdentity: 'youtube:channel:/@demo',
      config: {},
    });
    const snap: VideoSnapshot = {
      id: randomUUID(),
      spyRunId: run.id,
      sourceVideoId: 'AAAAAAAAAAA',
      canonicalUrl: 'https://www.youtube.com/watch?v=AAAAAAAAAAA',
      title: 'Bài mẫu',
      channelTitle: 'Kênh Demo',
      rank: 1,
      viewCount: 1000,
      likeCount: 10,
      commentCount: 1,
      durationSec: 120,
      publishedAt: '2026-06-01T00:00:00.000Z',
      tags: [],
      transcriptStatus: 'ok',
      transcriptSource: 'manual',
      frameStatus: 'skipped',
      thumbnail: null,
      createdAt: new Date().toISOString(),
    };
    store.insertVideoSnapshot(snap);
    store.insertTranscriptSegments([
      {
        id: randomUUID(),
        videoSnapshotId: snap.id,
        index: 0,
        startSec: 0,
        endSec: 2,
        text: 'Xin chào đây là đoạn mở bài.',
        source: 'manual',
        language: 'vi',
        contentHash: 'a'.repeat(64),
      },
    ]);

    const pack = buildSourcePack(store, { spyRunId: run.id, limit: 5 });
    expect(pack.markdown).toContain('UNTRUSTED');
    expect(pack.markdown).toContain('Xin chào đây là đoạn mở bài.');
    expect(pack.markdown).toContain('Bài mẫu');
    expect(pack.videoIds).toEqual(['AAAAAAAAAAA']);
    expect(pack.wordCount).toBeGreaterThan(10);
  });
});
