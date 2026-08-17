/**
 * Send one line to a TUI as two separate PTY writes.
 *
 * Codex and other full-screen CLIs can accept a pasted prompt while they are
 * still updating their composer, then drop a carriage return included in the
 * same PTY chunk. Waiting briefly between the text and Enter makes the submit
 * a distinct terminal key event, exactly like a person typing then pressing
 * Enter. `\r` is deliberate: it is what xterm sends for the Enter key.
 */
export const PTY_ENTER = '\r';
/**
 * Claude Code's Ink composer acknowledges a large programmatic paste later than
 * Codex's composer. 180ms was enough for Codex in normal cases, but Claude could
 * visibly receive the assignment text and still miss the immediately-following
 * Return. Keep the key event separate by a human-scale interval for every TUI;
 * this is a one-time dispatch cost, not an agent-thinking delay.
 */
export const TUI_SUBMIT_SETTLE_MS = 800;

type PtyWriter = (data: string) => Promise<void>;
type Delay = (ms: number) => Promise<void>;

const browserDelay: Delay = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

export async function submitPtyLine(
  write: PtyWriter,
  text: string,
  delay: Delay = browserDelay,
): Promise<void> {
  await write(text);
  await delay(TUI_SUBMIT_SETTLE_MS);
  await write(PTY_ENTER);
}
