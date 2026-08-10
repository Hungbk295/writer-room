import { createHash, randomUUID } from 'node:crypto';
import { AppError } from './errors.ts';
import { velocity } from './metrics/stats.ts';
import type { YoutubePort } from './adapters/ytdlp.ts';
import type { LlmPort } from './adapters/llm.ts';
import type { ArtifactStore } from './artifacts.ts';
import type { OperationManager } from './operations.ts';
import type { SpyStore, VideoListRow } from './store.ts';
import { youtubeThumbnailUrl } from './adapters/data-api.ts';
import {
  channelVideosQuerySchema,
  transcriptCohortInputSchema,
  transcriptFetchInputSchema,
  type ChannelVideosQuery,
  type TranscriptCohortInput,
  type TranscriptFetchInput,
  type TranscriptSegment,
  type VideoTranscript,
} from './schema.ts';

function clampConcurrency(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(4, Math.floor(value)));
}

function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function engagement(row: VideoListRow): number {
  if (row.viewCount <= 0) return 0;
  return ((row.likeCount ?? 0) + (row.commentCount ?? 0)) / row.viewCount;
}

function sortKey(orderBy: ChannelVideosQuery['orderBy'], row: VideoListRow, now: Date): number {
  switch (orderBy) {
    case 'views':
      return row.viewCount;
    case 'published_at':
      return row.publishedAt ? Date.parse(row.publishedAt) : 0;
    case 'duration':
      return row.durationSec;
    case 'engagement':
      return engagement(row);
    case 'velocity':
    default:
      return row.publishedAt ? velocity(row.viewCount, row.publishedAt, now) : 0;
  }
}

export class HarvestService {
  /** Số worker fetch transcript song song — lấy từ config.concurrency (1..4). */
  private concurrency: number;

  constructor(
    private readonly store: SpyStore,
    private readonly youtube: YoutubePort,
    private readonly operations: OperationManager,
    private readonly llm: LlmPort,
    private readonly artifacts?: ArtifactStore,
    concurrency = 3,
  ) {
    this.concurrency = clampConcurrency(concurrency);
  }

  setConcurrency(value: number | undefined): void {
    this.concurrency = clampConcurrency(value ?? this.concurrency);
  }

  listChannelVideos(raw: unknown) {
    const query = channelVideosQuerySchema.parse(raw);
    if (!query.channelId && !query.spyRunId) {
      throw new AppError('invalid_input', 'Cần channel_id hoặc spy_run_id');
    }
    const spyRunId = query.spyRunId ?? this.resolveLatestChannelRun(query.channelId!).id;
    const rows = this.store.listVideoSnapshots(spyRunId);
    const now = new Date();
    let filtered = rows.filter((row) => {
      if (query.publishedAfter && (!row.publishedAt || row.publishedAt < query.publishedAfter)) return false;
      if (query.publishedBefore && (!row.publishedAt || row.publishedAt > query.publishedBefore)) return false;
      if (query.minDurationSec !== undefined && row.durationSec < query.minDurationSec) return false;
      if (query.maxDurationSec !== undefined && row.durationSec > query.maxDurationSec) return false;
      if (query.hasTranscript === true && row.transcriptStatus !== 'ok') return false;
      if (query.hasTranscript === false && row.transcriptStatus === 'ok') return false;
      return true;
    });

    filtered = [...filtered].sort((a, b) => {
      const av = sortKey(query.orderBy, a, now);
      const bv = sortKey(query.orderBy, b, now);
      return query.direction === 'asc' ? av - bv : bv - av;
    });

    const total = filtered.length;
    const slice = filtered.slice(query.cursor, query.cursor + query.limit);
    const nextCursor = query.cursor + query.limit < total ? query.cursor + query.limit : null;

    return {
      videos: slice.map((video) => ({
        videoId: video.sourceVideoId,
        title: video.title,
        url: video.canonicalUrl,
        views: video.viewCount,
        publishedAt: video.publishedAt,
        durationSec: video.durationSec,
        velocity: video.publishedAt ? velocity(video.viewCount, video.publishedAt, now) : null,
        engagement: engagement(video),
        transcriptStatus: video.transcriptStatus,
        transcriptSource: video.transcriptSource,
        outlierScore: null as number | null,
        cohort: null as string | null,
      })),
      nextCursor,
      total,
      sampleMeta: {
        scanned: rows.length,
        spyRunId,
        computedAt: now.toISOString(),
        orderBy: query.orderBy,
        note: query.orderBy === 'views'
          ? 'views là số cộng dồn — video cũ thường xếp trên; ưu tiên velocity khi so sánh công bằng'
          : undefined,
      },
    };
  }

  searchTranscripts(input: {
    query: string;
    channelId?: string;
    videoIds?: string[];
    limit?: number;
  }) {
    const q = input.query?.trim();
    if (!q) throw new AppError('invalid_input', 'query không được trống');
    const hits = this.store.searchTranscriptFts({
      query: q,
      sourceVideoIds: input.videoIds,
      channelId: input.channelId,
      limit: input.limit ?? 20,
    });
    return hits.map((hit) => ({
      videoId: hit.sourceVideoId,
      startSec: hit.startSec,
      endSec: hit.endSec,
      snippet: hit.snippet,
      url: `https://youtu.be/${hit.sourceVideoId}?t=${Math.floor(hit.startSec)}`,
    }));
  }

  fetchTranscripts(raw: unknown, ownerSubject = 'local') {
    const input = transcriptFetchInputSchema.parse(raw);
    return this.operations.start({
      kind: 'fetch_transcripts',
      ownerSubject,
      idempotencyKey: input.idempotencyKey,
      request: input,
      work: async (context) => {
        const videoIds = await this.resolveFetchVideoIds(input);
        let fetched = 0;
        let skipped = 0;
        const failed: Array<{ videoId: string; reason: string }> = [];
        const concurrency = this.concurrency;
        let index = 0;
        const workers = Array.from({ length: Math.min(concurrency, videoIds.length) }, async () => {
          while (index < videoIds.length) {
            if (context.signal.aborted) throw new AppError('cancelled', 'Operation đã bị hủy');
            const current = index++;
            const videoId = videoIds[current]!;
            context.progress(current, videoIds.length, `transcript ${current + 1}/${videoIds.length}`);
            try {
              const outcome = await this.fetchOneTranscript(videoId, input.force, context.signal);
              if (outcome === 'fetched') fetched += 1;
              else skipped += 1;
            } catch (error) {
              failed.push({
                videoId,
                reason: error instanceof Error ? error.message : String(error),
              });
            }
          }
        });
        await Promise.all(workers);
        const result = { fetched, skipped, failed, durationMs: 0 };
        return JSON.stringify(result);
      },
    });
  }

  async fetchTranscriptsSync(raw: unknown, signal?: AbortSignal) {
    const input = transcriptFetchInputSchema.parse(raw);
    const started = Date.now();
    const videoIds = await this.resolveFetchVideoIds(input);
    let fetched = 0;
    let skipped = 0;
    const failed: Array<{ videoId: string; reason: string }> = [];
    for (const videoId of videoIds) {
      if (signal?.aborted) throw new AppError('cancelled', 'Operation đã bị hủy');
      try {
        const outcome = await this.fetchOneTranscript(videoId, input.force, signal);
        if (outcome === 'fetched') fetched += 1;
        else skipped += 1;
      } catch (error) {
        failed.push({
          videoId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { fetched, skipped, failed, durationMs: Date.now() - started };
  }

  normalizeTranscripts(raw: { videoIds: string[]; model?: string }, ownerSubject = 'local') {
    const videoIds = raw.videoIds;
    if (!Array.isArray(videoIds) || videoIds.length === 0) {
      throw new AppError('invalid_input', 'video_ids bắt buộc');
    }
    const idempotencyKey = `normalize-${videoIds.slice().sort().join('-')}`.slice(0, 200);
    return this.operations.start({
      kind: 'normalize_transcripts',
      ownerSubject,
      idempotencyKey,
      request: raw,
      work: async (context) => {
        let done = 0;
        for (const videoId of videoIds) {
          if (context.signal.aborted) throw new AppError('cancelled', 'Operation đã bị hủy');
          context.progress(done, videoIds.length, `normalize ${done + 1}/${videoIds.length}`);
          const transcript = this.store.getVideoTranscript(videoId);
          if (!transcript) continue;
          if (transcript.source === 'manual') {
            done += 1;
            continue;
          }
          const segments = this.store.listTranscriptSegmentsBySourceVideoId(videoId);
          const original = segments.map((s) => s.text).join(' ');
          const normalized = await this.normalizeText(original, raw.model);
          this.store.saveNormalizedTranscript(transcript.id, normalized, raw.model ?? 'stub');
          done += 1;
        }
        return `normalized:${done}`;
      },
    });
  }

  transcriptCohort(raw: unknown) {
    const input = transcriptCohortInputSchema.parse(raw);
    const run = this.resolveLatestChannelRun(input.channelId);
    const listed = this.listChannelVideos({
      spyRunId: run.id,
      orderBy: input.orderBy,
      hasTranscript: input.requireTranscript ? true : undefined,
      minDurationSec: input.minDurationSec,
      maxDurationSec: input.maxDurationSec,
      limit: 100,
    });

    let candidates = listed.videos;
    if (input.preferManualSubs) {
      candidates = [
        ...candidates.filter((v) => v.transcriptSource === 'manual'),
        ...candidates.filter((v) => v.transcriptSource !== 'manual'),
      ];
    }
    const selected = candidates.slice(0, input.size);
    if (selected.length < 8) {
      throw new AppError('insufficient_evidence', 'insufficient_sample', {
        details: { have: selected.length, need: 8 },
      });
    }
    const sourceMix = {
      manual: selected.filter((v) => v.transcriptSource === 'manual').length,
      auto: selected.filter((v) => v.transcriptSource === 'auto').length,
      unknown: selected.filter((v) => !v.transcriptSource || v.transcriptSource === 'unknown').length,
    };
    const warnings: string[] = [];
    if (sourceMix.auto > sourceMix.manual) {
      warnings.push('Cohort nghiêng auto-caption — nên chạy spy_transcript_normalize trước Forge');
    }
    return {
      videoIds: selected.map((v) => v.videoId),
      sourceMix,
      warnings,
      spyRunId: run.id,
    };
  }

  private async resolveFetchVideoIds(input: TranscriptFetchInput): Promise<string[]> {
    if (input.videoIds?.length) return [...new Set(input.videoIds)];
    if (!input.channelId && !input.spyRunId) {
      throw new AppError('invalid_input', 'Cần video_ids hoặc channel_id/spy_run_id');
    }
    const listed = this.listChannelVideos({
      channelId: input.channelId,
      spyRunId: input.spyRunId,
      orderBy: input.orderBy,
      limit: input.topN ?? 20,
    });
    return listed.videos.map((v) => v.videoId);
  }

  private async fetchOneTranscript(
    videoId: string,
    force: boolean,
    signal?: AbortSignal,
  ): Promise<'fetched' | 'skipped'> {
    const existing = this.store.getVideoTranscript(videoId);
    if (existing && !force) return 'skipped';

    const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const transcript = await this.youtube.fetchTranscript(canonicalUrl, signal);
    if (transcript.status !== 'ok') {
      throw new AppError('provider_error', transcript.error ?? `Không lấy được transcript ${videoId}`);
    }

    const fullText = transcript.segments.map((s) => s.text).join('\n');
    const hash = contentHash(fullText);
    // Normalised text is derived from the raw transcript, so it only survives a refetch
    // that returned the very same content. Carrying it across a changed fetch would leave
    // every downstream reader on the superseded text.
    const unchanged = existing?.contentHash === hash;
    const record: VideoTranscript = {
      id: existing?.id ?? randomUUID(),
      sourceVideoId: videoId,
      language: transcript.language ?? 'und',
      source: transcript.source,
      contentHash: hash,
      fetchedAt: new Date().toISOString(),
      normalizedText: unchanged ? existing?.normalizedText ?? null : null,
      normalizedAt: unchanged ? existing?.normalizedAt ?? null : null,
      normalizeModel: unchanged ? existing?.normalizeModel ?? null : null,
    };
    this.store.upsertVideoTranscript(record);

    // Attach segments to every known snapshot of this video (idempotent replace).
    const snapshots = this.store.listSnapshotsBySourceVideoId(videoId);
    for (const snapshot of snapshots) {
      const segments: TranscriptSegment[] = transcript.segments.map((segment, index) => ({
        id: randomUUID(),
        videoSnapshotId: snapshot.id,
        videoTranscriptId: record.id,
        index,
        startSec: segment.startSec,
        endSec: segment.endSec,
        text: segment.text,
        source: transcript.source,
        language: transcript.language,
        contentHash: contentHash(segment.text),
      }));
      this.store.replaceTranscriptSegments(
        snapshot.id,
        segments,
      );
      this.store.updateVideoSnapshot(snapshot.id, {
        transcriptStatus: 'ok',
        transcriptSource: transcript.source,
      });
      if (this.artifacts && !snapshot.thumbnail) {
        try {
          const thumb = await this.youtube.thumbnail(youtubeThumbnailUrl(videoId), signal);
          const ref = await this.artifacts.putBuffer(thumb.bytes, {
            mimeType: thumb.mimeType,
            name: `${videoId}-thumb.jpg`,
          });
          this.store.updateVideoSnapshot(snapshot.id, { thumbnail: ref });
        } catch {
          // Thumbnail is best-effort.
        }
      }
    }
    return 'fetched';
  }

  private async normalizeText(original: string, model?: string): Promise<string> {
    // Stub: punctuation-only pass. Real LLM wiring later — must NOT rewrite words (F-Q2).
    void model;
    return original
      .replace(/\s+/g, ' ')
      .replace(/\s+([,.!?…])/g, '$1')
      .trim();
  }

  private resolveLatestChannelRun(channelId: string) {
    const runs = this.store.listSpyRuns('channel', 100);
    const match = runs.find(
      (run) => run.sourceIdentity.includes(channelId) || run.canonicalSource.includes(channelId) || run.id === channelId,
    );
    if (!match) throw new AppError('not_found', 'Không tìm thấy spy run cho kênh');
    return match;
  }
}
