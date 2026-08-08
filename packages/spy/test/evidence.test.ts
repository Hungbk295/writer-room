import { describe, expect, test } from 'bun:test';
import {
  canonicalChannelUrl,
  canonicalVideoUrl,
  coverageBuckets,
  dhashFromGray9x8,
  dhashToHex,
  hamming64,
  parseVtt,
  rankVideos,
  samplingTimestamps,
} from '../src/evidence/index.ts';

describe('YouTube URL canonicalization', () => {
  test('is host-aware and separates video/channel', () => {
    expect(canonicalVideoUrl('https://youtu.be/AAAAAAAAAAA?t=3')).toEqual({
      canonicalUrl: 'https://www.youtube.com/watch?v=AAAAAAAAAAA',
      sourceIdentity: 'youtube:video:AAAAAAAAAAA',
    });
    expect(canonicalChannelUrl('https://youtube.com/@Fixture/videos').canonicalUrl).toBe(
      'https://www.youtube.com/@Fixture/videos',
    );
    expect(() => canonicalVideoUrl('https://evil.example/watch?v=AAAAAAAAAAA')).toThrow();
    expect(() => canonicalChannelUrl('https://youtube.com/watch?v=AAAAAAAAAAA')).toThrow();
  });
});

describe('frame timestamps and dHash', () => {
  test('cover full duration and dHash is deterministic', () => {
    const timestamps = samplingTimestamps(100, {
      mode: 'spread',
      frameCount: 5,
      intervalSec: 1,
      dhashThreshold: 8,
    });
    expect(timestamps).toEqual([1, 25.25, 49.5, 73.75, 98]);
    expect(coverageBuckets(100, timestamps).has('opening')).toBe(true);
    expect(coverageBuckets(100, timestamps).has('ending')).toBe(true);
    expect(samplingTimestamps(3, {
      mode: 'spread',
      frameCount: 3,
      intervalSec: 1,
      dhashThreshold: 8,
    })).toEqual([0.06, 1.405, 2.75]);
    const pixels = Uint8Array.from({ length: 72 }, (_, index) => index);
    const hash = dhashFromGray9x8(pixels);
    expect(dhashToHex(hash).length).toBe(16);
    expect(hamming64(hash, hash)).toBe(0);
  });
});

describe('VTT parser and channel ranking', () => {
  test('retains timed evidence and supports velocity ranking', () => {
    const segments = parseVtt(`WEBVTT

00:00:00.000 --> 00:00:02.000
Hello world

00:00:02.000 --> 00:00:04.500
Second line`);
    expect(segments.map(({ startSec, endSec, text }) => ({ startSec, endSec, text }))).toEqual([
      { startSec: 0, endSec: 2, text: 'Hello world' },
      { startSec: 2, endSec: 4.5, text: 'Second line' },
    ]);
    const ranked = rankVideos([
      { sourceVideoId: 'old', viewCount: 10_000, durationSec: 100, publishedAt: '2020-01-01' },
      { sourceVideoId: 'new', viewCount: 1_000, durationSec: 100, publishedAt: '2026-07-29' },
    ], { topN: 1, minDurationSec: 60, rankBy: 'velocity', now: new Date('2026-07-30') });
    expect(ranked[0]!.sourceVideoId).toBe('new');
  });
});
