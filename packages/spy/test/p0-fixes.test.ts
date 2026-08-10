/**
 * Regression tests cho pass P0 — 6 tool đang trả rác + 4 tool wrapper mới.
 * Mỗi test tương ứng một mục trong plan/claude/spy-mcp-vidiq-parity.md §5.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpyService, spyTools } from '../src/index.ts';
import { SpyStore } from '../src/store.ts';
import { MAX_WAIT_MS } from '../src/operations.ts';
import { deterministic, insufficientSample } from '../src/metrics/gates.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function newSpy() {
  const root = await mkdtemp(join(tmpdir(), 'spy-p0-'));
  roots.push(root);
  // dataRoot phải là <data>/spy: defaultConfigPath() ghi config vào THƯ MỤC CHA của dataRoot,
  // nên nếu truyền thẳng tmpdir con thì config rò rỉ ra /tmp/config/spy.json và lây giữa các test.
  const spy = new SpyService({ dataRoot: join(root, 'spy') });
  await spy.init();
  return spy;
}

/** Dựng một channel run có sẵn metrics payload để test tầng đọc. */
function seedChannelRun(store: SpyStore, sourceIdentity: string, payload: unknown) {
  const op = store.createOrGetOperation({
    kind: 'acquire_channel',
    ownerSubject: 'test',
    idempotencyKey: `seed-${sourceIdentity}`,
    request: {},
  });
  const run = store.createSpyRun({
    operationId: op.operation.id,
    kind: 'channel',
    canonicalSource: `https://www.youtube.com/channel/${sourceIdentity}`,
    sourceIdentity,
    config: {},
  });
  store.saveMetrics({ scope: 'channel', scopeId: sourceIdentity, spyRunId: run.id, payload });
  return run;
}

const channelPayload = (viewMedian: number, tokens: string[]) => ({
  performance: { viewMedian: deterministic(viewMedian), velocityMedian: deterministic(viewMedian / 30) },
  outliers: [
    // Đúng shape thật: outlierScore là MetricValue<number>, không phải number.
    { videoId: 'vid-high', viewCount: 90_000, cohort: '0-30d', metricUsed: 'view', outlierScore: deterministic(3.2) },
    { videoId: 'vid-mid', viewCount: 20_000, cohort: '0-30d', metricUsed: 'view', outlierScore: deterministic(1.6) },
    { videoId: 'vid-low', viewCount: 900, cohort: '0-30d', metricUsed: 'view', outlierScore: deterministic(0.2) },
    { videoId: 'vid-nosample', viewCount: 10, cohort: '>365d', metricUsed: 'view', outlierScore: insufficientSample(1, 3) },
  ],
  title: { tokenLift: tokens.map((token) => ({ token, videosContaining: 3, lift: 1.4 })) },
});

describe('P0 — spy_channel_outliers', () => {
  test('đọc được MetricValue thay vì so object với số (trước đây luôn trả rỗng)', async () => {
    const spy = await newSpy();
    seedChannelRun(spy.store, 'UC_outlier', channelPayload(10_000, ['sự thật']));

    const result = spy.channelOutliers('UC_outlier', 1.5);
    expect(result.outliers.map((row) => row.videoId)).toEqual(['vid-high', 'vid-mid']);
    expect(result.outliers[0]?.outlierScore).toBe(3.2);
    expect(result.outliers[0]?.method).toBe('deterministic');
  });

  test('điểm không tính được bị tách ra thay vì lọc im lặng', async () => {
    const spy = await newSpy();
    seedChannelRun(spy.store, 'UC_unscored', channelPayload(10_000, []));
    const result = spy.channelOutliers('UC_unscored', 1.5);
    expect(result.sampleSize).toBe(4);
    expect(result.unscored).toBe(1);
  });

  test('minScore cao hơn thì lọc đúng', async () => {
    const spy = await newSpy();
    seedChannelRun(spy.store, 'UC_minscore', channelPayload(10_000, []));
    expect(spy.channelOutliers('UC_minscore', 3).outliers).toHaveLength(1);
    expect(spy.channelOutliers('UC_minscore', 99).outliers).toHaveLength(0);
  });
});

describe('P0 — spy_wait', () => {
  test('trần chờ khớp với 600s khai báo ở tool, không còn kẹp 60s', () => {
    expect(MAX_WAIT_MS).toBe(600_000);
  });
});

describe('P0 — profiles table', () => {
  test('saveProfile/getLatestProfile round-trip', async () => {
    const spy = await newSpy();
    const run = seedChannelRun(spy.store, 'UC_profile', channelPayload(10_000, []));
    spy.store.saveProfile({
      scope: 'channel',
      scopeId: 'UC_profile',
      spyRunId: run.id,
      kind: 'hooks',
      payload: [{ videoId: 'vid-high', strategy: 'question' }],
      evidence: [{ videoId: 'vid-high' }],
      model: 'test-model',
    });
    const profile = spy.channelProfile('UC_profile');
    expect(profile.hooks).toEqual([{ videoId: 'vid-high', strategy: 'question' }]);
    expect(profile.profileModel).toBe('test-model');
    expect(profile.missingProfiles).toEqual(['topics', 'voice']);
  });

  test('ProfileService ghi kết quả vào DB sau khi phân tích', async () => {
    const spy = await newSpy();
    const run = seedChannelRun(spy.store, 'UC_persist', channelPayload(10_000, []));
    await spy.profile.topicClusters(run.id);
    expect(spy.store.getLatestProfile('channel', 'UC_persist', 'topics')).not.toBeNull();
  });
});

describe('P0 — spy_compare', () => {
  test('dimensions được áp dụng thật, dimension lạ được báo lại', async () => {
    const spy = await newSpy();
    const run = seedChannelRun(spy.store, 'UC_cmp', channelPayload(10_000, []));
    spy.store.saveMetrics({
      scope: 'video',
      scopeId: 'vid-a',
      spyRunId: run.id,
      payload: { title: { charLength: 40 }, speech: { speechRateWpm: 150 } },
    });
    spy.store.saveMetrics({
      scope: 'video',
      scopeId: 'vid-b',
      spyRunId: run.id,
      payload: { title: { charLength: 80 }, speech: { speechRateWpm: 200 } },
    });

    const onlyTitle = spy.compare(['vid-a', 'vid-b'], ['title', 'khong-ton-tai']);
    expect(onlyTitle.unknownDimensions).toEqual(['khong-ton-tai']);
    expect(onlyTitle.results[0]?.metrics).toEqual({ title: { charLength: 40 } });
    const charLength = onlyTitle.table.find((row) => row.field === 'title.charLength');
    expect(charLength?.min).toBe(40);
    expect(charLength?.max).toBe(80);
    expect(charLength?.ratio).toBe(2);
    // speech bị loại vì không nằm trong dimensions
    expect(onlyTitle.table.some((row) => row.field.startsWith('speech.'))).toBe(false);
  });

  test('video thiếu metrics được đánh dấu missing thay vì biến mất', async () => {
    const spy = await newSpy();
    const result = spy.compare(['khong-co'], []);
    expect(result.results[0]?.missing).toBe(true);
  });
});

describe('P0 — spy_channel_diff', () => {
  test('trả delta/ratio thật chứ không chỉ hai profile cạnh nhau', async () => {
    const spy = await newSpy();
    seedChannelRun(spy.store, 'UC_a', channelPayload(10_000, ['sự thật', 'tại sao']));
    seedChannelRun(spy.store, 'UC_b', channelPayload(30_000, ['tại sao', 'bí mật']));

    const diff = spy.channelDiff('UC_a', 'UC_b');
    const viewMedian = diff.diff.find((row) => row.field === 'performance.viewMedian');
    expect(viewMedian?.delta).toBe(20_000);
    expect(viewMedian?.ratio).toBe(3);
    expect(diff.titleTokens.sharedTop).toEqual(['tại sao']);
    expect(diff.titleTokens.onlyA).toEqual(['sự thật']);
    expect(diff.titleTokens.onlyB).toEqual(['bí mật']);
    expect(diff.topDivergence.length).toBeGreaterThan(0);
  });
});

describe('P0 — competitors', () => {
  test('follow idempotent, unfollow, và chặn trùng follow/unfollow', async () => {
    const spy = await newSpy();
    const first = spy.updateCompetitors({ ownerChannelId: 'UC_me', follow: ['UC_x', 'UC_y'] });
    expect(first.added).toEqual(['UC_x', 'UC_y']);

    const again = spy.updateCompetitors({ ownerChannelId: 'UC_me', follow: ['UC_x'] });
    expect(again.added).toEqual([]);
    expect(again.alreadyFollowing).toEqual(['UC_x']);

    const removed = spy.updateCompetitors({ ownerChannelId: 'UC_me', unfollow: ['UC_y', 'UC_z'] });
    expect(removed.removed).toEqual(['UC_y']);
    expect(removed.notFollowing).toEqual(['UC_z']);

    expect(spy.listCompetitors('UC_me').count).toBe(1);
    expect(() => spy.updateCompetitors({ ownerChannelId: 'UC_me', follow: ['UC_q'], unfollow: ['UC_q'] }))
      .toThrow(/vừa follow vừa unfollow/);
  });

  test('danh sách tách theo owner channel', async () => {
    const spy = await newSpy();
    spy.updateCompetitors({ ownerChannelId: 'UC_one', follow: ['UC_x'] });
    spy.updateCompetitors({ ownerChannelId: 'UC_two', follow: ['UC_y'] });
    expect(spy.listCompetitors('UC_one').competitors.map((c) => c.competitorChannelId)).toEqual(['UC_x']);
  });
});

describe('P0 — tool wrapper Data API', () => {
  test('4 tool mới được đăng ký', async () => {
    const spy = await newSpy();
    const names = spyTools(spy).map((tool) => tool.name);
    expect(names).toContain('spy_videos_by_ids');
    expect(names).toContain('spy_channels_by_ids');
    expect(names).toContain('spy_video_comments');
    expect(names).toContain('spy_competitors_list');
    expect(names).toContain('spy_competitors_update');
  });

  test('thiếu API key báo capability_missing thay vì trả rỗng im lặng', async () => {
    const spy = await newSpy();
    await expect(spy.videosByIds(['AAAAAAAAAAA'])).rejects.toMatchObject({ code: 'capability_missing' });
    await expect(spy.videoComments({ videoId: 'AAAAAAAAAAA' })).rejects.toMatchObject({ code: 'capability_missing' });
  });

  test('videosByIds chặn quá 50 id', async () => {
    const spy = await newSpy();
    await spy.updateConfig({ youtubeDataApiKey: 'fake-key' });
    const ids = Array.from({ length: 51 }, (_, i) => `id-${i}`);
    await expect(spy.videosByIds(ids)).rejects.toMatchObject({ code: 'invalid_input' });
  });

  test('videoComments bắt buộc đúng một trong video_id / channel_id', async () => {
    const spy = await newSpy();
    await spy.updateConfig({ youtubeDataApiKey: 'fake-key' });
    await expect(spy.videoComments({})).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(spy.videoComments({ videoId: 'a', channelId: 'b' })).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('P0 — concurrency config', () => {
  test('config.concurrency được nối vào harvest thay vì hardcode', async () => {
    const spy = await newSpy();
    expect(spy.getPublicConfig().concurrency).toBe(3);
    await spy.updateConfig({ concurrency: 1 });
    expect(spy.getPublicConfig().concurrency).toBe(1);
    // setConcurrency kẹp trong 1..4
    spy.harvest.setConcurrency(99);
    spy.harvest.setConcurrency(0);
  });
});
