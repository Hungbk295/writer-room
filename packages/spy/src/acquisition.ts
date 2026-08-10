import { createHash, randomUUID } from 'node:crypto';
import { AppError } from './errors.ts';
import {
  canonicalChannelUrl,
  rankVideos,
} from './evidence/index.ts';
import {
  computeChannelMetrics,
  computeVideoMetrics,
  type ChannelVideoInput,
} from './metrics/index.ts';
import type { ArtifactStore } from './artifacts.ts';
import { youtubeThumbnailUrl, type YouTubeDataApiPort } from './adapters/data-api.ts';
import type { YoutubePort, YoutubeVideoInfo } from './adapters/ytdlp.ts';
import type { OperationManager } from './operations.ts';
import type { SpyStore } from './store.ts';
import {
  channelSpyInputSchema,
  type ChannelSpyInput,
  type StartedOp,
  type TranscriptSegment,
  type VideoSnapshot,
} from './schema.ts';

function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export class AcquisitionService {
  /** Lý do lần enrich kênh gần nhất không lấy được subscriber — để chẩn đoán, không nuốt lỗi. */
  lastChannelEnrichError: string | null = null;

  constructor(
    private readonly store: SpyStore,
    private readonly artifacts: ArtifactStore,
    private readonly youtube: YoutubePort,
    private readonly dataApi: YouTubeDataApiPort,
    private readonly operations: OperationManager,
    _defaultSampling?: unknown,
  ) {}

  setDefaultSampling(_sampling?: unknown): void {
    // Frame sampling removed with Deep video; kept for API compatibility.
  }

  channelSpy(raw: unknown, ownerSubject = 'local'): StartedOp {
    const input = channelSpyInputSchema.parse(raw);
    const source = canonicalChannelUrl(input.url);
    let spyRunId = '';
    const operation = this.operations.start({
      kind: 'acquire_channel',
      ownerSubject,
      idempotencyKey: input.idempotencyKey,
      request: input,
      initialize: (created) => {
        const run = this.store.createSpyRun({
          operationId: created.id,
          kind: 'channel',
          canonicalSource: source.canonicalUrl,
          sourceIdentity: source.sourceIdentity,
          config: input,
          scanLimit: input.scanLimit,
          topN: input.topN,
        });
        spyRunId = run.id;
        return run.id;
      },
      work: async (context) => {
        const run = this.store.getSpyRunByOperation(context.operationId)!;
        spyRunId = run.id;
        this.store.updateSpyRun(run.id, { status: 'running' });
        return this.runWork(run.id, context.signal, async () => {
          context.progress(0, input.scanLimit, 'listing channel');
          const listed = await this.listChannelVideos(source.canonicalUrl, input, context.signal);
          // Soft pre-filter only: keep unknown duration (0) until after enrichSnapshots.
          const candidates = listed.filter((v) => {
            if (v.durationSec > 0 && v.durationSec < input.minDurationSec) return false;
            if (
              input.maxDurationSec !== undefined
              && v.durationSec > 0
              && v.durationSec > input.maxDurationSec
            ) {
              return false;
            }
            if (input.publishedAfter && v.publishedAt && v.publishedAt < input.publishedAfter) return false;
            if (input.publishedBefore && v.publishedAt && v.publishedAt > input.publishedBefore) return false;
            return true;
          });
          if (candidates.length === 0) {
            throw new AppError('insufficient_evidence', 'Channel không có video phù hợp bộ lọc');
          }
          const depth = input.depth;
          for (let index = 0; index < candidates.length; index++) {
            context.progress(index, candidates.length, `metadata ${index + 1}/${candidates.length}`);
            await this.insertMetadataSnapshot(run.id, candidates[index]!, index + 1);
          }
          await this.enrichSnapshots(run.id, candidates.map((v) => v.sourceVideoId));
          await this.enrichChannel(run.sourceIdentity, candidates);

          if (depth === 'metadata') {
            await this.finishRun(run.id, run.sourceIdentity);
            return run.id;
          }

          // Re-merge enriched duration/views from store before ranking
          // (flat-list / API may have had duration 0 until enrichSnapshots).
          const enriched = candidates.map((info) => {
            const snap = this.store.getVideoSnapshotBySourceId(run.id, info.sourceVideoId);
            return {
              ...info,
              durationSec: snap?.durationSec && snap.durationSec > 0 ? snap.durationSec : info.durationSec,
              viewCount: snap?.viewCount && snap.viewCount > 0 ? snap.viewCount : info.viewCount,
              publishedAt: snap?.publishedAt ?? info.publishedAt,
              thumbnailUrl: info.thumbnailUrl || youtubeThumbnailUrl(info.sourceVideoId),
            } satisfies YoutubeVideoInfo;
          });

          let selected = rankVideos(enriched, {
            topN: input.topN,
            minDurationSec: input.minDurationSec,
            rankBy: input.rankBy,
          });
          // Fallback: if duration filter wiped the set, still capture topN by rank without duration gate.
          if (selected.length === 0 && enriched.length > 0) {
            selected = rankVideos(enriched, {
              topN: input.topN,
              minDurationSec: 0,
              rankBy: input.rankBy,
            });
          }

          for (let index = 0; index < selected.length; index++) {
            if (context.signal.aborted) throw new AppError('cancelled', 'Operation đã bị hủy');
            context.progress(index, selected.length, `capturing video ${index + 1}/${selected.length}`);
            const info = selected[index]!;
            const snapshot = this.store.getVideoSnapshotBySourceId(run.id, info.sourceVideoId)!;
            await this.captureTranscriptAndThumb(snapshot, info, context.signal);
          }
          await this.finishRun(run.id, run.sourceIdentity);
          return run.id;
        });
      },
    });
    spyRunId ||= this.store.getSpyRunByOperation(operation.id)?.id ?? '';
    return { operationId: operation.id, spyRunId, status: operation.status };
  }

  private async listChannelVideos(
    canonicalUrl: string,
    input: ChannelSpyInput,
    signal: AbortSignal,
  ): Promise<YoutubeVideoInfo[]> {
    const viaApi = await this.listChannelViaDataApi(canonicalUrl, input.scanLimit, signal);
    if (viaApi) return viaApi;

    const listed = await this.youtube.listChannel(canonicalUrl, input.scanLimit, signal);
    const inspected: YoutubeVideoInfo[] = [];
    for (const candidate of listed) {
      if (signal.aborted) throw new AppError('cancelled', 'Operation đã bị hủy');
      try {
        inspected.push(await this.youtube.inspectVideo(candidate.canonicalUrl, signal));
      } catch (error) {
        if (signal.aborted) throw error;
        inspected.push(candidate);
      }
    }
    return inspected;
  }

  private async listChannelViaDataApi(
    canonicalUrl: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<YoutubeVideoInfo[] | null> {
    const resolve = this.dataApi.resolveChannelByHandle?.bind(this.dataApi);
    const listItems = this.dataApi.listUploadsPlaylistItems?.bind(this.dataApi);
    if (!resolve || !listItems) return null;

    try {
      const handleMatch = /youtube\.com\/@([^/]+)/i.exec(canonicalUrl);
      const channelIdMatch = /youtube\.com\/channel\/([^/]+)/i.exec(canonicalUrl);
      let channel = handleMatch
        ? await resolve(handleMatch[1]!)
        : null;
      if (!channel && channelIdMatch) {
        const stats = await this.dataApi.fetchChannelStatistics([channelIdMatch[1]!]);
        channel = stats.get(channelIdMatch[1]!) ?? null;
      }
      if (!channel?.uploadsPlaylistId) return null;

      const items = await listItems(channel.uploadsPlaylistId, limit, signal);
      if (items.length === 0) return null;
      const stats = await this.dataApi.fetchVideoStatistics(items.map((i) => i.videoId));
      return items.map((item) => {
        const api = stats.get(item.videoId);
        return {
          sourceVideoId: item.videoId,
          canonicalUrl: `https://www.youtube.com/watch?v=${item.videoId}`,
          title: api?.title ?? item.title ?? item.videoId,
          channelTitle: api?.channelTitle ?? channel!.title ?? '',
          channelId: api?.channelId ?? channel!.channelId,
          viewCount: api?.viewCount ?? 0,
          durationSec: api?.durationSec ?? 0,
          publishedAt: api?.publishedAt ?? item.publishedAt,
          thumbnailUrl: api?.thumbnailUrl ?? youtubeThumbnailUrl(item.videoId),
        } satisfies YoutubeVideoInfo;
      });
    } catch {
      return null; // soft degrade to yt-dlp
    }
  }

  private async insertMetadataSnapshot(spyRunId: string, info: YoutubeVideoInfo, rank: number): Promise<VideoSnapshot> {
    const snapshot: VideoSnapshot = {
      id: randomUUID(),
      spyRunId,
      sourceVideoId: info.sourceVideoId,
      canonicalUrl: info.canonicalUrl,
      title: info.title,
      channelTitle: info.channelTitle,
      rank,
      viewCount: info.viewCount,
      likeCount: null,
      commentCount: null,
      durationSec: info.durationSec,
      publishedAt: info.publishedAt,
      tags: [],
      transcriptStatus: 'skipped',
      transcriptSource: null,
      frameStatus: 'skipped',
      thumbnail: null,
      createdAt: new Date().toISOString(),
    };
    this.store.insertVideoSnapshot(snapshot);
    return snapshot;
  }

  private async enrichSnapshots(spyRunId: string, videoIds: string[]): Promise<void> {
    const stats = await this.dataApi.fetchVideoStatistics(videoIds);
    for (const videoId of videoIds) {
      const snapshot = this.store.getVideoSnapshotBySourceId(spyRunId, videoId);
      if (!snapshot) continue;
      const api = stats.get(videoId);
      if (!api) continue;
      this.store.updateVideoSnapshot(snapshot.id, {
        likeCount: api.likeCount,
        commentCount: api.commentCount,
        publishedAt: api.publishedAt ?? snapshot.publishedAt,
        tags: api.tags,
        ...(api.viewCount != null && api.viewCount > 0 ? { viewCount: api.viewCount } : {}),
      });
      if (api.durationSec != null && api.durationSec > 0 && snapshot.durationSec === 0) {
        this.store.patchVideoDuration(snapshot.id, api.durationSec);
      }
    }
  }

  private async captureTranscriptAndThumb(
    snapshot: VideoSnapshot,
    info: YoutubeVideoInfo,
    signal: AbortSignal,
  ): Promise<void> {
    this.store.updateVideoSnapshot(snapshot.id, {
      transcriptStatus: 'pending',
      frameStatus: 'skipped',
    });
    const thumbUrl = info.thumbnailUrl || youtubeThumbnailUrl(info.sourceVideoId);
    try {
      const thumbnail = await this.youtube.thumbnail(thumbUrl, signal);
      const ref = await this.artifacts.putBuffer(thumbnail.bytes, {
        mimeType: thumbnail.mimeType,
        name: `${info.sourceVideoId}-thumb.jpg`,
      });
      this.store.updateVideoSnapshot(snapshot.id, { thumbnail: ref });
    } catch {
      // Thumbnail is best-effort; transcript still proceeds.
    }
    const existing = this.store.getVideoTranscript(info.sourceVideoId);
    if (existing) {
      const segments = this.store.listTranscriptSegmentsBySourceVideoId(info.sourceVideoId);
      if (segments.length > 0) {
        this.store.replaceTranscriptSegments(
          snapshot.id,
          segments.map((segment, index) => ({
            ...segment,
            id: randomUUID(),
            videoSnapshotId: snapshot.id,
            index,
          })),
        );
        this.store.updateVideoSnapshot(snapshot.id, {
          transcriptStatus: 'ok',
          transcriptSource: existing.source,
          frameStatus: 'skipped',
        });
        return;
      }
    }
    const transcript = await this.youtube.fetchTranscript(info.canonicalUrl, signal);
    if (transcript.status === 'ok') {
      const hash = contentHash(transcript.segments.map((s) => s.text).join('\n'));
      const recordId = existing?.id ?? randomUUID();
      this.store.upsertVideoTranscript({
        id: recordId,
        sourceVideoId: info.sourceVideoId,
        language: transcript.language ?? 'und',
        source: transcript.source,
        contentHash: hash,
        fetchedAt: new Date().toISOString(),
        normalizedText: null,
        normalizedAt: null,
        normalizeModel: null,
      });
      const segments: TranscriptSegment[] = transcript.segments.map((segment, index) => ({
        id: randomUUID(),
        videoSnapshotId: snapshot.id,
        videoTranscriptId: recordId,
        index,
        startSec: segment.startSec,
        endSec: segment.endSec,
        text: segment.text,
        source: transcript.source,
        language: transcript.language,
        contentHash: contentHash(segment.text),
      }));
      this.store.insertTranscriptSegments(segments);
      this.store.updateVideoSnapshot(snapshot.id, {
        transcriptStatus: 'ok',
        transcriptSource: transcript.source,
        frameStatus: 'skipped',
      });
    } else {
      this.store.updateVideoSnapshot(snapshot.id, {
        transcriptStatus: transcript.status,
        transcriptSource: transcript.source === 'unknown' ? null : transcript.source,
        frameStatus: 'skipped',
      });
    }
  }

  private async enrichChannel(scopeId: string, videos: readonly YoutubeVideoInfo[]): Promise<void> {
    const title = videos[0]?.channelTitle || scopeId;
    const youtubeChannelId = videos.find((v) => v.channelId)?.channelId ?? null;
    let subscriberCount: number | null = null;
    let videoCount: number | null = null;
    let totalViewCount: number | null = null;
    // Trước đây lỗi ở đây bị nuốt hoàn toàn (catch rỗng) nên subscriber_count âm
    // thầm là NULL và mọi metric cần subscriber vĩnh viễn 'unavailable' mà không
    // ai biết vì sao. Giờ ghi lại lý do để chẩn đoán được.
    if (youtubeChannelId) {
      try {
        const stats = await this.dataApi.fetchChannelStatistics([youtubeChannelId]);
        const channel = stats.get(youtubeChannelId);
        if (channel) {
          subscriberCount = channel.subscriberCount;
          videoCount = channel.videoCount;
          totalViewCount = channel.viewCount;
        } else {
          this.lastChannelEnrichError = `channels.list không trả kết quả cho ${youtubeChannelId} (thiếu API key?)`;
        }
      } catch (error) {
        this.lastChannelEnrichError = error instanceof Error ? error.message : String(error);
      }
    } else {
      this.lastChannelEnrichError = 'không xác định được YouTube channelId từ metadata video';
    }
    if (this.lastChannelEnrichError && subscriberCount === null) {
      console.warn(`[spy] enrichChannel(${scopeId}) không lấy được subscriber: ${this.lastChannelEnrichError}`);
    }
    this.store.upsertChannel({
      channelId: scopeId,
      title,
      subscriberCount,
      videoCount,
      totalViewCount,
      fetchedAt: new Date().toISOString(),
    });
  }

  private async finishRun(spyRunId: string, channelScopeId?: string): Promise<void> {
    const run = this.store.getSpyRun(spyRunId)!;
    const videos = this.store.listVideoSnapshots(spyRunId);
    const channelVideos: ChannelVideoInput[] = videos.map((video) => ({
      videoId: video.sourceVideoId,
      viewCount: video.viewCount,
      publishedAt: video.publishedAt ?? new Date().toISOString(),
      likeCount: video.likeCount,
      commentCount: video.commentCount,
      durationSec: video.durationSec,
      title: video.title,
      transcriptSegments: this.store.listTranscriptSegments(video.id).map((s) => ({
        startSec: s.startSec,
        endSec: s.endSec,
        text: s.text,
      })),
      frames: this.store.listFrameSamples(video.id).map((f) => ({
        timestampSec: f.timestampSec,
        dhash: f.dhash,
      })),
    }));
    const scopeId = channelScopeId ?? run.sourceIdentity;
    const channelRecord = this.store.getChannel(scopeId);
    const channelMetrics = computeChannelMetrics({
      videos: channelVideos,
      subscriberCount: channelRecord?.subscriberCount ?? null,
    });
    this.store.saveMetrics({
      scope: 'channel',
      scopeId,
      spyRunId,
      payload: channelMetrics,
    });
    for (const video of videos) {
      const videoMetrics = computeVideoMetrics(
        {
          videoId: video.sourceVideoId,
          viewCount: video.viewCount,
          publishedAt: video.publishedAt ?? new Date().toISOString(),
          likeCount: video.likeCount,
          commentCount: video.commentCount,
          durationSec: video.durationSec,
          title: video.title,
          transcriptSegments: this.store.listTranscriptSegments(video.id).map((s) => ({
            startSec: s.startSec,
            endSec: s.endSec,
            text: s.text,
          })),
          frames: this.store.listFrameSamples(video.id).map((f) => ({
            timestampSec: f.timestampSec,
            dhash: f.dhash,
          })),
        },
        { channelVideos, subscriberCount: channelRecord?.subscriberCount ?? null },
      );
      this.store.saveMetrics({
        scope: 'video',
        scopeId: video.sourceVideoId,
        spyRunId,
        payload: videoMetrics,
      });
    }
    this.store.updateSpyRun(spyRunId, { status: 'completed' });
  }

  private async runWork<T>(spyRunId: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      this.store.updateSpyRun(spyRunId, {
        status: signal.aborted ? 'cancelled' : 'failed',
      });
      throw error;
    }
  }
}
