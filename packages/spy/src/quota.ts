/**
 * Sổ quota YouTube Data API — hỗ trợ multi-key rotation.
 *
 * Từ 01/06/2026 Google tách quota thành các bucket độc lập:
 *   - `search`  : search.list có bucket riêng, mặc định 100 CALL/ngày (1 unit/call)
 *   - `general` : 10.000 unit/ngày dùng chung cho mọi endpoint còn lại
 * (developers.google.com/youtube/v3/determine_quota_cost)
 *
 * Đây là bộ đếm ƯỚC LƯỢNG phía client, không phải bộ đếm thật của Google.
 * Nếu API key còn được dùng bởi tiến trình khác thì số sẽ lệch — mọi output
 * đều nói rõ điều đó thay vì giả vờ chính xác.
 *
 * Multi-key rotation: khi có nhiều key, mỗi key có quota riêng.
 * Hết quota key A → tự chuyển sang key B. Tổng quota = 100 × N search call/ngày.
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

/** Chuỗi chỉ có ngày, không có giờ — `2026-08-21`. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Quy một MỐC THỜI GIAN về quota-day Pacific. Trả null nếu rỗng/không parse được.
 *
 * Đây là hàm phải dùng mỗi khi so một timestamp với một quota-day. So trực tiếp
 * bằng `iso.startsWith(quotaDay())` hay `iso.slice(0,10) === quotaDay()` là SAI:
 * timestamp là UTC còn quota-day là Pacific, hai cái lệch nhau 17:00–23:59
 * Pacific (07:00–13:59 giờ VN) nên phép so **không bao giờ khớp** trong khung đó
 * — và vì nó fail im lặng, chỗ gọi chỉ trông như "không tìm thấy gì".
 * Lỗi này đã xảy ra hai lần trong cùng một ngày ở hai package khác nhau.
 *
 * @throws invalid_input khi nhận chuỗi chỉ-có-ngày. Một quota-day ĐÃ là quota-day:
 *   `new Date('2026-08-21')` là nửa đêm UTC, quy về Pacific sẽ lùi thành 08-20 và
 *   lại sinh ra đúng loại lệch ngày mà hàm này tồn tại để chặn. So hai quota-day
 *   với nhau thì so chuỗi trực tiếp.
 */
export function quotaDayOf(at: Date | string | null | undefined): string | null {
  if (at === null || at === undefined || at === '') return null;
  if (typeof at === 'string' && DATE_ONLY.test(at.trim())) {
    throw new AppError(
      'invalid_input',
      `quotaDayOf() nhận chuỗi chỉ có ngày ("${at}"). Đó đã là một quota-day — so chuỗi trực tiếp, đừng parse lại thành Date.`,
    );
  }
  const date = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  return quotaDay(date);
}

/**
 * Hai mốc thời gian có rơi vào cùng một quota-day Pacific không?
 * false khi một trong hai không parse được — không có ngày thì không "cùng ngày".
 */
export function isSameQuotaDay(
  a: Date | string | null | undefined,
  b: Date | string | null | undefined,
): boolean {
  const dayA = quotaDayOf(a);
  const dayB = quotaDayOf(b);
  return dayA !== null && dayA === dayB;
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

/** Trạng thái quota của một key cụ thể. */
export interface KeyBucketStatus extends BucketStatus {
  keyId: string;
}

/** Lấy 4 ký tự cuối của API key làm ID ẩn danh. */
export function keyId(apiKey: string): string {
  const trimmed = apiKey.trim();
  return trimmed.length >= 4 ? trimmed.slice(-4) : trimmed;
}

export class QuotaLedger {
  private _keyPool: KeyPool | null = null;

  constructor(private readonly store: SpyStore) {}

  /** Gắn key pool để aggregate methods dùng đúng limit tổng. */
  setKeyPool(pool: KeyPool): void {
    this._keyPool = pool;
  }

  /** Effective limit = perKeyLimit × numberOfKeys. Single key → đúng QUOTA_LIMITS. */
  effectiveLimit(bucket: QuotaBucket): number {
    const numKeys = this._keyPool && !this._keyPool.isEmpty ? this._keyPool.size : 1;
    return QUOTA_LIMITS[bucket] * numKeys;
  }

  status(now: Date = new Date()): {
    quotaDay: string;
    resetsAt: string;
    buckets: BucketStatus[];
    note: string;
  } {
    const day = quotaDay(now);
    const buckets = (Object.keys(QUOTA_LIMITS) as QuotaBucket[]).map((bucket) => {
      const usage = this.store.getQuotaUsage(bucket, day);
      const limit = this.effectiveLimit(bucket);
      return {
        bucket,
        used: usage.units,
        limit,
        remaining: Math.max(0, limit - usage.units),
        calls: usage.calls,
      };
    });
    return {
      quotaDay: day,
      resetsAt: nextQuotaReset(now),
      buckets,
      note: this._keyPool && this._keyPool.size > 1
        ? `Multi-key rotation: ${this._keyPool.size} key, limit nhân ${this._keyPool.size}. Ước lượng phía client.`
        : 'Ước lượng phía client. Bộ đếm thật nằm ở Google Cloud Console; nếu API key được dùng ở nơi khác thì số này thấp hơn thực tế.',
    };
  }

  remaining(bucket: QuotaBucket, now: Date = new Date()): number {
    const usage = this.store.getQuotaUsage(bucket, quotaDay(now));
    return Math.max(0, this.effectiveLimit(bucket) - usage.units);
  }

  /** Còn đủ chỗ cho `calls` lần gọi op này không? Dùng cho dry_run và lập kế hoạch. */
  canAfford(op: QuotaOp, calls = 1, now: Date = new Date()): boolean {
    const cost = QUOTA_COST[op];
    return this.remaining(cost.bucket, now) >= cost.units * calls;
  }

  /**
   * Ghi nhận một lần gọi (single-key mode).
   * Ném `quota_exceeded` TRƯỚC khi request được gửi đi.
   * Multi-key mode dùng consumeForKey() thay vì hàm này.
   */
  consume(op: QuotaOp, calls = 1, now: Date = new Date()): BucketStatus {
    const cost = QUOTA_COST[op];
    const day = quotaDay(now);
    const usage = this.store.getQuotaUsage(cost.bucket, day);
    const needed = cost.units * calls;
    const limit = this.effectiveLimit(cost.bucket);
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

  // ---------------------------------------------------------------------------
  // Per-key quota — dùng cho multi-key rotation
  // ---------------------------------------------------------------------------

  /** Quota còn lại của một key cụ thể cho một bucket. */
  remainingForKey(kid: string, bucket: QuotaBucket, now: Date = new Date()): number {
    const usage = this.store.getQuotaUsagePerKey(kid, bucket, quotaDay(now));
    return Math.max(0, QUOTA_LIMITS[bucket] - usage.units);
  }

  /** Key này còn đủ quota cho op? */
  canAffordForKey(kid: string, op: QuotaOp, calls = 1, now: Date = new Date()): boolean {
    const cost = QUOTA_COST[op];
    return this.remainingForKey(kid, cost.bucket, now) >= cost.units * calls;
  }

  /**
   * Ghi nhận quota cho key cụ thể.
   * Cũng cập nhật bảng aggregate (backward compat).
   * Ném `quota_exceeded` nếu KEY ĐÓ hết quota.
   */
  consumeForKey(kid: string, op: QuotaOp, calls = 1, now: Date = new Date()): KeyBucketStatus {
    const cost = QUOTA_COST[op];
    const day = quotaDay(now);
    const usage = this.store.getQuotaUsagePerKey(kid, cost.bucket, day);
    const needed = cost.units * calls;
    const limit = QUOTA_LIMITS[cost.bucket];
    if (usage.units + needed > limit) {
      throw new AppError(
        'quota_exceeded',
        `Key ...${kid} hết quota bucket "${cost.bucket}" cho ${op}: đã dùng ${usage.units}/${limit}, cần thêm ${needed}. Reset lúc ${nextQuotaReset(now)}.`,
        { retryable: false, details: { keyId: kid, bucket: cost.bucket, used: usage.units, limit, needed } },
      );
    }
    // addQuotaUsagePerKey tự cập nhật cả bảng aggregate
    const next = this.store.addQuotaUsagePerKey(kid, cost.bucket, day, needed, calls);
    return {
      keyId: kid,
      bucket: cost.bucket,
      used: next.units,
      limit,
      remaining: Math.max(0, limit - next.units),
      calls: next.calls,
    };
  }

  /** Trạng thái quota chi tiết cho tất cả key đang có trong DB hôm nay. */
  statusPerKey(apiKeys: string[], now: Date = new Date()): {
    quotaDay: string;
    resetsAt: string;
    keys: Array<{ keyId: string; buckets: BucketStatus[] }>;
    totalSearchRemaining: number;
    totalGeneralRemaining: number;
  } {
    const day = quotaDay(now);
    const keys = apiKeys.map((key) => {
      const kid = keyId(key);
      const buckets = (Object.keys(QUOTA_LIMITS) as QuotaBucket[]).map((bucket) => {
        const usage = this.store.getQuotaUsagePerKey(kid, bucket, day);
        return {
          bucket,
          used: usage.units,
          limit: QUOTA_LIMITS[bucket],
          remaining: Math.max(0, QUOTA_LIMITS[bucket] - usage.units),
          calls: usage.calls,
        };
      });
      return { keyId: kid, buckets };
    });
    return {
      quotaDay: day,
      resetsAt: nextQuotaReset(now),
      keys,
      totalSearchRemaining: keys.reduce((sum, k) => sum + (k.buckets.find((b) => b.bucket === 'search')?.remaining ?? 0), 0),
      totalGeneralRemaining: keys.reduce((sum, k) => sum + (k.buckets.find((b) => b.bucket === 'general')?.remaining ?? 0), 0),
    };
  }
}

// ---------------------------------------------------------------------------
// KeyPool — quản lý nhiều API key với auto-rotation
// ---------------------------------------------------------------------------

export class KeyPool {
  private readonly keys: string[];
  private currentIndex = 0;

  constructor(keys: string[]) {
    this.keys = keys.filter((k) => k.trim().length > 0);
  }

  get size(): number {
    return this.keys.length;
  }

  get isEmpty(): boolean {
    return this.keys.length === 0;
  }

  /** Key hiện tại. */
  get currentKey(): string | undefined {
    return this.keys[this.currentIndex];
  }

  /** keyId (last4) của key hiện tại. */
  get currentKeyId(): string | undefined {
    const key = this.currentKey;
    return key ? keyId(key) : undefined;
  }

  /** Tất cả key. */
  get allKeys(): readonly string[] {
    return this.keys;
  }

  /** Tất cả keyId (last4). */
  get allKeyIds(): string[] {
    return this.keys.map(keyId);
  }

  /**
   * Tìm key còn quota cho op. Bắt đầu từ currentIndex, quay vòng.
   * Trả key đầu tiên còn đủ quota, hoặc null nếu tất cả hết.
   * Cập nhật currentIndex sang key tìm được.
   */
  pickAvailableKey(quota: QuotaLedger, op: QuotaOp, now: Date = new Date()): string | null {
    if (this.keys.length === 0) return null;
    for (let i = 0; i < this.keys.length; i++) {
      const idx = (this.currentIndex + i) % this.keys.length;
      const key = this.keys[idx]!;
      if (quota.canAffordForKey(keyId(key), op, 1, now)) {
        this.currentIndex = idx;
        return key;
      }
    }
    return null;
  }

  /**
   * Chuyển sang key tiếp theo. Dùng khi key hiện tại gặp lỗi 429/403.
   * Trả key mới hoặc null nếu chỉ có 1 key.
   */
  rotateToNext(): string | null {
    if (this.keys.length <= 1) return null;
    this.currentIndex = (this.currentIndex + 1) % this.keys.length;
    return this.keys[this.currentIndex]!;
  }

  /** Thông tin tóm tắt. */
  summary(): { totalKeys: number; currentKeyId: string | null; allKeyIds: string[] } {
    return {
      totalKeys: this.keys.length,
      currentKeyId: this.currentKeyId ?? null,
      allKeyIds: this.allKeyIds,
    };
  }
}
