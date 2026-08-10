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
import type {
  AnalysisArtifact,
  CompoundRule,
  CritiqueArtifact,
  FormulaArtifact,
  IncludedArtifactRef,
} from './contracts.ts';

export type ValidateAnalysisResult =
  | { ok: true }
  | { ok: false; errorCode: 'AGENT_UNGROUNDED'; reason: string };

/**
 * Multi-segment grounding check shared by `validateAnalysis`/`validateCritique`/
 * `validateCompoundCritique` (added 2026-08-10, replacing a single-`segmentId`
 * check — see `Evidence`'s doc comment in `contracts.ts` for why). Looks up every
 * id in order, joins their `text` with a single space (this is how consecutive
 * auto-caption segments read as continuous prose — verified against real
 * transcripts), and requires `quote` to be an exact substring of that join.
 * Returns `null` on success, or a human-readable reason string on failure — the
 * caller wraps it into its own `AGENT_UNGROUNDED` shape (error codes/messages
 * differ slightly by call site, e.g. compound critique's "not among that video's
 * cited segments" vs plain "not in the pinned transcript").
 */
function groundQuoteInSegments(
  segmentIds: unknown,
  quote: string,
  segmentsById: Map<string, { text: string }>,
  missingSegmentReason: (segmentId: string) => string,
): string | null {
  if (!Array.isArray(segmentIds) || segmentIds.length === 0) {
    return 'has no segmentIds';
  }
  const texts: string[] = [];
  for (const segmentId of segmentIds) {
    const segment = segmentsById.get(segmentId);
    if (!segment) return missingSegmentReason(segmentId);
    texts.push(segment.text);
  }
  // Exact substring match — deliberately NOT fuzzy. Fuzzy matching would defeat the
  // point of the gate (SDD §8.1: quote must be verbatim from the segment(s)).
  if (!texts.join(' ').includes(quote)) {
    return `quotes "${quote}", which is not an exact substring of segments [${segmentIds.join(', ')}] joined`;
  }
  return null;
}

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
      const failure = groundQuoteInSegments(
        evidence.segmentIds, evidence.quote, segmentsById,
        (segmentId) => `cites segmentId "${segmentId}", which is not in the pinned transcript`,
      );
      if (failure) {
        return { ok: false, errorCode: 'AGENT_UNGROUNDED', reason: `rule "${rule.id}" ${failure}` };
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
    origin: 'ANALYZED',
    version: 1,
    videoSnapshotId: analysis.videoSnapshotId,
    channelTitle: analysis.channelTitle,
    rules: analysis.rules,
    includedArtifacts: [includedRef],
    lineage: {},
    // One video is one sample — stated honestly rather than silently.
    warnings: ['LOW_SAMPLE: Formula built from 1 video — TRIAL only, not statistically validated'],
    createdAt: new Date().toISOString(),
    ...(sourceBatchId ? { sourceBatchId } : {}),
  };
}

/** The pre-2026-08-10 on-disk Formula shape, before `scope`/`channelGroups` were
 * replaced by `origin`/`videoSnapshotId`/`channelTitle` (ADR-5). */
interface LegacyFormulaShape {
  scope?: string;
  channelGroups?: { channelTitle: string; videoSnapshotIds: string[] }[];
  origin?: string;
  version?: number;
  lineage?: unknown;
}

/**
 * Read-time migration. Formulas written before the 2026-08-10 unification carry
 * `scope`/`channelGroups` and no `origin`/`version`/`lineage`; this maps them onto
 * the current shape on the way out of storage, so no rewrite pass over the data
 * directory is needed and an old file stays readable forever.
 *
 * Every legacy Formula was necessarily produced by `formulaFromSingleAnalysis` (the
 * only writer that existed), so `origin: 'ANALYZED'` and `version: 1` are facts here,
 * not guesses.
 */
export function normalizeFormula(raw: FormulaArtifact): FormulaArtifact {
  const legacy = raw as FormulaArtifact & LegacyFormulaShape;
  if (legacy.origin && typeof legacy.version === 'number' && legacy.lineage) {
    return raw;
  }
  const group = legacy.channelGroups?.[0];
  const { scope: _scope, channelGroups: _channelGroups, ...rest } = legacy;
  return {
    ...rest,
    origin: 'ANALYZED',
    version: legacy.version ?? 1,
    lineage: {},
    videoSnapshotId: raw.videoSnapshotId ?? group?.videoSnapshotIds[0],
    channelTitle: raw.channelTitle ?? group?.channelTitle,
  };
}

export type ValidateCritiqueResult =
  | { ok: true }
  | { ok: false; errorCode: 'AGENT_UNGROUNDED'; reason: string };

/**
 * SDD §12a "Grounding rule for CRITIQUE (both directions)": every pattern (positive
 * or negative) must cite evidence on BOTH sides —
 *  - `sourceEvidence`: a quote that is an exact substring of the pinned transcript
 *    segment it claims to come from (same shape/check as `validateAnalysis` above).
 *  - `draftEvidence`: a quote that is an exact substring of the draft's own `script`
 *    text (no `segmentId` — the draft has no transcript-style segmentation).
 * A pattern with no evidence on either side is invalid, "same spirit as
 * AGENT_UNGROUNDED — this is what actually verifies an agent's appliedRules
 * self-report instead of trusting it" (§12a). Zero patterns total is also invalid,
 * same reasoning as `validateAnalysis`'s zero-rules check ("nothing found is not
 * useful critique"). Returns the FIRST violation found, same style as
 * `validateAnalysis` — good enough for M1.5, no need to collect every violation.
 */
export function validateCritique(
  critique: CritiqueArtifact,
  segmentsById: Map<string, { text: string }>,
  draftScript: string,
  /** Negative pattern ids from the PREVIOUS round (2026-08-10, "gate" fix — user:
   * "khi agent 1 check thì cũng k có gate để verify là đã sửa đúng chưa"). Empty/
   * omitted on round 1 (nothing to check yet). Coverage-only check, "mức nhẹ" per
   * user's own framing: every id here must appear in `critique.regressionCheck` with
   * a valid `status` and a non-empty `note` — the TRUTH of that status is NOT
   * verified (no evidence requirement), same trust level as REFINE's `changeLog`. */
  previousNegativePatternIds: string[] = [],
): ValidateCritiqueResult {
  const positive = Array.isArray(critique.positivePatterns) ? critique.positivePatterns : [];
  const negative = Array.isArray(critique.negativePatterns) ? critique.negativePatterns : [];

  if (positive.length + negative.length === 0) {
    return { ok: false, errorCode: 'AGENT_UNGROUNDED', reason: 'critique has zero patterns — nothing found is not useful critique' };
  }

  if (previousNegativePatternIds.length > 0) {
    const regressionCheck = Array.isArray(critique.regressionCheck) ? critique.regressionCheck : [];
    const byId = new Map(regressionCheck.map((r) => [r.patternId, r]));
    const validStatuses = new Set(['fixed', 'still-present', 'partial']);
    for (const patternId of previousNegativePatternIds) {
      const entry = byId.get(patternId);
      if (!entry) {
        return {
          ok: false,
          errorCode: 'AGENT_UNGROUNDED',
          reason: `regressionCheck is missing an entry for previous round's negative pattern "${patternId}"`,
        };
      }
      if (!validStatuses.has(entry.status)) {
        return {
          ok: false,
          errorCode: 'AGENT_UNGROUNDED',
          reason: `regressionCheck entry "${patternId}" has invalid status "${entry.status}" (must be fixed/still-present/partial)`,
        };
      }
      if (typeof entry.note !== 'string' || !entry.note.trim()) {
        return {
          ok: false,
          errorCode: 'AGENT_UNGROUNDED',
          reason: `regressionCheck entry "${patternId}" has an empty note`,
        };
      }
    }
  }

  const allPatterns = [
    ...positive.map((p) => ({ side: 'positivePatterns', pattern: p })),
    ...negative.map((p) => ({ side: 'negativePatterns', pattern: p })),
  ];

  for (const { side, pattern } of allPatterns) {
    const sourceEvidence = Array.isArray(pattern.sourceEvidence) ? pattern.sourceEvidence : [];
    const draftEvidence = Array.isArray(pattern.draftEvidence) ? pattern.draftEvidence : [];

    if (sourceEvidence.length === 0) {
      return {
        ok: false,
        errorCode: 'AGENT_UNGROUNDED',
        reason: `pattern "${pattern.id}" (${side}) has zero sourceEvidence entries`,
      };
    }
    if (draftEvidence.length === 0) {
      return {
        ok: false,
        errorCode: 'AGENT_UNGROUNDED',
        reason: `pattern "${pattern.id}" (${side}) has zero draftEvidence entries`,
      };
    }

    for (const evidence of sourceEvidence) {
      const failure = groundQuoteInSegments(
        evidence.segmentIds, evidence.quote, segmentsById,
        (segmentId) => `cites segmentId "${segmentId}", which is not in the pinned transcript`,
      );
      if (failure) {
        return { ok: false, errorCode: 'AGENT_UNGROUNDED', reason: `pattern "${pattern.id}" (${side}) sourceEvidence ${failure}` };
      }
    }

    for (const evidence of draftEvidence) {
      if (!draftScript.includes(evidence.quote)) {
        return {
          ok: false,
          errorCode: 'AGENT_UNGROUNDED',
          reason: `pattern "${pattern.id}" (${side}) quotes "${evidence.quote}" as draftEvidence, which is not an exact substring of the draft script`,
        };
      }
    }
  }

  return { ok: true };
}

/* ------------------------------------------------------------------------- *
 * Formula Studio validators (SDD §12b, ADR-13)
 * ------------------------------------------------------------------------- */

export type ValidateCompoundRuleResult =
  | { ok: true }
  | { ok: false; errorCode: 'STUDIO_RULE_UNGROUNDED'; reason: string };

/**
 * A compound rule must stay traceable to the real videos it was distilled from.
 * This is the L2 equivalent of `validateAnalysis`'s evidence gate: an LLM that
 * invents a nice-sounding merged rule with no provenance is producing exactly the
 * unfalsifiable output the Studio exists to prevent.
 *
 * Note this checks provenance *structure*, not the quotes themselves — those were
 * already verified verbatim by `validateAnalysis` when the L1 Formula was committed,
 * and are carried through unchanged. Re-checking them here would need every source
 * transcript in memory for no added safety.
 */
export function validateCompoundRule(rule: CompoundRule): ValidateCompoundRuleResult {
  if (!rule.statement || rule.statement.trim().length === 0) {
    return { ok: false, errorCode: 'STUDIO_RULE_UNGROUNDED', reason: `rule "${rule.id}" has an empty statement` };
  }
  if (!Array.isArray(rule.sources) || rule.sources.length === 0) {
    return {
      ok: false,
      errorCode: 'STUDIO_RULE_UNGROUNDED',
      reason: `rule "${rule.id}" has zero sources — a merged rule must name the video(s) it came from`,
    };
  }
  for (const source of rule.sources) {
    if (!source.videoSnapshotId || !source.sourceFormulaId || !source.sourceRuleId) {
      return {
        ok: false,
        errorCode: 'STUDIO_RULE_UNGROUNDED',
        reason: `rule "${rule.id}" has a source entry missing videoSnapshotId/sourceFormulaId/sourceRuleId`,
      };
    }
  }
  return { ok: true };
}

export type ValidateCompoundCritiqueResult =
  | { ok: true }
  | { ok: false; errorCode: 'AGENT_UNGROUNDED' | 'STUDIO_EVIDENCE_OUT_OF_SCOPE'; reason: string };

/**
 * SDD §12b — the compound-level counterpart of `validateCritique`.
 *
 * Kept as a SEPARATE function rather than an extra mode on `validateCritique` so the
 * single-video Training Lab path (proven live) is not touched at all. The difference
 * is that a compound Formula has no single source transcript, so every `sourceEvidence`
 * entry must say WHICH video it came from, and that video must be one the compound
 * actually draws from — an agent citing a video outside the Formula's provenance is
 * grounding its critique in something the Formula never claimed.
 *
 * `segmentsByVideo` only needs to contain the segments actually cited by the
 * compound's rules (SDD §12b "Envelope size"), not whole transcripts.
 */
export function validateCompoundCritique(
  critique: CritiqueArtifact,
  segmentsByVideo: Map<string, Map<string, { text: string }>>,
  draftScript: string,
): ValidateCompoundCritiqueResult {
  const positive = Array.isArray(critique.positivePatterns) ? critique.positivePatterns : [];
  const negative = Array.isArray(critique.negativePatterns) ? critique.negativePatterns : [];

  if (positive.length + negative.length === 0) {
    return { ok: false, errorCode: 'AGENT_UNGROUNDED', reason: 'critique has zero patterns — nothing found is not useful critique' };
  }

  const allPatterns = [
    ...positive.map((p) => ({ side: 'positivePatterns', pattern: p })),
    ...negative.map((p) => ({ side: 'negativePatterns', pattern: p })),
  ];

  for (const { side, pattern } of allPatterns) {
    const sourceEvidence = Array.isArray(pattern.sourceEvidence) ? pattern.sourceEvidence : [];
    const draftEvidence = Array.isArray(pattern.draftEvidence) ? pattern.draftEvidence : [];

    if (sourceEvidence.length === 0) {
      return { ok: false, errorCode: 'AGENT_UNGROUNDED', reason: `pattern "${pattern.id}" (${side}) has zero sourceEvidence entries` };
    }
    if (draftEvidence.length === 0) {
      return { ok: false, errorCode: 'AGENT_UNGROUNDED', reason: `pattern "${pattern.id}" (${side}) has zero draftEvidence entries` };
    }

    for (const evidence of sourceEvidence) {
      if (!evidence.videoSnapshotId) {
        return {
          ok: false,
          errorCode: 'STUDIO_EVIDENCE_OUT_OF_SCOPE',
          reason: `pattern "${pattern.id}" (${side}) has a sourceEvidence entry with no videoSnapshotId — required when critiquing a compound Formula`,
        };
      }
      const segments = segmentsByVideo.get(evidence.videoSnapshotId);
      if (!segments) {
        return {
          ok: false,
          errorCode: 'STUDIO_EVIDENCE_OUT_OF_SCOPE',
          reason: `pattern "${pattern.id}" (${side}) cites video "${evidence.videoSnapshotId}", which this compound Formula does not draw from`,
        };
      }
      const failure = groundQuoteInSegments(
        evidence.segmentIds, evidence.quote, segments,
        (segmentId) => `cites segmentId "${segmentId}" of video "${evidence.videoSnapshotId}", which is not among that video's cited segments`,
      );
      if (failure) {
        return { ok: false, errorCode: 'AGENT_UNGROUNDED', reason: `pattern "${pattern.id}" (${side}) sourceEvidence ${failure}` };
      }
    }

    for (const evidence of draftEvidence) {
      if (!draftScript.includes(evidence.quote)) {
        return {
          ok: false,
          errorCode: 'AGENT_UNGROUNDED',
          reason: `pattern "${pattern.id}" (${side}) quotes "${evidence.quote}" as draftEvidence, which is not an exact substring of the draft script`,
        };
      }
    }
  }

  return { ok: true };
}
