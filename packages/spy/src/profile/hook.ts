import type { LlmPort } from '../adapters/llm.ts';
import type { HookAnalysis, TranscriptSegment, VideoSnapshot } from '../schema.ts';
import type { SpyStore } from '../store.ts';
import { buildEvidenceCatalog, validateEvidenceRefs } from './evidence.ts';

export async function analyzeHooks(
  store: SpyStore,
  llm: LlmPort,
  spyRunId: string,
  videoIds?: string[],
): Promise<HookAnalysis[]> {
  const catalog = buildEvidenceCatalog(store, spyRunId);
  const videos = store.listVideoSnapshots(spyRunId).filter((v) =>
    !videoIds || videoIds.includes(v.sourceVideoId),
  );
  const results: HookAnalysis[] = [];
  for (const video of videos) {
    const segments = store.listTranscriptSegments(video.id);
    if (segments.length === 0) continue;
    const analyses = await llm.analyzeHooks({ video, segments });
    for (const analysis of analyses) {
      validateEvidenceRefs(analysis.evidence, catalog);
      results.push(analysis);
    }
  }
  return results;
}

export function segmentsForVideo(store: SpyStore, video: VideoSnapshot): TranscriptSegment[] {
  return store.listTranscriptSegments(video.id);
}
