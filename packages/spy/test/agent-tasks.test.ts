/**
 * agent-tasks.test.ts — phiếu việc agent (plan spy-analyst-workflow §J):
 * kết quả chỉ vào DB khi đúng khuôn + ID có thật + trích comment có thật;
 * sai thì báo đường dẫn trường và KHÔNG ghi; mỗi phiếu nhận một lần.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SpyStore } from '../src/store.ts';
import { boardVideoMaterial, createAgentTask, submitAgentTask } from '../src/board/agent-tasks.ts';

const T = 'fin';
let tempDir = '';
afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = '';
});

async function seed() {
  tempDir = await mkdtemp(join(tmpdir(), 'spy-agent-tasks-'));
  const store = new SpyStore(join(tempDir, 'spy.sqlite'));
  store.upsertTopic({ topicId: T, label: 'Fin', market: 'en', language: 'en', region: 'US' });
  store.upsertTopicKeyword({ topicId: T, termKey: 'side_hustle', displayTerm: 'side hustle', relation: 'seed', status: 'active', groupKey: 'sh' });
  store.upsertTopicChannel({ topicId: T, channelId: 'UCa', status: 'active', title: 'A' });
  store.upsertMeasuredChannel({
    topicId: T, channelId: 'UCm', title: 'M', subscriberCount: 900, baselineMedianViews: null, baselineN: null,
    maxViews: null, verdict: 'no_outlier', hitOutlierScore: null, discoveredVia: 'keyword_run',
    discoveredFrom: 'side_hustle', measuredAt: '2026-09-29T00:00:00Z', groupKey: 'sh',
  });
  for (const id of ['v1', 'v2', 'v3']) {
    store.upsertTopicVideo({
      topicId: T, videoId: id, channelId: 'UCa', title: `video ${id}`, publishedAt: '2026-09-10T00:00:00Z',
      durationSec: 600, source: 'daily_scan', views: 5_000, capturedAt: '2026-09-29T00:00:00Z',
    });
  }
  store.upsertVideoComments([{
    id: 'c1', sourceVideoId: 'v1', channelId: null, parentCommentId: null, authorDisplayName: 'x',
    text: 'I have $40k in credit card debt and   no idea where to start', likeCount: 12,
    publishedAt: null, updatedAt: null, fetchedAt: '2026-09-29T00:00:00Z',
  }]);
  return store;
}

describe('createAgentTask', () => {
  test('soạn prompt có prompt_id, dữ liệu đã chọn, tool cần gọi và khuôn nộp', async () => {
    const store = await seed();
    const { promptId, promptText } = createAgentTask(store, {
      topicId: T, template: 'outlier_patterns', niche: 'sh', selection: { videoIds: ['v1', 'v2'] }, note: 'tìm mẫu tiêu đề',
    });
    expect(promptId).toMatch(/^p_[0-9a-f]{12}$/);
    expect(promptText).toContain(`prompt_id="${promptId}"`);
    expect(promptText).toContain('v1, v2');
    expect(promptText).toContain('spy_board_submit');
    expect(promptText).toContain('"titleTemplates"');
    expect(promptText).toContain('tìm mẫu tiêu đề');
    expect(store.getAgentTask(promptId)!['status']).toBe('pending');
  });

  test('thiếu dữ liệu chọn bắt buộc → từ chối', async () => {
    const store = await seed();
    expect(() => createAgentTask(store, { topicId: T, template: 'outlier_patterns', selection: { videoIds: ['v1'] } }))
      .toThrow('ít nhất 2 video');
    expect(() => createAgentTask(store, { topicId: T, template: 'next_steps', selection: {} })).toThrow('một ngách');
    expect(() => createAgentTask(store, { topicId: 'nope', template: 'compare_niches', selection: {} })).toThrow('không tồn tại');
  });
});

describe('submitAgentTask', () => {
  test('đúng khuôn + ID thật → ghi, phiếu chuyển submitted; nộp lần 2 → conflict', async () => {
    const store = await seed();
    const { promptId } = createAgentTask(store, { topicId: T, template: 'next_steps', niche: 'sh', selection: {} });
    const result = {
      discover: [{ termKey: 'side_hustle', reason: 'tỉ lệ mới còn 36%', priority: 1 }],
      deepdive: [{ videoId: 'v2', reason: 'outlier 8x kênh nhỏ', priority: 1 }],
      follow: [{ channelId: 'UCm', reason: 'kênh mới đang lên' }],
    };
    expect(submitAgentTask(store, promptId, result, 'claude')).toEqual({ promptId, template: 'next_steps', status: 'submitted' });
    const row = store.getAgentTask(promptId)!;
    expect(row['status']).toBe('submitted');
    expect(row['submitted_by']).toBe('claude');
    expect(JSON.parse(String(row['result_json']))).toEqual(result);
    expect(() => submitAgentTask(store, promptId, result)).toThrow('chỉ nhận một lần');
  });

  test('sai khuôn (thiếu trường / thừa trường / sai enum) → lỗi có đường dẫn, không ghi', async () => {
    const store = await seed();
    const { promptId } = createAgentTask(store, { topicId: T, template: 'compare_niches', selection: {} });
    expect(() => submitAgentTask(store, promptId, { ranking: [{ niche: 'sh', verdict: 'yes', reason: 'tốt' }], pick: null, missingEvidence: [] }))
      .toThrow('ranking.0.verdict');
    expect(() => submitAgentTask(store, promptId, { ranking: [{ niche: 'sh', verdict: 'choose', reason: 'tốt lắm' }], pick: null, missingEvidence: [], extra: 1 }))
      .toThrow('Sai khuôn');
    expect(() => submitAgentTask(store, promptId, { ranking: [] })).toThrow('Sai khuôn');
    expect(store.getAgentTask(promptId)!['status']).toBe('pending');
  });

  test('ID bịa / ngoài phạm vi đã chọn / ngách không tồn tại → từ chối', async () => {
    const store = await seed();
    const kw = createAgentTask(store, { topicId: T, template: 'keyword_ideas', niche: 'sh', selection: {} });
    expect(() => submitAgentTask(store, kw.promptId, {
      stop: [{ termKey: 'khong_co', reason: 'cạn rồi' }],
      try: [{ term: '30 day challenge', reason: 'mẫu lặp', evidenceVideoIds: ['v1', 'fake'] }],
    })).toThrow(/stop\.0\.termKey.*khong_co.*try\.0\.evidenceVideoIds\.1.*fake/);

    const pat = createAgentTask(store, { topicId: T, template: 'outlier_patterns', selection: { videoIds: ['v1', 'v2'] } });
    expect(() => submitAgentTask(store, pat.promptId, {
      patterns: [{ name: 'POV nợ', description: 'mở bằng con số nợ', videoIds: ['v1', 'v3'] }],
      titleTemplates: [],
    })).toThrow("không nằm trong các video đã chọn");

    const cmp = createAgentTask(store, { topicId: T, template: 'compare_niches', selection: {} });
    expect(() => submitAgentTask(store, cmp.promptId, {
      ranking: [{ niche: 'ma', verdict: 'choose', reason: 'sàn cao' }], pick: 'ma', missingEvidence: [],
    })).toThrow("ngách 'ma' không tồn tại");
    expect(submitAgentTask(store, cmp.promptId, {
      ranking: [{ niche: 'sh', verdict: 'maybe', reason: 'mới 3/20 kênh' }], pick: null, missingEvidence: ['thêm kênh nhỏ'],
    }).status).toBe('submitted');
  });

  test('trích comment phải có thật (bỏ qua hoa/thường, khoảng trắng); bịa → từ chối', async () => {
    const store = await seed();
    const { promptId } = createAgentTask(store, { topicId: T, template: 'audience_pains', selection: { videoIds: ['v1'] } });
    const pain = (text: string) => ({
      pains: [{ pain: 'nợ thẻ tín dụng', frequency: 'high', quotes: [{ videoId: 'v1', text }] }], questions: [],
    });
    expect(() => submitAgentTask(store, promptId, pain('I love this video so much'))).toThrow('không tìm thấy đoạn trích');
    expect(submitAgentTask(store, promptId, pain('"$40K in credit card debt and no idea"')).status).toBe('submitted');
  });

  test('phiếu không tồn tại → not_found', async () => {
    const store = await seed();
    expect(() => submitAgentTask(store, 'p_000000000000', {})).toThrow('không tồn tại');
  });
});

describe('boardVideoMaterial', () => {
  test('trả comment đã lưu theo like + cờ thiếu transcript; >5 video → lỗi', async () => {
    const store = await seed();
    const [m] = boardVideoMaterial(store, T, ['v1']);
    expect(m!.inTopic).toBe(true);
    expect(m!.commentsStored).toBe(1);
    expect(m!.comments[0]!.likes).toBe(12);
    expect(m!.transcript).toBeNull();
    expect(() => boardVideoMaterial(store, T, ['a', 'b', 'c', 'd', 'e', 'f'])).toThrow('1..5');
  });
});
