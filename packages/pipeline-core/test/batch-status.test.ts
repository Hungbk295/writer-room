import { describe, expect, test } from 'bun:test';
import { deriveBatchStatus } from '../src/batch-status.ts';
import type { ItemStatus } from '../src/contracts.ts';

describe('deriveBatchStatus (SDD §6.2)', () => {
  test('row 1: stopRequested and no item RUNNING/VALIDATING -> CANCELLED', () => {
    const items: ItemStatus[] = ['FAILED', 'SKIPPED', 'SUCCEEDED'];
    expect(deriveBatchStatus(items, { stopRequested: true })).toBe('CANCELLED');
  });

  test('row 1 does not fire while an item is still RUNNING even if stopRequested', () => {
    const items: ItemStatus[] = ['RUNNING', 'SUCCEEDED'];
    expect(deriveBatchStatus(items, { stopRequested: true })).toBe('RUNNING');
  });

  test('row 1 does not fire while an item is still VALIDATING even if stopRequested', () => {
    const items: ItemStatus[] = ['VALIDATING'];
    expect(deriveBatchStatus(items, { stopRequested: true })).toBe('RUNNING');
  });

  test('row 2: any item QUEUED/WAITING_LANE/RUNNING/VALIDATING -> RUNNING', () => {
    expect(deriveBatchStatus(['QUEUED', 'SUCCEEDED'], { stopRequested: false })).toBe('RUNNING');
    expect(deriveBatchStatus(['WAITING_LANE', 'FAILED'], { stopRequested: false })).toBe('RUNNING');
    expect(deriveBatchStatus(['RUNNING'], { stopRequested: false })).toBe('RUNNING');
    expect(deriveBatchStatus(['VALIDATING'], { stopRequested: false })).toBe('RUNNING');
  });

  test('row 3: no item running and >=1 HUMAN_WAIT -> NEEDS_ATTENTION', () => {
    const items: ItemStatus[] = ['HUMAN_WAIT', 'SUCCEEDED'];
    expect(deriveBatchStatus(items, { stopRequested: false })).toBe('NEEDS_ATTENTION');
  });

  test('row 3: no item running and >=1 INTERRUPTED -> NEEDS_ATTENTION', () => {
    const items: ItemStatus[] = ['INTERRUPTED', 'SUCCEEDED'];
    expect(deriveBatchStatus(items, { stopRequested: false })).toBe('NEEDS_ATTENTION');
  });

  test('row 3: no item running and >=1 FAILED -> NEEDS_ATTENTION (FAILED treated as retryable by default, see NOTE)', () => {
    const items: ItemStatus[] = ['FAILED', 'SUCCEEDED'];
    expect(deriveBatchStatus(items, { stopRequested: false })).toBe('NEEDS_ATTENTION');
  });

  test('row 4: all items SUCCEEDED -> SUCCEEDED', () => {
    const items: ItemStatus[] = ['SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED'];
    expect(deriveBatchStatus(items, { stopRequested: false })).toBe('SUCCEEDED');
  });

  test('row 5: >=1 SUCCEEDED and >=1 SKIPPED, none pending -> PARTIAL_SUCCESS', () => {
    const items: ItemStatus[] = ['SUCCEEDED', 'SKIPPED'];
    expect(deriveBatchStatus(items, { stopRequested: false })).toBe('PARTIAL_SUCCESS');
  });

  test('row 5: >=1 SUCCEEDED and >=1 CANCELLED, none pending -> PARTIAL_SUCCESS', () => {
    const items: ItemStatus[] = ['SUCCEEDED', 'CANCELLED'];
    expect(deriveBatchStatus(items, { stopRequested: false })).toBe('PARTIAL_SUCCESS');
  });

  test('row 6: no item SUCCEEDED, none pending -> FAILED', () => {
    const items: ItemStatus[] = ['SKIPPED', 'CANCELLED'];
    expect(deriveBatchStatus(items, { stopRequested: false })).toBe('FAILED');
  });

  test('empty-items edge case: no items and no stop requested -> SUCCEEDED (vacuous "all succeeded")', () => {
    expect(deriveBatchStatus([], { stopRequested: false })).toBe('SUCCEEDED');
  });

  test('empty-items edge case: no items and stop requested -> CANCELLED', () => {
    expect(deriveBatchStatus([], { stopRequested: true })).toBe('CANCELLED');
  });
});
