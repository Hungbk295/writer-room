import type {
  EvidenceRef,
  HookAnalysis,
  StructureBeat,
  TopicCluster,
  TranscriptSegment,
  VideoSnapshot,
  VoiceProfile,
} from '../schema.ts';

export interface HookAnalysisInput {
  video: VideoSnapshot;
  segments: TranscriptSegment[];
}

export interface VoiceAnalysisInput {
  channelTitle: string;
  videos: Array<{ video: VideoSnapshot; segments: TranscriptSegment[] }>;
}

export interface StructureAnalysisInput {
  video: VideoSnapshot;
  segments: TranscriptSegment[];
  durationSec: number;
}

export interface TopicAnalysisInput {
  videos: Array<{ video: VideoSnapshot; segments: TranscriptSegment[] }>;
}

export interface OutlierAnalysisInput {
  video: VideoSnapshot;
  segments: TranscriptSegment[];
  outlierScore: number;
  cohort: string;
}

export interface LlmPort {
  readonly name: string;
  readonly model: string | null;
  analyzeHooks(input: HookAnalysisInput, signal?: AbortSignal): Promise<HookAnalysis[]>;
  analyzeVoice(input: VoiceAnalysisInput, signal?: AbortSignal): Promise<VoiceProfile>;
  analyzeStructure(input: StructureAnalysisInput, signal?: AbortSignal): Promise<StructureBeat[]>;
  analyzeTopics(input: TopicAnalysisInput, signal?: AbortSignal): Promise<TopicCluster[]>;
  analyzeOutlier(input: OutlierAnalysisInput, signal?: AbortSignal): Promise<{ hypothesis: string; confidence: 'low' | 'medium' | 'high'; evidence: EvidenceRef[] }>;
}

function inferHookStrategy(text: string): HookAnalysis['strategy'] {
  if (/\?/.test(text)) return 'question';
  if (/\d/.test(text)) return 'statistic';
  return 'scene';
}

export class DeterministicStubLlm implements LlmPort {
  readonly name = 'deterministic-stub';
  readonly model = null;

  async analyzeHooks(input: HookAnalysisInput): Promise<HookAnalysis[]> {
    const first = input.segments[0];
    if (!first) return [];
    return [{
      videoId: input.video.sourceVideoId,
      openingQuote: first.text,
      strategy: inferHookStrategy(first.text),
      promiseStatedAtSec: first.endSec <= 30 ? first.endSec : null,
      openLoop: null,
      payoffAtSec: null,
      evidence: [{
        videoId: input.video.sourceVideoId,
        segmentIds: [first.id],
        quote: first.text,
        startSec: first.startSec,
        endSec: first.endSec,
      }],
      method: 'interpreted',
    }];
  }

  async analyzeVoice(input: VoiceAnalysisInput): Promise<VoiceProfile> {
    const first = input.videos[0];
    const segment = first?.segments[0];
    return {
      niche: first?.video.channelTitle || 'general',
      language: segment?.language ?? 'unknown',
      persona: { traits: 'clear', voice: 'explanatory' },
      tonePov: { tone: 'informative', pov: 'second person', forbidden: 'unsupported claims' },
      narration: {
        hookFormulas: ['Open with the core question.'],
        jokeStyle: 'none unless evidenced',
        structureArc: 'question, evidence, explanation',
      },
      signaturePhrases: [],
      scriptPrep: null,
      evidence: segment ? [{
        videoId: first!.video.sourceVideoId,
        segmentIds: [segment.id],
        quote: segment.text,
      }] : [],
      method: 'interpreted',
    };
  }

  async analyzeStructure(input: StructureAnalysisInput): Promise<StructureBeat[]> {
    const first = input.segments[0];
    if (!first) return [];
    return [{
      index: 0,
      startSec: first.startSec,
      endSec: Math.min(first.endSec, 30),
      role: 'hook',
      summary: first.text.slice(0, 120),
      evidence: [{
        videoId: input.video.sourceVideoId,
        segmentIds: [first.id],
        quote: first.text,
      }],
    }];
  }

  async analyzeTopics(input: TopicAnalysisInput): Promise<TopicCluster[]> {
    if (input.videos.length === 0) return [];
    const ids = input.videos.map((v) => v.video.sourceVideoId);
    const first = input.videos[0]!;
    const segment = first.segments[0];
    return [{
      id: 'cluster-1',
      label: 'General topics',
      videoIds: ids,
      viewMedian: first.video.viewCount,
      liftVsChannel: 1,
      representativeQuotes: segment ? [{
        videoId: first.video.sourceVideoId,
        segmentIds: [segment.id],
        quote: segment.text,
      }] : [],
      method: 'interpreted',
    }];
  }

  async analyzeOutlier(input: OutlierAnalysisInput): Promise<{ hypothesis: string; confidence: 'low' | 'medium' | 'high'; evidence: EvidenceRef[] }> {
    const first = input.segments[0];
    return {
      hypothesis: `Video scored ${input.outlierScore.toFixed(1)} in cohort ${input.cohort}; title or hook may differ from channel norm.`,
      confidence: 'low',
      evidence: first ? [{
        videoId: input.video.sourceVideoId,
        segmentIds: [first.id],
        quote: first.text,
      }] : [],
    };
  }
}
