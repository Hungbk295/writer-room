import type { LlmPort } from '../adapters/llm.ts';
import type { StructureBeat } from '../schema.ts';
import type { SpyStore } from '../store.ts';
import { buildEvidenceCatalog, validateEvidenceRefs } from './evidence.ts';
import { segmentsForVideo } from './hook.ts';

export async function analyzeStructure(
  store: SpyStore,
  llm: LlmPort,
  spyRunId: string,
  sourceVideoId: string,
): Promise<StructureBeat[]> {
  const catalog = buildEvidenceCatalog(store, spyRunId);
  const video = store.listVideoSnapshots(spyRunId).find((v) => v.sourceVideoId === sourceVideoId);
  if (!video) return [];
  const segments = segmentsForVideo(store, video);
  const beats = await llm.analyzeStructure({
    video,
    segments,
    durationSec: video.durationSec,
  });
  return beats.map((beat) => {
    validateEvidenceRefs(beat.evidence, catalog);
    return beat;
  });
}
