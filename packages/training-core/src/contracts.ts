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
 * it so downstream code (Writer) can express "this Formula was later promoted", but
 * no factory in this package ever constructs one. */
export type FormulaStatus = 'DRAFT' | 'TRIAL' | 'VALIDATED';

/**
 * How a Formula came to exist. This replaces the old `scope`
 * (`SINGLE_CHANNEL`/`PER_CHANNEL_COMPARE`/`CROSS_CHANNEL_SHARED`), which described
 * the channel-grouping design that ADR-5 rejected outright — a channel has many
 * styles, so a "channel Formula" was never a real thing.
 *
 *  - `ANALYZED` — one video's `ANALYZE` output. The atomic unit (SDD §6.1a).
 *  - `REFINED`  — a Training Lab round improved a previous version (SDD §12a).
 *    Still about the same single video; `lineage.parentFormulaId` names its parent.
 *  - `COMPOUND` — a human merged rules from several Formulas in a Studio session
 *    (SDD §12b). Scoped to a `genre`, never to a channel.
 *
 * All three live in the SAME store and are interchangeable to the Writer: this is
 * the point of the 2026-08-10 unification. Before it, `REFINED` versions were
 * trapped inside `lab-runs/*.json` and compound Formulas inside
 * `studio-sessions/*.json`, so the two things that represent *improvement* were the
 * two things nothing downstream could use.
 */
export type FormulaOrigin = 'ANALYZED' | 'REFINED' | 'COMPOUND';

/** A hash-pinned reference to one included Analysis artifact (SDD §6.6 step 2/3 —
 * "verify every selected artifact hash still matches on disk"). */
export interface IncludedArtifactRef {
  videoSnapshotId: string;
  analysisArtifactHash: string;
}

/** Which process produced this Formula, by reference. The process's own log
 * (`lab-runs/*.json`, `studio-sessions/*.json`) points AT the Formula; it never
 * contains it. */
export interface FormulaLineage {
  /** `REFINED`: the version this was refined from. */
  parentFormulaId?: string;
  /** `REFINED`: the Training Lab run (SDD §12a). */
  labRunId?: string;
  /** `COMPOUND`: the Studio session that assembled it (SDD §12b). */
  studioSessionId?: string;
}

/**
 * A rule inside a Formula. `sources`/`mergeOrigin` are populated only on `COMPOUND`
 * Formulas — for `ANALYZED`/`REFINED` the Formula itself names the one video, so
 * per-rule provenance would be pure repetition.
 */
export interface FormulaRule extends AnalysisRule {
  /** `COMPOUND` only: every (video, formula, rule) this merged rule came from.
   * Non-empty is enforced by `validateCompoundRule`. */
  sources?: RuleSource[];
  /** `COMPOUND` only: how this rule entered the compound. */
  mergeOrigin?: CompoundRuleOrigin;
}

/**
 * The one Formula type. `origin` discriminates; the optional fields below are
 * documented per-origin rather than split into a union, deliberately — a union would
 * force every consumer (storage, pool, UI, Writer) to narrow before reading `rules`,
 * which is the field they all actually want.
 */
export interface FormulaArtifact {
  id: string;
  status: FormulaStatus;
  origin: FormulaOrigin;
  /** 1 for a fresh `ANALYZED`; incremented by each `REFINED`/`COMPOUND` rebuild. */
  version: number;
  rules: FormulaRule[];
  /** `ANALYZED`/`REFINED`: the single video this Formula describes. A Formula at
   * these origins is about exactly one video — an invariant the old `channelGroups`
   * array could not express. */
  videoSnapshotId?: string;
  /** Display/filter label only, never a grouping key (ADR-5). */
  channelTitle?: string;
  /** `COMPOUND`: the user-named content genre (`thể loại`) this was distilled for. */
  genre?: string;
  includedArtifacts: IncludedArtifactRef[];
  lineage: FormulaLineage;
  /** e.g. a `LOW_SAMPLE` warning for a single-video Formula. */
  warnings: string[];
  createdAt: string;
  /** The `batchId` the dispatch that produced this Formula ran under — lets the UI
   * correlate a finished poll back to the Formula it produced. */
  sourceBatchId?: string;
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

/**
 * One prior round's negative pattern, re-checked against THIS round's draft (added
 * 2026-08-10 — closes the "does anyone verify a flagged issue actually got fixed"
 * gap: CRITIQUE previously had no memory of what earlier rounds found, so a
 * recurring issue could silently go unmentioned forever). Deliberately "light":
 * `status`/`note` are self-reported, NOT grounded/validated like `CritiquePattern`
 * evidence — same trust level as REFINE's `changeLog`. Only the COVERAGE is
 * enforced (one entry per prior negative pattern id), not the correctness of the
 * status itself.
 */
export interface RegressionCheckEntry {
  patternId: string;
  status: 'fixed' | 'still-present' | 'partial';
  note: string;
}

/** The `CRITIQUE`-stage artifact (SDD §12a stage table). Grading is qualitative
 * pattern-matching, not a numeric score (user: "tạo tiêu chí chấm đơn giản thôi"). */
export interface CritiqueArtifact {
  positivePatterns: CritiquePattern[];
  negativePatterns: CritiquePattern[];
  /** Present from round 2 onward when the previous round had negative patterns;
   * absent/omitted on round 1 (nothing to check yet). See `RegressionCheckEntry`. */
  regressionCheck?: RegressionCheckEntry[];
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
 * Formula Studio (SDD §12b, ADR-5/ADR-13) — the `COMPOUND` origin.
 *
 * A compound Formula is NOT a separate type: it is a `FormulaArtifact` with
 * `origin: 'COMPOUND'`, a `genre`, and rules carrying `sources`. That unification
 * (2026-08-10) is what lets the Writer pin a compound Formula and the Studio pool
 * pick from a refined one, with no per-level special casing anywhere downstream.
 * ------------------------------------------------------------------------- */

/** Where one merged rule came from. A non-empty `sources[]` is what makes a compound
 * rule auditable AND what lets the compound `CRITIQUE` ship only the cited evidence
 * spans instead of whole transcripts (SDD §12b "Envelope size"). */
export interface RuleSource {
  videoSnapshotId: string;
  /** Display/audit label only — never a grouping key (ADR-5). */
  channelTitle: string;
  sourceFormulaId: string;
  sourceRuleId: string;
  /** Carried verbatim from the source rule; powers the lean critique envelope. */
  evidence: Evidence[];
}

/** How a rule entered a compound Formula. `CARRIED` = a picked rule nothing else
 * resembled, taken as-is; `SYNTHESIZED` = an LLM worded one rule out of a cluster the
 * human approved; `HUMAN_EDITED` = the human rewrote the statement themselves. */
export type CompoundRuleOrigin = 'CARRIED' | 'SYNTHESIZED' | 'HUMAN_EDITED';

/** A `FormulaRule` known to carry compound provenance — the shape
 * `validateCompoundRule` checks and `rebuildCompound` produces. */
export interface CompoundRule extends FormulaRule {
  sources: RuleSource[];
  mergeOrigin: CompoundRuleOrigin;
}

/** Distinct source videos behind a compound Formula — the honest sample size.
 * Derived, never stored: a stored copy could disagree with `rules` after an edit. */
export function sourceVideoCount(rules: FormulaRule[]): number {
  return new Set(rules.flatMap((r) => (r.sources ?? []).map((s) => s.videoSnapshotId))).size;
}
