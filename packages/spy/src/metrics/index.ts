export * from './stats.ts';
export * from './gates.ts';
export * from './performance.ts';
export * from './cadence.ts';
export * from './duration.ts';
export * from './title.ts';
export * from './speech.ts';
export * from './visual.ts';

import { computeCadenceMetrics } from './cadence.ts';
import { computeDurationMetrics } from './duration.ts';
import { hasCorrelationSample, computePerformanceMetrics, computeVideoOutlierScores } from './performance.ts';
import { computeSpeechMetrics } from './speech.ts';
import { computeTitleMetrics, extractTitleFeatures } from './title.ts';
import { computeVisualRhythmMetrics, type VisualSamplingPolicy } from './visual.ts';
import type { TranscriptSegmentInput } from './speech.ts';
import type { FrameInput } from './visual.ts';
import type { VideoOutlierResult } from './performance.ts';
import type { PerformanceMetrics } from './performance.ts';
import type { CadenceMetrics } from './cadence.ts';
import type { DurationMetrics } from './duration.ts';
import type { TitleMetrics, TitleFeatures } from './title.ts';
import type { SpeechMetrics } from './speech.ts';
import type { VisualRhythmMetrics } from './visual.ts';
import type { MetricValue } from './gates.ts';

export interface ChannelVideoInput {
  videoId: string;
  viewCount: number;
  publishedAt: Date | string;
  likeCount?: number | null;
  commentCount?: number | null;
  durationSec: number;
  title: string;
  transcriptSegments?: TranscriptSegmentInput[];
  frames?: FrameInput[];
}

export interface ChannelMetricsInput {
  videos: ChannelVideoInput[];
  subscriberCount?: number | null;
  referenceDate?: Date;
  samplingPolicy?: VisualSamplingPolicy;
}

export interface ChannelMetrics {
  performance: PerformanceMetrics;
  outliers: VideoOutlierResult[];
  correlationSample: MetricValue<boolean>;
  cadence: CadenceMetrics;
  duration: DurationMetrics;
  title: TitleMetrics;
}

export interface VideoMetricsInput {
  videoId: string;
  viewCount: number;
  publishedAt: Date | string;
  likeCount?: number | null;
  commentCount?: number | null;
  durationSec: number;
  title: string;
  transcriptSegments?: TranscriptSegmentInput[];
  frames?: FrameInput[];
}

export interface VideoMetricsContext {
  channelVideos?: ChannelVideoInput[];
  subscriberCount?: number | null;
  referenceDate?: Date;
  samplingPolicy?: VisualSamplingPolicy;
}

export interface VideoMetrics {
  videoId: string;
  title: TitleFeatures;
  performance: {
    outlier: VideoOutlierResult | null;
    channelPerformance: PerformanceMetrics | null;
  };
  speech: SpeechMetrics | null;
  visual: VisualRhythmMetrics | null;
}

export function computeChannelMetrics(input: ChannelMetricsInput): ChannelMetrics {
  const { videos, subscriberCount, referenceDate = new Date(), samplingPolicy } = input;

  const performanceVideos = videos.map((v) => ({
    videoId: v.videoId,
    viewCount: v.viewCount,
    publishedAt: v.publishedAt,
    likeCount: v.likeCount,
    commentCount: v.commentCount,
  }));

  return {
    performance: computePerformanceMetrics(performanceVideos, { subscriberCount, referenceDate }),
    outliers: computeVideoOutlierScores(performanceVideos, referenceDate),
    correlationSample: hasCorrelationSample(performanceVideos),
    cadence: computeCadenceMetrics(videos),
    duration: computeDurationMetrics(videos),
    title: computeTitleMetrics(videos),
  };
}

export function computeVideoMetrics(
  video: VideoMetricsInput,
  context: VideoMetricsContext = {},
): VideoMetrics {
  const { channelVideos = [], subscriberCount, referenceDate = new Date(), samplingPolicy } = context;

  let outlier: VideoOutlierResult | null = null;
  let channelPerformance: PerformanceMetrics | null = null;

  if (channelVideos.length > 0) {
    const performanceVideos = channelVideos.map((v) => ({
      videoId: v.videoId,
      viewCount: v.viewCount,
      publishedAt: v.publishedAt,
      likeCount: v.likeCount,
      commentCount: v.commentCount,
    }));
    channelPerformance = computePerformanceMetrics(performanceVideos, { subscriberCount, referenceDate });
    const outliers = computeVideoOutlierScores(performanceVideos, referenceDate);
    outlier = outliers.find((o) => o.videoId === video.videoId) ?? null;
  }

  const speech =
    video.transcriptSegments && video.transcriptSegments.length > 0
      ? computeSpeechMetrics(video.transcriptSegments)
      : null;

  const visual =
    video.frames && video.frames.length > 0
      ? computeVisualRhythmMetrics(video.frames, samplingPolicy)
      : null;

  return {
    videoId: video.videoId,
    title: extractTitleFeatures(video.title),
    performance: { outlier, channelPerformance },
    speech,
    visual,
  };
}
