/**
 * Kiểu dữ liệu dùng chung cho Spy Auto-Loop.
 *
 * File này KHÔNG import bất kỳ module nào trong codebase ngoài 'zod' để giữ
 * dependency nhẹ và cho phép agy-2/agy-3 import mà không kéo theo store/DB.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// §1.2 — TopicConfig (source of truth: config/topics/<id>.json)
// ---------------------------------------------------------------------------

export const topicConfigSchema = z.object({
  topicId: z.string().min(1),
  label: z.string().min(1),
  /** ISO 639-1, vd 'vi' | 'en'. */
  market: z.string().min(2).max(5),
  /** ISO 639-1 — ngôn ngữ post-filter. */
  language: z.string().min(2).max(5),
  /**
   * ISO 3166-1 alpha-2, vd 'VN' | 'US' — search regionCode + languageMatch
   * (ADR-7). Cột `topics.region` từ migration v13. Rỗng = chưa khai báo →
   * runner rơi về suy luận cũ `market.toUpperCase().slice(0,2)` (topic 'vi'
   * cho ra 'VI' không hợp lệ nhưng đó đúng là hành vi hiện tại — bay-tra-gop
   * không đổi cho tới khi region được khai báo).
   */
  region: z.string().max(2).default(''),
  /** Kênh của mình trong chủ đề này — dùng làm baseline cho learnValue. */
  ownChannelIds: z.array(z.string()).default([]),
  /** Từ khoá gieo hạt — đưa vào discoverVideos. */
  seedKeywords: z.array(z.string()).default([]),
  /**
   * Kênh đối thủ user tự biết — cold start 0 quota, thay cho provider ngoài (§1.2).
   * importTopicFiles upsert thẳng vào candidate_channels(discovered_via='seed_config').
   */
  seedChannelIds: z.array(z.string()).default([]),
  /** Cụm từ chống trôi chủ đề — keyword harvest phải đồng xuất hiện với ≥1 term này. */
  anchorTerms: z.array(z.string()).default([]),
  /** Từ khoá loại trừ — dính thì phạt fit score. */
  negativeKeywords: z.array(z.string()).default([]),
  /**
   * Cờ chủ đề "chỉ lấy kênh faceless". P0 KHÔNG gate được vì chưa có verdict
   * (§3) — faceless_hint là phỏng đoán, không đủ tư cách chặn. Giữ cờ để vòng
   * agent vision dùng.
   */
  facelessRequired: z.boolean().default(true),
  /** Ưu tiên videoDuration medium|long khi search. */
  preferLongform: z.boolean().default(true),
  /** Số search call tối đa mỗi ngày cho chủ đề này. */
  dailySearchBudget: z.number().int().min(1).max(100).default(20),
  /** Prose: khán giả, giọng, format, thứ KHÔNG làm — LLM đọc ở P1. */
  brief: z.string().default(''),
  /** active | paused | archived. */
  status: z.enum(['active', 'paused', 'archived']).default('active'),
});

export type TopicConfig = z.infer<typeof topicConfigSchema>;

// ---------------------------------------------------------------------------
// Store row types (mirrors §1.1 DDL)
// ---------------------------------------------------------------------------

export interface TopicRow {
  topicId: string;
  label: string;
  market: string;
  language: string;
  /** v13: ISO 3166-1 alpha-2 — undefined trước migration. */
  region?: string | null;
  /** v13: 'none' | 'awaiting_channels' | 'awaiting_keywords' | 'done'. */
  setupStatus?: string;
  /** v13: settings_json thô — store merge với DEFAULT_TOPIC_SETTINGS. */
  settingsJson?: string | null;
  status: 'active' | 'paused' | 'archived';
  ownChannelIdsJson: string;   // JSON array
  briefMd: string;
  facelessRequired: boolean;
  dailySearchBudget: number;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// v3-lean — kiểu hợp đồng store sống ở store.ts (Devin A, migration v13):
// LoopMode, TopicSettings (camelCase), TopicSetupStatus, các row v3,
// KeywordOrigin. File này KHÔNG re-export chúng (tránh export-* ambiguity ở
// index.ts) — caller import thẳng từ '../store.ts'. Hai import dưới chỉ phục
// vụ nội bộ file.
// ---------------------------------------------------------------------------

import type { LoopMode, TopicSetupStatus } from '../store.ts';

// ---------------------------------------------------------------------------
// v3-lean — nhịp chạy (SetupStep là khái niệm của flow layer, store không cần)
// ---------------------------------------------------------------------------

/** Hai bước setup tách lệnh riêng — mỗi bước dừng chờ người duyệt (S2/S3). */
export type SetupStep = 'channels' | 'keywords';

export type TopicKeywordRelation =
  | 'seed'
  | 'harvested_title'
  | 'harvested_tag'
  | 'comment_mined'
  | 'graph'
  | 'yt_suggest'
  | 'llm_expand';

/**
 * v13 CHECK: pending | active | paused | rejected. Migration đã ánh xạ
 * searched→active, exhausted→paused — không còn row legacy để đọc.
 */
export type TopicKeywordStatus = 'pending' | 'active' | 'paused' | 'rejected';

export type LoopTickStatus = 'running' | 'done' | 'failed' | 'skipped_quota';
export type LoopTickStep = 'expand' | 'search' | 'enrich' | 'triage' | 'scan' | 'harvest' | 'report';

export interface LoopTickRow {
  tickId: string;
  topicId: string;
  quotaDay: string;             // YYYY-MM-DD Pacific
  /** v13: nhịp của tick — idempotency theo (topic_id, quota_day, mode). */
  mode?: LoopMode;
  startedAt: string;
  finishedAt: string | null;
  status: LoopTickStatus;
  step: LoopTickStep;
  searchCallsUsed: number;
  generalUnitsUsed: number;
  keywordsSearchedJson: string;  // string[]
  newCandidates: number;
  newShortlistedAuto: number;
  scannedChannels: number;
  keywordsHarvested: number;
  error: string | null;
}

export interface DailyReportRow {
  reportId: string;
  reportDate: string;            // YYYY-MM-DD
  topicId: string | null;        // NULL = tổng hợp
  /** v13: report thuộc nhịp nào — UNIQUE (topic_id, report_date, mode). */
  mode?: LoopMode;
  summaryJson: string;           // ReportSummaryJson (immutable)
  markdown: string;
  createdAt: string;
  deliveredJson: string;         // {telegram?: ts, mcp_read?: ts, telegram_digest?: ts}
}

// ---------------------------------------------------------------------------
// Planning & execution
// ---------------------------------------------------------------------------

export interface TickPlan {
  topicId: string;
  quotaDay: string;
  dryRun: boolean;
  estimatedSearchCalls: number;
  estimatedGeneralUnits: number;
  keywordsToSearch: string[];
  channelsToExpand: string[];
  canProceed: boolean;
  blockers: string[];
}

export interface TickResult {
  tickId: string;
  topicId: string;
  quotaDay: string;
  /** Nhịp của tick (v3). Legacy runTick không truyền → undefined. */
  mode?: LoopMode;
  /** Chỉ mode='setup': bước đã chạy trong tick này. */
  setupStep?: SetupStep;
  status: LoopTickStatus;
  dryRun: boolean;
  searchCallsUsed: number;
  generalUnitsUsed: number;
  newCandidates: number;
  newShortlistedAuto: number;
  pendingReview: number;
  autoRejected: number;
  keywordsSearched: string[];
  keywordsHarvested: number;
  error: string | null;
  durationSec: number;
}

// ---------------------------------------------------------------------------
// Inbox (delivery.md §3)
// ---------------------------------------------------------------------------

export interface InboxItem {
  channelId: string;
  title: string | null;
  handle: string | null;
  url: string;
  /** ≤6 hqdefault thumbnail URLs (từ video mới nhất). */
  thumbnails: string[];
  subscriberCount: number | null;
  videoCount: number | null;
  country: string | null;
  publishedAt: string | null;
  /** Median view trên 12 video mới nhất. */
  medianViews: number | null;
  /** medianViews / median view của kênh baseline trong topic (null khi chưa tính). */
  medianViewsVsOwn: number | null;
  fitScore: number | null;
  fitReasons: unknown[];
  /** Verdict (agent vision). P0 luôn null — UI không được hiển thị như kết luận. */
  facelessScore: number | null;
  facelessSignals: FacelessSignal[];
  /** Phỏng đoán từ chữ, hiển thị kèm nhãn "đoán từ chữ". */
  facelessHint: number | null;
  facelessHintReasons: FacelessHintReason[];
  learnValueScore: number | null;
  learnValueReasons: LearnValueReason[];
  foundVia: {
    relation: TopicKeywordRelation | 'graph' | 'corpus_import' | 'seed_config' | 'manual_user';
    term: string | null;
    fromChannelId: string | null;
  };
  /** v13 CHECK: new | active | paused | rejected | own (không còn shortlisted/studied). */
  status: 'new' | 'active' | 'paused' | 'rejected' | 'own';
  decidedBy: 'user' | 'loop_auto' | null;
  decidedAt: string | null;
  firstSeenAt: string;
}

// ---------------------------------------------------------------------------
// Loop status (delivery.md §3)
// ---------------------------------------------------------------------------

export interface LoopTickBrief {
  tickId: string;
  quotaDay: string;
  status: LoopTickStatus;
  step: LoopTickStep;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface LoopStatus {
  topicId: string;
  topicLabel: string;
  topicStatus: 'active' | 'paused' | 'archived';
  /** v13: vị trí funnel setup của topic. */
  setupStatus?: TopicSetupStatus | string;
  lastTick: LoopTickBrief | null;
  /**
   * v3: tick gần nhất THEO NHỊP — scheduler daily/weekly cần nhìn riêng từng
   * mode, vì lastTick đơn lẻ chỉ kể được tick mới nhất bất kể nhịp.
   */
  lastTickByMode?: Partial<Record<LoopMode, LoopTickBrief | null>>;
  nextTickAt: string | null;    // ISO — null khi topic paused
  inboxTotal: number;           // status=new
  /** v3: Follow List = kênh active (tên cũ shortlistedTotal/studiedTotal). */
  activeTotal: number;
  pausedTotal: number;
  keywordsPending: number;
  /**
   * Quota TOÀN NGÀY — cả năm trường cùng một namespace (sổ global của quota-day).
   * Số của riêng tick nằm ở `tick.searchCallsUsed` / `tick.generalUnitsUsed`.
   * Đừng trộn hai phạm vi: chúng trông giống nhau và lệch nhau âm thầm.
   */
  quota: {
    searchUsed: number;
    searchBudget: number;
    searchRemainingDay: number;
    generalUsed: number;
    generalLimit: number;
  };
}

// ---------------------------------------------------------------------------
// Report (delivery.md §5)
// ---------------------------------------------------------------------------

export interface TopLearnEntry {
  channelId: string;
  title: string | null;
  url: string;
  subscriberCount: number | null;
  ageMonths: number | null;
  medianViews: number | null;
  medianViewsVsOwn: number | null;
  ownChannelTitle: string | null;
  /** Verdict (agent vision). P0 luôn null. */
  facelessScore: number | null;
  /** Phỏng đoán từ chữ — render phải kèm nhãn "đoán từ chữ", không được đọc là verdict. */
  facelessHint: number | null;
  fitScore: number | null;
  learnValueScore: number | null;
  foundVia: string;
  status: string;
  decidedBy: string | null;
  why: string[];
}

export interface ReportDelta {
  vsReportId: string | null;
  vsDate: string | null;
  newCandidatesPrev: number | null;
  inboxTotalPrev: number | null;
  /** v3: active/paused (tên cũ shortlistedTotalPrev/studiedTotalPrev). */
  activeTotalPrev: number | null;
  pausedTotalPrev: number | null;
  keywordsPendingPrev: number | null;
  firstSeenToday: string[];
  /** v3: kênh được duyệt sang active (tên cũ movedToShortlistToday). */
  movedToActiveToday: string[];
  /** v3: số quyết định 'active' của người (tên cũ .shortlisted). */
  userDecisionsSinceLast: { active: number; rejected: number };
  /** v3: keyword vừa bị paused (tên cũ newlyExhausted). */
  newlyPaused: string[];
}

/** Số liệu riêng của từng nhịp trong daily_reports.summary_json. */
export interface DailyReportSection {
  newVideos: number;
  channelsScanned: number;
  channelsChecked: number;
  topGained24h: Array<{ videoId: string; title: string; channelTitle: string; viewsGained24h: number; views: number | null }>;
  topOutliers: Array<{ videoId: string; title: string; channelTitle: string; outlierScore: number; views: number | null }>;
  suggestions: Array<{ channelId: string; title: string | null; suggestion: string }>;
}

export interface WeeklyReportSection {
  keywordsSearched: Array<{ termKey: string; term: string; nResults: number; nFollowed: number; medianViews: number | null }>;
  outliersInFollow: Array<{ videoId: string; title: string; channelTitle: string; outlierScore: number }>;
  newChannelsProposed: Array<{ channelId: string; title: string | null; outlierScore: number | null; baselineMedianViews: number | null; foundByKeyword: string }>;
  channelsRejectedLang: number;
  channelsFilteredDeadLottery: number;
  newKeywords: Array<{ termKey: string; display: string; nVideos: number }>;
}

export interface SetupReportSection {
  step: SetupStep;
  /** S2: kênh đề xuất / loại ngôn ngữ / lọc dead-lottery; S3: keyword đề xuất. */
  channelsProposed: number;
  channelsRejectedLang: number;
  channelsFilteredDeadLottery: number;
  keywordsProposed: number;
  /** 'awaiting_channels' | 'awaiting_keywords' — điểm dừng chờ người. */
  awaitingStatus: TopicSetupStatus;
}

export interface ReportSummaryJson {
  version: 1;
  reportId: string;
  reportDate: string;
  topicId: string | null;
  topicLabel: string;
  /** v3: nhịp sinh ra report — daily | weekly | setup. */
  mode?: LoopMode;
  daily?: DailyReportSection;
  weekly?: WeeklyReportSection;
  setup?: SetupReportSection;
  tick: {
    tickId: string;
    status: LoopTickStatus;
    startedAt: string;
    finishedAt: string | null;
    durationSec: number;
    error: string | null;
    dryRun: boolean;
    /** Quota bị charge cho RIÊNG tick này (khối `quota` là của cả ngày). */
    searchCallsUsed: number;
    generalUnitsUsed: number;
  } | null;
  quota: {
    searchUsed: number;
    searchBudget: number;
    searchRemainingDay: number;
    generalUsed: number;
    generalLimit: number;
  };
  funnel: {
    expanded: number;
    searched: number;
    newCandidates: number;
    autoShortlisted: number;
    pendingReview: number;
    autoRejected: number;
    scanned: number;
    keywordsHarvested: number;
  };
  inboxTotal: number;
  topLearn: TopLearnEntry[];
  newKeywords: string[];
  /** v3: keyword đang paused (tên cũ exhaustedKeywords — web đọc fallback). */
  pausedKeywords: Array<{ term: string; rejectRate: number; yieldChannels: number }>;
  scannedChannels: Array<{ channelId: string; title: string | null; spyRunId: string | null; topTitlePattern: string | null; outliers: string[] }>;
  delta: ReportDelta;
  warnings: string[];
  links: {
    dashboard: string;
    mcpTool: string;
  };
}

// ---------------------------------------------------------------------------
// Faceless — PHỎNG ĐOÁN (P0) vs VERDICT (vòng agent vision, chưa implement)
//
// Hai thứ tách bạch, không được lẫn (§3):
//   faceless_hint  — regex trên chữ, sai lệch cao, CHỈ để sắp Inbox.
//                    KHÔNG BAO GIỜ dùng để auto-reject hay khoe như kết luận.
//   faceless_score — verdict của agent vision, có evidence ref. P0 luôn NULL.
// ---------------------------------------------------------------------------

/** Loại tín hiệu văn bản trong `scoreFacelessHint`. */
export type FacelessHintReasonKind =
  | 'keyword'
  | 'boilerplate'
  | 'deixis'
  | 'name_brand'
  | 'synthetic_presenter';

export interface FacelessHintReason {
  kind: FacelessHintReasonKind;
  /** Tên field đã khớp, vd 'host_titles' | 'description'. */
  ref: string;
  value: number;
  weight: number;
}

export interface FacelessHintResult {
  /**
   * 0..1 — >0.5 nghiêng faceless, <0.5 nghiêng có host, null khi mẫu quá mỏng.
   * Là PHỎNG ĐOÁN, không phải verdict.
   */
  hint: number | null;
  reasons: FacelessHintReason[];
  method: 'text_only' | 'insufficient_sample';
}

/** Tín hiệu kèm VERDICT (agent vision). P0 không sinh ra giá trị nào loại này. */
export type FacelessSignalKind = 'face' | 'no_face' | 'keyword' | 'boilerplate' | 'deixis' | 'name_brand' | 'template_thumbnails' | 'synthetic_presenter';

export interface FacelessSignal {
  kind: FacelessSignalKind;
  /** videoId hoặc tên field. */
  ref: string;
  value: number;
  weight: number;
}

// ---------------------------------------------------------------------------
// Seam cho agent vision — KHAI BÁO ONLY, không implement ở P0 (§3).
// Khi vòng thiết kế vision xong, chỉ cần implement port này rồi truyền vào
// `new LoopRunner({ facelessJudge })` — không phải sửa runner, schema hay UI.
// ---------------------------------------------------------------------------

export interface FacelessVerdictInput {
  channelId: string;
  thumbnailUrls: string[];
  videoTitles: string[];
  transcriptExcerpt?: string;
}

export interface FacelessVerdict {
  score: number;
  label: string;
  evidence: Array<{ ref: string; note: string }>;
}

export interface FacelessVerdictPort {
  judge(input: FacelessVerdictInput): Promise<FacelessVerdict>;
}

// ---------------------------------------------------------------------------
// Learn value scorer
// ---------------------------------------------------------------------------

export interface LearnValueReason {
  factor: string;
  points: number;
  max: number;
  detail: string;
  method: string;
  sampleSize: number | null;
}

export interface LearnValueResult {
  score: number | null;
  reasons: LearnValueReason[];
  /** 'deterministic' | 'insufficient_sample' */
  method: string;
  sampleSize: number | null;
}
