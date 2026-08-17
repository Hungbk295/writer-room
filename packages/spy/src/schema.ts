import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);

export const samplingPolicySchema = z.object({
  mode: z.enum(['sequential', 'scene', 'spread', 'random']).default('spread'),
  frameCount: z.number().int().min(1).max(200).default(30),
  intervalSec: z.number().min(0.1).max(60).default(1),
  dhashThreshold: z.number().int().min(0).max(64).default(8),
}).strict();

export type SamplingPolicy = z.infer<typeof samplingPolicySchema>;

export const methodTaggedSchema = z.object({
  value: z.unknown(),
  method: z.enum(['deterministic', 'interpreted', 'proxy', 'unavailable', 'insufficient_sample']),
  reason: z.string().optional(),
  have: z.number().optional(),
  need: z.number().optional(),
}).strict();

export type MethodTagged = z.infer<typeof methodTaggedSchema>;

export const artifactRefSchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  relativePath: nonEmpty,
  byteLength: z.number().int().nonnegative(),
  mimeType: nonEmpty,
}).strict();

export type ArtifactRef = z.infer<typeof artifactRefSchema>;

export const evidenceRefSchema = z.object({
  videoId: nonEmpty,
  segmentIds: z.array(nonEmpty).optional(),
  frameIds: z.array(nonEmpty).optional(),
  startSec: z.number().optional(),
  endSec: z.number().optional(),
  quote: z.string().optional(),
}).strict();

export type EvidenceRef = z.infer<typeof evidenceRefSchema>;

export const transcriptSegmentSchema = z.object({
  id: nonEmpty,
  videoSnapshotId: nonEmpty,
  videoTranscriptId: z.string().optional(),
  index: z.number().int().nonnegative(),
  startSec: z.number(),
  endSec: z.number(),
  text: nonEmpty,
  source: nonEmpty,
  language: z.string().nullable(),
  contentHash: nonEmpty,
}).strict();

export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;

export const videoTranscriptSchema = z.object({
  id: nonEmpty,
  sourceVideoId: nonEmpty,
  language: nonEmpty,
  source: z.enum(['manual', 'auto', 'unknown']),
  contentHash: nonEmpty,
  fetchedAt: nonEmpty,
  normalizedText: z.string().nullable(),
  normalizedAt: z.string().nullable(),
  normalizeModel: z.string().nullable(),
}).strict();

export type VideoTranscript = z.infer<typeof videoTranscriptSchema>;

export const harvestDepthSchema = z.enum(['metadata', 'transcript']);
export type HarvestDepth = z.infer<typeof harvestDepthSchema>;

export const frameSampleSchema = z.object({
  id: nonEmpty,
  videoSnapshotId: nonEmpty,
  index: z.number().int().nonnegative(),
  timestampSec: z.number(),
  dhash: nonEmpty,
  artifact: artifactRefSchema,
}).strict();

export type FrameSample = z.infer<typeof frameSampleSchema>;

export const videoSnapshotSchema = z.object({
  id: nonEmpty,
  spyRunId: nonEmpty,
  sourceVideoId: nonEmpty,
  canonicalUrl: nonEmpty,
  title: nonEmpty,
  channelTitle: z.string(),
  rank: z.number().int(),
  viewCount: z.number().int().nonnegative(),
  likeCount: z.number().int().nonnegative().nullable(),
  commentCount: z.number().int().nonnegative().nullable(),
  durationSec: z.number().nonnegative(),
  publishedAt: z.string().nullable(),
  tags: z.array(z.string()),
  transcriptStatus: z.enum(['pending', 'ok', 'missing', 'error', 'skipped']),
  transcriptSource: z.enum(['manual', 'auto', 'unknown']).nullable(),
  frameStatus: z.enum(['pending', 'ok', 'low_variance', 'error', 'skipped']),
  thumbnail: artifactRefSchema.nullable(),
  createdAt: nonEmpty,
}).strict();

export type VideoSnapshot = z.infer<typeof videoSnapshotSchema>;

export const spyRunSchema = z.object({
  id: nonEmpty,
  kind: z.enum(['video', 'channel']),
  canonicalSource: nonEmpty,
  sourceIdentity: nonEmpty,
  config: z.unknown(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted']),
  scanLimit: z.number().int().nullable(),
  topN: z.number().int().nullable(),
  createdAt: nonEmpty,
  completedAt: z.string().nullable(),
}).strict();

export type SpyRun = z.infer<typeof spyRunSchema>;

export const hookAnalysisSchema = z.object({
  videoId: nonEmpty,
  openingQuote: nonEmpty,
  strategy: z.enum([
    'scene', 'contradiction', 'consequence', 'question',
    'statistic', 'promise', 'story', 'direct-address',
  ]),
  promiseStatedAtSec: z.number().nullable(),
  openLoop: z.string().nullable(),
  payoffAtSec: z.number().nullable(),
  evidence: z.array(evidenceRefSchema).min(1),
  method: z.literal('interpreted'),
}).strict();

export type HookAnalysis = z.infer<typeof hookAnalysisSchema>;

export const topicClusterSchema = z.object({
  id: nonEmpty,
  label: nonEmpty,
  videoIds: z.array(nonEmpty),
  viewMedian: z.number(),
  liftVsChannel: z.number(),
  representativeQuotes: z.array(evidenceRefSchema),
  method: z.literal('interpreted'),
}).strict();

export type TopicCluster = z.infer<typeof topicClusterSchema>;

export const scriptPrepAttachmentSchema = z.object({
  storySpine: z.record(z.string(), z.string()).optional(),
  arc: z.array(z.object({
    phase: nonEmpty,
    fromIdx: z.number().int().nonnegative(),
    toIdx: z.number().int().nonnegative(),
    emotion: nonEmpty,
  }).strict()).optional(),
  literalTraps: z.array(z.string()).optional(),
  entityPlan: z.array(z.object({
    entity: nonEmpty,
    introIdx: z.number().int().nonnegative(),
    reserveForTwist: z.boolean().optional(),
    note: z.string().optional(),
  }).strict()).optional(),
}).strict();

export type ScriptPrepAttachment = z.infer<typeof scriptPrepAttachmentSchema>;

export const voiceProfileSchema = z.object({
  niche: nonEmpty,
  language: nonEmpty,
  persona: z.object({ traits: nonEmpty, voice: nonEmpty }).strict(),
  tonePov: z.object({ tone: nonEmpty, pov: nonEmpty, forbidden: z.string() }).strict(),
  narration: z.object({
    hookFormulas: z.array(nonEmpty),
    jokeStyle: z.string(),
    structureArc: z.string(),
  }).strict(),
  signaturePhrases: z.array(z.object({
    phrase: nonEmpty,
    occurrences: z.number().int().nonnegative(),
    evidence: z.array(evidenceRefSchema),
  }).strict()),
  scriptPrep: scriptPrepAttachmentSchema.nullable(),
  evidence: z.array(evidenceRefSchema).min(1),
  method: z.literal('interpreted'),
}).strict();

export type VoiceProfile = z.infer<typeof voiceProfileSchema>;

export const structureBeatSchema = z.object({
  index: z.number().int().nonnegative(),
  startSec: z.number(),
  endSec: z.number(),
  role: z.enum(['hook', 'setup', 'escalation', 'turn', 'payoff', 'cta', 'outro']),
  summary: nonEmpty,
  evidence: z.array(evidenceRefSchema).min(1),
}).strict();

export type StructureBeat = z.infer<typeof structureBeatSchema>;

export const outlierExplanationSchema = z.object({
  videoId: nonEmpty,
  outlierScore: z.number(),
  cohort: nonEmpty,
  featureDiffs: z.array(z.object({
    feature: nonEmpty,
    videoValue: z.unknown(),
    channelNorm: z.unknown(),
  }).strict()),
  hypothesis: nonEmpty,
  confidence: z.enum(['low', 'medium', 'high']),
  evidence: z.array(evidenceRefSchema).min(1),
}).strict();

export type OutlierExplanation = z.infer<typeof outlierExplanationSchema>;

export const channelSpyInputSchema = z.object({
  url: nonEmpty,
  topN: z.number().int().min(1).max(20).default(5),
  /** Which videos to capture after scanning the channel. */
  selectionMode: z.enum(['popular', 'latest']).default('popular'),
  /** Default 60, hard ceiling 500 (harvest H-e). */
  scanLimit: z.number().int().min(1).max(500).default(60),
  rankBy: z.enum(['views', 'velocity']).default('velocity'),
  minDurationSec: z.number().int().min(0).max(7200).default(0),
  maxDurationSec: z.number().int().min(0).max(72_000).optional(),
  /** ISO date/datetime — scan window instead of pure count. */
  publishedAfter: z.string().optional(),
  publishedBefore: z.string().optional(),
  /** metadata | transcript — channel harvest only. */
  depth: harvestDepthSchema.default('transcript'),
  sampling: samplingPolicySchema.partial().optional(),
  idempotencyKey: z.string().min(8).max(200),
}).strict();

export type ChannelSpyInput = z.infer<typeof channelSpyInputSchema>;

/** Spy đúng một video từ URL watch/shorts/youtu.be. */
export const videoSpyInputSchema = z.object({
  url: nonEmpty,
  /** metadata | transcript — default transcript. */
  depth: harvestDepthSchema.default('transcript'),
  idempotencyKey: z.string().min(8).max(200),
}).strict();

export type VideoSpyInput = z.infer<typeof videoSpyInputSchema>;

export const transcriptFetchInputSchema = z.object({
  videoIds: z.array(nonEmpty).min(1).max(100).optional(),
  channelId: z.string().optional(),
  spyRunId: z.string().optional(),
  topN: z.number().int().min(1).max(100).optional(),
  orderBy: z.enum(['views', 'velocity', 'published_at', 'duration', 'engagement']).default('velocity'),
  languages: z.array(nonEmpty).default(['vi', 'en']),
  force: z.boolean().default(false),
  idempotencyKey: z.string().min(8).max(200),
}).strict();

export type TranscriptFetchInput = z.infer<typeof transcriptFetchInputSchema>;

export const channelVideosQuerySchema = z.object({
  channelId: z.string().optional(),
  spyRunId: z.string().optional(),
  orderBy: z.enum(['views', 'velocity', 'published_at', 'duration', 'engagement']).default('velocity'),
  direction: z.enum(['asc', 'desc']).default('desc'),
  publishedAfter: z.string().optional(),
  publishedBefore: z.string().optional(),
  minDurationSec: z.number().int().min(0).optional(),
  maxDurationSec: z.number().int().min(0).optional(),
  hasTranscript: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.number().int().min(0).default(0),
}).strict();

export type ChannelVideosQuery = z.infer<typeof channelVideosQuerySchema>;

export const transcriptCohortInputSchema = z.object({
  channelId: nonEmpty,
  size: z.number().int().min(1).max(50).default(10),
  orderBy: z.enum(['views', 'velocity', 'published_at']).default('velocity'),
  requireTranscript: z.boolean().default(true),
  preferManualSubs: z.boolean().default(true),
  minDurationSec: z.number().int().min(0).optional(),
  maxDurationSec: z.number().int().min(0).optional(),
}).strict();

export type TranscriptCohortInput = z.infer<typeof transcriptCohortInputSchema>;

export const operationKindSchema = z.enum([
  'acquire_video',
  'acquire_channel',
  'fetch_transcripts',
  /** Writer Room: transcribe a hand-picked multi-video source pack. */
  'build_source_pack',
  'normalize_transcripts',
  'analyze_hooks',
  'analyze_voice',
  'analyze_structure',
  'analyze_topics',
  'analyze_outliers',
]);

export type OperationKind = z.infer<typeof operationKindSchema>;

export const operationStatusSchema = z.enum([
  'queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted',
]);

export type OperationStatus = z.infer<typeof operationStatusSchema>;

export const operationSchema = z.object({
  id: nonEmpty,
  kind: operationKindSchema,
  ownerSubject: nonEmpty,
  status: operationStatusSchema,
  idempotencyKey: z.string().nullable(),
  progress: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  step: nonEmpty,
  resultRef: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: nonEmpty,
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
}).strict();

export type Operation = z.infer<typeof operationSchema>;

export const spyConfigSchema = z.object({
  youtubeDataApiKey: z.string().optional(),
  sampling: samplingPolicySchema.partial().optional(),
  /** Số worker fetch transcript song song. Default 3 = giữ nguyên hành vi trước khi config được nối vào harvest. */
  concurrency: z.number().int().min(1).max(4).default(3),
}).strict();

export type SpyConfig = z.infer<typeof spyConfigSchema>;

export interface StartedOp {
  operationId: string;
  spyRunId: string;
  status: string;
}

export interface ChannelRecord {
  id: string;
  channelId: string;
  title: string;
  subscriberCount: number | null;
  videoCount: number | null;
  totalViewCount: number | null;
  fetchedAt: string;
}
