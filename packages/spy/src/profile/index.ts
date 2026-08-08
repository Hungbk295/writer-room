import type { LlmPort } from '../adapters/llm.ts';
import type { SpyStore } from '../store.ts';
import { analyzeHooks } from './hook.ts';
import { analyzeTopics } from './cluster.ts';
import { analyzeVoice } from './voice.ts';
import { analyzeStructure } from './structure.ts';
import { analyzeOutlier } from './outlier.ts';

export class ProfileService {
  constructor(
    private readonly store: SpyStore,
    private readonly llm: LlmPort,
  ) {}

  hookTaxonomy(spyRunId: string, videoIds?: string[]) {
    return analyzeHooks(this.store, this.llm, spyRunId, videoIds);
  }

  topicClusters(spyRunId: string) {
    return analyzeTopics(this.store, this.llm, spyRunId);
  }

  voiceProfile(spyRunId: string) {
    return analyzeVoice(this.store, this.llm, spyRunId);
  }

  videoStructure(spyRunId: string, sourceVideoId: string) {
    return analyzeStructure(this.store, this.llm, spyRunId, sourceVideoId);
  }

  outlierExplanation(spyRunId: string, sourceVideoId: string, outlierScore: number, cohort: string) {
    return analyzeOutlier(this.store, this.llm, spyRunId, sourceVideoId, outlierScore, cohort);
  }
}

export * from './evidence.ts';
export * from './hook.ts';
export * from './cluster.ts';
export * from './voice.ts';
export * from './structure.ts';
export * from './outlier.ts';
