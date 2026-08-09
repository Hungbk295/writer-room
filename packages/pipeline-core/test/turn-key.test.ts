import { describe, expect, test } from 'bun:test';
import { turnKey, type TurnKeyInput } from '../src/turn-key.ts';

function baseInput(): TurnKeyInput {
  return {
    batchId: 'batch-1',
    itemId: 'item-1',
    stage: 'ANALYZE',
    attempt: 1,
    inputHashes: ['hash-a', 'hash-b'],
    promptVersion: 'v1',
  };
}

describe('turnKey (SDD §5.5)', () => {
  test('same inputs produce the same key (determinism)', () => {
    expect(turnKey(baseInput())).toBe(turnKey(baseInput()));
  });

  test('changing attempt produces a different key', () => {
    const a = turnKey(baseInput());
    const b = turnKey({ ...baseInput(), attempt: 2 });
    expect(a).not.toBe(b);
  });

  test('reordering inputHashes produces the SAME key (order-independent)', () => {
    const a = turnKey({ ...baseInput(), inputHashes: ['hash-a', 'hash-b'] });
    const b = turnKey({ ...baseInput(), inputHashes: ['hash-b', 'hash-a'] });
    expect(a).toBe(b);
  });

  test('changing any other field produces a different key', () => {
    const base = turnKey(baseInput());
    expect(turnKey({ ...baseInput(), batchId: 'batch-2' })).not.toBe(base);
    expect(turnKey({ ...baseInput(), itemId: 'item-2' })).not.toBe(base);
    expect(turnKey({ ...baseInput(), stage: 'REVIEW' })).not.toBe(base);
    expect(turnKey({ ...baseInput(), promptVersion: 'v2' })).not.toBe(base);
    expect(turnKey({ ...baseInput(), inputHashes: ['hash-a', 'hash-c'] })).not.toBe(base);
  });

  test('returns a sha256 hex digest', () => {
    expect(turnKey(baseInput())).toMatch(/^[0-9a-f]{64}$/);
  });
});
