// packages/spy/src/dash/registry.ts — truy vấn read-only cho các endpoint
// "sổ đăng ký" của Spy Dashboard API (docs/plans/spy-dashboard-api.html):
// meta(#1) · topics(#2) · channels(#4) · channel detail(#5) · keywords(#7)
// inbox(#13) · decisions(#14) · ticks(#15) · reports+quota(#16).
// Phần chuỗi/activity (overview #3, videos #8-#12) thuộc dash/activity.ts của
// Devin B. Mọi hàm nhận Database và CHỈ SELECT — không INSERT/UPDATE.

import type { Database } from 'bun:sqlite';
import { quotaDay } from '../quota.ts';
import {
  DEFAULT_TOPIC_SETTINGS,
  type KeywordOrigin,
  type LoopMode,
  type TopicChannelStatusV3,
  type TopicKeywordStatusV3,
  type TopicSettings,
} from '../store.ts';
import type {
  DashChannelDetail,
  DashChannelRow,
  DashChannelsParams,
  DashDecisionRow,
  DashDecisionSummary,
  DashDecisionsParams,
  DashInbox,
  DashKeywordRow,
  DashKeywordsParams,
  DashMetaData,
  DashQuotaParams,
  DashQuotaRow,
  DashReportRow,
  DashReportsParams,
  DashTickRow,
  DashTicksParams,
  DashTopicRow,
  DashVideoRow,
} from './types.ts';

type Row = Record<string, unknown>;

const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const strOrNull = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? v : null;
const intOrNull = (v: unknown): number | null => {
  const n = numOrNull(v);
  return n === null ? null : Math.trunc(n);
};

/** Ngưỡng của topic = mặc định §3 + settings_json (snake hoặc camel).
 *  Giống SpyStore.getTopicSettings nhưng đi qua Database thô vì hợp đồng
 *  dash/* chỉ nhận db. */
export function dashTopicSettings(db: Database, topicId: string): TopicSettings {
  const settings: TopicSettings = { ...DEFAULT_TOPIC_SETTINGS };
  const row = db
    .prepare('SELECT settings_json FROM topics WHERE topic_id = ?')
    .get(topicId) as Row | undefined;
  const raw = row?.['settings_json'];
  if (typeof raw !== 'string' || raw.trim() === '') return settings;
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return settings;
    parsed = value as Record<string, unknown>;
  } catch {
    return settings;
  }
  const writable = settings as unknown as Record<string, unknown>;
  const pickNum = (snake: string, camel: keyof TopicSettings): void => {
    const v = parsed[snake] ?? parsed[camel as string];
    if (typeof v === 'number' && Number.isFinite(v)) writable[camel] = v;
  };
  const pickStr = (snake: string, camel: keyof TopicSettings): void => {
    const v = parsed[snake] ?? parsed[camel as string];
    if (typeof v === 'string' && v.trim() !== '') writable[camel] = v;
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

const MS_PER_DAY = 86_400_000;
/** quota_day - N ngày, tính ở JS vì "hôm nay" của pipeline là Pacific,
 *  không phải UTC (date('now') của SQLite) — review M1. */
const shiftQuotaDay = (day: string, delta: number): string => {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
};
const dayDiff = (fromIso: string | null, toIso: string): number | null => {
  if (!fromIso) return null;
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.floor((b - a) / MS_PER_DAY);
};

// ---------------------------------------------------------------------------
// #1 GET /dash/meta
// ---------------------------------------------------------------------------

export function dashMeta(_db: Database): DashMetaData {
  return {
    metrics: [
      {
        key: 'outlier_score',
        label: 'Bội số outlier',
        formula: 'latest_views / baseline_median_views',
        null_when: 'baseline_n < baseline_min_n',
      },
      {
        key: 'views_gained_24h',
        label: 'View tăng 24h',
        formula: 'views_today - views_snapshot_trước',
        null_when: 'video mới có 1 snapshot',
      },
      {
        key: 'max_over_median',
        label: 'Video đỉnh / median kênh',
        formula: 'max_views / baseline_median_views',
        null_when: 'baseline_n < baseline_min_n',
      },
      {
        key: 'pct_followed',
        label: 'Tỉ lệ keyword sinh kênh follow',
        formula: 'last_n_followed / last_n_results',
        null_when: 'keyword chưa được quét',
      },
      {
        key: 'heat',
        label: 'Nhiệt video trong ngày',
        formula: 'gained_per_day / (baseline_median_views / 30)',
        null_when: 'baseline chưa tin cậy hoặc chưa đủ 2 snapshot',
      },
      {
        key: 'is_dead',
        label: 'Kênh chết/nhỏ',
        formula: 'baseline_median_views < dead_median',
        null_when: 'baseline_n < baseline_min_n',
      },
      {
        key: 'is_lottery',
        label: 'Kênh xổ số',
        formula: 'max_over_median > lottery_ratio',
        null_when: 'baseline_n < baseline_min_n',
      },
    ],
    default_settings: { ...DEFAULT_TOPIC_SETTINGS },
    enums: {
      channel_status: ['new', 'active', 'paused', 'rejected', 'own'],
      keyword_status: ['pending', 'active', 'paused', 'rejected'],
      keyword_origin: ['seed', 'title_ngram', 'outlier_title', 'user'],
      // Giá trị loop thực ghi (plan v3 §4.3). Filter discovered_via ở route
      // là tham số tự do — không chặn giá trị lạ để kênh legacy vẫn lọc được.
      discovered_via: ['seed', 'keyword_search', 'weekly_outlier', 'user'],
      tick_mode: ['setup', 'daily', 'weekly'],
      decision_actor: ['human', 'loop'],
      video_source: ['setup', 'daily_scan', 'weekly_search'],
      tick_status: ['running', 'done', 'failed', 'skipped_quota'],
    },
  };
}

// ---------------------------------------------------------------------------
// #2 GET /dash/topics
// ---------------------------------------------------------------------------

export function dashTopics(db: Database): DashTopicRow[] {
  const rows = db.prepare(`
SELECT t.topic_id, t.label, t.market, t.language, t.region, t.status, t.setup_status,
  (SELECT COUNT(*) FROM topic_channels c
    WHERE c.topic_id = t.topic_id AND c.status = 'active') AS channels_active,
  (SELECT COUNT(*) FROM topic_keywords k
    WHERE k.topic_id = t.topic_id AND k.status = 'active') AS keywords_active,
  (SELECT COUNT(*) FROM topic_videos v
    WHERE v.topic_id = t.topic_id) AS videos_tracked,
  (SELECT COUNT(*) FROM topic_channels c
    WHERE c.topic_id = t.topic_id AND c.status = 'new')
  + (SELECT COUNT(*) FROM topic_keywords k
    WHERE k.topic_id = t.topic_id AND k.status = 'pending')
  + (SELECT COUNT(*) FROM topic_channels c
    WHERE c.topic_id = t.topic_id AND c.suggestion IS NOT NULL AND c.suggestion != '')
    AS inbox_pending,
  (SELECT lt.started_at FROM loop_ticks lt
    WHERE lt.topic_id = t.topic_id AND lt.mode = 'daily'
    ORDER BY lt.started_at DESC LIMIT 1) AS last_daily_at,
  (SELECT lt.status FROM loop_ticks lt
    WHERE lt.topic_id = t.topic_id AND lt.mode = 'daily'
    ORDER BY lt.started_at DESC LIMIT 1) AS last_daily_status,
  (SELECT lt.started_at FROM loop_ticks lt
    WHERE lt.topic_id = t.topic_id AND lt.mode = 'weekly'
    ORDER BY lt.started_at DESC LIMIT 1) AS last_weekly_at,
  (SELECT lt.status FROM loop_ticks lt
    WHERE lt.topic_id = t.topic_id AND lt.mode = 'weekly'
    ORDER BY lt.started_at DESC LIMIT 1) AS last_weekly_status
FROM topics t
ORDER BY t.created_at ASC
  `).all() as Row[];
  return rows.map((r) => ({
    topic_id: String(r['topic_id']),
    label: String(r['label']),
    market: String(r['market']),
    language: String(r['language']),
    region: strOrNull(r['region']),
    status: String(r['status']),
    setup_status: String(r['setup_status']) as DashTopicRow['setup_status'],
    channels_active: Number(r['channels_active']),
    keywords_active: Number(r['keywords_active']),
    videos_tracked: Number(r['videos_tracked']),
    inbox_pending: Number(r['inbox_pending']),
    last_daily_at: strOrNull(r['last_daily_at']),
    last_daily_status: strOrNull(r['last_daily_status']),
    last_weekly_at: strOrNull(r['last_weekly_at']),
    last_weekly_status: strOrNull(r['last_weekly_status']),
  }));
}

// ---------------------------------------------------------------------------
// #4 GET /dash/channels — follow list + inbox
// ---------------------------------------------------------------------------

interface ChannelAgg {
  videosTracked: number;
  uploads28d: number;
  outliers28d: number;
  viewsGained7d: number | null;
}

/** Tổng hợp theo kênh từ topic_videos + video_daily_views — một truy vấn
 *  group thay vì N+1. views_gained_7d = Σ hiệu snapshot liên tiếp trong 7
 *  quota-day gần nhất (LAG so với snapshot ngay trước, kể cả trước cửa sổ).
 *  `todayQuota` = quota_day Pacific của "hôm nay"; cửa sổ 7d/28d tính JS-side
 *  vì date('now') của SQLite là UTC — khác khoá ngày của pipeline.
 *  `channelId` (tuỳ chọn) giới hạn aggregate cho 1 kênh — dùng bởi #5 để
 *  không phải aggregate cả topic (review L2). */
function channelAggregates(
  db: Database,
  topicId: string,
  outlierMultiple: number,
  todayQuota: string,
  channelId?: string,
): Map<string, ChannelAgg> {
  const from7 = shiftQuotaDay(todayQuota, -6);  // 7 ngày inclusive
  const from28 = shiftQuotaDay(todayQuota, -27); // 28 ngày inclusive
  const chanCond = channelId === undefined ? '' : 'AND channel_id = ?';
  const chanCondTv = channelId === undefined ? '' : 'AND tv.channel_id = ?';
  const chanArgs = channelId === undefined ? [] : [channelId];
  const counts = db.prepare(`
SELECT channel_id,
  COUNT(*) AS videos_tracked,
  SUM(CASE WHEN substr(published_at, 1, 10) >= ? THEN 1 ELSE 0 END) AS uploads_28d,
  SUM(CASE WHEN substr(published_at, 1, 10) >= ?
        AND outlier_score IS NOT NULL AND outlier_score >= ?
      THEN 1 ELSE 0 END) AS outliers_28d
FROM topic_videos
WHERE topic_id = ? ${chanCond}
GROUP BY channel_id
  `).all(from28, from28, outlierMultiple, topicId, ...chanArgs) as Row[];

  const gained = db.prepare(`
SELECT channel_id, SUM(gained) AS views_gained_7d FROM (
  SELECT tv.channel_id AS channel_id,
    dv.views - LAG(dv.views) OVER (PARTITION BY dv.video_id ORDER BY dv.day) AS gained,
    dv.day AS day
  FROM video_daily_views dv
  JOIN topic_videos tv
    ON tv.topic_id = dv.topic_id AND tv.video_id = dv.video_id
  WHERE dv.topic_id = ? ${chanCondTv}
)
WHERE day >= ? AND gained IS NOT NULL
GROUP BY channel_id
  `).all(topicId, ...chanArgs, from7) as Row[];

  const map = new Map<string, ChannelAgg>();
  for (const r of counts) {
    map.set(String(r['channel_id']), {
      videosTracked: Number(r['videos_tracked']),
      uploads28d: Number(r['uploads_28d']),
      outliers28d: Number(r['outliers_28d']),
      viewsGained7d: null,
    });
  }
  for (const r of gained) {
    const agg = map.get(String(r['channel_id'])) ?? {
      videosTracked: 0, uploads28d: 0, outliers28d: 0, viewsGained7d: null,
    };
    agg.viewsGained7d = numOrNull(r['views_gained_7d']);
    map.set(String(r['channel_id']), agg);
  }
  return map;
}

function channelRow(r: Row, agg: ChannelAgg | undefined, s: TopicSettings, todayQuota: string): DashChannelRow {
  const median = numOrNull(r['baseline_median_views']);
  const baselineN = intOrNull(r['baseline_n']);
  const maxViews = numOrNull(r['max_views']);
  const reliable = baselineN !== null && baselineN >= s.baselineMinN;
  const maxOverMedian = reliable && median && median > 0 && maxViews !== null
    ? maxViews / median
    : null;
  const lastPublishedAt = strOrNull(r['last_published_at']);
  let thumbnails: string[] = [];
  const rawThumb = r['thumbnails_json'];
  if (typeof rawThumb === 'string' && rawThumb !== '') {
    try {
      const v = JSON.parse(rawThumb) as unknown;
      if (Array.isArray(v)) thumbnails = v.filter((x): x is string => typeof x === 'string');
    } catch { /* json hỏng → mảng rỗng */ }
  }
  return {
    channel_id: String(r['channel_id']),
    title: strOrNull(r['title']),
    handle: strOrNull(r['handle']),
    url: `https://www.youtube.com/channel/${String(r['channel_id'])}`,
    subscriber_count: intOrNull(r['subscriber_count']),
    status: String(r['status']) as TopicChannelStatusV3,
    suggestion: strOrNull(r['suggestion']),
    discovered_via: strOrNull(r['discovered_via']),
    discovered_from: strOrNull(r['discovered_from']),
    first_seen_at: String(r['first_seen_at']),
    decided_at: strOrNull(r['decided_at']),
    decided_reason: strOrNull(r['decided_reason']),
    baseline_median_views: median,
    baseline_n: baselineN,
    baseline_reliable: reliable,
    max_views: maxViews === null ? null : Math.trunc(maxViews),
    max_over_median: maxOverMedian,
    is_dead: reliable && median !== null ? median < s.deadMedian : null,
    is_lottery: maxOverMedian === null ? null : maxOverMedian > s.lotteryRatio,
    last_published_at: lastPublishedAt,
    days_since_upload: dayDiff(lastPublishedAt, `${todayQuota}T23:59:59.999Z`),
    last_checked_at: strOrNull(r['last_checked_at']),
    videos_tracked: agg?.videosTracked ?? 0,
    uploads_28d: agg?.uploads28d ?? 0,
    views_gained_7d: agg?.viewsGained7d ?? null,
    outliers_28d: agg?.outliers28d ?? 0,
    thumbnails,
  };
}

export function dashChannels(
  db: Database,
  topicId: string,
  params: DashChannelsParams,
): { rows: DashChannelRow[]; total: number } {
  const settings = dashTopicSettings(db, topicId);
  const where: string[] = ['topic_id = ?'];
  const args: unknown[] = [topicId];
  if (params.status) {
    where.push('status = ?');
    args.push(params.status);
  }
  if (params.discoveredVia) {
    where.push('discovered_via = ?');
    args.push(params.discoveredVia);
  }
  if (params.q) {
    where.push('(title LIKE ? OR handle LIKE ?)');
    const like = `%${params.q}%`;
    args.push(like, like);
  }
  const rows = db.prepare(
    `SELECT * FROM topic_channels WHERE ${where.join(' AND ')}`,
  ).all(...(args as string[])) as Row[];
  const todayQuota = quotaDay();
  const aggs = channelAggregates(db, topicId, settings.outlierMultiple, todayQuota);
  let mapped = rows.map((r) => channelRow(r, aggs.get(String(r['channel_id'])), settings, todayQuota));
  // Sort trên field đã tính (có cột tổng hợp không sort được trong SQL).
  const key = params.sort;
  const dir = params.order === 'asc' ? 1 : -1;
  const val = (r: DashChannelRow): number | string => {
    const v = r[key];
    return v === null ? '' : (v as number | string);
  };
  mapped = mapped.sort((a, b) => {
    const va = val(a);
    const vb = val(b);
    if (va === vb) return 0;
    // null/'' xếp cuối bất kể chiều sort.
    if (va === '') return 1;
    if (vb === '') return -1;
    return va < vb ? -dir : dir;
  });
  const total = mapped.length;
  return { rows: mapped.slice(params.offset, params.offset + params.limit), total };
}

// ---------------------------------------------------------------------------
// #5 GET /dash/channels/:channel_id
// ---------------------------------------------------------------------------

function videoRow(r: Row, settings: TopicSettings, todayQuota: string): DashVideoRow {
  const publishedAt = strOrNull(r['published_at']);
  const durationSec = numOrNull(r['duration_sec']);
  const outlierScore = numOrNull(r['outlier_score']);
  const ageDays = dayDiff(publishedAt, `${todayQuota}T23:59:59.999Z`);
  return {
    video_id: String(r['video_id']),
    url: `https://www.youtube.com/watch?v=${String(r['video_id'])}`,
    title: String(r['title']),
    thumbnail_url: strOrNull(r['thumbnail_url']),
    channel_id: String(r['channel_id']),
    channel_title: strOrNull(r['channel_title']),
    channel_status: (strOrNull(r['channel_status']) ?? null) as TopicChannelStatusV3 | null,
    published_at: publishedAt,
    age_days: ageDays,
    duration_sec: durationSec,
    is_short: durationSec === null ? null : durationSec < settings.minDurationSec,
    latest_views: intOrNull(r['latest_views']),
    latest_likes: intOrNull(r['latest_likes']),
    latest_comments: intOrNull(r['latest_comments']),
    latest_at: strOrNull(r['latest_at']),
    views_gained_24h: intOrNull(r['views_gained_24h']),
    outlier_score: outlierScore,
    is_outlier: outlierScore === null ? null : outlierScore >= settings.outlierMultiple,
    launch_spike: outlierScore === null || ageDays === null
      ? null
      : ageDays < 3 && outlierScore >= settings.outlierMultiple,
    source: String(r['source']),
    found_by_keyword: strOrNull(r['found_by_keyword']),
    first_seen_at: String(r['first_seen_at']),
    snapshots: Number(r['snapshots'] ?? 0),
  };
}

/** Video của topic kèm channel_title/status + số snapshot — dùng chung cho
 *  channel detail (#5); bản đầy đủ có lọc/sort là videosList() của Devin B. */
function topicVideoRows(
  db: Database,
  topicId: string,
  channelId: string,
  limit: number,
): DashVideoRow[] {
  const settings = dashTopicSettings(db, topicId);
  const rows = db.prepare(`
SELECT tv.*, tc.title AS channel_title, tc.status AS channel_status,
  (SELECT COUNT(*) FROM video_daily_views dv
    WHERE dv.topic_id = tv.topic_id AND dv.video_id = tv.video_id) AS snapshots
FROM topic_videos tv
LEFT JOIN topic_channels tc
  ON tc.topic_id = tv.topic_id AND tc.channel_id = tv.channel_id
WHERE tv.topic_id = ? AND tv.channel_id = ?
ORDER BY tv.published_at DESC
LIMIT ?
  `).all(topicId, channelId, limit) as Row[];
  return rows.map((r) => videoRow(r, settings, quotaDay()));
}

export function dashChannelDetail(
  db: Database,
  topicId: string,
  channelId: string,
): DashChannelDetail | null {
  const settings = dashTopicSettings(db, topicId);
  const r = db.prepare(
    'SELECT * FROM topic_channels WHERE topic_id = ? AND channel_id = ?',
  ).get(topicId, channelId) as Row | undefined;
  if (!r) return null;
  const todayQuota = quotaDay();
  const agg = channelAggregates(db, topicId, settings.outlierMultiple, todayQuota, channelId)
    .get(channelId);
  return {
    channel: channelRow(r, agg, settings, todayQuota),
    recent_videos: topicVideoRows(db, topicId, channelId, 20),
    decisions: dashDecisions(db, topicId, {
      from: '0000-01-01',
      to: '9999-12-31',
      limit: 50,
      offset: 0,
      entityType: 'channel',
      entityId: channelId,
    }).rows,
  };
}

// ---------------------------------------------------------------------------
// #7 GET /dash/keywords
// ---------------------------------------------------------------------------

export function dashKeywords(
  db: Database,
  topicId: string,
  params: DashKeywordsParams,
): { rows: DashKeywordRow[]; total: number } {
  const where: string[] = ['topic_id = ?'];
  const args: unknown[] = [topicId];
  if (params.status) {
    where.push('status = ?');
    args.push(params.status);
  }
  if (params.origin) {
    where.push('origin = ?');
    args.push(params.origin);
  }
  if (params.q) {
    where.push('(display_term LIKE ? OR term_key LIKE ?)');
    const like = `%${params.q}%`;
    args.push(like, like);
  }
  const rows = db.prepare(
    `SELECT * FROM topic_keywords WHERE ${where.join(' AND ')}`,
  ).all(...(args as string[])) as Row[];

  // Số kênh mỗi keyword đã sinh — discovered_from = term_key.
  const discovered = db.prepare(`
SELECT discovered_from, COUNT(*) AS n
FROM topic_channels
WHERE topic_id = ? AND discovered_from IS NOT NULL
GROUP BY discovered_from
  `).all(topicId) as Row[];
  const discoveredMap = new Map(discovered.map((r) => [String(r['discovered_from']), Number(r['n'])]));

  let mapped: DashKeywordRow[] = rows.map((r) => {
    const termKey = String(r['term_key']);
    const nResults = intOrNull(r['last_n_results']);
    const nFollowed = intOrNull(r['last_n_followed']);
    let evidence: DashKeywordRow['evidence'] = { n_channels: null, sample_video_ids: [] };
    const rawEv = r['evidence_json'];
    if (typeof rawEv === 'string' && rawEv !== '') {
      try {
        const v = JSON.parse(rawEv) as Record<string, unknown>;
        if (v && typeof v === 'object') {
          evidence = {
            n_channels: intOrNull(v['n_channels']),
            sample_video_ids: Array.isArray(v['sample_video_ids'])
              ? v['sample_video_ids'].filter((x): x is string => typeof x === 'string')
              : [],
          };
        }
      } catch { /* json hỏng → evidence rỗng */ }
    }
    return {
      term_key: termKey,
      display_term: String(r['display_term']),
      status: String(r['status']) as TopicKeywordStatusV3,
      origin: (strOrNull(r['origin']) ?? null) as KeywordOrigin | null,
      added_by: String(r['added_by']) as DashKeywordRow['added_by'],
      added_at: String(r['added_at']),
      decided_at: strOrNull(r['decided_at']),
      decided_reason: strOrNull(r['decided_reason']),
      last_checked_at: strOrNull(r['last_checked_at']),
      last_n_results: nResults,
      last_n_followed: nFollowed,
      pct_followed: nResults && nResults > 0 && nFollowed !== null
        ? nFollowed / nResults
        : null,
      last_median_views: numOrNull(r['last_median_views']),
      channels_discovered: discoveredMap.get(termKey) ?? 0,
      evidence,
    };
  });

  const key = params.sort;
  const dir = params.order === 'asc' ? 1 : -1;
  mapped = mapped.sort((a, b) => {
    const va = a[key];
    const vb = b[key];
    if (va === vb) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    return va < vb ? -dir : dir;
  });
  const total = mapped.length;
  return { rows: mapped.slice(params.offset, params.offset + params.limit), total };
}

// ---------------------------------------------------------------------------
// #13 GET /dash/inbox
// ---------------------------------------------------------------------------

const NO_PAGE_SORT_CHANNEL: Pick<DashChannelsParams, 'sort' | 'order'> = {
  sort: 'first_seen_at', order: 'desc',
};

export function dashInbox(db: Database, topicId: string): DashInbox {
  const channelsNew = dashChannels(db, topicId, {
    ...NO_PAGE_SORT_CHANNEL, status: 'new', limit: 500, offset: 0,
  }).rows;
  const channelsSuggested = dashChannels(db, topicId, {
    ...NO_PAGE_SORT_CHANNEL, limit: 500, offset: 0,
  }).rows.filter((c) => c.suggestion !== null && c.suggestion !== '');
  const keywordsPending = dashKeywords(db, topicId, {
    status: 'pending', sort: 'added_at', order: 'desc', limit: 500, offset: 0,
  }).rows;
  return {
    channels_new: channelsNew,
    keywords_pending: keywordsPending,
    channels_suggested: channelsSuggested,
    counts: {
      channels: channelsNew.length,
      keywords: keywordsPending.length,
      suggestions: channelsSuggested.length,
    },
  };
}

// ---------------------------------------------------------------------------
// #14 GET /dash/decisions
// ---------------------------------------------------------------------------

export function dashDecisions(
  db: Database,
  topicId: string,
  params: DashDecisionsParams,
): { rows: DashDecisionRow[]; total: number; summary: DashDecisionSummary } {
  const where: string[] = ['d.topic_id = ?'];
  const args: unknown[] = [topicId];
  if (params.actor) {
    where.push('d.actor = ?');
    args.push(params.actor);
  }
  if (params.entityType) {
    where.push('d.entity_type = ?');
    args.push(params.entityType);
  }
  if (params.entityId) {
    where.push('d.entity_id = ?');
    args.push(params.entityId);
  }
  // `to` là khoá ngày inclusive: `d.at <= (? || 'T23:59:59.999Z')` nối
  // 'YYYY-MM-DD' thành cuối-ngày ISO — || là concat, bind chặt hơn <=.
  where.push('d.at >= ?', "d.at <= (? || 'T23:59:59.999Z')");
  args.push(params.from, params.to);
  const cond = where.join(' AND ');
  const total = Number(
    (db.prepare(`SELECT COUNT(*) AS n FROM decisions d WHERE ${cond}`)
      .get(...(args as string[])) as Row)['n'],
  );
  const rows = db.prepare(`
SELECT d.*,
  COALESCE(
    CASE WHEN d.entity_type = 'channel' THEN
      (SELECT tc.title FROM topic_channels tc
        WHERE tc.topic_id = d.topic_id AND tc.channel_id = d.entity_id) END,
    CASE WHEN d.entity_type = 'keyword' THEN
      (SELECT tk.display_term FROM topic_keywords tk
        WHERE tk.topic_id = d.topic_id AND tk.term_key = d.entity_id) END
  ) AS entity_label
FROM decisions d
WHERE ${cond}
ORDER BY d.at DESC
LIMIT ? OFFSET ?
  `).all(...([...args, params.limit, params.offset] as string[])) as Row[];

  // Summary tính trên toàn bộ lịch sử của topic — không theo filter — vì
  // hitl_violations là chỉ số toàn cục của tôn chỉ 1.
  const summaryRow = db.prepare(`
SELECT
  SUM(CASE WHEN actor = 'human' THEN 1 ELSE 0 END) AS human,
  SUM(CASE WHEN actor = 'loop' THEN 1 ELSE 0 END) AS loop_n,
  SUM(CASE WHEN actor = 'loop' AND to_status = 'new' THEN 1 ELSE 0 END) AS loop_new,
  SUM(CASE WHEN actor = 'loop' AND to_status = 'pending' THEN 1 ELSE 0 END) AS loop_pending,
  SUM(CASE WHEN actor = 'loop' AND to_status = 'rejected' THEN 1 ELSE 0 END) AS loop_rejected,
  SUM(CASE WHEN actor = 'loop' AND to_status IN ('active', 'paused') THEN 1 ELSE 0 END)
    AS hitl_violations
FROM decisions WHERE topic_id = ?
  `).get(topicId) as Row;

  return {
    rows: rows.map((r) => ({
      id: String(r['id']),
      at: String(r['at']),
      actor: String(r['actor']) as 'human' | 'loop',
      entity_type: String(r['entity_type']) as 'channel' | 'keyword',
      entity_id: String(r['entity_id']),
      entity_label: strOrNull(r['entity_label']),
      from_status: strOrNull(r['from_status']),
      to_status: String(r['to_status']),
      reason: String(r['reason']),
      tick_id: strOrNull(r['tick_id']),
    })),
    total,
    summary: {
      by_actor: {
        human: Number(summaryRow['human'] ?? 0),
        loop: Number(summaryRow['loop_n'] ?? 0),
      },
      loop_to_status: {
        new: Number(summaryRow['loop_new'] ?? 0),
        pending: Number(summaryRow['loop_pending'] ?? 0),
        rejected: Number(summaryRow['loop_rejected'] ?? 0),
      },
      hitl_violations: Number(summaryRow['hitl_violations'] ?? 0),
    },
  };
}

// ---------------------------------------------------------------------------
// #15 GET /dash/ticks
// ---------------------------------------------------------------------------

export function dashTicks(
  db: Database,
  topicId: string,
  params: DashTicksParams,
): { rows: DashTickRow[]; total: number } {
  const where: string[] = ['topic_id = ?', 'quota_day >= ?', 'quota_day <= ?'];
  const args: unknown[] = [topicId, params.from, params.to];
  if (params.mode) {
    where.push('mode = ?');
    args.push(params.mode);
  }
  const cond = where.join(' AND ');
  const total = Number(
    (db.prepare(`SELECT COUNT(*) AS n FROM loop_ticks WHERE ${cond}`)
      .get(...(args as string[])) as Row)['n'],
  );
  const rows = db.prepare(`
SELECT *,
  CAST((julianday(finished_at) - julianday(started_at)) * 86400 AS INTEGER)
    AS duration_sec
FROM loop_ticks
WHERE ${cond}
ORDER BY started_at DESC
LIMIT ? OFFSET ?
  `).all(...([...args, params.limit, params.offset] as string[])) as Row[];
  return {
    rows: rows.map((r) => ({
      tick_id: String(r['tick_id']),
      mode: String(r['mode']) as LoopMode,
      quota_day: String(r['quota_day']),
      started_at: String(r['started_at']),
      finished_at: strOrNull(r['finished_at']),
      duration_sec: intOrNull(r['duration_sec']),
      status: String(r['status']),
      step: String(r['step']),
      error: strOrNull(r['error']),
      search_calls_used: Number(r['search_calls_used']),
      general_units_used: Number(r['general_units_used']),
      scanned_channels: Number(r['scanned_channels']),
      new_candidates: Number(r['new_candidates']),
      keywords_harvested: Number(r['keywords_harvested']),
    })),
    total,
  };
}

// ---------------------------------------------------------------------------
// #16 GET /dash/reports + GET /dash/quota
// ---------------------------------------------------------------------------

const parseJsonObj = (raw: unknown): Record<string, unknown> => {
  if (typeof raw !== 'string' || raw === '') return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v)
      ? v as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
};

export function dashReports(
  db: Database,
  topicId: string,
  params: DashReportsParams,
): { rows: DashReportRow[]; total: number } {
  const where: string[] = ['topic_id = ?'];
  const args: unknown[] = [topicId];
  if (params.mode) {
    where.push('mode = ?');
    args.push(params.mode);
  }
  if (params.date) {
    where.push('report_date = ?');
    args.push(params.date);
  }
  const cond = where.join(' AND ');
  const total = Number(
    (db.prepare(`SELECT COUNT(*) AS n FROM daily_reports WHERE ${cond}`)
      .get(...(args as string[])) as Row)['n'],
  );
  const rows = db.prepare(`
SELECT report_id, report_date, mode, summary_json, markdown, delivered_json
FROM daily_reports
WHERE ${cond}
ORDER BY report_date DESC
LIMIT ? OFFSET ?
  `).all(...([...args, params.limit, params.offset] as string[])) as Row[];
  return {
    rows: rows.map((r) => ({
      report_id: String(r['report_id']),
      report_date: String(r['report_date']),
      mode: String(r['mode']) as LoopMode,
      summary: parseJsonObj(r['summary_json']),
      markdown: String(r['markdown'] ?? ''),
      delivered: parseJsonObj(r['delivered_json']),
    })),
    total,
  };
}

/** Quota là sổ toàn cục (api_quota_usage), không gắn topic — §3 #16. */
export function dashQuota(db: Database, params: DashQuotaParams): DashQuotaRow[] {
  const where: string[] = ['quota_day >= ?', 'quota_day <= ?'];
  const args: unknown[] = [params.from, params.to];
  if (params.bucket) {
    where.push('bucket = ?');
    args.push(params.bucket);
  }
  const rows = db.prepare(`
SELECT quota_day, bucket, units, calls
FROM api_quota_usage
WHERE ${where.join(' AND ')}
ORDER BY quota_day DESC, bucket ASC
  `).all(...(args as string[])) as Row[];
  return rows.map((r) => ({
    quota_day: String(r['quota_day']),
    bucket: String(r['bucket']),
    units: Number(r['units']),
    calls: Number(r['calls']),
  }));
}
