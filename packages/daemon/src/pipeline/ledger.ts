/**
 * StageLedger — idempotent-dispatch index + append-only audit trail (SDD §5.5).
 *
 * Deliberately simple for M0.5: one global JSONL file, in-memory `Map<turnKey, row>`
 * rebuilt from disk on construction (last row per `turnKey` wins). No SQLite index —
 * per ADR-2 that index is a *derived, rebuildable* optimization, not required for
 * correctness, so it is out of scope here.
 *
 * Judgment call: pipeline-core's `StageLedgerRow` (packages/pipeline-core/src/contracts.ts)
 * only distinguishes `'non-terminal' | 'terminal'` — coarse by design, since
 * pipeline-core must stay domain-generic. The lane scheduler needs finer detail (why
 * a row went terminal: committed vs failed, which error code, what artifact hash) to
 * drive `LaneScheduler.onItemSettled` and boot reconciliation. Rather than extend
 * pipeline-core's contract — outside this task's file boundary — `PipelineLedgerRow`
 * below is a structural superset of `StageLedgerRow`: it satisfies the imported type
 * exactly and adds daemon-owned optional fields on top.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { StageLedgerRow } from '@writer-room/pipeline-core';

export type LedgerOutcome = 'RUNNING' | 'COMMITTED' | 'FAILED' | 'INTERRUPTED';

export interface PipelineLedgerRow extends StageLedgerRow {
  /** Not part of `turnKey`'s own hash inputs list, but useful to carry alongside the
   * row so `LaneScheduler.onItemSettled` doesn't need a second lookup table. */
  batchId: string;
  outcome?: LedgerOutcome;
  errorCode?: string;
  artifactHash?: string;
}

export class StageLedger {
  private byTurnKey = new Map<string, PipelineLedgerRow>();
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
    if (!existsSync(filePath)) {
      writeFileSync(filePath, '');
      return;
    }
    const raw = readFileSync(filePath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed) as PipelineLedgerRow;
        this.byTurnKey.set(row.turnKey, row); // last row per turnKey wins
      } catch {
        // Skip a torn/corrupt trailing line (e.g. crash mid-write) rather than fail boot.
      }
    }
  }

  findByTurnKey(turnKey: string): PipelineLedgerRow | undefined {
    return this.byTurnKey.get(turnKey);
  }

  /** All rows currently indexed (latest version per turnKey) — used for boot reconciliation. */
  all(): PipelineLedgerRow[] {
    return [...this.byTurnKey.values()];
  }

  /** Append a brand-new row (fresh dispatch). Never mutates a prior line on disk. */
  append(row: PipelineLedgerRow): void {
    appendFileSync(this.filePath, `${JSON.stringify(row)}\n`);
    this.byTurnKey.set(row.turnKey, row);
  }

  /** Append a new version of an existing row (status transition). Append-only: this
   * writes a brand-new JSONL line, it never rewrites the earlier one. */
  updateStatus(turnKey: string, patch: Partial<PipelineLedgerRow>): void {
    const prev = this.byTurnKey.get(turnKey);
    if (!prev) throw new Error(`StageLedger.updateStatus: no row for turnKey ${turnKey}`);
    const next: PipelineLedgerRow = {
      ...prev,
      ...patch,
      turnKey,
      recordedAt: patch.recordedAt ?? new Date().toISOString(),
    };
    this.append(next);
  }
}
