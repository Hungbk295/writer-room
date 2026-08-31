/**
 * Wait until a TUI stops repainting before typing into it.
 *
 * Every full-screen CLI is noisy while it boots and while it redraws its
 * composer around freshly pasted text, then falls quiet once it is ready for
 * the next key event. A fixed delay can only ever be tuned for one CLI on one
 * machine; watching the PTY chunk counter go still adapts to all of them.
 *
 * `sequence` is the Rust bridge's chunk counter (batched at 16ms / 32KiB), so
 * "unchanged" means no output batch at all — the strongest signal available
 * from outside the terminal.
 */
export type Delay = (ms: number) => Promise<void>;
export type SequenceReader = () => Promise<number>;

export const browserDelay: Delay = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
const browserNow = () => Date.now();

export const PTY_QUIET_POLL_MS = 200;

export interface WaitForPtyQuietOptions {
  readSequence: SequenceReader;
  /** No new output chunk for this long counts as quiet. */
  settleMs: number;
  /** Floor: always observe at least this long, even if nothing ever arrives. */
  minWaitMs: number;
  /** Ceiling: give up waiting and proceed, however noisy the TUI still is. */
  maxWaitMs: number;
  pollMs?: number;
  /** The caller owns a turn/pane lifecycle; stop early once it is stale. */
  isActive?: () => boolean;
  delay?: Delay;
  now?: () => number;
}

/**
 * A newly spawned full-screen CLI is not ready merely because its PTY is
 * silent: before the process paints its first frame, sequence=0 is also
 * perfectly quiet.  Waiting on that state was the startup race that let the
 * bridge paste a Writer assignment before Claude had mounted its composer.
 *
 * This stricter gate requires at least one real output batch and then the same
 * quiet window used for pane hand-offs.  It returns false at the ceiling so a
 * caller can fail closed instead of typing blindly into an uninitialised TUI.
 */
export async function waitForPtyReady(opts: WaitForPtyQuietOptions): Promise<boolean> {
  const delay = opts.delay ?? browserDelay;
  const now = opts.now ?? browserNow;
  const isActive = opts.isActive ?? (() => true);
  const pollMs = opts.pollMs ?? PTY_QUIET_POLL_MS;

  const read = async (fallback: number): Promise<number> => {
    try {
      return await opts.readSequence();
    } catch {
      return fallback;
    }
  };

  const start = now();
  let lastSequence = await read(-1);
  let observedOutput = lastSequence > 0;
  let lastChangeAt = start;

  for (;;) {
    if (!isActive()) return false;
    const elapsed = now() - start;
    if (elapsed >= opts.maxWaitMs) return false;
    if (observedOutput && elapsed >= opts.minWaitMs && now() - lastChangeAt >= opts.settleMs) {
      return true;
    }
    await delay(pollMs);
    if (!isActive()) return false;
    const sequence = await read(lastSequence);
    if (sequence !== lastSequence) {
      lastSequence = sequence;
      lastChangeAt = now();
    }
    if (sequence > 0) observedOutput = true;
  }
}

export async function waitForPtyQuiet(opts: WaitForPtyQuietOptions): Promise<void> {
  const delay = opts.delay ?? browserDelay;
  const now = opts.now ?? browserNow;
  const isActive = opts.isActive ?? (() => true);
  const pollMs = opts.pollMs ?? PTY_QUIET_POLL_MS;

  // A snapshot can fail transiently while the pane is being set up. Treating
  // that as neither activity nor a fatal error keeps the poll loop honest: the
  // ceiling still bounds it, and a genuinely dead pane surfaces on the write.
  const read = async (fallback: number): Promise<number> => {
    try {
      return await opts.readSequence();
    } catch {
      return fallback;
    }
  };

  const start = now();
  let lastSequence = await read(-1);
  let lastChangeAt = start;

  for (;;) {
    if (!isActive()) return;
    const elapsed = now() - start;
    if (elapsed >= opts.maxWaitMs) return;
    if (elapsed >= opts.minWaitMs && now() - lastChangeAt >= opts.settleMs) return;
    await delay(pollMs);
    if (!isActive()) return;
    const sequence = await read(lastSequence);
    if (sequence !== lastSequence) {
      lastSequence = sequence;
      lastChangeAt = now();
    }
  }
}
