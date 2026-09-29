/**
 * board/queries.ts — 6 truy vấn đọc của Board (plan spy-analyst-workflow §F1).
 * HTTP /api/spy/board/* và MCP spy_board_* đều gọi các hàm này → cùng tham số
 * thì cùng số. Mọi chỉ số đi qua board/metrics.ts; ở đây chỉ nạp dữ liệu,
 * gom theo ngách và phân trang.
 *
 * Ngách của kênh = group_key của kênh (keyword đầu tiên tìm ra nó, hoặc người
 * gán). Video thuộc ngách của kênh; video của kênh chưa đo thì theo ngách của
 * keyword tìm ra nó. NULL = "chưa gán" (trả về niche=null).
 */
import type { Database } from 'bun:sqlite';
import { dashTopicSettings } from '../dash/registry.ts';
import { KEYWORD_RESEARCH_DAYS } from '../loop/modes.ts';
import {
  DEFAULT_BOARD_SETTINGS,
  ageDays,
  channelBaselineFor,
  isLongVideo,
  isSmallChannel,
  metricDefinitions,
  nicheFloor,
  repeatSmall,
  scoreVideo,
  type BaselineTier,
  type BoardSettings,
  type BoardVideoInput,
  type NicheFloor,
  type RepeatCount,
  type VideoScore,
} from './metrics.ts';

type Row = Record<string, unknown>;
const DAY_MS = 86_400_000;
export const BOARD_MAX_LIMIT = 500;
export const BOARD_DEFAULT_LIMIT = 50;

// ── Khung response chung ────────────────────────────────────────────────────

export interface BoardFreshness {
  /** Lượt Theo dõi (daily tick) gần nhất đã xong. */
  lastTrackAt: string | null;
  /** Lượt Tìm mới (keyword run / weekly) gần nhất đã xong. */
  lastDiscoverAt: string | null;
}

export interface BoardEnvelope<T> {
  data: T;
  /** Mốc dữ liệu mới nhất đứng sau con số (max latest_at / measured_at). */
  dataAsOf: string | null;
  /** Lượt chạy gần nhất đã góp dữ liệu (Theo dõi + Tìm mới). */
  runIds: string[];
  freshness: BoardFreshness;
  sample: { channels: number; videos: number };
  limit: number | null;
  truncated: boolean;
}

// ── Nạp dữ liệu một topic ───────────────────────────────────────────────────

export type BoardChannelState = 'following' | 'pending' | 'paused' | 'measured';

interface ChannelRec {
  channelId: string;
  title: string | null;
  subs: number | null;
  niche: string | null;
  channelPublishedAt: string | null;
  state: BoardChannelState;
  verdict: string | null;
}

interface VideoRec extends BoardVideoInput {
  channelId: string;
  title: string;
  thumbnailUrl: string | null;
  viewsGained24h: number | null;
  baselineEligible: boolean;
  foundByKeyword: string | null;
  firstSeenAt: string;
}

interface TopicData {
  settings: BoardSettings;
  channels: Map<string, ChannelRec>;
  videos: VideoRec[];
  keywordGroup: Map<string, string | null>;
  /** Uploads (baseline_eligible) theo kênh — đầu vào baseline. */
  uploadsByChannel: Map<string, VideoRec[]>;
}

function num(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}
function str(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

export function boardSettingsFor(db: Database, topicId: string): BoardSettings {
  const t = dashTopicSettings(db, topicId);
  return {
    ...DEFAULT_BOARD_SETTINGS,
    outlierMultiple: t.outlierMultiple,
    minDurationSec: t.minDurationSec,
    baselineWindow: t.baselineWindow,
    reliableMinN: t.baselineMinN,
    deadMedian: t.deadMedian,
  };
}

function loadTopic(db: Database, topicId: string): TopicData {
  const settings = boardSettingsFor(db, topicId);

  const keywordGroup = new Map<string, string | null>();
  for (const r of db.prepare('SELECT term_key, group_key FROM topic_keywords WHERE topic_id=?').all(topicId) as Row[]) {
    keywordGroup.set(String(r['term_key']), str(r['group_key']));
  }

  const channels = new Map<string, ChannelRec>();
  const stateOf: Record<string, BoardChannelState> = { active: 'following', new: 'pending', paused: 'paused' };
  // 'own' (kênh của mình) và 'rejected' không phải mẫu của ngách.
  for (const r of db.prepare(
    `SELECT channel_id, title, subscriber_count, group_key, channel_published_at, status
     FROM topic_channels WHERE topic_id=? AND status IN ('active','new','paused')`,
  ).all(topicId) as Row[]) {
    channels.set(String(r['channel_id']), {
      channelId: String(r['channel_id']),
      title: str(r['title']),
      subs: num(r['subscriber_count']),
      niche: str(r['group_key']),
      channelPublishedAt: str(r['channel_published_at']),
      state: stateOf[String(r['status'])] ?? 'measured',
      verdict: null,
    });
  }
  const excluded = new Set(
    (db.prepare(
      "SELECT channel_id FROM topic_channels WHERE topic_id=? AND status IN ('own','rejected')",
    ).all(topicId) as Row[]).map((r) => String(r['channel_id'])),
  );
  for (const r of db.prepare(
    `SELECT channel_id, title, subscriber_count, group_key, channel_published_at, verdict
     FROM measured_channels WHERE topic_id=?`,
  ).all(topicId) as Row[]) {
    const id = String(r['channel_id']);
    if (excluded.has(id)) continue;
    const known = channels.get(id);
    if (known) {
      known.verdict = str(r['verdict']);
      known.niche ??= str(r['group_key']);
      known.channelPublishedAt ??= str(r['channel_published_at']);
      known.subs ??= num(r['subscriber_count']);
      continue;
    }
    channels.set(id, {
      channelId: id,
      title: str(r['title']),
      subs: num(r['subscriber_count']),
      niche: str(r['group_key']),
      channelPublishedAt: str(r['channel_published_at']),
      state: 'measured',
      verdict: str(r['verdict']),
    });
  }

  const videos: VideoRec[] = [];
  for (const r of db.prepare(
    `SELECT video_id, channel_id, title, thumbnail_url, published_at, duration_sec,
            latest_views, views_gained_24h, baseline_eligible, found_by_keyword, first_seen_at
     FROM topic_videos WHERE topic_id=?`,
  ).all(topicId) as Row[]) {
    const channelId = String(r['channel_id']);
    if (excluded.has(channelId)) continue;
    videos.push({
      videoId: String(r['video_id']),
      channelId,
      title: String(r['title']),
      thumbnailUrl: str(r['thumbnail_url']),
      publishedAt: str(r['published_at']),
      durationSec: num(r['duration_sec']),
      views: num(r['latest_views']),
      viewsGained24h: num(r['views_gained_24h']),
      baselineEligible: Number(r['baseline_eligible'] ?? 0) === 1,
      foundByKeyword: str(r['found_by_keyword']),
      firstSeenAt: String(r['first_seen_at']),
    });
  }
  const uploadsByChannel = new Map<string, VideoRec[]>();
  for (const v of videos) {
    if (!v.baselineEligible) continue;
    const list = uploadsByChannel.get(v.channelId) ?? [];
    list.push(v);
    uploadsByChannel.set(v.channelId, list);
  }
  return { settings, channels, videos, keywordGroup, uploadsByChannel };
}

function videoNiche(data: TopicData, v: VideoRec): string | null {
  const ch = data.channels.get(v.channelId);
  if (ch) return ch.niche;
  return v.foundByKeyword ? data.keywordGroup.get(v.foundByKeyword) ?? null : null;
}

function smallChannelIds(data: TopicData): Set<string> {
  const out = new Set<string>();
  for (const ch of data.channels.values()) if (isSmallChannel(ch.subs, data.settings)) out.add(ch.channelId);
  return out;
}

/** Tất cả ngách đang có: từ keyword lẫn kênh. null = "chưa gán". */
function listNiches(data: TopicData): Array<string | null> {
  const set = new Set<string | null>();
  for (const g of data.keywordGroup.values()) set.add(g);
  for (const ch of data.channels.values()) set.add(ch.niche);
  return [...set].sort((a, b) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)));
}

function sameNiche(a: string | null, b: string | null): boolean {
  return (a ?? null) === (b ?? null);
}

interface ScoredVideo {
  video: VideoRec;
  niche: string | null;
  score: VideoScore;
}

/** Sàn + chấm điểm mọi video của một ngách tại thời điểm nowMs. */
function scoreNiche(
  data: TopicData,
  niche: string | null,
  nowMs: number,
  small: Set<string>,
  viewsAt?: (v: VideoRec) => number | null,
  floorOnly = false,
): { floor: NicheFloor; scored: ScoredVideo[] } {
  const withViews = (v: VideoRec): VideoRec => (viewsAt ? { ...v, views: viewsAt(v) } : v);
  const inNiche = data.videos
    .filter((v) => sameNiche(videoNiche(data, v), niche))
    .filter((v) => !viewsAt || (v.publishedAt !== null && Date.parse(v.publishedAt) <= nowMs))
    .map(withViews);
  const floor = nicheFloor(inNiche, small, data.settings, nowMs);
  if (floorOnly) return { floor, scored: [] };
  const nicheRef = { floorViews: floor.floorViews, nVideos: floor.nVideos };
  const uploads = (channelId: string) => (data.uploadsByChannel.get(channelId) ?? [])
    .filter((v) => !viewsAt || (v.publishedAt !== null && Date.parse(v.publishedAt) <= nowMs))
    .map(withViews);
  const scored = inNiche.map((video) => ({
    video,
    niche,
    score: scoreVideo(video, uploads(video.channelId), nicheRef, data.settings, nowMs),
  }));
  return { floor, scored };
}

// ── Độ tươi + khung ─────────────────────────────────────────────────────────

function freshness(db: Database, topicId: string): { freshness: BoardFreshness; runIds: string[]; dataAsOf: string | null } {
  const track = db.prepare(
    "SELECT tick_id, finished_at FROM loop_ticks WHERE topic_id=? AND mode='daily' AND status='done' ORDER BY finished_at DESC LIMIT 1",
  ).get(topicId) as Row | null;
  const weekly = db.prepare(
    "SELECT tick_id AS id, finished_at FROM loop_ticks WHERE topic_id=? AND mode='weekly' AND status='done' ORDER BY finished_at DESC LIMIT 1",
  ).get(topicId) as Row | null;
  const run = db.prepare(
    "SELECT run_id AS id, finished_at FROM keyword_runs WHERE topic_id=? AND type='discover' AND status IN ('done','skipped_quota') ORDER BY finished_at DESC LIMIT 1",
  ).get(topicId) as Row | null;
  const discover = [weekly, run]
    .filter((r): r is Row => Boolean(r))
    .sort((a, b) => String(b['finished_at']).localeCompare(String(a['finished_at'])))[0] ?? null;
  const asOf = db.prepare(
    `SELECT MAX(t) AS t FROM (
       SELECT MAX(latest_at) AS t FROM topic_videos WHERE topic_id=?
       UNION ALL SELECT MAX(measured_at) FROM measured_channels WHERE topic_id=?)`,
  ).get(topicId, topicId) as Row | null;
  const runIds = [track ? String(track['tick_id']) : null, discover ? String(discover['id']) : null]
    .filter((x): x is string => x !== null);
  return {
    freshness: {
      lastTrackAt: track ? str(track['finished_at']) : null,
      lastDiscoverAt: discover ? str(discover['finished_at']) : null,
    },
    runIds,
    dataAsOf: asOf ? str(asOf['t']) : null,
  };
}

function envelope<T>(
  db: Database,
  topicId: string,
  data: T,
  sample: { channels: number; videos: number },
  page: { limit: number | null; truncated: boolean } = { limit: null, truncated: false },
): BoardEnvelope<T> {
  const f = freshness(db, topicId);
  return { data, dataAsOf: f.dataAsOf, runIds: f.runIds, freshness: f.freshness, sample, ...page };
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return BOARD_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit phải là số nguyên > 0');
  return Math.min(limit, BOARD_MAX_LIMIT);
}

// ── 1. metrics ──────────────────────────────────────────────────────────────

export function boardMetrics(db: Database, topicId: string): Array<{ name: string; definition: string }> {
  return metricDefinitions(boardSettingsFor(db, topicId));
}

// ── 2. scorecard ────────────────────────────────────────────────────────────

export interface ScorecardRow {
  niche: string | null;
  floorSmall: number | null;
  floorSmall7dAgo: number | null;
  nSmallChannels: number;
  nSmallVideos: number;
  repeat: RepeatCount;
  outliers28d: number;
  stop: { ready: boolean; smallMeasured: number; need: number; rankStableDays: number };
  history: Array<{ day: string; floorSmall: number | null }>;
}

/** views của một video tại cuối ngày `day` (snapshot gần nhất ≤ day). */
function loadViewHistory(db: Database, topicId: string): Map<string, Array<{ day: string; views: number }>> {
  const map = new Map<string, Array<{ day: string; views: number }>>();
  for (const r of db.prepare(
    'SELECT video_id, day, views FROM video_daily_views WHERE topic_id=? ORDER BY day ASC',
  ).all(topicId) as Row[]) {
    const id = String(r['video_id']);
    const list = map.get(id) ?? [];
    list.push({ day: String(r['day']), views: Number(r['views']) });
    map.set(id, list);
  }
  return map;
}

function viewsAtDay(hist: Map<string, Array<{ day: string; views: number }>>, day: string) {
  return (v: VideoRec): number | null => {
    const list = hist.get(v.videoId);
    if (!list) return null;
    let found: number | null = null;
    for (const p of list) {
      if (p.day > day) break;
      found = p.views;
    }
    return found;
  };
}

export function boardScorecard(
  db: Database,
  topicId: string,
  opts: { historyDays?: number; nowMs?: number } = {},
): BoardEnvelope<ScorecardRow[]> {
  const nowMs = opts.nowMs ?? Date.now();
  const historyDays = Math.max(7, Math.min(opts.historyDays ?? 28, 90));
  const data = loadTopic(db, topicId);
  const small = smallChannelIds(data);
  const niches = listNiches(data);
  const hist = loadViewHistory(db, topicId);

  // Chuỗi sàn view theo ngày (views tại cuối mỗi ngày) — cho biểu đồ, delta 7
  // ngày và luật dừng "thứ hạng không đổi 2 tuần".
  const days: string[] = [];
  for (let i = historyDays - 1; i >= 0; i--) {
    days.push(new Date(nowMs - i * DAY_MS).toISOString().slice(0, 10));
  }
  const floorByDay = new Map<string | null, Array<{ day: string; floorSmall: number | null }>>();
  for (const niche of niches) floorByDay.set(niche, []);
  for (const day of days) {
    const endOfDay = Date.parse(`${day}T23:59:59.999Z`);
    const at = viewsAtDay(hist, day);
    for (const niche of niches) {
      const { floor } = scoreNiche(data, niche, endOfDay, small, at, true);
      floorByDay.get(niche)!.push({ day, floorSmall: floor.floorViews });
    }
  }
  // Số ngày gần nhất liên tiếp mà thứ hạng ngách (theo sàn) giữ nguyên.
  const rankKey = (i: number) => niches
    .map((n) => ({ n, f: floorByDay.get(n)![i]!.floorSmall }))
    .filter((x) => x.f !== null)
    .sort((a, b) => (b.f as number) - (a.f as number))
    .map((x) => String(x.n))
    .join('|');
  let rankStableDays = 0;
  const lastKey = rankKey(days.length - 1);
  for (let i = days.length - 1; i >= 0 && lastKey !== '' && rankKey(i) === lastKey; i--) rankStableDays++;

  let totalVideos = 0;
  const rows: ScorecardRow[] = niches.map((niche) => {
    const { floor, scored } = scoreNiche(data, niche, nowMs, small);
    totalVideos += scored.length;
    const repeat = repeatSmall(
      scored.map((s) => ({ channelId: s.video.channelId, publishedAt: s.video.publishedAt, score: s.score })),
      small, data.settings, nowMs,
    );
    const outliers28d = scored.filter((s) => {
      const age = ageDays(s.video.publishedAt, nowMs);
      return s.score.isOutlier && age !== null && age <= data.settings.repeatWindowDays;
    }).length;
    const series = floorByDay.get(niche)!;
    const weekAgo = series[series.length - 8]?.floorSmall ?? null;
    const smallMeasured = floor.nChannels;
    return {
      niche,
      floorSmall: floor.floorViews,
      floorSmall7dAgo: weekAgo,
      nSmallChannels: floor.nChannels,
      nSmallVideos: floor.nVideos,
      repeat,
      outliers28d,
      stop: {
        ready: smallMeasured >= data.settings.stopMinSmallChannels && rankStableDays >= 14,
        smallMeasured,
        need: data.settings.stopMinSmallChannels,
        rankStableDays,
      },
      history: series,
    };
  });
  return envelope(db, topicId, rows, { channels: small.size, videos: totalVideos });
}

// ── 3. videos ───────────────────────────────────────────────────────────────

export type BoardVideoView = 'outliers' | 'rising' | 'all';
export type BoardVideoSort = 'outlier_x' | 'velocity_24h' | 'views' | 'published_at';

export interface BoardVideosParams {
  niche?: string | null;
  view?: BoardVideoView;
  smallOnly?: boolean;
  channelAgeMaxDays?: number;
  sort?: BoardVideoSort;
  limit?: number;
  nowMs?: number;
}

export interface BoardVideoRow {
  videoId: string;
  title: string;
  thumbnailUrl: string | null;
  channelId: string;
  channelTitle: string | null;
  subs: number | null;
  channelAgeDays: number | null;
  niche: string | null;
  views: number | null;
  velocity24h: number | null;
  publishedAt: string | null;
  videoAgeDays: number | null;
  outlierX: number | null;
  tier: BaselineTier | null;
  baselineViews: number | null;
  baselineN: number;
  isOutlier: boolean;
  isRising: boolean;
  foundByKeyword: string | null;
}

export function boardVideos(db: Database, topicId: string, params: BoardVideosParams = {}): BoardEnvelope<BoardVideoRow[]> {
  const nowMs = params.nowMs ?? Date.now();
  const limit = clampLimit(params.limit);
  const view = params.view ?? 'outliers';
  const data = loadTopic(db, topicId);
  const small = smallChannelIds(data);
  const niches = params.niche !== undefined ? [params.niche] : listNiches(data);

  let rows: BoardVideoRow[] = [];
  for (const niche of niches) {
    const { scored } = scoreNiche(data, niche, nowMs, small);
    for (const { video, score } of scored) {
      if (!isLongVideo(video, data.settings)) continue;
      if (view === 'outliers' && !score.isOutlier) continue;
      if (view === 'rising' && !score.isRising) continue;
      const ch = data.channels.get(video.channelId);
      if (params.smallOnly && !small.has(video.channelId)) continue;
      const chAge = ageDays(ch?.channelPublishedAt ?? null, nowMs);
      if (params.channelAgeMaxDays !== undefined && (chAge === null || chAge > params.channelAgeMaxDays)) continue;
      rows.push({
        videoId: video.videoId,
        title: video.title,
        thumbnailUrl: video.thumbnailUrl,
        channelId: video.channelId,
        channelTitle: ch?.title ?? null,
        subs: ch?.subs ?? null,
        channelAgeDays: chAge === null ? null : Math.floor(chAge),
        niche,
        views: video.views,
        velocity24h: video.viewsGained24h,
        publishedAt: video.publishedAt,
        videoAgeDays: score.ageDays === null ? null : Math.floor(score.ageDays),
        outlierX: score.outlierX,
        tier: score.tier,
        baselineViews: score.baselineViews,
        baselineN: score.baselineN,
        isOutlier: score.isOutlier,
        isRising: score.isRising,
        foundByKeyword: video.foundByKeyword,
      });
    }
  }
  const sort = params.sort ?? (view === 'rising' ? 'velocity_24h' : 'outlier_x');
  const key = (r: BoardVideoRow): number => {
    if (sort === 'velocity_24h') return r.velocity24h ?? -1;
    if (sort === 'views') return r.views ?? -1;
    if (sort === 'published_at') return r.publishedAt ? Date.parse(r.publishedAt) : -1;
    return r.outlierX ?? -1;
  };
  rows.sort((a, b) => key(b) - key(a));
  const total = rows.length;
  rows = rows.slice(0, limit);
  return envelope(db, topicId, rows, {
    channels: new Set(rows.map((r) => r.channelId)).size, videos: total,
  }, { limit, truncated: total > limit });
}

// ── 4. channels ─────────────────────────────────────────────────────────────

export type BoardChannelSort = 'outliers_28d' | 'subs' | 'baseline' | 'channel_age';

export interface BoardChannelsParams {
  niche?: string | null;
  smallOnly?: boolean;
  hasOutlier?: boolean;
  sort?: BoardChannelSort;
  limit?: number;
  nowMs?: number;
}

export interface BoardChannelRow {
  channelId: string;
  title: string | null;
  subs: number | null;
  isSmall: boolean;
  channelAgeDays: number | null;
  niche: string | null;
  state: BoardChannelState;
  verdict: string | null;
  baselineViews: number | null;
  baselineN: number;
  tier: Exclude<BaselineTier, 'niche'> | null;
  dead: boolean;
  outliers28d: number;
  bestOutlierX: number | null;
}

export function boardChannels(db: Database, topicId: string, params: BoardChannelsParams = {}): BoardEnvelope<BoardChannelRow[]> {
  const nowMs = params.nowMs ?? Date.now();
  const limit = clampLimit(params.limit);
  const data = loadTopic(db, topicId);
  const small = smallChannelIds(data);
  const niches = params.niche !== undefined ? [params.niche] : listNiches(data);

  let rows: BoardChannelRow[] = [];
  let totalVideos = 0;
  for (const niche of niches) {
    const { scored } = scoreNiche(data, niche, nowMs, small);
    const byChannel = new Map<string, ScoredVideo[]>();
    for (const s of scored) {
      const list = byChannel.get(s.video.channelId) ?? [];
      list.push(s);
      byChannel.set(s.video.channelId, list);
    }
    for (const ch of data.channels.values()) {
      if (!sameNiche(ch.niche, niche)) continue;
      const isSmall = small.has(ch.channelId);
      if (params.smallOnly && !isSmall) continue;
      const mine = byChannel.get(ch.channelId) ?? [];
      totalVideos += mine.length;
      const recent = mine.filter((s) => {
        const age = ageDays(s.video.publishedAt, nowMs);
        return s.score.isOutlier && age !== null && age <= data.settings.repeatWindowDays;
      });
      if (params.hasOutlier && recent.length === 0) continue;
      const base = channelBaselineFor(null, data.uploadsByChannel.get(ch.channelId) ?? [], data.settings);
      const chAge = ageDays(ch.channelPublishedAt, nowMs);
      const xs = mine.map((s) => s.score.outlierX).filter((x): x is number => x !== null);
      rows.push({
        channelId: ch.channelId,
        title: ch.title,
        subs: ch.subs,
        isSmall,
        channelAgeDays: chAge === null ? null : Math.floor(chAge),
        niche,
        state: ch.state,
        verdict: ch.verdict,
        baselineViews: base.medianViews,
        baselineN: base.n,
        tier: base.tier,
        dead: base.dead,
        outliers28d: recent.length,
        bestOutlierX: xs.length ? Math.max(...xs) : null,
      });
    }
  }
  const sort = params.sort ?? 'outliers_28d';
  const key = (r: BoardChannelRow): number => {
    if (sort === 'subs') return r.subs ?? -1;
    if (sort === 'baseline') return r.baselineViews ?? -1;
    if (sort === 'channel_age') return -(r.channelAgeDays ?? Number.MAX_SAFE_INTEGER);
    return r.outliers28d * 1e6 + (r.bestOutlierX ?? 0);
  };
  rows.sort((a, b) => key(b) - key(a));
  const total = rows.length;
  rows = rows.slice(0, limit);
  return envelope(db, topicId, rows, { channels: total, videos: totalVideos }, { limit, truncated: total > limit });
}

// ── 5. keywords ─────────────────────────────────────────────────────────────

export interface BoardKeywordRow {
  termKey: string;
  term: string;
  niche: string | null;
  status: string;
  lastCheckedAt: string | null;
  /** Còn khoá (không search lại) tới lúc này; null = chạy được ngay. */
  lockedUntil: string | null;
  lastNResults: number | null;
  lastNNew: number | null;
  newRate: number | null;
  nChecks: number;
  outliersFound: number;
}

export function boardKeywords(
  db: Database,
  topicId: string,
  params: { niche?: string | null; nowMs?: number } = {},
): BoardEnvelope<BoardKeywordRow[]> {
  const nowMs = params.nowMs ?? Date.now();
  const data = loadTopic(db, topicId);
  const small = smallChannelIds(data);
  const outliersByKeyword = new Map<string, number>();
  for (const niche of listNiches(data)) {
    for (const { video, score } of scoreNiche(data, niche, nowMs, small).scored) {
      if (score.isOutlier && video.foundByKeyword) {
        outliersByKeyword.set(video.foundByKeyword, (outliersByKeyword.get(video.foundByKeyword) ?? 0) + 1);
      }
    }
  }
  const lastCheck = new Map<string, Row>();
  const nChecks = new Map<string, number>();
  for (const r of db.prepare(
    'SELECT term_key, checked_at, n_results, n_new FROM keyword_checks WHERE topic_id=? ORDER BY checked_at DESC',
  ).all(topicId) as Row[]) {
    const k = String(r['term_key']);
    if (!lastCheck.has(k)) lastCheck.set(k, r);
    nChecks.set(k, (nChecks.get(k) ?? 0) + 1);
  }
  const rows: BoardKeywordRow[] = [];
  for (const r of db.prepare(
    `SELECT term_key, display_term, group_key, status, last_checked_at, last_n_results
     FROM topic_keywords WHERE topic_id=? AND status != 'rejected' ORDER BY display_term`,
  ).all(topicId) as Row[]) {
    const niche = str(r['group_key']);
    if (params.niche !== undefined && !sameNiche(niche, params.niche)) continue;
    const termKey = String(r['term_key']);
    const last = str(r['last_checked_at']);
    const lockEnd = last ? Date.parse(last) + KEYWORD_RESEARCH_DAYS * DAY_MS : null;
    const check = lastCheck.get(termKey);
    const nNew = check ? num(check['n_new']) : null;
    const nRes = check ? num(check['n_results']) : num(r['last_n_results']);
    rows.push({
      termKey,
      term: String(r['display_term']),
      niche,
      status: String(r['status']),
      lastCheckedAt: last,
      lockedUntil: lockEnd !== null && lockEnd > nowMs ? new Date(lockEnd).toISOString() : null,
      lastNResults: nRes,
      lastNNew: nNew,
      newRate: nNew !== null && nRes ? Math.round((nNew / nRes) * 100) / 100 : null,
      nChecks: nChecks.get(termKey) ?? 0,
      outliersFound: outliersByKeyword.get(termKey) ?? 0,
    });
  }
  return envelope(db, topicId, rows, { channels: data.channels.size, videos: data.videos.length });
}

// ── 6. runs (Theo dõi + Tìm mới + Đào sâu) ─────────────────────────────────

export type BoardRunType = 'track' | 'discover' | 'deepdive' | 'weekly' | 'setup';

export interface BoardRunCard {
  runId: string;
  source: 'keyword_run' | 'loop_tick';
  type: BoardRunType;
  niche: string | null;
  note: string | null;
  triggeredBy: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  nItems: number | null;
  itemsDone: number | null;
  searchCalls: number;
  units: number;
  nNew: number | null;
  nSkipped: number | null;
  newChannels: number;
  error: string | null;
}

const TICK_TYPE: Record<string, BoardRunType> = { daily: 'track', weekly: 'weekly', setup: 'setup' };
const TICK_NOTE: Record<string, string> = {
  daily: 'Theo dõi hằng ngày (tự động)',
  weekly: 'Tìm mới hằng tuần — keyword active xoay vòng (tự động)',
  setup: 'Khởi tạo topic',
};

function cardFromKeywordRun(r: Row): BoardRunCard {
  return {
    runId: String(r['run_id']),
    source: 'keyword_run',
    type: (String(r['type'] ?? 'discover') as BoardRunType),
    niche: str(r['group_key']),
    note: str(r['note']),
    triggeredBy: String(r['triggered_by'] ?? 'human'),
    status: String(r['status']),
    startedAt: String(r['started_at']),
    finishedAt: str(r['finished_at']),
    nItems: num(r['n_keywords']),
    itemsDone: num(r['keywords_done']),
    searchCalls: Number(r['search_calls_used'] ?? 0),
    units: Number(r['general_units_used'] ?? 0),
    nNew: num(r['n_new']),
    nSkipped: num(r['n_skipped']),
    newChannels: Number(r['new_candidates'] ?? 0),
    error: str(r['error']),
  };
}

function cardFromTick(r: Row): BoardRunCard {
  const mode = String(r['mode']);
  let nItems: number | null = null;
  try { nItems = (JSON.parse(String(r['keywords_searched_json'] ?? '[]')) as unknown[]).length; } catch { /* giữ null */ }
  return {
    runId: String(r['tick_id']),
    source: 'loop_tick',
    type: TICK_TYPE[mode] ?? 'track',
    niche: null,
    note: TICK_NOTE[mode] ?? null,
    triggeredBy: 'loop',
    status: String(r['status']),
    startedAt: String(r['started_at']),
    finishedAt: str(r['finished_at']),
    nItems: mode === 'daily' ? null : nItems,
    itemsDone: null,
    searchCalls: Number(r['search_calls_used'] ?? 0),
    units: Number(r['general_units_used'] ?? 0),
    nNew: null,
    nSkipped: null,
    newChannels: Number(r['new_candidates'] ?? 0),
    error: str(r['error']),
  };
}

export function boardRuns(
  db: Database,
  topicId: string,
  params: { niche?: string | null; type?: BoardRunType; limit?: number } = {},
): BoardEnvelope<BoardRunCard[]> {
  const limit = clampLimit(params.limit);
  const cards = [
    ...(db.prepare('SELECT * FROM keyword_runs WHERE topic_id=?').all(topicId) as Row[]).map(cardFromKeywordRun),
    ...(db.prepare('SELECT * FROM loop_ticks WHERE topic_id=?').all(topicId) as Row[]).map(cardFromTick),
  ]
    .filter((c) => params.type === undefined || c.type === params.type)
    .filter((c) => params.niche === undefined || sameNiche(c.niche, params.niche))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const total = cards.length;
  const rows = cards.slice(0, limit);
  return envelope(db, topicId, rows, { channels: 0, videos: 0 }, { limit, truncated: total > limit });
}

export interface BoardRunDetail {
  card: BoardRunCard;
  items: Array<{
    target: string;
    status: string;
    nResults: number | null;
    nNew: number | null;
    medianViews: number | null;
    outliersFound: number | null;
    skipReason: string | null;
    error: string | null;
  }>;
}

/** null = không có run này. topicId lấy từ chính run. */
export function boardRunDetail(db: Database, runId: string): BoardEnvelope<BoardRunDetail> | null {
  const kr = db.prepare('SELECT * FROM keyword_runs WHERE run_id=?').get(runId) as Row | null;
  if (kr) {
    const items = (db.prepare('SELECT * FROM keyword_run_items WHERE run_id=? ORDER BY rowid').all(runId) as Row[])
      .map((i) => ({
        target: String(i['term_key']),
        status: String(i['status']),
        nResults: num(i['n_results']),
        nNew: num(i['n_new']),
        medianViews: num(i['median_views']),
        outliersFound: num(i['outliers_found']),
        skipReason: str(i['skip_reason']),
        error: str(i['error']),
      }));
    return envelope(db, String(kr['topic_id']), { card: cardFromKeywordRun(kr), items }, { channels: 0, videos: 0 });
  }
  const tick = db.prepare('SELECT * FROM loop_ticks WHERE tick_id=?').get(runId) as Row | null;
  if (!tick) return null;
  let searched: string[] = [];
  try { searched = JSON.parse(String(tick['keywords_searched_json'] ?? '[]')) as string[]; } catch { /* rỗng */ }
  const items = searched.map((target) => ({
    target, status: 'done', nResults: null, nNew: null, medianViews: null,
    outliersFound: null, skipReason: null, error: null,
  }));
  return envelope(db, String(tick['topic_id']), { card: cardFromTick(tick), items }, { channels: 0, videos: 0 });
}
