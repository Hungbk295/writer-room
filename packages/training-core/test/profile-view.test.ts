import { describe, expect, test } from 'bun:test';
import type { WriterReadyProfile } from '../src/profile.ts';
import { toWriterProfileView } from '../src/profile-view.ts';
import { isTasteDecisionType, TASTE_DECISION_TYPES } from '../src/taste.ts';

const sample: WriterReadyProfile = {
  kind: 'WRITER_READY_PROFILE',
  id: 'p1',
  version: 2,
  label: 'Series',
  readiness: 'TRIAL',
  scope: { language: 'vi', contentModes: [] },
  guidelines: [
    {
      id: 'g1',
      instruction: 'Keep voice direct',
      priority: 'CORE',
      sourceRuleIds: ['f:r1', 'f:r2'],
    },
  ],
  antiPatterns: ['hype'],
  createdAt: '2026-08-11T00:00:00.000Z',
};

describe('toWriterProfileView', () => {
  test('does not expose sourceRuleIds', () => {
    const view = toWriterProfileView(sample);
    expect(JSON.stringify(view)).not.toContain('sourceRuleIds');
    expect(JSON.stringify(view)).not.toContain('f:r1');
    expect(view.version).toBe(2);
    expect(view.guidelines[0]!.priority).toBe('CORE');
  });
});

describe('taste decision types', () => {
  test('closed enum accepts known values only', () => {
    for (const t of TASTE_DECISION_TYPES) {
      expect(isTasteDecisionType(t)).toBe(true);
    }
    expect(isTasteDecisionType('HOOK')).toBe(false);
    expect(isTasteDecisionType('')).toBe(false);
  });
});
