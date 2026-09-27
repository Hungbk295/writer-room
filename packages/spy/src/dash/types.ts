// packages/spy/src/dash/types.ts — hợp đồng kiểu cho Spy Dashboard API
// (docs/plans/spy-dashboard-api.html §3). File này là nguồn sự thật cho
// cả registry.ts (Devin A) lẫn activity.ts (Devin B): mọi endpoint trả đúng
// shape bên dưới, số thô không format locale, "chưa đủ dữ liệu" → null.

import type { Database } from 'bun:sqlite';
import type {
  KeywordOrigin,
  LoopMode,
  TopicChannelStatusV3,
  TopicKeywordStatusV3,
  TopicSetupStatus,
} from '../store.js';

// ---------------------------------------------------------------------------
// Tham số chung (§1) — route parse query string thành các type này rồi mới gọi
// hàm dash/*. from/to là quota_day YYYY-MM-DD; mặc định 28 ngày gần nhất do
// route điền (hàm query luôn nhận khoảng đã resolve).
// ---------------------------------------------------------------------------

export type DashSortOrder = 'asc' | 'desc';

export interface DashRange {
  /** quota_day đầu khoảng, đã resolve mặc định. */
  from: string;
  /** quota_day cuối khoảng, đã resolve mặc định. */
  to: string;
}

export interface DashPage {
  limit: number; // mặc định 50, tối đa 500
  offset: number; // mặc định 0
}

export interface DashSort<S extends string> {
  sort: S;
  order: DashSortOrder;
}

/** Envelope chuẩn { data, meta } của mọi endpoint (§1). */
export interface DashMeta {
  topic_id?: string;
  as_of: string; // ISO-8601 UTC lúc truy vấn
  total?: number;
  limit?: number;
  offset?: number;
  from?: string;
  to?: string;
  summary?: DashDecisionSummary; // chỉ /dash/decisions (#14)
}

export interface DashEnvelope<T> {
  data: T;
  meta: DashMeta;
}

// ---------------------------------------------------------------------------
// #1 GET /dash/meta — định nghĩa chỉ số + ngưỡng + enum
// ---------------------------------------------------------------------------

export interface DashMetricDef {
  key: string;
  label: string;
  formula: string;
  /** Điều kiện trả null — ví dụ "baseline_n < baseline_min_n". */
  null_when?: string;
}

export interface DashMetaData {
  metrics: DashMetricDef[];
  default_settings: Record<string, number | string>;
  enums: {
    channel_status: TopicChannelStatusV3[];
    keyword_status: TopicKeywordStatusV3[];
    keyword_origin: KeywordOrigin[];
    discovered_via: string[];
    tick_mode: LoopMode[];
    decision_actor: ('human' | 'loop')[];
    video_source: string[];
    tick_status: string[];
  };
}

// ---------------------------------------------------------------------------
// #2 GET /dash/topics — danh sách topic + điểm dừng hiện tại
// ---------------------------------------------------------------------------

export interface DashTopicRow {
  topic_id: string;
  label: string;
  market: string;
  language: string;
  region: string | null;
  status: string;
  setup_status: TopicSetupStatus;
  channels_active: number;
  keywords_active: number;
  videos_tracked: number;
  /** channels_new + keywords_pending + suggestions đang chờ người duyệt. */
  inbox_pending: number;
  last_daily_at: string | null;
  last_daily_status: string | null;
  last_weekly_at: string | null;
  last_weekly_status: string | null;
}

// ---------------------------------------------------------------------------
// #3 GET /dash/overview — hôm nay so với hôm qua (Devin B: overview())
// ---------------------------------------------------------------------------

export interface DashStatusCounts {
  new: number;
  active: number;
  paused: number;
  rejected: number;
  own: number;
}

export interface DashKeywordStatusCounts {
  pending: number;
  active: number;
  paused: number;
  rejected: number;
}

export interface DashOverview {
  /** quota_day đang tổng hợp (mặc định = hôm nay). */
  date: string;
  channels: DashStatusCounts;
  keywords: DashKeywordStatusCounts;
  videos_tracked: number;
  new_videos_today: number;
  new_videos_7d: number;
  /** Σ views_gained của video có đủ 2 snapshot trong ngày; null khi chưa có gì. */
  views_gained_today: number | null;
  outliers_7d: { followed: number; external: number };
  inbox_pending: { channels: number; keywords: number; suggestions: number };
  quota_today: { search_calls: number; general_units: number };
  delta_vs_prev_day: {
    views_gained_today: number | null;
    new_videos_today: number | null;
    channels_active: number | null;
    keywords_active: number | null;
  };
  last_ticks: {
    daily: { at: string | null; status: string | null };
    weekly: { at: string | null; status: string | null };
  };
}

export interface DashOverviewParams {
  /** quota_day; route mặc định hôm nay. */
  date?: string;
}

// ---------------------------------------------------------------------------
// #4 GET /dash/channels — follow list + inbox (registry.ts)
// ---------------------------------------------------------------------------

export type DashChannelSort =
  | 'baseline_median_views'
  | 'subscriber_count'
  | 'last_published_at'
  | 'views_gained_7d'
  | 'outliers_28d'
  | 'first_seen_at';

export interface DashChannelsParams extends DashPage, DashSort<DashChannelSort> {
  status?: TopicChannelStatusV3;
  discoveredVia?: string;
  /** lọc chữ trong title/handle. */
  q?: string;
}

export interface DashChannelRow {
  channel_id: string;
  title: string | null;
  handle: string | null;
  url: string;
  subscriber_count: number | null;
  status: TopicChannelStatusV3;
  suggestion: string | null;
  discovered_via: string | null;
  discovered_from: string | null;
  first_seen_at: string;
  decided_at: string | null;
  decided_reason: string | null;
  baseline_median_views: number | null;
  baseline_n: number | null;
  /** baseline_n >= settings.baselineMinN. */
  baseline_reliable: boolean;
  max_views: number | null;
  /** max_views / baseline_median_views; null khi baseline chưa tin cậy. */
  max_over_median: number | null;
  /** median < settings.deadMedian; null khi baseline chưa tin cậy. */
  is_dead: boolean | null;
  /** max_over_median > settings.lotteryRatio; null khi baseline chưa tin cậy. */
  is_lottery: boolean | null;
  last_published_at: string | null;
  days_since_upload: number | null;
  last_checked_at: string | null;
  videos_tracked: number;
  uploads_28d: number;
  /** Σ gained trong 7 ngày qua video_daily_views; null khi chưa có snapshot. */
  views_gained_7d: number | null;
  outliers_28d: number;
  thumbnails: string[];
}

// ---------------------------------------------------------------------------
// #5 GET /dash/channels/:channel_id — chi tiết + lịch sử quyết định
// ---------------------------------------------------------------------------

export interface DashChannelDetail {
  channel: DashChannelRow;
  recent_videos: DashVideoRow[]; // tối đa 20 dòng, mới nhất trước
  decisions: DashDecisionRow[]; // quyết định của riêng kênh này
}

// ---------------------------------------------------------------------------
// #6 GET /dash/channels/:id/timeseries (Devin B: channelTimeseries())
// ---------------------------------------------------------------------------

export interface DashChannelDayPoint {
  day: string; // quota_day
  /** Σ latest_views của các video kênh quan sát được ngày đó. */
  total_views: number;
  /** Σ hiệu snapshot liên tiếp trong ngày; null khi chưa đủ 2 snapshot. */
  views_gained: number | null;
  /** video có published_at trong ngày. */
  uploads: number;
  /** số video có snapshot ngày đó. */
  videos_observed: number;
}

// ---------------------------------------------------------------------------
// #7 GET /dash/keywords (registry.ts)
// ---------------------------------------------------------------------------

export type DashKeywordSort =
  | 'last_median_views'
  | 'last_n_followed'
  | 'last_checked_at'
  | 'added_at';

export interface DashKeywordsParams extends DashPage, DashSort<DashKeywordSort> {
  status?: TopicKeywordStatusV3;
  origin?: KeywordOrigin;
  q?: string;
}

export interface DashKeywordEvidence {
  n_channels: number | null;
  sample_video_ids: string[];
}

export interface DashKeywordRow {
  term_key: string;
  display_term: string;
  status: TopicKeywordStatusV3;
  origin: KeywordOrigin | null;
  added_by: 'user' | 'loop' | 'agent';
  added_at: string;
  decided_at: string | null;
  decided_reason: string | null;
  last_checked_at: string | null;
  last_n_results: number | null;
  last_n_followed: number | null;
  /** last_n_followed / last_n_results; null khi chưa quét. */
  pct_followed: number | null;
  last_median_views: number | null;
  /** số kênh có discovered_from = term_key. */
  channels_discovered: number;
  evidence: DashKeywordEvidence;
}

// ---------------------------------------------------------------------------
// #8 GET /dash/videos (Devin B: videosList())
// ---------------------------------------------------------------------------

export type DashVideoSort =
  | 'views_gained_24h'
  | 'outlier_score'
  | 'latest_views'
  | 'published_at'
  | 'first_seen_at';

export interface DashVideosParams extends DashPage, DashSort<DashVideoSort> {
  channelId?: string;
  source?: string; // setup | daily_scan | weekly_search
  keyword?: string; // found_by_keyword
  publishedAfter?: string;
  minOutlier?: number;
  minDuration?: number;
}

export interface DashVideoRow {
  video_id: string;
  url: string;
  title: string;
  thumbnail_url: string | null;
  channel_id: string;
  channel_title: string | null;
  channel_status: TopicChannelStatusV3 | null;
  published_at: string | null;
  /** số ngày từ published_at tới hôm nay; null khi thiếu published_at. */
  age_days: number | null;
  duration_sec: number | null;
  is_short: boolean | null; // duration_sec < settings.minDurationSec
  latest_views: number | null;
  latest_likes: number | null;
  latest_comments: number | null;
  latest_at: string | null;
  views_gained_24h: number | null;
  outlier_score: number | null;
  is_outlier: boolean | null; // outlier_score >= settings.outlierMultiple
  /** video < 3 ngày tuổi mà đã nổ — tách khỏi outlier lâu năm. */
  launch_spike: boolean | null;
  source: string;
  found_by_keyword: string | null;
  first_seen_at: string;
  /** số snapshot trong video_daily_views. */
  snapshots: number;
}

// ---------------------------------------------------------------------------
// #9 GET /dash/videos/:id/timeseries (Devin B: videoTimeseries())
// ---------------------------------------------------------------------------

export interface DashVideoDayPoint {
  day: string;
  views: number;
  likes: number | null;
  comments: number | null;
  /** hiệu với snapshot trước; null cho điểm đầu tiên. */
  views_gained: number | null;
}

// ---------------------------------------------------------------------------
// #10 GET /dash/hot (Devin B: hotBoard()) — top tăng view của một ngày bất kỳ
// ---------------------------------------------------------------------------

export interface DashHotParams {
  /** quota_day; route mặc định hôm nay. */
  date?: string;
  limit?: number; // mặc định 10
  /** bỏ launch_spike (video <3 ngày tuổi) khỏi bảng nóng. */
  excludeLaunch?: boolean;
}

export interface DashHotRow {
  rank: number;
  video_id: string;
  title: string;
  channel_id: string;
  channel_title: string | null;
  /** views của snapshot ngày `date`. */
  views: number;
  /** views - snapshot gần nhất trước `date`; null khi video mới có 1 snapshot. */
  views_gained: number | null;
  /** khoảng ngày giữa 2 snapshot (1 khi liên tiếp). */
  window_days: number;
  /** views_gained / window_days; null theo views_gained. */
  gained_per_day: number | null;
  /** gained_per_day / (baseline_median/30); null khi baseline chưa tin cậy. */
  heat: number | null;
  outlier_score: number | null;
  age_days: number | null;
  launch_spike: boolean | null;
}

// ---------------------------------------------------------------------------
// #11 GET /dash/outliers (Devin B: outliers())
// ---------------------------------------------------------------------------

export type DashOutlierScope = 'followed' | 'external' | 'all';

export interface DashOutliersParams extends DashPage {
  range: DashRange; // mặc định 7 ngày gần nhất
  scope: DashOutlierScope;
  /** mặc định = settings.outlierMultiple của topic. */
  minMultiple: number;
}

export interface DashOutlierRow {
  video_id: string;
  title: string;
  channel_id: string;
  channel_title: string | null;
  channel_status: TopicChannelStatusV3 | null;
  scope: 'followed' | 'external';
  published_at: string | null;
  latest_views: number | null;
  baseline_median_views: number | null;
  outlier_score: number | null;
  found_by_keyword: string | null;
  /** kênh của video đang ngồi trong inbox (status=new). */
  channel_in_inbox: boolean;
}

// ---------------------------------------------------------------------------
// #12 GET /dash/timeseries (Devin B: timeseries())
// ---------------------------------------------------------------------------

export type DashMetric =
  | 'views_gained'
  | 'new_videos'
  | 'outliers'
  | 'new_channels'
  | 'approvals'
  | 'search_calls'
  | 'general_units';

export type DashGroupBy = 'day' | 'week';

export interface DashTimeseriesParams {
  metric: DashMetric;
  range: DashRange;
  groupBy: DashGroupBy;
}

export interface DashSeriesPoint {
  /** day = YYYY-MM-DD; week = đầu tuần (Thứ 2) YYYY-MM-DD. */
  bucket: string;
  value: number;
  /** tách theo mode/status tuỳ metric (vd approvals theo to_status). */
  breakdown?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// #13 GET /dash/inbox (registry.ts) — việc chờ người duyệt
// ---------------------------------------------------------------------------

export interface DashInbox {
  channels_new: DashChannelRow[];
  keywords_pending: DashKeywordRow[];
  channels_suggested: DashChannelRow[];
  counts: { channels: number; keywords: number; suggestions: number };
}

// ---------------------------------------------------------------------------
// #14 GET /dash/decisions (registry.ts) — audit log + bằng chứng HITL
// ---------------------------------------------------------------------------

export interface DashDecisionsParams extends DashPage, DashRange {
  actor?: 'human' | 'loop';
  entityType?: 'channel' | 'keyword';
  entityId?: string;
}

export interface DashDecisionRow {
  id: string;
  at: string;
  actor: 'human' | 'loop';
  entity_type: 'channel' | 'keyword';
  entity_id: string;
  /** title kênh / display_term keyword — join khi còn tồn tại. */
  entity_label: string | null;
  from_status: string | null;
  to_status: string;
  reason: string;
  tick_id: string | null;
}

export interface DashDecisionSummary {
  by_actor: { human: number; loop: number };
  loop_to_status: { new: number; pending: number; rejected: number };
  /** dòng actor=loop mà to_status ∈ {active, paused} — phải luôn = 0. */
  hitl_violations: number;
}

// ---------------------------------------------------------------------------
// #15 GET /dash/ticks (registry.ts) — lịch sử chạy loop
// ---------------------------------------------------------------------------

export interface DashTicksParams extends DashPage, DashRange {
  mode?: LoopMode;
}

export interface DashTickRow {
  tick_id: string;
  mode: LoopMode;
  quota_day: string;
  started_at: string;
  finished_at: string | null;
  /** finished_at - started_at; null khi đang chạy. */
  duration_sec: number | null;
  status: string; // running | done | failed | skipped_quota
  step: string;
  error: string | null;
  search_calls_used: number;
  general_units_used: number;
  scanned_channels: number;
  new_candidates: number;
  keywords_harvested: number;
}

// ---------------------------------------------------------------------------
// #16 GET /dash/reports + GET /dash/quota (registry.ts)
// ---------------------------------------------------------------------------

export interface DashReportsParams extends DashPage {
  mode?: LoopMode;
  date?: string; // report_date cụ thể
}

export interface DashReportRow {
  report_id: string;
  report_date: string;
  mode: LoopMode;
  /** summary_json đã parse. */
  summary: Record<string, unknown>;
  markdown: string;
  /** delivered_json đã parse. */
  delivered: Record<string, unknown>;
}

export interface DashQuotaParams extends DashRange {
  bucket?: string;
}

export interface DashQuotaRow {
  quota_day: string;
  bucket: string;
  units: number;
  calls: number;
}

// ---------------------------------------------------------------------------
// Chữ ký hàm — Devin B cài trong packages/spy/src/dash/activity.ts.
// Hàm thuần nhận Database (read-only), trả đúng type trên; KHÔNG INSERT/UPDATE.
// Route (dash-routes.ts) parse query → params đã resolve default → gọi hàm.
// ---------------------------------------------------------------------------

export type DashOverviewFn = (
  db: Database,
  topicId: string,
  params: DashOverviewParams,
) => DashOverview;

export type DashVideosListFn = (
  db: Database,
  topicId: string,
  params: DashVideosParams,
) => { rows: DashVideoRow[]; total: number };

/** null = video không thuộc topic (route trả 404). */
export type DashVideoTimeseriesFn = (
  db: Database,
  topicId: string,
  videoId: string,
) => DashVideoDayPoint[] | null;

/** null = kênh không thuộc topic (route trả 404). */
export type DashChannelTimeseriesFn = (
  db: Database,
  topicId: string,
  channelId: string,
  params: DashRange,
) => DashChannelDayPoint[] | null;

export type DashHotBoardFn = (
  db: Database,
  topicId: string,
  params: DashHotParams,
) => DashHotRow[];

export type DashOutliersFn = (
  db: Database,
  topicId: string,
  params: DashOutliersParams,
) => DashOutlierRow[];

export type DashTimeseriesFn = (
  db: Database,
  topicId: string,
  params: DashTimeseriesParams,
) => DashSeriesPoint[];

// ---------------------------------------------------------------------------
// Chữ ký hàm — Devin A cài trong packages/spy/src/dash/registry.ts.
// ---------------------------------------------------------------------------

export type DashMetaFn = (db: Database) => DashMetaData;

export type DashTopicsFn = (db: Database) => DashTopicRow[];

export type DashChannelsFn = (
  db: Database,
  topicId: string,
  params: DashChannelsParams,
) => { rows: DashChannelRow[]; total: number };

/** null = kênh không thuộc topic (route trả 404). */
export type DashChannelDetailFn = (
  db: Database,
  topicId: string,
  channelId: string,
) => DashChannelDetail | null;

export type DashKeywordsFn = (
  db: Database,
  topicId: string,
  params: DashKeywordsParams,
) => { rows: DashKeywordRow[]; total: number };

export type DashInboxFn = (db: Database, topicId: string) => DashInbox;

export type DashDecisionsFn = (
  db: Database,
  topicId: string,
  params: DashDecisionsParams,
) => { rows: DashDecisionRow[]; total: number; summary: DashDecisionSummary };

export type DashTicksFn = (
  db: Database,
  topicId: string,
  params: DashTicksParams,
) => { rows: DashTickRow[]; total: number };

export type DashReportsFn = (
  db: Database,
  topicId: string,
  params: DashReportsParams,
) => { rows: DashReportRow[]; total: number };

export type DashQuotaFn = (
  db: Database,
  params: DashQuotaParams,
) => DashQuotaRow[];
