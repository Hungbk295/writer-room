import type { LlmPort } from '../adapters/llm.ts';
import type { VoiceProfile } from '../schema.ts';
import type { SpyStore } from '../store.ts';
import { buildEvidenceCatalog, validateEvidenceRefs } from './evidence.ts';
import { segmentsForVideo } from './hook.ts';

export async function analyzeVoice(
  store: SpyStore,
  llm: LlmPort,
  spyRunId: string,
): Promise<VoiceProfile> {
  const catalog = buildEvidenceCatalog(store, spyRunId);
  const videos = store.listVideoSnapshots(spyRunId);
  const channelTitle = videos[0]?.channelTitle ?? 'unknown';
  const profile = await llm.analyzeVoice({
    channelTitle,
    videos: videos.map((video) => ({
      video,
      segments: segmentsForVideo(store, video),
    })),
  });
  validateEvidenceRefs(profile.evidence, catalog);
  for (const phrase of profile.signaturePhrases) {
    validateEvidenceRefs(phrase.evidence, catalog);
  }
  return profile;
}
