/**
 * Turn key derivation (SDD §5.5):
 *
 *   turn_key = sha256(batchId | itemId | stage | attempt | sorted(inputHashes) | promptVersion)
 *
 * `inputHashes` is sorted before joining so the key is order-independent — two
 * dispatches that pin the same input set in a different order collapse to the same
 * key, while any change to `attempt` (or any other field) always changes it. This
 * is the mechanism that makes dispatch idempotent: the scheduler refuses to create
 * a second ledger row for an existing `turn_key` in a non-terminal state.
 */

import { createHash } from 'node:crypto';

export interface TurnKeyInput {
  batchId: string;
  itemId: string;
  stage: string;
  attempt: number;
  inputHashes: string[];
  promptVersion: string;
}

export function turnKey(input: TurnKeyInput): string {
  const sortedInputHashes = [...input.inputHashes].sort();
  const payload = [
    input.batchId,
    input.itemId,
    input.stage,
    String(input.attempt),
    sortedInputHashes.join(','),
    input.promptVersion,
  ].join('|');
  return createHash('sha256').update(payload).digest('hex');
}
