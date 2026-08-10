/**
 * Training-core contracts (SDD 002 §8.1 Analysis artifact, §8.2 Formula artifact,
 * ADR-6). Pure types + the grounding validator — no I/O, no daemon/agent knowledge.
 * Mirrors how `pipeline-core` stays framework-agnostic; this package is
 * Training-domain-specific but still I/O-agnostic (per `plan/writer-train/HANDOFF.md`
 * §3, Training-specific types live here, not in `pipeline-core`).
 */

/** One cited quote from the pinned transcript (SDD §8.1). */
export interface Evidence {
  /**
   * One or more segment ids, in transcript order (changed 2026-08-10 from a single
   * `segmentId` — real auto-caption transcripts chunk into ~4s windows that often
   * split mid-sentence, so a single segment is frequently too short to hold a
   * complete, natural quote). `quote` must be an exact substring of those segments'
   * `text` values joined with a single space, in the order given — this is what
   * makes a rule "grounded" (SDD §8.1: "Validation rejects any rule with zero
   * evidence... this is the Training-side equivalent of the Writer citation gate").
   * Segments do not need to be contiguous, but usually are for a real quote.
   */
  segmentIds: string[];
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

/**
 * SDD §12a "Training Lab — calibration loop": one version in a per-video Formula
 * version history. `version: 1` is always the original `ANALYZE` output (the
 * existing M1 `FormulaArtifact`, wrapped — not re-derived); each `REFINE` round
 * produces `version: N+1` with `parentFormulaId` pointing at the `FormulaArtifact.id`
 * it was refined from. Every version is kept (§12a "Formula versioning" — "v1, v2,
 * v3... are never deleted, they are the run's log"); nothing here auto-promotes a
 * version to canonical, same ADR-6 spirit `formulaFromSingleAnalysis` already follows.
 */
export interface FormulaVersion extends FormulaArtifact {
  version: number;
  parentFormulaId?: string;
}

/** One cited quote used by a `CritiquePattern` (SDD §12a "Grounding rule for
 * CRITIQUE"). `segmentIds` is present only on the source-transcript side — the
 * draft has no transcript-style segmentation, so draft-side evidence is a bare
 * substring-match quote. Same multi-segment shape as `Evidence` above, and for the
 * same reason (2026-08-10). */
export interface CritiqueEvidence {
  quote: string;
  segmentIds?: string[];
  /** SDD §12b: which video this source quote came from. Omitted on the single-video
   * Training Lab path (there is only one transcript, so it is implied); REQUIRED when
   * critiquing a `CompoundFormula`, whose rules come from several videos. */
  videoSnapshotId?: string;
}

/**
 * One positive-or-negative observation the `CRITIQUE` stage makes about a `DRAFT`,
 * grounded on BOTH sides per SDD §12a: at least one quote from the original pinned
 * transcript (`sourceEvidence`, `segmentId` required) AND at least one quote that is
 * an exact substring of the draft's own `script` (`draftEvidence`). This is what
 * actually verifies a `DraftArtifact.appliedRules` self-report instead of trusting
 * it — see `validateCritique` in `validator.ts`.
 */
export interface CritiquePattern {
  id: string;
  ruleId?: string;
  description: string;
  sourceEvidence: CritiqueEvidence[];
  draftEvidence: CritiqueEvidence[];
}

/** The `CRITIQUE`-stage artifact (SDD §12a stage table). Grading is qualitative
 * pattern-matching, not a numeric score (user: "tạo tiêu chí chấm đơn giản thôi"). */
export interface CritiqueArtifact {
  positivePatterns: CritiquePattern[];
  negativePatterns: CritiquePattern[];
}

/** The `DRAFT`-stage artifact (SDD §12a stage table). `appliedRules` is a
 * self-report from the writer agent — NOT trusted on its own; `CRITIQUE` verifies
 * it against the real transcript and the draft's own text. */
export interface DraftArtifact {
  title: string;
  script: string;
  appliedRules: string[];
}

/* ------------------------------------------------------------------------- *
 * Formula Studio (SDD §12b, ADR-5/ADR-13) — the L2 "compound" Formula level.
 *
 * L1 = `FormulaArtifact` above: one video's rules, the atomic unit.
 * L2 = `CompoundFormula` below: rules a HUMAN picked across several L1 Formulas
 *      and merged, scoped to a content genre (`thể loại`) — never to a channel,
 *      and never produced automatically by a batch (ADR-5).
 * ------------------------------------------------------------------------- */

/** Where one compound rule came from. Non-empty `provenance[]` is what makes a
 * merged rule auditable AND what lets the compound `CRITIQUE` ship only the cited
 * evidence spans instead of whole transcripts (SDD §12b "Envelope size"). */
export interface CompoundRuleProvenance {
  videoSnapshotId: string;
  /** Display/audit label only — never a grouping key (ADR-5). */
  channelTitle: string;
  sourceFormulaId: string;
  sourceRuleId: string;
  /** Carried verbatim from the L1 rule; powers the lean critique envelope. */
  evidence: Evidence[];
}

/** How a compound rule came to exist. `CARRIED` = a single picked rule taken as-is;
 * `SYNTHESIZED` = an LLM worded one rule out of a cluster the human approved;
 * `HUMAN_EDITED` = the human rewrote the statement themselves. */
export type CompoundRuleOrigin = 'CARRIED' | 'SYNTHESIZED' | 'HUMAN_EDITED';

export interface CompoundRule {
  id: string;
  statement: string;
  /** Non-empty, enforced by `validateCompoundRule`. */
  provenance: CompoundRuleProvenance[];
  origin: CompoundRuleOrigin;
}

/** A genre-scoped Formula assembled in a Studio session. `status` follows ADR-6:
 * starts `DRAFT`, becomes `TRIAL` only by explicit human promotion, never
 * `VALIDATED` in the MVP. */
export interface CompoundFormula {
  id: string;
  /** User-named content genre, e.g. "kể chuyện tài chính cá nhân". Free-form on
   * purpose — the point is that the user discovers the right genres by doing this,
   * so there is no hardcoded taxonomy (SDD §12b "Genre, not channel"). */
  genre: string;
  status: FormulaStatus;
  rules: CompoundRule[];
  /** Distinct videos across all rules' provenance — the honest sample size. */
  sourceVideoCount: number;
  sessionId: string;
  version: number;
  createdAt: string;
}
