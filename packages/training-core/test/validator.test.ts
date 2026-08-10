import { describe, expect, test } from 'bun:test';
import { formulaFromSingleAnalysis, validateAnalysis, validateCritique } from '../src/validator.ts';
import type { AnalysisArtifact, CritiqueArtifact } from '../src/contracts.ts';

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
        evidence: [{ segmentIds: ['seg-1'], quote: 'Have you ever wondered' }],
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
      rules: [{ id: 'rule-1', statement: 'x', evidence: [{ segmentIds: ['seg-does-not-exist'], quote: 'x' }] }],
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
      rules: [{ id: 'rule-1', statement: 'x', evidence: [{ segmentIds: ['seg-1'], quote: 'have u ever wonder' }] }],
    });
    const result = validateAnalysis(analysis, segments);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('not an exact substring');
    }
  });

  test('accepts a quote spanning two consecutive segments, joined with a space (§8.1 multi-segment grounding, 2026-08-10)', () => {
    // Real auto-caption transcripts chunk into ~4s windows that split mid-sentence
    // (e.g. "...thành phố" | "không còn đáng theo đuổi..."); a rule quoting the full
    // sentence must cite both segmentIds, in order.
    const segments = segmentsMap({
      'seg-1': 'bỏ phố về quê. Khi giấc mơ thành phố',
      'seg-2': 'không còn đáng theo đuổi, Hùng và vợ',
    });
    const analysis = baseAnalysis({
      rules: [{
        id: 'rule-1', statement: 'x',
        evidence: [{ segmentIds: ['seg-1', 'seg-2'], quote: 'thành phố không còn đáng theo đuổi' }],
      }],
    });
    const result = validateAnalysis(analysis, segments);
    expect(result.ok).toBe(true);
  });

  test('rejects a multi-segment quote that does not match the space-joined concatenation', () => {
    const segments = segmentsMap({
      'seg-1': 'bỏ phố về quê. Khi giấc mơ thành phố',
      'seg-2': 'không còn đáng theo đuổi, Hùng và vợ',
    });
    const analysis = baseAnalysis({
      rules: [{
        id: 'rule-1', statement: 'x',
        // Wrong order — 'seg-2' text does not precede 'seg-1' text in the transcript.
        evidence: [{ segmentIds: ['seg-2', 'seg-1'], quote: 'thành phố không còn đáng theo đuổi' }],
      }],
    });
    const result = validateAnalysis(analysis, segments);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('not an exact substring');
    }
  });

  test('rejects evidence with zero segmentIds', () => {
    const segments = segmentsMap({ 'seg-1': 'anything' });
    const analysis = baseAnalysis({
      rules: [{ id: 'rule-1', statement: 'x', evidence: [{ segmentIds: [], quote: 'x' }] }],
    });
    const result = validateAnalysis(analysis, segments);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('no segmentIds');
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
    expect(formula.origin).toBe('ANALYZED');
    expect(formula.version).toBe(1);
    expect(formula.lineage).toEqual({});
    expect(formula.rules).toEqual(analysis.rules);
    expect(formula.videoSnapshotId).toBe('video-1');
    expect(formula.channelTitle).toBe('Channel One');
    expect(formula.includedArtifacts).toEqual([
      { videoSnapshotId: 'video-1', analysisArtifactHash: 'deadbeef' },
    ]);
    expect(formula.warnings.some((w) => w.includes('LOW_SAMPLE'))).toBe(true);
    expect(formula.id).toBeTruthy();
    expect(formula.createdAt).toBeTruthy();
  });
});

describe('validateCritique', () => {
  const draftScript = 'This new video opens with a bold personal story about losing everything.';

  function baseCritique(overrides: Partial<CritiqueArtifact> = {}): CritiqueArtifact {
    return {
      positivePatterns: [
        {
          id: 'p1',
          ruleId: 'rule-1',
          description: 'Draft opens with a direct question, matching the source pattern.',
          sourceEvidence: [{ segmentIds: ['seg-1'], quote: 'Have you ever wondered' }],
          draftEvidence: [{ quote: 'This new video opens with a bold personal story' }],
        },
      ],
      negativePatterns: [],
      ...overrides,
    };
  }

  test('happy path: every pattern has grounded evidence on both sides', () => {
    const segments = segmentsMap({ 'seg-1': 'Have you ever wondered why the sky is blue?' });
    const result = validateCritique(baseCritique(), segments, draftScript);
    expect(result.ok).toBe(true);
  });

  test('rejects zero patterns', () => {
    const segments = segmentsMap({ 'seg-1': 'anything' });
    const result = validateCritique(
      baseCritique({ positivePatterns: [], negativePatterns: [] }),
      segments,
      draftScript,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe('AGENT_UNGROUNDED');
      expect(result.reason).toContain('zero patterns');
    }
  });

  test('rejects a sourceEvidence entry with a missing segmentId', () => {
    const segments = segmentsMap({ 'seg-1': 'Have you ever wondered why the sky is blue?' });
    const critique = baseCritique({
      negativePatterns: [
        {
          id: 'n1',
          description: 'Draft skips the numbered-section structure.',
          sourceEvidence: [{ segmentIds: ['seg-does-not-exist'], quote: 'x' }],
          draftEvidence: [{ quote: 'This new video opens' }],
        },
      ],
    });
    const result = validateCritique(critique, segments, draftScript);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('n1');
      expect(result.reason).toContain('seg-does-not-exist');
      expect(result.reason).toContain('not in the pinned transcript');
    }
  });

  test('rejects a source quote that is not an exact substring of the segment', () => {
    const segments = segmentsMap({ 'seg-1': 'Have you ever wondered why the sky is blue?' });
    const critique = baseCritique({
      positivePatterns: [
        {
          id: 'p1',
          description: 'x',
          sourceEvidence: [{ segmentIds: ['seg-1'], quote: 'have u ever wonder' }],
          draftEvidence: [{ quote: 'This new video opens' }],
        },
      ],
    });
    const result = validateCritique(critique, segments, draftScript);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('sourceEvidence');
      expect(result.reason).toContain('not an exact substring');
    }
  });

  test('rejects a draft quote that is not an exact substring of the draft script', () => {
    const segments = segmentsMap({ 'seg-1': 'Have you ever wondered why the sky is blue?' });
    const critique = baseCritique({
      positivePatterns: [
        {
          id: 'p1',
          description: 'x',
          sourceEvidence: [{ segmentIds: ['seg-1'], quote: 'Have you ever wondered' }],
          draftEvidence: [{ quote: 'this sentence never appears in the draft' }],
        },
      ],
    });
    const result = validateCritique(critique, segments, draftScript);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('draftEvidence');
      expect(result.reason).toContain('not an exact substring of the draft script');
    }
  });
});
