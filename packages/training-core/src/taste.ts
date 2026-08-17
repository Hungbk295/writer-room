/**
 * Taste decision memory (plan/writer-train/FORMULA-MIGRATION-TO-WRITER.md §3,
 * ADR-FM5/FM11/FM12) — unit is a human edit pair (`before`/`after`) plus a closed
 * `decisionType` enum so retrieval (later, FM3) can filter by *kind of decision*
 * rather than topic similarity.
 *
 * Capture first, retrieve later. Do not mine cases from transcripts.
 */

export const TASTE_DECISION_TYPES = [
  'OPENING',
  'ANGLE',
  'TRANSITION',
  'DEPTH',
  'TONE',
  'ENDING',
  'CUT',
] as const;

export type TasteDecisionType = (typeof TASTE_DECISION_TYPES)[number];

export function isTasteDecisionType(v: unknown): v is TasteDecisionType {
  return typeof v === 'string' && (TASTE_DECISION_TYPES as readonly string[]).includes(v);
}

/**
 * One observed human intervention. Primary signal is the edit span (`before` →
 * `after`). `options` is optional and only for the rare case the agent itself
 * offered explicit alternatives (e.g. three angles).
 */
export interface TasteDecisionCase {
  id: string;
  decisionType: TasteDecisionType;
  situation: string;
  /** Agent text the human changed (span, not necessarily full draft). */
  before: string;
  /** Human replacement for that span. */
  after: string;
  options?: Array<{ id: string; description: string; status: 'CHOSEN' | 'REJECTED' }>;
  reason?: string;
  boundary?: string;
  doNotTransfer?: string[];
  evidenceStatus: 'OBSERVED' | 'INFERRED' | 'SYNTHETIC';
  humanValidated: boolean;
  /** Writer run that produced this edit, when captured from Writer. */
  writerRunId?: string;
  createdAt: string;
}
