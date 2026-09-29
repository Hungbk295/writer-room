/**
 * deepdive.test.ts — lượt Đào sâu (plan spy-analyst-workflow §H bước 6):
 * kéo comment + transcript; cái đã có thì bỏ qua kèm lý do; thẻ ghi đúng sổ
 * keyword_runs(type='deepdive'); lỗi một phần không làm chết cả lượt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SpyStore } from '../src/store.ts';
import { QuotaLedger } from '../src/quota.ts';
import { DeepDiveService } from '../src/loop/deepdive.ts';

let tempDir = '';
afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = '';
});

async function waitRun(store: SpyStore, runId: string) {
  for (let i = 0; i < 200; i++) {
    const got = store.getKeywordRun(runId);
    if (got && got.run['status'] !== 'running') return got;
    await Bun.sleep(5);
  }
  throw new Error('run không kết thúc');
}

async function setup(opts: { transcriptFails?: Set<string>; commentsFail?: Set<string> } = {}) {
  tempDir = await mkdtemp(join(tmpdir(), 'spy-deepdive-'));
  const store = new SpyStore(join(tempDir, 'spy.sqlite'));
  store.upsertTopic({ topicId: 'fin', label: 'Fin', market: 'en', language: 'en', region: 'US' });
  const transcripts = new Set<string>(['has-both']);
  const calls = { spy: [] as string[], comments: [] as string[] };
  let op = 0;
  const pending = new Map<string, string>();
  const service = new DeepDiveService({
    store,
    quota: new QuotaLedger(store),
    videoSpy: ({ url }) => {
      const videoId = new URL(url).searchParams.get('v')!;
      calls.spy.push(videoId);
      const id = `op-${op++}`;
      pending.set(id, videoId);
      return { operationId: id };
    },
    wait: async (id) => {
      const videoId = pending.get(id)!;
      if (opts.transcriptFails?.has(videoId)) return { status: 'failed', errorMessage: 'no captions' };
      transcripts.add(videoId);
      return { status: 'completed', errorMessage: null };
    },
    videoComments: async ({ videoId }) => {
      calls.comments.push(videoId);
      if (opts.commentsFail?.has(videoId)) throw new Error('commentsDisabled');
      store.upsertVideoComments([{
        id: `c-${videoId}`, sourceVideoId: videoId, channelId: null, parentCommentId: null,
        authorDisplayName: 'a', text: 'pain point', likeCount: 1, publishedAt: null, updatedAt: null,
        fetchedAt: new Date().toISOString(),
      }]);
      return { saved: 1 };
    },
    transcriptPresent: (videoId) => transcripts.has(videoId),
  });
  // 'has-both' đã có cả comment lẫn transcript từ trước.
  store.upsertVideoComments([{
    id: 'old', sourceVideoId: 'has-both', channelId: null, parentCommentId: null,
    authorDisplayName: 'a', text: 'x', likeCount: 0, publishedAt: null, updatedAt: null, fetchedAt: '2026-09-01T00:00:00Z',
  }]);
  return { store, service, calls };
}

describe('DeepDiveService', () => {
  test('kéo comment + transcript cho video mới; video đã có đủ → skipped_dedup, không gọi gì', async () => {
    const { store, service, calls } = await setup();
    const runId = service.startRun('fin', ['fresh', 'has-both'], { note: 'vì sao thắng', groupKey: 'side-hustle' });
    const { run, items } = await waitRun(store, runId);

    expect(run['type']).toBe('deepdive');
    expect(run['status']).toBe('done');
    expect(run['note']).toBe('vì sao thắng');
    expect(run['group_key']).toBe('side-hustle');
    expect(run['n_keywords']).toBe(2);
    expect(run['keywords_done']).toBe(2);
    expect(run['n_new']).toBe(1);
    expect(run['n_skipped']).toBe(1);
    expect(calls.spy).toEqual(['fresh']);
    expect(calls.comments).toEqual(['fresh']);

    const byId = new Map(items.map((i) => [String(i['term_key']), i]));
    expect(byId.get('fresh')!['status']).toBe('done');
    expect(byId.get('fresh')!['n_results']).toBe(1);
    expect(byId.get('has-both')!['status']).toBe('skipped_dedup');
    expect(byId.get('has-both')!['skip_reason']).toBe('comments_present,transcript_present');
  });

  test('chạy lại cùng video → comment không kéo lần hai (mỗi video một lần)', async () => {
    const { store, service, calls } = await setup();
    await waitRun(store, service.startRun('fin', ['v1']));
    const second = await waitRun(store, service.startRun('fin', ['v1']));
    expect(calls.comments).toEqual(['v1']);
    expect(calls.spy).toEqual(['v1']);
    expect(second.items[0]!['status']).toBe('skipped_dedup');
  });

  test('lỗi một phần: transcript hỏng vẫn giữ comment (done + error); hỏng cả hai → failed; lượt vẫn done', async () => {
    const { store, service } = await setup({
      transcriptFails: new Set(['no-cap', 'broken']),
      commentsFail: new Set(['broken']),
    });
    const { run, items } = await waitRun(store, service.startRun('fin', ['no-cap', 'broken']));
    expect(run['status']).toBe('done');
    const byId = new Map(items.map((i) => [String(i['term_key']), i]));
    expect(byId.get('no-cap')!['status']).toBe('done');
    expect(String(byId.get('no-cap')!['error'])).toContain('no captions');
    expect(byId.get('broken')!['status']).toBe('failed');
    expect(String(byId.get('broken')!['error'])).toContain('commentsDisabled');
  });
});
