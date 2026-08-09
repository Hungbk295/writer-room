/** Shared fixtures for Training (M1) daemon tests — seeds a real `SpyService` over a
 * temp dir with one video snapshot + transcript, mirroring the pattern
 * `packages/spy/test/store.test.ts` uses for `SpyStore` fixtures directly. */
import { createHash, randomUUID } from 'node:crypto';
import { SpyService, type TranscriptSegment, type VideoSnapshot } from '@writer-room/spy';

export interface SeedVideoOptions {
  channelTitle?: string;
  transcriptStatus?: VideoSnapshot['transcriptStatus'];
  segmentTexts?: string[];
}

export interface SeededVideo {
  videoSnapshotId: string;
  segments: TranscriptSegment[];
}

export async function seedVideo(spy: SpyService, opts: SeedVideoOptions = {}): Promise<SeededVideo> {
  const sourceVideoId = randomUUID().replace(/-/g, '').slice(0, 11);
  const op = spy.store.createOrGetOperation({
    kind: 'acquire_video',
    ownerSubject: 'test',
    idempotencyKey: `seed-${sourceVideoId}`,
    request: { url: `https://youtu.be/${sourceVideoId}` },
  });
  const run = spy.store.createSpyRun({
    operationId: op.operation.id,
    kind: 'video',
    canonicalSource: `https://www.youtube.com/watch?v=${sourceVideoId}`,
    sourceIdentity: `youtube:video:${sourceVideoId}`,
    config: {},
  });

  const videoSnapshotId = randomUUID();
  const snapshot: VideoSnapshot = {
    id: videoSnapshotId,
    spyRunId: run.id,
    sourceVideoId,
    canonicalUrl: `https://www.youtube.com/watch?v=${sourceVideoId}`,
    title: 'Test video',
    channelTitle: opts.channelTitle ?? 'Test Channel',
    rank: 1,
    viewCount: 1000,
    likeCount: 50,
    commentCount: 10,
    durationSec: 120,
    publishedAt: '2026-01-01T00:00:00.000Z',
    tags: [],
    transcriptStatus: opts.transcriptStatus ?? 'ok',
    transcriptSource: 'manual',
    frameStatus: 'ok',
    thumbnail: null,
    createdAt: new Date().toISOString(),
  };
  spy.store.insertVideoSnapshot(snapshot);

  const texts = opts.segmentTexts ?? [
    'Have you ever wondered why the sky turns orange at sunset?',
    'That is because sunlight scatters differently through the thick atmosphere near the horizon.',
  ];
  const segments: TranscriptSegment[] = texts.map((text, index) => ({
    id: `seg-${videoSnapshotId}-${index + 1}`,
    videoSnapshotId,
    index,
    startSec: index * 5,
    endSec: index * 5 + 4,
    text,
    source: 'manual',
    language: 'en',
    contentHash: createHash('sha256').update(text).digest('hex'),
  }));
  if (segments.length > 0) {
    spy.store.insertTranscriptSegments(segments);
  }

  return { videoSnapshotId, segments };
}
