import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { AppError } from '../src/errors.ts';
import { DeterministicStubLlm } from '../src/adapters/llm.ts';
import { SpyStore } from '../src/store.ts';
import { buildEvidenceCatalog, validateEvidenceRefs } from '../src/profile/evidence.ts';
import { analyzeHooks } from '../src/profile/hook.ts';

let tempDir = '';
let store: SpyStore;

afterEach(async () => {
  store?.close();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

async function setupWithSegment() {
  tempDir = await mkdtemp(join(tmpdir(), 'spy-profile-'));
  store = new SpyStore(join(tempDir, 'spy.sqlite'));
  const op = store.createOrGetOperation({
    kind: 'acquire_video',
    ownerSubject: 'test',
    idempotencyKey: 'profile-test-key1234',
    request: {},
  });
  const run = store.createSpyRun({
    operationId: op.operation.id,
    kind: 'video',
    canonicalSource: 'https://www.youtube.com/watch?v=AAAAAAAAAAA',
    sourceIdentity: 'youtube:video:AAAAAAAAAAA',
    config: {},
  });
  const snapshotId = randomUUID();
  store.insertVideoSnapshot({
    id: snapshotId,
    spyRunId: run.id,
    sourceVideoId: 'AAAAAAAAAAA',
    canonicalUrl: 'https://www.youtube.com/watch?v=AAAAAAAAAAA',
    title: 'Why does this work?',
    channelTitle: 'Test Channel',
    rank: 1,
    viewCount: 1000,
    likeCount: null,
    commentCount: null,
    durationSec: 120,
    publishedAt: '2026-01-01T00:00:00.000Z',
    tags: [],
    transcriptStatus: 'ok',
    transcriptSource: 'manual',
    frameStatus: 'skipped',
    thumbnail: null,
    createdAt: new Date().toISOString(),
  });
  const segmentId = randomUUID();
  store.insertTranscriptSegments([{
    id: segmentId,
    videoSnapshotId: snapshotId,
    index: 0,
    startSec: 0,
    endSec: 3,
    text: 'Why does this work?',
    source: 'manual',
    language: 'en',
    contentHash: 'abc',
  }]);
  return { run, segmentId, snapshotId };
}

describe('Profile evidence validation', () => {
  test('rejects claim without evidence', async () => {
    const { run } = await setupWithSegment();
    const catalog = buildEvidenceCatalog(store, run.id);
    expect(() => validateEvidenceRefs([], catalog)).toThrow(AppError);
  });

  test('rejects non-existent segment id', async () => {
    const { run } = await setupWithSegment();
    const catalog = buildEvidenceCatalog(store, run.id);
    expect(() => validateEvidenceRefs([{
      videoId: 'AAAAAAAAAAA',
      segmentIds: ['missing-segment'],
    }], catalog)).toThrow(AppError);
  });

  test('stub LLM claim with valid segment is accepted', async () => {
    const { run } = await setupWithSegment();
    const llm = new DeterministicStubLlm();
    const hooks = await analyzeHooks(store, llm, run.id);
    expect(hooks).toHaveLength(1);
    expect(hooks[0]!.strategy).toBe('question');
    expect(hooks[0]!.evidence[0]!.segmentIds?.length).toBe(1);
  });
});
