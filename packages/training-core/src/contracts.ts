/**
 * Training-core contracts (SDD 002 §8.1 Analysis artifact, §8.2 Formula artifact,
 * ADR-6). Pure types + the grounding validator — no I/O, no daemon/agent knowledge.
 * Mirrors how `pipeline-core` stays framework-agnostic; this package is
 * Training-domain-specific but still I/O-agnostic (per `plan/writer-train/HANDOFF.md`
 * §3, Training-specific types live here, not in `pipeline-core`).
 */

/** One cited quote from a pinned transcript segment (SDD §8.1). */
export interface Evidence {
  segmentId: string;
  /** Must be an exact substring of that segment's `text` — this is what makes a
   * rule "grounded" (SDD §8.1: "Validation rejects any rule with zero evidence...
   * this is the Training-side equivalent of the Writer citation gate"). */
  quote: string;
  startSec?: number;
  endSec?: number;
}

/** One extracted pattern/style claim about a single video, with its evidence. */
export interface AnalysisRule {
  id: string;
  statement: string;
  /** Zero-length is invalid — see `validateAnalysis`. */
  evidence: Evidence[];
}

/** The ANALYZE-stage artifact committed for one item (SDD §6.1 "Item stage machine"). */
export interface AnalysisArtifact {
  videoSnapshotId: string;
  channelTitle: string;
  rules: AnalysisRule[];
  createdAt: string;
}

/** SDD §8.2 — `VALIDATED` is unreachable in MVP code (ADR-6); the type still names
 * it so downstream code (Writer, future M2+) can express "this Formula was later
 * promoted", but `formulaFromSingleAnalysis` below never constructs one. */
export type FormulaStatus = 'DRAFT' | 'TRIAL' | 'VALIDATED';

export type FormulaScope = 'SINGLE_CHANNEL' | 'PER_CHANNEL_COMPARE' | 'CROSS_CHANNEL_SHARED';

/** A hash-pinned reference to one included Analysis artifact (SDD §6.6 AGGREGATE_FORMULA
 * step 2/3 — "verify every selected artifact hash still matches on disk"). */
export interface IncludedArtifactRef {
  videoSnapshotId: string;
  analysisArtifactHash: string;
}

export interface FormulaArtifact {
  id: string;
  status: FormulaStatus;
  scope: FormulaScope;
  channelGroups: { channelTitle: string; videoSnapshotIds: string[] }[];
  /** For M1 (single video), this is just that video's rules, carried through
   * unchanged — M2's aggregator is where cross-item rule merging/differencing
   * happens (SDD §6.1 step 4/5, out of scope here). */
  rules: AnalysisRule[];
  includedArtifacts: IncludedArtifactRef[];
  /** e.g. a `LOW_SAMPLE` warning (SDD §6.5) for a single-video Formula. */
  warnings: string[];
  createdAt: string;
  /** The `batchId` the dispatch that produced this Formula was run under — lets the
   * UI correlate a finished poll (`GET /api/training/formula-discovery/status`) back
   * to the Formula it produced, since `id` itself is a fresh `randomUUID()` unrelated
   * to `batchId`. Optional/additive: older persisted Formulas simply omit it. */
  sourceBatchId?: string;
}
