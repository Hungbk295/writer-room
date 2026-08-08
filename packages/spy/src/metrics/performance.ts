import {
  deterministic,
  insufficientSample,
  MIN_VIDEOS_FOR_CORRELATION,
  MIN_VIDEOS_FOR_DISTRIBUTION,
  MIN_VIDEOS_PER_COHORT,
  unavailable,
  type MetricValue,
} from './gates.ts';
import {
  ageCohort,
  mad,
  median,
  outlierScore,
  percentile,
  velocity,
  type AgeCohort,
} from './stats.ts';

export interface PerformanceVideoInput {
  videoId?: string;
  viewCount: number;
  publishedAt: Date | string;
  likeCount?: number | null;
  commentCount?: number | null;
}

export interface PerformanceMetrics {
  sampleSize: number;
  viewMedian: MetricValue<number>;
  viewP25: MetricValue<number>;
  viewP75: MetricValue<number>;
  viewP90: MetricValue<number>;
  viewMAD: MetricValue<number>;
  velocityMedian: MetricValue<number>;
  viewPerSubMedian: MetricValue<number>;
  engagementRateMedian: MetricValue<number>;
}

export interface VideoOutlierResult {
  videoId?: string;
  viewCount: number;
  cohort: AgeCohort;
  outlierScore: MetricValue<number>;
  metricUsed: 'view' | 'velocity';
}

function hasEngagementData(videos: PerformanceVideoInput[]): boolean {
  return videos.every(
    (v) =>
      v.likeCount != null &&
      v.commentCount != null &&
      !Number.isNaN(v.likeCount) &&
      !Number.isNaN(v.commentCount),
  );
}

function engagementRate(video: PerformanceVideoInput): number {
  const likes = video.likeCount ?? 0;
  const comments = video.commentCount ?? 0;
  if (video.viewCount === 0) return 0;
  return (likes + comments) / video.viewCount;
}

function distributionGate<T>(values: number[], compute: (values: number[]) => T): MetricValue<T> {
  if (values.length < MIN_VIDEOS_FOR_DISTRIBUTION) {
    return insufficientSample(values.length, MIN_VIDEOS_FOR_DISTRIBUTION);
  }
  return deterministic(compute(values));
}

export function computePerformanceMetrics(
  videos: PerformanceVideoInput[],
  options: { subscriberCount?: number | null; referenceDate?: Date } = {},
): PerformanceMetrics {
  const { subscriberCount = null, referenceDate = new Date() } = options;
  const views = videos.map((v) => v.viewCount);
  const velocities = videos.map((v) => velocity(v.viewCount, v.publishedAt, referenceDate));

  const viewMedianMetric = distributionGate(views, median);
  const viewP25Metric = distributionGate(views, (vals) => percentile(vals, 25));
  const viewP75Metric = distributionGate(views, (vals) => percentile(vals, 75));
  const viewP90Metric = distributionGate(views, (vals) => percentile(vals, 90));
  const viewMADMetric = distributionGate(views, mad);
  const velocityMedianMetric = distributionGate(velocities, median);

  let viewPerSubMedian: MetricValue<number>;
  if (subscriberCount == null || subscriberCount <= 0) {
    viewPerSubMedian = unavailable('youtube_data_api_subscriber_count_missing');
  } else if (views.length < MIN_VIDEOS_FOR_DISTRIBUTION) {
    viewPerSubMedian = insufficientSample(views.length, MIN_VIDEOS_FOR_DISTRIBUTION);
  } else {
    viewPerSubMedian = deterministic(median(views.map((v) => v / subscriberCount)));
  }

  let engagementRateMedian: MetricValue<number>;
  if (!hasEngagementData(videos)) {
    engagementRateMedian = unavailable('youtube_data_api_engagement_fields_missing');
  } else if (videos.length < MIN_VIDEOS_FOR_DISTRIBUTION) {
    engagementRateMedian = insufficientSample(videos.length, MIN_VIDEOS_FOR_DISTRIBUTION);
  } else {
    engagementRateMedian = deterministic(median(videos.map(engagementRate)));
  }

  return {
    sampleSize: videos.length,
    viewMedian: viewMedianMetric,
    viewP25: viewP25Metric,
    viewP75: viewP75Metric,
    viewP90: viewP90Metric,
    viewMAD: viewMADMetric,
    velocityMedian: velocityMedianMetric,
    viewPerSubMedian,
    engagementRateMedian,
  };
}

export function computeVideoOutlierScores(
  videos: PerformanceVideoInput[],
  referenceDate: Date = new Date(),
): VideoOutlierResult[] {
  const byCohort = new Map<AgeCohort, PerformanceVideoInput[]>();
  for (const video of videos) {
    const cohort = ageCohort(video.publishedAt, referenceDate);
    const group = byCohort.get(cohort) ?? [];
    group.push(video);
    byCohort.set(cohort, group);
  }

  const results: VideoOutlierResult[] = [];

  for (const video of videos) {
    const cohort = ageCohort(video.publishedAt, referenceDate);
    const cohortVideos = byCohort.get(cohort) ?? [];

    if (cohortVideos.length < MIN_VIDEOS_PER_COHORT) {
      const velocities = cohortVideos.map((v) => velocity(v.viewCount, v.publishedAt, referenceDate));
      const velMedian = median(velocities);
      const velMad = mad(velocities);
      const videoVel = velocity(video.viewCount, video.publishedAt, referenceDate);
      results.push({
        videoId: video.videoId,
        viewCount: video.viewCount,
        cohort,
        metricUsed: 'velocity',
        outlierScore: deterministic(outlierScore(videoVel, velMedian, velMad)),
      });
      continue;
    }

    const cohortViews = cohortVideos.map((v) => v.viewCount);
    const viewMed = median(cohortViews);
    const viewMadVal = mad(cohortViews);
    results.push({
      videoId: video.videoId,
      viewCount: video.viewCount,
      cohort,
      metricUsed: 'view',
      outlierScore: deterministic(outlierScore(video.viewCount, viewMed, viewMadVal)),
    });
  }

  return results;
}

export function hasCorrelationSample(videos: PerformanceVideoInput[]): MetricValue<boolean> {
  if (videos.length < MIN_VIDEOS_FOR_CORRELATION) {
    return insufficientSample(videos.length, MIN_VIDEOS_FOR_CORRELATION);
  }
  return deterministic(true);
}
