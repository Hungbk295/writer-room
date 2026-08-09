/**
 * Pure batch-status reducer — no I/O, no domain knowledge. Implements the decision
 * table in SDD §6.2 exactly, evaluated in order with first-match-wins semantics.
 */

import type { BatchStatus, ItemStatus } from './contracts.ts';

const RUNNING_LIKE: ReadonlySet<ItemStatus> = new Set(['QUEUED', 'WAITING_LANE', 'RUNNING', 'VALIDATING']);
const ACTIVELY_RUNNING: ReadonlySet<ItemStatus> = new Set(['RUNNING', 'VALIDATING']);
const NEEDS_ATTENTION_LIKE: ReadonlySet<ItemStatus> = new Set(['HUMAN_WAIT', 'INTERRUPTED', 'FAILED']);
const FAILED_LIKE: ReadonlySet<ItemStatus> = new Set(['FAILED', 'SKIPPED', 'CANCELLED']);

export interface DeriveBatchStatusOptions {
  stopRequested: boolean;
}

/**
 * NOTE — "FAILED" vs "FAILED-retryable" (SDD §6.2 row 3):
 * `ItemStatus` carries no separate retryable flag, so this reducer treats every
 * `FAILED` item as retryable-by-default. Concretely that means: whenever no item is
 * actively running, a single `FAILED` item always routes the batch to
 * `NEEDS_ATTENTION` (row 3) before rows 4-6 are even considered, since row 3 is
 * evaluated first. That is a deliberate reading, not an oversight: `SKIPPED` and
 * `CANCELLED` are terminal states the user already decided on, so they can
 * legitimately contribute to `PARTIAL_SUCCESS`/`FAILED` (rows 5-6) without further
 * attention, whereas an unresolved `FAILED` item always still has a pending human
 * decision (retry or skip) and so always needs attention first. A consequence:
 * `PARTIAL_SUCCESS`/`FAILED` outcomes that involve a `FAILED` item are effectively
 * unreachable by this reducer — they are reached only via `SKIPPED`/`CANCELLED`
 * items. If a future milestone adds a real "retryable" flag (e.g. some FAILED
 * reasons are terminal, like AGENT_UNGROUNDED), this reducer's signature should
 * grow a second parameter rather than silently keep this default.
 */
export function deriveBatchStatus(items: ItemStatus[], opts: DeriveBatchStatusOptions): BatchStatus {
  // NOTE — empty-items edge case: with zero items, "any item is X" is vacuously
  // false and "all items are X" is vacuously true. That makes rows 2 and 3 fall
  // through naturally and row 4 ("all items SUCCEEDED") match by vacuous truth, so
  // an empty batch reports SUCCEEDED unless stopRequested is set (row 1 still
  // applies: no item is RUNNING/VALIDATING, so stopRequested alone is enough to
  // report CANCELLED). This is a deliberate, sane default — an empty batch never
  // crashes the reducer — rather than an accidental fallthrough.

  const anyActivelyRunning = items.some((status) => ACTIVELY_RUNNING.has(status));

  // Row 1: stop_requested and no item is RUNNING/VALIDATING.
  if (opts.stopRequested && !anyActivelyRunning) {
    return 'CANCELLED';
  }

  // Row 2: any item in QUEUED / WAITING_LANE / RUNNING / VALIDATING.
  if (items.some((status) => RUNNING_LIKE.has(status))) {
    return 'RUNNING';
  }

  // Row 3: no item running, and >=1 item in HUMAN_WAIT / INTERRUPTED / FAILED(-retryable).
  if (items.some((status) => NEEDS_ATTENTION_LIKE.has(status))) {
    return 'NEEDS_ATTENTION';
  }

  // Row 4: all items SUCCEEDED (vacuously true for an empty batch — see NOTE above).
  if (items.every((status) => status === 'SUCCEEDED')) {
    return 'SUCCEEDED';
  }

  // Row 5: >=1 SUCCEEDED and >=1 FAILED/SKIPPED/CANCELLED, none pending.
  const anySucceeded = items.some((status) => status === 'SUCCEEDED');
  const anyFailedLike = items.some((status) => FAILED_LIKE.has(status));
  if (anySucceeded && anyFailedLike) {
    return 'PARTIAL_SUCCESS';
  }

  // Row 6: no item SUCCEEDED, none pending.
  return 'FAILED';
}
