/**
 * Khám phá kênh/video cùng niche.
 *
 * Hai tầng, hai ngân sách:
 *   - search.list  → bucket riêng 100 call/ngày. CHỈ dùng để gieo hạt.
 *   - endpoint ID  → 10.000 unit/ngày. Mở rộng đồ thị và enrich thoải mái.
 *
 * `relatedToVideoId` đã bị YouTube gỡ 07/08/2023 nên không còn API "video liên
 * quan"; đường duy nhất còn rẻ để tìm kênh cùng niche là đồ thị featured
 * channels + public subscriptions.
 */
import { AppError } from './errors.ts';
import type { SpyStore, DiscoverySource } from './store.ts';
import type { YouTubeDataApiPort, SearchHit } from './adapters/data-api.ts';
import type { QuotaLedger } from './quota.ts';
import { buildQueryMatrix, scoreChannelFit, type NicheConfig, type NicheMarket } from './niche.ts';

export interface DiscoverChannelsInput {
  /** Giới hạn số search call được phép tiêu. Bắt buộc — search là tài nguyên khan hiếm. */
  maxQueries: number;
  /** Chỉ chạy market này; bỏ trống = chạy tất cả market trong niche.json. */
  marketId?: string;
  /** Cũng tìm theo type=channel, không chỉ gom kênh từ kết quả video. */
  includeChannelSearch?: boolean;
  /** Chỉ báo cáo kế hoạch và chi phí, không gọi API. */
  dryRun?: boolean;
  publishedAfter?: string;
}

export interface DiscoverVideosInput {
  query: string;
  marketId?: string;
  order?: 'relevance' | 'viewCount' | 'date';
  maxResults?: number;
  publishedAfter?: string;
  dryRun?: boolean;
}

export interface ExpandGraphInput {
  /** Kênh gốc để mở rộng; bỏ trống = lấy từ candidate đã shortlist + kênh đã quét. */
  channelIds?: string[];
  /** Trần số kênh gốc xử lý trong một lần chạy. */
  maxSeeds?: number;
  includeSubscriptions?: boolean;
  dryRun?: boolean;
}

export class DiscoveryService {
  constructor(
    private readonly store: SpyStore,
    private readonly dataApi: YouTubeDataApiPort,
    private readonly quota: QuotaLedger,
  ) {}

  private requireSearch(): NonNullable<YouTubeDataApiPort['search']> {
    if (!this.dataApi.search) {
      throw new AppError('capability_missing', 'Data API adapter không hỗ trợ search');
    }
    return this.dataApi.search.bind(this.dataApi);
  }

  private marketsFor(niche: NicheConfig, marketId?: string): NicheMarket[] {
    if (!marketId) return niche.markets;
    const market = niche.markets.find((m) => m.id === marketId);
    if (!market) {
      throw new AppError('invalid_input', `Market "${marketId}" không có trong niche.json`);
    }
    return [market];
  }

  /**
   * Gieo hạt bằng search.list rồi enrich bằng channels.list.
   * Kết quả của MỖI market được giữ riêng — không trộn khi xếp hạng.
   */
  async discoverChannels(niche: NicheConfig, input: DiscoverChannelsInput) {
    const markets = this.marketsFor(niche, input.marketId);
    const perMarket = Math.max(1, Math.floor(input.maxQueries / markets.length));
    const plan = markets.map((market) => ({
      market: market.id,
      queries: buildQueryMatrix(market, {
        maxQueries: input.includeChannelSearch ? Math.max(1, perMarket - 1) : perMarket,
        orders: ['relevance', 'viewCount'],
      }),
      channelSearch: input.includeChannelSearch === true,
    }));
    const searchCalls = plan.reduce((sum, item) => sum + item.queries.length + (item.channelSearch ? 1 : 0), 0);
    const quotaBefore = this.quota.status();

    if (input.dryRun) {
      return {
        dryRun: true,
        plan,
        estimatedSearchCalls: searchCalls,
        quota: quotaBefore,
        affordable: this.quota.canAfford('search.list', searchCalls),
      };
    }
    if (searchCalls === 0) {
      throw new AppError('invalid_input', 'Không có query nào — niche.json chưa có seedKeywords cho market này');
    }

    const search = this.requireSearch();
    const seen = new Map<string, { market: string; via: DiscoverySource; from: string }>();
    const executed: Array<{ market: string; q: string; order: string; type: string; hits: number }> = [];

    for (const item of plan) {
      const market = markets.find((m) => m.id === item.market)!;
      for (const query of item.queries) {
        this.quota.consume('search.list');
        const result = await search({
          q: query.q,
          type: 'video',
          order: query.order,
          maxResults: 50,
          regionCode: market.regionCode,
          relevanceLanguage: market.relevanceLanguage,
          videoDuration: niche.format.videoDuration === 'any' ? undefined : niche.format.videoDuration,
          publishedAfter: input.publishedAfter,
        });
        executed.push({ market: market.id, q: query.q, order: query.order, type: 'video', hits: result.hits.length });
        collectChannels(result.hits, seen, market.id, 'search_video', query.q);
      }
      if (item.channelSearch) {
        const q = market.seedKeywords.slice(0, 3).join(' ');
        if (q) {
          this.quota.consume('search.list');
          const result = await search({
            q,
            type: 'channel',
            order: 'relevance',
            maxResults: 50,
            regionCode: market.regionCode,
            relevanceLanguage: market.relevanceLanguage,
          });
          executed.push({ market: market.id, q, order: 'relevance', type: 'channel', hits: result.hits.length });
          collectChannels(result.hits, seen, market.id, 'search_channel', q);
        }
      }
    }

    const stored = await this.enrichAndStore(seen, niche, markets);
    return {
      dryRun: false,
      executed,
      searchCallsUsed: executed.length,
      uniqueChannelsFound: seen.size,
      ...stored,
      quota: this.quota.status(),
    };
  }

  /** Tìm video theo một truy vấn cụ thể; kênh của chúng cũng trở thành ứng viên. */
  async discoverVideos(niche: NicheConfig, input: DiscoverVideosInput) {
    const market = input.marketId
      ? this.marketsFor(niche, input.marketId)[0]!
      : niche.markets[0]!;
    if (input.dryRun) {
      return {
        dryRun: true,
        estimatedSearchCalls: 1,
        market: market.id,
        quota: this.quota.status(),
        affordable: this.quota.canAfford('search.list', 1),
      };
    }
    const search = this.requireSearch();
    this.quota.consume('search.list');
    const result = await search({
      q: input.query,
      type: 'video',
      order: input.order ?? 'viewCount',
      maxResults: Math.max(1, Math.min(input.maxResults ?? 50, 50)),
      regionCode: market.regionCode,
      relevanceLanguage: market.relevanceLanguage,
      videoDuration: niche.format.videoDuration === 'any' ? undefined : niche.format.videoDuration,
      publishedAfter: input.publishedAfter,
    });

    const seen = new Map<string, { market: string; via: DiscoverySource; from: string }>();
    collectChannels(result.hits, seen, market.id, 'search_video', input.query);
    const stored = await this.enrichAndStore(seen, niche, [market]);

    return {
      dryRun: false,
      market: market.id,
      query: input.query,
      videos: result.hits
        .filter((hit) => hit.videoId)
        .map((hit) => ({
          videoId: hit.videoId!,
          title: hit.title,
          channelId: hit.channelId,
          channelTitle: hit.channelTitle,
          publishedAt: hit.publishedAt,
          url: `https://www.youtube.com/watch?v=${hit.videoId}`,
        })),
      ...stored,
      quota: this.quota.status(),
    };
  }

  /**
   * BFS một tầng qua featured channels (+ public subscriptions nếu bật).
   * 1–2 unit mỗi kênh gốc, KHÔNG đụng bucket search.
   */
  async expandGraph(niche: NicheConfig, input: ExpandGraphInput = {}) {
    const maxSeeds = Math.max(1, Math.min(input.maxSeeds ?? 25, 200));
    const seeds = input.channelIds?.length
      ? input.channelIds.slice(0, maxSeeds)
      : this.defaultSeeds(maxSeeds);

    if (seeds.length === 0) {
      throw new AppError('invalid_input', 'Không có kênh gốc nào — hãy shortlist ứng viên hoặc truyền channel_ids');
    }

    const callsPerSeed = input.includeSubscriptions ? 2 : 1;
    if (input.dryRun) {
      return {
        dryRun: true,
        seeds,
        estimatedUnits: seeds.length * callsPerSeed,
        quota: this.quota.status(),
        affordable: this.quota.canAfford('channelSections.list', seeds.length * callsPerSeed),
      };
    }
    if (!this.dataApi.fetchFeaturedChannels) {
      throw new AppError('capability_missing', 'Data API adapter không hỗ trợ channelSections');
    }

    const seen = new Map<string, { market: string; via: DiscoverySource; from: string }>();
    const perSeed: Array<{ seed: string; featured: number; subscriptions: number | null }> = [];

    for (const seed of seeds) {
      this.quota.consume('channelSections.list');
      const featured = await this.dataApi.fetchFeaturedChannels(seed);
      for (const channelId of featured) {
        if (!seen.has(channelId)) seen.set(channelId, { market: '', via: 'featured', from: seed });
      }

      let subsCount: number | null = null;
      if (input.includeSubscriptions && this.dataApi.fetchPublicSubscriptions) {
        this.quota.consume('subscriptions.list');
        const subs = await this.dataApi.fetchPublicSubscriptions(seed);
        // null = kênh ẩn subscriptions (403). Đó là mặc định của YouTube, không phải lỗi.
        subsCount = subs === null ? null : subs.length;
        for (const channelId of subs ?? []) {
          if (!seen.has(channelId)) seen.set(channelId, { market: '', via: 'subscription', from: seed });
        }
      }
      perSeed.push({ seed, featured: featured.length, subscriptions: subsCount });
    }

    const stored = await this.enrichAndStore(seen, niche, niche.markets);
    return {
      dryRun: false,
      seedsProcessed: seeds.length,
      perSeed,
      uniqueChannelsFound: seen.size,
      ...stored,
      quota: this.quota.status(),
    };
  }

  /**
   * Kênh gốc mặc định: ứng viên đã shortlist, rồi tới ứng viên đã quét.
   * KHÔNG lấy từ bảng `channels` — `channel_id` ở đó là sourceIdentity đã
   * canonical hoá viết thường, mà channel ID của YouTube phân biệt hoa thường
   * nên không khôi phục được ID thật từ đó. Bảng candidate giữ ID gốc.
   */
  private defaultSeeds(limit: number): string[] {
    const shortlisted = this.store.listCandidates({ status: 'shortlisted', limit }).map((c) => c.channelId);
    if (shortlisted.length >= limit) return shortlisted.slice(0, limit);
    const scanned = this.store.listCandidates({ status: 'scanned', limit }).map((c) => c.channelId);
    return [...new Set([...shortlisted, ...scanned])].slice(0, limit);
  }

  /**
   * Enrich bằng channels.list (batch 50, 1 unit/lô) rồi chấm fit và lưu.
   * Bỏ qua kênh đã có trong bảng candidate để không tiêu quota lặp lại.
   */
  private async enrichAndStore(
    seen: Map<string, { market: string; via: DiscoverySource; from: string }>,
    niche: NicheConfig,
    markets: NicheMarket[],
  ) {
    const fresh = [...seen.keys()].filter((id) => !this.store.hasCandidate(id));
    const skippedKnown = seen.size - fresh.length;
    if (fresh.length === 0) {
      return { created: 0, skippedKnown, excluded: 0, enrichUnits: 0, topCandidates: [] as unknown[] };
    }

    const batches: string[][] = [];
    for (let offset = 0; offset < fresh.length; offset += 50) batches.push(fresh.slice(offset, offset + 50));

    let created = 0;
    let excluded = 0;
    const scored: Array<{ channelId: string; title: string | null; market: string; fitScore: number; subscriberCount: number | null }> = [];

    for (const batch of batches) {
      this.quota.consume('channels.list');
      const stats = await this.dataApi.fetchChannelStatistics(batch);
      for (const channelId of batch) {
        const meta = seen.get(channelId)!;
        const channel = stats.get(channelId);
        const market = markets.find((m) => m.id === meta.market) ?? markets[0];
        const fit = scoreChannelFit(
          {
            channelId,
            title: channel?.title ?? null,
            subscriberCount: channel?.subscriberCount ?? null,
            videoCount: channel?.videoCount ?? null,
            viewCount: channel?.viewCount ?? null,
          },
          niche,
          market,
        );
        if (fit.excluded) {
          excluded += 1;
          continue;
        }
        const result = this.store.upsertCandidate({
          channelId,
          title: channel?.title ?? null,
          market: meta.market || market?.id || null,
          discoveredVia: meta.via,
          discoveredFrom: meta.from,
          subscriberCount: channel?.subscriberCount ?? null,
          videoCount: channel?.videoCount ?? null,
          viewCount: channel?.viewCount ?? null,
          fitScore: fit.score,
          fitReasons: fit.reasons,
        });
        if (result.created) created += 1;
        scored.push({
          channelId,
          title: channel?.title ?? null,
          market: meta.market || market?.id || '',
          fitScore: fit.score,
          subscriberCount: channel?.subscriberCount ?? null,
        });
      }
    }

    return {
      created,
      skippedKnown,
      excluded,
      enrichUnits: batches.length,
      topCandidates: scored.sort((a, b) => b.fitScore - a.fitScore).slice(0, 15),
    };
  }
}

function collectChannels(
  hits: readonly SearchHit[],
  seen: Map<string, { market: string; via: DiscoverySource; from: string }>,
  market: string,
  via: DiscoverySource,
  from: string,
): void {
  for (const hit of hits) {
    if (!hit.channelId) continue;
    if (!seen.has(hit.channelId)) seen.set(hit.channelId, { market, via, from });
  }
}
