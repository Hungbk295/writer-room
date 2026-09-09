import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SpyService } from '../src/index.ts';
import type { CommentThread, YouTubeDataApiPort } from '../src/adapters/data-api.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function dataApiWithComments(threads: CommentThread[]): YouTubeDataApiPort {
  return {
    fetchVideoStatistics: async () => new Map(),
    fetchChannelStatistics: async () => new Map(),
    fetchVideoComments: async () => threads,
  };
}

async function newSpy(dataApi: YouTubeDataApiPort): Promise<SpyService> {
  const root = await mkdtemp(join(tmpdir(), 'spy-comments-'));
  roots.push(root);
  const spy = new SpyService({ dataRoot: join(root, 'spy'), dataApi });
  await spy.init();
  return spy;
}

describe('spy_video_comments persistence', () => {
  test('saves top-level comments and their replies', async () => {
    const threads: CommentThread[] = [{
      commentId: 'c1',
      videoId: 'VIDEO1',
      authorDisplayName: 'Alice',
      text: 'Great video!',
      likeCount: 5,
      publishedAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      totalReplyCount: 1,
      replies: [{
        commentId: 'r1',
        authorDisplayName: 'Bob',
        text: 'Agreed',
        likeCount: 1,
        publishedAt: '2026-01-01T01:00:00Z',
      }],
    }];
    const spy = await newSpy(dataApiWithComments(threads));

    const result = await spy.videoComments({ videoId: 'VIDEO1' });
    expect(result.count).toBe(1);
    expect(result.saved).toBe(2);

    const saved = spy.store.listVideoComments('VIDEO1');
    expect(saved).toHaveLength(2);
    const top = saved.find((c) => c.id === 'c1')!;
    expect(top.parentCommentId).toBeNull();
    expect(top.text).toBe('Great video!');
    expect(top.sourceVideoId).toBe('VIDEO1');
    expect(top.likeCount).toBe(5);
    const reply = saved.find((c) => c.id === 'r1')!;
    expect(reply.parentCommentId).toBe('c1');
    expect(reply.authorDisplayName).toBe('Bob');
    expect(reply.sourceVideoId).toBe('VIDEO1');
  });

  test('re-fetching the same video refreshes rows instead of duplicating them', async () => {
    const threads: CommentThread[] = [{
      commentId: 'c1',
      videoId: 'VIDEO1',
      authorDisplayName: 'Alice',
      text: 'v1',
      likeCount: 1,
      publishedAt: '2026-01-01T00:00:00Z',
      updatedAt: null,
      totalReplyCount: 0,
      replies: [],
    }];
    const spy = await newSpy(dataApiWithComments(threads));
    await spy.videoComments({ videoId: 'VIDEO1' });
    threads[0]!.text = 'v2';
    threads[0]!.likeCount = 9;
    await spy.videoComments({ videoId: 'VIDEO1' });

    const saved = spy.store.listVideoComments('VIDEO1');
    expect(saved).toHaveLength(1);
    expect(saved[0]!.text).toBe('v2');
    expect(saved[0]!.likeCount).toBe(9);
  });

  test('channel_id is set only when the scope resolves to a known channels row — never guessed', async () => {
    const threads: CommentThread[] = [{
      commentId: 'c1',
      videoId: 'VIDEO1',
      authorDisplayName: 'Alice',
      text: 'hi',
      likeCount: 0,
      publishedAt: null,
      updatedAt: null,
      totalReplyCount: 0,
      replies: [],
    }];
    const spy = await newSpy(dataApiWithComments(threads));

    // Unknown channel scope: comment still saved, but channel_id stays null.
    await spy.videoComments({ channelId: 'UCunknown0000000000000' });
    expect(spy.store.listVideoComments('VIDEO1')[0]!.channelId).toBeNull();

    // Once that channel is a known channels row, a later fetch resolves it.
    const channel = spy.store.upsertChannel({
      channelId: 'UCunknown0000000000000',
      title: 'Some Channel',
      subscriberCount: null,
      videoCount: null,
      totalViewCount: null,
      fetchedAt: new Date().toISOString(),
    });
    await spy.videoComments({ channelId: 'UCunknown0000000000000' });
    expect(spy.store.listVideoComments('VIDEO1')[0]!.channelId).toBe(channel.id);
  });

  test('drops a comment with no resolvable video id instead of fabricating one', async () => {
    const threads: CommentThread[] = [{
      commentId: 'c1',
      videoId: null,
      authorDisplayName: 'Alice',
      text: 'hi',
      likeCount: 0,
      publishedAt: null,
      updatedAt: null,
      totalReplyCount: 0,
      replies: [],
    }];
    const spy = await newSpy(dataApiWithComments(threads));
    const result = await spy.videoComments({ channelId: 'UCsomething000000000000' });
    expect(result.saved).toBe(0);
  });
});
