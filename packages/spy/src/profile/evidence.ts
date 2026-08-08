import { AppError } from '../errors.ts';
import type { EvidenceRef } from '../schema.ts';
import type { SpyStore } from '../store.ts';

export interface EvidenceCatalog {
  videoIds: Set<string>;
  segmentIds: Set<string>;
  frameIds: Set<string>;
}

export function buildEvidenceCatalog(store: SpyStore, spyRunId: string): EvidenceCatalog {
  const catalog: EvidenceCatalog = {
    videoIds: new Set(),
    segmentIds: new Set(),
    frameIds: new Set(),
  };
  for (const video of store.listVideoSnapshots(spyRunId)) {
    catalog.videoIds.add(video.sourceVideoId);
    for (const segment of store.listTranscriptSegments(video.id)) {
      catalog.segmentIds.add(segment.id);
    }
    for (const frame of store.listFrameSamples(video.id)) {
      catalog.frameIds.add(frame.id);
    }
  }
  return catalog;
}

export function validateEvidenceRefs(
  refs: readonly EvidenceRef[],
  catalog: EvidenceCatalog,
): EvidenceRef[] {
  if (refs.length === 0) {
    throw new AppError('insufficient_evidence', 'Claim phải có ít nhất một evidence ref');
  }
  const validated: EvidenceRef[] = [];
  for (const ref of refs) {
    if (!catalog.videoIds.has(ref.videoId)) {
      throw new AppError('insufficient_evidence', `Video ${ref.videoId} không tồn tại trong spy run`);
    }
    if (ref.segmentIds) {
      for (const segmentId of ref.segmentIds) {
        if (!catalog.segmentIds.has(segmentId)) {
          throw new AppError('insufficient_evidence', `Segment ${segmentId} không tồn tại`);
        }
      }
    }
    if (ref.frameIds) {
      for (const frameId of ref.frameIds) {
        if (!catalog.frameIds.has(frameId)) {
          throw new AppError('insufficient_evidence', `Frame ${frameId} không tồn tại`);
        }
      }
    }
    const hasPointer = Boolean(
      (ref.segmentIds && ref.segmentIds.length > 0)
      || (ref.frameIds && ref.frameIds.length > 0)
      || ref.quote
      || ref.startSec !== undefined,
    );
    if (!hasPointer) {
      throw new AppError('insufficient_evidence', 'Evidence ref phải trỏ segment, frame, quote hoặc timestamp');
    }
    validated.push(ref);
  }
  return validated;
}
