import { expect, test } from 'bun:test';
import {
  PTY_ENTER,
  PTY_SUBMIT_SETTLE_MS,
  submitPtyLine,
} from '../src/components/terminal/terminalInput.ts';
import {
  PTY_ENTER_OBSERVE_DELAY_MS,
  PTY_ENTER_OBSERVE_WINDOW_MS,
  PTY_ENTER_RECOVERY_BACKOFF_MS,
  schedulePtyEnterRecovery,
} from '../src/components/terminal/terminalAutoRetry.ts';
import { waitForPtyQuiet } from '../src/components/terminal/ptyQuiet.ts';

/** One pending timer at a time is all the recovery loop ever holds. */
function testTimer() {
  const delays: number[] = [];
  let pending: (() => void) | null = null;
  const timer = {
    delays,
    schedule(callback: () => void, ms: number) {
      delays.push(ms);
      pending = callback;
      return delays.length as unknown as ReturnType<typeof setTimeout>;
    },
    cancel() { pending = null; },
    hasPending() { return pending !== null; },
    async tick() {
      const callback = pending;
      pending = null;
      callback?.();
      for (let i = 0; i < 50; i++) await Promise.resolve();
    },
    async tickAll(limit = 40) {
      for (let i = 0; i < limit && pending !== null; i++) await timer.tick();
    },
  };
  return timer;
}

/** Deterministic fake clock: `delay` is what advances time. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    delay: async (ms: number) => { t += ms; },
    get time() { return t; },
  };
}

const ATTEMPT_TIMERS = 3; // backoff, observe delay, observe window

test('re-sends Enter when the paste echo moves the sequence and then it freezes', async () => {
  // Regression for the bug this file exists to fix. Right after the first
  // Enter, the TUI repaints the pasted assignment, so the chunk sequence DOES
  // move (10 -> 11). The old "retry only if nothing at all was emitted" rule
  // read that repaint as progress and never retried, leaving the text parked
  // in the composer forever. What matters is that the sequence then stops:
  // a CLI that actually received the prompt keeps emitting.
  const writes: string[] = [];
  const reads: number[] = [];
  const timer = testTimer();
  let sequence = 10;
  const retries: number[] = [];
  schedulePtyEnterRecovery({
    readSequence: async () => { reads.push(sequence); return sequence; },
    write: async (data) => { writes.push(data); },
    onRetry: () => { retries.push(writes.length); },
    schedule: timer.schedule,
    cancelSchedule: timer.cancel,
  });

  expect(timer.delays[0]).toBe(PTY_ENTER_RECOVERY_BACKOFF_MS[0]);
  sequence = 11; // the TUI repaints the pasted text right after the Enter

  for (let i = 0; i < ATTEMPT_TIMERS; i++) await timer.tick();

  expect(timer.delays.slice(0, ATTEMPT_TIMERS)).toEqual([
    PTY_ENTER_RECOVERY_BACKOFF_MS[0],
    PTY_ENTER_OBSERVE_DELAY_MS,
    PTY_ENTER_OBSERVE_WINDOW_MS,
  ]);

  // Both samples of the observation window saw the post-echo value.
  expect(reads).toEqual([11, 11]);
  expect(writes).toEqual([PTY_ENTER]);
  expect(retries).toEqual([1]);
});

test('does not re-send Enter while the agent keeps producing output', async () => {
  const writes: string[] = [];
  const timer = testTimer();
  let sequence = 11;
  schedulePtyEnterRecovery({
    // Spinner frames, streamed tokens, tool calls: every read moves on.
    readSequence: async () => { sequence += 4; return sequence; },
    write: async (data) => { writes.push(data); },
    schedule: timer.schedule,
    cancelSchedule: timer.cancel,
  });

  await timer.tickAll();
  expect(writes).toEqual([]);
  // Activity ends the watch outright; nothing is left scheduled.
  expect(timer.hasPending()).toBe(false);
});

test('gives up after three attempts, backing off 5s then 8s then 12s', async () => {
  const writes: string[] = [];
  const timer = testTimer();
  schedulePtyEnterRecovery({
    readSequence: async () => 11,
    write: async (data) => { writes.push(data); },
    schedule: timer.schedule,
    cancelSchedule: timer.cancel,
  });

  await timer.tickAll();

  expect(writes).toEqual([PTY_ENTER, PTY_ENTER, PTY_ENTER]);
  expect(timer.delays).toEqual([
    5_000, PTY_ENTER_OBSERVE_DELAY_MS, PTY_ENTER_OBSERVE_WINDOW_MS,
    8_000, PTY_ENTER_OBSERVE_DELAY_MS, PTY_ENTER_OBSERVE_WINDOW_MS,
    12_000, PTY_ENTER_OBSERVE_DELAY_MS, PTY_ENTER_OBSERVE_WINDOW_MS,
  ]);
  expect(timer.hasPending()).toBe(false);
});

test('cancels the watch when its owning turn settled or pane was replaced', async () => {
  const writes: string[] = [];
  const timer = testTimer();
  const cancel = schedulePtyEnterRecovery({
    readSequence: async () => 11,
    write: async (data) => { writes.push(data); },
    schedule: timer.schedule,
    cancelSchedule: timer.cancel,
  });

  // Settle mid-observation, after the first sample has already been taken.
  await timer.tick();
  await timer.tick();
  cancel();
  await timer.tickAll();

  expect(writes).toEqual([]);
  expect(timer.hasPending()).toBe(false);
});

test('stops as soon as isActive() reports the assignment is stale', async () => {
  const writes: string[] = [];
  const timer = testTimer();
  let active = true;
  schedulePtyEnterRecovery({
    readSequence: async () => { active = false; return 11; },
    write: async (data) => { writes.push(data); },
    isActive: () => active,
    schedule: timer.schedule,
    cancelSchedule: timer.cancel,
  });

  await timer.tickAll();
  expect(writes).toEqual([]);
});

test('waitForPtyQuiet resolves once the TUI has been silent for settleMs', async () => {
  const clock = fakeClock();
  await waitForPtyQuiet({
    readSequence: async () => 7,
    settleMs: 600,
    minWaitMs: 300,
    maxWaitMs: 5_000,
    pollMs: 200,
    delay: clock.delay,
    now: clock.now,
  });
  expect(clock.time).toBe(600);
});

test('waitForPtyQuiet honours minWaitMs even when nothing is ever emitted', async () => {
  const clock = fakeClock();
  await waitForPtyQuiet({
    readSequence: async () => 7,
    settleMs: 100,
    minWaitMs: 800,
    maxWaitMs: 5_000,
    pollMs: 200,
    delay: clock.delay,
    now: clock.now,
  });
  expect(clock.time).toBe(800);
});

test('waitForPtyQuiet gives up at maxWaitMs on a TUI that never stops drawing', async () => {
  const clock = fakeClock();
  let sequence = 0;
  await waitForPtyQuiet({
    readSequence: async () => ++sequence,
    settleMs: 600,
    minWaitMs: 300,
    maxWaitMs: 1_000,
    pollMs: 200,
    delay: clock.delay,
    now: clock.now,
  });
  expect(clock.time).toBe(1_000);
});

test('submitPtyLine sends the text and the Enter key as two writes, quiet in between', async () => {
  const clock = fakeClock();
  const writes: Array<{ data: string; at: number }> = [];

  await submitPtyLine({
    write: async (data) => { writes.push({ data, at: clock.time }); },
    text: 'read prompt.md',
    readSequence: async () => 3,
    delay: clock.delay,
    now: clock.now,
  });

  expect(writes).toEqual([
    { data: 'read prompt.md', at: 0 },
    { data: PTY_ENTER, at: PTY_SUBMIT_SETTLE_MS },
  ]);
});
