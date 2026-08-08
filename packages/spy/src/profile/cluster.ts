import type { LlmPort } from '../adapters/llm.ts';
import type { TopicCluster } from '../schema.ts';
import type { SpyStore } from '../store.ts';
import { buildEvidenceCatalog, validateEvidenceRefs } from './evidence.ts';
import { segmentsForVideo } from './hook.ts';

export async function analyzeTopics(
  store: SpyStore,
  llm: LlmPort,
  spyRunId: string,
): Promise<TopicCluster[]> {
  const catalog = buildEvidenceCatalog(store, spyRunId);
  const videos = store.listVideoSnapshots(spyRunId).map((video) => ({
    video,
    segments: segmentsForVideo(store, video),
  }));
  const clusters = await llm.analyzeTopics({ videos });
  return clusters.map((cluster) => ({
    ...cluster,
    representativeQuotes: cluster.representativeQuotes.map((ref) => {
      validateEvidenceRefs([ref], catalog);
      return ref;
    }),
  }));
}
