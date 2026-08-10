import { useEffect, useState } from 'preact/hooks';
import { api, type FormulaDiscoveryStatus, type SpyOperation, type TrainingLabRun } from './api.ts';

export function useOperationPoll(operationId: string | null, onDone?: (op: SpyOperation) => void) {
  const [operation, setOperation] = useState<SpyOperation | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!operationId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      try {
        const op = await api.getOperation(operationId);
        if (cancelled) return;
        setOperation(op);
        setError(null);
        if (op.status === 'queued' || op.status === 'running') {
          timer = setTimeout(tick, 1200);
        } else {
          onDone?.(op);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        timer = setTimeout(tick, 2000);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [operationId]);

  return { operation, error };
}

/**
 * Same `setTimeout`-based poll pattern as `useOperationPoll` above, but for the
 * Training ledger-status route, whose payload shape is different (`found`/`status`
 * instead of `status: 'queued'|'running'|...`). `found: false` means the ledger row
 * for this dispatch hasn't been written yet (the scheduler/agent hasn't reached the
 * ANALYZE stage's first ledger write) — treated as "still starting", not an error.
 */
export function useFormulaDiscoveryPoll(
  batchId: string | null,
  videoSnapshotId: string | null,
  onDone?: (status: FormulaDiscoveryStatus) => void,
) {
  const [state, setState] = useState<FormulaDiscoveryStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!batchId || !videoSnapshotId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      try {
        const status = await api.getFormulaDiscoveryStatus(batchId, videoSnapshotId);
        if (cancelled) return;
        setState(status);
        setError(null);
        if (!status.found || status.status === 'RUNNING') {
          timer = setTimeout(tick, 1500);
        } else {
          onDone?.(status);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        timer = setTimeout(tick, 2000);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [batchId, videoSnapshotId]);

  return { status: state, error };
}

/**
 * Same `setTimeout`-based poll pattern as `useFormulaDiscoveryPoll`, but Training
 * Lab has no dedicated lightweight status route (SDD §12a UI note) — the full
 * `GET /api/training/lab/runs/:id` is cheap enough to poll directly, so every tick
 * just replaces the whole `TrainingLabRun` in state. A caller watching an
 * in-progress run sees rounds/stages fill in live without a manual refresh.
 */
export function useTrainingLabRunPoll(
  runId: string | null,
  onDone?: (run: TrainingLabRun) => void,
) {
  const [run, setRun] = useState<TrainingLabRun | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      try {
        const current = await api.getTrainingLabRun(runId);
        if (cancelled) return;
        setRun(current);
        setError(null);
        if (current.status === 'RUNNING') {
          timer = setTimeout(tick, 1500);
        } else {
          onDone?.(current);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        timer = setTimeout(tick, 2000);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId]);

  return { run, error };
}

export function pct(progress: number, total: number): number {
  if (!total) return 0;
  return Math.min(100, Math.round((progress / total) * 100));
}
