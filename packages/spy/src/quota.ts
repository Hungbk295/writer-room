/**
 * Sổ quota YouTube Data API.
 *
 * Từ 01/06/2026 Google tách quota thành các bucket độc lập:
 *   - `search`  : search.list có bucket riêng, mặc định 100 CALL/ngày (1 unit/call)
 *   - `general` : 10.000 unit/ngày dùng chung cho mọi endpoint còn lại
 * (developers.google.com/youtube/v3/determine_quota_cost)
 *
 * Đây là bộ đếm ƯỚC LƯỢNG phía client, không phải bộ đếm thật của Google.
 * Nếu API key còn được dùng bởi tiến trình khác thì số sẽ lệch — mọi output
 * đều nói rõ điều đó thay vì giả vờ chính xác.
 */
import { AppError } from './errors.ts';
import type { SpyStore } from './store.ts';

export type QuotaBucket = 'search' | 'general';

export const QUOTA_LIMITS: Record<QuotaBucket, number> = {
  search: 100,
  general: 10_000,
};

/** Chi phí quota theo endpoint, tính bằng unit trong bucket tương ứng. */
export const QUOTA_COST = {
  'search.list': { bucket: 'search' as const, units: 1 },
  'videos.list': { bucket: 'general' as const, units: 1 },
  'channels.list': { bucket: 'general' as const, units: 1 },
  'playlistItems.list': { bucket: 'general' as const, units: 1 },
  'channelSections.list': { bucket: 'general' as const, units: 1 },
  'subscriptions.list': { bucket: 'general' as const, units: 1 },
  'commentThreads.list': { bucket: 'general' as const, units: 1 },
} satisfies Record<string, { bucket: QuotaBucket; units: number }>;

export type QuotaOp = keyof typeof QUOTA_COST;

/**
 * Ngày quota theo America/Los_Angeles — giờ reset của Google Cloud quota
 * ("For per-day quotas, the time period resets at midnight Pacific Time").
 * Dùng en-CA để ra sẵn định dạng YYYY-MM-DD.
 */
export function quotaDay(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Thời điểm reset kế tiếp (nửa đêm Pacific) dưới dạng ISO. */
export function nextQuotaReset(now: Date = new Date()): string {
  const today = quotaDay(now);
  // Nửa đêm Pacific của NGÀY KẾ TIẾP, quy về UTC bằng cách dò offset hiện hành.
  const [year, month, day] = today.split('-').map(Number);
  const nextMidnightUtcGuess = Date.UTC(year!, month! - 1, day! + 1, 0, 0, 0);
  const offsetMinutes = pacificOffsetMinutes(new Date(nextMidnightUtcGuess));
  return new Date(nextMidnightUtcGuess + offsetMinutes * 60_000).toISOString();
}

function pacificOffsetMinutes(at: Date): number {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'longOffset',
  }).formatToParts(at).find((part) => part.type === 'timeZoneName')?.value ?? 'GMT-08:00';
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(formatted);
  if (!match) return 480;
  const sign = match[1] === '-' ? 1 : -1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

export interface BucketStatus {
  bucket: QuotaBucket;
  used: number;
  limit: number;
  remaining: number;
  calls: number;
}

export class QuotaLedger {
  constructor(private readonly store: SpyStore) {}

  status(now: Date = new Date()): {
    quotaDay: string;
    resetsAt: string;
    buckets: BucketStatus[];
    note: string;
  } {
    const day = quotaDay(now);
    const buckets = (Object.keys(QUOTA_LIMITS) as QuotaBucket[]).map((bucket) => {
      const usage = this.store.getQuotaUsage(bucket, day);
      return {
        bucket,
        used: usage.units,
        limit: QUOTA_LIMITS[bucket],
        remaining: Math.max(0, QUOTA_LIMITS[bucket] - usage.units),
        calls: usage.calls,
      };
    });
    return {
      quotaDay: day,
      resetsAt: nextQuotaReset(now),
      buckets,
      note: 'Ước lượng phía client. Bộ đếm thật nằm ở Google Cloud Console; nếu API key được dùng ở nơi khác thì số này thấp hơn thực tế.',
    };
  }

  remaining(bucket: QuotaBucket, now: Date = new Date()): number {
    const usage = this.store.getQuotaUsage(bucket, quotaDay(now));
    return Math.max(0, QUOTA_LIMITS[bucket] - usage.units);
  }

  /** Còn đủ chỗ cho `calls` lần gọi op này không? Dùng cho dry_run và lập kế hoạch. */
  canAfford(op: QuotaOp, calls = 1, now: Date = new Date()): boolean {
    const cost = QUOTA_COST[op];
    return this.remaining(cost.bucket, now) >= cost.units * calls;
  }

  /**
   * Ghi nhận một lần gọi. Ném `quota_exceeded` TRƯỚC khi request được gửi đi,
   * để không đốt quota thật rồi mới phát hiện hết.
   */
  consume(op: QuotaOp, calls = 1, now: Date = new Date()): BucketStatus {
    const cost = QUOTA_COST[op];
    const day = quotaDay(now);
    const usage = this.store.getQuotaUsage(cost.bucket, day);
    const needed = cost.units * calls;
    const limit = QUOTA_LIMITS[cost.bucket];
    if (usage.units + needed > limit) {
      throw new AppError(
        'quota_exceeded',
        `Hết quota bucket "${cost.bucket}" cho ${op}: đã dùng ${usage.units}/${limit}, cần thêm ${needed}. Reset lúc ${nextQuotaReset(now)}.`,
        { retryable: false, details: { bucket: cost.bucket, used: usage.units, limit, needed } },
      );
    }
    const next = this.store.addQuotaUsage(cost.bucket, day, needed, calls);
    return {
      bucket: cost.bucket,
      used: next.units,
      limit,
      remaining: Math.max(0, limit - next.units),
      calls: next.calls,
    };
  }
}
