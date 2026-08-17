import { expect, test } from 'bun:test';
import { PTY_ENTER, TUI_SUBMIT_SETTLE_MS, submitPtyLine } from '../src/components/terminal/terminalInput.ts';

test('submitPtyLine writes prompt before a separate Enter key', async () => {
  const writes: string[] = [];
  const waits: number[] = [];

  await submitPtyLine(
    async (data) => { writes.push(data); },
    'read prompt.md',
    async (ms) => { waits.push(ms); },
  );

  expect(writes).toEqual(['read prompt.md', PTY_ENTER]);
  expect(waits).toEqual([TUI_SUBMIT_SETTLE_MS]);
});
