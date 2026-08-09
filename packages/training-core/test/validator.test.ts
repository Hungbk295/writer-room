import { describe, expect, test } from 'bun:test';
import { formulaFromSingleAnalysis, validateAnalysis } from '../src/validator.ts';
import type { AnalysisArtifact } from '../src/contracts.ts';

function segmentsMap(entries: Record<string, string>): Map<string, { text: string }> {
  return new Map(Object.entries(entries).map(([id, text]) => [id, { text }]));
}

function baseAnalysis(overrides: Partial<AnalysisArtifact> = {}): AnalysisArtifact {
  return {
    videoSnapshotId: 'video-1',
    channelTitle: 'Channel One',
    createdAt: '2026-08-09T00:00:00.000Z',
    rules: [
      {
        id: 'rule-1',
        statement: 'Opens with a direct question to the viewer.',
        evidence: [{ segmentId: 'seg-1', quote: 'Have you ever wondered' }],
      },
    ],
    ...overrides,
  };
}

describe('validateAnalysis', () => {
  test('happy path: every rule has grounded evidence', () => {
    const segments = segmentsMap({ 'seg-1': 'Have you ever wondered why the sky is blue?' });
    const result = validateAnalysis(baseAnalysis(), segments);
    expect(result.ok).toBe(true);
  });

  test('rejects zero rules', () => {
    const segments = segmentsMap({ 'seg-1': 'anything' });
    const result = validateAnalysis(baseAnalysis({ rules: [] }), segments);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe('AGENT_UNGROUNDED');
      expect(result.reason).toContain('zero rules');
    }
  });

  test('rejects a rule with zero evidence', () => {
    const segments = segmentsMap({ 'seg-1': 'anything' });
    const analysis = baseAnalysis({
      rules: [{ id: 'rule-x', statement: 'no evidence at all', evidence: [] }],
    });
    const result = validateAnalysis(analysis, segments);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('rule-x');
      expect(result.reason).toContain('zero evidence');
    }
  });

  test('rejects an unknown segmentId', () => {
    const segments = segmentsMap({ 'seg-1': 'Have you ever wondered why the sky is blue?' });
    const analysis = baseAnalysis({
      rules: [{ id: 'rule-1', statement: 'x', evidence: [{ segmentId: 'seg-does-not-exist', quote: 'x' }] }],
    });
    const result = validateAnalysis(analysis, segments);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('seg-does-not-exist');
      expect(result.reason).toContain('not in the pinned transcript');
    }
  });

  test('rejects a quote that is not an exact substring (no fuzzy matching)', () => {
    const segments = segmentsMap({ 'seg-1': 'Have you ever wondered why the sky is blue?' });
    const analysis = baseAnalysis({
      rules: [{ id: 'rule-1', statement: 'x', evidence: [{ segmentId: 'seg-1', quote: 'have u ever wonder' }] }],
    });
    const result = validateAnalysis(analysis, segments);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('not an exact substring');
    }
  });
});

describe('formulaFromSingleAnalysis', () => {
  test('always produces status TRIAL and a LOW_SAMPLE warning', () => {
    const analysis = baseAnalysis();
    const formula = formulaFromSingleAnalysis(analysis, {
      videoSnapshotId: analysis.videoSnapshotId,
      analysisArtifactHash: 'deadbeef',
    }, 'batch-1');

    expect(formula.status).toBe('TRIAL');
    expect(formula.sourceBatchId).toBe('batch-1');
    expect(formula.scope).toBe('SINGLE_CHANNEL');
    expect(formula.rules).toEqual(analysis.rules);
    expect(formula.channelGroups).toEqual([
      { channelTitle: 'Channel One', videoSnapshotIds: ['video-1'] },
    ]);
    expect(formula.includedArtifacts).toEqual([
      { videoSnapshotId: 'video-1', analysisArtifactHash: 'deadbeef' },
    ]);
    expect(formula.warnings.some((w) => w.includes('LOW_SAMPLE'))).toBe(true);
    expect(formula.id).toBeTruthy();
    expect(formula.createdAt).toBeTruthy();
  });
});
