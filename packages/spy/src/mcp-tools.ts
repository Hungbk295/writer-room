import { randomUUID } from 'node:crypto';
import { AppError } from './errors.ts';
import type { SpyService } from './index.ts';

/** Spy MCP tools. Disabled only when WRITER_ROOM_SPY_ENABLED=0. */
export function isSpyEnabled(): boolean {
  return process.env.WRITER_ROOM_SPY_ENABLED !== '0';
}

export interface SpyToolContext {
  subject: string;
  scopes: Set<string>;
}

export interface SpyToolDef {
  name: string;
  description: string;
  requiredScopes: string[];
  outputLimitBytes: number;
  handler: (args: Record<string, unknown>, context: SpyToolContext) => unknown | Promise<unknown>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AppError('invalid_input', `${name} phải là string`);
  }
  return value;
}

function integer(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = value === undefined ? fallback : value;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new AppError('invalid_input', `Số nguyên phải trong ${minimum}..${maximum}`);
  }
  return parsed;
}

function stringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new AppError('invalid_input', `${name} phải là mảng string`);
  return value.map((item) => text(item, name));
}

function assertScopes(context: SpyToolContext, required: string[]): void {
  for (const scope of required) {
    if (!context.scopes.has(scope)) {
      throw new AppError('forbidden', `Thiếu scope ${scope}`);
    }
  }
}

function truncateOutput(value: unknown, limitBytes: number): unknown {
  const json = JSON.stringify(value);
  if (json.length <= limitBytes) return value;
  return {
    truncated: true,
    bytes: json.length,
    limitBytes,
    preview: json.slice(0, Math.min(limitBytes, 4_000)),
  };
}

/** Paged transcript reader shared by transcript-only and visual material tools. */
function readTranscriptBatch(spy: SpyService, args: Record<string, unknown>) {
  const videoSnapshotIds = stringList(args['video_snapshot_ids'], 'video_snapshot_ids');
  if (videoSnapshotIds.length < 1 || videoSnapshotIds.length > 5) {
    throw new AppError('invalid_input', 'video_snapshot_ids phải có 1..5 phần tử');
  }
  const cursors = args['cursors'];
  if (cursors !== undefined && (typeof cursors !== 'object' || cursors === null || Array.isArray(cursors))) {
    throw new AppError('invalid_input', 'cursors phải là object { video_snapshot_id: cursor }');
  }
  const cursorById = (cursors ?? {}) as Record<string, unknown>;
  const limit = integer(args['limit_per_video'], 50, 1, 50);
  // Keep enough headroom that the generic output-limit wrapper never discards
  // cursors/segments. A deferred video is explicit and can be retried alone.
  let remainingBytes = 48_000;
  const deferredVideoSnapshotIds: string[] = [];
  const videos = videoSnapshotIds.map((videoSnapshotId) => {
    const cursor = integer(cursorById[videoSnapshotId], 0, 0, 100_000);
    const page = spy.getTranscript(videoSnapshotId, cursor, limit);
    const segments = [] as typeof page.segments;
    for (const segment of page.segments) {
      const segmentBytes = JSON.stringify(segment).length;
      if (segments.length > 0 && segmentBytes > remainingBytes) break;
      segments.push(segment);
      remainingBytes -= segmentBytes;
    }
    if (segments.length === 0 && page.segments.length > 0) deferredVideoSnapshotIds.push(videoSnapshotId);
    const consumed = segments.length;
    return {
      videoSnapshotId,
      segments,
      meta: page.meta,
      nextCursor: consumed < page.segments.length ? cursor + consumed : page.nextCursor,
    };
  });
  return { videos, deferredVideoSnapshotIds };
}

/**
 * Spy / Harvest MCP tools.
 * Returns [] when parked so they never appear on Writer/control surfaces.
 */
export function spyTools(spy: SpyService): SpyToolDef[] {
  if (!isSpyEnabled()) return [];

  const wrap = (def: SpyToolDef): SpyToolDef => ({
    ...def,
    handler: async (args, context) => {
      assertScopes(context, def.requiredScopes);
      const result = await def.handler(args, context);
      return truncateOutput(result, def.outputLimitBytes);
    },
  });

  return [
    wrap({
      name: 'spy_channel_start',
      description: 'Chạy Channel Spy cho URL kênh/playlist. depth: metadata|transcript.',
      requiredScopes: ['spy.start'],
      outputLimitBytes: 8_192,
      handler: (args, context) => spy.channelSpy({
        url: text(args['url'], 'url'),
        topN: integer(args['top_n'], 5, 1, 20),
        selectionMode: args['selection_mode'] === 'latest' ? 'latest' : 'popular',
        scanLimit: integer(args['scan_limit'], 60, 1, 500),
        rankBy: args['rank_by'] === 'views' ? 'views' : 'velocity',
        minDurationSec: integer(args['min_duration_sec'], 60, 0, 7200),
        maxDurationSec: typeof args['max_duration_sec'] === 'number'
          ? integer(args['max_duration_sec'], 0, 0, 72_000)
          : undefined,
        publishedAfter: typeof args['published_after'] === 'string' ? args['published_after'] : undefined,
        publishedBefore: typeof args['published_before'] === 'string' ? args['published_before'] : undefined,
        depth: args['depth'] === 'metadata' || args['depth'] === 'transcript'
          ? args['depth']
          : 'transcript',
        idempotencyKey: typeof args['idempotency_key'] === 'string'
          ? args['idempotency_key']
          : `mcp-channel-${randomUUID()}`,
      }, context.subject),
    }),
    wrap({
      name: 'spy_video_start',
      description: 'Spy đúng một video YouTube từ URL (watch/shorts/youtu.be). depth: metadata|transcript.',
      requiredScopes: ['spy.start'],
      outputLimitBytes: 8_192,
      handler: (args, context) => spy.videoSpy({
        url: text(args['url'], 'url'),
        depth: args['depth'] === 'metadata' || args['depth'] === 'transcript'
          ? args['depth']
          : 'transcript',
        idempotencyKey: typeof args['idempotency_key'] === 'string'
          ? args['idempotency_key']
          : `mcp-video-${randomUUID()}`,
      }, context.subject),
    }),
    wrap({
      name: 'spy_get_status',
      description: 'Đọc trạng thái operation.',
      requiredScopes: ['spy.read'],
      outputLimitBytes: 16_384,
      handler: (args) => spy.getStatus(text(args['operation_id'] ?? args['run_id'], 'operation_id')),
    }),
    wrap({
      name: 'spy_wait',
      description: 'Chờ operation (trần 600s — harvest có thể lâu).',
      requiredScopes: ['spy.read'],
      outputLimitBytes: 16_384,
      handler: async (args) => {
        const seconds = integer(args['max_wait_seconds'], 30, 1, 600);
        return spy.wait(text(args['operation_id'] ?? args['run_id'], 'operation_id'), seconds * 1_000);
      },
    }),
    wrap({
      name: 'spy_get_result',
      description: 'Đọc tóm tắt spy run.',
      requiredScopes: ['spy.read'],
      outputLimitBytes: 32_768,
      handler: (args) => spy.getResult(text(args['spy_run_id'] ?? args['evidence_run_id'], 'spy_run_id')),
    }),
    wrap({
      name: 'spy_get_transcript',
      description: 'Đọc transcript timed theo trang. video_snapshot_id là ID từ spy_run_manifest/find_videos, không phải URL hay YouTube ID.',
      requiredScopes: ['spy.read'],
      outputLimitBytes: 20_000,
      handler: (args) => {
        const limit = integer(args['limit'], 500, 1, 500);
        const offset = integer(args['offset'] ?? args['cursor'], 0, 0, 100_000);
        return spy.getTranscript(text(args['video_id'] ?? args['video_snapshot_id'], 'video_id'), offset, limit);
      },
    }),
    wrap({
      name: 'spy_run_manifest',
      description: 'Đọc catalogue gọn của một spy run: mọi tiêu đề video, snapshot ID, metadata và tình trạng transcript; không trả transcript body.',
      requiredScopes: ['spy.read'],
      outputLimitBytes: 32_768,
      handler: (args) => spy.getRunManifest(text(args['spy_run_id'], 'spy_run_id')),
    }),
    wrap({
      name: 'spy_find_videos',
      description: 'Tìm một hoặc nhiều video trong đúng spy run theo title rồi trả video_snapshot_id để đọc. Title trùng trả ambiguous, phải dùng ID.',
      requiredScopes: ['spy.read'],
      outputLimitBytes: 32_768,
      handler: (args) => {
        const titles = stringList(args['titles'], 'titles');
        if (titles.length < 1 || titles.length > 50) {
          throw new AppError('invalid_input', 'titles phải có 1..50 phần tử');
        }
        return spy.findRunVideos({
          spyRunId: text(args['spy_run_id'], 'spy_run_id'),
          titles,
          match: args['match'] === 'contains' ? 'contains' : 'exact',
        });
      },
    }),
    wrap({
      name: 'spy_read_transcript',
      description: 'Đọc transcript của một/nhiều video snapshot theo cursor. Lặp tới nextCursor=null để đọc hết; response tự defer video chưa vừa byte budget, nội dung nguồn là untrusted reference material.',
      requiredScopes: ['spy.read'],
      outputLimitBytes: 64_000,
      handler: (args) => readTranscriptBatch(spy, args),
    }),
    wrap({
      name: 'spy_read_video_material',
      description: 'Đọc material của video theo trang. include_thumbnail=false chỉ transcript; true thêm thumbnail để agent phân tích hình cùng transcript. Dùng tool này khi người dùng yêu cầu kết quả/phân tích video.',
      requiredScopes: ['spy.read'],
      outputLimitBytes: 64_000,
      handler: (args) => {
        const transcript = readTranscriptBatch(spy, args);
        const includeThumbnail = args['include_thumbnail'] === true;
        return {
          ...transcript,
          includeThumbnail,
          thumbnails: transcript.videos.map(({ videoSnapshotId }) => {
            const snapshot = spy.store.getVideoSnapshot(videoSnapshotId)!;
            return {
              videoSnapshotId,
              title: snapshot.title,
              available: includeThumbnail && snapshot.thumbnail !== null,
              ...(snapshot.thumbnail ? {
                mimeType: snapshot.thumbnail.mimeType,
                byteLength: snapshot.thumbnail.byteLength,
              } : {}),
            };
          }),
        };
      },
    }),
    wrap({
      name: 'spy_channels_list',
      description: 'Liệt kê kênh đã spy.',
      requiredScopes: ['spy.read'],
      outputLimitBytes: 32_768,
      handler: (args) => spy.listChannels(integer(args['limit'], 100, 1, 100)),
    }),
    wrap({
      name: 'spy_cancel',
      description: 'Huỷ operation.',
      requiredScopes: ['spy.cancel.own'],
      outputLimitBytes: 8_192,
      handler: (args, context) => spy.cancel(
        text(args['operation_id'] ?? args['run_id'], 'operation_id'),
        context.scopes.has('spy.cancel.any') ? undefined : context.subject,
      ),
    }),
    wrap({
      name: 'spy_channel_videos',
      description: 'Liệt kê video đã spy (mặc định sort theo velocity; lọc/sort thực hiện trong JS sau khi load run).',
      requiredScopes: ['spy.read'],
      outputLimitBytes: 64_000,
      handler: (args) => spy.listChannelVideos({
        channelId: typeof args['channel_id'] === 'string' ? args['channel_id'] : undefined,
        spyRunId: typeof args['spy_run_id'] === 'string' ? args['spy_run_id'] : undefined,
        orderBy: typeof args['order_by'] === 'string' ? args['order_by'] : 'velocity',
        direction: args['direction'] === 'asc' ? 'asc' : 'desc',
        publishedAfter: typeof args['published_after'] === 'string' ? args['published_after'] : undefined,
        publishedBefore: typeof args['published_before'] === 'string' ? args['published_before'] : undefined,
        minDurationSec: typeof args['min_duration_sec'] === 'number' ? args['min_duration_sec'] : undefined,
        maxDurationSec: typeof args['max_duration_sec'] === 'number' ? args['max_duration_sec'] : undefined,
        hasTranscript: typeof args['has_transcript'] === 'boolean' ? args['has_transcript'] : undefined,
        limit: integer(args['limit'], 50, 1, 100),
        cursor: integer(args['cursor'], 0, 0, 100_000),
      }),
    }),
    wrap({
      name: 'spy_transcript_fetch',
      description: 'Fetch transcript-only, idempotent theo sourceVideoId.',
      requiredScopes: ['spy.start'],
      outputLimitBytes: 16_384,
      handler: (args, context) => {
        const videoIds = Array.isArray(args['video_ids'])
          ? args['video_ids'].map((id) => text(id, 'video_id'))
          : undefined;
        return spy.fetchTranscripts({
          videoIds,
          channelId: typeof args['channel_id'] === 'string' ? args['channel_id'] : undefined,
          spyRunId: typeof args['spy_run_id'] === 'string' ? args['spy_run_id'] : undefined,
          topN: typeof args['top_n'] === 'number' ? args['top_n'] : undefined,
          orderBy: typeof args['order_by'] === 'string' ? args['order_by'] : 'velocity',
          force: args['force'] === true,
          idempotencyKey: typeof args['idempotency_key'] === 'string'
            ? args['idempotency_key']
            : `mcp-transcript-${randomUUID()}`,
        }, context.subject);
      },
    }),
    wrap({
      name: 'spy_transcript_search',
      description: 'Tìm trong transcript (FTS5).',
      requiredScopes: ['spy.read'],
      outputLimitBytes: 32_768,
      handler: (args) => {
        const videoIds = Array.isArray(args['video_ids'])
          ? args['video_ids'].map((id) => text(id, 'video_id'))
          : undefined;
        return spy.searchTranscripts({
          query: text(args['query'], 'query'),
          channelId: typeof args['channel_id'] === 'string' ? args['channel_id'] : undefined,
          videoIds,
          limit: integer(args['limit'], 20, 1, 100),
        });
      },
    }),
    wrap({
      name: 'spy_transcript_normalize',
      description: 'Chuẩn hoá dấu câu/chính tả transcript auto; không ghi đè bản gốc.',
      requiredScopes: ['spy.start'],
      outputLimitBytes: 8_192,
      handler: (args, context) => {
        const videoIds = Array.isArray(args['video_ids'])
          ? args['video_ids'].map((id) => text(id, 'video_id'))
          : [];
        return spy.normalizeTranscripts({
          videoIds,
          model: typeof args['model'] === 'string' ? args['model'] : undefined,
        }, context.subject);
      },
    }),
    wrap({
      name: 'spy_transcript_cohort',
      description: 'Chọn cohort transcript đồng nhất cho Forge (≥8).',
      requiredScopes: ['spy.read'],
      outputLimitBytes: 16_384,
      handler: (args) => spy.transcriptCohort({
        channelId: text(args['channel_id'], 'channel_id'),
        size: integer(args['size'], 10, 1, 50),
        orderBy: typeof args['order_by'] === 'string' ? args['order_by'] : 'velocity',
        requireTranscript: args['require_transcript'] !== false,
        preferManualSubs: args['prefer_manual_subs'] !== false,
        minDurationSec: typeof args['min_duration_sec'] === 'number' ? args['min_duration_sec'] : undefined,
        maxDurationSec: typeof args['max_duration_sec'] === 'number' ? args['max_duration_sec'] : undefined,
      }),
    }),
    wrap({
      name: 'spy_export_source_pack',
      description: 'Xuất Source Pack (UNTRUSTED) từ spy run — đưa vào create_run cho Writer.',
      requiredScopes: ['spy.read'],
      outputLimitBytes: 120_000,
      handler: (args) => {
        const videoIds = Array.isArray(args['video_ids'])
          ? args['video_ids'].map((id) => text(id, 'video_id'))
          : undefined;
        return spy.exportSourcePack({
          spyRunId: text(args['spy_run_id'], 'spy_run_id'),
          videoIds,
          limit: integer(args['limit'], 5, 1, 20),
          orderBy: args['order_by'] === 'views' || args['order_by'] === 'published_at'
            ? args['order_by']
            : 'velocity',
          preferNormalized: args['prefer_normalized'] !== false,
        });
      },
    }),
    wrap({
      name: 'spy_channel_profile',
      description: 'Chân dung kênh tổng hợp.',
      requiredScopes: ['spy.read'],
      outputLimitBytes: 64_000,
      handler: (args) => spy.channelProfile(text(args['channel_id'] ?? args['spy_run_id'], 'channel_id')),
    }),
    wrap({
      name: 'spy_channel_outliers',
      description: 'Video outlier của kênh (modified z-score theo age cohort). Trả cả số mục không chấm được.',
      requiredScopes: ['spy.read'],
      outputLimitBytes: 64_000,
      handler: (args) => spy.channelOutliers(
        text(args['channel_id'] ?? args['spy_run_id'], 'channel_id'),
        typeof args['min_score'] === 'number' ? args['min_score'] : 1.5,
      ),
    }),
    wrap({
      name: 'spy_title_patterns',
      description: 'Title features và token lift.',
      requiredScopes: ['spy.read'],
      outputLimitBytes: 64_000,
      handler: (args) => spy.titlePatterns(text(args['channel_id'] ?? args['spy_run_id'], 'channel_id')),
    }),
    wrap({
      name: 'spy_hook_taxonomy',
      description: 'Hook analysis theo video hoặc kênh.',
      requiredScopes: ['spy.analyze'],
      outputLimitBytes: 64_000,
      handler: async (args) => {
        const videoIds = Array.isArray(args['video_ids'])
          ? args['video_ids'].map((id) => text(id, 'video_id'))
          : undefined;
        return spy.hookTaxonomy(text(args['channel_id'] ?? args['spy_run_id'], 'channel_id'), videoIds);
      },
    }),
    wrap({
      name: 'spy_video_metrics',
      description: 'Metrics một video.',
      requiredScopes: ['spy.read'],
      outputLimitBytes: 64_000,
      handler: (args) => spy.videoMetrics(
        text(args['video_id'], 'video_id'),
        typeof args['spy_run_id'] === 'string' ? args['spy_run_id'] : undefined,
      ),
    }),
    wrap({
      name: 'spy_video_structure',
      description: 'Structure beats và speech/cut windows.',
      requiredScopes: ['spy.analyze'],
      outputLimitBytes: 64_000,
      handler: (args) => spy.videoStructure(
        text(args['video_id'], 'video_id'),
        typeof args['spy_run_id'] === 'string' ? args['spy_run_id'] : undefined,
      ),
    }),
    wrap({
      name: 'spy_topic_clusters',
      description: 'Topic clusters của kênh.',
      requiredScopes: ['spy.analyze'],
      outputLimitBytes: 64_000,
      handler: (args) => spy.topicClusters(text(args['channel_id'] ?? args['spy_run_id'], 'channel_id')),
    }),
    wrap({
      name: 'spy_voice_profile',
      description: 'Voice profile kênh hoặc video.',
      requiredScopes: ['spy.analyze'],
      outputLimitBytes: 64_000,
      handler: (args) => spy.voiceProfile(text(args['channel_id'] ?? args['video_id'] ?? args['spy_run_id'], 'channel_id')),
    }),
    wrap({
      name: 'spy_compare',
      description: 'So sánh nhiều video.',
      requiredScopes: ['spy.read'],
      outputLimitBytes: 64_000,
      handler: (args) => {
        const videoIds = Array.isArray(args['video_ids'])
          ? args['video_ids'].map((id) => text(id, 'video_id'))
          : [];
        const dimensions = Array.isArray(args['dimensions'])
          ? args['dimensions'].map((d) => text(d, 'dimension'))
          : [];
        return spy.compare(videoIds, dimensions);
      },
    }),
    wrap({
      name: 'spy_channel_diff',
      description: 'So hai kênh: delta/ratio từng chỉ số + token tiêu đề riêng của mỗi bên.',
      requiredScopes: ['spy.read'],
      outputLimitBytes: 64_000,
      handler: (args) => spy.channelDiff(
        text(args['channel_id_a'], 'channel_id_a'),
        text(args['channel_id_b'], 'channel_id_b'),
      ),
    }),
    wrap({
      name: 'spy_videos_by_ids',
      description: 'Tra cứu metadata + stats nhiều video theo id (≤50). Không cần spy run trước. ~1 quota unit.',
      requiredScopes: ['spy.read'],
      outputLimitBytes: 64_000,
      handler: (args) => spy.videosByIds(stringList(args['video_ids'], 'video_ids')),
    }),
    wrap({
      name: 'spy_channels_by_ids',
      description: 'Tra cứu metadata + stats nhiều kênh theo id hoặc @handle (≤50). ~1 quota unit.',
      requiredScopes: ['spy.read'],
      outputLimitBytes: 64_000,
      handler: (args) => spy.channelsByIds(stringList(args['channel_ids'], 'channel_ids')),
    }),
    wrap({
      name: 'spy_video_comments',
      description: 'Comment thread của một video hoặc cả kênh (commentThreads.list, ~1 quota unit).',
      requiredScopes: ['spy.read'],
      outputLimitBytes: 64_000,
      handler: (args) => spy.videoComments({
        videoId: typeof args['video_id'] === 'string' ? args['video_id'] : undefined,
        channelId: typeof args['channel_id'] === 'string' ? args['channel_id'] : undefined,
        maxResults: integer(args['max_results'], 20, 1, 100),
        order: args['order'] === 'time' ? 'time' : 'relevance',
        includeReplies: args['include_replies'] !== false,
      }),
    }),
    // ---------------------------------------------------------------------
    // Discovery — xem plan/claude/spy-discovery-design.md
    // Bucket search: 100 call/ngày. Bucket general: 10.000 unit/ngày.
    // ---------------------------------------------------------------------
    wrap({
      name: 'spy_quota_status',
      description: 'Còn bao nhiêu quota search (100/ngày) và general (10.000 unit/ngày), reset lúc nào. 0 chi phí.',
      requiredScopes: ['spy.read'],
      outputLimitBytes: 16_384,
      handler: () => spy.quotaStatus(),
    }),
    wrap({
      name: 'spy_niche_get',
      description: 'Đọc file chiến lược niche.json (trả template nếu chưa có).',
      requiredScopes: ['spy.read'],
      outputLimitBytes: 32_768,
      handler: () => spy.getNiche(),
    }),
    wrap({
      name: 'spy_niche_set',
      description: 'Ghi đè niche.json. Truyền toàn bộ object config (markets, seedKeywords, scoring, notes).',
      requiredScopes: ['spy.start'],
      outputLimitBytes: 32_768,
      handler: (args) => spy.setNiche(args['config'] ?? args),
    }),
    wrap({
      name: 'spy_niche_score_fit',
      description: 'Chấm thử độ hợp niche cho một kênh (0-100 + lý do). Không tốn quota, dùng để hiệu chỉnh trọng số.',
      requiredScopes: ['spy.read'],
      outputLimitBytes: 16_384,
      handler: (args) => spy.scoreFit({
        channelId: text(args['channel_id'], 'channel_id'),
        title: typeof args['title'] === 'string' ? args['title'] : undefined,
        description: typeof args['description'] === 'string' ? args['description'] : undefined,
        subscriberCount: typeof args['subscriber_count'] === 'number' ? args['subscriber_count'] : undefined,
        videoCount: typeof args['video_count'] === 'number' ? args['video_count'] : undefined,
        viewCount: typeof args['view_count'] === 'number' ? args['view_count'] : undefined,
        country: typeof args['country'] === 'string' ? args['country'] : undefined,
        marketId: typeof args['market_id'] === 'string' ? args['market_id'] : undefined,
      }),
    }),
    wrap({
      name: 'spy_discover_channels',
      description: 'Tìm kênh cùng niche bằng search.list theo ma trận từ khoá của niche.json. TỐN bucket search (100 call/ngày) — luôn chạy dry_run trước.',
      requiredScopes: ['spy.start'],
      outputLimitBytes: 64_000,
      handler: (args) => spy.discoverChannels({
        maxQueries: integer(args['max_queries'], 4, 1, 100),
        marketId: typeof args['market_id'] === 'string' ? args['market_id'] : undefined,
        includeChannelSearch: args['include_channel_search'] === true,
        publishedAfter: typeof args['published_after'] === 'string' ? args['published_after'] : undefined,
        dryRun: args['dry_run'] === true,
      }),
    }),
    wrap({
      name: 'spy_discover_videos',
      description: 'Tìm video theo một truy vấn; kênh của chúng cũng thành ứng viên. TỐN 1 call bucket search.',
      requiredScopes: ['spy.start'],
      outputLimitBytes: 64_000,
      handler: (args) => spy.discoverVideos({
        query: text(args['query'], 'query'),
        marketId: typeof args['market_id'] === 'string' ? args['market_id'] : undefined,
        order: args['order'] === 'date' || args['order'] === 'relevance' ? args['order'] : 'viewCount',
        maxResults: integer(args['max_results'], 50, 1, 50),
        publishedAfter: typeof args['published_after'] === 'string' ? args['published_after'] : undefined,
        dryRun: args['dry_run'] === true,
      }),
    }),
    wrap({
      name: 'spy_expand_graph',
      description: 'Mở rộng đồ thị kênh qua featured channels (+ public subscriptions). 1-2 unit/kênh gốc, KHÔNG tốn bucket search.',
      requiredScopes: ['spy.start'],
      outputLimitBytes: 64_000,
      handler: (args) => spy.expandGraph({
        channelIds: Array.isArray(args['channel_ids']) ? stringList(args['channel_ids'], 'channel_ids') : undefined,
        maxSeeds: integer(args['max_seeds'], 25, 1, 200),
        includeSubscriptions: args['include_subscriptions'] === true,
        dryRun: args['dry_run'] === true,
      }),
    }),
    wrap({
      name: 'spy_candidates_list',
      description: 'Danh sách kênh ứng viên đã phát hiện, xếp theo điểm hợp niche. 0 chi phí.',
      requiredScopes: ['spy.read'],
      outputLimitBytes: 120_000,
      handler: (args) => spy.listCandidates({
        status: typeof args['status'] === 'string' ? args['status'] : undefined,
        market: typeof args['market'] === 'string' ? args['market'] : undefined,
        discoveredVia: typeof args['discovered_via'] === 'string' ? args['discovered_via'] : undefined,
        minFitScore: typeof args['min_fit_score'] === 'number' ? args['min_fit_score'] : undefined,
        minSubscribers: typeof args['min_subscribers'] === 'number' ? args['min_subscribers'] : undefined,
        maxSubscribers: typeof args['max_subscribers'] === 'number' ? args['max_subscribers'] : undefined,
        limit: integer(args['limit'], 50, 1, 200),
        cursor: integer(args['cursor'], 0, 0, 100_000),
      }),
    }),
    wrap({
      name: 'spy_candidates_decide',
      description: 'Đánh dấu ứng viên: shortlisted | rejected | new. Kênh đã reject không bị discovery sau ghi đè về new.',
      requiredScopes: ['spy.start'],
      outputLimitBytes: 32_768,
      handler: (args) => {
        const status = text(args['status'], 'status');
        if (status !== 'shortlisted' && status !== 'rejected' && status !== 'new') {
          throw new AppError('invalid_input', 'status phải là shortlisted | rejected | new');
        }
        return spy.decideCandidates(stringList(args['channel_ids'], 'channel_ids'), status);
      },
    }),
    wrap({
      name: 'spy_scan_candidates',
      description: 'Quét sâu hàng loạt kênh đã shortlist (~21 unit/kênh cho 500 video). Có dry_run và chặn khi thiếu quota.',
      requiredScopes: ['spy.start'],
      outputLimitBytes: 64_000,
      handler: (args, context) => spy.scanCandidates({
        channelIds: Array.isArray(args['channel_ids']) ? stringList(args['channel_ids'], 'channel_ids') : undefined,
        maxChannels: integer(args['max_channels'], 10, 1, 100),
        scanLimit: integer(args['scan_limit'], 60, 1, 500),
        depth: args['depth'] === 'transcript' ? 'transcript' : 'metadata',
        dryRun: args['dry_run'] === true,
      }, context.subject),
    }),
    wrap({
      name: 'spy_corpus_videos',
      description: 'Tìm video xuyên TOÀN BỘ corpus đã quét (không giới hạn một run). Lọc theo title, transcript, view, thời lượng, ngày. 0 quota.',
      requiredScopes: ['spy.read'],
      outputLimitBytes: 120_000,
      handler: (args) => spy.corpusVideos({
        titleQuery: typeof args['title_query'] === 'string' ? args['title_query'] : undefined,
        transcriptQuery: typeof args['transcript_query'] === 'string' ? args['transcript_query'] : undefined,
        channelIds: Array.isArray(args['channel_ids']) ? stringList(args['channel_ids'], 'channel_ids') : undefined,
        minViews: typeof args['min_views'] === 'number' ? args['min_views'] : undefined,
        maxViews: typeof args['max_views'] === 'number' ? args['max_views'] : undefined,
        minDurationSec: typeof args['min_duration_sec'] === 'number' ? args['min_duration_sec'] : undefined,
        maxDurationSec: typeof args['max_duration_sec'] === 'number' ? args['max_duration_sec'] : undefined,
        publishedAfter: typeof args['published_after'] === 'string' ? args['published_after'] : undefined,
        publishedBefore: typeof args['published_before'] === 'string' ? args['published_before'] : undefined,
        hasTranscript: typeof args['has_transcript'] === 'boolean' ? args['has_transcript'] : undefined,
        minOutlierScore: typeof args['min_outlier_score'] === 'number' ? args['min_outlier_score'] : undefined,
        minViewPerSub: typeof args['min_view_per_sub'] === 'number' ? args['min_view_per_sub'] : undefined,
        orderBy: typeof args['order_by'] === 'string'
          ? args['order_by'] as 'views' | 'velocity' | 'published_at' | 'duration' | 'engagement'
          : 'velocity',
        direction: args['direction'] === 'asc' ? 'asc' : 'desc',
        limit: integer(args['limit'], 50, 1, 200),
        cursor: integer(args['cursor'], 0, 0, 100_000),
      }),
    }),
    wrap({
      name: 'spy_channel_momentum',
      description: 'Đà tăng trưởng của một kênh đã quét: video/view trong N ngày gần nhất, nhịp đăng, momentum ratio, view/sub, tuổi kênh. 0 quota. KHÔNG phải tăng trưởng subscriber.',
      requiredScopes: ['spy.read'],
      outputLimitBytes: 32_768,
      handler: (args) => spy.channelMomentum(
        text(args['channel_id'], 'channel_id'),
        integer(args['window_days'], 30, 1, 365),
      ),
    }),
    wrap({
      name: 'spy_corpus_channels',
      description: 'Thống kê từng kênh trong corpus đã quét: số video, view trung bình, khoảng đăng, tỉ lệ có transcript. 0 quota.',
      requiredScopes: ['spy.read'],
      outputLimitBytes: 64_000,
      handler: (args) => spy.corpusChannels({
        minVideos: typeof args['min_videos'] === 'number' ? args['min_videos'] : undefined,
        minAvgViews: typeof args['min_avg_views'] === 'number' ? args['min_avg_views'] : undefined,
        limit: integer(args['limit'], 100, 1, 200),
      }),
    }),
    wrap({
      name: 'spy_competitors_list',
      description: 'Danh sách kênh đối thủ đang theo dõi (state cục bộ, không cần OAuth).',
      requiredScopes: ['spy.read'],
      outputLimitBytes: 32_768,
      handler: (args) => spy.listCompetitors(text(args['owner_channel_id'] ?? args['channel_id'], 'owner_channel_id')),
    }),
    wrap({
      name: 'spy_competitors_update',
      description: 'Thêm/bớt kênh đối thủ theo dõi. follow và unfollow không được trùng nhau.',
      requiredScopes: ['spy.start'],
      outputLimitBytes: 32_768,
      handler: (args) => spy.updateCompetitors({
        ownerChannelId: text(args['owner_channel_id'] ?? args['channel_id'], 'owner_channel_id'),
        follow: Array.isArray(args['follow']) ? stringList(args['follow'], 'follow') : [],
        unfollow: Array.isArray(args['unfollow']) ? stringList(args['unfollow'], 'unfollow') : [],
        note: typeof args['note'] === 'string' ? args['note'] : undefined,
      }),
    }),
  ];
}

export function spyToolHandlers(spy: SpyService): Record<string, SpyToolDef['handler']> {
  const tools = spyTools(spy);
  return Object.fromEntries(tools.map((tool) => [tool.name, tool.handler]));
}
