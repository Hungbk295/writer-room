/**
 * board/metrics.ts — định nghĩa chỉ số của Board, MỘT chỗ duy nhất
 * (docs/plans/spy-analyst-workflow.md §B4). Board (HTTP) và agent (MCP) đều đi
 * qua queries.ts → các hàm thuần ở đây, nên luôn ra cùng một số.
 *
 * Hàm thuần: không đọc DB, không đọc đồng hồ (caller truyền nowMs).
 */
import { median } from '../metrics/stats.ts';

/** ✅ tin cậy | ⚠️ mẫu mỏng | 🆕 kênh quá mới — so với sàn ngách. */
export type BaselineTier = 'reliable' | 'thin' | 'niche';

export interface BoardSettings {
  /** outlier_x tối thiểu. */
  outlierMultiple: number;
  /** Video ngắn hơn không tính (loại Shorts). */
  minDurationSec: number;
  /** Số video khác mới nhất lấy median. */
  baselineWindow: number;
  /** ≥ ngưỡng này video khác → ✅. */
  reliableMinN: number;
  /** ≥ ngưỡng này (và < reliableMinN) → ⚠️; ít hơn → 🆕 so với ngách. */
  thinMinN: number;
  /** Median dưới ngưỡng (khi có ≥ thinMinN video khác) → kênh chết. */
  deadMedian: number;
  /** Video trẻ hơn → "đang lên", không chấm outlier. */
  risingDays: number;
  /** subs < ngưỡng → kênh nhỏ. */
  smallSubs: number;
  /** Cửa sổ đếm độ lặp. */
  repeatWindowDays: number;
  /** Luật dừng: số kênh nhỏ đã đo tối thiểu mỗi ngách. */
  stopMinSmallChannels: number;
}

export const DEFAULT_BOARD_SETTINGS: BoardSettings = {
  outlierMultiple: 3,
  minDurationSec: 300,
  baselineWindow: 30,
  reliableMinN: 10,
  thinMinN: 3,
  deadMedian: 500,
  risingDays: 7,
  smallSubs: 10_000,
  repeatWindowDays: 28,
  stopMinSmallChannels: 20,
};

const DAY_MS = 86_400_000;

export interface BoardVideoInput {
  videoId: string;
  views: number | null;
  durationSec: number | null;
  publishedAt: string | null;
}

export function isLongVideo(v: Pick<BoardVideoInput, 'durationSec'>, settings: BoardSettings): boolean {
  return (v.durationSec ?? 0) >= settings.minDurationSec;
}

export function ageDays(publishedAt: string | null, nowMs: number): number | null {
  if (!publishedAt) return null;
  const t = Date.parse(publishedAt);
  return Number.isFinite(t) ? Math.max(0, (nowMs - t) / DAY_MS) : null;
}

export interface ChannelBaseline {
  /** null = < thinMinN video khác → caller so với sàn ngách (🆕). */
  tier: Exclude<BaselineTier, 'niche'> | null;
  medianViews: number | null;
  /** Số video dài KHÁC dùng để tính. */
  n: number;
  dead: boolean;
}

/**
 * Mức thường của kênh cho MỘT video: median views các video dài KHÁC của kênh
 * (bỏ chính video đang xét — quan trọng khi kênh ít video), tối đa
 * baselineWindow video mới nhất.
 */
export function channelBaselineFor(
  videoId: string | null,
  channelVideos: readonly BoardVideoInput[],
  settings: BoardSettings,
): ChannelBaseline {
  const others = channelVideos
    .filter((v) => v.videoId !== videoId && v.views !== null && isLongVideo(v, settings))
    .sort((a, b) => String(b.publishedAt ?? '').localeCompare(String(a.publishedAt ?? '')))
    .slice(0, settings.baselineWindow)
    .map((v) => v.views as number);
  const n = others.length;
  if (n < settings.thinMinN) return { tier: null, medianViews: n ? median(others) : null, n, dead: false };
  const med = median(others);
  return {
    tier: n >= settings.reliableMinN ? 'reliable' : 'thin',
    medianViews: med,
    n,
    dead: med < settings.deadMedian,
  };
}

export interface VideoScore {
  tier: BaselineTier | null;
  /** Mức thường đã dùng để chia (của kênh hoặc sàn ngách). */
  baselineViews: number | null;
  /** Cỡ mẫu của mức thường: số video khác của kênh (tier niche: số video của ngách). */
  baselineN: number;
  outlierX: number | null;
  isOutlier: boolean;
  isRising: boolean;
  dead: boolean;
  ageDays: number | null;
}

/**
 * Chấm một video dài. Video < risingDays tuổi → "đang lên" (không outlier).
 * Kênh < thinMinN video khác → so với sàn ngách (🆕); không có sàn → không chấm.
 */
export function scoreVideo(
  video: BoardVideoInput,
  channelVideos: readonly BoardVideoInput[],
  niche: { floorViews: number | null; nVideos: number },
  settings: BoardSettings,
  nowMs: number,
): VideoScore {
  const age = ageDays(video.publishedAt, nowMs);
  const isRising = age !== null && age < settings.risingDays;
  const empty: VideoScore = {
    tier: null, baselineViews: null, baselineN: 0, outlierX: null,
    isOutlier: false, isRising, dead: false, ageDays: age,
  };
  if (!isLongVideo(video, settings) || video.views === null) return empty;

  const ch = channelBaselineFor(video.videoId, channelVideos, settings);
  let tier: BaselineTier | null = ch.tier;
  let base = ch.medianViews;
  let baseN = ch.n;
  if (tier === null) {
    tier = niche.floorViews !== null ? 'niche' : null;
    base = niche.floorViews;
    baseN = niche.nVideos;
  }
  if (tier === null || base === null || base <= 0) return { ...empty, dead: ch.dead };

  const outlierX = Math.round((video.views / base) * 100) / 100;
  return {
    tier,
    baselineViews: base,
    baselineN: baseN,
    outlierX,
    isOutlier: !isRising && !ch.dead && outlierX >= settings.outlierMultiple,
    isRising,
    dead: ch.dead,
    ageDays: age,
  };
}

export interface NicheFloor {
  floorViews: number | null;
  nChannels: number;
  nVideos: number;
}

/**
 * Sàn view kênh nhỏ của ngách: median views video dài, đã qua risingDays (video
 * non chưa kịp lên view sẽ kéo sàn xuống oan), của kênh nhỏ, CHỈ video quét
 * uploads (baselineEligible) — search xếp theo views nên thiên về video thắng.
 */
export function nicheFloor(
  videos: ReadonlyArray<BoardVideoInput & { channelId: string; baselineEligible: boolean }>,
  smallChannelIds: ReadonlySet<string>,
  settings: BoardSettings,
  nowMs: number,
): NicheFloor {
  const picked = videos.filter((v) => {
    if (!v.baselineEligible || v.views === null || !smallChannelIds.has(v.channelId)) return false;
    if (!isLongVideo(v, settings)) return false;
    const age = ageDays(v.publishedAt, nowMs);
    return age === null || age >= settings.risingDays;
  });
  return {
    floorViews: picked.length ? median(picked.map((v) => v.views as number)) : null,
    nChannels: new Set(picked.map((v) => v.channelId)).size,
    nVideos: picked.length,
  };
}

export interface RepeatCount {
  total: number;
  reliable: number;
  thin: number;
  niche: number;
}

/**
 * Độ lặp: số kênh nhỏ KHÁC NHAU có ≥ 1 outlier đăng trong repeatWindowDays.
 * Mỗi kênh đếm một lần theo nhãn mạnh nhất (✅ > ⚠️ > 🆕).
 */
export function repeatSmall(
  scored: ReadonlyArray<{ channelId: string; publishedAt: string | null; score: VideoScore }>,
  smallChannelIds: ReadonlySet<string>,
  settings: BoardSettings,
  nowMs: number,
): RepeatCount {
  const rank: Record<BaselineTier, number> = { reliable: 3, thin: 2, niche: 1 };
  const best = new Map<string, BaselineTier>();
  for (const s of scored) {
    if (!s.score.isOutlier || !s.score.tier || !smallChannelIds.has(s.channelId)) continue;
    const age = ageDays(s.publishedAt, nowMs);
    if (age === null || age > settings.repeatWindowDays) continue;
    const prev = best.get(s.channelId);
    if (!prev || rank[s.score.tier] > rank[prev]) best.set(s.channelId, s.score.tier);
  }
  const out: RepeatCount = { total: best.size, reliable: 0, thin: 0, niche: 0 };
  for (const tier of best.values()) out[tier]++;
  return out;
}

export function isSmallChannel(subs: number | null | undefined, settings: BoardSettings): boolean {
  return subs !== null && subs !== undefined && subs < settings.smallSubs;
}

/** Bảng định nghĩa cho spy_board_metrics / tooltip board. */
export function metricDefinitions(settings: BoardSettings): Array<{ name: string; definition: string }> {
  return [
    { name: 'baseline', definition: `Mức thường của kênh: median views các video dài (≥ ${settings.minDurationSec}s) KHÁC của kênh, tối đa ${settings.baselineWindow} video mới nhất. ≥ ${settings.reliableMinN} video → reliable (✅); ${settings.thinMinN}–${settings.reliableMinN - 1} → thin (⚠️); < ${settings.thinMinN} → so với sàn ngách (niche, 🆕).` },
    { name: 'outlier_x', definition: 'views ÷ mức thường (theo tier).' },
    { name: 'is_outlier', definition: `outlier_x ≥ ${settings.outlierMultiple} và video ≥ ${settings.risingDays} ngày tuổi và kênh không chết.` },
    { name: 'dead', definition: `Kênh có ≥ ${settings.thinMinN} video khác và median < ${settings.deadMedian} views.` },
    { name: 'is_rising', definition: `Video < ${settings.risingDays} ngày tuổi; xếp theo views tăng 24h.` },
    { name: 'small_channel', definition: `subs < ${settings.smallSubs}.` },
    { name: 'floor_small', definition: `Sàn view kênh nhỏ: median views video dài ≥ ${settings.risingDays} ngày tuổi của kênh nhỏ trong ngách, chỉ video lấy từ lượt quét uploads. Tiêu chí thắng.` },
    { name: 'repeat_small', definition: `Số kênh nhỏ khác nhau có ≥ 1 outlier đăng trong ${settings.repeatWindowDays} ngày, tách theo tier. Gợi ý ≥ 3.` },
    { name: 'stop_rule', definition: `Ngách đủ tin cậy khi ≥ ${settings.stopMinSmallChannels} kênh nhỏ đã đo và thứ hạng sàn view không đổi 2 tuần liên tiếp.` },
    { name: 'new_rate', definition: 'Tỉ lệ mới của keyword: kết quả chưa từng có trong kho ÷ tổng kết quả, lần search gần nhất.' },
  ];
}
