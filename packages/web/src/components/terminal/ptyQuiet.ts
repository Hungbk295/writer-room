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
