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
import { keyId, QUOTA_COST } from '../quota.ts';
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

  /** true khi lỗi cho biết ĐÚNG KEY này không dùng được cho request kế tiếp —
   * hoặc vì hết quota (retry key khác, key này tự hồi phục ngày mai) hoặc vì
   * key sai/chưa bật API (retry key khác, key này KHÔNG tự hồi phục).
   * Đây là điều kiện DUY NHẤT được phép kích hoạt rotate-sang-key-khác; mọi
   * lỗi khác (503, network, capability_missing, invalid_input...) phải ném
   * thẳng lên trên — rotate vào chúng chỉ đốt quota key kế tiếp một cách vô ích.
   */
  private static isKeyLevelError(error: unknown): error is AppError {
    return error instanceof AppError && (error.code === 'quota_exceeded' || error.code === 'unauthorized');
  }

  /**
   * Chạy một request qua key pool, tự rotate khi Google báo ĐÚNG KEY hiện tại
   * hết quota / sai key (xem classifyGoogleApiError trong data-api.ts).
   *
   * Trước đây (consumeQuota) chỉ chọn key theo BỘ ĐẾM PHÍA CLIENT rồi gọi
   * `inner.xxx()` ở ngoài hàm này — nếu bộ đếm lệch với quota thật của Google
   * (key vẫn còn "8 lượt" theo sổ nhưng Google đã 403 thật), request seCHẾT ở
   * `inner.xxx()`, lỗi đó rơi thẳng ra `globalVideoSearch`'s catch và fallback
   * sang yt-dlp NGAY — không có gì thử key khác. Vòng lặp dưới đây thử LẦN
   * LƯỢT các key mà client-side counter nói là còn quota; mỗi lần request thật
   * sự thất bại vì lỗi cấp-key, nó đánh dấu key đó hết quota (markKeyExhausted
   * — ghi vào store nên sống sót qua restart) rồi thử key kế tiếp. Chỉ khi
   * không còn key nào (theo client-side counter, sau khi đã đánh dấu các key
   * vừa fail) mới ném lỗi "hết quota" để caller fallback yt-dlp.
   */
  private async withRotation<T>(op: QuotaOp, run: () => Promise<T>): Promise<T> {
    if (!this.keyPool || this.keyPool.isEmpty) {
      // Single-key mode — backward compatible: không có key khác để rotate.
      this.quota.consume(op, 1);
      return run();
    }

    const bucket = QUOTA_COST[op].bucket;
    const triedKeyIds: string[] = [];
    const totalKeys = this.keyPool.size;

    for (let attempt = 0; attempt < totalKeys; attempt++) {
      const availableKey = this.keyPool.pickAvailableKey(this.quota, op);
      if (!availableKey) break;
      const kid = keyId(availableKey);
      if (triedKeyIds.includes(kid)) break; // đã thử & fail — tránh vòng lặp vô hạn

      this.switchKey?.(availableKey);
      this.quota.consumeForKey(kid, op, 1);
      triedKeyIds.push(kid);

      try {
        return await run();
      } catch (error) {
        if (QuotaCountingDataApi.isKeyLevelError(error)) {
          this.quota.markKeyExhausted(kid, bucket);
          continue; // thử key kế tiếp
        }
        throw error; // lỗi không liên quan đến key (503, network,...) — không rotate
      }
    }

    throw new AppError(
      'quota_exceeded',
      `Tất cả ${totalKeys} API key đều hết quota/không dùng được cho ${op}. Đã thử: ${
        triedKeyIds.length ? triedKeyIds.join(', ') : '(không có key nào còn quota theo bộ đếm phía client)'
      }.`,
      { retryable: false, details: { op, triedKeyIds, allKeysExhausted: true, totalKeys } },
    );
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
      const part = await this.withRotation('videos.list', () => this.inner.fetchVideoStatistics(batch));
      for (const [key, value] of part) result.set(key, value);
    }
    return result;
  }

  async fetchChannelStatistics(channelIds: readonly string[]): Promise<Map<string, ChannelStatistics>> {
    if (channelIds.length === 0) return new Map();
    this.assertKey();
    const result = new Map<string, ChannelStatistics>();
    for (const batch of QuotaCountingDataApi.batches(channelIds)) {
      const part = await this.withRotation('channels.list', () => this.inner.fetchChannelStatistics(batch));
      for (const [key, value] of part) result.set(key, value);
    }
    return result;
  }

  async search(input: SearchInput): Promise<{ hits: SearchHit[]; nextPageToken: string | null }> {
    this.assertKey();
    if (!this.inner.search) {
      throw new AppError('capability_missing', 'Inner adapter không hỗ trợ search');
    }
    return this.withRotation('search.list', () => this.inner.search!(input));
  }

  async fetchFeaturedChannels(channelId: string): Promise<string[]> {
    this.assertKey();
    if (!this.inner.fetchFeaturedChannels) return [];
    return this.withRotation('channelSections.list', () => this.inner.fetchFeaturedChannels!(channelId));
  }

  async fetchPublicSubscriptions(channelId: string, maxResults?: number): Promise<string[] | null> {
    this.assertKey();
    if (!this.inner.fetchPublicSubscriptions) return null;
    return this.withRotation('subscriptions.list', () => this.inner.fetchPublicSubscriptions!(channelId, maxResults));
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
    return this.withRotation('commentThreads.list', () => this.inner.fetchVideoComments!(input));
  }

  async listUploadsPlaylistItems(
    uploadsPlaylistId: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<PlaylistVideoItem[]> {
    if (limit <= 0) return [];
    this.assertKey();
    if (!this.inner.listUploadsPlaylistItems) return [];
    const items = await this.withRotation(
      'playlistItems.list',
      () => this.inner.listUploadsPlaylistItems!(uploadsPlaylistId, limit, signal),
    );
    const extraPages = Math.max(0, Math.ceil(items.length / 50) - 1);
    if (extraPages > 0) {
      // Các trang thêm này đã được adapter tự phân trang lấy về TRONG một lần
      // gọi ở trên — không thể rotate lại vì request đã hoàn tất; chỉ ghi sổ
      // cho đúng key vừa dùng thành công.
      const kid = this.keyPool && !this.keyPool.isEmpty ? this.keyPool.currentKeyId : undefined;
      if (kid) this.quota.consumeForKey(kid, 'playlistItems.list', extraPages);
      else this.quota.consume('playlistItems.list', extraPages);
    }
    return items;
  }

  /** Pass-through — không có quota cost vì dùng forHandle param trên channels.list. */
  async resolveChannelByHandle(handle: string): Promise<ChannelStatistics | null> {
    this.assertKey();
    if (!this.inner.resolveChannelByHandle) return null;
    return this.withRotation('channels.list', () => this.inner.resolveChannelByHandle!(handle));
  }
}
