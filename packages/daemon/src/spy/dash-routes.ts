// packages/daemon/src/spy/dash-routes.ts — 16 route GET read-only dưới
// /api/spy/dash/* (docs/plans/spy-dashboard-api.html). Mount duy nhất 1 dòng
// trong http.ts để không phình file. Mọi truy vấn nằm trong
// packages/spy/src/dash/{registry,activity}.ts; file này chỉ parse/validate
// query, gói envelope {data, meta}, render format=csv, map 400/404.
// Không route nào ghi dữ liệu — HITL vẫn chỉ qua POST /api/spy/loop/decide.

import {
  dashChannelDetail,
  dashChannels,
  dashDecisions,
  dashInbox,
  dashKeywords,
  dashMeta,
  dashQuota,
  dashReports,
  dashTicks,
  dashTopicSettings,
  dashTopics,
  quotaDay,
  type SpyService,
  channelTimeseries,
  dashOverview,
  hotBoard,
  outliers,
  timeseries,
  videoTimeseries,
  videosList,
  type DashChannelSort,
  type DashChannelsParams,
  type DashDecisionsParams,
  type DashGroupBy,
  type DashKeywordSort,
  type DashKeywordsParams,
  type DashMetric,
  type DashOutliersParams,
  type DashOutlierScope,
  type DashRange,
  type DashReportsParams,
  type DashTicksParams,
  type DashVideosParams,
  type DashVideoSort,
} from '@writer-room/spy';

// 7 hàm activity (#3, #6, #8–#12) — cài thật trong
// packages/spy/src/dash/activity.ts, export qua @writer-room/spy.
const activity = {
  overview: dashOverview,
  videosList,
  videoTimeseries,
  channelTimeseries,
  hotBoard,
  outliers,
  timeseries,
};

// ── Helpers http nhỏ (bản sao của http.ts — file này tự chứa để mount 1 dòng)

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function err(message: string, status = 400): Response {
  return json({ error: message }, status);
}

// ── Parse/validate tham số chung (§1) ───────────────────────────────────────

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// Mặc định ngày = quota_day Pacific (khoá ngày của pipeline), KHÔNG UTC
// ISO date — hai khoá lệch nhau 17:00–23:59 Pacific (review M1). Dùng cho
// so khớp CHÍNH XÁC 1 ngày trên cột đã bucket theo quota_day
// (video_daily_views.day, /overview?date, /hot?date) — ĐỪNG dùng làm cận
// trên của một range.
const todayDay = (): string => quotaDay();
// Cận trên của MỌI range (from/to) trong file này — kể cả range áp lên cột
// mốc thời gian thật (decisions.at, topic_videos.published_at, dùng
// substr(...,1,10) để so). Pacific luôn trễ hơn hoặc bằng UTC cùng lúc, nên
// ngày UTC hôm nay luôn >= mọi quota_day có thể tồn tại — dùng nó làm cận
// trên vừa đúng cho cột mốc thời gian thật, vừa không làm hẹp cận trên của
// cột quota_day (an toàn theo cả hai chiều). Sự cố thật: 2026-09-26 02:21Z,
// quotaDay()='2026-09-25' — một decision ghi NGAY LÚC ĐÓ (at=hôm nay UTC)
// biến mất khỏi /decisions vì to (Pacific, hôm qua) < at (UTC, hôm nay).
const todayDayUtc = (): string => new Date().toISOString().slice(0, 10);

function shiftDay(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** from/to mặc định 28 ngày gần nhất, cận trên = todayDayUtc() (xem comment). Ném string mô tả lỗi. */
function parseRange(url: URL): DashRange {
  const to = url.searchParams.get('to') ?? todayDayUtc();
  const from = url.searchParams.get('from') ?? shiftDay(to, -27);
  if (!DAY_RE.test(from) || !DAY_RE.test(to)) {
    throw 'from/to phải là YYYY-MM-DD';
  }
  if (from > to) throw 'from phải <= to';
  return { from, to };
}

function parsePage(url: URL, defLimit = 50): { limit: number; offset: number } {
  const rawLimit = url.searchParams.get('limit');
  const rawOffset = url.searchParams.get('offset');
  const limit = rawLimit === null ? defLimit : Number(rawLimit);
  const offset = rawOffset === null ? 0 : Number(rawOffset);
  if (!Number.isInteger(limit) || limit < 1) throw 'limit phải là số nguyên > 0';
  if (limit > 500) throw 'limit tối đa 500';
  if (!Number.isInteger(offset) || offset < 0) throw 'offset phải là số nguyên >= 0';
  return { limit, offset };
}

function parseOrder(url: URL): 'asc' | 'desc' {
  const v = url.searchParams.get('order') ?? 'desc';
  if (v !== 'asc' && v !== 'desc') throw "order phải là asc|desc";
  return v;
}

function parseSort<S extends string>(url: URL, allowed: readonly S[], def: S): S {
  const v = url.searchParams.get('sort') ?? def;
  if (!(allowed as readonly string[]).includes(v)) {
    throw `sort không hợp lệ — cho phép: ${allowed.join(', ')}`;
  }
  return v as S;
}

function parseEnum<S extends string>(url: URL, key: string, allowed: readonly S[]): S | undefined {
  const v = url.searchParams.get(key);
  if (v === null) return undefined;
  if (!(allowed as readonly string[]).includes(v)) {
    throw `${key} không hợp lệ — cho phép: ${allowed.join(', ')}`;
  }
  return v as S;
}

function parseNum(url: URL, key: string): number | undefined {
  const v = url.searchParams.get(key);
  if (v === null) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw `${key} phải là số`;
  return n;
}

/** topic_id bắt buộc ở mọi endpoint trừ /meta /topics /quota; 404 khi topic
 *  không tồn tại. Trả về topic_id đã kiểm. */
function requireTopic(url: URL, spy: SpyService): string {
  const topicId = url.searchParams.get('topic_id');
  if (!topicId) throw 'topic_id bắt buộc';
  if (!spy.store.getTopic(topicId)) throw `TOPIC_NOT_FOUND:${topicId}`;
  return topicId;
}

// ── CSV (§1: mọi endpoint dạng danh sách nhận format=csv) ───────────────────

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') return `"${JSON.stringify(v).replace(/"/g, '""')}"`;
  let s = String(v);
  // Chặn formula injection: ô bắt đầu = + - @ được Excel/Sheets parse
  // thành công thức → tiền tố ' ép thành text (review L1).
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const keys = Object.keys(rows[0]!);
  const lines = [keys.join(',')];
  for (const r of rows) lines.push(keys.map((k) => csvCell(r[k])).join(','));
  return `${lines.join('\n')}\n`;
}

function maybeCsv(
  url: URL,
  rows: Record<string, unknown>[],
  name: string,
): Response | null {
  if (url.searchParams.get('format') !== 'csv') return null;
  return new Response(toCsv(rows), {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}

// ── Envelope ────────────────────────────────────────────────────────────────

interface MetaExtra {
  total?: number;
  limit?: number;
  offset?: number;
  range?: DashRange;
  summary?: unknown;
}

function envelope(
  data: unknown,
  topicId: string | undefined,
  extra: MetaExtra = {},
): Response {
  return json({
    data,
    meta: {
      ...(topicId ? { topic_id: topicId } : {}),
      as_of: new Date().toISOString(),
      ...(extra.total !== undefined ? { total: extra.total } : {}),
      ...(extra.limit !== undefined ? { limit: extra.limit } : {}),
      ...(extra.offset !== undefined ? { offset: extra.offset } : {}),
      ...(extra.range ? { from: extra.range.from, to: extra.range.to } : {}),
      ...(extra.summary ? { summary: extra.summary } : {}),
    },
  });
}

// ── Whitelist sort/enum theo endpoint (§3) ──────────────────────────────────

const CHANNEL_SORTS = [
  'baseline_median_views', 'subscriber_count', 'last_published_at',
  'views_gained_7d', 'outliers_28d', 'first_seen_at',
] as const;
const KEYWORD_SORTS = [
  'last_median_views', 'last_n_followed', 'last_checked_at', 'added_at',
] as const;
const VIDEO_SORTS = [
  'views_gained_24h', 'outlier_score', 'latest_views', 'published_at', 'first_seen_at',
] as const;
const CHANNEL_STATUSES = ['new', 'active', 'paused', 'rejected', 'own'] as const;
const KEYWORD_STATUSES = ['pending', 'active', 'paused', 'rejected'] as const;
const KEYWORD_ORIGINS = ['seed', 'title_ngram', 'outlier_title', 'user'] as const;
const TICK_MODES = ['setup', 'daily', 'weekly'] as const;
const DECISION_ACTORS = ['human', 'loop'] as const;
const ENTITY_TYPES = ['channel', 'keyword'] as const;
const OUTLIER_SCOPES = ['followed', 'external', 'all'] as const;
const METRICS = [
  'views_gained', 'new_videos', 'outliers', 'new_channels', 'approvals',
  'search_calls', 'general_units',
] as const;
const GROUP_BYS = ['day', 'week'] as const;

// ── Dispatcher chính — http.ts mount: pathname.startsWith('/api/spy/dash') ──

export function handleSpyDash(url: URL, spy: SpyService): Response {
  const db = spy.store.rawDb;
  const path = url.pathname.replace(/^\/api\/spy\/dash\/?/, '');
  try {
    // 1 /meta — không cần topic.
    if (path === 'meta') {
      return envelope(dashMeta(db), undefined);
    }

    // 2 /topics — không cần topic.
    if (path === 'topics') {
      const rows = dashTopics(db);
      return maybeCsv(url, rows as unknown as Record<string, unknown>[], 'topics')
        ?? envelope(rows, undefined);
    }

    // 16b /quota — sổ toàn cục, không cần topic.
    if (path === 'quota') {
      const range = parseRange(url);
      const bucket = url.searchParams.get('bucket') ?? undefined;
      const rows = dashQuota(db, { ...range, bucket });
      return maybeCsv(url, rows as unknown as Record<string, unknown>[], 'quota')
        ?? envelope(rows, undefined, { range });
    }

    // 3 /overview?topic_id&date
    if (path === 'overview') {
      const topicId = requireTopic(url, spy);
      const date = url.searchParams.get('date') ?? undefined;
      if (date !== undefined && !DAY_RE.test(date)) throw 'date phải là YYYY-MM-DD';
      return envelope(activity.overview(db, topicId, { date }), topicId);
    }

    // 4 /channels?topic_id&status&discovered_via&q&sort&order&limit&offset&format
    if (path === 'channels') {
      const topicId = requireTopic(url, spy);
      const { limit, offset } = parsePage(url);
      const params: DashChannelsParams = {
        limit,
        offset,
        sort: parseSort<DashChannelSort>(url, CHANNEL_SORTS, 'first_seen_at'),
        order: parseOrder(url),
        status: parseEnum(url, 'status', CHANNEL_STATUSES),
        discoveredVia: url.searchParams.get('discovered_via') ?? undefined,
        q: url.searchParams.get('q') ?? undefined,
      };
      const { rows, total } = dashChannels(db, topicId, params);
      return maybeCsv(url, rows as unknown as Record<string, unknown>[], 'channels')
        ?? envelope(rows, topicId, { total, limit, offset });
    }

    // 5 /channels/:id?topic_id
    const channelDetail = path.match(/^channels\/([^/]+)$/);
    if (channelDetail) {
      const topicId = requireTopic(url, spy);
      const detail = dashChannelDetail(db, topicId, decodeURIComponent(channelDetail[1]!));
      if (!detail) return err('Channel không thuộc topic', 404);
      return envelope(detail, topicId);
    }

    // 6 /channels/:id/timeseries?topic_id&from&to
    const channelTs = path.match(/^channels\/([^/]+)\/timeseries$/);
    if (channelTs) {
      const topicId = requireTopic(url, spy);
      const range = parseRange(url);
      const rows = activity.channelTimeseries(db, topicId, decodeURIComponent(channelTs[1]!), range);
      if (rows === null) return err('Channel không thuộc topic', 404);
      return maybeCsv(url, rows as unknown as Record<string, unknown>[], 'channel-timeseries')
        ?? envelope(rows, topicId, { range });
    }

    // 7 /keywords?topic_id&status&origin&q&sort&order&limit&offset&format
    if (path === 'keywords') {
      const topicId = requireTopic(url, spy);
      const { limit, offset } = parsePage(url);
      const params: DashKeywordsParams = {
        limit,
        offset,
        sort: parseSort<DashKeywordSort>(url, KEYWORD_SORTS, 'added_at'),
        order: parseOrder(url),
        status: parseEnum(url, 'status', KEYWORD_STATUSES),
        origin: parseEnum(url, 'origin', KEYWORD_ORIGINS),
        q: url.searchParams.get('q') ?? undefined,
      };
      const { rows, total } = dashKeywords(db, topicId, params);
      return maybeCsv(url, rows as unknown as Record<string, unknown>[], 'keywords')
        ?? envelope(rows, topicId, { total, limit, offset });
    }

    // 8 /videos?topic_id&channel_id&source&keyword&published_after&min_outlier&min_duration&sort&order&limit&offset&format
    if (path === 'videos') {
      const topicId = requireTopic(url, spy);
      const { limit, offset } = parsePage(url);
      const publishedAfter = url.searchParams.get('published_after') ?? undefined;
      if (publishedAfter !== undefined && !DAY_RE.test(publishedAfter)) {
        throw 'published_after phải là YYYY-MM-DD';
      }
      const params: DashVideosParams = {
        limit,
        offset,
        sort: parseSort<DashVideoSort>(url, VIDEO_SORTS, 'latest_views'),
        order: parseOrder(url),
        channelId: url.searchParams.get('channel_id') ?? undefined,
        source: url.searchParams.get('source') ?? undefined,
        keyword: url.searchParams.get('keyword') ?? undefined,
        publishedAfter,
        minOutlier: parseNum(url, 'min_outlier'),
        minDuration: parseNum(url, 'min_duration'),
      };
      const { rows, total } = activity.videosList(db, topicId, params);
      return maybeCsv(url, rows as unknown as Record<string, unknown>[], 'videos')
        ?? envelope(rows, topicId, { total, limit, offset });
    }

    // 9 /videos/:id/timeseries?topic_id
    const videoTs = path.match(/^videos\/([^/]+)\/timeseries$/);
    if (videoTs) {
      const topicId = requireTopic(url, spy);
      const rows = activity.videoTimeseries(db, topicId, decodeURIComponent(videoTs[1]!));
      if (rows === null) return err('Video không thuộc topic', 404);
      return maybeCsv(url, rows as unknown as Record<string, unknown>[], 'video-timeseries')
        ?? envelope(rows, topicId);
    }

    // 10 /hot?topic_id&date&limit&exclude_launch
    if (path === 'hot') {
      const topicId = requireTopic(url, spy);
      const date = url.searchParams.get('date') ?? undefined;
      if (date !== undefined && !DAY_RE.test(date)) throw 'date phải là YYYY-MM-DD';
      const rawLimit = url.searchParams.get('limit');
      const limit = rawLimit === null ? 10 : Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw 'limit 1..500';
      const excludeLaunch = url.searchParams.get('exclude_launch') === 'true';
      const rows = activity.hotBoard(db, topicId, { date, limit, excludeLaunch });
      return maybeCsv(url, rows as unknown as Record<string, unknown>[], 'hot')
        ?? envelope(rows, topicId);
    }

    // 11 /outliers?topic_id&from&to&scope&min_multiple&limit&offset
    if (path === 'outliers') {
      const topicId = requireTopic(url, spy);
      // published_at là mốc thời gian thật (không phải quota_day) — cận trên
      // phải là todayDayUtc(), không phải todayDay() (xem comment ở khai
      // báo todayDayUtc). Cùng lỗi lớp M1, khác cột.
      const to = url.searchParams.get('to') ?? todayDayUtc();
      const from = url.searchParams.get('from') ?? shiftDay(to, -6);
      if (!DAY_RE.test(from) || !DAY_RE.test(to) || from > to) {
        throw 'from/to không hợp lệ';
      }
      const { limit, offset } = parsePage(url);
      const settings = dashTopicSettings(db, topicId);
      const params: DashOutliersParams = {
        limit,
        offset,
        range: { from, to },
        scope: parseEnum<DashOutlierScope>(url, 'scope', OUTLIER_SCOPES) ?? 'all',
        minMultiple: parseNum(url, 'min_multiple') ?? settings.outlierMultiple,
      };
      const rows = activity.outliers(db, topicId, params);
      return maybeCsv(url, rows as unknown as Record<string, unknown>[], 'outliers')
        ?? envelope(rows, topicId, { range: params.range, limit, offset });
    }

    // 12 /timeseries?topic_id&metric&from&to&group_by
    if (path === 'timeseries') {
      const topicId = requireTopic(url, spy);
      const range = parseRange(url);
      const metric = url.searchParams.get('metric');
      if (!metric) throw 'metric bắt buộc';
      if (!(METRICS as readonly string[]).includes(metric)) {
        throw `metric không hợp lệ — cho phép: ${METRICS.join(', ')}`;
      }
      const groupBy = parseEnum<DashGroupBy>(url, 'group_by', GROUP_BYS) ?? 'day';
      const rows = activity.timeseries(db, topicId, {
        metric: metric as DashMetric, range, groupBy,
      });
      return maybeCsv(url, rows as unknown as Record<string, unknown>[], 'timeseries')
        ?? envelope(rows, topicId, { range });
    }

    // 13 /inbox?topic_id
    if (path === 'inbox') {
      const topicId = requireTopic(url, spy);
      return envelope(dashInbox(db, topicId), topicId);
    }

    // 14 /decisions?topic_id&actor&entity_type&entity_id&from&to&limit&offset&format
    if (path === 'decisions') {
      const topicId = requireTopic(url, spy);
      const range = parseRange(url);
      const { limit, offset } = parsePage(url);
      const params: DashDecisionsParams = {
        ...range,
        limit,
        offset,
        actor: parseEnum(url, 'actor', DECISION_ACTORS),
        entityType: parseEnum(url, 'entity_type', ENTITY_TYPES),
        entityId: url.searchParams.get('entity_id') ?? undefined,
      };
      const { rows, total, summary } = dashDecisions(db, topicId, params);
      return maybeCsv(url, rows as unknown as Record<string, unknown>[], 'decisions')
        ?? envelope(rows, topicId, { total, limit, offset, range, summary });
    }

    // 15 /ticks?topic_id&mode&from&to&limit&offset&format
    if (path === 'ticks') {
      const topicId = requireTopic(url, spy);
      const range = parseRange(url);
      const { limit, offset } = parsePage(url);
      const params: DashTicksParams = {
        ...range,
        limit,
        offset,
        mode: parseEnum(url, 'mode', TICK_MODES),
      };
      const { rows, total } = dashTicks(db, topicId, params);
      return maybeCsv(url, rows as unknown as Record<string, unknown>[], 'ticks')
        ?? envelope(rows, topicId, { total, limit, offset, range });
    }

    // 16a /reports?topic_id&mode&date&limit&offset&format
    if (path === 'reports') {
      const topicId = requireTopic(url, spy);
      const { limit, offset } = parsePage(url);
      const date = url.searchParams.get('date') ?? undefined;
      if (date !== undefined && !DAY_RE.test(date)) throw 'date phải là YYYY-MM-DD';
      const params: DashReportsParams = {
        limit,
        offset,
        mode: parseEnum(url, 'mode', TICK_MODES),
        date,
      };
      const { rows, total } = dashReports(db, topicId, params);
      return maybeCsv(url, rows as unknown as Record<string, unknown>[], 'reports')
        ?? envelope(rows, topicId, { total, limit, offset });
    }

    return err('Endpoint không tồn tại', 404);
  } catch (e) {
    if (typeof e === 'string') {
      if (e.startsWith('TOPIC_NOT_FOUND:')) {
        return err(`Topic không tồn tại: ${e.slice('TOPIC_NOT_FOUND:'.length)}`, 404);
      }
      return err(e, 400);
    }
    throw e;
  }
}
