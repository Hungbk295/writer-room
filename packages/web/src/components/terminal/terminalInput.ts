/**
 * Send one line to a TUI as two separate PTY writes.
 *
 * Codex and other full-screen CLIs can accept a pasted prompt while they are
 * still updating their composer, then drop a carriage return included in the
 * same PTY chunk. Letting the TUI go quiet between the text and Enter makes the
 * submit a distinct terminal key event, exactly like a person typing and then
 * pressing Enter. `\r` is deliberate: it is what xterm sends for the Enter key.
 */
import { waitForPtyQuiet, type Delay, type SequenceReader } from './ptyQuiet.ts';

export const PTY_ENTER = '\r';

/**
 * Composer repaint after a paste is short and bursty, so a small settle window
 * is enough. The ceiling matters more than the floor here: the text is already
 * in the composer, and a TUI that never stops drawing must still get its Enter.
 */
export const PTY_SUBMIT_SETTLE_MS = 600;
export const PTY_SUBMIT_MIN_WAIT_MS = 300;
export const PTY_SUBMIT_MAX_WAIT_MS = 5_000;

type PtyWriter = (data: string) => Promise<void>;

export async function submitPtyLine(opts: {
  write: PtyWriter;
  text: string;
  readSequence: SequenceReader;
  isActive?: () => boolean;
  delay?: Delay;
  now?: () => number;
}): Promise<void> {
  await opts.write(opts.text);
  await waitForPtyQuiet({
    readSequence: opts.readSequence,
    settleMs: PTY_SUBMIT_SETTLE_MS,
    minWaitMs: PTY_SUBMIT_MIN_WAIT_MS,
    maxWaitMs: PTY_SUBMIT_MAX_WAIT_MS,
    isActive: opts.isActive,
    delay: opts.delay,
    now: opts.now,
  });
  await opts.write(PTY_ENTER);
}
