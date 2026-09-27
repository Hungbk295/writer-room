/**
 * loop/metrics.ts — hàm THUẦN của pipeline v3-lean (plan §3).
 *
 * Không I/O, không import store/API — mọi ngưỡng đều đến từ `TopicSettings`
 * của topic (settings_json merge với DEFAULT_TOPIC_SETTINGS), nên hai topic
 * khác market có thể dùng hai bộ ngưỡng khác nhau trên cùng một binary (ADR-7).
 */
import { median } from '../metrics/stats.ts';
import { normalizeTermKey } from '../topic.ts';
// Type-only — TopicSettings sống ở store.ts (Devin A). Không kéo runtime dep
// vào file thuần này.
import type { TopicSettings } from '../store.ts';

// ---------------------------------------------------------------------------
// baselineOf — sàn median views của một kênh
// ---------------------------------------------------------------------------

export interface BaselineVideoInput {
  views: number | null;
  durationSec?: number | null;
  publishedAt?: string | null;
}

export interface BaselineResult {
  medianViews: number | null;
  /** Số video hợp lệ trong cửa sổ baseline. */
  n: number;
  maxViews: number | null;
  /** n >= baselineMinN — mẫu đủ dày mới được dùng làm mẫu. */
  reliable: boolean;
  /** reliable && median < deadMedian — kênh chết, không đề xuất (L7). */
  dead: boolean;
  /** reliable && max/median > lotteryRatio — kênh xổ số, không đề xuất (L7). */
  lottery: boolean;
}

function publishedKey(publishedAt: string | null | undefined): number {
  const t = publishedAt ? Date.parse(publishedAt) : Number.NaN;
  // Video thiếu ngày đăng xếp cuối — baseline thiên về video "mới nhất".
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

/**
 * Sàn baseline của kênh: chỉ video dài >= `minDurationSec` (lọc Shorts),
 * lấy tối đa `baselineWindow` video MỚI NHẤT, rồi lấy median views.
 *
 * `reliable=false` nghĩa là mẫu quá mỏng — caller KHÔNG được kết luận
 * dead/lottery hay tính outlier từ baseline này (vẫn ghi median/n để hiển thị).
 */
export function baselineOf(
  videos: readonly BaselineVideoInput[],
  settings: Pick<
    TopicSettings,
    'minDurationSec' | 'baselineWindow' | 'baselineMinN' | 'deadMedian' | 'lotteryRatio'
  >,
): BaselineResult {
  const eligible = videos
    .filter((v) => v.views !== null && Number.isFinite(v.views))
    .filter((v) => (v.durationSec ?? 0) >= settings.minDurationSec)
    .sort((a, b) => publishedKey(b.publishedAt) - publishedKey(a.publishedAt))
    .slice(0, Math.max(0, settings.baselineWindow));

  const views = eligible.map((v) => v.views as number);
  const n = views.length;
  const medianViews = n > 0 ? median(views) : null;
  const maxViews = n > 0 ? Math.max(...views) : null;
  const reliable = n >= settings.baselineMinN;
  const dead = reliable && medianViews !== null && medianViews < settings.deadMedian;
  // median=0 thì tỷ lệ vô nghĩa — kênh đó đã là dead, không cần cờ lottery.
  const lottery =
    reliable &&
    medianViews !== null &&
    medianViews > 0 &&
    maxViews !== null &&
    maxViews / medianViews > settings.lotteryRatio;

  return { medianViews, n, maxViews, reliable, dead, lottery };
}

// ---------------------------------------------------------------------------
// outlierScore — views / baseline_median
// ---------------------------------------------------------------------------

/**
 * Bội số so với sàn kênh. NULL khi baseline chưa tin cậy — một con số không có
 * mẫu đứng sau thì không được phép xuất hiện trong báo cáo như "outlier".
 */
export function outlierScore(
  views: number | null | undefined,
  baseline: Pick<BaselineResult, 'medianViews' | 'reliable'>,
): number | null {
  if (views === null || views === undefined || !Number.isFinite(views)) return null;
  const base = baseline.medianViews;
  if (!baseline.reliable || base === null || base <= 0) return null;
  return Math.round((views / base) * 100) / 100;
}

// ---------------------------------------------------------------------------
// viewsGained24h — tốc độ view tăng, chuẩn hoá theo khoảng ngày đo
// ---------------------------------------------------------------------------

/**
 * Snapshot của `video_daily_views` (day 'YYYY-MM-DD'). `listVideoDailyViews`
 * trả DESC theo day, nhưng hàm này tự sort phòng caller truyền thứ tự khác.
 *
 * NULL khi <2 snapshot — một điểm đo không nói được tốc độ (acceptance §6.3:
 * video mới chỉ có 1 snapshot thì views_gained_24h phải là NULL).
 *
 * Chuẩn hoá theo số ngày giữa 2 snapshot gần nhất: bỏ lỡ một ngày quét không
 * được làm con số phình gấp đôi. Ngày trùng/lộn thì kẹp tối thiểu 1 ngày.
 */
export function viewsGained24h(
  snapshots: readonly { day: string; views: number }[],
): number | null {
  const valid = snapshots
    .filter((s) => Number.isFinite(s.views) && Number.isFinite(Date.parse(s.day)))
    .toSorted((a, b) => Date.parse(b.day) - Date.parse(a.day));
  if (valid.length < 2) return null;

  const latest = valid[0]!;
  const prev = valid[1]!;
  const days = Math.max(
    1,
    Math.round((Date.parse(latest.day) - Date.parse(prev.day)) / 86_400_000),
  );
  return Math.round((latest.views - prev.views) / days);
}

// ---------------------------------------------------------------------------
// harvestNgrams — từ khoá mọc lên từ title video, không phải từ khung đề tài
// ---------------------------------------------------------------------------

/**
 * Từ chức năng vi+en phổ biến — mặc định của riêng n-gram harvest vì nó phục
 * vụ sinh keyword, không phải scoring title (stopword của title.ts nằm kín
 * trong module đó và có mục đích khác). Caller truyền thêm qua `stopwords`.
 */
const DEFAULT_NGRAM_STOPWORDS: readonly string[] = [
  // en
  'the', 'a', 'an', 'of', 'to', 'in', 'for', 'on', 'with', 'and', 'or', 'is',
  'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had', 'do', 'does', 'did',
  'how', 'why', 'what', 'you', 'your', 'my', 'i', 'we', 'it', 'this', 'that',
  'at', 'by', 'from', 'as', 'but', 'not', 'no', 'so', 'if', 'than', 'then',
  // vi
  'và', 'của', 'là', 'có', 'cho', 'với', 'để', 'trong', 'không', 'những',
  'người', 'được', 'này', 'khi', 'như', 'một', 'các', 'sẽ', 'nếu', 'thì',
  'mà', 'về', 'đã', 'còn', 'cũng', 'từ', 'bị', 'theo', 'hay', 'hoặc', 'vì',
];

export interface NgramHit {
  /** Khoá duy nhất: lowercase, bỏ dấu — dùng làm term_key của topic_keywords. */
  termKey: string;
  /** Dạng hiển thị hay gặp nhất (giữ case gốc từ title). */
  display: string;
  /** Số nhóm (kênh) khác nhau chứa cụm này. */
  nChannels: number;
  /** Số video chứa cụm này (đếm trên toàn bộ input). */
  nVideos: number;
  sampleVideoIds: string[];
}

/**
 * Tách n-gram 2–3 từ từ title, đếm theo NHÓM (kênh) — một cụm lặp 10 lần trong
 * cùng một kênh vẫn chỉ tính 1 nhóm, vì keyword đáng học phải là pattern của
 * NICHE chứ không phải tics của một kênh (plan S3: n-gram xuất hiện ở
 * ≥ngram_min_channels kênh).
 *
 * `titlesByChannel`: Map khoá-nhóm → danh sách video. Với weekly W4 ("n-gram
 * chung của ≥2 video outlier"), caller key mỗi video một nhóm (khoá = videoId)
 * để nChannels = số video chứa cụm.
 *
 * termKey normalize qua cùng `normalizeTermKey` của keyword pipeline nên cụm
 * 'Lãi Kép' và 'lãi kép' gộp một ô.
 */
export function harvestNgrams(
  titlesByChannel: ReadonlyMap<string, ReadonlyArray<{ videoId: string; title: string }>>,
  minChannels: number,
  stopwords: readonly string[] = [],
): NgramHit[] {
  const stop = new Set(DEFAULT_NGRAM_STOPWORDS);
  for (const w of stopwords) {
    const k = w.trim().toLowerCase();
    if (k) stop.add(k);
  }

  interface TermAcc {
    groups: Set<string>;
    videoIds: Set<string>;
    displayCounts: Map<string, number>;
  }
  const terms = new Map<string, TermAcc>();

  for (const [group, videos] of titlesByChannel) {
    for (const video of videos) {
      const tokens = video.title
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length > 0 && !stop.has(t.toLowerCase()));
      const seenInVideo = new Set<string>();
      for (let n = 2; n <= 3; n++) {
        for (let i = 0; i + n <= tokens.length; i++) {
          const display = tokens.slice(i, i + n).join(' ');
          const termKey = normalizeTermKey(display);
          if (!termKey || seenInVideo.has(termKey)) continue;
          seenInVideo.add(termKey);
          let acc = terms.get(termKey);
          if (!acc) {
            acc = { groups: new Set(), videoIds: new Set(), displayCounts: new Map() };
            terms.set(termKey, acc);
          }
          acc.groups.add(group);
          acc.videoIds.add(video.videoId);
          acc.displayCounts.set(display, (acc.displayCounts.get(display) ?? 0) + 1);
        }
      }
    }
  }

  return [...terms.entries()]
    .filter(([, acc]) => acc.groups.size >= minChannels)
    .map(([termKey, acc]) => {
      let display = termKey;
      let best = -1;
      for (const [form, count] of acc.displayCounts) {
        if (count > best) {
          best = count;
          display = form;
        }
      }
      return {
        termKey,
        display,
        nChannels: acc.groups.size,
        nVideos: acc.videoIds.size,
        sampleVideoIds: [...acc.videoIds].slice(0, 5),
      };
    })
    .sort(
      (a, b) =>
        b.nChannels - a.nChannels ||
        b.nVideos - a.nVideos ||
        a.termKey.localeCompare(b.termKey),
    );
}
