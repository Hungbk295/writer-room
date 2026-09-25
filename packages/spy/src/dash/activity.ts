// packages/spy/src/dash/activity.ts — truy vấn read-only cho các endpoint
// "activity" của Spy Dashboard API (docs/plans/spy-dashboard-api.html):
// overview(#3) · channel timeseries(#6) · videos(#8) · video timeseries(#9)
// · hot(#10) · outliers(#11) · timeseries(#12). Phần registry thuộc
// dash/registry.ts. Mọi hàm nhận Database và CHỈ SELECT — không INSERT/UPDATE.
//
// Bài học §1: số trả thô không format; giá trị chưa đủ dữ liệu → null,
// không bao giờ 0 (views_gained khi mới có 1 snapshot, heat khi baseline
// chưa tin cậy...).

import type { Database } from 'bun:sqlite';
import { quotaDay } from '../quota.ts';
import type { TopicChannelStatusV3 } from '../store.ts';
import { dashTopicSettings } from './registry.ts';
import type {
  DashChannelDayPoint,
  DashHotParams,
  DashHotRow,
  DashOutlierRow,
  DashOutliersParams,
  DashOverview,
  DashOverviewParams,
  DashRange,
  DashSeriesPoint,
  DashTimeseriesParams,
  DashVideoDayPoint,
  DashVideoRow,
  DashVideosParams,
} from './types.ts';

type Row = Record<string, unknown>;

const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
const intOrNull = (v: unknown): number | null => {
  const n = numOrNull(v);
  return n === null ? null : Math.trunc(n);
};
const strOrNull = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? v : null;

const MS_PER_DAY = 86_400_000;
// "Hôm nay" của pipeline = quota_day Pacific — không dùng UTC ISO date
// vì hai khoá lệch nhau 17:00–23:59 Pacific (review M1).
const today = (): string => quotaDay();
const shiftDay = (day: string, delta: number): string => {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
};
const ageDays = (publishedAt: string | null, nowIso: string): number | null => {
  if (!publishedAt) return null;
  const a = Date.parse(publishedAt);
  const b = Date.parse(nowIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.floor((b - a) / MS_PER_DAY);
};

/** Bucket tuần = Thứ 2 đầu tuần (SQLite %w: 0 = Chủ nhật). */
const WEEK_BUCKET = "date(d, '-' || ((CAST(strftime('%w', d) AS INTEGER) + 6) % 7) || ' days')";

// ---------------------------------------------------------------------------
// #3 GET /dash/overview — hôm nay so với hôm qua
// ---------------------------------------------------------------------------

const FOLLOWED = "('active','own')";

export function dashOverview(
  db: Database,
  topicId: string,
  params: DashOverviewParams,
): DashOverview {
  const date = params.date ?? today();
  const prevDay = shiftDay(date, -1);
  const day7 = shiftDay(date, -6);
  const settings = dashTopicSettings(db, topicId);

  const chanRows = db.prepare(
    'SELECT status, COUNT(*) AS n FROM topic_channels WHERE topic_id = ? GROUP BY status',
  ).all(topicId) as Row[];
  const channels = { new: 0, active: 0, paused: 0, rejected: 0, own: 0 };
  for (const r of chanRows) {
    const s = String(r['status']) as keyof typeof channels;
    if (s in channels) channels[s] = Number(r['n']);
  }

  const kwRows = db.prepare(
    'SELECT status, COUNT(*) AS n FROM topic_keywords WHERE topic_id = ? GROUP BY status',
  ).all(topicId) as Row[];
  const keywords = { pending: 0, active: 0, paused: 0, rejected: 0 };
  for (const r of kwRows) {
    const s = String(r['status']) as keyof typeof keywords;
    if (s in keywords) keywords[s] = Number(r['n']);
  }

  const one = (sql: string, ...args: string[]): number =>
    Number((db.prepare(sql).get(...args) as Row | undefined)?.['n'] ?? 0);

  const videosTracked = one(
    'SELECT COUNT(*) AS n FROM topic_videos WHERE topic_id = ?', topicId);
  // "Video mới" = video ĐĂNG mới → đếm theo published_at (khoá quota_day),
  // KHÔNG first_seen_at — lần quét đầu backfill lịch sử, first_seen gom hết
  // vào ngày scan và thổi phồng chỉ số (E2E: 129 "video mới hôm nay" giả).
  // Đồng bộ với metric new_videos của #12 đã đếm theo published_at.
  const newVideosOn = (d: string): number => one(
    `SELECT COUNT(*) AS n FROM topic_videos
     WHERE topic_id = ? AND substr(published_at, 1, 10) = ?`, topicId, d);
  const newVideos7d = one(
    `SELECT COUNT(*) AS n FROM topic_videos
     WHERE topic_id = ? AND substr(published_at, 1, 10) BETWEEN ? AND ?`,
    topicId, day7, date);

  // Σ gained trong ngày = tổng hiệu với snapshot ngay trước của từng video —
  // LAG trên TOÀN bộ lịch sử rồi mới lọc ngày, vì mốc so của ngày đầu khoảng
  // nằm ngoài khoảng. SUM trên tập rỗng/mọi phần tử NULL → NULL (đúng §1).
  const gainedOn = (d: string): number | null => numOrNull(
    (db.prepare(`
SELECT SUM(gained) AS g FROM (
  SELECT views - LAG(views) OVER (PARTITION BY video_id ORDER BY day) AS gained,
    day
  FROM video_daily_views WHERE topic_id = ?
) WHERE day = ? AND gained IS NOT NULL
    `).get(topicId, d) as Row | undefined)?.['g'],
  );

  const outlierSplit = db.prepare(`
SELECT CASE WHEN tc.status IN ${FOLLOWED} THEN 'followed' ELSE 'external' END AS scope,
  COUNT(*) AS n
FROM topic_videos tv
LEFT JOIN topic_channels tc
  ON tc.topic_id = tv.topic_id AND tc.channel_id = tv.channel_id
WHERE tv.topic_id = ?
  AND tv.outlier_score IS NOT NULL AND tv.outlier_score >= ?
  AND substr(tv.published_at, 1, 10) BETWEEN ? AND ?
GROUP BY scope
  `).all(topicId, settings.outlierMultiple, day7, date) as Row[];
  const outliers7d = { followed: 0, external: 0 };
  for (const r of outlierSplit) {
    outliers7d[String(r['scope']) as keyof typeof outliers7d] = Number(r['n']);
  }

  const inbox = {
    channels: one(
      "SELECT COUNT(*) AS n FROM topic_channels WHERE topic_id = ? AND status = 'new'", topicId),
    keywords: one(
      "SELECT COUNT(*) AS n FROM topic_keywords WHERE topic_id = ? AND status = 'pending'", topicId),
    suggestions: one(
      `SELECT COUNT(*) AS n FROM topic_channels
       WHERE topic_id = ? AND suggestion IS NOT NULL AND suggestion != ''`, topicId),
  };

  const quotaRow = (bucket: string): Row | undefined =>
    db.prepare(
      'SELECT units, calls FROM api_quota_usage WHERE bucket = ? AND quota_day = ?',
    ).get(bucket, date) as Row | undefined;
  const quotaToday = {
    search_calls: Number(quotaRow('search')?.['calls'] ?? 0),
    general_units: Number(quotaRow('general')?.['units'] ?? 0),
  };

  // Delta chỉ số "đếm trạng thái" không có snapshot lịch sử — chỉ truy vết
  // được qua decisions trong ngày. CỘNG khi vào 'active' từ trạng thái khác;
  // TRỪ khi rời 'active' (paused/rejected với from_status='active'). Reject
  // một pending không đổi số active — lỗi cũ trừ cả trường hợp này (E2E:
  // keywords_active ra 24 thay vì 38).
  const netActiveOn = (d: string, entity: 'channel' | 'keyword'): number => one(
    `SELECT SUM(CASE
         WHEN to_status = 'active'
           AND (from_status IS NULL OR from_status != 'active') THEN 1
         WHEN to_status IN ('paused','rejected')
           AND from_status = 'active' THEN -1
         ELSE 0 END) AS n
     FROM decisions
     WHERE topic_id = ? AND entity_type = ? AND actor = 'human'
       AND substr(at, 1, 10) = ?`, topicId, entity, d);

  const lastTick = (mode: 'daily' | 'weekly'): { at: string | null; status: string | null } => {
    const r = db.prepare(
      `SELECT started_at, status FROM loop_ticks
       WHERE topic_id = ? AND mode = ? ORDER BY started_at DESC LIMIT 1`,
    ).get(topicId, mode) as Row | undefined;
    return {
      at: strOrNull(r?.['started_at']),
      status: strOrNull(r?.['status']),
    };
  };

  const gainedToday = gainedOn(date);
  const gainedPrev = gainedOn(prevDay);
  const newToday = newVideosOn(date);
  const newPrev = newVideosOn(prevDay);

  return {
    date,
    channels,
    keywords,
    videos_tracked: videosTracked,
    new_videos_today: newToday,
    new_videos_7d: newVideos7d,
    views_gained_today: gainedToday,
    outliers_7d: outliers7d,
    inbox_pending: inbox,
    quota_today: quotaToday,
    delta_vs_prev_day: {
      views_gained_today: gainedToday === null || gainedPrev === null
        ? null
        : gainedToday - gainedPrev,
      new_videos_today: newToday - newPrev,
      channels_active: netActiveOn(date, 'channel'),
      keywords_active: netActiveOn(date, 'keyword'),
    },
    last_ticks: { daily: lastTick('daily'), weekly: lastTick('weekly') },
  };
}

// ---------------------------------------------------------------------------
// #6 GET /dash/channels/:id/timeseries
// ---------------------------------------------------------------------------

export function channelTimeseries(
  db: Database,
  topicId: string,
  channelId: string,
  range: DashRange,
): DashChannelDayPoint[] | null {
  const exists = db.prepare(
    'SELECT 1 FROM topic_channels WHERE topic_id = ? AND channel_id = ?',
  ).get(topicId, channelId);
  if (!exists) return null;

  const rows = db.prepare(`
SELECT day, SUM(views) AS total_views, SUM(gained) AS views_gained,
  COUNT(*) AS videos_observed
FROM (
  SELECT dv.day AS day, dv.views AS views,
    dv.views - LAG(dv.views) OVER (PARTITION BY dv.video_id ORDER BY dv.day) AS gained
  FROM video_daily_views dv
  JOIN topic_videos tv
    ON tv.topic_id = dv.topic_id AND tv.video_id = dv.video_id
  WHERE dv.topic_id = ? AND tv.channel_id = ?
)
WHERE day BETWEEN ? AND ?
GROUP BY day ORDER BY day ASC
  `).all(topicId, channelId, range.from, range.to) as Row[];

  // uploads đếm theo published_at — nguồn khác snapshot nên query riêng rồi
  // gộp theo day.
  const uploads = new Map<string, number>();
  for (const r of db.prepare(`
SELECT substr(published_at, 1, 10) AS d, COUNT(*) AS n
FROM topic_videos
WHERE topic_id = ? AND channel_id = ?
  AND substr(published_at, 1, 10) BETWEEN ? AND ?
GROUP BY d
  `).all(topicId, channelId, range.from, range.to) as Row[]) {
    uploads.set(String(r['d']), Number(r['n']));
  }

  return rows.map((r) => ({
    day: String(r['day']),
    total_views: Number(r['total_views']),
    views_gained: numOrNull(r['views_gained']),
    uploads: uploads.get(String(r['day'])) ?? 0,
    videos_observed: Number(r['videos_observed']),
  }));
}

// ---------------------------------------------------------------------------
// #8 GET /dash/videos
// ---------------------------------------------------------------------------

const VIDEO_SORT_COLS: Record<string, string> = {
  views_gained_24h: 'tv.views_gained_24h',
  outlier_score: 'tv.outlier_score',
  latest_views: 'tv.latest_views',
  published_at: 'tv.published_at',
  first_seen_at: 'tv.first_seen_at',
};

export function videosList(
  db: Database,
  topicId: string,
  params: DashVideosParams,
): { rows: DashVideoRow[]; total: number } {
  const settings = dashTopicSettings(db, topicId);
  const where: string[] = ['tv.topic_id = ?'];
  const args: unknown[] = [topicId];
  if (params.channelId) {
    where.push('tv.channel_id = ?');
    args.push(params.channelId);
  }
  if (params.source) {
    where.push('tv.source = ?');
    args.push(params.source);
  }
  if (params.keyword) {
    where.push('tv.found_by_keyword = ?');
    args.push(params.keyword);
  }
  if (params.publishedAfter) {
    where.push('substr(tv.published_at, 1, 10) >= ?');
    args.push(params.publishedAfter);
  }
  if (params.minOutlier !== undefined) {
    where.push('tv.outlier_score IS NOT NULL AND tv.outlier_score >= ?');
    args.push(params.minOutlier);
  }
  if (params.minDuration !== undefined) {
    where.push('tv.duration_sec IS NOT NULL AND tv.duration_sec >= ?');
    args.push(params.minDuration);
  }
  const cond = where.join(' AND ');
  const sortCol = VIDEO_SORT_COLS[params.sort] ?? 'tv.latest_views';
  // NULLS LAST: số liệu chưa đủ không được nổi lên đầu bảng.
  const dir = params.order === 'asc' ? 'ASC' : 'DESC';

  const total = Number(
    (db.prepare(`SELECT COUNT(*) AS n FROM topic_videos tv WHERE ${cond}`)
      .get(...(args as never[])) as Row)['n'],
  );
  const rows = db.prepare(`
SELECT tv.*, tc.title AS channel_title, tc.status AS channel_status,
  (SELECT COUNT(*) FROM video_daily_views dv
    WHERE dv.topic_id = tv.topic_id AND dv.video_id = tv.video_id) AS snapshots
FROM topic_videos tv
LEFT JOIN topic_channels tc
  ON tc.topic_id = tv.topic_id AND tc.channel_id = tv.channel_id
WHERE ${cond}
ORDER BY ${sortCol} ${dir} NULLS LAST
LIMIT ? OFFSET ?
  `).all(...([...args, params.limit, params.offset] as never[])) as Row[];

  const nowIso = `${quotaDay()}T23:59:59.999Z`;
  return {
    rows: rows.map((r) => {
      const publishedAt = strOrNull(r['published_at']);
      const durationSec = numOrNull(r['duration_sec']);
      const outlierScore = numOrNull(r['outlier_score']);
      const age = ageDays(publishedAt, nowIso);
      const isOutlier = outlierScore === null ? null : outlierScore >= settings.outlierMultiple;
      return {
        video_id: String(r['video_id']),
        url: `https://www.youtube.com/watch?v=${String(r['video_id'])}`,
        title: String(r['title']),
        thumbnail_url: strOrNull(r['thumbnail_url']),
        channel_id: String(r['channel_id']),
        channel_title: strOrNull(r['channel_title']),
        channel_status: (strOrNull(r['channel_status']) ?? null) as TopicChannelStatusV3 | null,
        published_at: publishedAt,
        age_days: age,
        duration_sec: durationSec,
        is_short: durationSec === null ? null : durationSec < settings.minDurationSec,
        latest_views: intOrNull(r['latest_views']),
        latest_likes: intOrNull(r['latest_likes']),
        latest_comments: intOrNull(r['latest_comments']),
        latest_at: strOrNull(r['latest_at']),
        views_gained_24h: intOrNull(r['views_gained_24h']),
        outlier_score: outlierScore,
        is_outlier: isOutlier,
        launch_spike: isOutlier === null || age === null ? null : age < 3 && isOutlier,
        source: String(r['source']),
        found_by_keyword: strOrNull(r['found_by_keyword']),
        first_seen_at: String(r['first_seen_at']),
        snapshots: Number(r['snapshots']),
      };
    }),
    total,
  };
}

// ---------------------------------------------------------------------------
// #9 GET /dash/videos/:id/timeseries
// ---------------------------------------------------------------------------

export function videoTimeseries(
  db: Database,
  topicId: string,
  videoId: string,
): DashVideoDayPoint[] | null {
  const exists = db.prepare(
    'SELECT 1 FROM topic_videos WHERE topic_id = ? AND video_id = ?',
  ).get(topicId, videoId);
  if (!exists) return null;
  const rows = db.prepare(`
SELECT day, views, likes, comments,
  views - LAG(views) OVER (ORDER BY day) AS gained
FROM video_daily_views
WHERE topic_id = ? AND video_id = ?
ORDER BY day ASC
  `).all(topicId, videoId) as Row[];
  return rows.map((r) => ({
    day: String(r['day']),
    views: Number(r['views']),
    likes: intOrNull(r['likes']),
    comments: intOrNull(r['comments']),
    views_gained: intOrNull(r['gained']),
  }));
}

// ---------------------------------------------------------------------------
// #10 GET /dash/hot — bảng nóng của ĐÚNG ngày `date`, tính lại từ snapshot
// lịch sử nên gọi hôm nay hay 7 ngày sau đều ra một kết quả (§5.3).
// ---------------------------------------------------------------------------

export function hotBoard(
  db: Database,
  topicId: string,
  params: DashHotParams,
): DashHotRow[] {
  const date = params.date ?? today();
  const limit = params.limit ?? 10;
  const settings = dashTopicSettings(db, topicId);
  const nowIso = `${date}T23:59:59.999Z`;

  // prev = snapshot gần nhất TRƯỚC `date` của cùng video — không dùng
  // latest_* vì latest luôn trỏ quan sát mới nhất, không phải ngày đang xem.
  const rows = db.prepare(`
SELECT tv.video_id, tv.title, tv.channel_id, tv.published_at, tv.outlier_score,
  tc.title AS channel_title,
  tc.baseline_median_views, tc.baseline_n,
  cur.views AS views,
  cur.views - prev.views AS views_gained,
  CAST(julianday(cur.day) - julianday(prev.day) AS INTEGER) AS window_days
FROM video_daily_views cur
JOIN topic_videos tv
  ON tv.topic_id = cur.topic_id AND tv.video_id = cur.video_id
LEFT JOIN topic_channels tc
  ON tc.topic_id = tv.topic_id AND tc.channel_id = tv.channel_id
JOIN video_daily_views prev
  ON prev.topic_id = cur.topic_id AND prev.video_id = cur.video_id
  AND prev.day = (
    SELECT MAX(day) FROM video_daily_views
    WHERE topic_id = cur.topic_id AND video_id = cur.video_id AND day < cur.day
  )
WHERE cur.topic_id = ? AND cur.day = ?
  `).all(topicId, date) as Row[];

  const mapped = rows.map((r): DashHotRow => {
    const gained = numOrNull(r['views_gained']);
    const windowDays = Math.max(1, intOrNull(r['window_days']) ?? 1);
    const gainedPerDay = gained === null ? null : gained / windowDays;
    const median = numOrNull(r['baseline_median_views']);
    const baselineN = intOrNull(r['baseline_n']);
    const reliable = baselineN !== null && baselineN >= settings.baselineMinN;
    const age = ageDays(strOrNull(r['published_at']), nowIso);
    const outlierScore = numOrNull(r['outlier_score']);
    const isOutlier = outlierScore === null ? null : outlierScore >= settings.outlierMultiple;
    return {
      rank: 0, // gán sau khi sort
      video_id: String(r['video_id']),
      title: String(r['title']),
      channel_id: String(r['channel_id']),
      channel_title: strOrNull(r['channel_title']),
      views: Number(r['views']),
      views_gained: gained,
      window_days: windowDays,
      gained_per_day: gainedPerDay,
      heat: gainedPerDay === null || !reliable || !median || median <= 0
        ? null
        : gainedPerDay / (median / 30),
      outlier_score: outlierScore,
      age_days: age,
      launch_spike: isOutlier === null || age === null ? null : age < 3 && isOutlier,
    };
  });

  const filtered = params.excludeLaunch
    ? mapped.filter((r) => r.launch_spike !== true)
    : mapped;
  // Video chưa đủ 2 snapshot (gained null) xếp cuối bảng.
  filtered.sort((a, b) => {
    if (a.gained_per_day === null && b.gained_per_day === null) return 0;
    if (a.gained_per_day === null) return 1;
    if (b.gained_per_day === null) return -1;
    return b.gained_per_day - a.gained_per_day;
  });
  return filtered.slice(0, limit).map((r, i) => ({ ...r, rank: i + 1 }));
}

// ---------------------------------------------------------------------------
// #11 GET /dash/outliers
// ---------------------------------------------------------------------------

export function outliers(
  db: Database,
  topicId: string,
  params: DashOutliersParams,
): DashOutlierRow[] {
  const scopeCond = params.scope === 'followed'
    ? `AND tc.status IN ${FOLLOWED}`
    : params.scope === 'external'
      ? `AND (tc.status IS NULL OR tc.status NOT IN ${FOLLOWED})`
      : '';
  const rows = db.prepare(`
SELECT tv.video_id, tv.title, tv.channel_id, tv.published_at, tv.latest_views,
  tv.outlier_score, tv.found_by_keyword,
  tc.title AS channel_title, tc.status AS channel_status, tc.baseline_median_views
FROM topic_videos tv
LEFT JOIN topic_channels tc
  ON tc.topic_id = tv.topic_id AND tc.channel_id = tv.channel_id
WHERE tv.topic_id = ?
  AND tv.outlier_score IS NOT NULL AND tv.outlier_score >= ?
  AND substr(tv.published_at, 1, 10) BETWEEN ? AND ?
  ${scopeCond}
ORDER BY tv.outlier_score DESC
LIMIT ? OFFSET ?
  `).all(
    topicId, params.minMultiple, params.range.from, params.range.to,
    params.limit, params.offset,
  ) as Row[];

  return rows.map((r) => {
    const status = strOrNull(r['channel_status']) as TopicChannelStatusV3 | null;
    return {
      video_id: String(r['video_id']),
      title: String(r['title']),
      channel_id: String(r['channel_id']),
      channel_title: strOrNull(r['channel_title']),
      channel_status: status,
      scope: status !== null && (status === 'active' || status === 'own')
        ? 'followed' as const
        : 'external' as const,
      published_at: strOrNull(r['published_at']),
      latest_views: intOrNull(r['latest_views']),
      baseline_median_views: numOrNull(r['baseline_median_views']),
      outlier_score: numOrNull(r['outlier_score']),
      found_by_keyword: strOrNull(r['found_by_keyword']),
      channel_in_inbox: status === 'new',
    };
  });
}

// ---------------------------------------------------------------------------
// #12 GET /dash/timeseries
// ---------------------------------------------------------------------------

export function timeseries(
  db: Database,
  topicId: string,
  params: DashTimeseriesParams,
): DashSeriesPoint[] {
  const { from, to } = params.range;
  const bucketExpr = params.groupBy === 'week' ? WEEK_BUCKET : 'd';

  switch (params.metric) {
    case 'views_gained': {
      // Chỉ video của kênh đang follow (active|own) — kênh inbox/rejected
      // không vào chỉ số vận hành của topic.
      const rows = db.prepare(`
SELECT ${bucketExpr} AS bucket, SUM(gained) AS value FROM (
  SELECT dv.day AS d,
    dv.views - LAG(dv.views) OVER (PARTITION BY dv.video_id ORDER BY dv.day) AS gained
  FROM video_daily_views dv
  JOIN topic_videos tv
    ON tv.topic_id = dv.topic_id AND tv.video_id = dv.video_id
  LEFT JOIN topic_channels tc
    ON tc.topic_id = tv.topic_id AND tc.channel_id = tv.channel_id
  WHERE dv.topic_id = ? AND tc.status IN ${FOLLOWED}
)
WHERE d BETWEEN ? AND ? AND gained IS NOT NULL
GROUP BY bucket ORDER BY bucket ASC
      `).all(topicId, from, to) as Row[];
      return rows.map((r) => ({ bucket: String(r['bucket']), value: Number(r['value']) }));
    }

    case 'new_videos': {
      const rows = db.prepare(`
SELECT ${bucketExpr} AS bucket, COUNT(*) AS value FROM (
  SELECT substr(published_at, 1, 10) AS d FROM topic_videos WHERE topic_id = ?
)
WHERE d BETWEEN ? AND ?
GROUP BY bucket ORDER BY bucket ASC
      `).all(topicId, from, to) as Row[];
      return rows.map((r) => ({ bucket: String(r['bucket']), value: Number(r['value']) }));
    }

    case 'outliers': {
      const threshold = dashTopicSettings(db, topicId).outlierMultiple;
      const rows = db.prepare(`
SELECT ${bucketExpr} AS bucket, COUNT(*) AS value FROM (
  SELECT substr(published_at, 1, 10) AS d, outlier_score FROM topic_videos WHERE topic_id = ?
)
WHERE d BETWEEN ? AND ? AND outlier_score IS NOT NULL AND outlier_score >= ?
GROUP BY bucket ORDER BY bucket ASC
      `).all(topicId, from, to, threshold) as Row[];
      return rows.map((r) => ({ bucket: String(r['bucket']), value: Number(r['value']) }));
    }

    case 'new_channels': {
      const rows = db.prepare(`
SELECT ${bucketExpr} AS bucket, COUNT(*) AS value FROM (
  SELECT substr(at, 1, 10) AS d FROM decisions
  WHERE topic_id = ? AND entity_type = 'channel' AND to_status = 'new'
)
WHERE d BETWEEN ? AND ?
GROUP BY bucket ORDER BY bucket ASC
      `).all(topicId, from, to) as Row[];
      return rows.map((r) => ({ bucket: String(r['bucket']), value: Number(r['value']) }));
    }

    case 'approvals': {
      const rows = db.prepare(`
SELECT ${bucketExpr} AS bucket, to_status, COUNT(*) AS value FROM (
  SELECT substr(at, 1, 10) AS d, to_status FROM decisions
  WHERE topic_id = ? AND actor = 'human'
)
WHERE d BETWEEN ? AND ?
GROUP BY bucket, to_status ORDER BY bucket ASC
      `).all(topicId, from, to) as Row[];
      const byBucket = new Map<string, DashSeriesPoint>();
      for (const r of rows) {
        const b = String(r['bucket']);
        const p = byBucket.get(b) ?? { bucket: b, value: 0, breakdown: {} };
        p.value += Number(r['value']);
        p.breakdown![String(r['to_status'])] = Number(r['value']);
        byBucket.set(b, p);
      }
      return [...byBucket.values()];
    }

    case 'search_calls':
    case 'general_units': {
      const col = params.metric === 'search_calls' ? 'search_calls_used' : 'general_units_used';
      const rows = db.prepare(`
SELECT ${bucketExpr} AS bucket, mode, SUM(${col}) AS value FROM (
  SELECT quota_day AS d, mode, ${col} FROM loop_ticks WHERE topic_id = ?
)
WHERE d BETWEEN ? AND ?
GROUP BY bucket, mode ORDER BY bucket ASC
      `).all(topicId, from, to) as Row[];
      const byBucket = new Map<string, DashSeriesPoint>();
      for (const r of rows) {
        const b = String(r['bucket']);
        const p = byBucket.get(b) ?? { bucket: b, value: 0, breakdown: {} };
        p.value += Number(r['value']);
        p.breakdown![String(r['mode'])] = Number(r['value']);
        byBucket.set(b, p);
      }
      return [...byBucket.values()];
    }
  }
}
