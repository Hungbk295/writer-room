/**
 * Training Lab draft projection — what a *training* draft agent sees of a Formula
 * (rules without evidence). NOT Writer-ready: statements can still be source-bound.
 *
 * Replaces the deleted `toWriterFormula` name (FM1) so Training Lab keeps working
 * without implying the projection is safe for production Writer.
 */
import type { FormulaArtifact } from './contracts.ts';
import { normalizeFormula } from './validator.ts';

export interface TrainingDraftView {
  id: string;
  label: string;
  rules: Array<{ id: string; statement: string }>;
}

export function toTrainingDraftView(formula: FormulaArtifact): TrainingDraftView {
  const current = normalizeFormula(formula);
  const label =
    current.origin === 'COMPOUND'
      ? (current.genre ?? '')
      : (current.channelTitle ?? '');
  return {
    id: current.id,
    label,
    rules: current.rules.map((r) => ({ id: r.id, statement: r.statement })),
  };
}
