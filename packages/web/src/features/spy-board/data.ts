/**
 * Nguồn dữ liệu của Spy Board: /api/spy/board/* thật, hoặc mock khi ?mock=1.
 * Màn nào cũng đi qua đây — không gọi api.* trực tiếp — để chế độ mock phủ đủ.
 */
import {
  api,
  type BoardChannelRow,
  type BoardEnvelope,
  type BoardKeywordRow,
  type BoardRunCard,
  type BoardRunDetail,
  type BoardRunType,
  type BoardScorecardRow,
  type BoardVideoRow,
  type BoardVideoView,
} from '../../api.ts';
import { IS_MOCK, nicheParam } from './lib.tsx';

const mock = () => import('./mock.ts');

export async function loadScorecard(topicId: string): Promise<BoardEnvelope<BoardScorecardRow[]>> {
  if (IS_MOCK) {
    const m = await mock();
    return m.mockEnvelope(m.MOCK_SCORECARD, { channels: 46, videos: 726 });
  }
  return api.boardScorecard(topicId);
}

export async function loadVideos(topicId: string, niche: string | null, p: {
  view: BoardVideoView; smallOnly: boolean; youngChannels: boolean;
}): Promise<BoardEnvelope<BoardVideoRow[]>> {
  if (IS_MOCK) {
    const m = await mock();
    const rows = m.MOCK_VIDEOS
      .filter((r) => (p.view === 'outliers' ? r.isOutlier : p.view === 'rising' ? r.isRising : true))
      .filter((r) => !p.smallOnly || (r.subs ?? Infinity) < 10_000)
      .filter((r) => !p.youngChannels || (r.channelAgeDays ?? Infinity) <= 180)
      .sort((a, b) => (p.view === 'rising' ? (b.velocity24h ?? 0) - (a.velocity24h ?? 0) : (b.outlierX ?? 0) - (a.outlierX ?? 0)));
    return m.mockEnvelope(rows, { channels: new Set(rows.map((r) => r.channelId)).size, videos: rows.length });
  }
  return api.boardVideos(topicId, {
    niche: nicheParam(niche),
    view: p.view,
    smallOnly: p.smallOnly,
    channelAgeMaxDays: p.youngChannels ? 180 : undefined,
    limit: 120,
  });
}

export async function loadChannels(topicId: string, niche: string | null, smallOnly: boolean): Promise<BoardEnvelope<BoardChannelRow[]>> {
  if (IS_MOCK) {
    const m = await mock();
    const rows = m.MOCK_CHANNELS.filter((c) => !smallOnly || c.isSmall);
    return m.mockEnvelope(rows, { channels: rows.length, videos: 0 });
  }
  return api.boardChannels(topicId, { niche: nicheParam(niche), smallOnly, limit: 200 });
}

export async function loadKeywords(topicId: string, niche: string | null | undefined): Promise<BoardEnvelope<BoardKeywordRow[]>> {
  if (IS_MOCK) {
    const m = await mock();
    const rows = niche === undefined ? m.MOCK_KEYWORDS : m.MOCK_KEYWORDS.filter((k) => k.niche === niche);
    return m.mockEnvelope(rows);
  }
  return api.boardKeywords(topicId, niche === undefined ? undefined : nicheParam(niche));
}

export async function loadRuns(topicId: string, type?: BoardRunType): Promise<BoardEnvelope<BoardRunCard[]>> {
  if (IS_MOCK) {
    const m = await mock();
    return m.mockEnvelope(type ? m.MOCK_RUNS.filter((r) => r.type === type) : m.MOCK_RUNS);
  }
  return api.boardRuns(topicId, { type, limit: 100 });
}

export async function loadRunDetail(runId: string): Promise<BoardRunDetail> {
  if (IS_MOCK) {
    const m = await mock();
    return { ...m.MOCK_RUN_DETAIL, card: m.MOCK_RUNS.find((r) => r.runId === runId) ?? m.MOCK_RUN_DETAIL.card };
  }
  return (await api.boardRunDetail(runId)).data;
}
