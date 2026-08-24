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
  status: 'active' | 'paused' | 'archived';
  ownChannelIdsJson: string;   // JSON array
  briefMd: string;
  facelessRequired: boolean;
  dailySearchBudget: number;
  createdAt: string;
  updatedAt: string;
}

export type TopicKeywordRelation =
  | 'seed'
  | 'harvested_title'
  | 'harvested_tag'
  | 'comment_mined'
  | 'graph'
  | 'yt_suggest'
  | 'llm_expand';

export type TopicKeywordStatus = 'pending' | 'searched' | 'exhausted' | 'rejected';

export interface TopicKeywordRow {
  topicId: string;
  termKey: string;           // unaccented lowercase
  displayTerm: string;
  relation: TopicKeywordRelation;
  evidenceJson: string;      // {df_chan, df_vid, sample_videos[:5]} | {vendor, as_of, credit_cost}
  status: TopicKeywordStatus;
  yieldChannels: number;
  lastSearchedAt: string | null;
  addedAt: string;
  addedBy: 'user' | 'loop' | 'agent';
}

export interface TopicChannelRow {
  topicId: string;
  channelId: string;
  fitScore: number | null;
  fitReasonsJson: string;        // FitReason[]
  /** Verdict thật (agent vision). P0 LUÔN null. */
  facelessScore: number | null;
  facelessSignalsJson: string;   // FacelessSignal[]
  /** Phỏng đoán text-only 0..1 — không phải verdict, không dùng để reject. */
  facelessHint: number | null;
  facelessHintReasonsJson: string;  // FacelessHintReason[]
  /** JSON string[] — ≤6 hqdefault URL cho lưới review Inbox. */
  thumbnailsJson: string | null;
  styleMatchScore: number | null;
  styleNotes: string | null;
  learnValueScore: number | null;
  /** JSON {method, sampleSize, reasons: LearnValueReason[]}. */
  learnValueReasonsJson: string | null;
  status: 'new' | 'shortlisted' | 'studied' | 'rejected' | 'own';
  decidedBy: 'user' | 'loop_auto' | null;
  decidedAt: string | null;
  /** 'lang_mismatch' | 'low_fit' | 'fit_learn_auto' | null (user quyết). */
  decidedReason: string | null;
  spyRunId: string | null;
  langDetected: string | null;
  langConfidence: number | null;
  /** JSON {method, evidenceField, majority, declaredCount, sampleSize}. */
  langEvidenceJson: string | null;
  firstSeenAt: string;
  lastScoredAt: string | null;
}

export type LoopTickStatus = 'running' | 'done' | 'failed' | 'skipped_quota';
export type LoopTickStep = 'expand' | 'search' | 'enrich' | 'triage' | 'scan' | 'harvest' | 'report';

export interface LoopTickRow {
  tickId: string;
  topicId: string;
  quotaDay: string;             // YYYY-MM-DD Pacific
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
  status: 'new' | 'shortlisted' | 'studied' | 'rejected' | 'own';
  decidedBy: 'user' | 'loop_auto' | null;
  decidedAt: string | null;
  firstSeenAt: string;
}

// ---------------------------------------------------------------------------
// Loop status (delivery.md §3)
// ---------------------------------------------------------------------------

export interface LoopStatus {
  topicId: string;
  topicLabel: string;
  topicStatus: 'active' | 'paused' | 'archived';
  lastTick: {
    tickId: string;
    quotaDay: string;
    status: LoopTickStatus;
    step: LoopTickStep;
    startedAt: string;
    finishedAt: string | null;
    error: string | null;
  } | null;
  nextTickAt: string | null;    // ISO — null khi topic paused
  inboxTotal: number;           // status=new
  shortlistedTotal: number;
  studiedTotal: number;
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
  shortlistedTotalPrev: number | null;
  studiedTotalPrev: number | null;
  keywordsPendingPrev: number | null;
  firstSeenToday: string[];
  movedToShortlistToday: string[];
  userDecisionsSinceLast: { shortlisted: number; rejected: number };
  newlyExhausted: string[];
}

export interface ReportSummaryJson {
  version: 1;
  reportId: string;
  reportDate: string;
  topicId: string | null;
  topicLabel: string;
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
  exhaustedKeywords: Array<{ term: string; rejectRate: number; yieldChannels: number }>;
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
