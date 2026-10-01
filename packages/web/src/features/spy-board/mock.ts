/**
 * Mock data cho Spy Board — chỉ được import động khi URL có ?mock=1.
 * Số liệu giả để review bố cục (group ngách, trend, progress, outlier).
 */
import type {
  DashHotRow,
  DashKeywordRow,
  DashOutlierRow,
  DashTopicRow,
  DashVideoDayPoint,
  SpyKeywordRun,
  SpyKeywordRunDetail,
} from '../../api.ts';

export const MOCK_DASH_TOPICS: DashTopicRow[] = [
  {
    topic_id: 'pov-finance', label: 'POV Finance', market: 'us', language: 'en',
    region: 'US', status: 'active', setup_status: 'done',
    channels_active: 24, keywords_active: 14, videos_tracked: 1320,
    inbox_pending: 9, last_daily_at: '2026-09-27T06:10:00Z', last_daily_status: 'done',
    last_weekly_at: '2026-09-21T06:05:00Z', last_weekly_status: 'done',
  },
  {
    topic_id: 'bay-tra-gop', label: 'Bẫy trả góp', market: 'vi', language: 'vi',
    region: 'VN', status: 'active', setup_status: 'done',
    channels_active: 11, keywords_active: 8, videos_tracked: 640,
    inbox_pending: 3, last_daily_at: '2026-09-27T06:12:00Z', last_daily_status: 'done',
    last_weekly_at: null, last_weekly_status: null,
  },
  {
    topic_id: 'crypto-onchain', label: 'Crypto on-chain', market: 'vi', language: 'vi',
    region: 'VN', status: 'paused', setup_status: 'done',
    channels_active: 5, keywords_active: 4, videos_tracked: 210,
    inbox_pending: 0, last_daily_at: '2026-09-24T06:02:00Z', last_daily_status: 'skipped_quota',
    last_weekly_at: null, last_weekly_status: null,
  },
];

const now = Date.now();
const ago = (hours: number) => new Date(now - hours * 3_600_000).toISOString();

export const MOCK_DASH_KEYWORDS: DashKeywordRow[] = [
  // ngách "tra-gop"
  { term_key: 'tra-gop-0-dong', display_term: 'trả góp 0 đồng', status: 'active', origin: 'user', added_by: 'user', added_at: ago(24 * 30), decided_at: ago(24 * 30), decided_reason: null, last_checked_at: ago(5), last_n_results: 48, last_n_followed: 6, pct_followed: 0.125, last_median_views: 152000, prev_median_views: 121000, channels_discovered: 9, outliers_7d: 3, outliers_28d: 9, videos_found: 210, group_key: 'tra-gop' },
  { term_key: 'bay-tin-dung-tra-gop', display_term: 'bẫy tín dụng trả góp', status: 'active', origin: 'user', added_by: 'user', added_at: ago(24 * 30), decided_at: ago(24 * 30), decided_reason: null, last_checked_at: ago(5), last_n_results: 41, last_n_followed: 4, pct_followed: 0.098, last_median_views: 88400, prev_median_views: 99000, channels_discovered: 6, outliers_7d: 1, outliers_28d: 5, videos_found: 156, group_key: 'tra-gop' },
  { term_key: 'lai-suat-tra-gop', display_term: 'lãi suất trả góp thật', status: 'active', origin: 'title_ngram', added_by: 'loop', added_at: ago(24 * 12), decided_at: ago(24 * 12), decided_reason: null, last_checked_at: ago(30), last_n_results: 37, last_n_followed: 3, pct_followed: 0.081, last_median_views: 41200, prev_median_views: 41200, channels_discovered: 3, outliers_7d: 0, outliers_28d: 2, videos_found: 74, group_key: 'tra-gop' },
  // ngách "the-tin-dung"
  { term_key: 'the-tin-dung-sinh-vien', display_term: 'thẻ tín dụng cho sinh viên', status: 'active', origin: 'user', added_by: 'user', added_at: ago(24 * 25), decided_at: ago(24 * 25), decided_reason: null, last_checked_at: ago(4), last_n_results: 50, last_n_followed: 8, pct_followed: 0.16, last_median_views: 203000, prev_median_views: 160000, channels_discovered: 12, outliers_7d: 4, outliers_28d: 11, videos_found: 305, group_key: 'the-tin-dung' },
  { term_key: 'dao-no-the-tin-dung', display_term: 'đáo nợ thẻ tín dụng', status: 'active', origin: 'outlier_title', added_by: 'loop', added_at: ago(24 * 9), decided_at: ago(24 * 9), decided_reason: null, last_checked_at: ago(4), last_n_results: 44, last_n_followed: 5, pct_followed: 0.114, last_median_views: 121500, prev_median_views: 98000, channels_discovered: 7, outliers_7d: 2, outliers_28d: 7, videos_found: 132, group_key: 'the-tin-dung' },
  { term_key: 'phi-an-niem-the', display_term: 'phí ẩn danh thẻ tín dụng', status: 'pending', origin: 'title_ngram', added_by: 'loop', added_at: ago(30), decided_at: null, decided_reason: null, last_checked_at: null, last_n_results: null, last_n_followed: null, pct_followed: null, last_median_views: null, prev_median_views: null, channels_discovered: 0, outliers_7d: 0, outliers_28d: 0, videos_found: 0, group_key: 'the-tin-dung' },
  // ngách "dau-tu"
  { term_key: 'etf-cho-nguoi-moi', display_term: 'ETF cho người mới', status: 'active', origin: 'user', added_by: 'user', added_at: ago(24 * 40), decided_at: ago(24 * 40), decided_reason: null, last_checked_at: ago(2), last_n_results: 50, last_n_followed: 9, pct_followed: 0.18, last_median_views: 310000, prev_median_views: 298000, channels_discovered: 15, outliers_7d: 5, outliers_28d: 14, videos_found: 402, group_key: 'dau-tu' },
  { term_key: 'chung-khoan-phai-sinh', display_term: 'chứng khoán phái sinh', status: 'paused', origin: 'user', added_by: 'user', added_at: ago(24 * 40), decided_at: ago(24 * 8), decided_reason: 'reject_rate cao', last_checked_at: ago(24 * 7), last_n_results: 39, last_n_followed: 1, pct_followed: 0.026, last_median_views: 62000, prev_median_views: 87000, channels_discovered: 2, outliers_7d: 0, outliers_28d: 1, videos_found: 88, group_key: 'dau-tu' },
  // chưa gán ngách
  { term_key: 'tiet-kiem-10-trieu', display_term: 'tiết kiệm 10 triệu đầu tiên', status: 'active', origin: 'user', added_by: 'user', added_at: ago(24 * 20), decided_at: ago(24 * 20), decided_reason: null, last_checked_at: ago(6), last_n_results: 46, last_n_followed: 5, pct_followed: 0.109, last_median_views: 96000, prev_median_views: 110000, channels_discovered: 5, outliers_7d: 1, outliers_28d: 4, videos_found: 121, group_key: null },
  { term_key: 'quy-mo-nho', display_term: 'đầu tư quỹ mở nhỏ lẻ', status: 'pending', origin: 'harvested', added_by: 'loop', added_at: ago(8), decided_at: null, decided_reason: null, last_checked_at: null, last_n_results: null, last_n_followed: null, pct_followed: null, last_median_views: null, prev_median_views: null, channels_discovered: 0, outliers_7d: 0, outliers_28d: 0, videos_found: 0, group_key: null },
  { term_key: 'forex-signal', display_term: 'forex signal vip', status: 'rejected', origin: 'seed', added_by: 'user', added_at: ago(24 * 40), decided_at: ago(24 * 39), decided_reason: 'off-topic', last_checked_at: null, last_n_results: null, last_n_followed: null, pct_followed: null, last_median_views: null, prev_median_views: null, channels_discovered: 0, outliers_7d: 0, outliers_28d: 0, videos_found: 0, group_key: null },
];

export const MOCK_DASH_RUNS: SpyKeywordRun[] = [
  { run_id: 'run-9f2a', status: 'running', n_keywords: 8, keywords_done: 3, search_calls_used: 3, started_at: ago(0.08), finished_at: null },
  { run_id: 'run-771c', status: 'done', n_keywords: 12, keywords_done: 12, search_calls_used: 12, started_at: ago(30), finished_at: ago(29.6) },
  { run_id: 'run-540e', status: 'skipped_quota', n_keywords: 20, keywords_done: 14, search_calls_used: 14, started_at: ago(52), finished_at: ago(51.4) },
];

export const MOCK_DASH_RUN_DETAIL: SpyKeywordRunDetail = {
  ...MOCK_DASH_RUNS[0]!,
  items: [
    { term_key: 'tra-gop-0-dong', status: 'done', n_results: 48, n_followed: 6, median_views: 152000, outliers_found: 2, error: null },
    { term_key: 'bay-tin-dung-tra-gop', status: 'done', n_results: 41, n_followed: 4, median_views: 88400, outliers_found: 1, error: null },
    { term_key: 'the-tin-dung-sinh-vien', status: 'done', n_results: 50, n_followed: 8, median_views: 203000, outliers_found: 3, error: null },
    { term_key: 'lai-suat-tra-gop', status: 'skipped_quota', n_results: null, n_followed: null, median_views: null, outliers_found: null, error: null },
  ],
};

const yt = (id: string) => `https://youtu.be/${id}`;

export const MOCK_DASH_OUTLIERS: DashOutlierRow[] = [
  { video_id: 'xY9abc12345', title: 'Trả góp 0 đồng — cái bẫy ngọt ngào ai cũng từng gặp', channel_id: 'UC_a1', channel_title: 'Tài Chính Kể', channel_status: 'active', scope: 'followed', published_at: ago(24 * 5), latest_views: 912000, baseline_median_views: 120000, outlier_score: 7.6, found_by_keyword: 'tra-gop-0-dong', channel_in_inbox: false },
  { video_id: 'bb22cc33dd4', title: 'Cách tính lãi thật khi mua trả góp — số hoá đơn không ai đọc', channel_id: 'UC_b2', channel_title: 'Giải Mã Tiền', channel_status: 'new', scope: 'external', published_at: ago(24 * 9), latest_views: 430000, baseline_median_views: 41000, outlier_score: 10.5, found_by_keyword: 'bay-tin-dung-tra-gop', channel_in_inbox: true },
  { video_id: 'cc44dd55ee6', title: 'Sinh viên nên mở thẻ tín dụng đầu tiên thế nào?', channel_id: 'UC_c3', channel_title: 'Money 101', channel_status: 'active', scope: 'followed', published_at: ago(24 * 3), latest_views: 1500000, baseline_median_views: 200000, outlier_score: 7.5, found_by_keyword: 'the-tin-dung-sinh-vien', channel_in_inbox: false },
  { video_id: 'dd66ee77ff8', title: 'Đáo nợ thẻ tín dụng: con đường nhanh nhất dẫn tới nợ chồng nợ', channel_id: 'UC_d4', channel_title: 'Nợ & Sống', channel_status: null, scope: 'external', published_at: ago(24 * 12), latest_views: 268000, baseline_median_views: 35000, outlier_score: 7.7, found_by_keyword: 'dao-no-the-tin-dung', channel_in_inbox: false },
  { video_id: 'ee88ff99gg0', title: 'ETF VN30 giải thích trong 10 phút', channel_id: 'UC_e5', channel_title: 'ETF Dễ', channel_status: 'new', scope: 'external', published_at: ago(24 * 2), latest_views: 710000, baseline_median_views: 58000, outlier_score: 12.2, found_by_keyword: 'etf-cho-nguoi-moi', channel_in_inbox: true },
  { video_id: 'ff00gg11hh2', title: 'Vì sao ETF thắng stock picking ở 90% người chơi', channel_id: 'UC_f6', channel_title: 'Chứng Khoán Từ Đầu', channel_status: 'active', scope: 'followed', published_at: ago(24 * 16), latest_views: 520000, baseline_median_views: 140000, outlier_score: 3.7, found_by_keyword: 'etf-cho-nguoi-moi', channel_in_inbox: false },
];

export const MOCK_DASH_HOT: DashHotRow[] = [
  { rank: 1, video_id: 'cc44dd55ee6', title: 'Sinh viên nên mở thẻ tín dụng đầu tiên thế nào?', channel_id: 'UC_c3', channel_title: 'Money 101', views: 1500000, views_gained: 210000, window_days: 1, gained_per_day: 210000, heat: 31.5, outlier_score: 7.5, age_days: 3, launch_spike: true },
  { rank: 2, video_id: 'ee88ff99gg0', title: 'ETF VN30 giải thích trong 10 phút', channel_id: 'UC_e5', channel_title: 'ETF Dễ', views: 710000, views_gained: 96000, window_days: 1, gained_per_day: 96000, heat: 18.4, outlier_score: 12.2, age_days: 2, launch_spike: true },
  { rank: 3, video_id: 'xY9abc12345', title: 'Trả góp 0 đồng — cái bẫy ngọt ngào ai cũng từng gặp', channel_id: 'UC_a1', channel_title: 'Tài Chính Kể', views: 912000, views_gained: 54000, window_days: 1, gained_per_day: 54000, heat: 9.8, outlier_score: 7.6, age_days: 5, launch_spike: false },
  { rank: 4, video_id: 'dd66ee77ff8', title: 'Đáo nợ thẻ tín dụng: con đường nhanh nhất dẫn tới nợ chồng nợ', channel_id: 'UC_d4', channel_title: 'Nợ & Sống', views: 268000, views_gained: 31000, window_days: 1, gained_per_day: 31000, heat: 6.2, outlier_score: 7.7, age_days: 12, launch_spike: false },
];

export function mockVideoTs(videoId: string): DashVideoDayPoint[] {
  void videoId;
  const base = [12000, 31000, 68000, 145000, 232000, 318000, 402000, 466000, 519000, 560000];
  return base.map((views, i) => ({
    day: new Date(now - (base.length - 1 - i) * 86_400_000).toISOString().slice(0, 10),
    views,
    likes: Math.round(views * 0.031),
    comments: Math.round(views * 0.0021),
    views_gained: i === 0 ? null : views - base[i - 1]!,
  }));
}
