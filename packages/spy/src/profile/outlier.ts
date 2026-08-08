import type { LlmPort } from '../adapters/llm.ts';
import type { OutlierExplanation } from '../schema.ts';
import type { SpyStore } from '../store.ts';
import { buildEvidenceCatalog, validateEvidenceRefs } from './evidence.ts';
import { segmentsForVideo } from './hook.ts';

export async function analyzeOutlier(
  store: SpyStore,
  llm: LlmPort,
  spyRunId: string,
  sourceVideoId: string,
  outlierScore: number,
  cohort: string,
): Promise<OutlierExplanation | null> {
  const catalog = buildEvidenceCatalog(store, spyRunId);
  const video = store.listVideoSnapshots(spyRunId).find((v) => v.sourceVideoId === sourceVideoId);
  if (!video) return null;
  const segments = segmentsForVideo(store, video);
  const llmResult = await llm.analyzeOutlier({
    video,
    segments,
    outlierScore,
    cohort,
  });
  validateEvidenceRefs(llmResult.evidence, catalog);
  return {
    videoId: sourceVideoId,
    outlierScore,
    cohort,
    featureDiffs: [],
    hypothesis: llmResult.hypothesis,
    confidence: llmResult.confidence,
    evidence: llmResult.evidence,
  };
}
