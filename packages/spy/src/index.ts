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
    this.harvest = new HarvestService(this.store, this.youtube, this.operations, this.llm, this.artifacts);
  }

  async init(): Promise<void> {
    await mkdir(this.dataRoot, { recursive: true });
    await mkdir(join(resolve(this.dataRoot, '..'), 'config'), { recursive: true });
    await this.artifacts.initialize();
    this.config = await loadConfig(this.dataRoot, this.config);
    this.dataApiAdapter?.setApiKey(this.config.youtubeDataApiKey);
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
    return {
      spyRunId: run.id,
      computedAt: metrics?.computedAt ?? run.completedAt,
      method: 'mixed' as const,
      metrics: metrics?.payload ?? null,
      hooks: hooks?.payload ?? null,
      topics: topics?.payload ?? null,
    };
  }

  channelOutliers(channelIdOrSpyRunId: string, minScore = 1.5) {
    const run = this.resolveRun(channelIdOrSpyRunId);
    const metrics = this.store.getLatestMetrics('channel', run.sourceIdentity);
    const payload = metrics?.payload as { outliers?: Array<{ videoId: string; outlierScore: number; cohort: string }> } | null;
    return (payload?.outliers ?? []).filter((o) => o.outlierScore >= minScore);
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

  compare(videoIds: string[], dimensions: string[]) {
    return {
      videoIds,
      dimensions,
      results: videoIds.map((videoId) => ({
        videoId,
        metrics: this.store.getLatestMetrics('video', videoId)?.payload ?? null,
      })),
    };
  }

  channelDiff(channelIdA: string, channelIdB: string) {
    return {
      a: this.channelProfile(channelIdA),
      b: this.channelProfile(channelIdB),
    };
  }

  listChannels(limit = 100) {
    return this.store.listChannels(limit);
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
