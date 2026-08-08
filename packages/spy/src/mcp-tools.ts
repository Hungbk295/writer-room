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
      description: 'Đọc transcript timed theo trang.',
      requiredScopes: ['spy.read'],
      outputLimitBytes: 20_000,
      handler: (args) => {
        const limit = integer(args['limit'], 500, 1, 500);
        const offset = integer(args['offset'] ?? args['cursor'], 0, 0, 100_000);
        return spy.getTranscript(text(args['video_id'] ?? args['video_snapshot_id'], 'video_id'), offset, limit);
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
      description: 'Liệt kê video đã spy, sort ở SQL (mặc định velocity).',
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
      description: 'Video outlier của kênh.',
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
      description: 'So hai kênh.',
      requiredScopes: ['spy.read'],
      outputLimitBytes: 64_000,
      handler: (args) => spy.channelDiff(
        text(args['channel_id_a'], 'channel_id_a'),
        text(args['channel_id_b'], 'channel_id_b'),
      ),
    }),
  ];
}

export function spyToolHandlers(spy: SpyService): Record<string, SpyToolDef['handler']> {
  const tools = spyTools(spy);
  return Object.fromEntries(tools.map((tool) => [tool.name, tool.handler]));
}
