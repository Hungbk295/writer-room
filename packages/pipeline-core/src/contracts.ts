/**
 * Pipeline-core contracts (SDD 002 §Application Data Models, §5.5, §5.7, §6.2).
 *
 * These are pure types with zero I/O and zero knowledge of any specific workflow
 * domain (Formula/Training, Writer, ...). Per `plan/writer-train/HANDOFF.md` §3,
 * pipeline-core must stay generic so both the Training lane and the Writer lane can
 * plug into it without pipeline-core depending on either. Domain-specific fields
 * from the SDD's `DatasetRevision` (e.g. `formulaScope`) intentionally do not
 * appear here — a domain package (e.g. `training-core`) is expected to carry them
 * alongside a reference to the generic types below, not fold them into this file.
 */

/** All 10 item states from SDD §Application Data Models / HANDOFF §4 "đủ 10 status". */
export type ItemStatus =
  | 'QUEUED'
  | 'WAITING_LANE'
  | 'RUNNING'
  | 'VALIDATING'
  | 'HUMAN_WAIT'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'SKIPPED'
  | 'CANCELLED'
  | 'INTERRUPTED';

/** Batch-level status, derived (never independently mutated) per SDD §6.2. */
export type BatchStatus = 'RUNNING' | 'NEEDS_ATTENTION' | 'SUCCEEDED' | 'PARTIAL_SUCCESS' | 'FAILED' | 'CANCELLED';

/** Execution mode for a dataset revision — one item or many, per SDD §Application Data Models. */
export type ExecutionMode = 'SINGLE' | 'BATCH';

/**
 * A pinned, immutable dataset revision. `items` are opaque item ids/refs — the
 * shape of an "item" (video, title, ...) belongs to the domain package, not here.
 */
export interface DatasetRevision {
  id: string;
  items: string[];
  executionMode: ExecutionMode;
  createdAt: string;
}

/** Scoped turn budget passed to `requestTurn`, per SDD §5.4. */
export interface ScopedBudget {
  maxTurns?: number;
  maxDurationMinutes?: number;
  cooldownSeconds?: number;
}

/**
 * A batch run over a set of items. `workflowKind` is a free string
 * (`'FORMULA_DISCOVERY' | 'WRITER' | ...`) owned by the calling domain package —
 * pipeline-core never branches on its value.
 */
export interface BatchRun {
  id: string;
  workflowKind: string;
  itemRefs: string[];
  maxParallel: number;
  perItemBudget: ScopedBudget | null;
  paused: boolean;
  stopRequested: boolean;
  status: BatchStatus;
  createdAt: string;
}

/** A structured, machine-checkable item error (error codes are domain-owned, e.g. SDD §6.5). */
export interface ItemError {
  code: string;
  message: string;
}

/** Per-item run state. `stage` is a free string — the stage machine is domain-owned (SDD §6.1). */
export interface ItemRun {
  id: string;
  batchId: string;
  status: ItemStatus;
  stage: string;
  attempt: number;
  epoch: number;
  inputHashes: string[];
  checkpointHash: string | null;
  error: ItemError | null;
}

/** One dispatched turn for an (item, stage) pair, per SDD §5.2/§5.5. */
export interface Attempt {
  attempt: number;
  epoch: number;
  stage: string;
  startedAt: string;
  settledAt: string | null;
  exitCode: number | null;
  turnId: string | null;
}

/** Append-only row shape for `stage-ledger.jsonl`, per SDD §5.5. */
export interface StageLedgerRow {
  turnKey: string;
  itemId: string;
  stage: string;
  attempt: number;
  status: 'non-terminal' | 'terminal';
  turnId: string;
  recordedAt: string;
}

interface PipelineEventBase {
  cursor: number;
  batchId: string;
  at: string;
}

/**
 * Discriminated union of pipeline event kinds, per SDD §5.7. Every event carries a
 * monotonic `cursor` (for SSE replay) and the `batchId` it belongs to.
 */
export type PipelineEvent =
  | (PipelineEventBase & {
      kind: 'item.stage.started';
      itemId: string;
      stage: string;
      attempt: number;
    })
  | (PipelineEventBase & {
      kind: 'item.stage.settled';
      itemId: string;
      stage: string;
      attempt: number;
      status: ItemStatus;
    })
  | (PipelineEventBase & {
      kind: 'item.status';
      itemId: string;
      status: ItemStatus;
      reason: string | null;
    })
  | (PipelineEventBase & {
      kind: 'item.human_wait';
      itemId: string;
      reason: string;
    })
  | (PipelineEventBase & {
      kind: 'item.recovered';
      itemId: string;
      fromStatus: ItemStatus;
    })
  | (PipelineEventBase & {
      kind: 'batch.status';
      status: BatchStatus;
    })
  | (PipelineEventBase & {
      kind: 'batch.throttled';
      reason: string;
    })
  | (PipelineEventBase & {
      kind: 'batch.budget';
      reason: string;
    })
  | (PipelineEventBase & {
      kind: 'preflight.result';
      itemId: string;
      ok: boolean;
      reason: string | null;
    })
  | (PipelineEventBase & {
      kind: 'log.append';
      itemId: string;
      lines: string[];
    });
