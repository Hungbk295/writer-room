/**
 * One guarded retry for TUIs that visibly receive pasted text but miss its
 * first Return key. A PTY cannot acknowledge that its composer accepted Enter,
 * so terminal output activity is the practical proxy: retry only when it has
 * stayed completely quiet for the retry window.
 */
import { PTY_ENTER } from './terminalInput.ts';

export const PTY_ENTER_RETRY_MS = 5_000;

type PtyWriter = (data: string) => Promise<void>;
type SequenceReader = () => Promise<number>;
type IsActive = () => boolean;
type TimeoutHandle = ReturnType<typeof setTimeout>;
type Schedule = (callback: () => void, ms: number) => TimeoutHandle;
type CancelSchedule = (handle: TimeoutHandle) => void;

const browserSchedule: Schedule = (callback, ms) => window.setTimeout(callback, ms);
const browserCancel: CancelSchedule = (handle) => window.clearTimeout(handle);

export function scheduleQuietPtyEnterRetry(opts: {
  /** Sequence observed immediately after the first Enter was sent. */
  baselineSequence: number;
  readSequence: SequenceReader;
  write: PtyWriter;
  /** The caller owns a turn/pane lifecycle; never retry a stale assignment. */
  isActive?: IsActive;
  onRetry?: () => void;
  onError?: (error: unknown) => void;
  delayMs?: number;
  schedule?: Schedule;
  cancelSchedule?: CancelSchedule;
}): () => void {
  let cancelled = false;
  const isActive = opts.isActive ?? (() => true);
  const schedule = opts.schedule ?? browserSchedule;
  const cancelSchedule = opts.cancelSchedule ?? browserCancel;
  const timer = schedule(() => {
    void (async () => {
      try {
        if (cancelled || !isActive()) return;
        const currentSequence = await opts.readSequence();
        // Re-check after awaiting the terminal bridge: settlement/replacement can
        // happen while the snapshot request is in flight.
        if (cancelled || !isActive() || currentSequence !== opts.baselineSequence) return;
        await opts.write(PTY_ENTER);
        opts.onRetry?.();
      } catch (error) {
        if (!cancelled) opts.onError?.(error);
      }
    })();
  }, opts.delayMs ?? PTY_ENTER_RETRY_MS);

  return () => {
    cancelled = true;
    cancelSchedule(timer);
  };
}
