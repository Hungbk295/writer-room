/**
 * `WRITER_READY_PROFILE` store (ADR-FM10) — same JSON-per-record round-trip coverage
 * `studio.test.ts` gives the Formula store indirectly, but as a dedicated unit test
 * since this is a store of its own (`trainingRoot()/profiles`, never `formulas`).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WriterReadyProfile } from '@writer-room/training-core';
import { deleteProfile, getProfile, listProfiles, saveProfile } from '../../src/training/profile-store.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wr-profile-store-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function profile(overrides: Partial<WriterReadyProfile> & { id: string }): WriterReadyProfile {
  return {
    kind: 'WRITER_READY_PROFILE',
    version: 1,
    label: 'Kể chuyện tài chính cá nhân',
    readiness: 'TRIAL',
    scope: { language: 'vi', contentModes: ['short-form'] },
    guidelines: [
      {
        id: 'g1',
        instruction: 'Mở bài bằng một câu chuyện cá nhân có số liệu cụ thể',
        priority: 'CORE',
        sourceRuleIds: ['f1:rule-1'],
      },
    ],
    antiPatterns: ['Hài hước ép buộc'],
    createdAt: '2026-08-11T00:00:00.000Z',
    ...overrides,
  };
}

describe('saveProfile / getProfile', () => {
  test('round-trips a profile to disk', async () => {
    await saveProfile(profile({ id: 'p1' }), dir);
    const loaded = await getProfile('p1', dir);
    expect(loaded).not.toBeNull();
    expect(loaded!.label).toBe('Kể chuyện tài chính cá nhân');
    expect(loaded!.readiness).toBe('TRIAL');
    expect(loaded!.guidelines).toHaveLength(1);
  });

  test('getProfile returns null for an id that was never saved', async () => {
    expect(await getProfile('không-tồn-tại', dir)).toBeNull();
  });
});

describe('listProfiles', () => {
  test('lists newest first', async () => {
    await saveProfile(profile({ id: 'p1', createdAt: '2026-08-11T00:00:00.000Z' }), dir);
    await saveProfile(profile({ id: 'p2', createdAt: '2026-08-11T01:00:00.000Z' }), dir);

    const list = await listProfiles(dir);
    expect(list).toHaveLength(2);
    expect(list[0]!.id).toBe('p2');
    expect(list[1]!.id).toBe('p1');
  });

  test('empty store lists as empty, not an error', async () => {
    expect(await listProfiles(dir)).toEqual([]);
  });

  /** Same flake class `listFormulas`/`listStudioSessions` already guard against: two
   * records saved in the same millisecond must still sort deterministically. */
  test('listing order is deterministic even when createdAt ties', async () => {
    await saveProfile(profile({ id: 'p-b', createdAt: '2026-08-11T00:00:00.000Z' }), dir);
    await saveProfile(profile({ id: 'p-a', createdAt: '2026-08-11T00:00:00.000Z' }), dir);
    await saveProfile(profile({ id: 'p-c', createdAt: '2026-08-11T00:00:00.000Z' }), dir);

    const first = (await listProfiles(dir)).map((p) => p.id);
    const second = (await listProfiles(dir)).map((p) => p.id);
    expect(first).toEqual(second);
    expect(first).toEqual(['p-a', 'p-b', 'p-c']); // localeCompare tiebreak
  });
});

describe('deleteProfile', () => {
  test('deletes an existing profile and returns true', async () => {
    await saveProfile(profile({ id: 'p1' }), dir);
    expect(await deleteProfile('p1', dir)).toBe(true);
    expect(await getProfile('p1', dir)).toBeNull();
  });

  test('deleting a non-existent profile returns false, never throws', async () => {
    expect(await deleteProfile('không-tồn-tại', dir)).toBe(false);
  });
});
