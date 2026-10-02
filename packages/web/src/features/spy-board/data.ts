/**
 * Nguồn dữ liệu của Spy Board: /api/spy/board/* thật, hoặc mock khi ?mock=1.
 * Màn nào cũng đi qua đây — không gọi api.* trực tiếp — để chế độ mock phủ đủ.
 */
import {
  api,
  type AgentSelection,
  type AgentTemplate,
  type BoardAgentTask,
  type BoardChannelRow,
  type BoardLabels,
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
    const all = [...m.MOCK_RUNS, m.MOCK_DEEPDIVE_CARD];
    return m.mockEnvelope(type ? all.filter((r) => r.type === type) : all);
  }
  return api.boardRuns(topicId, { type, limit: 100 });
}

export async function loadRunDetail(runId: string): Promise<BoardRunDetail> {
  if (IS_MOCK) {
    const m = await mock();
    if (runId === m.MOCK_DEEPDIVE_CARD.runId) return m.MOCK_DEEPDIVE_DETAIL;
    return { ...m.MOCK_RUN_DETAIL, card: m.MOCK_RUNS.find((r) => r.runId === runId) ?? m.MOCK_RUN_DETAIL.card };
  }
  return (await api.boardRunDetail(runId)).data;
}

/** Báo cáo verify công thức (schema v1) — /api/spy/board/formulas. */
export async function loadFormulas(topicId: string): Promise<{ data: import('../../api.ts').BoardFormulasReport | null; file: string | null }> {
  if (IS_MOCK) {
    const m = await mock();
    return { data: m.MOCK_FORMULAS, file: '2026-10-01-formula-verify.json' };
  }
  return api.boardFormulas(topicId);
}

export async function loadTasks(topicId: string): Promise<BoardAgentTask[]> {
  if (IS_MOCK) return [...(await mock()).MOCK_TASKS];
  return (await api.boardTasks(topicId)).data;
}

export async function loadTask(promptId: string): Promise<BoardAgentTask | null> {
  if (IS_MOCK) return (await mock()).MOCK_TASKS.find((t) => t.promptId === promptId) ?? null;
  return (await api.boardTask(promptId)).data;
}

export async function createTask(topicId: string, body: {
  template: AgentTemplate; niche?: string | null; selection: AgentSelection; note?: string;
}): Promise<{ promptId: string; promptText: string }> {
  if (IS_MOCK) {
    const m = await mock();
    return m.mockCreateTask(body.template, body.niche, body.selection, body.note);
  }
  return api.boardCreateTask({ topicId, ...body });
}

/** Nhãn (tên, thumbnail, kênh) cho ID; ID không có trong topic thì vắng mặt — UI tự dùng ID. */
export async function loadLabels(topicId: string, videoIds: string[], channelIds: string[]): Promise<BoardLabels> {
  const empty: BoardLabels = { videos: {}, channels: {} };
  if (videoIds.length === 0 && channelIds.length === 0) return empty;
  if (IS_MOCK) {
    const m = await mock();
    const out: BoardLabels = { videos: {}, channels: {} };
    for (const v of m.MOCK_VIDEOS) {
      if (!videoIds.includes(v.videoId)) continue;
      out.videos[v.videoId] = {
        title: v.title, channelId: v.channelId, channelTitle: v.channelTitle,
        thumbnailUrl: v.thumbnailUrl, views: v.views, publishedAt: v.publishedAt,
      };
    }
    for (const c of m.MOCK_CHANNELS) out.channels[c.channelId] = { title: c.title, subs: c.subs };
    return out;
  }
  try {
    return (await api.boardLabels(topicId, videoIds, channelIds)).data;
  } catch {
    return empty; // chỉ là nhãn hiển thị — lỗi thì UI dùng ID
  }
}
