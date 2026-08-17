/**
 * `WRITER_READY_PROFILE` (plan/writer-train/FORMULA-MIGRATION-TO-WRITER.md §2.2,
 * ADR-FM2/FM3/FM4/FM10) — the ONLY artifact a Writer agent may pin. Deliberately a
 * separate type in a separate store from `FormulaArtifact` (ADR-FM10): a Formula
 * describes one video with evidence tying every rule back to a transcript; a Profile
 * has been migrated (Studio, human-gated) into topic-agnostic guidance with the
 * evidence stripped and the wording genericized. Boundary is structural — nothing in
 * this package or `packages/daemon/src/training/profile-store.ts` imports the
 * Formula store, and nothing here can be constructed FROM a `FormulaArtifact` without
 * going through that human-gated migration.
 *
 * Deliberately thin (§2.1/§2.3): consistency guardrail for series voice/tone/
 * anti-pattern, NOT a full writing checklist. `guidelines` is a single flat list —
 * no five-bucket taxonomy, no mandatory `appliesWhen[]` — free-text `when`/`avoidWhen`
 * is enough at this stage (§5 "cắt" table).
 */

/** One consistency guideline a Profile carries. `sourceRuleIds` is provenance back to
 * the `VIDEO_FORMULA` rule(s) it was migrated from — deliberately NOT reconstructible
 * after the fact (the original rule statement is gone, replaced by genericized
 * `instruction`/`when`/`avoidWhen`), so this is the one field that must be captured at
 * publish time or lost forever (§2.2). `priority` is `CORE` sparingly — the plan's own
 * guidance is "≤ 8 CORE; thừa thì OPTIONAL hoặc cắt" (§2.2), enforced by human judgment
 * at Studio publish time, not by this type. */
export interface WriterReadyProfileGuideline {
  id: string;
  instruction: string;
  /** Free text, optional — when this guideline applies. Not a structured condition
   * language on purpose (§2.2/§5: a 5-bucket `appliesWhen[]` schema was cut). */
  when?: string;
  /** Free text, optional — when this guideline should NOT be followed. */
  avoidWhen?: string;
  priority: 'CORE' | 'OPTIONAL';
  sourceRuleIds: string[];
}

/** `TRIAL` = migrated + leak-checked + human-approved, safe to try. `VALIDATED` is
 * reachable ONLY by a human manually marking a Profile as such after using it across
 * a few pieces (ADR-FM13) — no factory or automated pipeline in this package (or
 * anywhere else) ever produces a `VALIDATED` Profile; every `publishProfile` call
 * hard-asserts `'TRIAL'`, mirroring how `formulaFromSingleAnalysis` hard-asserts
 * `FormulaStatus: 'TRIAL'` in `validator.ts`. */
export type WriterReadyProfileReadiness = 'TRIAL' | 'VALIDATED';

/**
 * The one Writer-facing artifact type (§1: "Không có runtime concept thứ ba tên
 * `Writer Formula`"). `version`/`id` together let the Writer pin an exact version
 * (§1 "Có (pin version/hash)"); each publish produces a new immutable record rather
 * than mutating one in place — see `publishProfile` in
 * `packages/daemon/src/training/studio.ts`.
 */
export interface WriterReadyProfile {
  kind: 'WRITER_READY_PROFILE';
  id: string;
  version: number;
  label: string;
  readiness: WriterReadyProfileReadiness;
  scope: {
    language: string;
    genre?: string;
    contentModes: string[];
  };
  editorialPromise?: string;
  guidelines: WriterReadyProfileGuideline[];
  antiPatterns: string[];
  /** Not in the plan's minimal §2.2 shape verbatim, but every other artifact this
   * package/store persists (`FormulaArtifact`, `TrainingLabRun`) carries one and
   * `profile-store.ts`'s `listProfiles` needs a stable sort key — same rationale as
   * that store's `createdAt` fields, not scope creep. */
  createdAt: string;
}
