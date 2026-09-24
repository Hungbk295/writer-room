/**
 * QuotaCountingDataApi — decorator bọc YouTubeDataApiPort.
 *
 * Gọi quota.consume(op) TRƯỚC mỗi request, đảm bảo mọi API call đều được ghi
 * vào sổ quota. AcquisitionService (scan/videosByIds/channelsByIds/comments)
 * trước đây không consume — decorator này vá lỗ hổng đó.
 *
 * assertDataApi() được gọi trước consume để không đốt ledger khi key rỗng.
 *
 * Multi-key: khi KeyPool được cung cấp, dùng consumeForKey thay vì consume,
 * và tự rotate key khi gặp quota_exceeded.
 */
import { AppError } from '../errors.ts';
import type { QuotaLedger, QuotaOp, KeyPool } from '../quota.ts';
import { keyId } from '../quota.ts';
import type {
  YouTubeDataApiPort,
  VideoStatistics,
  ChannelStatistics,
  SearchHit,
  SearchInput,
  PlaylistVideoItem,
  CommentThread,
} from './data-api.ts';

export class QuotaCountingDataApi implements YouTubeDataApiPort {
  private keyPool: KeyPool | null = null;
  /** Callback to switch the underlying adapter's API key when rotating. */
  private switchKey: ((key: string) => void) | null = null;

  constructor(
    private readonly inner: YouTubeDataApiPort,
    private readonly quota: QuotaLedger,
    /** Trả về true khi key đã được cấu hình. */
    private readonly hasKey: () => boolean,
  ) {}

  /** Bật multi-key rotation. */
  setKeyPool(pool: KeyPool, switchKeyFn: (key: string) => void): void {
    this.keyPool = pool;
    this.switchKey = switchKeyFn;
  }

  private assertKey(): void {
    if (!this.hasKey()) {
      throw new AppError('capability_missing', 'Chưa cấu hình youtubeDataApiKey — không chạy được Data API');
    }
  }

  /**
   * Consume quota — nếu có KeyPool thì dùng per-key, nếu không thì aggregate.
   * Khi per-key hết quota, tự tìm key khác còn quota.
   */
  private consumeQuota(op: QuotaOp, calls = 1): void {
    if (!this.keyPool || this.keyPool.isEmpty) {
      // Single-key mode — backward compatible
      this.quota.consume(op, calls);
      return;
    }

    // Multi-key mode: tìm key còn quota
    const availableKey = this.keyPool.pickAvailableKey(this.quota, op);
    if (!availableKey) {
      // Tất cả key đều hết quota
      throw new AppError(
        'quota_exceeded',
        `Tất cả ${this.keyPool.size} API key đều hết quota cho ${op}. Key IDs: ${this.keyPool.allKeyIds.join(', ')}.`,
        { retryable: false },
      );
    }

    // Switch adapter sang key được chọn
    this.switchKey?.(availableKey);

    // Consume per-key (cũng cập nhật aggregate)
    this.quota.consumeForKey(keyId(availableKey), op, calls);
  }

  /**
   * Tự chia lô 50 id RỒI mới gọi inner từng lô một.
   *
   * Trước đây decorator charge `ceil(n/50)` MỘT LẦN rồi giao cả 51 id cho
   * adapter tự chia — nếu request thứ nhất chết 503 thì thực tế chỉ một HTTP
   * request được gửi trong khi sổ đã ghi 2. Sổ nói dối theo hướng "đã tiêu
   * nhiều hơn thực tế", loop tự hãm sớm, và không ai đối chiếu được vì con số
   * không gắn với request nào cả.
   *
   * Chia lô ở đây làm mỗi lần `consume` ứng với ĐÚNG một HTTP request mà adapter
   * sắp gửi (adapter nhận ≤50 id thì phát đúng 1 request). Charge vẫn nằm TRƯỚC
   * request tương ứng, nên một transport chết vẫn ghi đúng phần đã thử.
   */
  private static batches<T>(items: readonly T[], size = 50): T[][] {
    const out: T[][] = [];
    for (let offset = 0; offset < items.length; offset += size) {
      out.push(items.slice(offset, offset + size));
    }
    return out;
  }

  async fetchVideoStatistics(videoIds: readonly string[]): Promise<Map<string, VideoStatistics>> {
    if (videoIds.length === 0) return new Map();
    this.assertKey();
    const result = new Map<string, VideoStatistics>();
    for (const batch of QuotaCountingDataApi.batches(videoIds)) {
      this.consumeQuota('videos.list', 1);
      const part = await this.inner.fetchVideoStatistics(batch);
      for (const [key, value] of part) result.set(key, value);
    }
    return result;
  }

  async fetchChannelStatistics(channelIds: readonly string[]): Promise<Map<string, ChannelStatistics>> {
    if (channelIds.length === 0) return new Map();
    this.assertKey();
    const result = new Map<string, ChannelStatistics>();
    for (const batch of QuotaCountingDataApi.batches(channelIds)) {
      this.consumeQuota('channels.list', 1);
      const part = await this.inner.fetchChannelStatistics(batch);
      for (const [key, value] of part) result.set(key, value);
    }
    return result;
  }

  async search(input: SearchInput): Promise<{ hits: SearchHit[]; nextPageToken: string | null }> {
    this.assertKey();
    if (!this.inner.search) {
      throw new AppError('capability_missing', 'Inner adapter không hỗ trợ search');
    }
    this.consumeQuota('search.list', 1);
    return this.inner.search(input);
  }

  async fetchFeaturedChannels(channelId: string): Promise<string[]> {
    this.assertKey();
    if (!this.inner.fetchFeaturedChannels) return [];
    this.consumeQuota('channelSections.list', 1);
    return this.inner.fetchFeaturedChannels(channelId);
  }

  async fetchPublicSubscriptions(channelId: string, maxResults?: number): Promise<string[] | null> {
    this.assertKey();
    if (!this.inner.fetchPublicSubscriptions) return null;
    this.consumeQuota('subscriptions.list', 1);
    return this.inner.fetchPublicSubscriptions(channelId, maxResults);
  }

  async fetchVideoComments(input: {
    videoId?: string;
    channelId?: string;
    maxResults?: number;
    order?: 'relevance' | 'time';
    includeReplies?: boolean;
  }): Promise<CommentThread[]> {
    this.assertKey();
    if (!this.inner.fetchVideoComments) return [];
    this.consumeQuota('commentThreads.list', 1);
    return this.inner.fetchVideoComments(input);
  }

  async listUploadsPlaylistItems(
    uploadsPlaylistId: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<PlaylistVideoItem[]> {
    if (limit <= 0) return [];
    this.assertKey();
    if (!this.inner.listUploadsPlaylistItems) return [];
    this.consumeQuota('playlistItems.list', 1);
    const items = await this.inner.listUploadsPlaylistItems(uploadsPlaylistId, limit, signal);
    const extraPages = Math.max(0, Math.ceil(items.length / 50) - 1);
    if (extraPages > 0) this.consumeQuota('playlistItems.list', extraPages);
    return items;
  }

  /** Pass-through — không có quota cost vì dùng forHandle param trên channels.list. */
  async resolveChannelByHandle(handle: string): Promise<ChannelStatistics | null> {
    this.assertKey();
    if (!this.inner.resolveChannelByHandle) return null;
    this.consumeQuota('channels.list', 1);
    return this.inner.resolveChannelByHandle(handle);
  }
}
