/**
 * learn-value.ts — Chấm "đáng học" (learn_value_score 0–100) cho kênh ứng viên.
 *
 * Hoàn toàn xác định (deterministic), 0 quota sau enrich, chỉ đọc số từ DB/API.
 *
 * §4 plan — 4 factor:
 *   outperformBaseline (40): median view/video so với kênh baseline trong topic
 *   momentum          (25): upload 90 ngày gần nhất có view/ngày cao hơn median cả kênh
 *   growthRate        (20): sub / tuổi kênh (tháng)
 *   cadence           (15): nhịp đăng đều
 *
 * Khi thiếu mẫu (< 3 video): trả method='insufficient_sample'.
 */
import type { LearnValueResult, LearnValueReason } from './loop/types.ts';

export interface CandidateMetrics {
  /** Video stats: mảng {viewCount, publishedAt} từ ≤12 video mới nhất. */
  videos: Array<{ viewCount: number | null; publishedAt: string | null }>;
  subscriberCount: number | null;
  /** Ngày tạo kênh (snippet.publishedAt). */
  channelCreatedAt: string | null;
}

export interface OwnBaseline {
  /** Median view/video của kênh của mình trong topic. Null khi chưa có số liệu. */
  medianViews: number | null;
}

export interface CohortBaseline {
  /** Median view/video trong dải sub tương đương. */
  medianViews: number | null;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

export function scoreLearnValue(
  candidate: CandidateMetrics,
  ownBaseline: OwnBaseline,
  cohort: CohortBaseline,
): LearnValueResult {
  const validVideos = candidate.videos.filter((v) => v.viewCount !== null && v.viewCount >= 0);

  if (validVideos.length < 3) {
    return {
      score: null,
      reasons: [],
      method: 'insufficient_sample',
      sampleSize: validVideos.length,
    };
  }

  const views = validVideos.map((v) => v.viewCount as number);
  const medViews = median(views);
  const reasons: LearnValueReason[] = [];
  let totalScore = 0;

  // --- Factor 1: Outperform baseline (40 pt) ---
  let outperformPoints = 0;
  let outperformDetail = '';
  let outperformMethod = 'no_baseline';
  const baseline = ownBaseline.medianViews ?? cohort.medianViews;
  if (baseline !== null && baseline > 0) {
    const ratio = medViews / baseline;
    outperformPoints = Math.min(40, 40 * Math.min(ratio / 3, 1));
    outperformDetail = `median ${Math.round(medViews).toLocaleString('en-US')} view (${round2(ratio)}× baseline ${Math.round(baseline).toLocaleString('en-US')})`;
    outperformMethod = ownBaseline.medianViews !== null ? 'own_baseline' : 'cohort_baseline';
  } else {
    outperformPoints = 10; // credit nhỏ khi chưa có baseline
    outperformDetail = `median ${Math.round(medViews).toLocaleString('en-US')} view (chưa có baseline)`;
    outperformMethod = 'no_baseline';
  }
  reasons.push({
    factor: 'outperformBaseline',
    points: round2(outperformPoints),
    max: 40,
    detail: outperformDetail,
    method: outperformMethod,
    sampleSize: validVideos.length,
  });
  totalScore += outperformPoints;

  // --- Factor 2: Momentum (25 pt) ---
  const now = Date.now();
  const recent90 = validVideos.filter((v) => {
    if (!v.publishedAt) return false;
    return now - Date.parse(v.publishedAt) <= 90 * 86_400_000;
  });
  let momentumPoints = 0;
  let momentumDetail = '';
  if (recent90.length >= 2) {
    const recentViews = recent90.map((v) => v.viewCount as number);
    const recentMedian = median(recentViews);
    const recentRatio = medViews > 0 ? recentMedian / medViews : 0;
    momentumPoints = Math.min(25, 25 * Math.min(recentRatio, 2) / 2);
    momentumDetail = `${recent90.length} video/90 ngày, median ${Math.round(recentMedian).toLocaleString('en-US')} (${round2(recentRatio)}× all-time)`;
  } else {
    momentumDetail = `ít hơn 2 video trong 90 ngày (${recent90.length})`;
  }
  reasons.push({
    factor: 'momentum',
    points: round2(momentumPoints),
    max: 25,
    detail: momentumDetail,
    method: 'trailing_90d',
    sampleSize: recent90.length,
  });
  totalScore += momentumPoints;

  // --- Factor 3: Growth rate — sub/tuổi kênh (20 pt) ---
  let growthPoints = 0;
  let growthDetail = 'thiếu dữ liệu sub hoặc ngày tạo';
  if (candidate.subscriberCount !== null && candidate.channelCreatedAt) {
    const ageMonths = Math.max(1, (now - Date.parse(candidate.channelCreatedAt)) / (30 * 86_400_000));
    const subPerMonth = candidate.subscriberCount / ageMonths;
    // 5k sub/tháng coi là tốt
    growthPoints = Math.min(20, 20 * Math.min(subPerMonth / 5000, 1));
    growthDetail = `${candidate.subscriberCount.toLocaleString('en-US')} sub / ${Math.round(ageMonths)} tháng = ${Math.round(subPerMonth).toLocaleString('en-US')} sub/tháng`;
  }
  reasons.push({
    factor: 'growthRate',
    points: round2(growthPoints),
    max: 20,
    detail: growthDetail,
    method: 'sub_per_month',
    sampleSize: candidate.channelCreatedAt ? 1 : null,
  });
  totalScore += growthPoints;

  // --- Factor 4: Cadence (15 pt) ---
  let cadencePoints = 0;
  let cadenceDetail = 'không đủ video có ngày đăng';
  const videosWithDate = validVideos.filter((v) => v.publishedAt).sort((a, b) =>
    Date.parse(b.publishedAt!) - Date.parse(a.publishedAt!),
  );
  if (videosWithDate.length >= 4) {
    const intervals: number[] = [];
    for (let i = 0; i < videosWithDate.length - 1; i++) {
      const diff = Math.abs(Date.parse(videosWithDate[i]!.publishedAt!) - Date.parse(videosWithDate[i + 1]!.publishedAt!));
      intervals.push(diff / 86_400_000);
    }
    const medInterval = median(intervals);
    const stdDev = Math.sqrt(intervals.reduce((s, d) => s + (d - medInterval) ** 2, 0) / intervals.length);
    const cv = medInterval > 0 ? stdDev / medInterval : 1; // coefficient of variation
    // Đều thì cv thấp → điểm cao
    cadencePoints = Math.min(15, 15 * Math.max(0, 1 - cv));
    cadenceDetail = `đăng cách ${round2(medInterval)} ngày, CV=${round2(cv)}`;
  }
  reasons.push({
    factor: 'cadence',
    points: round2(cadencePoints),
    max: 15,
    detail: cadenceDetail,
    method: 'interval_cv',
    sampleSize: videosWithDate.length,
  });
  totalScore += cadencePoints;

  return {
    score: round2(Math.max(0, Math.min(100, totalScore))),
    reasons,
    method: 'deterministic',
    sampleSize: validVideos.length,
  };
}
