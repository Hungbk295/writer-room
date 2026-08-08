import { hamming64, parseDhashHex } from '../evidence/dhash.ts';
import { proxy, type MetricValue } from './gates.ts';
import { median, percentile } from './stats.ts';

export interface VisualSamplingPolicy {
  mode: 'sequential' | 'scene' | 'spread' | 'random';
  frameCount: number;
  intervalSec: number;
  dhashThreshold: number;
}

export interface FrameInput {
  timestampSec: number;
  dhash: string;
}

export interface VisualRhythmMetrics {
  cutRatePerMinute: number;
  sceneLengthMedianSec: number;
  sceneLengthP25: number;
  sceneLengthP75: number;
  cutRateByWindow: Array<{ startSec: number; endSec: number; cuts: number }>;
  samplingPolicy: VisualSamplingPolicy;
}

const DEFAULT_SAMPLING_POLICY: VisualSamplingPolicy = {
  mode: 'sequential',
  frameCount: 30,
  intervalSec: 1,
  dhashThreshold: 8,
};

function detectCuts(
  frames: FrameInput[],
  dhashThreshold: number,
): number[] {
  if (frames.length < 2) return [];
  const sorted = [...frames].sort((a, b) => a.timestampSec - b.timestampSec);
  const cutTimestamps: number[] = [];

  for (let i = 1; i < sorted.length; i++) {
    const prev = parseDhashHex(sorted[i - 1]!.dhash);
    const curr = parseDhashHex(sorted[i]!.dhash);
    if (hamming64(prev, curr) > dhashThreshold) {
      cutTimestamps.push(sorted[i]!.timestampSec);
    }
  }

  return cutTimestamps;
}

function sceneLengths(frames: FrameInput[], cutTimestamps: number[]): number[] {
  if (frames.length === 0) return [];
  const sorted = [...frames].sort((a, b) => a.timestampSec - b.timestampSec);
  const startSec = sorted[0]!.timestampSec;
  const endSec = sorted[sorted.length - 1]!.timestampSec;

  if (cutTimestamps.length === 0) {
    return endSec > startSec ? [endSec - startSec] : [0];
  }

  const boundaries = [startSec, ...cutTimestamps.sort((a, b) => a - b), endSec];
  const lengths: number[] = [];
  for (let i = 1; i < boundaries.length; i++) {
    const len = boundaries[i]! - boundaries[i - 1]!;
    if (len > 0) lengths.push(len);
  }
  return lengths;
}

function cutRateByWindow(
  cutTimestamps: number[],
  durationSec: number,
  windowSec = 60,
): Array<{ startSec: number; endSec: number; cuts: number }> {
  const windows: Array<{ startSec: number; endSec: number; cuts: number }> = [];
  for (let start = 0; start < durationSec; start += windowSec) {
    const end = Math.min(start + windowSec, durationSec);
    const cuts = cutTimestamps.filter((t) => t >= start && t < end).length;
    windows.push({ startSec: start, endSec: end, cuts });
  }
  return windows;
}

export function computeVisualRhythmMetrics(
  frames: FrameInput[],
  samplingPolicy: VisualSamplingPolicy = DEFAULT_SAMPLING_POLICY,
): VisualRhythmMetrics {
  if (frames.length === 0) {
    return {
      cutRatePerMinute: 0,
      sceneLengthMedianSec: 0,
      sceneLengthP25: 0,
      sceneLengthP75: 0,
      cutRateByWindow: [],
      samplingPolicy,
    };
  }

  const sorted = [...frames].sort((a, b) => a.timestampSec - b.timestampSec);
  const durationSec = Math.max(
    sorted[sorted.length - 1]!.timestampSec - sorted[0]!.timestampSec,
    1 / 60,
  );
  const durationMin = durationSec / 60;

  const cutTimestamps = detectCuts(sorted, samplingPolicy.dhashThreshold);
  const cutRatePerMinute = cutTimestamps.length / durationMin;

  const lengths = sceneLengths(sorted, cutTimestamps);

  return {
    cutRatePerMinute,
    sceneLengthMedianSec: lengths.length > 0 ? median(lengths) : 0,
    sceneLengthP25: lengths.length > 0 ? percentile(lengths, 25) : 0,
    sceneLengthP75: lengths.length > 0 ? percentile(lengths, 75) : 0,
    cutRateByWindow: cutRateByWindow(cutTimestamps, durationSec),
    samplingPolicy,
  };
}

export function visualRhythmMetricsValue(
  frames: FrameInput[],
  samplingPolicy: VisualSamplingPolicy = DEFAULT_SAMPLING_POLICY,
): MetricValue<VisualRhythmMetrics> {
  const metrics = computeVisualRhythmMetrics(frames, samplingPolicy);
  return proxy(metrics);
}
