/**
 * Mock data cho Spy Board — chỉ được import động khi URL có ?mock=1.
 * Số liệu giả để review bố cục 4 màn (3 ngách, đủ ✅/⚠️/🆕, keyword bị khoá,
 * lượt chạy có mục bỏ qua).
 */
import type {
  BoardChannelRow,
  BoardEnvelope,
  BoardKeywordRow,
  BoardRunCard,
  BoardRunDetail,
  BoardScorecardRow,
  BoardVideoRow,
} from '../../api.ts';

const now = Date.now();
const ago = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
const day = (d: number) => new Date(now - d * 86_400_000).toISOString().slice(0, 10);

export function mockEnvelope<T>(data: T, sample = { channels: 0, videos: 0 }): BoardEnvelope<T> {
  return {
    data,
    dataAsOf: ago(3),
    runIds: ['tick-daily', 'run-1'],
    freshness: { lastTrackAt: ago(3), lastDiscoverAt: ago(49) },
    sample,
    limit: 50,
    truncated: false,
  };
}

function series(base: number, drift: number, missing = 0): BoardScorecardRow['history'] {
  return Array.from({ length: 28 }, (_, i) => ({
    day: day(27 - i),
    floorSmall: i < missing ? null : Math.round(base + drift * i + ((i * 37) % 11) * base * 0.01),
  }));
}

export const MOCK_SCORECARD: BoardScorecardRow[] = [
  {
    niche: 'side-hustle', floorSmall: 4_150, floorSmall7dAgo: 3_600, nSmallChannels: 23, nSmallVideos: 410,
    repeat: { total: 6, reliable: 3, thin: 2, niche: 1 }, outliers28d: 14,
    stop: { ready: true, smallMeasured: 23, need: 20, rankStableDays: 15 }, history: series(3_200, 34),
  },
  {
    niche: 'debt-payoff', floorSmall: 2_300, floorSmall7dAgo: 2_450, nSmallChannels: 14, nSmallVideos: 205,
    repeat: { total: 3, reliable: 1, thin: 1, niche: 1 }, outliers28d: 6,
    stop: { ready: false, smallMeasured: 14, need: 20, rankStableDays: 15 }, history: series(2_500, -7),
  },
  {
    niche: 'retire-early', floorSmall: 1_150, floorSmall7dAgo: null, nSmallChannels: 6, nSmallVideos: 71,
    repeat: { total: 1, reliable: 0, thin: 0, niche: 1 }, outliers28d: 2,
    stop: { ready: false, smallMeasured: 6, need: 20, rankStableDays: 15 }, history: series(1_000, 6, 12),
  },
  {
    niche: null, floorSmall: 900, floorSmall7dAgo: 880, nSmallChannels: 3, nSmallVideos: 40,
    repeat: { total: 0, reliable: 0, thin: 0, niche: 0 }, outliers28d: 0,
    stop: { ready: false, smallMeasured: 3, need: 20, rankStableDays: 3 }, history: series(880, 1),
  },
];

const v = (
  id: string, title: string, ch: string, subs: number, views: number, x: number | null,
  tier: BoardVideoRow['tier'], ageDays: number, extra: Partial<BoardVideoRow> = {},
): BoardVideoRow => ({
  videoId: id, title, thumbnailUrl: null, channelId: `UC${ch}`, channelTitle: ch, subs,
  channelAgeDays: 120, niche: 'side-hustle', views, velocity24h: Math.round(views / Math.max(ageDays, 1)),
  publishedAt: ago(ageDays * 24), videoAgeDays: ageDays, outlierX: x, tier,
  baselineViews: x ? Math.round(views / x) : null, baselineN: tier === 'thin' ? 5 : 22,
  isOutlier: ageDays >= 7 && (x ?? 0) >= 3, isRising: ageDays < 7, foundByKeyword: 'side hustle ideas',
  ...extra,
});

export const MOCK_VIDEOS: BoardVideoRow[] = [
  v('dQw4w9WgXcQ', 'I Tried 7 Side Hustles for 30 Days — Real Numbers', 'Quiet Money', 6_200, 184_000, 22.4, 'reliable', 12),
  v('M7lc1UVf-VE', 'The $0 Side Hustle Nobody Talks About (POV)', 'Tiny Ledger', 2_100, 61_000, 18.46, 'thin', 9, { baselineN: 4, channelAgeDays: 64 }),
  v('aqz-KE-bpKQ', 'I Was Drowning in Debt. This Spreadsheet Saved Me', 'New Start Co', 800, 45_000, 11.0, 'niche', 15, { channelAgeDays: 21, baselineN: 410 }),
  v('ScMzIvxBSi4', 'How I Made $1,200 Reselling Thrift Finds', 'Flip Diary', 9_400, 22_000, 4.2, 'reliable', 20),
  v('jNQXAC9IVRw', 'My Honest Etsy Month 3 Report', 'Quiet Money', 6_200, 12_000, 3.1, 'reliable', 26),
  v('9bZkp7q19f0', 'Day 4 of Building a $100/day Side Hustle', 'Tiny Ledger', 2_100, 14_500, 5.8, 'thin', 3, { baselineN: 4 }),
  v('kJQP7kiw5Fk', 'Why Everyone Is Quitting Dropshipping (Data)', 'Flip Diary', 9_400, 9_800, 1.9, 'reliable', 2),
];

export const MOCK_CHANNELS: BoardChannelRow[] = [
  { channelId: 'UCQuiet Money', title: 'Quiet Money', subs: 6_200, isSmall: true, channelAgeDays: 410, niche: 'side-hustle', state: 'following', verdict: null, baselineViews: 8_200, baselineN: 28, tier: 'reliable', dead: false, outliers28d: 2, bestOutlierX: 22.4 },
  { channelId: 'UCTiny Ledger', title: 'Tiny Ledger', subs: 2_100, isSmall: true, channelAgeDays: 64, niche: 'side-hustle', state: 'measured', verdict: 'proposed', baselineViews: 3_300, baselineN: 5, tier: 'thin', dead: false, outliers28d: 1, bestOutlierX: 18.46 },
  { channelId: 'UCNew Start Co', title: 'New Start Co', subs: 800, isSmall: true, channelAgeDays: 21, niche: 'side-hustle', state: 'measured', verdict: 'unreliable', baselineViews: null, baselineN: 1, tier: null, dead: false, outliers28d: 1, bestOutlierX: 11 },
  { channelId: 'UCFlip Diary', title: 'Flip Diary', subs: 9_400, isSmall: true, channelAgeDays: 900, niche: 'side-hustle', state: 'pending', verdict: 'proposed', baselineViews: 5_200, baselineN: 30, tier: 'reliable', dead: false, outliers28d: 1, bestOutlierX: 4.2 },
  { channelId: 'UCSleepy', title: 'Sleepy Coins', subs: 3_000, isSmall: true, channelAgeDays: 300, niche: 'side-hustle', state: 'measured', verdict: 'dead', baselineViews: 210, baselineN: 14, tier: 'reliable', dead: true, outliers28d: 0, bestOutlierX: null },
];

export const MOCK_KEYWORDS: BoardKeywordRow[] = [
  { termKey: 'side_hustle_ideas', term: 'side hustle ideas', niche: 'side-hustle', status: 'active', lastCheckedAt: ago(30), lockedUntil: ago(-42), lastNResults: 50, lastNNew: 18, newRate: 0.36, nChecks: 3, outliersFound: 5 },
  { termKey: 'make_money_online_2026', term: 'make money online 2026', niche: 'side-hustle', status: 'active', lastCheckedAt: ago(24 * 5), lockedUntil: null, lastNResults: 50, lastNNew: 3, newRate: 0.06, nChecks: 4, outliersFound: 1 },
  { termKey: 'reselling_thrift', term: 'reselling thrift', niche: 'side-hustle', status: 'active', lastCheckedAt: null, lockedUntil: null, lastNResults: null, lastNNew: null, newRate: null, nChecks: 0, outliersFound: 0 },
  { termKey: 'debt_snowball', term: 'debt snowball', niche: 'debt-payoff', status: 'active', lastCheckedAt: ago(24 * 4), lockedUntil: null, lastNResults: 48, lastNNew: 20, newRate: 0.42, nChecks: 2, outliersFound: 3 },
  { termKey: 'fire_movement', term: 'FIRE movement', niche: 'retire-early', status: 'pending', lastCheckedAt: null, lockedUntil: null, lastNResults: null, lastNNew: null, newRate: null, nChecks: 0, outliersFound: 0 },
];

export const MOCK_RUNS: BoardRunCard[] = [
  { runId: 'tick-daily', source: 'loop_tick', type: 'track', niche: null, note: 'Theo dõi hằng ngày (tự động)', triggeredBy: 'loop', status: 'done', startedAt: ago(3.2), finishedAt: ago(3), nItems: null, itemsDone: null, searchCalls: 0, units: 38, nNew: null, nSkipped: null, newChannels: 0, error: null },
  { runId: 'run-1', source: 'keyword_run', type: 'discover', niche: 'side-hustle', note: 'Tìm kênh nhỏ đang lên', triggeredBy: 'human', status: 'done', startedAt: ago(49.2), finishedAt: ago(49), nItems: 12, itemsDone: 12, searchCalls: 10, units: 41, nNew: 143, nSkipped: 2, newChannels: 4, error: null },
  { runId: 'run-0', source: 'keyword_run', type: 'discover', niche: 'debt-payoff', note: null, triggeredBy: 'human', status: 'skipped_quota', startedAt: ago(98), finishedAt: ago(97.8), nItems: 8, itemsDone: 8, searchCalls: 5, units: 20, nNew: 61, nSkipped: 0, newChannels: 1, error: null },
];

export const MOCK_RUN_DETAIL: BoardRunDetail = {
  card: MOCK_RUNS[1]!,
  items: [
    { target: 'side_hustle_ideas', status: 'done', nResults: 50, nNew: 18, medianViews: 21_000, outliersFound: 3, skipReason: null, error: null },
    { target: 'make_money_online_2026', status: 'skipped_dedup', nResults: null, nNew: null, medianViews: null, outliersFound: null, skipReason: `searched_at:${ago(30)}`, error: null },
    { target: 'passive_income_ideas', status: 'done', nResults: 50, nNew: 4, medianViews: 88_000, outliersFound: 0, skipReason: null, error: null },
  ],
};
