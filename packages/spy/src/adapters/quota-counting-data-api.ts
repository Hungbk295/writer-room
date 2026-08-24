/**
 * QuotaCountingDataApi — decorator bọc YouTubeDataApiPort.
 *
 * Gọi quota.consume(op) TRƯỚC mỗi request, đảm bảo mọi API call đều được ghi
 * vào sổ quota. AcquisitionService (scan/videosByIds/channelsByIds/comments)
 * trước đây không consume — decorator này vá lỗ hổng đó.
 *
 * assertDataApi() được gọi trước consume để không đốt ledger khi key rỗng.
 */
import { AppError } from '../errors.ts';
import type { QuotaLedger } from '../quota.ts';
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
  constructor(
    private readonly inner: YouTubeDataApiPort,
    private readonly quota: QuotaLedger,
    /** Trả về true khi key đã được cấu hình. */
    private readonly hasKey: () => boolean,
  ) {}

  private assertKey(): void {
    if (!this.hasKey()) {
      throw new AppError('capability_missing', 'Chưa cấu hình youtubeDataApiKey — không chạy được Data API');
    }
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
      this.quota.consume('videos.list', 1);
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
      this.quota.consume('channels.list', 1);
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
    // consume SAU khi chắc chắn call sẽ xảy ra — ghi sổ cho một request không
    // bao giờ gửi đi cũng sai như không ghi sổ cho một request đã gửi.
    this.quota.consume('search.list', 1);
    return this.inner.search(input);
  }

  async fetchFeaturedChannels(channelId: string): Promise<string[]> {
    this.assertKey();
    if (!this.inner.fetchFeaturedChannels) return [];
    this.quota.consume('channelSections.list', 1);
    return this.inner.fetchFeaturedChannels(channelId);
  }

  async fetchPublicSubscriptions(channelId: string, maxResults?: number): Promise<string[] | null> {
    this.assertKey();
    if (!this.inner.fetchPublicSubscriptions) return null;
    this.quota.consume('subscriptions.list', 1);
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
    this.quota.consume('commentThreads.list', 1);
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
    // playlistItems.list trả tối đa 50 item/request và adapter tự phân trang bên
    // trong (token nằm trong đó, decorator không chia lô được như videos/channels).
    //
    // Charge 1 TRƯỚC — ứng với request đầu tiên chắc chắn sẽ gửi. Các trang sau
    // chỉ được ghi khi chúng đã thực sự trả về dữ liệu: `ceil(items/50) - 1`.
    // KHÔNG charge `ceil(limit/50)` trước như bản cũ: xin 500 mà playlist chỉ có
    // 12 video thì sổ ghi 10 unit cho 1 request — sổ nói dối theo hướng "đã tiêu
    // nhiều hơn thực tế" và loop tự hãm sớm.
    //
    // Sai số còn lại, có biên và cố ý chấp nhận ở P0: nếu chết GIỮA lúc phân
    // trang thì phần trang đã thử mà chưa trả về bị thiếu tối đa 1 unit. Muốn
    // chính xác tuyệt đối thì phải cho pageToken lộ ra ở port để decorator tự
    // lái từng trang — chưa đáng đổi API cho đường duy nhất dùng >50 (scan).
    this.quota.consume('playlistItems.list', 1);
    const items = await this.inner.listUploadsPlaylistItems(uploadsPlaylistId, limit, signal);
    const extraPages = Math.max(0, Math.ceil(items.length / 50) - 1);
    if (extraPages > 0) this.quota.consume('playlistItems.list', extraPages);
    return items;
  }

  /** Pass-through — không có quota cost vì dùng forHandle param trên channels.list. */
  async resolveChannelByHandle(handle: string): Promise<ChannelStatistics | null> {
    this.assertKey();
    if (!this.inner.resolveChannelByHandle) return null;
    this.quota.consume('channels.list', 1);
    return this.inner.resolveChannelByHandle(handle);
  }
}
