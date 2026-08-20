import { expect, test } from 'bun:test';
import {
  PTY_ENTER,
  PTY_SUBMIT_MAX_WAIT_MS,
  submitPtyLine,
} from '../src/components/terminal/terminalInput.ts';

test('submitPtyLine still sends Enter to a TUI that never stops repainting', async () => {
  // The ceiling is what guarantees delivery: a CLI with a live status line or a
  // running spinner never goes quiet, and its assignment must not be stranded.
  let clock = 0;
  const writes: Array<{ data: string; at: number }> = [];
  let sequence = 0;

  await submitPtyLine({
    write: async (data) => { writes.push({ data, at: clock }); },
    text: 'read prompt.md',
    readSequence: async () => ++sequence,
    delay: async (ms) => { clock += ms; },
    now: () => clock,
  });

  expect(writes).toEqual([
    { data: 'read prompt.md', at: 0 },
    { data: PTY_ENTER, at: PTY_SUBMIT_MAX_WAIT_MS },
  ]);
});
