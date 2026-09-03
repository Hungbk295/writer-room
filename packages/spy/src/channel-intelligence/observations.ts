import { AppError, asAppError } from '../errors.ts';
import type { YoutubePort, YoutubeVideoObservationInfo } from '../adapters/ytdlp.ts';
import type { SpyStore } from '../store.ts';
import { isResolvedYoutubeUcId } from '../store.ts';
import {
  LOCAL_PUBLIC_WATCHLIST,
  type PublicChannelVphRead,
  type PublicObservationPlanKind,
  type PublicObservationRun,
  type PublicVideoVphRead,
  type PublicVideoStatPoint,
  type PublicVphQuery,
  type PublicVphSegment,
  type PublicVphWindow,
  type VphComparability,
} from './types.ts';

const PLAN_VERSION = 'public-vph-collect/v1';
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PublicObservationOptions {
  watchlistId?: string;
  planKind?: PublicObservationPlanKind;
  /** Scheduler date in its configured timezone.  Manual calls use UTC day. */
  localDate?: string;
  playlistLimit?: number;
  inspectCap?: number;
  now?: Date;
  /** Scheduler-only cancellation for a bounded per-relation collection. */
  signal?: AbortSignal;
}

export interface PublicObservationResult {
  run: PublicObservationRun;
  reused: boolean;
  inspected: number;
  notes: string[];
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function channelUrl(channel: { youtubeUcId: string | null; handle: string | null }): string {
  if (channel.handle?.startsWith('@')) return `https://www.youtube.com/${channel.handle}/videos`;
  if (channel.youtubeUcId && isResolvedYoutubeUcId(channel.youtubeUcId)) {
    return `https://www.youtube.com/channel/${channel.youtubeUcId}/videos`;
  }
  throw new AppError('invalid_input', 'channel_unresolved_or_invalid: public watch cần stable UC identity');
}

function observationPort(youtube: YoutubePort): Required<Pick<YoutubePort, 'listChannelObservation' | 'inspectVideoObservation'>> {
  if (typeof youtube.listChannelObservation !== 'function' || typeof youtube.inspectVideoObservation !== 'function') {
    throw new AppError('capability_missing', 'yt-dlp observation capability chưa sẵn sàng');
  }
  return {
    listChannelObservation: youtube.listChannelObservation.bind(youtube),
    inspectVideoObservation: youtube.inspectVideoObservation.bind(youtube),
  };
}

function knownOrUnknown(value: number | null): 'known' | 'unknown' {
  return value === null ? 'unknown' : 'known';
}

/**
 * Public-only, yt-dlp-only collector.  It has no Data API, operations, agent,
 * PTY, transcript or LLM dependency, so a fallback cannot be introduced by
 * accident at this boundary.
 */
export class PublicObservationService {
  constructor(
    private readonly store: SpyStore,
    private readonly youtube: YoutubePort,
  ) {}

  async observe(input: { youtubeUcId: string } & PublicObservationOptions): Promise<PublicObservationResult> {
    const now = input.now ?? new Date();
    const watchlistId = input.watchlistId ?? LOCAL_PUBLIC_WATCHLIST;
    const planKind = input.planKind ?? 'manual';
    const localDate = input.localDate ?? utcDay(now);
    const playlistLimit = Math.max(1, Math.min(input.playlistLimit ?? 30, 100));
    const inspectCap = Math.max(1, Math.min(input.inspectCap ?? 20, 30));
    if (!isResolvedYoutubeUcId(input.youtubeUcId)) {
      throw new AppError('invalid_input', 'channel_unresolved_or_invalid: public watch cần stable UC identity');
    }
    const relation = this.store.getPublicCompetitor(watchlistId, input.youtubeUcId);
    if (!relation) throw new AppError('not_found', 'channel_not_followed: hãy Follow kênh trước khi thu thập public observation');
    if (relation.watchStatus !== 'followed') {
      throw new AppError('conflict', 'channel_watch_paused: hãy resume public watch trước khi thu thập');
    }
    const channel = this.store.getChannelByYoutubeUcId(input.youtubeUcId);
    if (!channel) throw new AppError('not_found', 'channel_unknown: kênh chưa có metadata Spy');

    const created = this.store.createOrGetPublicObservationRun({
      watchlistId, competitorChannelId: input.youtubeUcId, planKind, planVersion: PLAN_VERSION,
      localDate, playlistLimit, startedAt: now.toISOString(),
    });
    if (!created.created) {
      return { run: created.run, reused: true, inspected: created.run.inspectAttempted, notes: ['Idempotent: đã có run cho cửa sổ này.'] };
    }

    let inspectAttempted = 0;
    let inspectOk = 0;
    const notes: string[] = [];
    try {
      // Capability detection belongs inside the durable-run lifecycle.  A
      // missing yt-dlp observation method must settle this run unavailable,
      // never strand it `running` and make its idempotency key unrecoverable.
      const port = observationPort(this.youtube);
      const inventory = await port.listChannelObservation(channelUrl(channel), playlistLimit, input.signal);
      const selected = inventory.slice(0, inspectCap);
      if (inventory.length > selected.length) notes.push(`Chỉ inspect ${selected.length}/${inventory.length} video theo cap.`);
      for (const entry of selected) {
        if (input.signal?.aborted) {
          throw new AppError('quota_exceeded', 'wall_clock_budget_exceeded: public observation vượt quá ngân sách thời gian mỗi kênh');
        }
        inspectAttempted += 1;
        try {
          const detail = await port.inspectVideoObservation(entry.canonicalUrl, input.signal);
          const previous = this.store.getPreviousKnownPublicView(input.youtubeUcId, detail.sourceVideoId);
          const decreased = detail.viewCount !== null && previous !== null && detail.viewCount < previous;
          this.store.insertPublicVideoStatPoint({
            observationRunId: created.run.id,
            sourceVideoId: detail.sourceVideoId,
            youtubeUcId: input.youtubeUcId,
            sampledAt: now.toISOString(),
            viewCount: detail.viewCount,
            likeCount: detail.likeCount,
            commentCount: detail.commentCount,
            durationSec: detail.durationSec,
            publishedAt: detail.publishedAt,
            title: detail.title,
            availability: 'present',
            viewQuality: decreased ? 'decreased_vs_prior' : knownOrUnknown(detail.viewCount),
            providerUsed: 'ytdlp',
            inspectUsed: true,
          });
          inspectOk += 1;
        } catch (error) {
          // Do not keep spawning inspection attempts with an already-aborted
          // signal.  The outer durable-run path settles the partial sample.
          if (input.signal?.aborted) {
            throw new AppError('quota_exceeded', 'wall_clock_budget_exceeded: public observation vượt quá ngân sách thời gian mỗi kênh');
          }
          const appError = asAppError(error);
          this.store.insertPublicVideoStatPoint({
            observationRunId: created.run.id,
            sourceVideoId: entry.sourceVideoId,
            youtubeUcId: input.youtubeUcId,
            sampledAt: now.toISOString(),
            viewCount: null, likeCount: null, commentCount: null, durationSec: null,
            publishedAt: entry.publishedAt, title: entry.title,
            availability: /private|unavailable|404/i.test(appError.message) ? 'private' : 'error',
            viewQuality: 'unknown', providerUsed: 'ytdlp', inspectUsed: true,
          });
        }
      }
      const complete = inspectOk === selected.length;
      const status = complete ? 'completed' : inspectOk > 0 ? 'partial' : 'unavailable';
      const run = this.store.updatePublicObservationRun({
        id: created.run.id, status, completeness: complete ? 'complete' : inspectOk > 0 ? 'partial' : 'unavailable',
        completedAt: new Date().toISOString(), inspectAttempted, inspectOk,
      });
      this.store.markPublicCompetitorObserved(watchlistId, input.youtubeUcId, run.completedAt ?? now.toISOString(), status);
      return { run, reused: false, inspected: inspectAttempted, notes };
    } catch (error) {
      const appError = input.signal?.aborted
        ? new AppError('quota_exceeded', 'wall_clock_budget_exceeded: public observation vượt quá ngân sách thời gian mỗi kênh')
        : asAppError(error);
      const run = this.store.updatePublicObservationRun({
        id: created.run.id,
        // A deadline can leave earlier inspected points behind.  Preserve
        // those facts and label the run partial rather than pretending a
        // complete daily sample exists.
        status: appError.code === 'capability_missing' || inspectOk === 0 ? 'unavailable' : 'partial',
        completeness: inspectOk === 0 ? 'unavailable' : 'partial', completedAt: new Date().toISOString(),
        errorCode: appError.code, errorMessage: appError.message.slice(0, 500), inspectAttempted, inspectOk,
      });
      this.store.markPublicCompetitorObserved(watchlistId, input.youtubeUcId, run.completedAt ?? now.toISOString(), run.status);
      // Provider failure is represented in the append-only run rather than
      // silently falling back to Data API.  The caller receives the run so the
      // UI can show an unavailable observation instead of a fake zero.
      return { run, reused: false, inspected: inspectAttempted, notes: [...notes, appError.message] };
    }
  }

  readVph(youtubeUcId: string, query: PublicVphQuery = {}, watchlistId = LOCAL_PUBLIC_WATCHLIST): PublicChannelVphRead {
    if (!isResolvedYoutubeUcId(youtubeUcId)) {
      throw new AppError('invalid_input', 'channel_unresolved_or_invalid: VPH cần stable UC identity');
    }
    if (query.cursor) {
      throw new AppError('invalid_input', 'cursor chỉ áp dụng cho raw video drilldown; channel VPH được derive trên toàn bộ history để không cắt đôi cặp mẫu');
    }
    const requestedWindow = query.window ?? '24h';
    // Derive VPH before any raw-point pagination.  A channel page is a global
    // time ordering, while the formula needs adjacent points per video.
    const points = this.store.listAllPublicVideoStatPoints({
      youtubeUcId, from: query.from, to: query.to,
    });
    const byVideo = new Map<string, typeof points>();
    for (const point of points) {
      const bucket = byVideo.get(point.sourceVideoId) ?? [];
      bucket.push(point);
      byVideo.set(point.sourceVideoId, bucket);
    }
    const allSegments = [...byVideo.values()].map((videoPoints) => deriveVphSegment(videoPoints, requestedWindow));
    const timeline = [...byVideo.values()].flatMap((videoPoints) => videoPoints
      .slice(1)
      .map((_, index) => deriveVphSegment(videoPoints.slice(0, index + 2), requestedWindow)));
    const matchingSegments = allSegments.filter((segment) => matchesVphFilters(segment, query));
    const segments = query.includeNonComparable === false
      ? matchingSegments.filter((segment) => segment.comparability === comparableFor(requestedWindow))
      : matchingSegments;
    const comparable = matchingSegments.filter((item) => item.comparability === comparableFor(requestedWindow) && item.value !== null)
      .map((item) => item.value!).toSorted((a, b) => a - b);
    const median = comparable.length >= 5
      ? medianOf(comparable)
      : null;
    // Store ordering groups by video id for VPH pairing, so it is not a
    // trustworthy channel-level recency order.  The provenance strip must
    // report the newest actual sample across all videos.
    const observedAt = points.reduce<string | null>((latest, point) => (
      latest === null || point.sampledAt > latest ? point.sampledAt : latest
    ), null);
    const matchingTimeline = timeline.filter((segment) => matchesVphFilters(segment, query));
    const visibleTimeline = query.includeNonComparable === false
      ? matchingTimeline.filter((segment) => segment.comparability === comparableFor(requestedWindow))
      : matchingTimeline;
    const sortedSegments = segments.toSorted((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
    const latestRun = this.store.listPublicObservationRuns(watchlistId, youtubeUcId, 1)[0] ?? null;
    const videos = [...byVideo.values()].map((videoPoints) => toVphVideo(videoPoints));
    const unavailablePointCount = points.filter((point) => point.availability !== 'present' || point.viewCount === null).length;
    const result: PublicChannelVphRead = {
      youtubeUcId, requestedWindow, definitionVersion: 'vph/v1', timezone: query.timezone ?? 'Asia/Ho_Chi_Minh', observedAt,
      provenance: { visibility: 'public', providerUsed: 'ytdlp', dataApiUsed: false, definitionVersion: 'vph/v1' },
      coverage: {
        rawPointCount: points.length,
        videoCount: byVideo.size,
        latestRunStatus: latestRun?.status ?? null,
        latestRunCompleteness: latestRun?.completeness ?? null,
        latestRunAt: latestRun?.completedAt ?? latestRun?.startedAt ?? null,
        inspectedVideoCount: points.filter((point) => point.inspectUsed).length,
        unavailablePointCount,
        truncated: false,
        nextCursor: null,
      },
      videos: videos.toSorted((a, b) => (b.latestSampledAt ?? '').localeCompare(a.latestSampledAt ?? '')),
      vphSegments: sortedSegments,
      vphTimeline: visibleTimeline,
      aggregations: {
        medianVph: median,
        comparableCount: comparable.length,
        measuredCount: matchingSegments.filter((segment) => segment.value !== null).length,
        unavailableCount: matchingSegments.filter((segment) => segment.value === null).length,
        cohorts: vphCohorts(matchingSegments, requestedWindow),
      },
      // Preserve the initial C3 client shape while it moves to the named v0.2 fields.
      segments: sortedSegments,
      medianVph24h: requestedWindow === '24h' ? median : null,
      comparableCount: comparable.length,
      notes: [
        'VPH = (views cuối − views đầu) / số giờ thực tế giữa hai lần quan sát.',
        comparabilityNote(requestedWindow),
        'Channel VPH được tính trên toàn bộ history trong khoảng lọc; raw points chỉ phân trang ở video drilldown.',
      ],
    };
    return result;
  }

  readVideoVph(sourceVideoId: string, query: PublicVphQuery = {}, watchlistId = LOCAL_PUBLIC_WATCHLIST): PublicVideoVphRead {
    if (!/^[A-Za-z0-9_-]{11}$/.test(sourceVideoId)) {
      throw new AppError('invalid_input', 'source_video_id không hợp lệ');
    }
    const page = this.store.listPublicVideoStatPointsForVideoPage({
      sourceVideoId, from: query.from, to: query.to, cursor: query.cursor, limit: query.limit,
    });
    const allPoints = this.store.listAllPublicVideoStatPointsForVideo({ sourceVideoId, from: query.from, to: query.to });
    const youtubeUcId = allPoints[0]?.youtubeUcId ?? page.points[0]?.youtubeUcId ?? null;
    if (!youtubeUcId) throw new AppError('not_found', 'public_video_not_found');
    if (!this.store.getPublicCompetitor(watchlistId, youtubeUcId)) {
      throw new AppError('not_found', 'channel_not_followed: video không thuộc public watchlist này');
    }
    const requestedWindow = query.window ?? '24h';
    const segment = deriveVphSegment(allPoints, requestedWindow);
    return {
      sourceVideoId,
      youtubeUcId,
      requestedWindow,
      definitionVersion: 'vph/v1',
      timezone: query.timezone ?? 'Asia/Ho_Chi_Minh',
      provenance: { visibility: 'public', providerUsed: 'ytdlp', dataApiUsed: false, definitionVersion: 'vph/v1' },
      coverage: {
        rawPointCount: page.points.length,
        unavailablePointCount: page.points.filter((point) => point.availability !== 'present' || point.viewCount === null).length,
        truncated: page.truncated,
        nextCursor: page.nextCursor,
      },
      rawPoints: page.points,
      vphSegments: [segment],
    };
  }
}

export function deriveVphSegment(points: readonly PublicVideoStatPoint[], requestedWindow: PublicVphWindow = '24h'): PublicVphSegment {
  const first = points[0] ?? null;
  const last = points.at(-1) ?? null;
  const base = {
    sourceVideoId: last?.sourceVideoId ?? first?.sourceVideoId ?? 'unknown',
    title: last?.title ?? first?.title ?? null,
    publishedAt: last?.publishedAt ?? first?.publishedAt ?? null,
    durationSec: last?.durationSec ?? first?.durationSec ?? null,
    requestedWindow,
    availability: last?.availability ?? null,
    viewQuality: last?.viewQuality ?? null,
    inspectUsed: last?.inspectUsed ?? null,
    providerUsed: 'ytdlp' as const,
    definitionVersion: 'vph/v1' as const,
  };
  if (!last) {
    return { ...base, actualElapsedHours: null, value: null, method: 'insufficient_sample', comparability: 'insufficient_sample', reason: 'Chưa có public observation cho video này.', start: null, end: null };
  }
  // Missing/private/error is an honest discontinuity.  Do not skip it and
  // bridge two earlier/later known points into a made-up continuous VPH line.
  const contiguousKnownTail: PublicVideoStatPoint[] = [];
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index]!;
    if (point.availability !== 'present' || point.viewCount === null) break;
    contiguousKnownTail.unshift(point);
  }
  if (contiguousKnownTail.length < 2) {
    const hasGap = points.length > contiguousKnownTail.length;
    return {
      ...base, actualElapsedHours: null, value: null,
      method: hasGap ? 'unavailable' : 'insufficient_sample',
      comparability: hasGap ? 'unavailable' : 'insufficient_sample',
      reason: hasGap ? 'missing_measurement: VPH dừng tại mẫu missing/private/error; không bắc cầu qua khoảng trống.' : 'Cần ít nhất 2 mẫu view public hợp lệ.',
      start: null, end: null,
    };
  }
  const end = contiguousKnownTail.at(-1)!;
  const start = selectVphStart(contiguousKnownTail, requestedWindow);
  const elapsed = (Date.parse(end.sampledAt) - Date.parse(start.sampledAt)) / 3_600_000;
  if (!Number.isFinite(elapsed) || elapsed <= 0) {
    return { ...base, actualElapsedHours: null, value: null, method: 'unavailable', comparability: 'unavailable', reason: 'Timestamp observation không hợp lệ.', start: null, end: null };
  }
  const startRef = { sampledAt: start.sampledAt, viewCount: start.viewCount! };
  const endRef = { sampledAt: end.sampledAt, viewCount: end.viewCount! };
  if (end.viewCount! < start.viewCount!) {
    return { ...base, actualElapsedHours: elapsed, value: null, method: 'unavailable', comparability: 'unavailable', reason: 'count_decreased: giữ raw fact nhưng không tạo VPH âm/clamped.', start: startRef, end: endRef };
  }
  const comparability = classifyComparability(elapsed, requestedWindow);
  return {
    ...base, actualElapsedHours: elapsed, value: (end.viewCount! - start.viewCount!) / elapsed,
    method: 'deterministic', comparability,
    ...(comparability === comparableFor(requestedWindow) ? {} : { reason: comparabilityReason(elapsed, requestedWindow, comparability) }),
    start: startRef, end: endRef,
  };
}

function windowHours(window: PublicVphWindow): number {
  return window === '1h' ? 1 : window === '7d' ? 24 * 7 : 24;
}

function comparableFor(window: PublicVphWindow): VphComparability {
  return window === '1h' ? 'comparable_1h' : window === '7d' ? 'comparable_7d' : 'comparable_24h';
}

function selectVphStart(points: readonly PublicVideoStatPoint[], window: PublicVphWindow): PublicVideoStatPoint {
  if (window !== '7d') return points.at(-2)!;
  const end = points.at(-1)!;
  return points.slice(0, -1).toSorted((left, right) => (
    Math.abs(Date.parse(end.sampledAt) - Date.parse(left.sampledAt) - windowHours(window) * 3_600_000)
      - Math.abs(Date.parse(end.sampledAt) - Date.parse(right.sampledAt) - windowHours(window) * 3_600_000)
  ))[0]!;
}

function classifyComparability(elapsed: number, window: PublicVphWindow): VphComparability {
  const [minimum, maximum] = window === '1h' ? [0.5, 2] : window === '7d' ? [24 * 6, 24 * 8] : [18, 30];
  if (elapsed >= minimum && elapsed <= maximum) return comparableFor(window);
  if (window === '1h' && elapsed > maximum) return 'coverage_daily_only';
  return elapsed > maximum ? 'stretched' : window === '1h' ? 'not_comparable_to_1h' : window === '7d' ? 'not_comparable_to_7d' : 'not_comparable_to_24h';
}

function comparabilityReason(elapsed: number, window: PublicVphWindow, comparability: VphComparability): string {
  if (comparability === 'coverage_daily_only') return `Cửa sổ ${elapsed.toFixed(1)}h không có burst-compatible 0.5–2h; daily-only không được gọi là VPH 1h.`;
  return `Cửa sổ thực tế ${elapsed.toFixed(1)}h, không scale sang ${window}.`;
}

function comparabilityNote(window: PublicVphWindow): string {
  if (window === '1h') return 'VPH 1h chỉ comparable khi cửa sổ thực tế 0.5–2h; daily-only được ghi rõ là thiếu coverage.';
  if (window === '7d') return 'VPH 7d chỉ comparable khi cửa sổ thực tế nằm trong 6–8 ngày; số thiếu không được xem là 0.';
  return 'Chỉ so sánh 24h khi cửa sổ thực tế nằm trong 18–30 giờ; số thiếu không được xem là 0.';
}

function medianOf(sorted: readonly number[]): number {
  const middle = sorted.length / 2;
  return Number.isInteger(middle) ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[Math.floor(middle)]!;
}

function matchesVphFilters(segment: PublicVphSegment, query: PublicVphQuery): boolean {
  if (query.ageBucket && !matchesAgeBucket(segment, query.ageBucket)) return false;
  if (query.durationBucket && !matchesDurationBucket(segment.durationSec, query.durationBucket)) return false;
  if (query.publishedWeekday !== null && query.publishedWeekday !== undefined) {
    if (!segment.publishedAt || new Date(segment.publishedAt).getUTCDay() !== query.publishedWeekday) return false;
  }
  return true;
}

function matchesAgeBucket(segment: PublicVphSegment, bucket: string): boolean {
  if (!segment.publishedAt || !segment.end) return false;
  const ageHours = (Date.parse(segment.end.sampledAt) - Date.parse(segment.publishedAt)) / 3_600_000;
  if (!Number.isFinite(ageHours)) return false;
  if (bucket === '0-48h') return ageHours >= 0 && ageHours < 48;
  if (bucket === '2-7d') return ageHours >= 48 && ageHours < 24 * 7;
  if (bucket === '7-30d') return ageHours >= 24 * 7 && ageHours <= 24 * 30;
  return false;
}

function matchesDurationBucket(durationSec: number | null, bucket: string): boolean {
  if (durationSec === null) return false;
  if (bucket === 'short') return durationSec < 60;
  if (bucket === 'medium') return durationSec >= 60 && durationSec < 600;
  if (bucket === 'long') return durationSec >= 600;
  return false;
}

function toVphVideo(points: readonly PublicVideoStatPoint[]): import('./types.ts').PublicVphVideo {
  const latest = points.at(-1) ?? null;
  return {
    sourceVideoId: latest?.sourceVideoId ?? 'unknown',
    title: latest?.title ?? null,
    publishedAt: latest?.publishedAt ?? null,
    durationSec: latest?.durationSec ?? null,
    latestSampledAt: latest?.sampledAt ?? null,
    latestViewCount: latest?.viewCount ?? null,
    availability: latest?.availability ?? null,
    viewQuality: latest?.viewQuality ?? null,
    inspectUsed: latest?.inspectUsed ?? null,
  };
}

function vphCohorts(segments: readonly PublicVphSegment[], window: PublicVphWindow): PublicChannelVphRead['aggregations']['cohorts'] {
  const buckets: Array<{ ageBucket: '0-48h' | '2-7d' | '7-30d'; min: number; max: number }> = [
    { ageBucket: '0-48h', min: 0, max: 48 },
    { ageBucket: '2-7d', min: 48, max: 24 * 7 },
    { ageBucket: '7-30d', min: 24 * 7, max: 24 * 30 + 0.0001 },
  ];
  return buckets.map((bucket) => {
    const values = segments.flatMap((segment) => {
      if (segment.value === null || segment.comparability !== comparableFor(window) || !segment.end || !segment.publishedAt) return [];
      const ageHours = (Date.parse(segment.end.sampledAt) - Date.parse(segment.publishedAt)) / 3_600_000;
      return Number.isFinite(ageHours) && ageHours >= bucket.min && ageHours < bucket.max ? [segment.value] : [];
    }).toSorted((a, b) => a - b);
    if (values.length < 3) {
      return { ageBucket: bucket.ageBucket, sampleCount: values.length, medianVph: null, p25: null, p75: null, reason: 'insufficient_sample' as const };
    }
    return {
      ageBucket: bucket.ageBucket,
      sampleCount: values.length,
      medianVph: medianOf(values),
      p25: percentile(values, 0.25),
      p75: percentile(values, 0.75),
    };
  });
}

function percentile(sorted: readonly number[], fraction: number): number {
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

export const PUBLIC_VPH_PLAN_VERSION = PLAN_VERSION;
export const PUBLIC_VPH_DAY_MS = DAY_MS;
