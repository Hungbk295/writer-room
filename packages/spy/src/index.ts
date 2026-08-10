import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AppError } from './errors.ts';
import { ArtifactStore } from './artifacts.ts';
import { SpyStore } from './store.ts';
import { OperationManager } from './operations.ts';
import { AcquisitionService } from './acquisition.ts';
import { ProfileService } from './profile/index.ts';
import { HarvestService } from './harvest.ts';
import { buildSourcePack } from './source-pack.ts';
import {
  YtDlpAdapter,
  FfmpegAdapter,
  YouTubeDataApiAdapter,
  DeterministicStubLlm,
  type YoutubePort,
  type MediaPort,
  type YouTubeDataApiPort,
  type LlmPort,
} from './adapters/index.ts';
import {
  samplingPolicySchema,
  spyConfigSchema,
  type ChannelSpyInput,
  type Operation,
  type SamplingPolicy,
  type SpyConfig,
  type StartedOp,
} from './schema.ts';

export * from './errors.ts';
export * from './schema.ts';
export * from './evidence/index.ts';
export * from './metrics/index.ts';
export * from './artifacts.ts';
export * from './store.ts';
export * from './operations.ts';
export * from './acquisition.ts';
export * from './harvest.ts';
export * from './source-pack.ts';
export * from './profile/index.ts';
export * from './adapters/index.ts';
export { spyTools, type SpyToolContext, type SpyToolDef } from './mcp-tools.ts';

export interface SpyServiceOptions {
  dataRoot: string;
  config?: SpyConfig;
  youtube?: YoutubePort;
  media?: MediaPort;
  dataApi?: YouTubeDataApiPort;
  llm?: LlmPort;
}

function defaultConfigPath(dataRoot: string): string {
  // SpyService dataRoot is <data>/spy → config lives at <data>/config/spy.json
  return join(resolve(dataRoot, '..'), 'config', 'spy.json');
}

async function loadConfig(dataRoot: string, override?: SpyConfig): Promise<SpyConfig> {
  let fromFile: SpyConfig = spyConfigSchema.parse({});
  try {
    const raw = await readFile(defaultConfigPath(dataRoot), 'utf8');
    fromFile = spyConfigSchema.parse(JSON.parse(raw));
  } catch {
    // optional
  }
  if (!override) return fromFile;
  return spyConfigSchema.parse({
    ...fromFile,
    ...override,
    sampling: { ...fromFile.sampling, ...override.sampling },
  });
}

interface OutlierRow {
  videoId: string;
  viewCount?: number | null;
  cohort: string;
  metricUsed?: string | null;
  /** MetricValue<number> từ metrics/performance.ts — KHÔNG phải number. */
  outlierScore: unknown;
}

/**
 * Đọc một MetricValue<number> (hoặc number thô của payload cũ) ra số.
 * Trước đây channelOutliers so thẳng object với số → NaN → luôn trả rỗng.
 */
function readMetricNumber(raw: unknown): { score: number | null; method: string } {
  if (typeof raw === 'number') {
    return { score: Number.isFinite(raw) ? raw : null, method: 'deterministic' };
  }
  if (raw && typeof raw === 'object') {
    const holder = raw as { value?: unknown; method?: unknown };
    const value = holder.value;
    const method = typeof holder.method === 'string' ? holder.method : 'unavailable';
    if (typeof value === 'number' && Number.isFinite(value)) return { score: value, method };
    return { score: null, method };
  }
  return { score: null, method: 'unavailable' };
}

function numbersIn(payload: unknown, prefix = '', out: Record<string, number> = {}): Record<string, number> {
  if (!payload || typeof payload !== 'object') return out;
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[path] = value;
    } else if (value && typeof value === 'object' && 'value' in (value as Record<string, unknown>)) {
      const inner = (value as { value?: unknown }).value;
      if (typeof inner === 'number' && Number.isFinite(inner)) out[path] = inner;
      else numbersIn(inner, path, out);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      numbersIn(value, path, out);
    }
  }
  return out;
}

/** Top token theo |lift − 1| từ ChannelMetrics.title.tokenLift, dùng cho channelDiff. */
function topTokens(metrics: unknown, limit = 15): string[] {
  const title = (metrics as { title?: { tokenLift?: unknown } } | null)?.title;
  const lifts = Array.isArray(title?.tokenLift) ? title.tokenLift : [];
  return lifts
    .filter((row): row is { token: string } => Boolean(row) && typeof (row as { token?: unknown }).token === 'string')
    .slice(0, limit)
    .map((row) => row.token);
}

function pickDimensions(payload: unknown, dimensions: string[]): unknown {
  if (!payload || typeof payload !== 'object' || dimensions.length === 0) return payload;
  const source = payload as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const dimension of dimensions) {
    if (dimension in source) picked[dimension] = source[dimension];
  }
  return picked;
}

export class SpyService {
  readonly dataRoot: string;
  readonly artifacts: ArtifactStore;
  readonly store: SpyStore;
  readonly operations: OperationManager;
  readonly acquisition: AcquisitionService;
  readonly profile: ProfileService;
  readonly harvest: HarvestService;
  config: SpyConfig;

  private readonly youtube: YoutubePort;
  private readonly media: MediaPort;
  private readonly dataApi: YouTubeDataApiPort;
  private readonly dataApiAdapter: YouTubeDataApiAdapter | null;
  private readonly llm: LlmPort;

  constructor(opts: SpyServiceOptions) {
    this.dataRoot = resolve(opts.dataRoot);
    this.config = spyConfigSchema.parse(opts.config ?? {});
    this.artifacts = new ArtifactStore(join(this.dataRoot, 'artifacts'));
    this.store = new SpyStore(join(this.dataRoot, 'spy.sqlite'));
    this.operations = new OperationManager(this.store);
    this.youtube = opts.youtube ?? new YtDlpAdapter();
    this.media = opts.media ?? new FfmpegAdapter();
    if (opts.dataApi) {
      this.dataApi = opts.dataApi;
      this.dataApiAdapter = null;
    } else {
      this.dataApiAdapter = new YouTubeDataApiAdapter(this.config.youtubeDataApiKey);
      this.dataApi = this.dataApiAdapter;
    }
    this.llm = opts.llm ?? new DeterministicStubLlm();
    this.acquisition = new AcquisitionService(
      this.store,
      this.artifacts,
      this.youtube,
      this.dataApi,
      this.operations,
      this.config.sampling,
    );
    this.profile = new ProfileService(this.store, this.llm);
    this.harvest = new HarvestService(
      this.store,
      this.youtube,
      this.operations,
      this.llm,
      this.artifacts,
      this.config.concurrency,
    );
  }

  async init(): Promise<void> {
    await mkdir(this.dataRoot, { recursive: true });
    await mkdir(join(resolve(this.dataRoot, '..'), 'config'), { recursive: true });
    await this.artifacts.initialize();
    this.config = await loadConfig(this.dataRoot, this.config);
    this.dataApiAdapter?.setApiKey(this.config.youtubeDataApiKey);
    this.harvest.setConcurrency(this.config.concurrency);
    this.operations.reconcile();
  }

  channelSpy(input: ChannelSpyInput, ownerSubject = 'local'): StartedOp {
    return this.acquisition.channelSpy(input, ownerSubject);
  }

  getStatus(opId: string): Operation {
    const operation = this.store.getOperation(opId);
    if (!operation) throw new AppError('not_found', 'Operation không tồn tại');
    return operation;
  }

  wait(opId: string, timeoutMs = 30_000): Promise<Operation> {
    return this.operations.wait(opId, timeoutMs);
  }

  cancel(opId: string, subject?: string): Operation {
    const operation = this.store.getOperation(opId);
    if (!operation) throw new AppError('not_found', 'Operation không tồn tại');
    if (subject && operation.ownerSubject !== subject) {
      throw new AppError('forbidden', 'Không thể huỷ operation của subject khác');
    }
    return this.operations.cancel(opId);
  }

  getResult(spyRunId: string) {
    const run = this.store.getSpyRun(spyRunId);
    if (!run) throw new AppError('not_found', 'Spy run không tồn tại');
    const videos = this.store.listVideoSnapshots(spyRunId);
    return {
      run,
      videos: videos.map((video) => ({
        ...video,
        transcriptCount: this.store.transcriptSegmentCount(video.id),
        frameCount: this.store.frameSampleCount(video.id),
        thumbnailUrl: video.thumbnail
          ? `/api/spy/snapshots/${video.id}/thumbnail`
          : `https://i.ytimg.com/vi/${video.sourceVideoId}/hqdefault.jpg`,
      })),
    };
  }

  getTranscript(videoSnapshotId: string, cursor = 0, limit = 500) {
    const snapshot = this.store.getVideoSnapshot(videoSnapshotId);
    if (!snapshot) throw new AppError('not_found', 'Video snapshot không tồn tại');
    const segments = this.store.listTranscriptSegments(videoSnapshotId, cursor, limit);
    const nextCursor = segments.length === limit ? cursor + limit : null;
    const record = this.store.getVideoTranscript(snapshot.sourceVideoId);
    const total = this.store.transcriptSegmentCount(videoSnapshotId);
    return {
      segments,
      nextCursor,
      meta: {
        source: record?.source ?? snapshot.transcriptSource,
        language: record?.language ?? null,
        count: total,
        transcriptStatus: snapshot.transcriptStatus,
        hasNormalized: Boolean(record?.normalizedText?.trim()),
      },
    };
  }

  getTranscriptText(videoSnapshotId: string) {
    const snapshot = this.store.getVideoSnapshot(videoSnapshotId);
    if (!snapshot) throw new AppError('not_found', 'Video snapshot không tồn tại');
    const record = this.store.getVideoTranscript(snapshot.sourceVideoId);
    if (record?.normalizedText?.trim()) {
      const text = record.normalizedText.trim();
      return {
        text,
        source: record.source,
        language: record.language,
        normalized: true,
        wordCount: text.split(/\s+/).filter(Boolean).length,
      };
    }
    const segments = this.store.listTranscriptSegments(videoSnapshotId, 0, 100_000);
    const text = segments.map((s) => s.text).join('\n');
    return {
      text,
      source: record?.source ?? snapshot.transcriptSource ?? 'unknown',
      language: record?.language ?? null,
      normalized: false,
      wordCount: text.split(/\s+/).filter(Boolean).length,
    };
  }

  /** Public settings view — API key is masked. */
  getPublicConfig() {
    const key = this.config.youtubeDataApiKey?.trim() || '';
    return {
      hasApiKey: key.length > 0,
      apiKeyLast4: key.length >= 4 ? key.slice(-4) : null,
      concurrency: this.config.concurrency ?? 1,
      sampling: samplingPolicySchema.parse(this.config.sampling ?? {}),
    };
  }

  async updateConfig(patch: {
    youtubeDataApiKey?: string | null;
    concurrency?: number;
    sampling?: Partial<SamplingPolicy>;
  }): Promise<SpyConfig> {
    const next: SpyConfig = {
      ...this.config,
      concurrency: patch.concurrency ?? this.config.concurrency,
      sampling: {
        ...this.config.sampling,
        ...patch.sampling,
      },
    };
    if (patch.youtubeDataApiKey !== undefined) {
      const value = patch.youtubeDataApiKey?.trim() || '';
      next.youtubeDataApiKey = value || undefined;
    }
    this.config = spyConfigSchema.parse(next);
    this.dataApiAdapter?.setApiKey(this.config.youtubeDataApiKey);
    this.harvest.setConcurrency(this.config.concurrency);
    this.acquisition.setDefaultSampling(this.config.sampling);

    const configPath = defaultConfigPath(this.dataRoot);
    await mkdir(join(resolve(this.dataRoot, '..'), 'config'), { recursive: true });
    const toWrite = {
      youtubeDataApiKey: this.config.youtubeDataApiKey ?? '',
      concurrency: this.config.concurrency ?? 1,
      sampling: this.config.sampling ?? {},
    };
    await writeFile(configPath, `${JSON.stringify(toWrite, null, 2)}\n`, 'utf8');
    return this.config;
  }

  listFrames(videoSnapshotId: string, cursor = 0, limit = 25) {
    const frames = this.store.listFrameSamples(videoSnapshotId, cursor, limit);
    const nextCursor = frames.length === limit ? cursor + limit : null;
    return {
      frames: frames.map(({ artifact, ...frame }) => ({
        ...frame,
        assetRef: artifact,
      })),
      nextCursor,
    };
  }

  async getFrame(frameId: string): Promise<{ path: string; frame: ReturnType<SpyStore['getFrameSample']> }> {
    const frame = this.store.getFrameSample(frameId);
    if (!frame) throw new AppError('not_found', 'Frame không tồn tại');
    const path = await this.artifacts.resolve(frame.artifact);
    return { path, frame };
  }

  channelProfile(channelIdOrSpyRunId: string) {
    const run = this.resolveRun(channelIdOrSpyRunId);
    const scopeId = run.sourceIdentity;
    const metrics = this.store.getLatestMetrics('channel', scopeId);
    const hooks = this.store.getLatestProfile('channel', scopeId, 'hooks');
    const topics = this.store.getLatestProfile('channel', scopeId, 'topics');
    const voice = this.store.getLatestProfile('channel', scopeId, 'voice');
    return {
      spyRunId: run.id,
      computedAt: metrics?.computedAt ?? run.completedAt,
      method: 'mixed' as const,
      metrics: metrics?.payload ?? null,
      hooks: hooks?.payload ?? null,
      topics: topics?.payload ?? null,
      voice: voice?.payload ?? null,
      // Profile chỉ có sau khi chạy spy_hook_taxonomy / spy_topic_clusters / spy_voice_profile.
      profileModel: hooks?.model ?? topics?.model ?? voice?.model ?? null,
      missingProfiles: [
        hooks ? null : 'hooks',
        topics ? null : 'topics',
        voice ? null : 'voice',
      ].filter((kind): kind is string => kind !== null),
    };
  }

  channelOutliers(channelIdOrSpyRunId: string, minScore = 1.5) {
    const run = this.resolveRun(channelIdOrSpyRunId);
    const metrics = this.store.getLatestMetrics('channel', run.sourceIdentity);
    const payload = metrics?.payload as { outliers?: OutlierRow[] } | null;
    const rows = payload?.outliers ?? [];
    const scored = rows.map((row) => {
      const { score, method } = readMetricNumber(row.outlierScore);
      return {
        videoId: row.videoId,
        viewCount: row.viewCount ?? null,
        cohort: row.cohort,
        metricUsed: row.metricUsed ?? null,
        outlierScore: score,
        method,
      };
    });
    return {
      spyRunId: run.id,
      computedAt: metrics?.computedAt ?? null,
      minScore,
      sampleSize: rows.length,
      // Điểm không tính được (mẫu nhỏ / MAD=0) tách riêng thay vì bị lọc im lặng.
      unscored: scored.filter((row) => row.outlierScore === null).length,
      outliers: scored
        .filter((row) => row.outlierScore !== null && row.outlierScore >= minScore)
        .sort((a, b) => (b.outlierScore ?? 0) - (a.outlierScore ?? 0)),
    };
  }

  titlePatterns(channelIdOrSpyRunId: string) {
    const run = this.resolveRun(channelIdOrSpyRunId);
    const metrics = this.store.getLatestMetrics('channel', run.sourceIdentity);
    const payload = metrics?.payload as { title?: unknown } | null;
    return payload?.title ?? null;
  }

  async hookTaxonomy(channelIdOrSpyRunId: string, videoIds?: string[]) {
    const run = this.resolveRun(channelIdOrSpyRunId);
    return this.profile.hookTaxonomy(run.id, videoIds);
  }

  videoMetrics(videoId: string, spyRunId?: string) {
    const metrics = spyRunId
      ? this.store.getLatestMetrics('video', videoId)
      : this.store.getLatestMetrics('video', videoId);
    return metrics?.payload ?? null;
  }

  async videoStructure(videoId: string, spyRunId?: string) {
    const run = spyRunId ? this.resolveRun(spyRunId) : this.findRunForVideo(videoId);
    if (!run) throw new AppError('not_found', 'Không tìm thấy spy run cho video');
    return this.profile.videoStructure(run.id, videoId);
  }

  async topicClusters(channelIdOrSpyRunId: string) {
    const run = this.resolveRun(channelIdOrSpyRunId);
    return this.profile.topicClusters(run.id);
  }

  async voiceProfile(channelIdOrSpyRunId: string) {
    const run = this.resolveRun(channelIdOrSpyRunId);
    return this.profile.voiceProfile(run.id);
  }

  /**
   * So sánh video theo dimension. `dimensions` rỗng = lấy tất cả.
   * Dimension hợp lệ khớp key cấp 1 của VideoMetrics: title | performance | speech | visual.
   */
  compare(videoIds: string[], dimensions: string[]) {
    const known = ['title', 'performance', 'speech', 'visual'];
    const unknownDimensions = dimensions.filter((d) => !known.includes(d));
    const results = videoIds.map((videoId) => {
      const payload = this.store.getLatestMetrics('video', videoId)?.payload ?? null;
      return {
        videoId,
        metrics: payload === null ? null : pickDimensions(payload, dimensions),
        missing: payload === null,
      };
    });

    // Bảng số phẳng để so ngang: field → giá trị từng video + min/max/spread.
    const flat = results.map((row) => ({ videoId: row.videoId, numbers: numbersIn(row.metrics) }));
    const fields = [...new Set(flat.flatMap((row) => Object.keys(row.numbers)))].sort();
    const table = fields.map((field) => {
      const values = flat
        .map((row) => ({ videoId: row.videoId, value: row.numbers[field] }))
        .filter((entry): entry is { videoId: string; value: number } => entry.value !== undefined);
      const numeric = values.map((entry) => entry.value);
      const min = numeric.length ? Math.min(...numeric) : null;
      const max = numeric.length ? Math.max(...numeric) : null;
      return {
        field,
        values,
        min,
        max,
        spread: min !== null && max !== null ? max - min : null,
        ratio: min !== null && max !== null && min !== 0 ? max / min : null,
      };
    });

    return {
      videoIds,
      dimensions: dimensions.length ? dimensions : known,
      unknownDimensions,
      method: 'deterministic' as const,
      results,
      table,
    };
  }

  /** Diff thật giữa hai kênh: chênh lệch từng chỉ số số học + khác biệt token/topic. */
  channelDiff(channelIdA: string, channelIdB: string) {
    const a = this.channelProfile(channelIdA);
    const b = this.channelProfile(channelIdB);
    const numbersA = numbersIn(a.metrics);
    const numbersB = numbersIn(b.metrics);
    const fields = [...new Set([...Object.keys(numbersA), ...Object.keys(numbersB)])].sort();

    const diff = fields.map((field) => {
      const valueA = numbersA[field] ?? null;
      const valueB = numbersB[field] ?? null;
      const delta = valueA !== null && valueB !== null ? valueB - valueA : null;
      return {
        field,
        a: valueA,
        b: valueB,
        delta,
        ratio: valueA !== null && valueB !== null && valueA !== 0 ? valueB / valueA : null,
        onlyIn: valueA === null ? 'b' : valueB === null ? 'a' : null,
      };
    });

    const tokensA = topTokens(a.metrics);
    const tokensB = topTokens(b.metrics);
    return {
      a: { channel: channelIdA, ...a },
      b: { channel: channelIdB, ...b },
      method: 'deterministic' as const,
      diff,
      /** Chênh lệch lớn nhất theo |ratio − 1|, bỏ qua field chỉ có ở một bên. */
      topDivergence: diff
        .filter((row) => row.ratio !== null)
        .sort((x, y) => Math.abs((y.ratio ?? 1) - 1) - Math.abs((x.ratio ?? 1) - 1))
        .slice(0, 15),
      titleTokens: {
        sharedTop: tokensA.filter((token) => tokensB.includes(token)),
        onlyA: tokensA.filter((token) => !tokensB.includes(token)),
        onlyB: tokensB.filter((token) => !tokensA.includes(token)),
      },
    };
  }

  listChannels(limit = 100) {
    return this.store.listChannels(limit);
  }

  // ---------------------------------------------------------------------------
  // Wrapper YouTube Data API — tra cứu trực tiếp, không cần spy run trước.
  // Batch 50 id/call, 1 quota unit/call.
  // ---------------------------------------------------------------------------

  private assertDataApi(): void {
    if (!this.config.youtubeDataApiKey?.trim()) {
      throw new AppError('capability_missing', 'Chưa cấu hình youtubeDataApiKey trong config/spy.json');
    }
  }

  async videosByIds(videoIds: string[]) {
    this.assertDataApi();
    if (videoIds.length === 0) throw new AppError('invalid_input', 'Cần ít nhất 1 video_id');
    if (videoIds.length > 50) throw new AppError('invalid_input', 'Tối đa 50 video_id mỗi lần');
    const found = await this.dataApi.fetchVideoStatistics(videoIds);
    return {
      requested: videoIds.length,
      videos: videoIds.map((id) => found.get(id) ?? null).filter((v) => v !== null),
      missing: videoIds.filter((id) => !found.has(id)),
      quotaUnitsApprox: Math.ceil(videoIds.length / 50),
    };
  }

  async channelsByIds(channelIds: string[]) {
    this.assertDataApi();
    if (channelIds.length === 0) throw new AppError('invalid_input', 'Cần ít nhất 1 channel_id');
    if (channelIds.length > 50) throw new AppError('invalid_input', 'Tối đa 50 channel_id mỗi lần');
    const handles = channelIds.filter((id) => id.startsWith('@'));
    const ids = channelIds.filter((id) => !id.startsWith('@'));
    const found = await this.dataApi.fetchChannelStatistics(ids);
    const resolved = [...found.values()];
    for (const handle of handles) {
      const channel = await this.dataApi.resolveChannelByHandle?.(handle);
      if (channel) resolved.push(channel);
    }
    return {
      requested: channelIds.length,
      channels: resolved,
      missing: ids.filter((id) => !found.has(id)),
      quotaUnitsApprox: Math.ceil(ids.length / 50) + handles.length,
    };
  }

  async videoComments(input: {
    videoId?: string;
    channelId?: string;
    maxResults?: number;
    order?: 'relevance' | 'time';
    includeReplies?: boolean;
  }) {
    this.assertDataApi();
    if (!this.dataApi.fetchVideoComments) {
      throw new AppError('capability_missing', 'Data API adapter không hỗ trợ comment');
    }
    const threads = await this.dataApi.fetchVideoComments(input);
    return {
      scope: input.videoId ? { videoId: input.videoId } : { channelId: input.channelId },
      order: input.order ?? 'relevance',
      count: threads.length,
      totalReplies: threads.reduce((sum, thread) => sum + thread.totalReplyCount, 0),
      threads,
      quotaUnitsApprox: 1,
    };
  }

  // ---------------------------------------------------------------------------
  // Competitor list — state cục bộ, không cần OAuth.
  // ---------------------------------------------------------------------------

  listCompetitors(ownerChannelId: string) {
    const rows = this.store.listCompetitors(ownerChannelId);
    return { ownerChannelId, count: rows.length, competitors: rows };
  }

  updateCompetitors(input: { ownerChannelId: string; follow?: string[]; unfollow?: string[]; note?: string }) {
    const follow = input.follow ?? [];
    const unfollow = input.unfollow ?? [];
    const overlap = follow.filter((id) => unfollow.includes(id));
    if (overlap.length > 0) {
      throw new AppError('invalid_input', `Không thể vừa follow vừa unfollow: ${overlap.join(', ')}`);
    }
    const added = follow.filter((id) => this.store.addCompetitor(input.ownerChannelId, id, input.note));
    const removed = unfollow.filter((id) => this.store.removeCompetitor(input.ownerChannelId, id));
    return {
      ownerChannelId: input.ownerChannelId,
      added,
      alreadyFollowing: follow.filter((id) => !added.includes(id)),
      removed,
      notFollowing: unfollow.filter((id) => !removed.includes(id)),
      competitors: this.store.listCompetitors(input.ownerChannelId),
    };
  }

  listChannelVideos(query: unknown) {
    return this.harvest.listChannelVideos(query);
  }

  searchTranscripts(input: { query: string; channelId?: string; videoIds?: string[]; limit?: number }) {
    return this.harvest.searchTranscripts(input);
  }

  fetchTranscripts(input: unknown, ownerSubject = 'local') {
    const operation = this.harvest.fetchTranscripts(input, ownerSubject);
    return {
      operationId: operation.id,
      status: operation.status,
    };
  }

  fetchTranscriptsSync(input: unknown, signal?: AbortSignal) {
    return this.harvest.fetchTranscriptsSync(input, signal);
  }

  normalizeTranscripts(input: { videoIds: string[]; model?: string }, ownerSubject = 'local') {
    return this.harvest.normalizeTranscripts(input, ownerSubject);
  }

  transcriptCohort(input: unknown) {
    return this.harvest.transcriptCohort(input);
  }

  exportSourcePack(options: {
    spyRunId: string;
    videoIds?: string[];
    limit?: number;
    orderBy?: 'velocity' | 'views' | 'published_at';
    preferNormalized?: boolean;
    maxCharsPerVideo?: number;
  }) {
    return buildSourcePack(this.store, options);
  }

  samplingPolicy(): SamplingPolicy {
    return samplingPolicySchema.parse(this.config.sampling ?? {});
  }

  private resolveRun(id: string) {
    const byId = this.store.getSpyRun(id);
    if (byId) return byId;
    const runs = this.store.listSpyRuns(undefined, 100);
    const match = runs.find((run) => run.sourceIdentity.includes(id) || run.canonicalSource.includes(id));
    if (!match) throw new AppError('not_found', 'Spy run không tồn tại');
    return match;
  }

  private findRunForVideo(videoId: string) {
    for (const run of this.store.listSpyRuns(undefined, 100)) {
      if (this.store.getVideoSnapshotBySourceId(run.id, videoId)) return run;
    }
    return null;
  }
}
