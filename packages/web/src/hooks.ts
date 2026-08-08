import { useEffect, useState } from 'preact/hooks';
import { api, type SpyOperation } from './api.ts';

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

export function pct(progress: number, total: number): number {
  if (!total) return 0;
  return Math.min(100, Math.round((progress / total) * 100));
}
