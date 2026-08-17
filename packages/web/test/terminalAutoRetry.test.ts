import { expect, test } from 'bun:test';
import { PTY_ENTER } from '../src/components/terminal/terminalInput.ts';
import { PTY_ENTER_RETRY_MS, scheduleQuietPtyEnterRetry } from '../src/components/terminal/terminalAutoRetry.ts';

function testTimer() {
  let callback: (() => void) | undefined;
  let delayMs: number | undefined;
  let cancelled = false;
  return {
    schedule: (next: () => void, delay: number) => {
      callback = next;
      delayMs = delay;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: () => { cancelled = true; },
    async fire() {
      if (!cancelled) callback?.();
      await Promise.resolve();
      await Promise.resolve();
    },
    get delayMs() { return delayMs; },
  };
}

test('retries exactly one Enter after five quiet seconds', async () => {
  const writes: string[] = [];
  const timer = testTimer();
  scheduleQuietPtyEnterRetry({
    baselineSequence: 10,
    readSequence: async () => 10,
    write: async (data) => { writes.push(data); },
    schedule: timer.schedule,
    cancelSchedule: timer.cancel,
  });

  expect(timer.delayMs).toBe(PTY_ENTER_RETRY_MS);
  await timer.fire();
  expect(writes).toEqual([PTY_ENTER]);
});

test('does not retry when terminal output changed after the first Enter', async () => {
  const writes: string[] = [];
  const timer = testTimer();
  scheduleQuietPtyEnterRetry({
    baselineSequence: 10,
    readSequence: async () => 11,
    write: async (data) => { writes.push(data); },
    schedule: timer.schedule,
    cancelSchedule: timer.cancel,
  });

  await timer.fire();
  expect(writes).toEqual([]);
});

test('cancels a retry when its owning turn settled or pane was replaced', async () => {
  const writes: string[] = [];
  const timer = testTimer();
  const cancel = scheduleQuietPtyEnterRetry({
    baselineSequence: 10,
    readSequence: async () => 10,
    write: async (data) => { writes.push(data); },
    schedule: timer.schedule,
    cancelSchedule: timer.cancel,
  });

  cancel();
  await timer.fire();
  expect(writes).toEqual([]);
});
