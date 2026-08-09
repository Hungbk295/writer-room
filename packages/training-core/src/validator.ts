/**
 * Grounding validator + single-video Formula factory (SDD §8.1, §8.2, ADR-6).
 *
 * `validateAnalysis` is the Training-side equivalent of the Writer citation gate:
 * every extracted rule must cite evidence that is an exact substring of the pinned
 * transcript segment it claims to come from. This is what lets `LaneScheduler`'s
 * optional `validateContent` hook (packages/daemon/src/pipeline/lane-scheduler.ts)
 * reject an agent's output as `AGENT_UNGROUNDED` (SDD §5.2 commit-rule Branch 4)
 * before it is ever committed as an artifact.
 */
import { randomUUID } from 'node:crypto';
import type { AnalysisArtifact, FormulaArtifact, IncludedArtifactRef } from './contracts.ts';

export type ValidateAnalysisResult =
  | { ok: true }
  | { ok: false; errorCode: 'AGENT_UNGROUNDED'; reason: string };

/**
 * Validates an `AnalysisArtifact` against the transcript segments it was allowed to
 * cite. Returns the FIRST violation found (rule id + what failed) — good enough for
 * M1, no need to collect every violation (per task scope).
 */
export function validateAnalysis(
  analysis: AnalysisArtifact,
  segmentsById: Map<string, { text: string }>,
): ValidateAnalysisResult {
  if (!Array.isArray(analysis.rules) || analysis.rules.length === 0) {
    return { ok: false, errorCode: 'AGENT_UNGROUNDED', reason: 'analysis has zero rules — nothing extracted is not useful output' };
  }

  for (const rule of analysis.rules) {
    if (!Array.isArray(rule.evidence) || rule.evidence.length === 0) {
      return { ok: false, errorCode: 'AGENT_UNGROUNDED', reason: `rule "${rule.id}" has zero evidence entries` };
    }
    for (const evidence of rule.evidence) {
      const segment = segmentsById.get(evidence.segmentId);
      if (!segment) {
        return {
          ok: false,
          errorCode: 'AGENT_UNGROUNDED',
          reason: `rule "${rule.id}" cites segmentId "${evidence.segmentId}", which is not in the pinned transcript`,
        };
      }
      // Exact substring match — deliberately NOT fuzzy. Fuzzy matching would defeat
      // the point of the gate (SDD §8.1: quote must be verbatim from the segment).
      if (!segment.text.includes(evidence.quote)) {
        return {
          ok: false,
          errorCode: 'AGENT_UNGROUNDED',
          reason: `rule "${rule.id}" quotes "${evidence.quote}", which is not an exact substring of segment "${evidence.segmentId}"`,
        };
      }
    }
  }

  return { ok: true };
}

/**
 * ADR-6 factory: builds a `TRIAL` Formula from exactly one video's Analysis
 * artifact. `status` is hard-asserted to `'TRIAL'` here — there is no parameter for
 * it, and no caller of this function can ever produce a `VALIDATED` Formula. This is
 * the "assertion in the aggregator enforces it" SDD §8.2 refers to.
 */
export function formulaFromSingleAnalysis(
  analysis: AnalysisArtifact,
  includedRef: IncludedArtifactRef,
  sourceBatchId?: string,
): FormulaArtifact {
  return {
    id: randomUUID(),
    status: 'TRIAL',
    scope: 'SINGLE_CHANNEL',
    channelGroups: [
      { channelTitle: analysis.channelTitle, videoSnapshotIds: [analysis.videoSnapshotId] },
    ],
    rules: analysis.rules,
    includedArtifacts: [includedRef],
    // SDD §6.5 LOW_SAMPLE: "< 3 videos per channel" — one video is always low-sample.
    warnings: ['LOW_SAMPLE: Formula built from 1 video — TRIAL only, not statistically validated'],
    createdAt: new Date().toISOString(),
    ...(sourceBatchId ? { sourceBatchId } : {}),
  };
}
