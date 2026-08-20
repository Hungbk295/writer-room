/**
 * Guarded Enter recovery for TUIs that visibly receive a pasted assignment but
 * miss its Return key, leaving the text sitting in the composer forever.
 *
 * A PTY cannot acknowledge that a composer accepted Enter, so the question has
 * to be answered indirectly. The obvious proxy — "did the terminal stay
 * completely quiet?" — is wrong, and was the bug this replaces: every TUI
 * repaints while it absorbs a paste, so the chunk counter always moved right
 * after the first Enter and the retry never fired. Inspecting the ring buffer
 * for the prompt text is wrong for the mirror-image reason: a successfully
 * submitted prompt is echoed back into the transcript, so the text is still
 * there either way, and every TUI renders it differently.
 *
 * What does separate the two cases is what happens *next*. A CLI that received
 * the prompt keeps emitting output — spinner frames, streamed tokens, tool
 * calls. A CLI still holding unsent text emits nothing at all. So each attempt
 * samples the chunk counter twice across a wide window and only re-sends Enter
 * when it did not move. An extra Enter on an empty composer is a no-op in
 * Codex, Claude Code and Gemini, which is what makes retrying safe.
 */
import { PTY_ENTER } from './terminalInput.ts';
import type { SequenceReader } from './ptyQuiet.ts';

/** Waited before each attempt's observation window, so a slow-but-working agent
 *  is given progressively more room before we type into it again. */
export const PTY_ENTER_RECOVERY_BACKOFF_MS = [5_000, 8_000, 12_000] as const;
/** Settle time before sampling the counter, so the paste repaint is not counted
 *  as agent activity. */
export const PTY_ENTER_OBSERVE_DELAY_MS = 1_500;
/** Width of the observation window. Long enough that no working CLI stays
 *  silent through it, short enough to recover a hung turn quickly. */
export const PTY_ENTER_OBSERVE_WINDOW_MS = 3_500;

type PtyWriter = (data: string) => Promise<void>;
type IsActive = () => boolean;
type TimeoutHandle = ReturnType<typeof setTimeout>;
type Schedule = (callback: () => void, ms: number) => TimeoutHandle;
type CancelSchedule = (handle: TimeoutHandle) => void;

const browserSchedule: Schedule = (callback, ms) => window.setTimeout(callback, ms);
const browserCancel: CancelSchedule = (handle) => window.clearTimeout(handle);

export function schedulePtyEnterRecovery(opts: {
  readSequence: SequenceReader;
  write: PtyWriter;
  /** The caller owns a turn/pane lifecycle; never type into a stale assignment. */
  isActive?: IsActive;
  onRetry?: () => void;
  onError?: (error: unknown) => void;
  backoffMs?: readonly number[];
  observeDelayMs?: number;
  observeWindowMs?: number;
  schedule?: Schedule;
  cancelSchedule?: CancelSchedule;
}): () => void {
  const isActive = opts.isActive ?? (() => true);
  const schedule = opts.schedule ?? browserSchedule;
  const cancelSchedule = opts.cancelSchedule ?? browserCancel;
  const backoffMs = opts.backoffMs ?? PTY_ENTER_RECOVERY_BACKOFF_MS;
  const observeDelayMs = opts.observeDelayMs ?? PTY_ENTER_OBSERVE_DELAY_MS;
  const observeWindowMs = opts.observeWindowMs ?? PTY_ENTER_OBSERVE_WINDOW_MS;

  let cancelled = false;
  let releaseWait: (() => void) | undefined;

  // Cancelling resolves the pending wait instead of dropping it, so the loop
  // wakes up, sees `stop()` and unwinds rather than dangling.
  const wait = (ms: number) => new Promise<void>((resolve) => {
    const handle = schedule(() => {
      releaseWait = undefined;
      resolve();
    }, ms);
    releaseWait = () => {
      cancelSchedule(handle);
      resolve();
    };
  });
  const stop = () => cancelled || !isActive();

  void (async () => {
    try {
      for (const backoff of backoffMs) {
        await wait(backoff);
        if (stop()) return;
        await wait(observeDelayMs);
        if (stop()) return;
        const before = await opts.readSequence();
        if (stop()) return;
        await wait(observeWindowMs);
        if (stop()) return;
        const after = await opts.readSequence();
        if (stop()) return;
        // Output kept flowing: the agent is working, so the line went through.
        if (after !== before) return;
        await opts.write(PTY_ENTER);
        opts.onRetry?.();
      }
    } catch (error) {
      if (!cancelled) opts.onError?.(error);
    }
  })();

  return () => {
    cancelled = true;
    releaseWait?.();
    releaseWait = undefined;
  };
}
