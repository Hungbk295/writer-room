import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { SpyStore } from '../src/store.ts';
import { OperationManager } from '../src/operations.ts';
import type { VideoSnapshot } from '../src/schema.ts';

let tempDir = '';
let store: SpyStore;

afterEach(async () => {
  store?.close();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

async function setupStore() {
  tempDir = await mkdtemp(join(tmpdir(), 'spy-store-'));
  store = new SpyStore(join(tempDir, 'spy.sqlite'));
}

function sampleSnapshot(spyRunId: string): VideoSnapshot {
  return {
    id: randomUUID(),
    spyRunId,
    sourceVideoId: 'AAAAAAAAAAA',
    canonicalUrl: 'https://www.youtube.com/watch?v=AAAAAAAAAAA',
    title: 'Test video',
    channelTitle: 'Test Channel',
    rank: 1,
    viewCount: 1000,
    likeCount: 50,
    commentCount: 10,
    durationSec: 120,
    publishedAt: '2026-01-01T00:00:00.000Z',
    tags: [],
    transcriptStatus: 'ok',
    transcriptSource: 'manual',
    frameStatus: 'ok',
    thumbnail: null,
    createdAt: new Date().toISOString(),
  };
}

describe('SpyStore', () => {
  test('creates spy run and inserts snapshot', async () => {
    await setupStore();
    const op = store.createOrGetOperation({
      kind: 'acquire_video',
      ownerSubject: 'test',
      idempotencyKey: 'key-create-run',
      request: { url: 'https://youtu.be/AAAAAAAAAAA' },
    });
    const run = store.createSpyRun({
      operationId: op.operation.id,
      kind: 'video',
      canonicalSource: 'https://www.youtube.com/watch?v=AAAAAAAAAAA',
      sourceIdentity: 'youtube:video:AAAAAAAAAAA',
      config: {},
    });
    store.insertVideoSnapshot(sampleSnapshot(run.id));
    expect(store.listVideoSnapshots(run.id)).toHaveLength(1);
    expect(store.getSpyRun(run.id)?.kind).toBe('video');
  });

  test('idempotent operation returns same operation', async () => {
    await setupStore();
    const first = store.createOrGetOperation({
      kind: 'acquire_video',
      ownerSubject: 'test',
      idempotencyKey: 'same-key-12345678',
      request: { url: 'https://youtu.be/AAAAAAAAAAA' },
    });
    const second = store.createOrGetOperation({
      kind: 'acquire_video',
      ownerSubject: 'test',
      idempotencyKey: 'same-key-12345678',
      request: { url: 'https://youtu.be/AAAAAAAAAAA' },
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(first.operation.id).toBe(second.operation.id);
  });

  test('reconcile interrupted operations', async () => {
    await setupStore();
    const op = store.createOrGetOperation({
      kind: 'acquire_video',
      ownerSubject: 'test',
      idempotencyKey: 'key-reconcile-123456',
      request: {},
    });
    store.updateOperation(op.operation.id, { status: 'running' });
    store.createSpyRun({
      operationId: op.operation.id,
      kind: 'video',
      canonicalSource: 'https://www.youtube.com/watch?v=AAAAAAAAAAA',
      sourceIdentity: 'youtube:video:AAAAAAAAAAA',
      config: {},
    });
    const manager = new OperationManager(store);
    const count = manager.reconcile();
    expect(count).toBe(1);
    expect(store.getOperation(op.operation.id)?.status).toBe('interrupted');
  });

  test('deleteSpyRun removes run and snapshots', async () => {
    await setupStore();
    const op = store.createOrGetOperation({
      kind: 'acquire_video',
      ownerSubject: 'test',
      idempotencyKey: 'key-delete-run-1234',
      request: {},
    });
    const run = store.createSpyRun({
      operationId: op.operation.id,
      kind: 'video',
      canonicalSource: 'https://www.youtube.com/watch?v=AAAAAAAAAAA',
      sourceIdentity: 'youtube:video:AAAAAAAAAAA',
      config: {},
    });
    store.insertVideoSnapshot(sampleSnapshot(run.id));
    expect(store.listVideoSnapshots(run.id)).toHaveLength(1);
    expect(store.deleteSpyRun(run.id)).toBe(true);
    expect(store.getSpyRun(run.id)).toBeNull();
    expect(store.listVideoSnapshots(run.id)).toHaveLength(0);
    expect(store.deleteSpyRun(run.id)).toBe(false);
  });
});

describe('video transcript upsert', () => {
  const transcript = (over: Partial<{
    id: string; language: string; source: 'manual' | 'auto'; contentHash: string;
  }> = {}) => ({
    id: over.id ?? 'transcript-1',
    sourceVideoId: 'AAAAAAAAAAA',
    language: over.language ?? 'vi-orig',
    source: over.source ?? ('auto' as const),
    contentHash: over.contentHash ?? 'hash-old',
    fetchedAt: '2026-08-07T04:51:48.745Z',
    normalizedText: null,
    normalizedAt: null,
    normalizeModel: null,
  });

  test('refetching the same track updates in place', async () => {
    await setupStore();
    store.upsertVideoTranscript(transcript());
    store.upsertVideoTranscript(transcript({ contentHash: 'hash-new' }));
    const stored = store.getVideoTranscript('AAAAAAAAAAA');
    expect(stored?.contentHash).toBe('hash-new');
  });

  /**
   * Reproduces the failure seen in the field: a refetch that resolves to a different
   * caption track keeps the old row id but changes the natural key, so the write hit
   * "UNIQUE constraint failed: video_transcripts.id" and every video failed to update.
   */
  test('refetching a different track of the same video replaces the old row', async () => {
    await setupStore();
    store.upsertVideoTranscript(transcript({ language: 'vi-orig', source: 'auto' }));
    const previous = store.getVideoTranscript('AAAAAAAAAAA');
    expect(previous).not.toBeNull();

    store.upsertVideoTranscript(transcript({
      id: previous!.id,
      language: 'vi',
      source: 'manual',
      contentHash: 'hash-manual',
    }));

    const stored = store.getVideoTranscript('AAAAAAAAAAA');
    expect(stored?.language).toBe('vi');
    expect(stored?.source).toBe('manual');
    expect(stored?.contentHash).toBe('hash-manual');
    expect(stored?.id).toBe(previous!.id);
  });
});
