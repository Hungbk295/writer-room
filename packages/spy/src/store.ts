import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import { AppError } from './errors.ts';
import type {
  ArtifactRef,
  ChannelRecord,
  FrameSample,
  Operation,
  OperationKind,
  OperationStatus,
  SpyRun,
  TranscriptSegment,
  VideoSnapshot,
  VideoTranscript,
} from './schema.ts';
import type {
  PublicCompetitorRecord,
  PublicObservationCompleteness,
  PublicObservationPlanKind,
  PublicObservationRun,
  PublicObservationStatus,
  PublicVideoAvailability,
  PublicVideoStatPoint,
  PublicViewQuality,
  PublicWatchCadence,
  PublicWatchStatus,
  SavedChannelRecord,
} from './channel-intelligence/types.ts';

// v10 -> v11: video_comments is a wholly new table, created by SCHEMA_SQL's
// own `IF NOT EXISTS` for both fresh and pre-existing databases — same as
// the v2->v4 additions noted below, no ALTER/backfill required. Bumping the
// version here is bookkeeping only.
// v11 -> v12: api_quota_usage_per_key for multi-key rotation. New table,
// IF NOT EXISTS — no ALTER required.
// v12 -> v13: Spy Pipeline v3 Lean (docs/plans/spy-research-pipeline-v3-lean.html §4).
// Đổi CHECK status của topic_keywords/topic_channels + UNIQUE của loop_ticks/
// daily_reports ⇒ rebuild bảng trong migrate12To13() (transaction). 3 bảng mới
// topic_videos, video_daily_views, decisions đã có IF NOT EXISTS ở dưới.
export const SCHEMA_VERSION = 13;

export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  owner_subject TEXT NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT,
  progress INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  step TEXT NOT NULL DEFAULT 'queued',
  result_ref TEXT,
  error_code TEXT,
  error_message TEXT,
  request_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  UNIQUE(owner_subject, kind, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_operations_status_created
  ON operations(status, created_at);

CREATE TABLE IF NOT EXISTS spy_runs (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id),
  kind TEXT NOT NULL CHECK(kind IN ('video', 'channel')),
  canonical_source TEXT NOT NULL,
  source_identity TEXT NOT NULL,
  config_json TEXT NOT NULL,
  status TEXT NOT NULL,
  scan_limit INTEGER,
  top_n INTEGER,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_spy_runs_source
  ON spy_runs(source_identity, created_at);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL UNIQUE,
  youtube_uc_id TEXT,
  handle TEXT,
  title TEXT NOT NULL,
  subscriber_count INTEGER,
  video_count INTEGER,
  total_view_count INTEGER,
  fetched_at TEXT NOT NULL
);

-- v10: channel_id is the real FK video_snapshots always lacked. Before it
-- existed, corpusChannelStats()/searchCorpusVideos() had to guess a video's
-- channel from "which spy_run produced its newest row" (ROW_NUMBER by
-- created_at across ALL runs) — a lone spy_video_start run 94s after a
-- channel scan would become that video's "newest" row and silently pull it
-- out of its channel's cluster (real incident: Hidden Yield's channel
-- average came back 3,668 instead of correctly including its 380,079-view
-- video). NULL means "not attributed to a channel" — a channel scan or a
-- video-level run with a resolved channel sets it; anything else (including
-- an unresolved video-level run) leaves it NULL on purpose, and NULL rows
-- are excluded from channel-cluster aggregation, never merged into one by
-- guesswork.
CREATE TABLE IF NOT EXISTS video_snapshots (
  id TEXT PRIMARY KEY,
  spy_run_id TEXT NOT NULL REFERENCES spy_runs(id),
  source_video_id TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  title TEXT NOT NULL,
  channel_title TEXT NOT NULL DEFAULT '',
  channel_id TEXT REFERENCES channels(id),
  rank INTEGER NOT NULL,
  view_count INTEGER NOT NULL,
  like_count INTEGER,
  comment_count INTEGER,
  duration_sec REAL NOT NULL,
  published_at TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  transcript_status TEXT NOT NULL,
  transcript_source TEXT,
  frame_status TEXT NOT NULL,
  thumbnail_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(spy_run_id, source_video_id)
);
CREATE INDEX IF NOT EXISTS idx_video_snapshots_run_rank
  ON video_snapshots(spy_run_id, rank);
CREATE INDEX IF NOT EXISTS idx_video_snapshots_source
  ON video_snapshots(source_video_id);

CREATE TABLE IF NOT EXISTS video_transcripts (
  id TEXT PRIMARY KEY,
  source_video_id TEXT NOT NULL,
  language TEXT NOT NULL,
  source TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  normalized_text TEXT,
  normalized_at TEXT,
  normalize_model TEXT,
  UNIQUE(source_video_id, language, source)
);
CREATE INDEX IF NOT EXISTS idx_video_transcripts_source
  ON video_transcripts(source_video_id);

CREATE TABLE IF NOT EXISTS transcript_segments (
  id TEXT PRIMARY KEY,
  video_snapshot_id TEXT NOT NULL REFERENCES video_snapshots(id),
  video_transcript_id TEXT,
  segment_index INTEGER NOT NULL,
  start_sec REAL NOT NULL,
  end_sec REAL NOT NULL,
  text TEXT NOT NULL,
  source TEXT NOT NULL,
  language TEXT,
  content_hash TEXT NOT NULL,
  UNIQUE(video_snapshot_id, segment_index)
);
CREATE INDEX IF NOT EXISTS idx_transcript_segments_video
  ON transcript_segments(video_snapshot_id, segment_index);

-- v11: spy_video_comments was wired up (mcp-tools.ts + spy-mcp.ts) but never
-- had anywhere to write — the tool fetched commentThreads.list and threw the
-- result away, leaving comment_count on video_snapshots as a bare number with
-- no underlying text. This is the only source with the audience's own words;
-- everything else in the corpus is the creator's script. id is the YouTube
-- commentId itself (top-level thread comment or reply — both are globally
-- unique), which is what makes a re-fetch of the same video idempotent via
-- INSERT OR REPLACE rather than accumulating duplicates.
-- channel_id is nullable and, like video_snapshots.channel_id, is set ONLY
-- when the caller's scope already resolves to a known channels row — never
-- guessed from title or spy_run — so an unattributed comment can be excluded
-- from channel-level aggregation instead of silently joined into the wrong
-- one (see the video_snapshots.channel_id comment above for the incident
-- that rule exists to prevent).
CREATE TABLE IF NOT EXISTS video_comments (
  id TEXT PRIMARY KEY,
  source_video_id TEXT NOT NULL,
  channel_id TEXT REFERENCES channels(id),
  parent_comment_id TEXT,
  author_display_name TEXT,
  text TEXT NOT NULL,
  like_count INTEGER,
  published_at TEXT,
  updated_at TEXT,
  fetched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_video_comments_video
  ON video_comments(source_video_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_video_comments_channel
  ON video_comments(channel_id);

CREATE TABLE IF NOT EXISTS frame_samples (
  id TEXT PRIMARY KEY,
  video_snapshot_id TEXT NOT NULL REFERENCES video_snapshots(id),
  frame_index INTEGER NOT NULL,
  timestamp_sec REAL NOT NULL,
  dhash TEXT NOT NULL,
  artifact_json TEXT NOT NULL,
  UNIQUE(video_snapshot_id, frame_index)
);
CREATE INDEX IF NOT EXISTS idx_frame_samples_video
  ON frame_samples(video_snapshot_id, frame_index);

CREATE TABLE IF NOT EXISTS metrics (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  spy_run_id TEXT NOT NULL REFERENCES spy_runs(id),
  payload_json TEXT NOT NULL,
  computed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_metrics_scope
  ON metrics(scope, scope_id, computed_at);

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  spy_run_id TEXT NOT NULL REFERENCES spy_runs(id),
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  model TEXT,
  computed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_profiles_scope
  ON profiles(scope, scope_id, kind, computed_at);

-- v4: sổ quota Data API. Hai bucket độc lập theo tài liệu Google 01/06/2026:
--   search  → trần 100 call/ngày (search.list có bucket riêng)
--   general → 10.000 unit/ngày cho mọi endpoint còn lại
-- quota_day là ngày theo America/Los_Angeles (giờ reset của Google Cloud quota).
CREATE TABLE IF NOT EXISTS api_quota_usage (
  bucket TEXT NOT NULL,
  quota_day TEXT NOT NULL,
  units INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (bucket, quota_day)
);

-- v12: per-key quota tracking for multi-key rotation.
-- key_id là last4 của API key (ẩn danh, đủ để phân biệt).
-- Mỗi key có 100 search call/ngày và 10.000 general unit/ngày riêng.
-- Bảng aggregate (api_quota_usage) vẫn giữ tổng cho backward compat.
CREATE TABLE IF NOT EXISTS api_quota_usage_per_key (
  key_id TEXT NOT NULL,
  bucket TEXT NOT NULL,
  quota_day TEXT NOT NULL,
  units INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (key_id, bucket, quota_day)
);

-- v4: kênh ứng viên phát hiện qua search hoặc mở rộng đồ thị, chưa quét sâu.
CREATE TABLE IF NOT EXISTS candidate_channels (
  channel_id TEXT PRIMARY KEY,
  title TEXT,
  handle TEXT,
  market TEXT,
  discovered_via TEXT NOT NULL,
  discovered_from TEXT,
  subscriber_count INTEGER,
  video_count INTEGER,
  view_count INTEGER,
  country TEXT,
  published_at TEXT,
  description TEXT,
  fit_score REAL,
  fit_reasons_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'new',
  first_seen_at TEXT NOT NULL,
  refreshed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_candidates_status_fit
  ON candidate_channels(status, fit_score DESC);
CREATE INDEX IF NOT EXISTS idx_candidates_market
  ON candidate_channels(market, fit_score DESC);

-- v3: danh sách kênh đối thủ theo dõi thủ công (không cần OAuth).
CREATE TABLE IF NOT EXISTS competitors (
  id TEXT PRIMARY KEY,
  owner_channel_id TEXT NOT NULL,
  competitor_channel_id TEXT NOT NULL,
  note TEXT,
  watch_status TEXT NOT NULL DEFAULT 'followed' CHECK(watch_status IN ('followed','paused')),
  cadence TEXT NOT NULL DEFAULT 'daily' CHECK(cadence IN ('daily','manual')),
  last_observed_at TEXT,
  last_observation_status TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(owner_channel_id, competitor_channel_id)
);
CREATE INDEX IF NOT EXISTS idx_competitors_owner
  ON competitors(owner_channel_id, created_at);

-- v7 saved_channels is created by the explicit migration below. It is deliberately
-- independent from competitors: starring never creates a watch relation or a
-- provider operation.
CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
  text,
  content='transcript_segments',
  content_rowid='rowid'
);

-- v5: Auto-Loop — topic layer + loop tick + daily report tables

CREATE TABLE IF NOT EXISTS topics (
  topic_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  market TEXT NOT NULL,
  language TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','archived')),
  own_channel_ids_json TEXT NOT NULL DEFAULT '[]',
  brief_md TEXT NOT NULL DEFAULT '',
  faceless_required INTEGER NOT NULL DEFAULT 1,
  daily_search_budget INTEGER NOT NULL DEFAULT 20,
  -- v13 §4.1: region = thị trường search (US, VN) — tách khỏi language.
  region TEXT,
  -- v13 §3: ngưỡng riêng của topic, merge lên DEFAULT_TOPIC_SETTINGS khi đọc.
  settings_json TEXT NOT NULL DEFAULT '{}',
  -- v13 §2: topic đang kẹt ở điểm dừng HITL nào của setup.
  setup_status TEXT NOT NULL DEFAULT 'none'
    CHECK(setup_status IN ('none','awaiting_channels','awaiting_keywords','done')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS topic_keywords (
  topic_id TEXT NOT NULL,
  term_key TEXT NOT NULL,
  display_term TEXT NOT NULL,
  relation TEXT NOT NULL DEFAULT '',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  -- v13 §4.2 = Keyword List: pending → active|paused|rejected (searched→active,
  -- exhausted→paused ở migration). Loop chỉ được ghi 'pending'; active/paused/
  -- rejected đi qua endpoint duyệt với actor='human' (tôn chỉ 1).
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','paused','rejected')),
  -- v13 §4.2: keyword phải có origin dữ liệu thật (L1). NULL = chưa chứng minh
  -- được nguồn (dữ liệu migrate từ enum cũ).
  origin TEXT CHECK(origin IS NULL OR origin IN ('seed','title_ngram','outlier_title','user')),
  yield_channels INTEGER NOT NULL DEFAULT 0,
  last_searched_at TEXT,
  -- v13 §4.2: sức khoẻ sau lần search gần nhất (W1) — bao nhiêu kết quả, bao
  -- nhiêu từ kênh follow, view trung vị.
  last_checked_at TEXT,
  last_n_results INTEGER,
  last_n_followed INTEGER,
  last_median_views REAL,
  decided_at TEXT,
  decided_reason TEXT,
  added_at TEXT NOT NULL,
  added_by TEXT NOT NULL DEFAULT 'user' CHECK(added_by IN ('user','loop','agent')),
  PRIMARY KEY (topic_id, term_key)
);
CREATE INDEX IF NOT EXISTS idx_topic_keywords_status
  ON topic_keywords(topic_id, status, yield_channels DESC);

CREATE TABLE IF NOT EXISTS topic_channel_sources (
  topic_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  term_key TEXT,
  from_channel_id TEXT,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (topic_id, channel_id, relation)
);

CREATE TABLE IF NOT EXISTS topic_channels (
  topic_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  fit_score REAL,
  fit_reasons_json TEXT NOT NULL DEFAULT '[]',
  -- Verdict thật (agent vision, chưa có ở P0) — LUÔN NULL cho tới khi
  -- FacelessVerdictPort được implement.
  faceless_score REAL,
  faceless_signals_json TEXT NOT NULL DEFAULT '[]',
  -- Phỏng đoán text-only (§3). KHÔNG được dùng để reject kênh.
  faceless_hint REAL,
  faceless_hint_reasons_json TEXT,
  -- ≤6 hqdefault URL từ video mới nhất — Inbox review bằng mắt (§5.1). Không có
  -- cái này thì người duyệt chỉ thấy tên kênh, và duyệt bằng tên là duyệt mù.
  thumbnails_json TEXT,
  style_match_score REAL,
  style_notes TEXT,
  learn_value_score REAL,
  -- LearnValueReason[] — §7 bắt buộc mọi điểm số phải kèm reasons + method.
  learn_value_reasons_json TEXT,
  -- v13 §4.3 = Follow List: new → active|paused|rejected|own (studied→active,
  -- shortlisted→new/active ở migration). Loop chỉ ghi 'new' hoặc rejected
  -- (duy nhất lang_mismatch); còn lại qua endpoint duyệt actor='human'.
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','active','paused','rejected','own')),
  decided_by TEXT CHECK(decided_by IN ('user','loop_auto')),
  decided_at TEXT,
  -- Lý do máy đọc được: 'lang_mismatch' | 'low_fit' | 'fit_learn_auto' | NULL (user).
  decided_reason TEXT,
  spy_run_id TEXT,
  lang_detected TEXT,
  lang_confidence REAL,
  -- Bằng chứng cho quyết định ngôn ngữ: {method, evidenceField, majority,
  -- declaredCount, sampleSize}. Reject phải nói được nó dựa vào field NÀO.
  lang_evidence_json TEXT,
  -- v13 §4.3: denormalize để inbox/dashboard đọc mà không cần join.
  title TEXT,
  handle TEXT,
  subscriber_count INTEGER,
  -- v13 §4.3: kênh đến từ đường nào, keyword/thực thể nào (provenance gọn —
  -- lịch sử đầy đủ vẫn ở topic_channel_sources).
  discovered_via TEXT,
  discovered_from TEXT,
  -- v13 §4.3: baseline cuốn chiếu — median view của N video dài gần nhất,
  -- thay cho regime/Pettitt đã cắt. baseline_n < baseline_min_n ⇒ chưa tin cậy.
  baseline_median_views REAL,
  baseline_n INTEGER,
  max_views INTEGER,
  baseline_at TEXT,
  last_published_at TEXT,
  last_checked_at TEXT,
  -- v13 §4.3 + tôn chỉ 1: máy chỉ GỢI Ý (vd 'pause_silent'), không tự đổi status.
  suggestion TEXT,
  suggestion_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_scored_at TEXT,
  PRIMARY KEY (topic_id, channel_id)
);
CREATE INDEX IF NOT EXISTS idx_topic_channels_status_fit
  ON topic_channels(topic_id, status, fit_score DESC);

CREATE TABLE IF NOT EXISTS loop_ticks (
  tick_id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL,
  quota_day TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','done','failed','skipped_quota')),
  step TEXT NOT NULL DEFAULT 'expand',
  search_calls_used INTEGER NOT NULL DEFAULT 0,
  general_units_used INTEGER NOT NULL DEFAULT 0,
  -- Mốc sổ quota lúc tick BẮT ĐẦU. Số đã tiêu của tick = sổ hiện tại trừ mốc này,
  -- nên nó đúng cả khi request lỗi (decorator đã charge) và khi resume (mốc gốc
  -- được giữ nguyên, phần tiêu trước khi chết vẫn được tính).
  search_baseline_calls INTEGER NOT NULL DEFAULT 0,
  general_baseline_units INTEGER NOT NULL DEFAULT 0,
  keywords_searched_json TEXT NOT NULL DEFAULT '[]',
  new_candidates INTEGER NOT NULL DEFAULT 0,
  new_shortlisted_auto INTEGER NOT NULL DEFAULT 0,
  scanned_channels INTEGER NOT NULL DEFAULT 0,
  keywords_harvested INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  -- v13 §4.4: 3 nhịp chạy trên cùng một sổ tick — một topic có thể có tick
  -- daily VÀ weekly trong cùng một quota_day.
  mode TEXT NOT NULL DEFAULT 'daily' CHECK(mode IN ('setup','daily','weekly')),
  UNIQUE(topic_id, quota_day, mode)
);

CREATE TABLE IF NOT EXISTS daily_reports (
  report_id TEXT PRIMARY KEY,
  report_date TEXT NOT NULL,
  topic_id TEXT,
  summary_json TEXT NOT NULL,
  markdown TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  delivered_json TEXT NOT NULL DEFAULT '{}',
  -- v13 §4.4: báo cáo ngày và báo cáo tuần (W5) chung một sổ.
  mode TEXT NOT NULL DEFAULT 'daily' CHECK(mode IN ('setup','daily','weekly'))
);
CREATE INDEX IF NOT EXISTS idx_daily_reports_topic_date
  ON daily_reports(topic_id, report_date DESC);
-- Một topic chỉ có ĐÚNG một report mỗi (ngày, mode). COALESCE vì SQLite coi các
-- NULL là khác nhau trong UNIQUE, mà topic_id NULL = báo cáo tổng cũng chỉ được có một.
CREATE UNIQUE INDEX IF NOT EXISTS uq_daily_reports_topic_date
  ON daily_reports(COALESCE(topic_id, ''), report_date, mode);

-- v6: Corpus Intelligence P0. These tables are intentionally separate from
-- Auto-Loop candidate/topic/inbox tables: a draft evidence item must never
-- become a competitor candidate merely because it was observed.
CREATE TABLE IF NOT EXISTS p0_corpus_import_batches (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(topic_id),
  owner_subject TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','confirmed','rejected')),
  created_at TEXT NOT NULL,
  decided_at TEXT,
  UNIQUE(owner_subject, topic_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_p0_import_batches_topic ON p0_corpus_import_batches(topic_id, created_at DESC);

CREATE TABLE IF NOT EXISTS p0_corpus_import_items (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES p0_corpus_import_batches(id),
  submitted_url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  source_video_id TEXT NOT NULL,
  identity_status TEXT NOT NULL CHECK(identity_status IN ('verified','needs_identity')),
  evidence_artifact_json TEXT NOT NULL,
  evidence_digest TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','confirmed','rejected')),
  promoted_membership_id TEXT,
  UNIQUE(batch_id, source_video_id)
);
CREATE INDEX IF NOT EXISTS idx_p0_import_items_batch ON p0_corpus_import_items(batch_id, status);

CREATE TABLE IF NOT EXISTS p0_corpus_memberships (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(topic_id),
  entity_kind TEXT NOT NULL CHECK(entity_kind IN ('video')),
  canonical_url TEXT NOT NULL,
  source_video_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('confirmed','expired')),
  identity_status TEXT NOT NULL CHECK(identity_status IN ('verified','needs_identity')),
  created_from_kind TEXT NOT NULL CHECK(created_from_kind IN ('corpus_import','recommendation')),
  created_from_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  UNIQUE(topic_id, entity_kind, source_video_id)
);
CREATE INDEX IF NOT EXISTS idx_p0_memberships_topic_status ON p0_corpus_memberships(topic_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS p0_recommendation_capture_batches (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(topic_id),
  seed_membership_id TEXT NOT NULL REFERENCES p0_corpus_memberships(id),
  from_video_id TEXT NOT NULL,
  seed_canonical_url TEXT NOT NULL,
  owner_subject TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  requested_depth INTEGER NOT NULL CHECK(requested_depth = 1),
  requested_limit INTEGER NOT NULL CHECK(requested_limit BETWEEN 1 AND 20),
  capture_method TEXT,
  adapter_version TEXT,
  capture_artifact_json TEXT,
  capture_digest TEXT,
  captured_at TEXT,
  expires_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('capturing','draft','failed','expired')),
  failure_code TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(owner_subject, topic_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_p0_recommendation_batches_seed
  ON p0_recommendation_capture_batches(topic_id, seed_membership_id, created_at DESC);

CREATE TABLE IF NOT EXISTS p0_recommendation_observations (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES p0_recommendation_capture_batches(id),
  seed_membership_id TEXT NOT NULL REFERENCES p0_corpus_memberships(id),
  from_video_id TEXT NOT NULL,
  target_video_id TEXT NOT NULL,
  target_canonical_url TEXT NOT NULL,
  target_title TEXT,
  target_channel_id TEXT,
  target_channel_title TEXT,
  target_identity_status TEXT NOT NULL CHECK(target_identity_status IN ('verified','needs_identity')),
  observed_position INTEGER NOT NULL CHECK(observed_position >= 1),
  capture_artifact_digest TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','confirmed','rejected','expired')),
  promoted_membership_id TEXT,
  decided_by TEXT,
  decided_at TEXT,
  UNIQUE(batch_id, target_video_id)
);
CREATE INDEX IF NOT EXISTS idx_p0_recommendation_observations_batch
  ON p0_recommendation_observations(batch_id, status, observed_position);

CREATE TABLE IF NOT EXISTS p0_evidence_records (
  id TEXT PRIMARY KEY,
  membership_id TEXT NOT NULL REFERENCES p0_corpus_memberships(id),
  kind TEXT NOT NULL CHECK(kind IN ('metadata','transcript','thumbnail')),
  status TEXT NOT NULL CHECK(status IN ('available','unavailable','failed','expired')),
  method TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  artifact_json TEXT,
  artifact_digest TEXT,
  observed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(membership_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_p0_evidence_membership ON p0_evidence_records(membership_id, kind);

CREATE TABLE IF NOT EXISTS p0_semantic_analysis_runs (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(topic_id),
  membership_id TEXT NOT NULL REFERENCES p0_corpus_memberships(id),
  owner_subject TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  input_manifest_json TEXT NOT NULL,
  input_manifest_digest TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed','expired')),
  result_json TEXT,
  raw_response_artifact_json TEXT,
  raw_response_digest TEXT,
  failure_code TEXT,
  failure_reason TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  expires_at TEXT NOT NULL,
  UNIQUE(owner_subject, topic_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_p0_analysis_membership ON p0_semantic_analysis_runs(membership_id, created_at DESC);

CREATE TABLE IF NOT EXISTS p0_loop_controls (
  topic_id TEXT PRIMARY KEY REFERENCES topics(topic_id),
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS p0_loop_runs (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(topic_id),
  owner_subject TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed','blocked')),
  phase TEXT NOT NULL,
  resume_index INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(owner_subject, topic_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_p0_loop_runs_topic ON p0_loop_runs(topic_id, created_at DESC);

CREATE TABLE IF NOT EXISTS p0_reports (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(topic_id),
  loop_run_id TEXT NOT NULL UNIQUE REFERENCES p0_loop_runs(id),
  summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_p0_reports_topic ON p0_reports(topic_id, created_at DESC);

CREATE TABLE IF NOT EXISTS p0_artifact_tombstones (
  artifact_hash TEXT PRIMARY KEY,
  purged_at TEXT NOT NULL,
  reason TEXT NOT NULL
);

-- v9: spy_global_video_search cache. Deliberately separate from
-- video_snapshots/spy_runs, never joined into corpus aggregation.
--
-- corpusChannelStats() / searchCorpusVideos() below cluster every video into a
-- channel by "which spy_run produced its newest video_snapshots row"
-- (ROW_NUMBER PARTITION BY source_video_id ORDER BY created_at DESC). A search
-- hit that reused that table — even tagged with a search kind — would create
-- a fresh spy_run per search call and become each touched video's "newest"
-- row, silently pulling it out of its channel's cluster and corrupting that
-- channel's avg/max view stats. (Real incident: a lone spy_video_start on an
-- already-scanned video did exactly this — Hidden Yield's channel average
-- came back 3,668 instead of correctly including its 380,079-view video, a
-- 45x understatement.) These two tables exist so search can persist and be
-- read back without ever touching that clustering.
CREATE TABLE IF NOT EXISTS search_query_cache (
  id TEXT PRIMARY KEY,
  query_norm TEXT NOT NULL,
  language TEXT NOT NULL,
  region TEXT NOT NULL,
  provider_used TEXT NOT NULL CHECK(provider_used IN ('youtube_data_api','ytdlp')),
  limit_requested INTEGER NOT NULL,
  locale_hints_applied INTEGER NOT NULL,
  fallback_reason TEXT,
  video_ids_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  UNIQUE(query_norm, language, region, provider_used)
);

-- One row per video ever seen through global search, independent of which
-- query surfaced it. published_at_known distinguishes "provider told us
-- there is no date" from "this provider (yt-dlp fallback) never tells us
-- dates" — an unknown write must never clobber a previously known value.
CREATE TABLE IF NOT EXISTS search_video_cache (
  source_video_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  channel_title TEXT NOT NULL DEFAULT '',
  canonical_url TEXT NOT NULL,
  view_count INTEGER NOT NULL,
  duration_sec REAL NOT NULL,
  published_at TEXT,
  published_at_known INTEGER NOT NULL DEFAULT 0 CHECK(published_at_known IN (0,1)),
  provider_used TEXT NOT NULL CHECK(provider_used IN ('youtube_data_api','ytdlp')),
  fetched_at TEXT NOT NULL,
  first_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_search_video_cache_fetched
  ON search_video_cache(fetched_at);

-- ── v13: Spy Pipeline v3 Lean (plan §4.5) ───────────────────────────────────
-- Ba bảng mới duy nhất — không có bảng rs_* nào (tôn chỉ 2).

-- Mỗi video mà topic đang theo dõi (1 dòng / topic / video). Giá trị "latest_*"
-- là bản sao để dashboard đọc nhanh — lịch sử thật nằm ở video_daily_views.
CREATE TABLE IF NOT EXISTS topic_videos (
  topic_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  title TEXT NOT NULL,
  published_at TEXT,
  duration_sec REAL,
  thumbnail_url TEXT,
  source TEXT NOT NULL,            -- setup | daily_scan | weekly_search
  found_by_keyword TEXT,           -- term_key khi source=weekly_search
  first_seen_at TEXT NOT NULL,
  latest_views INTEGER, latest_likes INTEGER, latest_comments INTEGER, latest_at TEXT,
  views_gained_24h INTEGER,        -- NULL khi chưa có 2 snapshot (L6)
  outlier_score REAL,              -- latest_views / baseline_median; NULL khi baseline chưa tin cậy
  PRIMARY KEY (topic_id, video_id)
);
CREATE INDEX IF NOT EXISTS idx_topic_videos_channel
  ON topic_videos(topic_id, channel_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_topic_videos_outlier
  ON topic_videos(topic_id, outlier_score DESC);

-- Snapshot view, append-only, tối đa 1 dòng / video / ngày (INSERT OR IGNORE —
-- quét lại trong ngày không tạo thêm dòng).
CREATE TABLE IF NOT EXISTS video_daily_views (
  topic_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  day TEXT NOT NULL,               -- YYYY-MM-DD (quota_day)
  views INTEGER NOT NULL, likes INTEGER, comments INTEGER,
  captured_at TEXT NOT NULL,
  PRIMARY KEY (topic_id, video_id, day)
);

-- Nhật ký mọi đổi trạng thái kênh/keyword — bằng chứng cho tôn chỉ 1 (HITL):
-- mọi dòng to_status IN (active,rejected,paused) phải có actor='human';
-- actor='loop' chỉ được to_status IN (new,pending,rejected) và rejected chỉ
-- kèm reason='lang_mismatch'.
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL,
  at TEXT NOT NULL,
  actor TEXT NOT NULL CHECK(actor IN ('human','loop')),
  entity_type TEXT NOT NULL CHECK(entity_type IN ('channel','keyword')),
  entity_id TEXT NOT NULL,
  from_status TEXT, to_status TEXT NOT NULL,
  reason TEXT NOT NULL,
  tick_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_decisions_entity
  ON decisions(topic_id, entity_type, entity_id, at DESC);

-- §4 spy-dashboard-api: index đọc cho 16 endpoint /api/spy/dash/*.
CREATE INDEX IF NOT EXISTS idx_video_daily_views_day
  ON video_daily_views(topic_id, day);
CREATE INDEX IF NOT EXISTS idx_decisions_at
  ON decisions(topic_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_topic_videos_published
  ON topic_videos(topic_id, published_at DESC);
`;


const MIGRATION_1_TO_2 = `
CREATE TABLE IF NOT EXISTS video_transcripts (
  id TEXT PRIMARY KEY,
  source_video_id TEXT NOT NULL,
  language TEXT NOT NULL,
  source TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  normalized_text TEXT,
  normalized_at TEXT,
  normalize_model TEXT,
  UNIQUE(source_video_id, language, source)
);
CREATE INDEX IF NOT EXISTS idx_video_transcripts_source
  ON video_transcripts(source_video_id);
CREATE INDEX IF NOT EXISTS idx_video_snapshots_source
  ON video_snapshots(source_video_id);
`;

// v4 → v5: thêm uploads_playlist_id vào candidate_channels.
// Các bảng mới (topics, topic_keywords, …) đã có IF NOT EXISTS trong SCHEMA_SQL nên
// migration chỉ cần ALTER cột cũ.
const MIGRATION_4_TO_5 = `
ALTER TABLE candidate_channels ADD COLUMN uploads_playlist_id TEXT;
`;

/**
 * v6 -> v7 is intentionally explicit.  The v6 schema's IF NOT EXISTS DDL can
 * create the new objects for a fresh database, but it cannot alter an existing
 * v6 table.  The constructor below runs these additions in one transaction and
 * only advances schema_version after every change succeeds.
 */
const MIGRATION_6_TO_7 = {
  channelsYoutubeUcId: 'ALTER TABLE channels ADD COLUMN youtube_uc_id TEXT',
  channelsHandle: 'ALTER TABLE channels ADD COLUMN handle TEXT',
  competitorsWatchStatus: "ALTER TABLE competitors ADD COLUMN watch_status TEXT NOT NULL DEFAULT 'followed' CHECK(watch_status IN ('followed','paused'))",
  competitorsCadence: "ALTER TABLE competitors ADD COLUMN cadence TEXT NOT NULL DEFAULT 'daily' CHECK(cadence IN ('daily','manual'))",
  competitorsLastObservedAt: 'ALTER TABLE competitors ADD COLUMN last_observed_at TEXT',
  competitorsLastObservationStatus: 'ALTER TABLE competitors ADD COLUMN last_observation_status TEXT',
  savedChannels: `CREATE TABLE IF NOT EXISTS saved_channels (
    youtube_uc_id TEXT PRIMARY KEY,
    starred_at TEXT NOT NULL,
    note TEXT,
    updated_at TEXT NOT NULL
  )`,
  savedChannelsIndex: 'CREATE INDEX IF NOT EXISTS idx_saved_channels_updated ON saved_channels(updated_at DESC)',
  channelsAliasIndex: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_youtube_uc_id ON channels(youtube_uc_id) WHERE youtube_uc_id IS NOT NULL',
} as const;

/**
 * C3 stores raw public measurements at video grain.  A channel-level snapshot
 * cannot support VPH, so these facts are append-only and deliberately separate
 * from `video_snapshots` (which belongs to a disposable manual Spy run).
 */
const MIGRATION_7_TO_8 = `
CREATE TABLE IF NOT EXISTS competitor_observation_runs (
  id TEXT PRIMARY KEY,
  owner_channel_id TEXT NOT NULL,
  competitor_channel_id TEXT NOT NULL,
  plan_kind TEXT NOT NULL CHECK(plan_kind IN ('daily','manual')),
  plan_version TEXT NOT NULL,
  local_date TEXT NOT NULL,
  provider_used TEXT NOT NULL CHECK(provider_used='ytdlp'),
  status TEXT NOT NULL CHECK(status IN ('queued','running','completed','partial','failed','unavailable')),
  completeness TEXT NOT NULL CHECK(completeness IN ('complete','partial','unavailable')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error_code TEXT,
  error_message TEXT,
  playlist_limit INTEGER NOT NULL,
  inspect_attempted INTEGER NOT NULL DEFAULT 0,
  inspect_ok INTEGER NOT NULL DEFAULT 0,
  UNIQUE(owner_channel_id, competitor_channel_id, plan_kind, local_date, plan_version)
);
CREATE INDEX IF NOT EXISTS idx_competitor_observation_due
  ON competitor_observation_runs(owner_channel_id, competitor_channel_id, local_date DESC);

CREATE TABLE IF NOT EXISTS video_stat_points (
  id TEXT PRIMARY KEY,
  observation_run_id TEXT NOT NULL REFERENCES competitor_observation_runs(id),
  source_video_id TEXT NOT NULL,
  youtube_uc_id TEXT,
  sampled_at TEXT NOT NULL,
  view_count INTEGER,
  like_count INTEGER,
  comment_count INTEGER,
  duration_sec REAL,
  published_at TEXT,
  title TEXT,
  availability TEXT NOT NULL CHECK(availability IN ('present','missing','private','error')),
  view_quality TEXT NOT NULL CHECK(view_quality IN ('known','unknown','decreased_vs_prior')),
  provider_used TEXT NOT NULL CHECK(provider_used='ytdlp'),
  inspect_used INTEGER NOT NULL CHECK(inspect_used IN (0,1)),
  created_at TEXT NOT NULL,
  UNIQUE(observation_run_id, source_video_id)
);
CREATE INDEX IF NOT EXISTS idx_video_stat_points_video_time
  ON video_stat_points(source_video_id, sampled_at);
CREATE INDEX IF NOT EXISTS idx_video_stat_points_channel_time
  ON video_stat_points(youtube_uc_id, sampled_at DESC);
`;

/**
 * Cột thêm vào bảng v5 sau khi v5 đã ra đời (DB dev có thể đã ở version 5 mà
 * thiếu cột). Chạy ALTER idempotent mỗi lần mở DB — rẻ và không cần bump version.
 */
const V5_ADDED_COLUMNS: ReadonlyArray<{ table: string; column: string; type: string }> = [
  { table: 'topic_channels', column: 'faceless_hint', type: 'REAL' },
  { table: 'topic_channels', column: 'faceless_hint_reasons_json', type: 'TEXT' },
  { table: 'topic_channels', column: 'decided_reason', type: 'TEXT' },
  { table: 'topic_channels', column: 'thumbnails_json', type: 'TEXT' },
  { table: 'topic_channels', column: 'learn_value_reasons_json', type: 'TEXT' },
  { table: 'topic_channels', column: 'lang_evidence_json', type: 'TEXT' },
  { table: 'loop_ticks', column: 'search_baseline_calls', type: 'INTEGER NOT NULL DEFAULT 0' },
  { table: 'loop_ticks', column: 'general_baseline_units', type: 'INTEGER NOT NULL DEFAULT 0' },
];

export type VideoListRow = VideoSnapshot;

export type CandidateStatus = 'new' | 'shortlisted' | 'rejected' | 'scanned';
/**
 * Nguồn phát hiện một kênh ứng viên. Mỗi nhãn phải TRUY NGUYÊN ĐƯỢC — không có
 * nguồn tự động vô danh (ràng buộc C1).
 *
 * `manual` chung chung đã bị tách làm ba vì gộp lại thì nhìn một dòng không
 * phân biệt được kênh đến từ corpus của chính mình (tự lực, đối chiếu được với
 * bảng `channels`) hay từ ô dán tay (chỉ là LỜI KHAI, và đúng là chỗ dữ liệu
 * provider ngoài có thể lọt vào mà không để lại dấu vết nào trong repo).
 *
 * `manual_user` CHỈ được ghi bởi entrypoint nhận input trực tiếp từ người đã
 * xác thực. Đường tự động — topic import, corpus import, discovery, agent —
 * ghi nhãn này là SAI THIẾT KẾ, không phải tiện tay.
 */
export type DiscoverySource =
  | 'search_video'
  | 'search_channel'
  | 'featured'
  | 'subscription'
  /** Kênh đã spy sẵn trong bảng `channels` của chính mình. Kiểm chứng được. */
  | 'corpus_import'
  /** `seedChannelIds` trong file topic config của user. */
  | 'seed_config'
  /** Dán qua dashboard. Attestation, không phải bằng chứng. */
  | 'manual_user';


export interface CandidateChannelInput {
  channelId: string;
  title?: string | null;
  handle?: string | null;
  market?: string | null;
  discoveredVia: DiscoverySource;
  discoveredFrom?: string | null;
  subscriberCount?: number | null;
  videoCount?: number | null;
  viewCount?: number | null;
  country?: string | null;
  publishedAt?: string | null;
  description?: string | null;
  fitScore?: number | null;
  fitReasons?: unknown[];
}

export interface CandidateChannel extends Omit<CandidateChannelInput, 'fitReasons'> {
  fitReasons: unknown[];
  status: CandidateStatus;
  firstSeenAt: string;
  refreshedAt: string;
}

export interface CorpusVideoFilter {
  titleQuery?: string;
  channelIds?: string[];
  sourceVideoIds?: string[];
  minViews?: number;
  maxViews?: number;
  minDurationSec?: number;
  maxDurationSec?: number;
  publishedAfter?: string;
  publishedBefore?: string;
  hasTranscript?: boolean;
  /** Minimum velocity (views/day). Computed as view_count / days_since_published. */
  minVelocity?: number;
  orderBy?: 'views' | 'velocity' | 'published_at' | 'duration' | 'engagement';
  direction?: 'asc' | 'desc';
  limit?: number;
  cursor?: number;
}

export interface CorpusVideoRow {
  videoSnapshotId: string;
  sourceVideoId: string;
  title: string;
  channelTitle: string;
  channelKey: string;
  url: string;
  viewCount: number;
  likeCount: number | null;
  commentCount: number | null;
  durationSec: number;
  publishedAt: string | null;
  velocity: number;
  engagement: number;
  hasTranscript: boolean;
}

export interface CorpusChannelRow {
  channelKey: string;
  channelTitle: string;
  videoCount: number;
  totalViews: number;
  avgViews: number;
  maxViews: number;
  firstPublished: string | null;
  lastPublished: string | null;
  avgDurationSec: number;
  withTranscript: number;
}

// ---------------------------------------------------------------------------
// v9 — spy_global_video_search cache. See the schema comment above
// search_query_cache for why this is intentionally isolated from
// video_snapshots/spy_runs/corpus aggregation.
// ---------------------------------------------------------------------------

export interface SearchQueryCacheRow {
  queryNorm: string;
  language: string;
  region: string;
  providerUsed: 'youtube_data_api' | 'ytdlp';
  limitRequested: number;
  localeHintsApplied: boolean;
  fallbackReason: string | null;
  videoIds: string[];
  fetchedAt: string;
}

export interface SearchVideoCacheRow {
  sourceVideoId: string;
  title: string;
  channelTitle: string;
  canonicalUrl: string;
  viewCount: number;
  durationSec: number;
  /** null when unknown — never a guessed date. */
  publishedAt: string | null;
  /** true only when a provider actually reported `publishedAt`. */
  publishedAtKnown: boolean;
  providerUsed: 'youtube_data_api' | 'ytdlp';
  /** Last time this row's view/duration/title were refreshed. */
  fetchedAt: string;
  firstSeenAt: string;
}

// ---------------------------------------------------------------------------
// P0 Corpus Intelligence rows. They deliberately mirror only P0's managed
// corpus/evidence plane; legacy Auto-Loop candidate and Inbox rows stay owned
// by their existing workflow.
// ---------------------------------------------------------------------------

export type P0ImportStatus = 'draft' | 'confirmed' | 'rejected';
export type P0MembershipStatus = 'confirmed' | 'expired';
export type P0RecommendationBatchStatus = 'capturing' | 'draft' | 'failed' | 'expired';
export type P0RecommendationStatus = 'draft' | 'confirmed' | 'rejected' | 'expired';
export type P0EvidenceStatus = 'available' | 'unavailable' | 'failed' | 'expired';
export type P0AnalysisStatus = 'running' | 'completed' | 'failed' | 'expired';

export interface P0CorpusImportBatch {
  id: string;
  topicId: string;
  ownerSubject: string;
  idempotencyKey: string;
  requestDigest: string;
  status: P0ImportStatus;
  createdAt: string;
  decidedAt: string | null;
}

export interface P0CorpusImportItem {
  id: string;
  batchId: string;
  submittedUrl: string;
  canonicalUrl: string;
  sourceVideoId: string;
  identityStatus: 'verified' | 'needs_identity';
  evidenceArtifact: ArtifactRef;
  evidenceDigest: string;
  capturedAt: string;
  expiresAt: string;
  status: P0ImportStatus;
  promotedMembershipId: string | null;
}

export interface P0CorpusMembership {
  id: string;
  topicId: string;
  entityKind: 'video';
  canonicalUrl: string;
  sourceVideoId: string;
  status: P0MembershipStatus;
  identityStatus: 'verified' | 'needs_identity';
  createdFromKind: 'corpus_import' | 'recommendation';
  createdFromId: string;
  createdAt: string;
  confirmedAt: string;
}

export interface P0RecommendationCaptureBatch {
  id: string;
  topicId: string;
  seedMembershipId: string;
  fromVideoId: string;
  seedCanonicalUrl: string;
  ownerSubject: string;
  idempotencyKey: string;
  requestDigest: string;
  requestedDepth: 1;
  requestedLimit: number;
  captureMethod: string | null;
  adapterVersion: string | null;
  captureArtifact: ArtifactRef | null;
  captureDigest: string | null;
  capturedAt: string | null;
  expiresAt: string | null;
  status: P0RecommendationBatchStatus;
  failureCode: string | null;
  failureReason: string | null;
  createdAt: string;
}

export interface P0RecommendationObservation {
  id: string;
  batchId: string;
  seedMembershipId: string;
  fromVideoId: string;
  targetVideoId: string;
  targetCanonicalUrl: string;
  targetTitle: string | null;
  targetChannelId: string | null;
  targetChannelTitle: string | null;
  targetIdentityStatus: 'verified' | 'needs_identity';
  observedPosition: number;
  captureArtifactDigest: string;
  observedAt: string;
  expiresAt: string;
  status: P0RecommendationStatus;
  promotedMembershipId: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
}

export interface P0EvidenceRecord {
  id: string;
  membershipId: string;
  kind: 'metadata' | 'transcript' | 'thumbnail';
  status: P0EvidenceStatus;
  method: string;
  adapterVersion: string;
  artifact: ArtifactRef | null;
  artifactDigest: string | null;
  observedAt: string;
  expiresAt: string;
  detail: Record<string, unknown>;
}

export interface P0SemanticAnalysisRun {
  id: string;
  topicId: string;
  membershipId: string;
  ownerSubject: string;
  idempotencyKey: string;
  inputManifest: Record<string, unknown>;
  inputManifestDigest: string;
  policyVersion: string;
  model: string;
  status: P0AnalysisStatus;
  result: Record<string, unknown> | null;
  rawResponseArtifact: ArtifactRef | null;
  rawResponseDigest: string | null;
  failureCode: string | null;
  failureReason: string | null;
  attempt: number;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string;
}

export interface P0LoopRun {
  id: string;
  topicId: string;
  ownerSubject: string;
  idempotencyKey: string;
  status: 'running' | 'completed' | 'failed' | 'blocked';
  phase: string;
  resumeIndex: number;
  summary: Record<string, unknown>;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface P0Report {
  id: string;
  topicId: string;
  loopRunId: string;
  summary: Record<string, unknown>;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// v13 — Spy Pipeline v3 Lean: kiểu dòng + settings theo hợp đồng store (§3, §4).
// Enum status mới: loop chỉ ghi new/pending (+ rejected duy nhất lang_mismatch)
// và suggestion; active/paused/rejected còn lại chỉ qua endpoint duyệt human.
// ---------------------------------------------------------------------------

export type LoopMode = 'setup' | 'daily' | 'weekly';
export type TopicSetupStatus = 'none' | 'awaiting_channels' | 'awaiting_keywords' | 'done';
export type TopicChannelStatusV3 = 'new' | 'active' | 'paused' | 'rejected' | 'own';
export type TopicKeywordStatusV3 = 'pending' | 'active' | 'paused' | 'rejected';
export type KeywordOrigin = 'seed' | 'title_ngram' | 'outlier_title' | 'user';

/** Ngưỡng §3 plan — merge settings_json của topic lên mặc định này khi đọc. */
export interface TopicSettings {
  /** views / baseline_median để gọi là outlier. */
  outlierMultiple: number;
  /** max/median > ngưỡng ⇒ kênh xổ số, không đề xuất. */
  lotteryRatio: number;
  /** Video dưới ngưỡng không tính baseline/outlier (loại Shorts). */
  minDurationSec: number;
  /** Số video dài gần nhất tính median. */
  baselineWindow: number;
  /** Ít hơn ⇒ baseline chưa tin cậy, không tính outlier. */
  baselineMinN: number;
  /** Median dưới ngưỡng ⇒ kênh dead, không đề xuất. */
  deadMedian: number;
  /** Không đăng quá số ngày ⇒ gợi ý pause. */
  silentDays: number;
  /** Video mới nhất quét mỗi ngày / kênh. */
  dailyScanPerChannel: number;
  /** Số search call tối đa mỗi tuần. */
  weeklyKeywordBudget: number;
  /** Số kênh ngoài follow quét nhanh / tuần. */
  weeklyNewChannelScan: number;
  /** n-gram phải xuất hiện ở ≥ N kênh (setup). */
  ngramMinChannels: number;
  /** Giờ chạy daily, Asia/Ho_Chi_Minh (mặc định 15:30). */
  dailyAt: string;
  /** Giờ chạy weekly (mặc định "CN 16:00" — Chủ nhật 16:00). */
  weeklyAt: string;
}

export const DEFAULT_TOPIC_SETTINGS: TopicSettings = {
  outlierMultiple: 3,
  lotteryRatio: 50,
  minDurationSec: 300,
  baselineWindow: 30,
  baselineMinN: 10,
  deadMedian: 500,
  silentDays: 60,
  dailyScanPerChannel: 15,
  weeklyKeywordBudget: 12,
  weeklyNewChannelScan: 10,
  ngramMinChannels: 3,
  dailyAt: '15:30',
  weeklyAt: 'CN 16:00',
};

export interface TopicChannelRow {
  topicId: string;
  channelId: string;
  title: string | null;
  handle: string | null;
  subscriberCount: number | null;
  fitScore: number | null;
  fitReasonsJson: string;
  facelessScore: number | null;
  facelessSignalsJson: string;
  facelessHint: number | null;
  facelessHintReasonsJson: string | null;
  thumbnailsJson: string | null;
  styleMatchScore: number | null;
  styleNotes: string | null;
  learnValueScore: number | null;
  learnValueReasonsJson: string | null;
  status: TopicChannelStatusV3;
  decidedBy: 'user' | 'loop_auto' | null;
  decidedAt: string | null;
  decidedReason: string | null;
  spyRunId: string | null;
  langDetected: string | null;
  langConfidence: number | null;
  langEvidenceJson: string | null;
  discoveredVia: string | null;
  discoveredFrom: string | null;
  baselineMedianViews: number | null;
  baselineN: number | null;
  maxViews: number | null;
  baselineAt: string | null;
  lastPublishedAt: string | null;
  lastCheckedAt: string | null;
  suggestion: string | null;
  suggestionAt: string | null;
  firstSeenAt: string;
  lastScoredAt: string | null;
}

export interface TopicKeywordRow {
  topicId: string;
  termKey: string;
  displayTerm: string;
  relation: string;
  evidenceJson: string;
  status: TopicKeywordStatusV3;
  origin: KeywordOrigin | null;
  yieldChannels: number;
  lastSearchedAt: string | null;
  lastCheckedAt: string | null;
  lastNResults: number | null;
  lastNFollowed: number | null;
  lastMedianViews: number | null;
  decidedAt: string | null;
  decidedReason: string | null;
  addedAt: string;
  addedBy: 'user' | 'loop' | 'agent';
}

export interface TopicVideoRow {
  topicId: string;
  videoId: string;
  channelId: string;
  title: string;
  publishedAt: string | null;
  durationSec: number | null;
  thumbnailUrl: string | null;
  source: string;
  foundByKeyword: string | null;
  firstSeenAt: string;
  latestViews: number | null;
  latestLikes: number | null;
  latestComments: number | null;
  latestAt: string | null;
  viewsGained24h: number | null;
  outlierScore: number | null;
}

export interface DecisionRow {
  id: string;
  topicId: string;
  at: string;
  actor: 'human' | 'loop';
  entityType: 'channel' | 'keyword';
  entityId: string;
  fromStatus: string | null;
  toStatus: string;
  reason: string;
  tickId: string | null;
}

type Row = Record<string, unknown>;

function candidateFromRow(row: Row): CandidateChannel {
  return {
    channelId: String(row['channel_id']),
    title: nullableString(row['title']),
    handle: nullableString(row['handle']),
    market: nullableString(row['market']),
    discoveredVia: String(row['discovered_via']) as DiscoverySource,
    discoveredFrom: nullableString(row['discovered_from']),
    subscriberCount: row['subscriber_count'] === null ? null : Number(row['subscriber_count']),
    videoCount: row['video_count'] === null ? null : Number(row['video_count']),
    viewCount: row['view_count'] === null ? null : Number(row['view_count']),
    country: nullableString(row['country']),
    publishedAt: nullableString(row['published_at']),
    description: nullableString(row['description']),
    fitScore: row['fit_score'] === null ? null : Number(row['fit_score']),
    fitReasons: parseJson<unknown[]>(row['fit_reasons_json']),
    status: String(row['status']) as CandidateStatus,
    firstSeenAt: String(row['first_seen_at']),
    refreshedAt: String(row['refreshed_at']),
  };
}

function parseJson<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

function searchQueryCacheFromRow(row: Row): SearchQueryCacheRow {
  return {
    queryNorm: String(row['query_norm']),
    language: String(row['language']),
    region: String(row['region']),
    providerUsed: String(row['provider_used']) as SearchQueryCacheRow['providerUsed'],
    limitRequested: Number(row['limit_requested']),
    localeHintsApplied: Number(row['locale_hints_applied']) === 1,
    fallbackReason: nullableString(row['fallback_reason']),
    videoIds: parseJson<string[]>(row['video_ids_json']),
    fetchedAt: String(row['fetched_at']),
  };
}

function searchVideoCacheFromRow(row: Row): SearchVideoCacheRow {
  return {
    sourceVideoId: String(row['source_video_id']),
    title: String(row['title']),
    channelTitle: String(row['channel_title'] ?? ''),
    canonicalUrl: String(row['canonical_url']),
    viewCount: Number(row['view_count']),
    durationSec: Number(row['duration_sec']),
    publishedAt: nullableString(row['published_at']),
    publishedAtKnown: Number(row['published_at_known']) === 1,
    providerUsed: String(row['provider_used']) as SearchVideoCacheRow['providerUsed'],
    fetchedAt: String(row['fetched_at']),
    firstSeenAt: String(row['first_seen_at']),
  };
}

interface PublicPointCursor {
  sampledAt: string;
  sourceVideoId: string;
  createdAt: string;
}

function publicPointCursor(sampledAt: string, sourceVideoId: string, createdAt: string): string {
  return Buffer.from(JSON.stringify({ sampledAt, sourceVideoId, createdAt }), 'utf8').toString('base64url');
}

function parsePublicPointCursor(value: string | null | undefined): PublicPointCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<PublicPointCursor>;
    if (
      typeof parsed.sampledAt !== 'string' || Number.isNaN(Date.parse(parsed.sampledAt)) ||
      typeof parsed.sourceVideoId !== 'string' || typeof parsed.createdAt !== 'string'
    ) return null;
    return { sampledAt: parsed.sampledAt, sourceVideoId: parsed.sourceVideoId, createdAt: parsed.createdAt };
  } catch {
    return null;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** YouTube channel IDs are `UC` followed by 22 URL-safe characters. */
export const YOUTUBE_UC_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;

export function isResolvedYoutubeUcId(value: unknown): value is string {
  return typeof value === 'string' && YOUTUBE_UC_ID_PATTERN.test(value);
}

function handleAliasFromChannelId(value: string): string | null {
  const match = /(?:^|:)\/@([^/]+)$/i.exec(value) ?? /youtube\.com\/@([^/]+)/i.exec(value);
  return match?.[1] ? `@${match[1]}` : null;
}

function channelFromRow(row: Row): ChannelRecord {
  return {
    id: String(row['id']),
    channelId: String(row['channel_id']),
    youtubeUcId: nullableString(row['youtube_uc_id']),
    handle: nullableString(row['handle']),
    title: String(row['title']),
    subscriberCount: row['subscriber_count'] === null ? null : Number(row['subscriber_count']),
    videoCount: row['video_count'] === null ? null : Number(row['video_count']),
    totalViewCount: row['total_view_count'] === null ? null : Number(row['total_view_count']),
    fetchedAt: String(row['fetched_at']),
  };
}

function publicCompetitorFromRow(row: Row): PublicCompetitorRecord {
  return {
    id: String(row['id']),
    watchlistId: String(row['owner_channel_id']),
    competitorChannelId: String(row['competitor_channel_id']),
    note: nullableString(row['note']),
    watchStatus: String(row['watch_status'] ?? 'followed') as PublicWatchStatus,
    cadence: String(row['cadence'] ?? 'daily') as PublicWatchCadence,
    lastObservedAt: nullableString(row['last_observed_at']),
    lastObservationStatus: nullableString(row['last_observation_status']),
    createdAt: String(row['created_at']),
  };
}

function publicObservationRunFromRow(row: Row): PublicObservationRun {
  return {
    id: String(row['id']),
    watchlistId: String(row['owner_channel_id']),
    competitorChannelId: String(row['competitor_channel_id']),
    planKind: String(row['plan_kind']) as PublicObservationPlanKind,
    planVersion: String(row['plan_version']),
    localDate: String(row['local_date']),
    providerUsed: 'ytdlp',
    status: String(row['status']) as PublicObservationStatus,
    completeness: String(row['completeness']) as PublicObservationCompleteness,
    startedAt: String(row['started_at']),
    completedAt: nullableString(row['completed_at']),
    errorCode: nullableString(row['error_code']),
    errorMessage: nullableString(row['error_message']),
    playlistLimit: Number(row['playlist_limit']),
    inspectAttempted: Number(row['inspect_attempted']),
    inspectOk: Number(row['inspect_ok']),
  };
}

function publicVideoStatPointFromRow(row: Row): PublicVideoStatPoint {
  return {
    id: String(row['id']),
    observationRunId: String(row['observation_run_id']),
    sourceVideoId: String(row['source_video_id']),
    youtubeUcId: nullableString(row['youtube_uc_id']),
    sampledAt: String(row['sampled_at']),
    viewCount: row['view_count'] === null ? null : Number(row['view_count']),
    likeCount: row['like_count'] === null ? null : Number(row['like_count']),
    commentCount: row['comment_count'] === null ? null : Number(row['comment_count']),
    durationSec: row['duration_sec'] === null ? null : Number(row['duration_sec']),
    publishedAt: nullableString(row['published_at']),
    title: nullableString(row['title']),
    availability: String(row['availability']) as PublicVideoAvailability,
    viewQuality: String(row['view_quality']) as PublicViewQuality,
    providerUsed: 'ytdlp',
    inspectUsed: Number(row['inspect_used']) === 1,
    createdAt: String(row['created_at']),
  };
}

function artifactFromJson(value: unknown): ArtifactRef | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = parseJson<ArtifactRef>(value);
  if (
    !parsed || typeof parsed.hash !== 'string' || typeof parsed.relativePath !== 'string'
    || typeof parsed.byteLength !== 'number' || typeof parsed.mimeType !== 'string'
  ) {
    throw new AppError('internal', 'Artifact manifest P0 không hợp lệ trong database');
  }
  return parsed;
}

function p0ImportBatchFromRow(row: Row): P0CorpusImportBatch {
  return {
    id: String(row['id']), topicId: String(row['topic_id']), ownerSubject: String(row['owner_subject']),
    idempotencyKey: String(row['idempotency_key']), requestDigest: String(row['request_digest']),
    status: String(row['status']) as P0ImportStatus, createdAt: String(row['created_at']),
    decidedAt: nullableString(row['decided_at']),
  };
}

function p0ImportItemFromRow(row: Row): P0CorpusImportItem {
  const artifact = artifactFromJson(row['evidence_artifact_json']);
  if (!artifact) throw new AppError('internal', 'Corpus import item thiếu evidence artifact');
  return {
    id: String(row['id']), batchId: String(row['batch_id']), submittedUrl: String(row['submitted_url']),
    canonicalUrl: String(row['canonical_url']), sourceVideoId: String(row['source_video_id']),
    identityStatus: String(row['identity_status']) as P0CorpusImportItem['identityStatus'],
    evidenceArtifact: artifact, evidenceDigest: String(row['evidence_digest']),
    capturedAt: String(row['captured_at']), expiresAt: String(row['expires_at']),
    status: String(row['status']) as P0ImportStatus, promotedMembershipId: nullableString(row['promoted_membership_id']),
  };
}

function p0MembershipFromRow(row: Row): P0CorpusMembership {
  return {
    id: String(row['id']), topicId: String(row['topic_id']), entityKind: 'video',
    canonicalUrl: String(row['canonical_url']), sourceVideoId: String(row['source_video_id']),
    status: String(row['status']) as P0MembershipStatus,
    identityStatus: String(row['identity_status']) as P0CorpusMembership['identityStatus'],
    createdFromKind: String(row['created_from_kind']) as P0CorpusMembership['createdFromKind'],
    createdFromId: String(row['created_from_id']), createdAt: String(row['created_at']),
    confirmedAt: String(row['confirmed_at']),
  };
}

function p0RecommendationBatchFromRow(row: Row): P0RecommendationCaptureBatch {
  return {
    id: String(row['id']), topicId: String(row['topic_id']), seedMembershipId: String(row['seed_membership_id']),
    fromVideoId: String(row['from_video_id']), seedCanonicalUrl: String(row['seed_canonical_url']),
    ownerSubject: String(row['owner_subject']), idempotencyKey: String(row['idempotency_key']),
    requestDigest: String(row['request_digest']), requestedDepth: 1,
    requestedLimit: Number(row['requested_limit']), captureMethod: nullableString(row['capture_method']),
    adapterVersion: nullableString(row['adapter_version']), captureArtifact: artifactFromJson(row['capture_artifact_json']),
    captureDigest: nullableString(row['capture_digest']), capturedAt: nullableString(row['captured_at']),
    expiresAt: nullableString(row['expires_at']), status: String(row['status']) as P0RecommendationBatchStatus,
    failureCode: nullableString(row['failure_code']), failureReason: nullableString(row['failure_reason']),
    createdAt: String(row['created_at']),
  };
}

function p0RecommendationObservationFromRow(row: Row): P0RecommendationObservation {
  return {
    id: String(row['id']), batchId: String(row['batch_id']), seedMembershipId: String(row['seed_membership_id']),
    fromVideoId: String(row['from_video_id']), targetVideoId: String(row['target_video_id']),
    targetCanonicalUrl: String(row['target_canonical_url']), targetTitle: nullableString(row['target_title']),
    targetChannelId: nullableString(row['target_channel_id']), targetChannelTitle: nullableString(row['target_channel_title']),
    targetIdentityStatus: String(row['target_identity_status']) as P0RecommendationObservation['targetIdentityStatus'],
    observedPosition: Number(row['observed_position']), captureArtifactDigest: String(row['capture_artifact_digest']),
    observedAt: String(row['observed_at']), expiresAt: String(row['expires_at']),
    status: String(row['status']) as P0RecommendationStatus,
    promotedMembershipId: nullableString(row['promoted_membership_id']), decidedBy: nullableString(row['decided_by']),
    decidedAt: nullableString(row['decided_at']),
  };
}

function p0EvidenceFromRow(row: Row): P0EvidenceRecord {
  return {
    id: String(row['id']), membershipId: String(row['membership_id']),
    kind: String(row['kind']) as P0EvidenceRecord['kind'], status: String(row['status']) as P0EvidenceStatus,
    method: String(row['method']), adapterVersion: String(row['adapter_version']), artifact: artifactFromJson(row['artifact_json']),
    artifactDigest: nullableString(row['artifact_digest']), observedAt: String(row['observed_at']),
    expiresAt: String(row['expires_at']), detail: parseJson<Record<string, unknown>>(row['detail_json']),
  };
}

function p0AnalysisFromRow(row: Row): P0SemanticAnalysisRun {
  return {
    id: String(row['id']), topicId: String(row['topic_id']), membershipId: String(row['membership_id']),
    ownerSubject: String(row['owner_subject']), idempotencyKey: String(row['idempotency_key']),
    inputManifest: parseJson<Record<string, unknown>>(row['input_manifest_json']),
    inputManifestDigest: String(row['input_manifest_digest']), policyVersion: String(row['policy_version']),
    model: String(row['model']), status: String(row['status']) as P0AnalysisStatus,
    result: row['result_json'] === null ? null : parseJson<Record<string, unknown>>(row['result_json']),
    rawResponseArtifact: artifactFromJson(row['raw_response_artifact_json']),
    rawResponseDigest: nullableString(row['raw_response_digest']), failureCode: nullableString(row['failure_code']),
    failureReason: nullableString(row['failure_reason']), attempt: Number(row['attempt']),
    createdAt: String(row['created_at']), completedAt: nullableString(row['completed_at']),
    expiresAt: String(row['expires_at']),
  };
}

function p0LoopRunFromRow(row: Row): P0LoopRun {
  return {
    id: String(row['id']), topicId: String(row['topic_id']), ownerSubject: String(row['owner_subject']),
    idempotencyKey: String(row['idempotency_key']), status: String(row['status']) as P0LoopRun['status'],
    phase: String(row['phase']), resumeIndex: Number(row['resume_index']), summary: parseJson<Record<string, unknown>>(row['summary_json']),
    errorCode: nullableString(row['error_code']), errorMessage: nullableString(row['error_message']),
    createdAt: String(row['created_at']), completedAt: nullableString(row['completed_at']),
  };
}

function p0ReportFromRow(row: Row): P0Report {
  return {
    id: String(row['id']), topicId: String(row['topic_id']), loopRunId: String(row['loop_run_id']),
    summary: parseJson<Record<string, unknown>>(row['summary_json']), createdAt: String(row['created_at']),
  };
}

function operationFromRow(row: Row): Operation {
  return {
    id: String(row['id']),
    kind: String(row['kind']) as OperationKind,
    ownerSubject: String(row['owner_subject']),
    status: String(row['status']) as OperationStatus,
    idempotencyKey: nullableString(row['idempotency_key']),
    progress: Number(row['progress']),
    total: Number(row['total']),
    step: String(row['step']),
    resultRef: nullableString(row['result_ref']),
    errorCode: nullableString(row['error_code']),
    errorMessage: nullableString(row['error_message']),
    createdAt: String(row['created_at']),
    startedAt: nullableString(row['started_at']),
    completedAt: nullableString(row['completed_at']),
  };
}

function spyRunFromRow(row: Row): SpyRun {
  return {
    id: String(row['id']),
    kind: String(row['kind']) as SpyRun['kind'],
    canonicalSource: String(row['canonical_source']),
    sourceIdentity: String(row['source_identity']),
    config: parseJson<unknown>(row['config_json']),
    status: String(row['status']) as OperationStatus,
    scanLimit: row['scan_limit'] === null ? null : Number(row['scan_limit']),
    topN: row['top_n'] === null ? null : Number(row['top_n']),
    createdAt: String(row['created_at']),
    completedAt: nullableString(row['completed_at']),
  };
}

function videoSnapshotFromRow(row: Row): VideoSnapshot {
  return {
    id: String(row['id']),
    spyRunId: String(row['spy_run_id']),
    sourceVideoId: String(row['source_video_id']),
    canonicalUrl: String(row['canonical_url']),
    title: String(row['title']),
    channelTitle: String(row['channel_title'] ?? ''),
    rank: Number(row['rank']),
    viewCount: Number(row['view_count']),
    likeCount: row['like_count'] === null ? null : Number(row['like_count']),
    commentCount: row['comment_count'] === null ? null : Number(row['comment_count']),
    durationSec: Number(row['duration_sec']),
    publishedAt: nullableString(row['published_at']),
    tags: parseJson<string[]>(row['tags_json']),
    transcriptStatus: String(row['transcript_status']) as VideoSnapshot['transcriptStatus'],
    transcriptSource: nullableString(row['transcript_source']) as VideoSnapshot['transcriptSource'],
    frameStatus: String(row['frame_status']) as VideoSnapshot['frameStatus'],
    thumbnail: row['thumbnail_json'] ? parseJson<ArtifactRef>(row['thumbnail_json']) : null,
    createdAt: String(row['created_at']),
  };
}

function videoTranscriptFromRow(row: Row): VideoTranscript {
  return {
    id: String(row['id']),
    sourceVideoId: String(row['source_video_id']),
    language: String(row['language']),
    source: String(row['source']) as VideoTranscript['source'],
    contentHash: String(row['content_hash']),
    fetchedAt: String(row['fetched_at']),
    normalizedText: nullableString(row['normalized_text']),
    normalizedAt: nullableString(row['normalized_at']),
    normalizeModel: nullableString(row['normalize_model']),
  };
}

/**
 * A saved YouTube comment or reply. `id` is the YouTube commentId itself —
 * the natural idempotency key for `upsertVideoComments`. `channelId` is the
 * internal `channels.id` FK (nullable — see the schema comment above
 * `video_comments`), never a raw YouTube channel id.
 */
export interface VideoCommentRecord {
  id: string;
  sourceVideoId: string;
  channelId: string | null;
  parentCommentId: string | null;
  authorDisplayName: string | null;
  text: string;
  likeCount: number | null;
  publishedAt: string | null;
  updatedAt: string | null;
  fetchedAt: string;
}

function videoCommentFromRow(row: Row): VideoCommentRecord {
  return {
    id: String(row['id']),
    sourceVideoId: String(row['source_video_id']),
    channelId: nullableString(row['channel_id']),
    parentCommentId: nullableString(row['parent_comment_id']),
    authorDisplayName: nullableString(row['author_display_name']),
    text: String(row['text']),
    likeCount: row['like_count'] === null ? null : Number(row['like_count']),
    publishedAt: nullableString(row['published_at']),
    updatedAt: nullableString(row['updated_at']),
    fetchedAt: String(row['fetched_at']),
  };
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function topicChannelRowFromRow(row: Row): TopicChannelRow {
  return {
    topicId: String(row['topic_id']),
    channelId: String(row['channel_id']),
    title: nullableString(row['title']),
    handle: nullableString(row['handle']),
    subscriberCount: nullableNumber(row['subscriber_count']),
    fitScore: nullableNumber(row['fit_score']),
    fitReasonsJson: String(row['fit_reasons_json'] ?? '[]'),
    facelessScore: nullableNumber(row['faceless_score']),
    facelessSignalsJson: String(row['faceless_signals_json'] ?? '[]'),
    facelessHint: nullableNumber(row['faceless_hint']),
    facelessHintReasonsJson: nullableString(row['faceless_hint_reasons_json']),
    thumbnailsJson: nullableString(row['thumbnails_json']),
    styleMatchScore: nullableNumber(row['style_match_score']),
    styleNotes: nullableString(row['style_notes']),
    learnValueScore: nullableNumber(row['learn_value_score']),
    learnValueReasonsJson: nullableString(row['learn_value_reasons_json']),
    status: String(row['status']) as TopicChannelStatusV3,
    decidedBy: nullableString(row['decided_by']) as TopicChannelRow['decidedBy'],
    decidedAt: nullableString(row['decided_at']),
    decidedReason: nullableString(row['decided_reason']),
    spyRunId: nullableString(row['spy_run_id']),
    langDetected: nullableString(row['lang_detected']),
    langConfidence: nullableNumber(row['lang_confidence']),
    langEvidenceJson: nullableString(row['lang_evidence_json']),
    discoveredVia: nullableString(row['discovered_via']),
    discoveredFrom: nullableString(row['discovered_from']),
    baselineMedianViews: nullableNumber(row['baseline_median_views']),
    baselineN: nullableNumber(row['baseline_n']),
    maxViews: nullableNumber(row['max_views']),
    baselineAt: nullableString(row['baseline_at']),
    lastPublishedAt: nullableString(row['last_published_at']),
    lastCheckedAt: nullableString(row['last_checked_at']),
    suggestion: nullableString(row['suggestion']),
    suggestionAt: nullableString(row['suggestion_at']),
    firstSeenAt: String(row['first_seen_at']),
    lastScoredAt: nullableString(row['last_scored_at']),
  };
}

function topicKeywordRowFromRow(row: Row): TopicKeywordRow {
  return {
    topicId: String(row['topic_id']),
    termKey: String(row['term_key']),
    displayTerm: String(row['display_term']),
    relation: String(row['relation'] ?? ''),
    evidenceJson: String(row['evidence_json'] ?? '{}'),
    status: String(row['status']) as TopicKeywordStatusV3,
    origin: nullableString(row['origin']) as TopicKeywordRow['origin'],
    yieldChannels: Number(row['yield_channels']),
    lastSearchedAt: nullableString(row['last_searched_at']),
    lastCheckedAt: nullableString(row['last_checked_at']),
    lastNResults: nullableNumber(row['last_n_results']),
    lastNFollowed: nullableNumber(row['last_n_followed']),
    lastMedianViews: nullableNumber(row['last_median_views']),
    decidedAt: nullableString(row['decided_at']),
    decidedReason: nullableString(row['decided_reason']),
    addedAt: String(row['added_at']),
    addedBy: String(row['added_by']) as TopicKeywordRow['addedBy'],
  };
}

function topicVideoRowFromRow(row: Row): TopicVideoRow {
  return {
    topicId: String(row['topic_id']),
    videoId: String(row['video_id']),
    channelId: String(row['channel_id']),
    title: String(row['title']),
    publishedAt: nullableString(row['published_at']),
    durationSec: nullableNumber(row['duration_sec']),
    thumbnailUrl: nullableString(row['thumbnail_url']),
    source: String(row['source']),
    foundByKeyword: nullableString(row['found_by_keyword']),
    firstSeenAt: String(row['first_seen_at']),
    latestViews: nullableNumber(row['latest_views']),
    latestLikes: nullableNumber(row['latest_likes']),
    latestComments: nullableNumber(row['latest_comments']),
    latestAt: nullableString(row['latest_at']),
    viewsGained24h: nullableNumber(row['views_gained_24h']),
    outlierScore: nullableNumber(row['outlier_score']),
  };
}

function decisionFromRow(row: Row): DecisionRow {
  return {
    id: String(row['id']),
    topicId: String(row['topic_id']),
    at: String(row['at']),
    actor: String(row['actor']) as DecisionRow['actor'],
    entityType: String(row['entity_type']) as DecisionRow['entityType'],
    entityId: String(row['entity_id']),
    fromStatus: nullableString(row['from_status']),
    toStatus: String(row['to_status']),
    reason: String(row['reason']),
    tickId: nullableString(row['tick_id']),
  };
}

export class SpyStore {
  readonly databasePath: string;
  private readonly database: Database;

  /** Database thô cho truy vấn read-only (dash/*) — lớp trên tự giữ read-only,
   *  không route nào được ghi qua cổng này. */
  get rawDb(): Database {
    return this.database;
  }

  constructor(path: string) {
    this.databasePath = resolve(path);
    mkdirSync(dirname(this.databasePath), { recursive: true });
    this.database = new Database(this.databasePath);
    this.database.exec(SCHEMA_SQL);
    const row = this.database.prepare('SELECT version FROM schema_version LIMIT 1').get() as Row | undefined;
    if (!row) {
      this.database.prepare('INSERT INTO schema_version(version) VALUES (?)').run(SCHEMA_VERSION);
    } else {
      const version = Number(row['version']);
      if (!Number.isInteger(version) || version < 1 || version > SCHEMA_VERSION) {
        throw new AppError('internal', `Unsupported database schema ${String(row['version'])}`);
      }
      if (version === 1) {
        this.database.exec(MIGRATION_1_TO_2);
        try {
          this.database.exec('ALTER TABLE transcript_segments ADD COLUMN video_transcript_id TEXT');
        } catch {
          // already present
        }
      }
      // v2 → v3 thêm `competitors`; v3 → v4 thêm `api_quota_usage` + `candidate_channels`.
      // Cả ba đều do SCHEMA_SQL tạo ở trên (IF NOT EXISTS) nên migration chỉ cần nâng version.
      // v4 → v5: thêm uploads_playlist_id vào candidate_channels (ALTER, ignore nếu đã có).
      if (version === 4) {
        try {
          this.database.exec(MIGRATION_4_TO_5);
        } catch {
          // Cột đã tồn tại — bỏ qua.
        }
      }
      if (version < 7) {
        this.migrate6To7();
      }
      if (version < 8) {
        this.migrate7To8();
      }
      if (version < 10) {
        this.migrate9To10();
      }
      if (version < 13) {
        this.migrate12To13();
      }
      if (version < SCHEMA_VERSION) {
        this.database.prepare('UPDATE schema_version SET version=?').run(SCHEMA_VERSION);
      }
    }
    // Nhãn 'manual' cũ không truy nguyên được: không có cách nào CHỨNG MINH một
    // hàng cũ đến từ corpus import hay từ ô dán tay. Đưa hết về 'manual_user' —
    // nhãn "cần soi" — thay vì đoán tốt cho dữ liệu cũ. Đoán 'corpus_import' sẽ
    // gắn nhãn "tự lực, kiểm chứng được" lên thứ chưa từng được kiểm chứng.
    const hasLegacyManual = this.database
      .prepare("SELECT 1 FROM candidate_channels WHERE discovered_via='manual' LIMIT 1")
      .get();
    if (hasLegacyManual) {
      this.database.exec(
        "UPDATE candidate_channels SET discovered_via='manual_user' WHERE discovered_via='manual'",
      );
    }
    const hasLegacySource = this.database
      .prepare("SELECT 1 FROM topic_channel_sources WHERE relation='manual' LIMIT 1")
      .get();
    if (hasLegacySource) {
      this.database.exec(
        "UPDATE topic_channel_sources SET relation='manual_user' WHERE relation='manual'",
      );
    }

    for (const { table, column, type } of V5_ADDED_COLUMNS) {
      try {
        this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      } catch {
        // Cột đã tồn tại — bỏ qua.
      }
    }
    // Fresh v7 databases already have the column; migrated v6 databases have
    // it after migrate6To7. Keep C1 object/index creation after the explicit
    // migration so opening a v6 table never references a column that does not
    // exist yet.
    this.database.exec(MIGRATION_6_TO_7.savedChannels);
    this.database.exec(MIGRATION_6_TO_7.channelsAliasIndex);
    this.database.exec(MIGRATION_6_TO_7.savedChannelsIndex);
    this.database.exec(MIGRATION_7_TO_8);
    // Fresh v10 databases already have video_snapshots.channel_id from
    // SCHEMA_SQL; migrated pre-v10 databases have it after migrate9To10().
    // Keep this index creation after both so it never references a column
    // that does not exist yet.
    this.database.exec('CREATE INDEX IF NOT EXISTS idx_video_snapshots_channel_id ON video_snapshots(channel_id)');
  }

  /** Apply the C1 additions to an already-created v6 database. */
  private migrate6To7(): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      // Each ALTER is explicit and independently idempotent so a partially
      // upgraded development database can be repaired without changing old
      // rows or columns.
      for (const statement of [
        MIGRATION_6_TO_7.channelsYoutubeUcId,
        MIGRATION_6_TO_7.channelsHandle,
        MIGRATION_6_TO_7.competitorsWatchStatus,
        MIGRATION_6_TO_7.competitorsCadence,
        MIGRATION_6_TO_7.competitorsLastObservedAt,
        MIGRATION_6_TO_7.competitorsLastObservationStatus,
      ]) {
        try {
          this.database.exec(statement);
        } catch (error) {
          // SQLite has no ADD COLUMN IF NOT EXISTS.  Only ignore the known
          // already-present-column case; another schema error must abort the
          // migration and leave schema_version at v6.
          if (!/duplicate column name|already exists/i.test(String(error))) throw error;
        }
      }
      this.database.exec(MIGRATION_6_TO_7.savedChannels);

      // Preserve the old canonical channel_id while making existing stable UC
      // rows addressable by the new role API. Handle-based/source identities
      // remain aliases until a later resolved run supplies a UC ID.
      const channels = this.database.prepare(
        'SELECT channel_id, youtube_uc_id, handle FROM channels',
      ).all() as Row[];
      const updateAlias = this.database.prepare(
        'UPDATE channels SET youtube_uc_id=?, handle=? WHERE channel_id=?',
      );
      for (const row of channels) {
        const channelId = String(row['channel_id']);
        const existingUcId = nullableString(row['youtube_uc_id']);
        const existingHandle = nullableString(row['handle']);
        const ucId = existingUcId ?? (isResolvedYoutubeUcId(channelId) ? channelId : null);
        const handle = existingHandle ?? handleAliasFromChannelId(channelId);
        if (ucId !== existingUcId || handle !== existingHandle) {
          updateAlias.run(ucId, handle, channelId);
        }
      }
      this.database.exec(MIGRATION_6_TO_7.channelsAliasIndex);
      this.database.exec(MIGRATION_6_TO_7.savedChannelsIndex);
      this.database.prepare('UPDATE schema_version SET version=?').run(7);
      this.database.exec('COMMIT');
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { /* preserve original error */ }
      throw error;
    }
  }

  /** C3 only adds tables/indexes, but remains an explicit versioned upgrade. */
  private migrate7To8(): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.exec(MIGRATION_7_TO_8);
      this.database.prepare('UPDATE schema_version SET version=?').run(8);
      this.database.exec('COMMIT');
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { /* preserve original error */ }
      throw error;
    }
  }

  /**
   * v9 → v10: add video_snapshots.channel_id and backfill it for existing
   * rows. Real-data check against a production DB: every one of 48 distinct
   * `channel_title` values in video_snapshots matched a `channels.title`
   * after trimming both sides (handles a trailing-space title like
   * "Finance With Ryan "). Two titles were ambiguous (two `channels` rows
   * sharing a title — pre-existing duplicate-channel-row debt, not something
   * this migration should try to merge or delete): the canonical row is the
   * one with a resolved `youtube_uc_id`, since that is the one C1 roles and
   * follow/star treat as the real channel identity.
   */
  private migrate9To10(): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      try {
        this.database.exec('ALTER TABLE video_snapshots ADD COLUMN channel_id TEXT REFERENCES channels(id)');
      } catch (error) {
        if (!/duplicate column name|already exists/i.test(String(error))) throw error;
      }
      this.database.exec('CREATE INDEX IF NOT EXISTS idx_video_snapshots_channel_id ON video_snapshots(channel_id)');

      const channels = this.database.prepare('SELECT id, title, youtube_uc_id FROM channels').all() as Row[];
      const byTrimmedTitle = new Map<string, Row[]>();
      for (const channel of channels) {
        const key = String(channel['title'] ?? '').trim();
        if (!key) continue;
        const bucket = byTrimmedTitle.get(key) ?? [];
        bucket.push(channel);
        byTrimmedTitle.set(key, bucket);
      }
      // Prefer the row with a resolved youtube_uc_id when a title is shared
      // by more than one channels row (pre-existing dedupe debt — see above).
      const canonicalFor = (bucket: Row[]): Row =>
        bucket.find((row) => row['youtube_uc_id'] !== null) ?? bucket[0]!;

      const distinctTitles = this.database.prepare(
        `SELECT DISTINCT channel_title FROM video_snapshots WHERE channel_id IS NULL AND TRIM(channel_title) != ''`,
      ).all() as Row[];
      const updateByTitle = this.database.prepare(
        'UPDATE video_snapshots SET channel_id=? WHERE channel_id IS NULL AND channel_title=?',
      );
      for (const row of distinctTitles) {
        const rawTitle = String(row['channel_title']);
        const bucket = byTrimmedTitle.get(rawTitle.trim());
        if (!bucket) continue; // No matching channels row — left NULL, not guessed.
        updateByTitle.run(String(canonicalFor(bucket)['id']), rawTitle);
      }

      this.database.prepare('UPDATE schema_version SET version=?').run(10);
      this.database.exec('COMMIT');
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { /* preserve original error */ }
      throw error;
    }
  }

  /**
   * v12 → v13 (plan v3-lean §4): rebuild 3 bảng có CHECK/UNIQUE cũ và map status
   * sang enum mới. SQLite không sửa được CHECK/UNIQUE trên bảng có sẵn nên
   * phải tạo bảng mới + copy + drop + rename — toàn bộ trong MỘT transaction để
   * crash giữa chừng không để lại nửa bảng.
   *
   * Map status:
   *   topic_keywords: searched→active, exhausted→paused.
   *   topic_channels: studied→active; shortlisted do user quyết → active;
   *     shortlisted do loop_auto (hoặc chưa ai quyết) → new (về lại inbox).
   *   loop_ticks: dòng cũ mode='daily'.
   * topics chỉ ALTER ADD COLUMN (không rebuild — p0_* đang REFERENCES topics).
   */
  private migrate12To13(): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      // 0. Đảm bảo các cột v5+ đã thêm sau (faceless_hint, decided_reason, …)
      //    tồn tại trước khi copy — DB nào đó có thể chưa từng mở ở version có
      //    V5_ADDED_COLUMNS nên INSERT SELECT thiếu cột sẽ chết giữa migration.
      for (const { table, column, type } of V5_ADDED_COLUMNS) {
        try {
          this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
        } catch (error) {
          if (!/duplicate column name|already exists/i.test(String(error))) throw error;
        }
      }

      // 1. topics — 3 cột mới §4.1. Chịu lỗi duplicate để sửa được DB nâng cấp dở.
      for (const statement of [
        'ALTER TABLE topics ADD COLUMN region TEXT',
        "ALTER TABLE topics ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}'",
        "ALTER TABLE topics ADD COLUMN setup_status TEXT NOT NULL DEFAULT 'none' CHECK(setup_status IN ('none','awaiting_channels','awaiting_keywords','done'))",
      ]) {
        try {
          this.database.exec(statement);
        } catch (error) {
          if (!/duplicate column name|already exists/i.test(String(error))) throw error;
        }
      }

      // 2. topic_keywords — rebuild với CHECK status mới + cột mới §4.2.
      this.database.exec(`
CREATE TABLE topic_keywords_v13 (
  topic_id TEXT NOT NULL,
  term_key TEXT NOT NULL,
  display_term TEXT NOT NULL,
  relation TEXT NOT NULL DEFAULT '',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','paused','rejected')),
  origin TEXT CHECK(origin IS NULL OR origin IN ('seed','title_ngram','outlier_title','user')),
  yield_channels INTEGER NOT NULL DEFAULT 0,
  last_searched_at TEXT,
  last_checked_at TEXT,
  last_n_results INTEGER,
  last_n_followed INTEGER,
  last_median_views REAL,
  decided_at TEXT,
  decided_reason TEXT,
  added_at TEXT NOT NULL,
  added_by TEXT NOT NULL DEFAULT 'user' CHECK(added_by IN ('user','loop','agent')),
  PRIMARY KEY (topic_id, term_key)
);
INSERT INTO topic_keywords_v13 (
  topic_id, term_key, display_term, relation, evidence_json, status, origin,
  yield_channels, last_searched_at, last_checked_at, last_n_results,
  last_n_followed, last_median_views, decided_at, decided_reason, added_at, added_by
)
SELECT
  topic_id, term_key, display_term, relation, evidence_json,
  CASE status WHEN 'searched' THEN 'active' WHEN 'exhausted' THEN 'paused' ELSE status END,
  -- origin enum mới: suy ra từ relation cũ khi trùng nghĩa, còn lại 'user' nếu
  -- chính người thêm; không đoán được thì để NULL (không gán bừa).
  CASE
    WHEN relation='seed' THEN 'seed'
    WHEN relation='harvested_title' THEN 'title_ngram'
    WHEN added_by='user' THEN 'user'
    ELSE NULL END,
  yield_channels, last_searched_at, NULL, NULL, NULL, NULL, NULL, NULL,
  added_at, added_by
FROM topic_keywords;
DROP TABLE topic_keywords;
ALTER TABLE topic_keywords_v13 RENAME TO topic_keywords;
CREATE INDEX idx_topic_keywords_status
  ON topic_keywords(topic_id, status, yield_channels DESC);
      `);

      // 3. topic_channels — rebuild với CHECK status mới + cột mới §4.3.
      this.database.exec(`
CREATE TABLE topic_channels_v13 (
  topic_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  fit_score REAL,
  fit_reasons_json TEXT NOT NULL DEFAULT '[]',
  faceless_score REAL,
  faceless_signals_json TEXT NOT NULL DEFAULT '[]',
  faceless_hint REAL,
  faceless_hint_reasons_json TEXT,
  thumbnails_json TEXT,
  style_match_score REAL,
  style_notes TEXT,
  learn_value_score REAL,
  learn_value_reasons_json TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','active','paused','rejected','own')),
  decided_by TEXT CHECK(decided_by IN ('user','loop_auto')),
  decided_at TEXT,
  decided_reason TEXT,
  spy_run_id TEXT,
  lang_detected TEXT,
  lang_confidence REAL,
  lang_evidence_json TEXT,
  title TEXT,
  handle TEXT,
  subscriber_count INTEGER,
  discovered_via TEXT,
  discovered_from TEXT,
  baseline_median_views REAL,
  baseline_n INTEGER,
  max_views INTEGER,
  baseline_at TEXT,
  last_published_at TEXT,
  last_checked_at TEXT,
  suggestion TEXT,
  suggestion_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_scored_at TEXT,
  PRIMARY KEY (topic_id, channel_id)
);
INSERT INTO topic_channels_v13 (
  topic_id, channel_id, fit_score, fit_reasons_json, faceless_score,
  faceless_signals_json, faceless_hint, faceless_hint_reasons_json,
  thumbnails_json, style_match_score, style_notes, learn_value_score,
  learn_value_reasons_json, status, decided_by, decided_at, decided_reason,
  spy_run_id, lang_detected, lang_confidence, lang_evidence_json,
  first_seen_at, last_scored_at
)
SELECT
  topic_id, channel_id, fit_score, fit_reasons_json, faceless_score,
  faceless_signals_json, faceless_hint, faceless_hint_reasons_json,
  thumbnails_json, style_match_score, style_notes, learn_value_score,
  learn_value_reasons_json,
  CASE
    WHEN status='studied' THEN 'active'
    WHEN status='shortlisted' AND decided_by='user' THEN 'active'
    WHEN status='shortlisted' THEN 'new'
    ELSE status END,
  decided_by, decided_at, decided_reason,
  spy_run_id, lang_detected, lang_confidence, lang_evidence_json,
  first_seen_at, last_scored_at
FROM topic_channels;
DROP TABLE topic_channels;
ALTER TABLE topic_channels_v13 RENAME TO topic_channels;
CREATE INDEX idx_topic_channels_status_fit
  ON topic_channels(topic_id, status, fit_score DESC);
      `);

      // 4. loop_ticks — rebuild để đổi UNIQUE thành (topic_id, quota_day, mode);
      //    mọi tick cũ đều là nhịp ngày.
      this.database.exec(`
CREATE TABLE loop_ticks_v13 (
  tick_id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL,
  quota_day TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','done','failed','skipped_quota')),
  step TEXT NOT NULL DEFAULT 'expand',
  search_calls_used INTEGER NOT NULL DEFAULT 0,
  general_units_used INTEGER NOT NULL DEFAULT 0,
  search_baseline_calls INTEGER NOT NULL DEFAULT 0,
  general_baseline_units INTEGER NOT NULL DEFAULT 0,
  keywords_searched_json TEXT NOT NULL DEFAULT '[]',
  new_candidates INTEGER NOT NULL DEFAULT 0,
  new_shortlisted_auto INTEGER NOT NULL DEFAULT 0,
  scanned_channels INTEGER NOT NULL DEFAULT 0,
  keywords_harvested INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  mode TEXT NOT NULL DEFAULT 'daily' CHECK(mode IN ('setup','daily','weekly')),
  UNIQUE(topic_id, quota_day, mode)
);
INSERT INTO loop_ticks_v13 (
  tick_id, topic_id, quota_day, started_at, finished_at, status, step,
  search_calls_used, general_units_used, search_baseline_calls,
  general_baseline_units, keywords_searched_json, new_candidates,
  new_shortlisted_auto, scanned_channels, keywords_harvested, error, mode
)
SELECT
  tick_id, topic_id, quota_day, started_at, finished_at, status, step,
  search_calls_used, general_units_used, search_baseline_calls,
  general_baseline_units, keywords_searched_json, new_candidates,
  new_shortlisted_auto, scanned_channels, keywords_harvested, error, 'daily'
FROM loop_ticks;
DROP TABLE loop_ticks;
ALTER TABLE loop_ticks_v13 RENAME TO loop_ticks;
      `);

      // 5. daily_reports — chỉ cần cột mode + unique index theo mode (không có
      //    CHECK/UNIQUE trong bảng cũ nên không phải rebuild).
      try {
        this.database.exec(
          "ALTER TABLE daily_reports ADD COLUMN mode TEXT NOT NULL DEFAULT 'daily' CHECK(mode IN ('setup','daily','weekly'))",
        );
      } catch (error) {
        if (!/duplicate column name|already exists/i.test(String(error))) throw error;
      }
      this.database.exec('DROP INDEX IF EXISTS uq_daily_reports_topic_date');
      this.database.exec(
        "CREATE UNIQUE INDEX uq_daily_reports_topic_date ON daily_reports(COALESCE(topic_id, ''), report_date, mode)",
      );

      this.database.prepare('UPDATE schema_version SET version=?').run(13);
      this.database.exec('COMMIT');
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { /* preserve original error */ }
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  transaction<T>(work: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  reconcileInterruptedOperations(): number {
    const rows = this.database.prepare(
      `SELECT id FROM operations WHERE status IN ('queued', 'running')`,
    ).all() as Row[];
    if (rows.length > 0) {
      const now = nowIso();
      this.database.prepare(
        `UPDATE operations
         SET status='interrupted', error_code='interrupted',
             error_message='daemon restarted', completed_at=?
         WHERE status IN ('queued', 'running')`,
      ).run(now);
      this.database.prepare(
        `UPDATE spy_runs SET status='interrupted', completed_at=?
         WHERE status IN ('queued', 'running')`,
      ).run(now);
    }
    return rows.length;
  }

  createOrGetOperation(input: {
    kind: OperationKind;
    ownerSubject: string;
    idempotencyKey: string;
    request: unknown;
  }): { operation: Operation; created: boolean } {
    const existing = this.database.prepare(
      `SELECT * FROM operations
       WHERE owner_subject=? AND kind=? AND idempotency_key=?`,
    ).get(input.ownerSubject, input.kind, input.idempotencyKey) as Row | undefined;
    if (existing) {
      const operation = operationFromRow(existing);
      if (!['failed', 'cancelled', 'interrupted'].includes(operation.status)) {
        return { operation, created: false };
      }
      // Stale row from a previous failed/cancelled attempt — free the idempotency
      // slot (keeping the row itself, since other tables may reference its id) so a
      // legitimate retry with the same key runs fresh instead of returning the old
      // failure forever. NULL never collides with the UNIQUE(owner,kind,key) index.
      this.database.prepare('UPDATE operations SET idempotency_key=NULL WHERE id=?').run(operation.id);
    }
    const createdAt = nowIso();
    const id = randomUUID();
    this.database.prepare(
      `INSERT INTO operations
       (id,kind,owner_subject,status,idempotency_key,request_json,created_at,step)
       VALUES (?,?,?,'queued',?,?,?,'queued')`,
    ).run(id, input.kind, input.ownerSubject, input.idempotencyKey, JSON.stringify(input.request), createdAt);
    return { operation: this.getOperation(id)!, created: true };
  }

  getOperation(id: string): Operation | null {
    const row = this.database.prepare('SELECT * FROM operations WHERE id=?').get(id) as Row | undefined;
    return row ? operationFromRow(row) : null;
  }

  updateOperation(
    id: string,
    patch: Partial<Pick<Operation, 'status' | 'progress' | 'total' | 'step' | 'resultRef' | 'errorCode' | 'errorMessage'>>,
  ): Operation {
    const current = this.getOperation(id);
    if (!current) throw new AppError('not_found', 'Operation không tồn tại');
    const status = patch.status ?? current.status;
    const startedAt = status === 'running' && current.startedAt === null ? nowIso() : current.startedAt;
    const terminal = status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'interrupted';
    const completedAt = terminal ? nowIso() : current.completedAt;
    this.database.prepare(
      `UPDATE operations SET status=?,progress=?,total=?,step=?,result_ref=?,
       error_code=?,error_message=?,started_at=?,completed_at=? WHERE id=?`,
    ).run(
      status,
      patch.progress ?? current.progress,
      patch.total ?? current.total,
      patch.step ?? current.step,
      patch.resultRef ?? current.resultRef,
      patch.errorCode ?? current.errorCode,
      patch.errorMessage ?? current.errorMessage,
      startedAt,
      completedAt,
      id,
    );
    return this.getOperation(id)!;
  }

  createSpyRun(input: {
    operationId: string;
    kind: SpyRun['kind'];
    canonicalSource: string;
    sourceIdentity: string;
    config: unknown;
    scanLimit?: number | null;
    topN?: number | null;
  }): SpyRun {
    const id = randomUUID();
    this.database.prepare(
      `INSERT INTO spy_runs
       (id,operation_id,kind,canonical_source,source_identity,config_json,status,scan_limit,top_n,created_at)
       VALUES (?,?,?,?,?,?,'queued',?,?,?)`,
    ).run(
      id,
      input.operationId,
      input.kind,
      input.canonicalSource,
      input.sourceIdentity,
      JSON.stringify(input.config),
      input.scanLimit ?? null,
      input.topN ?? null,
      nowIso(),
    );
    return this.getSpyRun(id)!;
  }

  getSpyRun(id: string): SpyRun | null {
    const row = this.database.prepare('SELECT * FROM spy_runs WHERE id=?').get(id) as Row | undefined;
    return row ? spyRunFromRow(row) : null;
  }

  getSpyRunByOperation(operationId: string): SpyRun | null {
    const row = this.database.prepare('SELECT * FROM spy_runs WHERE operation_id=?').get(operationId) as Row | undefined;
    return row ? spyRunFromRow(row) : null;
  }

  listSpyRuns(kind?: SpyRun['kind'], limit = 100): SpyRun[] {
    const rows = kind
      ? this.database.prepare('SELECT * FROM spy_runs WHERE kind=? ORDER BY created_at DESC LIMIT ?').all(kind, limit) as Row[]
      : this.database.prepare('SELECT * FROM spy_runs ORDER BY created_at DESC LIMIT ?').all(limit) as Row[];
    return rows.map(spyRunFromRow);
  }

  updateSpyRun(id: string, patch: { status?: OperationStatus }): SpyRun {
    const current = this.getSpyRun(id);
    if (!current) throw new AppError('not_found', 'Spy run không tồn tại');
    const status = patch.status ?? current.status;
    const terminal = ['completed', 'failed', 'cancelled', 'interrupted'].includes(status);
    this.database.prepare(
      `UPDATE spy_runs SET status=?, completed_at=? WHERE id=?`,
    ).run(status, terminal ? nowIso() : current.completedAt, id);
    return this.getSpyRun(id)!;
  }

  /** Operation gắn với spy run (nếu còn). Dùng để huỷ trước khi xoá. */
  getSpyRunOperationId(id: string): string | null {
    const row = this.database.prepare('SELECT operation_id FROM spy_runs WHERE id=?').get(id) as Row | undefined;
    return row ? String(row['operation_id']) : null;
  }

  /**
   * Xoá một spy run + snapshot / segments / frames / metrics / profiles của run đó.
   * Giữ `video_transcripts` (chia sẻ theo source_video_id) và `channels` (chia sẻ).
   * Trả `false` nếu run không tồn tại.
   */
  deleteSpyRun(id: string): boolean {
    if (!this.getSpyRun(id)) return false;
    this.transaction(() => {
      const snapshots = this.database.prepare(
        'SELECT id FROM video_snapshots WHERE spy_run_id=?',
      ).all(id) as Array<{ id: string }>;
      for (const snap of snapshots) {
        const oldRows = this.database.prepare(
          'SELECT rowid FROM transcript_segments WHERE video_snapshot_id=?',
        ).all(snap.id) as Array<{ rowid: number }>;
        for (const row of oldRows) {
          this.database.prepare(
            'INSERT INTO transcript_fts(transcript_fts, rowid) VALUES ("delete", ?)',
          ).run(row.rowid);
        }
        this.database.prepare('DELETE FROM transcript_segments WHERE video_snapshot_id=?').run(snap.id);
        this.database.prepare('DELETE FROM frame_samples WHERE video_snapshot_id=?').run(snap.id);
      }
      this.database.prepare('DELETE FROM metrics WHERE spy_run_id=?').run(id);
      this.database.prepare('DELETE FROM profiles WHERE spy_run_id=?').run(id);
      this.database.prepare('DELETE FROM video_snapshots WHERE spy_run_id=?').run(id);
      this.database.prepare('DELETE FROM spy_runs WHERE id=?').run(id);
    });
    return true;
  }

  upsertChannel(
    input: Omit<ChannelRecord, 'id' | 'youtubeUcId' | 'handle'>
      & Partial<Pick<ChannelRecord, 'youtubeUcId' | 'handle'>>
      & { id?: string },
  ): ChannelRecord {
    const id = input.id ?? randomUUID();
    const youtubeUcId = input.youtubeUcId
      ?? (isResolvedYoutubeUcId(input.channelId) ? input.channelId : null);
    const handle = input.handle ?? handleAliasFromChannelId(input.channelId);

    // A resolved UC can arrive through a different legacy source identity
    // (for example `youtube:channel:/@name`). Keep the old row and enrich the
    // already-known row instead of creating a second channel record.
    if (youtubeUcId) {
      const existingAlias = this.database.prepare(
        'SELECT channel_id FROM channels WHERE youtube_uc_id=?',
      ).get(youtubeUcId) as Row | undefined;
      if (existingAlias && String(existingAlias['channel_id']) !== input.channelId) {
        this.database.prepare(
          `UPDATE channels SET title=?, subscriber_count=?, video_count=?, total_view_count=?, fetched_at=?, handle=COALESCE(?, handle)
           WHERE youtube_uc_id=?`,
        ).run(
          input.title,
          input.subscriberCount,
          input.videoCount,
          input.totalViewCount,
          input.fetchedAt,
          handle,
          youtubeUcId,
        );
        return this.getChannelByYoutubeUcId(youtubeUcId)!;
      }
    }
    this.database.prepare(
      `INSERT INTO channels (id, channel_id, youtube_uc_id, handle, title, subscriber_count, video_count, total_view_count, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel_id) DO UPDATE SET
         youtube_uc_id=COALESCE(excluded.youtube_uc_id, channels.youtube_uc_id),
         handle=COALESCE(excluded.handle, channels.handle),
         title=excluded.title,
         subscriber_count=excluded.subscriber_count,
         video_count=excluded.video_count,
         total_view_count=excluded.total_view_count,
         fetched_at=excluded.fetched_at`,
    ).run(
      id,
      input.channelId,
      youtubeUcId,
      handle,
      input.title,
      input.subscriberCount,
      input.videoCount,
      input.totalViewCount,
      input.fetchedAt,
    );
    return this.getChannel(input.channelId)!;
  }

  getChannel(channelId: string): ChannelRecord | null {
    const row = this.database.prepare(
      'SELECT * FROM channels WHERE channel_id=? OR youtube_uc_id=? ORDER BY CASE WHEN channel_id=? THEN 0 ELSE 1 END LIMIT 1',
    ).get(channelId, channelId, channelId) as Row | undefined;
    if (!row) return null;
    return channelFromRow(row);
  }

  getChannelByYoutubeUcId(youtubeUcId: string): ChannelRecord | null {
    const row = this.database.prepare('SELECT * FROM channels WHERE youtube_uc_id=?').get(youtubeUcId) as Row | undefined;
    return row ? channelFromRow(row) : null;
  }

  listChannels(limit = 100): ChannelRecord[] {
    const rows = this.database.prepare('SELECT * FROM channels ORDER BY fetched_at DESC LIMIT ?').all(limit) as Row[];
    return rows.map(channelFromRow);
  }

  insertVideoSnapshot(snapshot: VideoSnapshot): void {
    this.database.prepare(
      `INSERT INTO video_snapshots
       (id,spy_run_id,source_video_id,canonical_url,title,channel_title,rank,
        view_count,like_count,comment_count,duration_sec,published_at,tags_json,
        transcript_status,transcript_source,frame_status,thumbnail_json,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      snapshot.id,
      snapshot.spyRunId,
      snapshot.sourceVideoId,
      snapshot.canonicalUrl,
      snapshot.title,
      snapshot.channelTitle,
      snapshot.rank,
      snapshot.viewCount,
      snapshot.likeCount,
      snapshot.commentCount,
      snapshot.durationSec,
      snapshot.publishedAt,
      JSON.stringify(snapshot.tags),
      snapshot.transcriptStatus,
      snapshot.transcriptSource,
      snapshot.frameStatus,
      snapshot.thumbnail ? JSON.stringify(snapshot.thumbnail) : null,
      snapshot.createdAt,
    );
  }

  /**
   * Attributes every video_snapshots row of a run to a channel (v10, C1-style
   * clustering fix — see the schema comment above video_snapshots.channel_id).
   * Deliberately a separate bulk UPDATE rather than a column on
   * `insertVideoSnapshot`: a run's channel is only known AFTER metadata is
   * captured and enrichChannel() has resolved/upserted the channels row, so
   * callers set it once, after the fact, for the whole run.
   */
  setVideoSnapshotsChannelId(spyRunId: string, channelId: string): void {
    this.database.prepare('UPDATE video_snapshots SET channel_id=? WHERE spy_run_id=?').run(channelId, spyRunId);
  }

  /** Test/debug helper — channel_id is intentionally not part of the VideoSnapshot read model. */
  getVideoSnapshotsChannelIds(spyRunId: string): Array<string | null> {
    const rows = this.database.prepare(
      'SELECT channel_id FROM video_snapshots WHERE spy_run_id=? ORDER BY rank,id',
    ).all(spyRunId) as Row[];
    return rows.map((row) => nullableString(row['channel_id']));
  }

  updateVideoSnapshot(
    id: string,
    patch: Partial<Pick<VideoSnapshot,
      'viewCount' | 'likeCount' | 'commentCount' | 'publishedAt' | 'tags'
      | 'transcriptStatus' | 'transcriptSource' | 'frameStatus' | 'thumbnail'
    >>,
  ): VideoSnapshot {
    const current = this.getVideoSnapshot(id);
    if (!current) throw new AppError('not_found', 'Video snapshot không tồn tại');
    this.database.prepare(
      `UPDATE video_snapshots SET
       view_count=?, like_count=?, comment_count=?, published_at=?, tags_json=?,
       transcript_status=?, transcript_source=?, frame_status=?, thumbnail_json=?
       WHERE id=?`,
    ).run(
      patch.viewCount ?? current.viewCount,
      patch.likeCount ?? current.likeCount,
      patch.commentCount ?? current.commentCount,
      patch.publishedAt ?? current.publishedAt,
      JSON.stringify(patch.tags ?? current.tags),
      patch.transcriptStatus ?? current.transcriptStatus,
      patch.transcriptSource ?? current.transcriptSource,
      patch.frameStatus ?? current.frameStatus,
      patch.thumbnail === undefined
        ? (current.thumbnail ? JSON.stringify(current.thumbnail) : null)
        : (patch.thumbnail ? JSON.stringify(patch.thumbnail) : null),
      id,
    );
    return this.getVideoSnapshot(id)!;
  }

  patchVideoDuration(id: string, durationSec: number): void {
    this.database.prepare('UPDATE video_snapshots SET duration_sec=? WHERE id=?').run(durationSec, id);
  }

  getVideoSnapshot(id: string): VideoSnapshot | null {
    const row = this.database.prepare('SELECT * FROM video_snapshots WHERE id=?').get(id) as Row | undefined;
    return row ? videoSnapshotFromRow(row) : null;
  }

  getVideoSnapshotBySourceId(spyRunId: string, sourceVideoId: string): VideoSnapshot | null {
    const row = this.database.prepare(
      'SELECT * FROM video_snapshots WHERE spy_run_id=? AND source_video_id=?',
    ).get(spyRunId, sourceVideoId) as Row | undefined;
    return row ? videoSnapshotFromRow(row) : null;
  }

  listVideoSnapshots(spyRunId: string): VideoSnapshot[] {
    const rows = this.database.prepare(
      'SELECT * FROM video_snapshots WHERE spy_run_id=? ORDER BY rank,id',
    ).all(spyRunId) as Row[];
    return rows.map(videoSnapshotFromRow);
  }

  /** Caller must already be inside a this.transaction() — not re-entrant on its own. */
  private insertTranscriptSegmentsInner(segments: readonly TranscriptSegment[]): void {
    const statement = this.database.prepare(
      `INSERT INTO transcript_segments
       (id,video_snapshot_id,video_transcript_id,segment_index,start_sec,end_sec,text,source,language,content_hash)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const segment of segments) {
      statement.run(
        segment.id,
        segment.videoSnapshotId,
        segment.videoTranscriptId ?? null,
        segment.index,
        segment.startSec,
        segment.endSec,
        segment.text,
        segment.source,
        segment.language,
        segment.contentHash,
      );
      this.database.prepare(
        `INSERT INTO transcript_fts(rowid, text)
         SELECT rowid, text FROM transcript_segments WHERE id=?`,
      ).run(segment.id);
    }
  }

  insertTranscriptSegments(segments: readonly TranscriptSegment[]): void {
    this.transaction(() => this.insertTranscriptSegmentsInner(segments));
  }

  replaceTranscriptSegments(videoSnapshotId: string, segments: readonly TranscriptSegment[]): void {
    // Delete + insert in one transaction — a crash between two separate transactions
    // would otherwise leave transcript_status:'ok' pointing at zero segments.
    this.transaction(() => {
      const oldRows = this.database.prepare(
        'SELECT rowid FROM transcript_segments WHERE video_snapshot_id=?',
      ).all(videoSnapshotId) as Array<{ rowid: number }>;
      for (const row of oldRows) {
        this.database.prepare('INSERT INTO transcript_fts(transcript_fts, rowid) VALUES ("delete", ?)').run(row.rowid);
      }
      this.database.prepare('DELETE FROM transcript_segments WHERE video_snapshot_id=?').run(videoSnapshotId);
      this.insertTranscriptSegmentsInner(segments);
    });
  }

  listSnapshotsBySourceVideoId(sourceVideoId: string): VideoSnapshot[] {
    const rows = this.database.prepare(
      'SELECT * FROM video_snapshots WHERE source_video_id=? ORDER BY created_at DESC',
    ).all(sourceVideoId) as Row[];
    return rows.map(videoSnapshotFromRow);
  }

  upsertVideoTranscript(transcript: VideoTranscript): void {
    // Two keys can collide here: the primary key, because a refetch reuses the previous
    // row's id, and the natural key (video, language, source). A refetch that resolves to
    // a *different* track — say the manual `vi` subtitles instead of the auto `vi-orig`
    // ones — changes the natural key while keeping the id, so a single ON CONFLICT target
    // cannot absorb it and the insert fails on the primary key. Clearing both candidates
    // first also retires the row for the track we are moving away from.
    // transcript_segments.video_transcript_id carries no foreign key, so segments written
    // by the caller afterwards remain intact.
    this.database.transaction(() => {
      this.database.prepare(
        `DELETE FROM video_transcripts
         WHERE id = ? OR (source_video_id = ? AND language = ? AND source = ?)`,
      ).run(transcript.id, transcript.sourceVideoId, transcript.language, transcript.source);
      this.database.prepare(
        `INSERT INTO video_transcripts
         (id, source_video_id, language, source, content_hash, fetched_at, normalized_text, normalized_at, normalize_model)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        transcript.id,
        transcript.sourceVideoId,
        transcript.language,
        transcript.source,
        transcript.contentHash,
        transcript.fetchedAt,
        transcript.normalizedText,
        transcript.normalizedAt,
        transcript.normalizeModel,
      );
    })();
  }

  getVideoTranscript(sourceVideoId: string, prefer: 'manual' | 'any' = 'any'): VideoTranscript | null {
    const rows = this.database.prepare(
      `SELECT * FROM video_transcripts WHERE source_video_id=?
       ORDER BY CASE source WHEN 'manual' THEN 0 WHEN 'auto' THEN 1 ELSE 2 END, fetched_at DESC`,
    ).all(sourceVideoId) as Row[];
    const row = prefer === 'manual'
      ? rows.find((r) => r['source'] === 'manual') ?? rows[0]
      : rows[0];
    if (!row) return null;
    return videoTranscriptFromRow(row);
  }

  saveNormalizedTranscript(videoTranscriptId: string, text: string, model: string): void {
    this.database.prepare(
      `UPDATE video_transcripts SET normalized_text=?, normalized_at=?, normalize_model=? WHERE id=?`,
    ).run(text, nowIso(), model, videoTranscriptId);
  }

  /**
   * Idempotent on `id` (the YouTube commentId) — re-fetching the same video's
   * comments refreshes like_count/text/etc. in place instead of duplicating rows.
   */
  upsertVideoComments(comments: readonly VideoCommentRecord[]): void {
    if (comments.length === 0) return;
    const statement = this.database.prepare(`
      INSERT INTO video_comments
        (id, source_video_id, channel_id, parent_comment_id, author_display_name,
         text, like_count, published_at, updated_at, fetched_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        source_video_id=excluded.source_video_id,
        channel_id=excluded.channel_id,
        parent_comment_id=excluded.parent_comment_id,
        author_display_name=excluded.author_display_name,
        text=excluded.text,
        like_count=excluded.like_count,
        published_at=excluded.published_at,
        updated_at=excluded.updated_at,
        fetched_at=excluded.fetched_at`);
    this.transaction(() => {
      for (const comment of comments) {
        statement.run(
          comment.id,
          comment.sourceVideoId,
          comment.channelId,
          comment.parentCommentId,
          comment.authorDisplayName,
          comment.text,
          comment.likeCount,
          comment.publishedAt,
          comment.updatedAt,
          comment.fetchedAt,
        );
      }
    });
  }

  listVideoComments(sourceVideoId: string, limit = 500): VideoCommentRecord[] {
    const rows = this.database.prepare(
      'SELECT * FROM video_comments WHERE source_video_id=? ORDER BY published_at DESC LIMIT ?',
    ).all(sourceVideoId, limit) as Row[];
    return rows.map(videoCommentFromRow);
  }

  listTranscriptSegmentsBySourceVideoId(sourceVideoId: string): TranscriptSegment[] {
    const snapshot = this.listSnapshotsBySourceVideoId(sourceVideoId)[0];
    if (!snapshot) return [];
    return this.listTranscriptSegments(snapshot.id, 0, 100_000);
  }

  searchTranscriptFts(input: {
    query: string;
    sourceVideoIds?: string[];
    channelId?: string;
    limit?: number;
  }): Array<{
    sourceVideoId: string;
    startSec: number;
    endSec: number;
    snippet: string;
    segmentId: string;
  }> {
    const limit = input.limit ?? 20;
    const safe = input.query.replace(/"/g, '""');
    let sql = `
      SELECT ts.id, ts.start_sec, ts.end_sec, ts.text, vs.source_video_id
      FROM transcript_fts fts
      JOIN transcript_segments ts ON ts.rowid = fts.rowid
      JOIN video_snapshots vs ON vs.id = ts.video_snapshot_id
      WHERE transcript_fts MATCH ?
    `;
    const params: Array<string | number> = [safe];
    if (input.sourceVideoIds?.length) {
      sql += ` AND vs.source_video_id IN (${input.sourceVideoIds.map(() => '?').join(',')})`;
      params.push(...input.sourceVideoIds);
    }
    if (input.channelId) {
      sql += ` AND vs.spy_run_id IN (
        SELECT id FROM spy_runs WHERE source_identity LIKE ? OR canonical_source LIKE ? OR id=?
      )`;
      params.push(`%${input.channelId}%`, `%${input.channelId}%`, input.channelId);
    }
    sql += ' LIMIT ?';
    params.push(limit);
    try {
      const rows = this.database.prepare(sql).all(...params) as Row[];
      return rows.map((row) => ({
        sourceVideoId: String(row['source_video_id']),
        startSec: Number(row['start_sec']),
        endSec: Number(row['end_sec']),
        snippet: String(row['text']),
        segmentId: String(row['id']),
      }));
    } catch {
      const like = `%${input.query}%`;
      const rows = this.database.prepare(
        `SELECT ts.id, ts.start_sec, ts.end_sec, ts.text, vs.source_video_id
         FROM transcript_segments ts
         JOIN video_snapshots vs ON vs.id = ts.video_snapshot_id
         WHERE ts.text LIKE ?
         LIMIT ?`,
      ).all(like, limit) as Row[];
      return rows.map((row) => ({
        sourceVideoId: String(row['source_video_id']),
        startSec: Number(row['start_sec']),
        endSec: Number(row['end_sec']),
        snippet: String(row['text']),
        segmentId: String(row['id']),
      }));
    }
  }

  listTranscriptSegments(videoSnapshotId: string, offset = 0, limit = 500): TranscriptSegment[] {
    const rows = this.database.prepare(
      `SELECT * FROM transcript_segments WHERE video_snapshot_id=?
       ORDER BY segment_index LIMIT ? OFFSET ?`,
    ).all(videoSnapshotId, limit, offset) as Row[];
    return rows.map((row) => ({
      id: String(row['id']),
      videoSnapshotId: String(row['video_snapshot_id']),
      index: Number(row['segment_index']),
      startSec: Number(row['start_sec']),
      endSec: Number(row['end_sec']),
      text: String(row['text']),
      source: String(row['source']),
      language: nullableString(row['language']),
      contentHash: String(row['content_hash']),
    }));
  }

  getTranscriptSegment(id: string): TranscriptSegment | null {
    const row = this.database.prepare('SELECT * FROM transcript_segments WHERE id=?').get(id) as Row | undefined;
    if (!row) return null;
    return {
      id: String(row['id']),
      videoSnapshotId: String(row['video_snapshot_id']),
      index: Number(row['segment_index']),
      startSec: Number(row['start_sec']),
      endSec: Number(row['end_sec']),
      text: String(row['text']),
      source: String(row['source']),
      language: nullableString(row['language']),
      contentHash: String(row['content_hash']),
    };
  }

  transcriptSegmentCount(videoSnapshotId: string): number {
    const row = this.database.prepare(
      'SELECT COUNT(*) AS count FROM transcript_segments WHERE video_snapshot_id=?',
    ).get(videoSnapshotId) as Row;
    return Number(row['count']);
  }

  insertFrameSamples(frames: readonly FrameSample[]): void {
    const statement = this.database.prepare(
      `INSERT INTO frame_samples
       (id,video_snapshot_id,frame_index,timestamp_sec,dhash,artifact_json)
       VALUES (?,?,?,?,?,?)`,
    );
    this.transaction(() => {
      for (const frame of frames) {
        statement.run(
          frame.id,
          frame.videoSnapshotId,
          frame.index,
          frame.timestampSec,
          frame.dhash,
          JSON.stringify(frame.artifact),
        );
      }
    });
  }

  listFrameSamples(videoSnapshotId: string, offset = 0, limit = 100): FrameSample[] {
    const rows = this.database.prepare(
      `SELECT * FROM frame_samples WHERE video_snapshot_id=?
       ORDER BY frame_index LIMIT ? OFFSET ?`,
    ).all(videoSnapshotId, limit, offset) as Row[];
    return rows.map((row) => ({
      id: String(row['id']),
      videoSnapshotId: String(row['video_snapshot_id']),
      index: Number(row['frame_index']),
      timestampSec: Number(row['timestamp_sec']),
      dhash: String(row['dhash']),
      artifact: parseJson<ArtifactRef>(row['artifact_json']),
    }));
  }

  getFrameSample(id: string): FrameSample | null {
    const row = this.database.prepare('SELECT * FROM frame_samples WHERE id=?').get(id) as Row | undefined;
    if (!row) return null;
    return {
      id: String(row['id']),
      videoSnapshotId: String(row['video_snapshot_id']),
      index: Number(row['frame_index']),
      timestampSec: Number(row['timestamp_sec']),
      dhash: String(row['dhash']),
      artifact: parseJson<ArtifactRef>(row['artifact_json']),
    };
  }

  frameSampleCount(videoSnapshotId: string): number {
    const row = this.database.prepare(
      'SELECT COUNT(*) AS count FROM frame_samples WHERE video_snapshot_id=?',
    ).get(videoSnapshotId) as Row;
    return Number(row['count']);
  }

  saveMetrics(input: {
    scope: string;
    scopeId: string;
    spyRunId: string;
    payload: unknown;
  }): string {
    const id = randomUUID();
    this.database.prepare(
      `INSERT INTO metrics (id, scope, scope_id, spy_run_id, payload_json, computed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, input.scope, input.scopeId, input.spyRunId, JSON.stringify(input.payload), nowIso());
    return id;
  }

  getLatestMetrics(scope: string, scopeId: string): { id: string; payload: unknown; computedAt: string; spyRunId: string } | null {
    const row = this.database.prepare(
      `SELECT * FROM metrics WHERE scope=? AND scope_id=? ORDER BY computed_at DESC LIMIT 1`,
    ).get(scope, scopeId) as Row | undefined;
    if (!row) return null;
    return {
      id: String(row['id']),
      payload: parseJson<unknown>(row['payload_json']),
      computedAt: String(row['computed_at']),
      spyRunId: String(row['spy_run_id']),
    };
  }

  /** Lấy metrics mới nhất cho nhiều scopeId một lượt — tránh N+1 khi enrich corpus. */
  getLatestMetricsBatch(scope: string, scopeIds: readonly string[]): Map<string, unknown> {
    const result = new Map<string, unknown>();
    if (scopeIds.length === 0) return result;
    const rows = this.database.prepare(`
      SELECT scope_id, payload_json FROM (
        SELECT scope_id, payload_json,
          ROW_NUMBER() OVER (PARTITION BY scope_id ORDER BY computed_at DESC) AS rn
        FROM metrics
        WHERE scope = ? AND scope_id IN (${scopeIds.map(() => '?').join(',')})
      ) WHERE rn = 1`).all(scope, ...scopeIds) as Row[];
    for (const row of rows) {
      result.set(String(row['scope_id']), parseJson<unknown>(row['payload_json']));
    }
    return result;
  }

  saveProfile(input: {
    scope: string;
    scopeId: string;
    spyRunId: string;
    kind: string;
    payload: unknown;
    evidence: unknown;
    model: string | null;
  }): string {
    const id = randomUUID();
    this.database.prepare(
      `INSERT INTO profiles (id, scope, scope_id, spy_run_id, kind, payload_json, evidence_json, model, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.scope,
      input.scopeId,
      input.spyRunId,
      input.kind,
      JSON.stringify(input.payload),
      JSON.stringify(input.evidence),
      input.model,
      nowIso(),
    );
    return id;
  }

  // ---------------------------------------------------------------------------
  // v4 — Quota ledger
  // ---------------------------------------------------------------------------

  getQuotaUsage(bucket: string, quotaDay: string): { units: number; calls: number } {
    const row = this.database.prepare(
      'SELECT units, calls FROM api_quota_usage WHERE bucket=? AND quota_day=?',
    ).get(bucket, quotaDay) as Row | undefined;
    return row ? { units: Number(row['units']), calls: Number(row['calls']) } : { units: 0, calls: 0 };
  }

  addQuotaUsage(bucket: string, quotaDay: string, units: number, calls = 1): { units: number; calls: number } {
    this.database.prepare(
      `INSERT INTO api_quota_usage (bucket, quota_day, units, calls, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(bucket, quota_day) DO UPDATE SET
         units = units + excluded.units,
         calls = calls + excluded.calls,
         updated_at = excluded.updated_at`,
    ).run(bucket, quotaDay, units, calls, nowIso());
    return this.getQuotaUsage(bucket, quotaDay);
  }

  /** Lịch sử tiêu quota, mới nhất trước — để nhìn xu hướng ngày qua ngày. */
  listQuotaUsage(limit = 14): Array<{ bucket: string; quotaDay: string; units: number; calls: number }> {
    const rows = this.database.prepare(
      'SELECT * FROM api_quota_usage ORDER BY quota_day DESC, bucket ASC LIMIT ?',
    ).all(limit) as Row[];
    return rows.map((row) => ({
      bucket: String(row['bucket']),
      quotaDay: String(row['quota_day']),
      units: Number(row['units']),
      calls: Number(row['calls']),
    }));
  }

  // ---------------------------------------------------------------------------
  // v12 — Per-key quota tracking
  // ---------------------------------------------------------------------------

  getQuotaUsagePerKey(keyId: string, bucket: string, quotaDay: string): { units: number; calls: number } {
    const row = this.database.prepare(
      'SELECT units, calls FROM api_quota_usage_per_key WHERE key_id=? AND bucket=? AND quota_day=?',
    ).get(keyId, bucket, quotaDay) as Row | undefined;
    return row ? { units: Number(row['units']), calls: Number(row['calls']) } : { units: 0, calls: 0 };
  }

  addQuotaUsagePerKey(keyId: string, bucket: string, quotaDay: string, units: number, calls = 1): { units: number; calls: number } {
    this.database.prepare(
      `INSERT INTO api_quota_usage_per_key (key_id, bucket, quota_day, units, calls, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(key_id, bucket, quota_day) DO UPDATE SET
         units = units + excluded.units,
         calls = calls + excluded.calls,
         updated_at = excluded.updated_at`,
    ).run(keyId, bucket, quotaDay, units, calls, nowIso());
    // Also update aggregate table for backward compatibility
    this.addQuotaUsage(bucket, quotaDay, units, calls);
    return this.getQuotaUsagePerKey(keyId, bucket, quotaDay);
  }

  listQuotaUsagePerKey(quotaDay: string): Array<{ keyId: string; bucket: string; units: number; calls: number }> {
    const rows = this.database.prepare(
      'SELECT * FROM api_quota_usage_per_key WHERE quota_day=? ORDER BY key_id, bucket',
    ).all(quotaDay) as Row[];
    return rows.map((row) => ({
      keyId: String(row['key_id']),
      bucket: String(row['bucket']),
      units: Number(row['units']),
      calls: Number(row['calls']),
    }));
  }

  // ---------------------------------------------------------------------------
  // v4 — Candidate channels
  // ---------------------------------------------------------------------------

  /**
   * Ghi ứng viên. Không đè `status` và `first_seen_at` của bản ghi cũ —
   * một kênh đã bị reject không được âm thầm quay lại 'new' ở lần discovery sau.
   */
  upsertCandidate(input: CandidateChannelInput): { created: boolean } {
    const now = nowIso();
    const result = this.database.prepare(
      `INSERT INTO candidate_channels (
         channel_id, title, handle, market, discovered_via, discovered_from,
         subscriber_count, video_count, view_count, country, published_at, description,
         fit_score, fit_reasons_json, status, first_seen_at, refreshed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)
       ON CONFLICT(channel_id) DO UPDATE SET
         title=COALESCE(excluded.title, title),
         handle=COALESCE(excluded.handle, handle),
         market=COALESCE(excluded.market, market),
         subscriber_count=COALESCE(excluded.subscriber_count, subscriber_count),
         video_count=COALESCE(excluded.video_count, video_count),
         view_count=COALESCE(excluded.view_count, view_count),
         country=COALESCE(excluded.country, country),
         published_at=COALESCE(excluded.published_at, published_at),
         description=COALESCE(excluded.description, description),
         fit_score=COALESCE(excluded.fit_score, fit_score),
         fit_reasons_json=excluded.fit_reasons_json,
         refreshed_at=excluded.refreshed_at`,
    ).run(
      input.channelId,
      input.title ?? null,
      input.handle ?? null,
      input.market ?? null,
      input.discoveredVia,
      input.discoveredFrom ?? null,
      input.subscriberCount ?? null,
      input.videoCount ?? null,
      input.viewCount ?? null,
      input.country ?? null,
      input.publishedAt ?? null,
      input.description ?? null,
      input.fitScore ?? null,
      JSON.stringify(input.fitReasons ?? []),
      now,
      now,
    );
    return { created: Number(result.changes) === 1 };
  }

  hasCandidate(channelId: string): boolean {
    const row = this.database.prepare('SELECT 1 FROM candidate_channels WHERE channel_id=?').get(channelId);
    return Boolean(row);
  }

  listCandidates(filter: {
    status?: string;
    market?: string;
    minFitScore?: number;
    minSubscribers?: number;
    maxSubscribers?: number;
    discoveredVia?: string;
    limit?: number;
    cursor?: number;
  } = {}): CandidateChannel[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filter.status) { where.push('status=?'); params.push(filter.status); }
    if (filter.market) { where.push('market=?'); params.push(filter.market); }
    if (filter.discoveredVia) { where.push('discovered_via=?'); params.push(filter.discoveredVia); }
    if (filter.minFitScore !== undefined) { where.push('fit_score >= ?'); params.push(filter.minFitScore); }
    if (filter.minSubscribers !== undefined) {
      where.push('subscriber_count >= ?'); params.push(filter.minSubscribers);
    }
    if (filter.maxSubscribers !== undefined) {
      where.push('subscriber_count <= ?'); params.push(filter.maxSubscribers);
    }
    const sql = `SELECT * FROM candidate_channels
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY fit_score DESC NULLS LAST, first_seen_at ASC
      LIMIT ? OFFSET ?`;
    params.push(filter.limit ?? 50, filter.cursor ?? 0);
    return (this.database.prepare(sql).all(...params) as Row[]).map(candidateFromRow);
  }

  countCandidatesByStatus(): Record<string, number> {
    const rows = this.database.prepare(
      'SELECT status, COUNT(*) AS n FROM candidate_channels GROUP BY status',
    ).all() as Row[];
    return Object.fromEntries(rows.map((row) => [String(row['status']), Number(row['n'])]));
  }

  setCandidateStatus(channelIds: readonly string[], status: string): string[] {
    const updated: string[] = [];
    const statement = this.database.prepare(
      'UPDATE candidate_channels SET status=?, refreshed_at=? WHERE channel_id=?',
    );
    const now = nowIso();
    for (const channelId of channelIds) {
      if (Number(statement.run(status, now, channelId).changes) > 0) updated.push(channelId);
    }
    return updated;
  }

  // ---------------------------------------------------------------------------
  // v4 — Corpus search (0 quota: chỉ đọc DB đã quét)
  // ---------------------------------------------------------------------------

  /**
   * Tìm video xuyên TOÀN BỘ corpus, không giới hạn trong một spy run.
   * Mỗi source_video_id chỉ trả bản snapshot mới nhất (video quét lại nhiều lần
   * sinh nhiều dòng — trước đây không có chỗ nào khử trùng lặp).
   */
  searchCorpusVideos(filter: CorpusVideoFilter = {}): CorpusVideoRow[] {
    const where: string[] = ['rn = 1'];
    const params: Array<string | number> = [];
    if (filter.titleQuery) { where.push('LOWER(title) LIKE ?'); params.push(`%${filter.titleQuery.toLowerCase()}%`); }
    if (filter.channelIds?.length) {
      // channels.channel_id (joined via video_snapshots.channel_id, same as
      // corpusChannelStats()) is canonicalised the same way spy_runs.source_identity
      // used to be ('youtube:channel:/channel/ucxxx', lowercase), while a real
      // YouTube channel ID is mixed-case ('UCxxx'). Match both forms, or a
      // filter by the real channel_id would always come back empty.
      const clauses = filter.channelIds.map(() => '(channel_key = ? OR LOWER(channel_key) LIKE ?)');
      where.push(`(${clauses.join(' OR ')})`);
      for (const channelId of filter.channelIds) {
        params.push(channelId, `%${channelId.toLowerCase()}%`);
      }
    }
    if (filter.sourceVideoIds?.length) {
      where.push(`source_video_id IN (${filter.sourceVideoIds.map(() => '?').join(',')})`);
      params.push(...filter.sourceVideoIds);
    }
    if (filter.minViews !== undefined) { where.push('view_count >= ?'); params.push(filter.minViews); }
    if (filter.maxViews !== undefined) { where.push('view_count <= ?'); params.push(filter.maxViews); }
    if (filter.minDurationSec !== undefined) { where.push('duration_sec >= ?'); params.push(filter.minDurationSec); }
    if (filter.maxDurationSec !== undefined) { where.push('duration_sec <= ?'); params.push(filter.maxDurationSec); }
    if (filter.publishedAfter) { where.push('published_at >= ?'); params.push(filter.publishedAfter); }
    if (filter.publishedBefore) { where.push('published_at <= ?'); params.push(filter.publishedBefore); }
    if (filter.hasTranscript === true) { where.push("transcript_status = 'ok'"); }
    if (filter.hasTranscript === false) { where.push("transcript_status != 'ok'"); }
    if (filter.minVelocity !== undefined) { where.push('velocity >= ?'); params.push(filter.minVelocity); }

    const orderColumn = {
      views: 'view_count',
      velocity: 'velocity',
      published_at: 'published_at',
      duration: 'duration_sec',
      engagement: 'engagement',
    }[filter.orderBy ?? 'velocity'];
    const direction = filter.direction === 'asc' ? 'ASC' : 'DESC';

    const sql = `
      SELECT * FROM (
        SELECT
          vs.id, vs.source_video_id, vs.title, vs.channel_title, vs.canonical_url,
          vs.view_count, vs.like_count, vs.comment_count, vs.duration_sec,
          vs.published_at, vs.transcript_status, vs.created_at,
          -- video_snapshots.channel_id (schema v10, see the comment above that
          -- column) is the real FK; a channel scan or a video-level run that
          -- resolved a channel sets it. NULL — an unattributed video-level run
          -- — deliberately becomes '' here rather than falling back to
          -- spy_runs.source_identity: that old rule is the exact bug this
          -- fixes (see the video_snapshots.channel_id comment for the
          -- Hidden Yield incident), so a video without a real channel
          -- attribution must read as "unknown channel", never as a guess.
          COALESCE(c.channel_id, '') AS channel_key,
          CAST(vs.view_count AS REAL) / MAX(1.0, julianday('now') - julianday(COALESCE(vs.published_at, vs.created_at))) AS velocity,
          CASE WHEN vs.view_count > 0
            THEN (COALESCE(vs.like_count, 0) + COALESCE(vs.comment_count, 0)) * 1.0 / vs.view_count
            ELSE 0 END AS engagement,
          ROW_NUMBER() OVER (PARTITION BY vs.source_video_id ORDER BY vs.created_at DESC, vs.rowid DESC) AS rn
        FROM video_snapshots vs
        LEFT JOIN channels c ON c.id = vs.channel_id
      )
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderColumn} ${direction}
      LIMIT ? OFFSET ?`;
    params.push(filter.limit ?? 50, filter.cursor ?? 0);

    return (this.database.prepare(sql).all(...params) as Row[]).map((row) => ({
      videoSnapshotId: String(row['id']),
      sourceVideoId: String(row['source_video_id']),
      title: String(row['title']),
      channelTitle: String(row['channel_title']),
      channelKey: String(row['channel_key']),
      url: String(row['canonical_url']),
      viewCount: Number(row['view_count']),
      likeCount: row['like_count'] === null ? null : Number(row['like_count']),
      commentCount: row['comment_count'] === null ? null : Number(row['comment_count']),
      durationSec: Number(row['duration_sec']),
      publishedAt: nullableString(row['published_at']),
      velocity: Number(row['velocity']),
      engagement: Number(row['engagement']),
      hasTranscript: String(row['transcript_status']) === 'ok',
    }));
  }

  /** Thống kê corpus theo kênh — đếm trên snapshot mới nhất của mỗi video. */
  corpusChannelStats(): CorpusChannelRow[] {
    // Grouped by video_snapshots.channel_id (a real FK to channels.id), not by
    // "which spy_run produced this video's newest row" — see the schema
    // comment above video_snapshots.channel_id for why the old rule
    // (ROW_NUMBER by created_at across ALL runs regardless of kind) silently
    // stole videos out of their channel's cluster whenever a later run (a
    // lone spy_video_start, or — before search got its own cache tables — a
    // hypothetical search write) touched an already-scanned video.
    //
    // `WHERE vs.channel_id IS NOT NULL` in the inner query is load-bearing:
    // it removes channel-unattributed snapshots from the ROW_NUMBER window
    // entirely, so such a row can never win "latest" and mask a properly
    // attributed one — a video that briefly loses its channel_id (or never
    // had one) simply drops out of every channel's stats instead of
    // corrupting one.
    const rows = this.database.prepare(`
      SELECT
        channel_key,
        MAX(channel_title) AS channel_title,
        COUNT(*) AS video_count,
        SUM(view_count) AS total_views,
        AVG(view_count) AS avg_views,
        MAX(view_count) AS max_views,
        MIN(published_at) AS first_published,
        MAX(published_at) AS last_published,
        AVG(duration_sec) AS avg_duration_sec,
        SUM(CASE WHEN transcript_status = 'ok' THEN 1 ELSE 0 END) AS with_transcript
      FROM (
        SELECT vs.*, c.channel_id AS channel_key,
          ROW_NUMBER() OVER (PARTITION BY vs.source_video_id ORDER BY vs.created_at DESC, vs.rowid DESC) AS rn
        FROM video_snapshots vs
        JOIN channels c ON c.id = vs.channel_id
        WHERE vs.channel_id IS NOT NULL
      )
      WHERE rn = 1
      GROUP BY channel_key
      ORDER BY avg_views DESC`).all() as Row[];
    return rows.map((row) => ({
      channelKey: String(row['channel_key']),
      channelTitle: String(row['channel_title'] ?? ''),
      videoCount: Number(row['video_count']),
      totalViews: Number(row['total_views'] ?? 0),
      avgViews: Number(row['avg_views'] ?? 0),
      maxViews: Number(row['max_views'] ?? 0),
      firstPublished: nullableString(row['first_published']),
      lastPublished: nullableString(row['last_published']),
      avgDurationSec: Number(row['avg_duration_sec'] ?? 0),
      withTranscript: Number(row['with_transcript'] ?? 0),
    }));
  }

  listCompetitors(ownerChannelId: string): Array<{
    competitorChannelId: string;
    note: string | null;
    createdAt: string;
  }> {
    const rows = this.database.prepare(
      `SELECT competitor_channel_id, note, created_at FROM competitors
       WHERE owner_channel_id=? ORDER BY created_at ASC`,
    ).all(ownerChannelId) as Row[];
    return rows.map((row) => ({
      competitorChannelId: String(row['competitor_channel_id']),
      note: nullableString(row['note']),
      createdAt: String(row['created_at']),
    }));
  }

  /** Idempotent: follow lại kênh đã có không tạo bản ghi trùng. */
  addCompetitor(ownerChannelId: string, competitorChannelId: string, note?: string): boolean {
    const result = this.database.prepare(
      `INSERT OR IGNORE INTO competitors (id, owner_channel_id, competitor_channel_id, note, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(randomUUID(), ownerChannelId, competitorChannelId, note ?? null, nowIso());
    return Number(result.changes) > 0;
  }

  removeCompetitor(ownerChannelId: string, competitorChannelId: string): boolean {
    const result = this.database.prepare(
      `DELETE FROM competitors WHERE owner_channel_id=? AND competitor_channel_id=?`,
    ).run(ownerChannelId, competitorChannelId);
    return Number(result.changes) > 0;
  }

  // ---------------------------------------------------------------------------
  // v7 — public saved/follow roles. These methods are storage-only: callers
  // must not pass a provider or OperationManager into this part of the store.
  // ---------------------------------------------------------------------------

  getSavedChannel(youtubeUcId: string): SavedChannelRecord | null {
    const row = this.database.prepare(
      'SELECT youtube_uc_id, starred_at, note, updated_at FROM saved_channels WHERE youtube_uc_id=?',
    ).get(youtubeUcId) as Row | undefined;
    if (!row) return null;
    return {
      youtubeUcId: String(row['youtube_uc_id']),
      starredAt: String(row['starred_at']),
      note: nullableString(row['note']),
      updatedAt: String(row['updated_at']),
    };
  }

  listSavedChannels(): SavedChannelRecord[] {
    const rows = this.database.prepare(
      'SELECT youtube_uc_id, starred_at, note, updated_at FROM saved_channels ORDER BY starred_at DESC, youtube_uc_id ASC',
    ).all() as Row[];
    return rows.map((row) => ({
      youtubeUcId: String(row['youtube_uc_id']),
      starredAt: String(row['starred_at']),
      note: nullableString(row['note']),
      updatedAt: String(row['updated_at']),
    }));
  }

  saveChannel(youtubeUcId: string, note?: string): SavedChannelRecord {
    const now = nowIso();
    this.database.prepare(
      `INSERT INTO saved_channels (youtube_uc_id, starred_at, note, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(youtube_uc_id) DO UPDATE SET
         note=COALESCE(excluded.note, saved_channels.note),
         updated_at=excluded.updated_at`,
    ).run(youtubeUcId, now, note ?? null, now);
    return this.getSavedChannel(youtubeUcId)!;
  }

  unsaveChannel(youtubeUcId: string): boolean {
    const result = this.database.prepare(
      'DELETE FROM saved_channels WHERE youtube_uc_id=?',
    ).run(youtubeUcId);
    return Number(result.changes) > 0;
  }

  getPublicCompetitor(ownerChannelId: string, competitorChannelId: string): PublicCompetitorRecord | null {
    const row = this.database.prepare(
      'SELECT * FROM competitors WHERE owner_channel_id=? AND competitor_channel_id=?',
    ).get(ownerChannelId, competitorChannelId) as Row | undefined;
    return row ? publicCompetitorFromRow(row) : null;
  }

  listPublicCompetitors(ownerChannelId: string): PublicCompetitorRecord[] {
    const rows = this.database.prepare(
      `SELECT * FROM competitors WHERE owner_channel_id=?
       ORDER BY created_at ASC, competitor_channel_id ASC`,
    ).all(ownerChannelId) as Row[];
    return rows.map(publicCompetitorFromRow);
  }

  /** Create or update the canonical competitors row used by the local UI. */
  upsertPublicCompetitor(input: {
    ownerChannelId: string;
    competitorChannelId: string;
    note?: string;
    cadence?: PublicWatchCadence;
    watchStatus?: PublicWatchStatus;
  }): PublicCompetitorRecord {
    const current = this.getPublicCompetitor(input.ownerChannelId, input.competitorChannelId);
    if (!current) {
      this.database.prepare(
        `INSERT INTO competitors
         (id, owner_channel_id, competitor_channel_id, note, watch_status, cadence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        input.ownerChannelId,
        input.competitorChannelId,
        input.note ?? null,
        input.watchStatus ?? 'followed',
        input.cadence ?? 'daily',
        nowIso(),
      );
    } else {
      this.database.prepare(
        `UPDATE competitors SET
           note=?, watch_status=?, cadence=?
         WHERE owner_channel_id=? AND competitor_channel_id=?`,
      ).run(
        input.note === undefined ? current.note : input.note,
        input.watchStatus ?? current.watchStatus,
        input.cadence ?? current.cadence,
        input.ownerChannelId,
        input.competitorChannelId,
      );
    }
    return this.getPublicCompetitor(input.ownerChannelId, input.competitorChannelId)!;
  }

  updatePublicCompetitor(
    ownerChannelId: string,
    competitorChannelId: string,
    patch: { note?: string; cadence?: PublicWatchCadence; watchStatus?: PublicWatchStatus },
  ): PublicCompetitorRecord {
    const current = this.getPublicCompetitor(ownerChannelId, competitorChannelId);
    if (!current) throw new AppError('not_found', 'Kênh chưa được theo dõi trong watchlist');
    return this.upsertPublicCompetitor({
      ownerChannelId,
      competitorChannelId,
      note: patch.note === undefined ? current.note ?? undefined : patch.note,
      cadence: patch.cadence ?? current.cadence,
      watchStatus: patch.watchStatus ?? current.watchStatus,
    });
  }

  removePublicCompetitor(ownerChannelId: string, competitorChannelId: string): boolean {
    return this.removeCompetitor(ownerChannelId, competitorChannelId);
  }

  markPublicCompetitorObserved(
    ownerChannelId: string,
    competitorChannelId: string,
    observedAt: string,
    status?: string | null,
  ): PublicCompetitorRecord {
    const current = this.getPublicCompetitor(ownerChannelId, competitorChannelId);
    if (!current) throw new AppError('not_found', 'Kênh chưa được theo dõi trong watchlist');
    this.database.prepare(
      `UPDATE competitors SET last_observed_at=?, last_observation_status=?
       WHERE owner_channel_id=? AND competitor_channel_id=?`,
    ).run(observedAt, status ?? null, ownerChannelId, competitorChannelId);
    return this.getPublicCompetitor(ownerChannelId, competitorChannelId)!;
  }

  createOrGetPublicObservationRun(input: {
    watchlistId: string;
    competitorChannelId: string;
    planKind: PublicObservationPlanKind;
    planVersion: string;
    localDate: string;
    playlistLimit: number;
    startedAt?: string;
  }): { run: PublicObservationRun; created: boolean } {
    const existing = this.database.prepare(
      `SELECT * FROM competitor_observation_runs
       WHERE owner_channel_id=? AND competitor_channel_id=? AND plan_kind=? AND local_date=? AND plan_version=?`,
    ).get(
      input.watchlistId, input.competitorChannelId, input.planKind, input.localDate, input.planVersion,
    ) as Row | undefined;
    if (existing) return { run: publicObservationRunFromRow(existing), created: false };
    const id = randomUUID();
    const startedAt = input.startedAt ?? nowIso();
    this.database.prepare(
      `INSERT INTO competitor_observation_runs
       (id,owner_channel_id,competitor_channel_id,plan_kind,plan_version,local_date,provider_used,status,completeness,started_at,playlist_limit)
       VALUES (?,?,?,?,?,?,'ytdlp','running','partial',?,?)`,
    ).run(
      id, input.watchlistId, input.competitorChannelId, input.planKind, input.planVersion,
      input.localDate, startedAt, input.playlistLimit,
    );
    return { run: this.getPublicObservationRun(id)!, created: true };
  }

  getPublicObservationRun(id: string): PublicObservationRun | null {
    const row = this.database.prepare('SELECT * FROM competitor_observation_runs WHERE id=?').get(id) as Row | undefined;
    return row ? publicObservationRunFromRow(row) : null;
  }

  updatePublicObservationRun(input: {
    id: string;
    status: PublicObservationStatus;
    completeness: PublicObservationCompleteness;
    completedAt?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    inspectAttempted?: number;
    inspectOk?: number;
  }): PublicObservationRun {
    const current = this.getPublicObservationRun(input.id);
    if (!current) throw new AppError('not_found', 'Public observation run không tồn tại');
    this.database.prepare(
      `UPDATE competitor_observation_runs SET
       status=?, completeness=?, completed_at=?, error_code=?, error_message=?, inspect_attempted=?, inspect_ok=?
       WHERE id=?`,
    ).run(
      input.status,
      input.completeness,
      input.completedAt === undefined ? current.completedAt : input.completedAt,
      input.errorCode === undefined ? current.errorCode : input.errorCode,
      input.errorMessage === undefined ? current.errorMessage : input.errorMessage,
      input.inspectAttempted ?? current.inspectAttempted,
      input.inspectOk ?? current.inspectOk,
      input.id,
    );
    return this.getPublicObservationRun(input.id)!;
  }

  insertPublicVideoStatPoint(input: Omit<PublicVideoStatPoint, 'id' | 'createdAt'>): PublicVideoStatPoint {
    const id = randomUUID();
    const createdAt = nowIso();
    this.database.prepare(
      `INSERT OR IGNORE INTO video_stat_points
       (id,observation_run_id,source_video_id,youtube_uc_id,sampled_at,view_count,like_count,comment_count,duration_sec,published_at,title,availability,view_quality,provider_used,inspect_used,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'ytdlp',?,?)`,
    ).run(
      id, input.observationRunId, input.sourceVideoId, input.youtubeUcId, input.sampledAt,
      input.viewCount, input.likeCount, input.commentCount, input.durationSec, input.publishedAt,
      input.title, input.availability, input.viewQuality, input.inspectUsed ? 1 : 0, createdAt,
    );
    const row = this.database.prepare(
      'SELECT * FROM video_stat_points WHERE observation_run_id=? AND source_video_id=?',
    ).get(input.observationRunId, input.sourceVideoId) as Row;
    return publicVideoStatPointFromRow(row);
  }

  listPublicObservationRuns(watchlistId: string, competitorChannelId: string, limit = 100): PublicObservationRun[] {
    const rows = this.database.prepare(
      `SELECT * FROM competitor_observation_runs WHERE owner_channel_id=? AND competitor_channel_id=?
       ORDER BY started_at DESC LIMIT ?`,
    ).all(watchlistId, competitorChannelId, Math.max(1, Math.min(limit, 500))) as Row[];
    return rows.map(publicObservationRunFromRow);
  }

  /**
   * Time-ordered, explicit-cursor read for public telemetry.  A VPH chart
   * must never silently drop later lexical video ids just because it hit a
   * global limit; callers receive `truncated` and a cursor when this page is
   * incomplete.
   */
  listPublicVideoStatPointsPage(input: {
    youtubeUcId: string;
    from?: string | null;
    to?: string | null;
    cursor?: string | null;
    limit?: number;
  }): { points: PublicVideoStatPoint[]; truncated: boolean; nextCursor: string | null } {
    const where = ['youtube_uc_id=?'];
    const args: Array<string | number> = [input.youtubeUcId];
    if (input.from) {
      where.push('sampled_at>=?');
      args.push(input.from);
    }
    if (input.to) {
      where.push('sampled_at<=?');
      args.push(input.to);
    }
    const cursor = parsePublicPointCursor(input.cursor);
    if (cursor) {
      where.push(`(sampled_at>? OR (sampled_at=? AND source_video_id>?) OR (sampled_at=? AND source_video_id=? AND created_at>?))`);
      args.push(cursor.sampledAt, cursor.sampledAt, cursor.sourceVideoId, cursor.sampledAt, cursor.sourceVideoId, cursor.createdAt);
    }
    const limit = Math.max(1, Math.min(input.limit ?? 2_000, 10_000));
    const rows = this.database.prepare(
      `SELECT * FROM video_stat_points WHERE ${where.join(' AND ')}
       ORDER BY sampled_at ASC, source_video_id ASC, created_at ASC LIMIT ?`,
    ).all(...args, limit + 1) as Row[];
    const truncated = rows.length > limit;
    const page = truncated ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    return {
      points: page.map(publicVideoStatPointFromRow),
      truncated,
      nextCursor: truncated && last
        ? publicPointCursor(String(last['sampled_at']), String(last['source_video_id']), String(last['created_at']))
        : null,
    };
  }

  /** Compatibility read for existing callers/tests; new chart reads use page metadata. */
  listPublicVideoStatPoints(youtubeUcId: string, limit = 2_000): PublicVideoStatPoint[] {
    return this.listPublicVideoStatPointsPage({ youtubeUcId, limit }).points;
  }

  /**
   * Complete bounded-history read used to derive a channel projection before
   * pagination.  VPH pairs are per-video facts, so deriving them from a
   * global cursor page can split a pair across pages and change the median.
   * Raw drill-downs remain paginated through the page methods below.
   */
  listAllPublicVideoStatPoints(input: {
    youtubeUcId: string;
    from?: string | null;
    to?: string | null;
  }): PublicVideoStatPoint[] {
    const where = ['youtube_uc_id=?'];
    const args: string[] = [input.youtubeUcId];
    if (input.from) {
      where.push('sampled_at>=?');
      args.push(input.from);
    }
    if (input.to) {
      where.push('sampled_at<=?');
      args.push(input.to);
    }
    const rows = this.database.prepare(
      `SELECT * FROM video_stat_points WHERE ${where.join(' AND ')}
       ORDER BY source_video_id ASC, sampled_at ASC, created_at ASC`,
    ).all(...args) as Row[];
    return rows.map(publicVideoStatPointFromRow);
  }

  listPublicVideoStatPointsForVideoPage(input: {
    sourceVideoId: string;
    from?: string | null;
    to?: string | null;
    cursor?: string | null;
    limit?: number;
  }): { points: PublicVideoStatPoint[]; truncated: boolean; nextCursor: string | null } {
    const where = ['source_video_id=?'];
    const args: Array<string | number> = [input.sourceVideoId];
    if (input.from) {
      where.push('sampled_at>=?');
      args.push(input.from);
    }
    if (input.to) {
      where.push('sampled_at<=?');
      args.push(input.to);
    }
    const cursor = parsePublicPointCursor(input.cursor);
    if (cursor) {
      // source_video_id is constant in this read, but retain the same stable
      // keyset ordering as the channel chart so cursors are unambiguous.
      where.push(`(sampled_at>? OR (sampled_at=? AND created_at>?))`);
      args.push(cursor.sampledAt, cursor.sampledAt, cursor.createdAt);
    }
    const limit = Math.max(1, Math.min(input.limit ?? 500, 5_000));
    const rows = this.database.prepare(
      `SELECT * FROM video_stat_points WHERE ${where.join(' AND ')}
       ORDER BY sampled_at ASC, source_video_id ASC, created_at ASC LIMIT ?`,
    ).all(...args, limit + 1) as Row[];
    const truncated = rows.length > limit;
    const page = truncated ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    return {
      points: page.map(publicVideoStatPointFromRow),
      truncated,
      nextCursor: truncated && last
        ? publicPointCursor(String(last['sampled_at']), String(last['source_video_id']), String(last['created_at']))
        : null,
    };
  }

  /** Complete per-video history for deterministic segment derivation. */
  listAllPublicVideoStatPointsForVideo(input: {
    sourceVideoId: string;
    from?: string | null;
    to?: string | null;
  }): PublicVideoStatPoint[] {
    const where = ['source_video_id=?'];
    const args: string[] = [input.sourceVideoId];
    if (input.from) {
      where.push('sampled_at>=?');
      args.push(input.from);
    }
    if (input.to) {
      where.push('sampled_at<=?');
      args.push(input.to);
    }
    const rows = this.database.prepare(
      `SELECT * FROM video_stat_points WHERE ${where.join(' AND ')}
       ORDER BY sampled_at ASC, created_at ASC`,
    ).all(...args) as Row[];
    return rows.map(publicVideoStatPointFromRow);
  }

  getPreviousKnownPublicView(youtubeUcId: string, sourceVideoId: string): number | null {
    const row = this.database.prepare(
      `SELECT view_count FROM video_stat_points
       WHERE youtube_uc_id=? AND source_video_id=? AND availability='present' AND view_count IS NOT NULL
       ORDER BY sampled_at DESC, created_at DESC LIMIT 1`,
    ).get(youtubeUcId, sourceVideoId) as Row | undefined;
    return row?.['view_count'] === null || row?.['view_count'] === undefined ? null : Number(row['view_count']);
  }

  getLatestProfile(scope: string, scopeId: string, kind: string): {
    id: string;
    payload: unknown;
    evidence: unknown;
    computedAt: string;
    spyRunId: string;
    model: string | null;
  } | null {
    const row = this.database.prepare(
      `SELECT * FROM profiles WHERE scope=? AND scope_id=? AND kind=? ORDER BY computed_at DESC LIMIT 1`,
    ).get(scope, scopeId, kind) as Row | undefined;
    if (!row) return null;
    return {
      id: String(row['id']),
      payload: parseJson<unknown>(row['payload_json']),
      evidence: parseJson<unknown>(row['evidence_json']),
      computedAt: String(row['computed_at']),
      spyRunId: String(row['spy_run_id']),
      model: nullableString(row['model']),
    };
  }

  // ---------------------------------------------------------------------------
  // v5 — Topics
  // ---------------------------------------------------------------------------

  upsertTopic(input: {
    topicId: string;
    label: string;
    market: string;
    language: string;
    status?: 'active' | 'paused' | 'archived';
    ownChannelIds?: string[];
    briefMd?: string;
    facelessRequired?: boolean;
    dailySearchBudget?: number;
    // v13 §4.1: thị trường search (US, VN) — tách khỏi language.
    region?: string | null;
  }): void {
    const now = nowIso();
    this.database.prepare(
      `INSERT INTO topics (topic_id, label, market, language, status, own_channel_ids_json,
         brief_md, faceless_required, daily_search_budget, region, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(topic_id) DO UPDATE SET
         label=excluded.label, market=excluded.market, language=excluded.language,
         status=excluded.status, own_channel_ids_json=excluded.own_channel_ids_json,
         brief_md=excluded.brief_md, faceless_required=excluded.faceless_required,
         daily_search_budget=excluded.daily_search_budget,
         region=COALESCE(excluded.region, topics.region),
         updated_at=excluded.updated_at`,
    ).run(
      input.topicId,
      input.label,
      input.market,
      input.language,
      input.status ?? 'active',
      JSON.stringify(input.ownChannelIds ?? []),
      input.briefMd ?? '',
      input.facelessRequired !== false ? 1 : 0,
      input.dailySearchBudget ?? 20,
      input.region ?? null,
      now,
      now,
    );
  }

  getTopic(topicId: string): Row | null {
    return this.database.prepare('SELECT * FROM topics WHERE topic_id=?').get(topicId) as Row | null;
  }

  listTopics(status?: 'active' | 'paused' | 'archived'): Row[] {
    if (status) {
      return this.database.prepare('SELECT * FROM topics WHERE status=? ORDER BY topic_id').all(status) as Row[];
    }
    return this.database.prepare('SELECT * FROM topics ORDER BY topic_id').all() as Row[];
  }

  // ---------------------------------------------------------------------------
  // v5 — Topic keywords
  // ---------------------------------------------------------------------------

  upsertTopicKeyword(input: {
    topicId: string;
    termKey: string;
    displayTerm: string;
    relation: string;
    evidenceJson?: string;
    status?: string;
    addedBy?: 'user' | 'loop' | 'agent';
  }): void {
    const now = nowIso();
    this.database.prepare(
      `INSERT INTO topic_keywords (topic_id, term_key, display_term, relation, evidence_json, status, added_at, added_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(topic_id, term_key) DO UPDATE SET
         display_term=excluded.display_term, relation=excluded.relation,
         evidence_json=excluded.evidence_json`,
    ).run(
      input.topicId,
      input.termKey,
      input.displayTerm,
      input.relation,
      input.evidenceJson ?? '{}',
      input.status ?? 'pending',
      now,
      input.addedBy ?? 'user',
    );
  }

  listTopicKeywords(topicId: string, status?: string): Row[] {
    if (status) {
      return this.database.prepare(
        'SELECT * FROM topic_keywords WHERE topic_id=? AND status=? ORDER BY yield_channels DESC, added_at ASC',
      ).all(topicId, status) as Row[];
    }
    return this.database.prepare(
      'SELECT * FROM topic_keywords WHERE topic_id=? ORDER BY yield_channels DESC, added_at ASC',
    ).all(topicId) as Row[];
  }

  markKeywordSearched(topicId: string, termKey: string, yieldDelta = 0): void {
    // v13: 'searched' không còn trong CHECK — keyword đã từng search = active.
    // Sức khoẻ search (n_results, median…) ghi qua updateKeywordCheck.
    this.database.prepare(
      `UPDATE topic_keywords SET status='active', last_searched_at=?, yield_channels=yield_channels+?
       WHERE topic_id=? AND term_key=?`,
    ).run(nowIso(), yieldDelta, topicId, termKey);
  }

  setKeywordStatus(topicId: string, termKey: string, status: string): void {
    this.database.prepare('UPDATE topic_keywords SET status=? WHERE topic_id=? AND term_key=?')
      .run(status, topicId, termKey);
  }

  // ---------------------------------------------------------------------------
  // v5 — Topic channel sources
  // ---------------------------------------------------------------------------

  addTopicChannelSource(input: {
    topicId: string;
    channelId: string;
    relation: string;
    termKey?: string | null;
    fromChannelId?: string | null;
  }): void {
    this.database.prepare(
      `INSERT OR REPLACE INTO topic_channel_sources
         (topic_id, channel_id, relation, term_key, from_channel_id, seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      input.topicId,
      input.channelId,
      input.relation,
      input.termKey ?? null,
      input.fromChannelId ?? null,
      nowIso(),
    );
  }

  /** Mọi provenance của một topic — dùng để dựng `foundVia` cho Inbox (§5.1). */
  listTopicChannelSources(topicId: string, channelId?: string): Row[] {
    if (channelId) {
      return this.database.prepare(
        `SELECT * FROM topic_channel_sources WHERE topic_id=? AND channel_id=?
         ORDER BY seen_at ASC, rowid ASC`,
      ).all(topicId, channelId) as Row[];
    }
    return this.database.prepare(
      'SELECT * FROM topic_channel_sources WHERE topic_id=? ORDER BY seen_at ASC, rowid ASC',
    ).all(topicId) as Row[];
  }

  /**
   * Provenance ĐẦU TIÊN của một kênh trong topic — "kênh này lần đầu đến từ đâu".
   * Một kênh có thể vào topic qua nhiều đường (PK gồm cả relation); lần đầu là
   * câu trả lời đúng cho câu hỏi "tìm được nhờ keyword nào".
   */
  getTopicChannelSource(topicId: string, channelId: string): Row | null {
    return this.database.prepare(
      // seen_at trùng nhau khi nhiều nguồn được ghi trong cùng một tick →
      // tie-break bằng rowid để "đường đầu tiên" luôn là đường chèn trước.
      `SELECT * FROM topic_channel_sources WHERE topic_id=? AND channel_id=?
       ORDER BY seen_at ASC, rowid ASC LIMIT 1`,
    ).get(topicId, channelId) as Row | null;
  }

  // ---------------------------------------------------------------------------
  // v5 — Topic channels
  // ---------------------------------------------------------------------------

  upsertTopicChannel(input: {
    topicId: string;
    channelId: string;
    fitScore?: number | null;
    fitReasonsJson?: string;
    /** Verdict thật — P0 phải luôn truyền null (§3). */
    facelessScore?: number | null;
    facelessSignalsJson?: string;
    /** Phỏng đoán text-only 0..1 — không phải verdict. */
    facelessHint?: number | null;
    facelessHintReasonsJson?: string | null;
    /** JSON string[] — ≤6 thumbnail URL cho Inbox. */
    thumbnailsJson?: string | null;
    learnValueScore?: number | null;
    /** JSON LearnValueReason[] — điểm không kèm lý do là điểm không dùng được. */
    learnValueReasonsJson?: string | null;
    /** v13: denormalize + provenance + baseline (§4.3). */
    title?: string | null;
    handle?: string | null;
    subscriberCount?: number | null;
    discoveredVia?: string | null;
    discoveredFrom?: string | null;
    baselineMedianViews?: number | null;
    baselineN?: number | null;
    maxViews?: number | null;
    baselineAt?: string | null;
    lastPublishedAt?: string | null;
    lastCheckedAt?: string | null;
    status?: string;
    decidedBy?: 'user' | 'loop_auto' | null;
    decidedAt?: string | null;
    decidedReason?: string | null;
    spyRunId?: string | null;
    langDetected?: string | null;
    langConfidence?: number | null;
    langEvidenceJson?: string | null;
  }): void {
    const now = nowIso();
    this.database.prepare(
      `INSERT INTO topic_channels
         (topic_id, channel_id, fit_score, fit_reasons_json, faceless_score,
          faceless_signals_json, faceless_hint, faceless_hint_reasons_json,
          thumbnails_json, learn_value_score, learn_value_reasons_json,
          status, decided_by, decided_at, decided_reason,
          spy_run_id, lang_detected, lang_confidence, lang_evidence_json,
          title, handle, subscriber_count, discovered_via, discovered_from,
          baseline_median_views, baseline_n, max_views, baseline_at,
          last_published_at, last_checked_at,
          first_seen_at, last_scored_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(topic_id, channel_id) DO UPDATE SET
         fit_score=COALESCE(excluded.fit_score, fit_score),
         fit_reasons_json=COALESCE(excluded.fit_reasons_json, fit_reasons_json),
         faceless_score=COALESCE(excluded.faceless_score, faceless_score),
         faceless_signals_json=COALESCE(excluded.faceless_signals_json, faceless_signals_json),
         faceless_hint=COALESCE(excluded.faceless_hint, faceless_hint),
         faceless_hint_reasons_json=COALESCE(excluded.faceless_hint_reasons_json, faceless_hint_reasons_json),
         thumbnails_json=COALESCE(excluded.thumbnails_json, thumbnails_json),
         learn_value_score=COALESCE(excluded.learn_value_score, learn_value_score),
         learn_value_reasons_json=COALESCE(excluded.learn_value_reasons_json, learn_value_reasons_json),
         -- Quyết định là DÍNH: kênh đã có decided_by (user duyệt hoặc loop_auto)
         -- không được một lần enrich/import sau đó âm thầm kéo về 'new'.
         -- Đổi trạng thái phải đi qua decideTopicChannels.
         status=CASE WHEN topic_channels.decided_by IS NULL THEN excluded.status ELSE topic_channels.status END,
         decided_by=COALESCE(excluded.decided_by, topic_channels.decided_by),
         decided_at=COALESCE(excluded.decided_at, topic_channels.decided_at),
         decided_reason=COALESCE(excluded.decided_reason, topic_channels.decided_reason),
         spy_run_id=COALESCE(excluded.spy_run_id, spy_run_id),
         lang_detected=COALESCE(excluded.lang_detected, lang_detected),
         lang_confidence=COALESCE(excluded.lang_confidence, lang_confidence),
         lang_evidence_json=COALESCE(excluded.lang_evidence_json, lang_evidence_json),
         title=COALESCE(excluded.title, title),
         handle=COALESCE(excluded.handle, handle),
         subscriber_count=COALESCE(excluded.subscriber_count, subscriber_count),
         -- Provenance lần ĐẦU thắng — upsert sau không được viết đè nguồn gốc.
         discovered_via=COALESCE(topic_channels.discovered_via, excluded.discovered_via),
         discovered_from=COALESCE(topic_channels.discovered_from, excluded.discovered_from),
         baseline_median_views=COALESCE(excluded.baseline_median_views, baseline_median_views),
         baseline_n=COALESCE(excluded.baseline_n, baseline_n),
         max_views=COALESCE(excluded.max_views, max_views),
         baseline_at=COALESCE(excluded.baseline_at, baseline_at),
         last_published_at=COALESCE(excluded.last_published_at, last_published_at),
         last_checked_at=COALESCE(excluded.last_checked_at, last_checked_at),
         last_scored_at=excluded.last_scored_at`,
    ).run(
      input.topicId, input.channelId,
      input.fitScore ?? null,
      input.fitReasonsJson ?? '[]',
      input.facelessScore ?? null,
      input.facelessSignalsJson ?? '[]',
      input.facelessHint ?? null,
      input.facelessHintReasonsJson ?? null,
      input.thumbnailsJson ?? null,
      input.learnValueScore ?? null,
      input.learnValueReasonsJson ?? null,
      input.status ?? 'new',
      input.decidedBy ?? null,
      input.decidedAt ?? null,
      input.decidedReason ?? null,
      input.spyRunId ?? null,
      input.langDetected ?? null,
      input.langConfidence ?? null,
      input.langEvidenceJson ?? null,
      input.title ?? null,
      input.handle ?? null,
      input.subscriberCount ?? null,
      input.discoveredVia ?? null,
      input.discoveredFrom ?? null,
      input.baselineMedianViews ?? null,
      input.baselineN ?? null,
      input.maxViews ?? null,
      input.baselineAt ?? null,
      input.lastPublishedAt ?? null,
      input.lastCheckedAt ?? null,
      now,
      now,
    );
  }

  listTopicChannels(topicId: string, filter: {
    status?: string;
    limit?: number;
    cursor?: number;
  } = {}): Row[] {
    const where: string[] = ['topic_id=?'];
    const params: Array<string | number> = [topicId];
    if (filter.status) { where.push('status=?'); params.push(filter.status); }
    const sql = `SELECT * FROM topic_channels WHERE ${where.join(' AND ')}
      ORDER BY (COALESCE(fit_score, 0) * COALESCE(learn_value_score, 0)) DESC, first_seen_at ASC
      LIMIT ? OFFSET ?`;
    params.push(filter.limit ?? 50, filter.cursor ?? 0);
    return this.database.prepare(sql).all(...params) as Row[];
  }

  /**
   * @param reason Lý do máy đọc được, vd 'lang_mismatch' | 'low_fit' | 'fit_learn_auto'.
   *   Bắt buộc có cho quyết định của loop để report/UI giải thích được vì sao
   *   một kênh biến mất khỏi Inbox.
   */
  decideTopicChannels(
    topicId: string,
    channelIds: string[],
    status: string,
    decidedBy: 'user' | 'loop_auto',
    reason: string | null = null,
  ): void {
    const stmt = this.database.prepare(
      `UPDATE topic_channels SET status=?, decided_by=?, decided_at=?, decided_reason=?
       WHERE topic_id=? AND channel_id=?`,
    );
    const now = nowIso();
    for (const channelId of channelIds) {
      stmt.run(status, decidedBy, now, reason, topicId, channelId);
    }
  }

  /**
   * Nạp kênh đã có sẵn trong corpus (`channels` — 20 kênh đã spy thủ công) vào
   * một topic làm hạt giống. **0 quota tuyệt đối**: chỉ đọc/ghi SQLite, không
   * chạm Data API (§1.2 cold start đường 2).
   *
   * Không đè trạng thái cũ: kênh đã có trong topic (kể cả đã reject) giữ nguyên.
   */
  importCorpusChannelsToTopic(topicId: string, market?: string | null): {
    imported: string[];
    skipped: string[];
  } {
    const rows = this.database.prepare(
      'SELECT channel_id, title, subscriber_count, video_count, total_view_count FROM channels ORDER BY fetched_at DESC',
    ).all() as Row[];
    const imported: string[] = [];
    const skipped: string[] = [];
    for (const row of rows) {
      const channelId = String(row['channel_id']);
      const existing = this.database.prepare(
        'SELECT 1 FROM topic_channels WHERE topic_id=? AND channel_id=?',
      ).get(topicId, channelId);
      if (existing) {
        skipped.push(channelId);
        continue;
      }
      this.upsertCandidate({
        channelId,
        title: row['title'] === null ? null : String(row['title']),
        market: market ?? null,
        discoveredVia: 'corpus_import',
        subscriberCount: row['subscriber_count'] === null ? null : Number(row['subscriber_count']),
        videoCount: row['video_count'] === null ? null : Number(row['video_count']),
        viewCount: row['total_view_count'] === null ? null : Number(row['total_view_count']),
      });
      this.upsertTopicChannel({ topicId, channelId, status: 'new' });
      this.addTopicChannelSource({ topicId, channelId, relation: 'corpus_import' });
      imported.push(channelId);
    }
    return { imported, skipped };
  }

  countTopicChannelsByStatus(topicId: string): Record<string, number> {
    const rows = this.database.prepare(
      'SELECT status, COUNT(*) AS n FROM topic_channels WHERE topic_id=? GROUP BY status',
    ).all(topicId) as Row[];
    return Object.fromEntries(rows.map((row) => [String(row['status']), Number(row['n'])]));
  }

  // ---------------------------------------------------------------------------
  // v5 — Loop ticks
  // ---------------------------------------------------------------------------

  /**
   * v13: tick gắn mode ('setup'|'daily'|'weekly') — UNIQUE(topic_id, quota_day,
   * mode) nên daily và weekly được chạy cùng một quota_day.
   */
  createLoopTick(input: {
    tickId: string;
    topicId: string;
    quotaDay: string;
    mode?: LoopMode;
    searchBaselineCalls?: number;
    generalBaselineUnits?: number;
  }): boolean {
    try {
      this.database.prepare(
        `INSERT INTO loop_ticks (tick_id, topic_id, quota_day, started_at, status, step,
           search_baseline_calls, general_baseline_units, mode)
         VALUES (?, ?, ?, ?, 'running', 'expand', ?, ?, ?)`,
      ).run(
        input.tickId, input.topicId, input.quotaDay, nowIso(),
        input.searchBaselineCalls ?? 0, input.generalBaselineUnits ?? 0,
        input.mode ?? 'daily',
      );
      return true;
    } catch {
      // UNIQUE constraint violated → tick already exists for this (quota_day, mode)
      return false;
    }
  }

  /** Giữ tên cũ cho caller v5 — tick không khai mode được coi là 'daily'. */
  insertLoopTick(input: {
    tickId: string;
    topicId: string;
    quotaDay: string;
    mode?: LoopMode;
    searchBaselineCalls?: number;
    generalBaselineUnits?: number;
  }): boolean {
    return this.createLoopTick(input);
  }

  updateLoopTick(tickId: string, patch: {
    status?: string;
    step?: string;
    searchCallsUsed?: number;
    generalUnitsUsed?: number;
    keywordsSearchedJson?: string;
    newCandidates?: number;
    newShortlistedAuto?: number;
    scannedChannels?: number;
    keywordsHarvested?: number;
    error?: string | null;
    finishedAt?: string | null;
  }): void {
    const current = this.database.prepare('SELECT * FROM loop_ticks WHERE tick_id=?').get(tickId) as Row | undefined;
    if (!current) return;
    const terminal = ['done', 'failed', 'skipped_quota'].includes(patch.status ?? String(current['status']));
    this.database.prepare(
      `UPDATE loop_ticks SET
         status=?, step=?, search_calls_used=?, general_units_used=?, keywords_searched_json=?,
         new_candidates=?, new_shortlisted_auto=?, scanned_channels=?, keywords_harvested=?,
         error=?, finished_at=?
       WHERE tick_id=?`,
    ).run(
      patch.status ?? String(current['status']),
      patch.step ?? String(current['step']),
      patch.searchCallsUsed ?? Number(current['search_calls_used']),
      patch.generalUnitsUsed ?? Number(current['general_units_used']),
      patch.keywordsSearchedJson ?? String(current['keywords_searched_json']),
      patch.newCandidates ?? Number(current['new_candidates']),
      patch.newShortlistedAuto ?? Number(current['new_shortlisted_auto']),
      patch.scannedChannels ?? Number(current['scanned_channels']),
      patch.keywordsHarvested ?? Number(current['keywords_harvested']),
      patch.error !== undefined ? patch.error : (current['error'] === null ? null : String(current['error'])),
      terminal ? (patch.finishedAt ?? nowIso()) : null,
      tickId,
    );
  }

  /**
   * Tick gần nhất của topic. v13: truyền `mode` để lọc đúng nhịp — một ngày có
   * thể có cả tick daily lẫn weekly (UNIQUE là (topic, quota_day, mode)).
   */
  getLastTick(topicId: string, mode?: LoopMode): Row | null {
    if (mode !== undefined) {
      return this.database.prepare(
        'SELECT * FROM loop_ticks WHERE topic_id=? AND mode=? ORDER BY quota_day DESC, started_at DESC LIMIT 1',
      ).get(topicId, mode) as Row | null;
    }
    return this.database.prepare(
      'SELECT * FROM loop_ticks WHERE topic_id=? ORDER BY quota_day DESC, started_at DESC LIMIT 1',
    ).get(topicId) as Row | null;
  }

  /** Tick của một ngày quota — `mode` lọc đúng tick daily/weekly/setup cùng ngày. */
  getTickByDay(topicId: string, quotaDay: string, mode?: LoopMode): Row | null {
    if (mode !== undefined) {
      return this.database.prepare(
        'SELECT * FROM loop_ticks WHERE topic_id=? AND quota_day=? AND mode=?',
      ).get(topicId, quotaDay, mode) as Row | null;
    }
    return this.database.prepare(
      'SELECT * FROM loop_ticks WHERE topic_id=? AND quota_day=?',
    ).get(topicId, quotaDay) as Row | null;
  }

  // ---------------------------------------------------------------------------
  // v5 — Daily reports
  // ---------------------------------------------------------------------------

  insertDailyReport(input: {
    reportId: string;
    reportDate: string;
    topicId: string | null;
    summaryJson: string;
    markdown: string;
    /** v13: 'daily' (mặc định) | 'weekly' | 'setup'. */
    mode?: LoopMode;
  }): void {
    this.database.prepare(
      `INSERT INTO daily_reports (report_id, report_date, topic_id, summary_json, markdown, created_at, delivered_json, mode)
       VALUES (?, ?, ?, ?, ?, ?, '{}', ?)`,
    ).run(input.reportId, input.reportDate, input.topicId, input.summaryJson, input.markdown, nowIso(), input.mode ?? 'daily');
  }

  /**
   * Ghi report cho (topic, ngày) NẾU CHƯA CÓ. Trả về report_id đang tồn tại khi
   * đã có — an toàn khi gọi lại sau crash. Tick chỉ được đánh `done` sau khi hàm
   * này trả về thành công, nếu không một crash giữa chừng sẽ để lại tick `done`
   * vĩnh viễn mà không có report nào, và lần chạy sau sẽ skip vì thấy `done`.
   */
  insertDailyReportOnce(input: {
    reportId: string;
    reportDate: string;
    topicId: string | null;
    summaryJson: string;
    markdown: string;
    mode?: LoopMode;
  }): { created: boolean; reportId: string } {
    return this.transaction(() => {
      const existing = this.getDailyReportByDate(input.topicId, input.reportDate, input.mode ?? 'daily');
      if (existing) return { created: false, reportId: String(existing['report_id']) };
      this.insertDailyReport(input);
      return { created: true, reportId: input.reportId };
    });
  }

  listDailyReports(topicId?: string | null, limit = 30): Row[] {
    if (topicId !== undefined) {
      return this.database.prepare(
        'SELECT * FROM daily_reports WHERE topic_id=? ORDER BY report_date DESC LIMIT ?',
      ).all(topicId, limit) as Row[];
    }
    return this.database.prepare('SELECT * FROM daily_reports ORDER BY report_date DESC LIMIT ?').all(limit) as Row[];
  }

  getDailyReport(reportId: string): Row | null {
    return this.database.prepare('SELECT * FROM daily_reports WHERE report_id=?').get(reportId) as Row | null;
  }

  getDailyReportByDate(topicId: string | null, date: string, mode: LoopMode = 'daily'): Row | null {
    if (topicId === null) {
      return this.database.prepare(
        'SELECT * FROM daily_reports WHERE topic_id IS NULL AND report_date=? AND mode=? LIMIT 1',
      ).get(date, mode) as Row | null;
    }
    return this.database.prepare(
      'SELECT * FROM daily_reports WHERE topic_id=? AND report_date=? AND mode=? LIMIT 1',
    ).get(topicId, date, mode) as Row | null;
  }

  markDelivered(reportId: string, key: string, value: string): void {
    const row = this.getDailyReport(reportId);
    if (!row) return;
    const delivered = parseJson<Record<string, string>>(row['delivered_json'] ?? '{}');
    delivered[key] = value;
    this.database.prepare('UPDATE daily_reports SET delivered_json=? WHERE report_id=?')
      .run(JSON.stringify(delivered), reportId);
  }

  // ── v13 — Spy Pipeline v3 Lean: hợp đồng store ─────────────────────────
  // Luật bất biến (plan §2): các method do loop gọi CHỈ ghi status
  // new/pending, rejected (duy nhất lang_mismatch) và suggestion. Mọi chuyển
  // sang active/paused/rejected khác đi qua decideChannel/decideKeyword với
  // actor='human' và đều được ghi vào bảng decisions để truy vết.

  /**
   * Ngưỡng của topic = DEFAULT_TOPIC_SETTINGS + topics.settings_json.
   * settings_json hỏng → trả mặc định, không ném — một topic cấu hình sai không
   * được làm chết cả tick.
   */
  getTopicSettings(topicId: string): TopicSettings {
    const settings: TopicSettings = { ...DEFAULT_TOPIC_SETTINGS };
    const row = this.getTopic(topicId);
    const raw = row ? row['settings_json'] : null;
    if (typeof raw !== 'string' || raw.trim() === '') return settings;
    let parsed: Record<string, unknown>;
    try {
      const value = JSON.parse(raw) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value)) return settings;
      parsed = value as Record<string, unknown>;
    } catch {
      return settings;
    }
    // Chấp nhận cả snake_case (tên khoá trong plan §3) lẫn camelCase — khoá
    // không phải number/string hợp lệ bị bỏ qua, không ghi đè mặc định.
    const writable = settings as unknown as Record<string, unknown>;
    const pickNum = (snake: string, camel: keyof TopicSettings): void => {
      const v = parsed[snake] ?? parsed[camel as string];
      if (typeof v === 'number' && Number.isFinite(v)) {
        writable[camel] = v;
      }
    };
    const pickStr = (snake: string, camel: keyof TopicSettings): void => {
      const v = parsed[snake] ?? parsed[camel as string];
      if (typeof v === 'string' && v.trim() !== '') {
        writable[camel] = v;
      }
    };
    pickNum('outlier_multiple', 'outlierMultiple');
    pickNum('lottery_ratio', 'lotteryRatio');
    pickNum('min_duration_sec', 'minDurationSec');
    pickNum('baseline_window', 'baselineWindow');
    pickNum('baseline_min_n', 'baselineMinN');
    pickNum('dead_median', 'deadMedian');
    pickNum('silent_days', 'silentDays');
    pickNum('daily_scan_per_channel', 'dailyScanPerChannel');
    pickNum('weekly_keyword_budget', 'weeklyKeywordBudget');
    pickNum('weekly_new_channel_scan', 'weeklyNewChannelScan');
    pickNum('ngram_min_channels', 'ngramMinChannels');
    pickStr('daily_at', 'dailyAt');
    pickStr('weekly_at', 'weeklyAt');
    return settings;
  }

  setTopicSetupStatus(topicId: string, status: TopicSetupStatus): void {
    const result = this.database.prepare(
      'UPDATE topics SET setup_status=?, updated_at=? WHERE topic_id=?',
    ).run(status, nowIso(), topicId);
    if (Number(result.changes) === 0) {
      throw new AppError('not_found', `Topic ${topicId} không tồn tại`);
    }
  }

  listTopicChannelsByStatus(topicId: string, statuses: string[]): TopicChannelRow[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(',');
    return this.database.prepare(
      `SELECT * FROM topic_channels WHERE topic_id=? AND status IN (${placeholders})
       ORDER BY first_seen_at ASC, channel_id ASC`,
    ).all(topicId, ...statuses).map((row) => topicChannelRowFromRow(row as Row));
  }

  /**
   * Đề xuất kênh ứng viên vào inbox. CHỈ tạo status='new' — INSERT OR IGNORE
   * nên không bao giờ ghi đè status/quyết định đã có (tôn chỉ 1). Khi chèn được
   * thì ghi decisions(actor='loop', to='new') để truy vết kênh đến từ đâu.
   */
  upsertTopicChannelCandidate(row: {
    topicId: string;
    channelId: string;
    title: string;
    handle?: string;
    subscriberCount?: number;
    discoveredVia: string;
    discoveredFrom?: string;
    thumbnailsJson?: string;
    langDetected?: string;
    tickId?: string;
  }): { inserted: boolean } {
    const result = this.database.prepare(
      `INSERT OR IGNORE INTO topic_channels
         (topic_id, channel_id, title, handle, subscriber_count,
          thumbnails_json, lang_detected, discovered_via, discovered_from,
          status, first_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`,
    ).run(
      row.topicId, row.channelId, row.title,
      row.handle ?? null, row.subscriberCount ?? null,
      row.thumbnailsJson ?? null, row.langDetected ?? null,
      row.discoveredVia, row.discoveredFrom ?? null,
      nowIso(),
    );
    const inserted = Number(result.changes) > 0;
    if (inserted) {
      this.recordDecision({
        topicId: row.topicId,
        actor: 'loop',
        entityType: 'channel',
        entityId: row.channelId,
        fromStatus: null,
        toStatus: 'new',
        reason: `candidate:${row.discoveredVia}`,
        tickId: row.tickId,
      });
    }
    return { inserted };
  }

  /**
   * Cổng ngôn ngữ (L3): reject duy nhất cho lang_mismatch — hành động tự động
   * duy nhất mà loop được phép quyết status (plan §2).
   */
  rejectChannelForLanguage(
    topicId: string,
    channelId: string,
    evidenceJson: string,
    tickId?: string,
  ): void {
    const current = this.database.prepare(
      'SELECT status FROM topic_channels WHERE topic_id=? AND channel_id=?',
    ).get(topicId, channelId) as Row | undefined;
    if (!current) {
      throw new AppError('not_found', `Kênh ${channelId} không có trong topic ${topicId}`);
    }
    const now = nowIso();
    this.database.prepare(
      `UPDATE topic_channels SET status='rejected', decided_by='loop_auto',
         decided_at=?, decided_reason='lang_mismatch', lang_evidence_json=?
       WHERE topic_id=? AND channel_id=?`,
    ).run(now, evidenceJson, topicId, channelId);
    this.recordDecision({
      topicId,
      actor: 'loop',
      entityType: 'channel',
      entityId: channelId,
      fromStatus: nullableString(current['status']),
      toStatus: 'rejected',
      reason: 'lang_mismatch',
      tickId,
    });
  }

  /** Baseline cuốn chiếu của kênh (thay regime/Pettitt đã cắt — plan §1). */
  updateChannelBaseline(
    topicId: string,
    channelId: string,
    baseline: {
      baselineMedianViews: number | null;
      baselineN: number | null;
      maxViews: number | null;
      lastPublishedAt: string | null;
      lastCheckedAt: string | null;
    },
  ): void {
    this.database.prepare(
      `UPDATE topic_channels SET baseline_median_views=?, baseline_n=?, max_views=?,
         baseline_at=?, last_published_at=?, last_checked_at=?
       WHERE topic_id=? AND channel_id=?`,
    ).run(
      baseline.baselineMedianViews, baseline.baselineN, baseline.maxViews,
      nowIso(), baseline.lastPublishedAt, baseline.lastCheckedAt,
      topicId, channelId,
    );
  }

  /**
   * Gợi ý của máy cho người (vd 'pause_silent'). suggestion=null = gỡ gợi ý.
   * Không bao giờ đổi status — quyết định là của người (tôn chỉ 1).
   */
  setChannelSuggestion(topicId: string, channelId: string, suggestion: string | null): void {
    this.database.prepare(
      'UPDATE topic_channels SET suggestion=?, suggestion_at=? WHERE topic_id=? AND channel_id=?',
    ).run(suggestion, suggestion === null ? null : nowIso(), topicId, channelId);
  }

  /**
   * Ghi video topic đang theo dõi + cập nhật bản sao latest_* để dashboard đọc
   * nhanh. first_seen_at/source/found_by_keyword là provenance — upsert sau
   * không đè nguồn ban đầu.
   */
  upsertTopicVideo(row: {
    topicId: string;
    videoId: string;
    channelId: string;
    title: string;
    publishedAt?: string | null;
    durationSec?: number | null;
    thumbnailUrl?: string | null;
    source: string;
    foundByKeyword?: string | null;
    views: number | null;
    likes?: number | null;
    comments?: number | null;
    capturedAt: string;
  }): void {
    this.database.prepare(
      `INSERT INTO topic_videos
         (topic_id, video_id, channel_id, title, published_at, duration_sec,
          thumbnail_url, source, found_by_keyword, first_seen_at,
          latest_views, latest_likes, latest_comments, latest_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(topic_id, video_id) DO UPDATE SET
         title=excluded.title,
         channel_id=excluded.channel_id,
         published_at=COALESCE(excluded.published_at, topic_videos.published_at),
         duration_sec=COALESCE(excluded.duration_sec, topic_videos.duration_sec),
         thumbnail_url=COALESCE(excluded.thumbnail_url, topic_videos.thumbnail_url),
         found_by_keyword=COALESCE(topic_videos.found_by_keyword, excluded.found_by_keyword),
         latest_views=excluded.latest_views,
         latest_likes=excluded.latest_likes,
         latest_comments=excluded.latest_comments,
         latest_at=excluded.latest_at`,
    ).run(
      row.topicId, row.videoId, row.channelId, row.title,
      row.publishedAt ?? null, row.durationSec ?? null, row.thumbnailUrl ?? null,
      row.source, row.foundByKeyword ?? null, row.capturedAt,
      row.views, row.likes ?? null, row.comments ?? null, row.capturedAt,
    );
  }

  /**
   * Snapshot view append-only — INSERT OR IGNORE theo (topic, video, day) nên
   * quét lại trong cùng ngày không tạo thêm dòng (sai số ngày là chấp nhận
   * được, cộng dồn thì không).
   */
  recordVideoDailyView(row: {
    topicId: string;
    videoId: string;
    day: string;
    views: number;
    likes?: number | null;
    comments?: number | null;
    capturedAt: string;
  }): { inserted: boolean } {
    const result = this.database.prepare(
      `INSERT OR IGNORE INTO video_daily_views
         (topic_id, video_id, day, views, likes, comments, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.topicId, row.videoId, row.day, row.views,
      row.likes ?? null, row.comments ?? null, row.capturedAt,
    );
    return { inserted: Number(result.changes) > 0 };
  }

  /** views_gained_24h/outlier_score do flow tính (L6: NULL khi mới 1 snapshot). */
  updateVideoDerived(
    topicId: string,
    videoId: string,
    derived: { viewsGained24h: number | null; outlierScore: number | null },
  ): void {
    this.database.prepare(
      'UPDATE topic_videos SET views_gained_24h=?, outlier_score=? WHERE topic_id=? AND video_id=?',
    ).run(derived.viewsGained24h, derived.outlierScore, topicId, videoId);
  }

  listVideoDailyViews(topicId: string, videoId: string, limit = 30): { day: string; views: number }[] {
    return this.database.prepare(
      'SELECT day, views FROM video_daily_views WHERE topic_id=? AND video_id=? ORDER BY day DESC LIMIT ?',
    ).all(topicId, videoId, limit).map((row) => ({
      day: String((row as Row)['day']),
      views: Number((row as Row)['views']),
    }));
  }

  listTopicVideos(topicId: string, filter: {
    channelId?: string;
    publishedAfter?: string;
    minOutlier?: number;
    source?: string;
    limit?: number;
  } = {}): TopicVideoRow[] {
    const where: string[] = ['topic_id=?'];
    const params: Array<string | number> = [topicId];
    if (filter.channelId !== undefined) { where.push('channel_id=?'); params.push(filter.channelId); }
    if (filter.publishedAfter !== undefined) { where.push('published_at>=?'); params.push(filter.publishedAfter); }
    if (filter.minOutlier !== undefined) { where.push('outlier_score>=?'); params.push(filter.minOutlier); }
    if (filter.source !== undefined) { where.push('source=?'); params.push(filter.source); }
    params.push(filter.limit ?? 100);
    return this.database.prepare(
      `SELECT * FROM topic_videos WHERE ${where.join(' AND ')}
       ORDER BY published_at DESC, latest_views DESC LIMIT ?`,
    ).all(...params).map((row) => topicVideoRowFromRow(row as Row));
  }

  /**
   * Đề xuất keyword ứng viên (S3 n-gram, W4 outlier_title). CHỈ tạo
   * status='pending' — INSERT OR IGNORE, không ghi đè quyết định đã có.
   */
  upsertKeywordCandidate(input: {
    topicId: string;
    termKey: string;
    displayTerm: string;
    origin: KeywordOrigin;
    evidenceJson: string;
    tickId?: string;
  }): { inserted: boolean } {
    const result = this.database.prepare(
      `INSERT OR IGNORE INTO topic_keywords
         (topic_id, term_key, display_term, relation, evidence_json, status, origin, added_at, added_by)
       VALUES (?, ?, ?, '', ?, 'pending', ?, ?, ?)`,
    ).run(
      input.topicId, input.termKey, input.displayTerm,
      input.evidenceJson, input.origin, nowIso(),
      input.origin === 'user' ? 'user' : 'loop',
    );
    const inserted = Number(result.changes) > 0;
    if (inserted) {
      this.recordDecision({
        topicId: input.topicId,
        actor: 'loop',
        entityType: 'keyword',
        entityId: input.termKey,
        fromStatus: null,
        toStatus: 'pending',
        reason: `candidate:${input.origin}`,
        tickId: input.tickId,
      });
    }
    return { inserted };
  }

  listKeywordsByStatus(topicId: string, statuses: string[]): TopicKeywordRow[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(',');
    return this.database.prepare(
      `SELECT * FROM topic_keywords WHERE topic_id=? AND status IN (${placeholders})
       ORDER BY yield_channels DESC, added_at ASC`,
    ).all(topicId, ...statuses).map((row) => topicKeywordRowFromRow(row as Row));
  }

  /**
   * Sức khoẻ keyword sau một lần search (W1): bao nhiêu kết quả, bao nhiêu từ
   * kênh đang follow, view trung vị. last_searched_at cũng được cập nhật để
   * code báo cáo cũ đọc đúng lần search gần nhất.
   */
  updateKeywordCheck(
    topicId: string,
    termKey: string,
    check: {
      lastCheckedAt: string;
      lastNResults: number | null;
      lastNFollowed: number | null;
      lastMedianViews: number | null;
    },
  ): void {
    this.database.prepare(
      `UPDATE topic_keywords SET last_checked_at=?, last_n_results=?,
         last_n_followed=?, last_median_views=?, last_searched_at=?
       WHERE topic_id=? AND term_key=?`,
    ).run(
      check.lastCheckedAt, check.lastNResults, check.lastNFollowed,
      check.lastMedianViews, check.lastCheckedAt, topicId, termKey,
    );
  }

  /**
   * Quyết định của NGƯỜI trên kênh — đường duy nhất chuyển sang
   * active/paused/rejected (lý do khác) hoặc trả về new/own. Ghi decisions
   * actor='human' làm bằng chứng tôn chỉ 1.
   */
  decideChannel(topicId: string, channelId: string, toStatus: string, reason: string | null): void {
    if (!['new', 'active', 'paused', 'rejected', 'own'].includes(toStatus)) {
      throw new AppError('invalid_input', `to_status kênh không hợp lệ: ${toStatus}`);
    }
    const current = this.database.prepare(
      'SELECT status FROM topic_channels WHERE topic_id=? AND channel_id=?',
    ).get(topicId, channelId) as Row | undefined;
    if (!current) {
      throw new AppError('not_found', `Kênh ${channelId} không có trong topic ${topicId}`);
    }
    const now = nowIso();
    this.database.prepare(
      `UPDATE topic_channels SET status=?, decided_by='user', decided_at=?, decided_reason=?
       WHERE topic_id=? AND channel_id=?`,
    ).run(toStatus, now, reason, topicId, channelId);
    this.recordDecision({
      topicId,
      actor: 'human',
      entityType: 'channel',
      entityId: channelId,
      fromStatus: nullableString(current['status']),
      toStatus,
      reason: reason ?? 'human_decision',
    });
  }

  /** Quyết định của NGƯỜI trên keyword — tương đương decideChannel. */
  decideKeyword(topicId: string, termKey: string, toStatus: string, reason: string | null): void {
    if (!['pending', 'active', 'paused', 'rejected'].includes(toStatus)) {
      throw new AppError('invalid_input', `to_status keyword không hợp lệ: ${toStatus}`);
    }
    const current = this.database.prepare(
      'SELECT status FROM topic_keywords WHERE topic_id=? AND term_key=?',
    ).get(topicId, termKey) as Row | undefined;
    if (!current) {
      throw new AppError('not_found', `Keyword ${termKey} không có trong topic ${topicId}`);
    }
    const now = nowIso();
    this.database.prepare(
      'UPDATE topic_keywords SET status=?, decided_at=?, decided_reason=? WHERE topic_id=? AND term_key=?',
    ).run(toStatus, now, reason, topicId, termKey);
    this.recordDecision({
      topicId,
      actor: 'human',
      entityType: 'keyword',
      entityId: termKey,
      fromStatus: nullableString(current['status']),
      toStatus,
      reason: reason ?? 'human_decision',
    });
  }

  /**
   * Nhật ký quyết định — nội bộ. Mọi đổi trạng thái kênh/keyword phải đi qua
   * đây để trả lời được "ai, khi nào, vì sao" (bằng chứng tôn chỉ 1).
   */
  recordDecision(input: {
    topicId: string;
    actor: 'human' | 'loop';
    entityType: 'channel' | 'keyword';
    entityId: string;
    fromStatus: string | null;
    toStatus: string;
    reason: string;
    tickId?: string;
  }): void {
    this.database.prepare(
      `INSERT INTO decisions (id, topic_id, at, actor, entity_type, entity_id, from_status, to_status, reason, tick_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(), input.topicId, nowIso(), input.actor, input.entityType,
      input.entityId, input.fromStatus, input.toStatus, input.reason,
      input.tickId ?? null,
    );
  }

  listDecisions(topicId: string, filter: {
    entityType?: 'channel' | 'keyword';
    entityId?: string;
    limit?: number;
  } = {}): DecisionRow[] {
    const where: string[] = ['topic_id=?'];
    const params: Array<string | number> = [topicId];
    if (filter.entityType !== undefined) { where.push('entity_type=?'); params.push(filter.entityType); }
    if (filter.entityId !== undefined) { where.push('entity_id=?'); params.push(filter.entityId); }
    params.push(filter.limit ?? 100);
    return this.database.prepare(
      `SELECT * FROM decisions WHERE ${where.join(' AND ')} ORDER BY at DESC LIMIT ?`,
    ).all(...params).map((row) => decisionFromRow(row as Row));
  }

  // ── P0 Corpus Intelligence store ───────────────────────────────────────

  getP0CorpusImportBatch(id: string): P0CorpusImportBatch | null {
    const row = this.database.prepare('SELECT * FROM p0_corpus_import_batches WHERE id=?').get(id) as Row | undefined;
    return row ? p0ImportBatchFromRow(row) : null;
  }

  getP0CorpusImportByIdempotency(ownerSubject: string, topicId: string, idempotencyKey: string): P0CorpusImportBatch | null {
    const row = this.database.prepare(
      'SELECT * FROM p0_corpus_import_batches WHERE owner_subject=? AND topic_id=? AND idempotency_key=?',
    ).get(ownerSubject, topicId, idempotencyKey) as Row | undefined;
    return row ? p0ImportBatchFromRow(row) : null;
  }

  /**
   * The local UI can lose a successful response and regenerate its request
   * UUID.  While a canonical video is still draft/confirmed, reattach rather
   * than creating a second pending import for the same corpus fact.
   */
  getActiveP0CorpusImportByVideo(topicId: string, sourceVideoId: string): P0CorpusImportBatch | null {
    const row = this.database.prepare(
      `SELECT b.* FROM p0_corpus_import_batches b
       JOIN p0_corpus_import_items i ON i.batch_id=b.id
       WHERE b.topic_id=? AND i.source_video_id=? AND b.status IN ('draft','confirmed')
       ORDER BY b.created_at ASC, b.id ASC LIMIT 1`,
    ).get(topicId, sourceVideoId) as Row | undefined;
    return row ? p0ImportBatchFromRow(row) : null;
  }

  listP0CorpusImportBatches(topicId: string): P0CorpusImportBatch[] {
    return (this.database.prepare(
      'SELECT * FROM p0_corpus_import_batches WHERE topic_id=? ORDER BY created_at DESC, id',
    ).all(topicId) as Row[]).map(p0ImportBatchFromRow);
  }

  createP0CorpusImportBatch(input: Omit<P0CorpusImportBatch, 'id' | 'createdAt' | 'decidedAt' | 'status'> & { id?: string }): P0CorpusImportBatch {
    const id = input.id ?? randomUUID();
    const createdAt = nowIso();
    this.database.prepare(
      `INSERT INTO p0_corpus_import_batches
       (id,topic_id,owner_subject,idempotency_key,request_digest,status,created_at)
       VALUES (?,?,?,?,?,'draft',?)`,
    ).run(id, input.topicId, input.ownerSubject, input.idempotencyKey, input.requestDigest, createdAt);
    return this.getP0CorpusImportBatch(id)!;
  }

  insertP0CorpusImportItem(input: Omit<P0CorpusImportItem, 'id' | 'status' | 'promotedMembershipId'> & { id?: string }): P0CorpusImportItem {
    const id = input.id ?? randomUUID();
    this.database.prepare(
      `INSERT INTO p0_corpus_import_items
       (id,batch_id,submitted_url,canonical_url,source_video_id,identity_status,evidence_artifact_json,evidence_digest,captured_at,expires_at,status)
       VALUES (?,?,?,?,?,?,?,?,?,?,'draft')`,
    ).run(
      id, input.batchId, input.submittedUrl, input.canonicalUrl, input.sourceVideoId, input.identityStatus,
      JSON.stringify(input.evidenceArtifact), input.evidenceDigest, input.capturedAt, input.expiresAt,
    );
    const row = this.database.prepare('SELECT * FROM p0_corpus_import_items WHERE id=?').get(id) as Row;
    return p0ImportItemFromRow(row);
  }

  listP0CorpusImportItems(batchId: string): P0CorpusImportItem[] {
    return (this.database.prepare(
      'SELECT * FROM p0_corpus_import_items WHERE batch_id=? ORDER BY id',
    ).all(batchId) as Row[]).map(p0ImportItemFromRow);
  }

  confirmP0CorpusImportBatch(input: { batchId: string; ownerSubject: string }): { batch: P0CorpusImportBatch; memberships: P0CorpusMembership[] } {
    return this.transaction(() => {
      const batch = this.getP0CorpusImportBatch(input.batchId);
      if (!batch) throw new AppError('not_found', 'Corpus import batch không tồn tại');
      if (batch.ownerSubject !== input.ownerSubject) throw new AppError('forbidden', 'Không có quyền confirm corpus import batch này');
      const items = this.listP0CorpusImportItems(batch.id);
      if (batch.status === 'rejected') throw new AppError('invalid_input', 'Corpus import batch đã bị reject');
      const memberships: P0CorpusMembership[] = [];
      const now = nowIso();
      for (const item of items) {
        let membership = this.getP0CorpusMembershipByVideo(batch.topicId, item.sourceVideoId);
        if (!membership) {
          const id = randomUUID();
          this.database.prepare(
            `INSERT INTO p0_corpus_memberships
             (id,topic_id,entity_kind,canonical_url,source_video_id,status,identity_status,created_from_kind,created_from_id,created_at,confirmed_at)
             VALUES (?,?,'video',? ,?,'confirmed',?,'corpus_import',?,?,?)`,
          ).run(id, batch.topicId, item.canonicalUrl, item.sourceVideoId, item.identityStatus, item.id, now, now);
          membership = this.getP0CorpusMembership(id)!;
        }
        this.database.prepare(
          `UPDATE p0_corpus_import_items SET status='confirmed', promoted_membership_id=? WHERE id=?`,
        ).run(membership.id, item.id);
        memberships.push(membership);
      }
      this.database.prepare(
        `UPDATE p0_corpus_import_batches SET status='confirmed', decided_at=? WHERE id=?`,
      ).run(now, batch.id);
      return { batch: this.getP0CorpusImportBatch(batch.id)!, memberships };
    });
  }

  rejectP0CorpusImportBatch(input: { batchId: string; ownerSubject: string }): P0CorpusImportBatch {
    return this.transaction(() => {
      const batch = this.getP0CorpusImportBatch(input.batchId);
      if (!batch) throw new AppError('not_found', 'Corpus import batch không tồn tại');
      if (batch.ownerSubject !== input.ownerSubject) throw new AppError('forbidden', 'Không có quyền reject corpus import batch này');
      if (batch.status === 'confirmed') throw new AppError('invalid_input', 'Corpus import batch đã confirm không thể reject');
      const now = nowIso();
      this.database.prepare("UPDATE p0_corpus_import_items SET status='rejected' WHERE batch_id=?").run(batch.id);
      this.database.prepare("UPDATE p0_corpus_import_batches SET status='rejected', decided_at=? WHERE id=?").run(now, batch.id);
      return this.getP0CorpusImportBatch(batch.id)!;
    });
  }

  getP0CorpusMembership(id: string): P0CorpusMembership | null {
    const row = this.database.prepare('SELECT * FROM p0_corpus_memberships WHERE id=?').get(id) as Row | undefined;
    return row ? p0MembershipFromRow(row) : null;
  }

  getP0CorpusMembershipByVideo(topicId: string, sourceVideoId: string): P0CorpusMembership | null {
    const row = this.database.prepare(
      "SELECT * FROM p0_corpus_memberships WHERE topic_id=? AND entity_kind='video' AND source_video_id=?",
    ).get(topicId, sourceVideoId) as Row | undefined;
    return row ? p0MembershipFromRow(row) : null;
  }

  listP0CorpusMemberships(topicId: string): P0CorpusMembership[] {
    return (this.database.prepare(
      'SELECT * FROM p0_corpus_memberships WHERE topic_id=? ORDER BY confirmed_at DESC, id',
    ).all(topicId) as Row[]).map(p0MembershipFromRow);
  }

  getP0RecommendationBatch(id: string): P0RecommendationCaptureBatch | null {
    const row = this.database.prepare('SELECT * FROM p0_recommendation_capture_batches WHERE id=?').get(id) as Row | undefined;
    return row ? p0RecommendationBatchFromRow(row) : null;
  }

  getP0RecommendationByIdempotency(ownerSubject: string, topicId: string, idempotencyKey: string): P0RecommendationCaptureBatch | null {
    const row = this.database.prepare(
      'SELECT * FROM p0_recommendation_capture_batches WHERE owner_subject=? AND topic_id=? AND idempotency_key=?',
    ).get(ownerSubject, topicId, idempotencyKey) as Row | undefined;
    return row ? p0RecommendationBatchFromRow(row) : null;
  }

  /** One direct-suggestion surface may be under review for a seed at a time. */
  getActiveP0RecommendationBatchForSeed(topicId: string, seedMembershipId: string): P0RecommendationCaptureBatch | null {
    const row = this.database.prepare(
      `SELECT * FROM p0_recommendation_capture_batches
       WHERE topic_id=? AND seed_membership_id=? AND status IN ('capturing','draft')
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).get(topicId, seedMembershipId) as Row | undefined;
    return row ? p0RecommendationBatchFromRow(row) : null;
  }

  createP0RecommendationBatch(input: {
    topicId: string; seedMembershipId: string; fromVideoId: string; seedCanonicalUrl: string;
    ownerSubject: string; idempotencyKey: string; requestDigest: string;
  }): P0RecommendationCaptureBatch {
    const id = randomUUID();
    this.database.prepare(
      `INSERT INTO p0_recommendation_capture_batches
       (id,topic_id,seed_membership_id,from_video_id,seed_canonical_url,owner_subject,idempotency_key,request_digest,requested_depth,requested_limit,status,created_at)
       VALUES (?,?,?,?,?,?,?,?,1,20,'capturing',?)`,
    ).run(id, input.topicId, input.seedMembershipId, input.fromVideoId, input.seedCanonicalUrl, input.ownerSubject, input.idempotencyKey, input.requestDigest, nowIso());
    return this.getP0RecommendationBatch(id)!;
  }

  finalizeP0RecommendationBatch(input: {
    batchId: string; captureMethod: string; adapterVersion: string; captureArtifact: ArtifactRef;
    capturedAt: string; expiresAt: string;
    observations: Array<Omit<P0RecommendationObservation, 'id' | 'batchId' | 'status' | 'promotedMembershipId' | 'decidedBy' | 'decidedAt'>>;
  }): P0RecommendationCaptureBatch {
    return this.transaction(() => {
      const batch = this.getP0RecommendationBatch(input.batchId);
      if (!batch) throw new AppError('not_found', 'Recommendation capture batch không tồn tại');
      if (batch.status !== 'capturing') throw new AppError('invalid_input', 'Recommendation capture batch không còn ở trạng thái capturing');
      const insert = this.database.prepare(
        `INSERT INTO p0_recommendation_observations
         (id,batch_id,seed_membership_id,from_video_id,target_video_id,target_canonical_url,target_title,target_channel_id,target_channel_title,target_identity_status,observed_position,capture_artifact_digest,observed_at,expires_at,status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'draft')`,
      );
      for (const observation of input.observations) {
        insert.run(
          randomUUID(), batch.id, observation.seedMembershipId, observation.fromVideoId, observation.targetVideoId,
          observation.targetCanonicalUrl, observation.targetTitle, observation.targetChannelId, observation.targetChannelTitle,
          observation.targetIdentityStatus, observation.observedPosition, observation.captureArtifactDigest,
          observation.observedAt, observation.expiresAt,
        );
      }
      this.database.prepare(
        `UPDATE p0_recommendation_capture_batches
         SET capture_method=?,adapter_version=?,capture_artifact_json=?,capture_digest=?,captured_at=?,expires_at=?,status='draft'
         WHERE id=?`,
      ).run(input.captureMethod, input.adapterVersion, JSON.stringify(input.captureArtifact), input.captureArtifact.hash, input.capturedAt, input.expiresAt, batch.id);
      return this.getP0RecommendationBatch(batch.id)!;
    });
  }

  failP0RecommendationBatch(input: { batchId: string; code: string; reason: string }): P0RecommendationCaptureBatch {
    const batch = this.getP0RecommendationBatch(input.batchId);
    if (!batch) throw new AppError('not_found', 'Recommendation capture batch không tồn tại');
    if (batch.status === 'capturing') {
      this.database.prepare(
        "UPDATE p0_recommendation_capture_batches SET status='failed', failure_code=?, failure_reason=? WHERE id=?",
      ).run(input.code, input.reason.slice(0, 1000), batch.id);
    }
    return this.getP0RecommendationBatch(batch.id)!;
  }

  listP0RecommendationBatches(topicId: string): P0RecommendationCaptureBatch[] {
    return (this.database.prepare(
      'SELECT * FROM p0_recommendation_capture_batches WHERE topic_id=? ORDER BY created_at DESC, id',
    ).all(topicId) as Row[]).map(p0RecommendationBatchFromRow);
  }

  listP0RecommendationObservations(batchId: string): P0RecommendationObservation[] {
    return (this.database.prepare(
      'SELECT * FROM p0_recommendation_observations WHERE batch_id=? ORDER BY observed_position, id',
    ).all(batchId) as Row[]).map(p0RecommendationObservationFromRow);
  }

  getP0RecommendationObservation(id: string): P0RecommendationObservation | null {
    const row = this.database.prepare('SELECT * FROM p0_recommendation_observations WHERE id=?').get(id) as Row | undefined;
    return row ? p0RecommendationObservationFromRow(row) : null;
  }

  decideP0RecommendationObservation(input: { observationId: string; ownerSubject: string; decision: 'confirmed' | 'rejected' }): { observation: P0RecommendationObservation; membership: P0CorpusMembership | null } {
    return this.transaction(() => {
      const observation = this.getP0RecommendationObservation(input.observationId);
      if (!observation) throw new AppError('not_found', 'Recommendation observation không tồn tại');
      const batch = this.getP0RecommendationBatch(observation.batchId);
      if (!batch) throw new AppError('internal', 'Recommendation batch không tồn tại');
      if (batch.ownerSubject !== input.ownerSubject) throw new AppError('forbidden', 'Không có quyền review suggestion này');
      if (observation.status !== 'draft') throw new AppError('invalid_input', 'Suggestion không còn ở trạng thái draft');
      const now = nowIso();
      if (input.decision === 'rejected') {
        this.database.prepare(
          "UPDATE p0_recommendation_observations SET status='rejected', decided_by=?, decided_at=? WHERE id=?",
        ).run(input.ownerSubject, now, observation.id);
        return { observation: this.getP0RecommendationObservation(observation.id)!, membership: null };
      }
      let membership = this.getP0CorpusMembershipByVideo(batch.topicId, observation.targetVideoId);
      if (!membership) {
        const id = randomUUID();
        this.database.prepare(
          `INSERT INTO p0_corpus_memberships
           (id,topic_id,entity_kind,canonical_url,source_video_id,status,identity_status,created_from_kind,created_from_id,created_at,confirmed_at)
           VALUES (?,?,'video',? ,?,'confirmed',?,'recommendation',?,?,?)`,
        ).run(id, batch.topicId, observation.targetCanonicalUrl, observation.targetVideoId, observation.targetIdentityStatus, observation.id, now, now);
        membership = this.getP0CorpusMembership(id)!;
      }
      this.database.prepare(
        "UPDATE p0_recommendation_observations SET status='confirmed', promoted_membership_id=?, decided_by=?, decided_at=? WHERE id=?",
      ).run(membership.id, input.ownerSubject, now, observation.id);
      return { observation: this.getP0RecommendationObservation(observation.id)!, membership };
    });
  }

  getP0EvidenceRecord(membershipId: string, kind: P0EvidenceRecord['kind']): P0EvidenceRecord | null {
    const row = this.database.prepare('SELECT * FROM p0_evidence_records WHERE membership_id=? AND kind=?').get(membershipId, kind) as Row | undefined;
    return row ? p0EvidenceFromRow(row) : null;
  }

  listP0EvidenceRecords(membershipId: string): P0EvidenceRecord[] {
    return (this.database.prepare('SELECT * FROM p0_evidence_records WHERE membership_id=? ORDER BY kind').all(membershipId) as Row[]).map(p0EvidenceFromRow);
  }

  upsertP0EvidenceRecord(input: Omit<P0EvidenceRecord, 'id'> & { id?: string }): P0EvidenceRecord {
    const existing = this.getP0EvidenceRecord(input.membershipId, input.kind);
    const id = existing?.id ?? input.id ?? randomUUID();
    this.database.prepare(
      `INSERT INTO p0_evidence_records
       (id,membership_id,kind,status,method,adapter_version,artifact_json,artifact_digest,observed_at,expires_at,detail_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(membership_id,kind) DO UPDATE SET
         status=excluded.status,method=excluded.method,adapter_version=excluded.adapter_version,
         artifact_json=excluded.artifact_json,artifact_digest=excluded.artifact_digest,
         observed_at=excluded.observed_at,expires_at=excluded.expires_at,detail_json=excluded.detail_json`,
    ).run(
      id, input.membershipId, input.kind, input.status, input.method, input.adapterVersion,
      input.artifact ? JSON.stringify(input.artifact) : null, input.artifactDigest,
      input.observedAt, input.expiresAt, JSON.stringify(input.detail),
    );
    return this.getP0EvidenceRecord(input.membershipId, input.kind)!;
  }

  getP0SemanticAnalysisRun(id: string): P0SemanticAnalysisRun | null {
    const row = this.database.prepare('SELECT * FROM p0_semantic_analysis_runs WHERE id=?').get(id) as Row | undefined;
    return row ? p0AnalysisFromRow(row) : null;
  }

  getP0SemanticAnalysisByIdempotency(ownerSubject: string, topicId: string, idempotencyKey: string): P0SemanticAnalysisRun | null {
    const row = this.database.prepare(
      'SELECT * FROM p0_semantic_analysis_runs WHERE owner_subject=? AND topic_id=? AND idempotency_key=?',
    ).get(ownerSubject, topicId, idempotencyKey) as Row | undefined;
    return row ? p0AnalysisFromRow(row) : null;
  }

  /** Dedupes a review independently of a client retry key. */
  getP0SemanticAnalysisByManifest(input: {
    topicId: string; membershipId: string; inputManifestDigest: string; policyVersion: string; model: string;
  }): P0SemanticAnalysisRun | null {
    const row = this.database.prepare(
      `SELECT * FROM p0_semantic_analysis_runs
       WHERE topic_id=? AND membership_id=? AND input_manifest_digest=? AND policy_version=? AND model=?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).get(input.topicId, input.membershipId, input.inputManifestDigest, input.policyVersion, input.model) as Row | undefined;
    return row ? p0AnalysisFromRow(row) : null;
  }

  createP0SemanticAnalysisRun(input: Omit<P0SemanticAnalysisRun, 'id' | 'status' | 'result' | 'rawResponseArtifact' | 'rawResponseDigest' | 'failureCode' | 'failureReason' | 'attempt' | 'createdAt' | 'completedAt'>): P0SemanticAnalysisRun {
    const id = randomUUID();
    this.database.prepare(
      `INSERT INTO p0_semantic_analysis_runs
       (id,topic_id,membership_id,owner_subject,idempotency_key,input_manifest_json,input_manifest_digest,policy_version,model,status,created_at,expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,'running',?,?)`,
    ).run(
      id, input.topicId, input.membershipId, input.ownerSubject, input.idempotencyKey,
      JSON.stringify(input.inputManifest), input.inputManifestDigest, input.policyVersion, input.model, nowIso(), input.expiresAt,
    );
    return this.getP0SemanticAnalysisRun(id)!;
  }

  completeP0SemanticAnalysisRun(input: { id: string; result: Record<string, unknown>; rawResponseArtifact: ArtifactRef | null }): P0SemanticAnalysisRun {
    const run = this.getP0SemanticAnalysisRun(input.id);
    if (!run) throw new AppError('not_found', 'Gemini analysis run không tồn tại');
    this.database.prepare(
      `UPDATE p0_semantic_analysis_runs
       SET status='completed',result_json=?,raw_response_artifact_json=?,raw_response_digest=?,completed_at=? WHERE id=?`,
    ).run(
      JSON.stringify(input.result), input.rawResponseArtifact ? JSON.stringify(input.rawResponseArtifact) : null,
      input.rawResponseArtifact?.hash ?? null, nowIso(), input.id,
    );
    return this.getP0SemanticAnalysisRun(input.id)!;
  }

  failP0SemanticAnalysisRun(input: { id: string; code: string; reason: string }): P0SemanticAnalysisRun {
    const run = this.getP0SemanticAnalysisRun(input.id);
    if (!run) throw new AppError('not_found', 'Gemini analysis run không tồn tại');
    if (run.status === 'running') {
      this.database.prepare(
        "UPDATE p0_semantic_analysis_runs SET status='failed',failure_code=?,failure_reason=?,completed_at=? WHERE id=?",
      ).run(input.code, input.reason.slice(0, 1000), nowIso(), input.id);
    }
    return this.getP0SemanticAnalysisRun(input.id)!;
  }

  listP0SemanticAnalysisRuns(topicId: string): P0SemanticAnalysisRun[] {
    return (this.database.prepare(
      'SELECT * FROM p0_semantic_analysis_runs WHERE topic_id=? ORDER BY created_at DESC, id',
    ).all(topicId) as Row[]).map(p0AnalysisFromRow);
  }

  setP0LoopEnabled(topicId: string, enabled: boolean): boolean {
    this.database.prepare(
      `INSERT INTO p0_loop_controls(topic_id,enabled,updated_at) VALUES (?,?,?)
       ON CONFLICT(topic_id) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at`,
    ).run(topicId, enabled ? 1 : 0, nowIso());
    return enabled;
  }

  isP0LoopEnabled(topicId: string): boolean {
    const row = this.database.prepare('SELECT enabled FROM p0_loop_controls WHERE topic_id=?').get(topicId) as Row | undefined;
    return row ? Number(row['enabled']) === 1 : false;
  }

  getP0LoopRun(id: string): P0LoopRun | null {
    const row = this.database.prepare('SELECT * FROM p0_loop_runs WHERE id=?').get(id) as Row | undefined;
    return row ? p0LoopRunFromRow(row) : null;
  }

  getP0LoopRunByIdempotency(ownerSubject: string, topicId: string, idempotencyKey: string): P0LoopRun | null {
    const row = this.database.prepare(
      'SELECT * FROM p0_loop_runs WHERE owner_subject=? AND topic_id=? AND idempotency_key=?',
    ).get(ownerSubject, topicId, idempotencyKey) as Row | undefined;
    return row ? p0LoopRunFromRow(row) : null;
  }

  listP0LoopRuns(topicId: string): P0LoopRun[] {
    return (this.database.prepare(
      'SELECT * FROM p0_loop_runs WHERE topic_id=? ORDER BY created_at DESC, id',
    ).all(topicId) as Row[]).map(p0LoopRunFromRow);
  }

  getActiveP0LoopRun(topicId: string): P0LoopRun | null {
    const row = this.database.prepare(
      `SELECT * FROM p0_loop_runs WHERE topic_id=? AND status='running'
       ORDER BY created_at ASC, id ASC LIMIT 1`,
    ).get(topicId) as Row | undefined;
    return row ? p0LoopRunFromRow(row) : null;
  }

  createP0LoopRun(input: { topicId: string; ownerSubject: string; idempotencyKey: string }): P0LoopRun {
    const id = randomUUID();
    const createdAt = nowIso();
    this.database.prepare(
      `INSERT INTO p0_loop_runs(id,topic_id,owner_subject,idempotency_key,status,phase,resume_index,summary_json,created_at)
       VALUES (?,?,?,?,'running','enrich',0,'{}',?)`,
    ).run(id, input.topicId, input.ownerSubject, input.idempotencyKey, createdAt);
    return this.getP0LoopRun(id)!;
  }

  updateP0LoopRun(input: {
    id: string; status?: P0LoopRun['status']; phase?: string; resumeIndex?: number;
    summary?: Record<string, unknown>; errorCode?: string | null; errorMessage?: string | null;
  }): P0LoopRun {
    const current = this.getP0LoopRun(input.id);
    if (!current) throw new AppError('not_found', 'P0 loop run không tồn tại');
    const status = input.status ?? current.status;
    const completedAt = ['completed', 'failed', 'blocked'].includes(status) ? nowIso() : null;
    this.database.prepare(
      `UPDATE p0_loop_runs SET status=?,phase=?,resume_index=?,summary_json=?,error_code=?,error_message=?,completed_at=? WHERE id=?`,
    ).run(
      status, input.phase ?? current.phase, input.resumeIndex ?? current.resumeIndex,
      JSON.stringify(input.summary ?? current.summary), input.errorCode ?? current.errorCode,
      input.errorMessage ?? current.errorMessage, completedAt, input.id,
    );
    return this.getP0LoopRun(input.id)!;
  }

  insertP0ReportOnce(input: { topicId: string; loopRunId: string; summary: Record<string, unknown> }): { report: P0Report; created: boolean } {
    return this.transaction(() => {
      const existing = this.database.prepare('SELECT * FROM p0_reports WHERE loop_run_id=?').get(input.loopRunId) as Row | undefined;
      if (existing) return { report: p0ReportFromRow(existing), created: false };
      const id = randomUUID();
      this.database.prepare(
        'INSERT INTO p0_reports(id,topic_id,loop_run_id,summary_json,created_at) VALUES (?,?,?,?,?)',
      ).run(id, input.topicId, input.loopRunId, JSON.stringify(input.summary), nowIso());
      return { report: p0ReportFromRow(this.database.prepare('SELECT * FROM p0_reports WHERE id=?').get(id) as Row), created: true };
    });
  }

  getP0ReportByLoopRun(loopRunId: string): P0Report | null {
    const row = this.database.prepare('SELECT * FROM p0_reports WHERE loop_run_id=?').get(loopRunId) as Row | undefined;
    return row ? p0ReportFromRow(row) : null;
  }

  listP0Reports(topicId: string): P0Report[] {
    return (this.database.prepare('SELECT * FROM p0_reports WHERE topic_id=? ORDER BY created_at DESC').all(topicId) as Row[]).map(p0ReportFromRow);
  }

  /** Mark expired P0 facts first; physical artifact removal is performed by ArtifactStore afterwards. */
  expireP0PublicEvidence(now: string): ArtifactRef[] {
    const refs = new Map<string, ArtifactRef>();
    const collect = (sql: string) => {
      for (const row of this.database.prepare(sql).all(now) as Row[]) {
        const ref = artifactFromJson(row['artifact_json']);
        if (ref) refs.set(ref.hash, ref);
      }
    };
    collect('SELECT evidence_artifact_json AS artifact_json FROM p0_corpus_import_items WHERE expires_at<=?');
    collect('SELECT capture_artifact_json AS artifact_json FROM p0_recommendation_capture_batches WHERE expires_at<=?');
    collect('SELECT artifact_json FROM p0_evidence_records WHERE expires_at<=?');
    collect('SELECT raw_response_artifact_json AS artifact_json FROM p0_semantic_analysis_runs WHERE expires_at<=?');
    this.transaction(() => {
      this.database.prepare("UPDATE p0_recommendation_capture_batches SET status='expired' WHERE expires_at IS NOT NULL AND expires_at<=?").run(now);
      this.database.prepare("UPDATE p0_recommendation_observations SET status='expired' WHERE expires_at<=?").run(now);
      this.database.prepare("UPDATE p0_evidence_records SET status='expired' WHERE expires_at<=?").run(now);
      this.database.prepare("UPDATE p0_semantic_analysis_runs SET status='expired' WHERE expires_at<=? AND status IN ('running','completed','failed')").run(now);
      this.database.prepare(
        `UPDATE p0_corpus_memberships SET status='expired'
         WHERE status='confirmed' AND (
           (created_from_kind='corpus_import' AND EXISTS (
             SELECT 1 FROM p0_corpus_import_items i WHERE i.id=p0_corpus_memberships.created_from_id AND i.expires_at<=?
           )) OR
           (created_from_kind='recommendation' AND EXISTS (
             SELECT 1 FROM p0_recommendation_observations r WHERE r.id=p0_corpus_memberships.created_from_id AND r.expires_at<=?
           ))
         )`,
      ).run(now, now);
    });
    return [...refs.values()];
  }

  /** Protect content-addressed files still referenced by any live P0 or legacy frame record. */
  isArtifactHashLive(hash: string, now: string): boolean {
    const scalar = (sql: string) => Number((this.database.prepare(sql).get(hash, now) as Row | undefined)?.['n'] ?? 0);
    const p0Live = [
      "SELECT COUNT(*) AS n FROM p0_corpus_import_items WHERE evidence_digest=? AND expires_at>?",
      "SELECT COUNT(*) AS n FROM p0_recommendation_capture_batches WHERE capture_digest=? AND expires_at>?",
      "SELECT COUNT(*) AS n FROM p0_evidence_records WHERE artifact_digest=? AND expires_at>?",
      "SELECT COUNT(*) AS n FROM p0_semantic_analysis_runs WHERE raw_response_digest=? AND expires_at>?",
    ].some((sql) => scalar(sql) > 0);
    if (p0Live) return true;
    const legacyQueries = [
      "SELECT COUNT(*) AS n FROM frame_samples WHERE json_extract(artifact_json, '$.hash')=?",
      "SELECT COUNT(*) AS n FROM video_snapshots WHERE json_extract(thumbnail_json, '$.hash')=?",
    ];
    return legacyQueries.some((sql) => Number((this.database.prepare(sql).get(hash) as Row | undefined)?.['n'] ?? 0) > 0);
  }

  recordP0ArtifactTombstone(hash: string, reason: string): void {
    this.database.prepare(
      `INSERT INTO p0_artifact_tombstones(artifact_hash,purged_at,reason) VALUES (?,?,?)
       ON CONFLICT(artifact_hash) DO NOTHING`,
    ).run(hash, nowIso(), reason.slice(0, 120));
  }

  hasP0ArtifactTombstone(hash: string): boolean {
    return Boolean(this.database.prepare('SELECT 1 FROM p0_artifact_tombstones WHERE artifact_hash=?').get(hash));
  }

  // ---------------------------------------------------------------------------
  // v9 — spy_global_video_search cache (search_query_cache / search_video_cache).
  // Intentionally does not touch video_snapshots/spy_runs — see the schema
  // comment above search_query_cache.
  // ---------------------------------------------------------------------------

  getSearchQueryCache(
    queryNorm: string,
    language: string,
    region: string,
    providerUsed: 'youtube_data_api' | 'ytdlp',
  ): SearchQueryCacheRow | null {
    const row = this.database.prepare(
      `SELECT * FROM search_query_cache WHERE query_norm=? AND language=? AND region=? AND provider_used=?`,
    ).get(queryNorm, language, region, providerUsed) as Row | undefined;
    return row ? searchQueryCacheFromRow(row) : null;
  }

  upsertSearchQueryCache(row: SearchQueryCacheRow): void {
    this.database.prepare(
      `INSERT INTO search_query_cache
       (id, query_norm, language, region, provider_used, limit_requested, locale_hints_applied,
        fallback_reason, video_ids_json, fetched_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(query_norm, language, region, provider_used) DO UPDATE SET
         limit_requested=excluded.limit_requested,
         locale_hints_applied=excluded.locale_hints_applied,
         fallback_reason=excluded.fallback_reason,
         video_ids_json=excluded.video_ids_json,
         fetched_at=excluded.fetched_at`,
    ).run(
      randomUUID(),
      row.queryNorm,
      row.language,
      row.region,
      row.providerUsed,
      row.limitRequested,
      row.localeHintsApplied ? 1 : 0,
      row.fallbackReason,
      JSON.stringify(row.videoIds),
      row.fetchedAt,
    );
  }

  /** Batched lookup. Missing ids are simply absent from the returned map. */
  getSearchVideoCacheRows(sourceVideoIds: readonly string[]): Map<string, SearchVideoCacheRow> {
    const result = new Map<string, SearchVideoCacheRow>();
    if (sourceVideoIds.length === 0) return result;
    const ids = [...new Set(sourceVideoIds)];
    const rows = this.database.prepare(
      `SELECT * FROM search_video_cache WHERE source_video_id IN (${ids.map(() => '?').join(',')})`,
    ).all(...ids) as Row[];
    for (const row of rows) {
      const parsed = searchVideoCacheFromRow(row);
      result.set(parsed.sourceVideoId, parsed);
    }
    return result;
  }

  /**
   * Merge-upsert: a write with `publishedAtKnown: false` (yt-dlp fallback,
   * which never reports a date) must never overwrite an already-known date
   * from a prior Data API fetch. View/duration/title always take the newest
   * value — those decay with time and a fresher read is always better;
   * `first_seen_at` is preserved from the original insert.
   */
  upsertSearchVideoCache(row: SearchVideoCacheRow): void {
    this.database.prepare(
      `INSERT INTO search_video_cache
       (source_video_id, title, channel_title, canonical_url, view_count, duration_sec,
        published_at, published_at_known, provider_used, fetched_at, first_seen_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(source_video_id) DO UPDATE SET
         title=excluded.title,
         channel_title=excluded.channel_title,
         canonical_url=excluded.canonical_url,
         view_count=excluded.view_count,
         duration_sec=excluded.duration_sec,
         published_at=CASE WHEN excluded.published_at_known=1 THEN excluded.published_at ELSE search_video_cache.published_at END,
         published_at_known=MAX(search_video_cache.published_at_known, excluded.published_at_known),
         provider_used=excluded.provider_used,
         fetched_at=excluded.fetched_at`,
    ).run(
      row.sourceVideoId,
      row.title,
      row.channelTitle,
      row.canonicalUrl,
      row.viewCount,
      row.durationSec,
      row.publishedAt,
      row.publishedAtKnown ? 1 : 0,
      row.providerUsed,
      row.fetchedAt,
      row.firstSeenAt,
    );
  }
}
