/**
 * Formula Studio: clustering + compound validators (SDD §12b, ADR-13).
 * Pure functions only — no I/O, no agent, no tokens spent.
 */
import { describe, expect, test } from 'bun:test';
import { clusterRules, similarity, type PickedRule } from '../src/cluster.ts';
import { validateCompoundCritique, validateCompoundRule } from '../src/validator.ts';
import type { CompoundRule, CritiqueArtifact } from '../src/contracts.ts';

function picked(overrides: Partial<PickedRule> & { statement: string }): PickedRule {
  return {
    videoSnapshotId: 'video-1',
    channelTitle: 'Channel One',
    sourceFormulaId: 'formula-1',
    sourceRuleId: 'rule-1',
    evidence: [{ segmentIds: ['seg-1'], quote: 'quote' }],
    ...overrides,
  };
}

describe('similarity', () => {
  test('identical statements score 1', () => {
    expect(similarity('Mở bài bằng một câu hỏi trực tiếp', 'Mở bài bằng một câu hỏi trực tiếp')).toBe(1);
  });

  test('unrelated statements score low', () => {
    const score = similarity(
      'Mở bài bằng một câu hỏi trực tiếp với người xem',
      'Kết bài bằng lời kêu gọi đăng ký kênh',
    );
    expect(score).toBeLessThan(0.5);
  });

  test('punctuation and casing do not affect the score', () => {
    expect(similarity('Mở bài bằng câu hỏi!', 'mở bài, bằng câu hỏi...')).toBe(1);
  });

  test('diacritics are NOT stripped — different tones are different words', () => {
    // "bàn" (table/discuss) vs "bán" (sell): collapsing these would merge unrelated rules.
    expect(similarity('bàn chuyện tiền bạc', 'bán chuyện tiền bạc')).toBeLessThan(1);
  });

  test('a statement of only stopwords is similar to nothing', () => {
    expect(similarity('và của là một', 'Mở bài bằng câu hỏi')).toBe(0);
  });
});

describe('clusterRules', () => {
  test('groups near-duplicate statements from different videos', () => {
    const clusters = clusterRules([
      picked({ statement: 'Mở bài bằng một câu chuyện cá nhân có số liệu cụ thể' }),
      picked({
        videoSnapshotId: 'video-2',
        sourceFormulaId: 'formula-2',
        statement: 'Mở bài bằng câu chuyện cá nhân kèm số liệu cụ thể',
      }),
    ]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.kind).toBe('SIMILAR');
    expect(clusters[0]!.members).toHaveLength(2);
    // Provenance of both sources survives clustering — this is what the merge needs.
    expect(clusters[0]!.members.map((m) => m.videoSnapshotId)).toEqual(['video-1', 'video-2']);
  });

  test('keeps genuinely different tactics apart', () => {
    const clusters = clusterRules([
      picked({ statement: 'Mở bài bằng một câu chuyện cá nhân có số liệu' }),
      picked({ videoSnapshotId: 'video-2', statement: 'Kết bài bằng khung ba khái niệm đã đặt tên' }),
    ]);

    expect(clusters).toHaveLength(2);
    expect(clusters.every((c) => c.kind === 'SINGLE')).toBe(true);
  });

  test('never drops a picked rule', () => {
    const input = [
      picked({ statement: 'Mở bài bằng câu hỏi trực tiếp' }),
      picked({ videoSnapshotId: 'video-2', statement: 'Mở bài bằng câu hỏi trực tiếp' }),
      picked({ videoSnapshotId: 'video-3', statement: 'Đặt tên riêng cho khái niệm rồi lặp lại' }),
      picked({ videoSnapshotId: 'video-4', statement: 'Chốt bằng lời kêu gọi hành động rõ ràng' }),
    ];
    const clusters = clusterRules(input);
    const total = clusters.reduce((sum, c) => sum + c.members.length, 0);
    expect(total).toBe(input.length);
  });

  test('is deterministic — same input, same clusters', () => {
    const input = [
      picked({ statement: 'Mở bài bằng câu hỏi trực tiếp' }),
      picked({ videoSnapshotId: 'video-2', statement: 'Đặt tên riêng cho khái niệm' }),
      picked({ videoSnapshotId: 'video-3', statement: 'Mở bài bằng câu hỏi trực tiếp' }),
    ];
    expect(JSON.stringify(clusterRules(input))).toBe(JSON.stringify(clusterRules(input)));
  });

  test('empty input yields no clusters', () => {
    expect(clusterRules([])).toEqual([]);
  });
});

describe('validateCompoundRule', () => {
  function rule(overrides: Partial<CompoundRule> = {}): CompoundRule {
    return {
      id: 'cr-1',
      statement: 'Mở bài bằng câu chuyện cá nhân có số liệu cụ thể',
      origin: 'SYNTHESIZED',
      provenance: [
        {
          videoSnapshotId: 'video-1',
          channelTitle: 'Channel One',
          sourceFormulaId: 'formula-1',
          sourceRuleId: 'rule-1',
          evidence: [{ segmentIds: ['seg-1'], quote: 'hồi đó tôi kiếm được 3 triệu' }],
        },
      ],
      ...overrides,
    };
  }

  test('accepts a rule that names where it came from', () => {
    expect(validateCompoundRule(rule()).ok).toBe(true);
  });

  test('rejects a rule with no provenance — the core Studio gate', () => {
    const result = validateCompoundRule(rule({ provenance: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('STUDIO_RULE_UNGROUNDED');
  });

  test('rejects an incomplete provenance entry', () => {
    const result = validateCompoundRule(
      rule({
        provenance: [
          {
            videoSnapshotId: 'video-1',
            channelTitle: 'Channel One',
            sourceFormulaId: '',
            sourceRuleId: 'rule-1',
            evidence: [],
          },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('STUDIO_RULE_UNGROUNDED');
  });

  test('rejects an empty statement', () => {
    const result = validateCompoundRule(rule({ statement: '   ' }));
    expect(result.ok).toBe(false);
  });
});

describe('validateCompoundCritique', () => {
  const draft = 'Lương 45 triệu nhưng vẫn không dám nghỉ việc. Mỗi tháng chị mất khoảng 3-4 triệu.';

  function segmentsByVideo(): Map<string, Map<string, { text: string }>> {
    return new Map([
      ['video-1', new Map([['seg-1', { text: 'hồi đó tôi kiếm được khoảng 3-4 triệu một tháng' }]])],
      ['video-2', new Map([['seg-9', { text: 'chị ấy không dám nghỉ việc vì sợ mất thu nhập' }]])],
    ]);
  }

  function critique(overrides: Partial<CritiqueArtifact> = {}): CritiqueArtifact {
    return {
      positivePatterns: [
        {
          id: 'p-1',
          description: 'Giữ cách nói số tròn như nguồn',
          sourceEvidence: [{ videoSnapshotId: 'video-1', segmentIds: ['seg-1'], quote: 'khoảng 3-4 triệu' }],
          draftEvidence: [{ quote: 'khoảng 3-4 triệu' }],
        },
      ],
      negativePatterns: [],
      ...overrides,
    };
  }

  test('happy path: evidence cites a video the compound draws from', () => {
    expect(validateCompoundCritique(critique(), segmentsByVideo(), draft).ok).toBe(true);
  });

  test('accepts patterns citing two different source videos', () => {
    const result = validateCompoundCritique(
      critique({
        negativePatterns: [
          {
            id: 'n-1',
            description: 'Bỏ mất nhân vật đối lập',
            sourceEvidence: [{ videoSnapshotId: 'video-2', segmentIds: ['seg-9'], quote: 'không dám nghỉ việc' }],
            draftEvidence: [{ quote: 'không dám nghỉ việc' }],
          },
        ],
      }),
      segmentsByVideo(),
      draft,
    );
    expect(result.ok).toBe(true);
  });

  test('rejects evidence with no videoSnapshotId', () => {
    const result = validateCompoundCritique(
      critique({
        positivePatterns: [
          {
            id: 'p-1',
            description: 'x',
            sourceEvidence: [{ segmentIds: ['seg-1'], quote: 'khoảng 3-4 triệu' }],
            draftEvidence: [{ quote: 'khoảng 3-4 triệu' }],
          },
        ],
      }),
      segmentsByVideo(),
      draft,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('STUDIO_EVIDENCE_OUT_OF_SCOPE');
  });

  test('rejects evidence citing a video outside the compound', () => {
    const result = validateCompoundCritique(
      critique({
        positivePatterns: [
          {
            id: 'p-1',
            description: 'x',
            sourceEvidence: [{ videoSnapshotId: 'video-99', segmentIds: ['seg-1'], quote: 'khoảng 3-4 triệu' }],
            draftEvidence: [{ quote: 'khoảng 3-4 triệu' }],
          },
        ],
      }),
      segmentsByVideo(),
      draft,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('STUDIO_EVIDENCE_OUT_OF_SCOPE');
  });

  test('rejects a source quote that is not verbatim', () => {
    const result = validateCompoundCritique(
      critique({
        positivePatterns: [
          {
            id: 'p-1',
            description: 'x',
            sourceEvidence: [{ videoSnapshotId: 'video-1', segmentIds: ['seg-1'], quote: 'chính xác 3.500.000' }],
            draftEvidence: [{ quote: 'khoảng 3-4 triệu' }],
          },
        ],
      }),
      segmentsByVideo(),
      draft,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('AGENT_UNGROUNDED');
  });

  test('rejects a draft quote that is not in the draft', () => {
    const result = validateCompoundCritique(
      critique({
        positivePatterns: [
          {
            id: 'p-1',
            description: 'x',
            sourceEvidence: [{ videoSnapshotId: 'video-1', segmentIds: ['seg-1'], quote: 'khoảng 3-4 triệu' }],
            draftEvidence: [{ quote: 'câu này không có trong bài' }],
          },
        ],
      }),
      segmentsByVideo(),
      draft,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('AGENT_UNGROUNDED');
  });

  test('rejects a critique with zero patterns', () => {
    const result = validateCompoundCritique({ positivePatterns: [], negativePatterns: [] }, segmentsByVideo(), draft);
    expect(result.ok).toBe(false);
  });
});
