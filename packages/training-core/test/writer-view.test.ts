/**
 * `toWriterFormula` / `detectTopicLeak` (see `../src/writer-view.ts` for the
 * "Formula has two views" rationale). The leak fixtures below are taken verbatim
 * from a real committed Formula (`0fcb21c0-...json`) that was flagged as leaking
 * topic — this is the actual evidence the task was scoped from, not invented text.
 */
import { describe, expect, test } from 'bun:test';
import { detectTopicLeak, toWriterFormula } from '../src/writer-view.ts';
import type { CompoundRule, FormulaArtifact } from '../src/contracts.ts';

function baseFormula(overrides: Partial<FormulaArtifact> = {}): FormulaArtifact {
  return {
    id: 'formula-1',
    status: 'TRIAL',
    origin: 'ANALYZED',
    version: 1,
    videoSnapshotId: 'video-1',
    channelTitle: 'Sói Tài Chính',
    rules: [
      {
        id: 'rule-1',
        statement: 'Mở đầu bằng một câu chuyện nhân vật cụ thể kèm số liệu.',
        evidence: [{ segmentIds: ['seg-1'], quote: 'Anh Minh năm nay 32 tuổi' }],
      },
    ],
    includedArtifacts: [{ videoSnapshotId: 'video-1', analysisArtifactHash: 'hash-1' }],
    lineage: {},
    warnings: [],
    createdAt: '2026-08-09T00:00:00.000Z',
    ...overrides,
  };
}

describe('toWriterFormula', () => {
  test('ANALYZED: labels with channelTitle and drops evidence', () => {
    const writer = toWriterFormula(baseFormula());
    expect(writer).toEqual({
      id: 'formula-1',
      label: 'Sói Tài Chính',
      rules: [{ id: 'rule-1', statement: 'Mở đầu bằng một câu chuyện nhân vật cụ thể kèm số liệu.' }],
    });
    // Belt-and-suspenders: assert the specific fields the task called out as
    // "must not leak" are genuinely absent, not just absent from the `toEqual`
    // shape (which would also pass if the type happened to allow extras).
    for (const rule of writer.rules) {
      expect(Object.keys(rule).sort()).toEqual(['id', 'statement']);
    }
  });

  test('REFINED: also labels with channelTitle', () => {
    const writer = toWriterFormula(
      baseFormula({
        origin: 'REFINED',
        version: 2,
        lineage: { parentFormulaId: 'formula-0', labRunId: 'run-1' },
      }),
    );
    expect(writer.label).toBe('Sói Tài Chính');
  });

  test('COMPOUND: labels with genre, not channelTitle, and strips per-rule sources/mergeOrigin', () => {
    const compoundRule: CompoundRule = {
      id: 'rule-c1',
      statement: 'Dùng câu hỏi tu từ để chuyển đoạn.',
      evidence: [{ segmentIds: ['seg-1'], quote: 'Bạn có bao giờ tự hỏi' }],
      mergeOrigin: 'CARRIED',
      sources: [
        {
          videoSnapshotId: 'video-2',
          channelTitle: 'Another Channel',
          sourceFormulaId: 'formula-2',
          sourceRuleId: 'rule-2',
          evidence: [{ segmentIds: ['seg-1'], quote: 'Bạn có bao giờ tự hỏi' }],
        },
      ],
    };
    const compound = baseFormula({
      origin: 'COMPOUND',
      channelTitle: undefined,
      genre: 'Tài chính cá nhân',
      videoSnapshotId: undefined,
      rules: [compoundRule],
      lineage: { studioSessionId: 'session-1' },
    });

    const writer = toWriterFormula(compound);
    expect(writer.label).toBe('Tài chính cá nhân');
    expect(writer.rules).toEqual([{ id: 'rule-c1', statement: 'Dùng câu hỏi tu từ để chuyển đoạn.' }]);
    expect(Object.keys(writer.rules[0]!).sort()).toEqual(['id', 'statement']);
  });

  test('missing label field falls back to empty string rather than throwing', () => {
    const writer = toWriterFormula(baseFormula({ channelTitle: undefined }));
    expect(writer.label).toBe('');
  });

  /**
   * Regression: a real pre-ADR-14 Formula is still on disk today carrying
   * `scope`/`channelGroups` and no `origin`. Read raw (not via `getFormula`, which
   * normalizes), it used to yield `label: ''` — silently handing the Writer a Formula
   * with no context label instead of failing. `toWriterFormula` now normalizes first.
   */
  test('legacy pre-ADR-14 shape still resolves its label', () => {
    const legacy = {
      id: 'legacy-1',
      status: 'TRIAL',
      scope: 'SINGLE_CHANNEL',
      channelGroups: [{ channelTitle: 'Sói Tài Chính', videoSnapshotIds: ['v-1'] }],
      rules: [{ id: 'rule-1', statement: 'Mở đầu bằng câu chuyện.', evidence: [] }],
      includedArtifacts: [],
      warnings: [],
      createdAt: '2026-08-09T00:00:00.000Z',
    } as unknown as FormulaArtifact;

    const writer = toWriterFormula(legacy);
    expect(writer.label).toBe('Sói Tài Chính');
    expect(writer.rules).toEqual([{ id: 'rule-1', statement: 'Mở đầu bằng câu chuyện.' }]);
  });
});

describe('detectTopicLeak', () => {
  test('a generic, video-agnostic rule triggers nothing', () => {
    const leaks = detectTopicLeak(
      'Dùng câu hỏi tu từ để dẫn dắt và chuyển đoạn, khơi gợi tò mò trước khi đưa ra câu trả lời hoặc mở phần mới.',
    );
    expect(leaks).toEqual([]);
  });

  test('catches a verbatim brand-line quote (real leak: rule-7 of 0fcb21c0)', () => {
    const leaks = detectTopicLeak(
      'Video mở và kết bằng chính câu nhận diện thương hiệu cá nhân \'tôi là sói tài chính\', tạo cấu trúc đóng khung (bookend) cho toàn bộ nội dung.',
    );
    expect(leaks).toContainEqual({ kind: 'VERBATIM_QUOTE', excerpt: 'tôi là sói tài chính' });
  });

  test('catches a verbatim coined-term quote (real leak: rule-4 of 0fcb21c0)', () => {
    const leaks = detectTopicLeak(
      'Đặt tên ẩn dụ riêng cho một khái niệm tài chính ("thuế ở lại thành phố") rồi lặp lại nó xuyên suốt video.',
    );
    expect(leaks.some((l) => l.kind === 'VERBATIM_QUOTE' && l.excerpt === 'thuế ở lại thành phố')).toBe(true);
  });

  test('catches a video-position timestamp (real leak: rule-1 of 0fcb21c0)', () => {
    const leaks = detectTopicLeak(
      'Trì hoãn phần chào hỏi/giới thiệu kênh cho tới tận giây thứ ~101, thay vì host tự giới thiệu ngay từ đầu.',
    );
    expect(leaks).toContainEqual({ kind: 'SPECIFIC_NUMBER', excerpt: 'giây thứ ~101' });
  });

  test('catches a literal section-number listing (real leak: rule-3 of 0fcb21c0)', () => {
    const leaks = detectTopicLeak(
      'Cấu trúc nội dung thành các Phần được đánh số rõ ràng (Phần một, Phần hai, Phần bốn...).',
    );
    expect(leaks.some((l) => l.kind === 'VIDEO_ORDINAL' && l.excerpt === 'Phần một, Phần hai, Phần bốn')).toBe(
      true,
    );
  });

  test('does NOT flag a generic repeat-count as SPECIFIC_NUMBER (real non-leak: rule-6 of 0fcb21c0)', () => {
    const leaks = detectTopicLeak(
      'Sử dụng điệp cấu trúc (anaphora) lặp lại ba lần liên tiếp để nhấn mạnh nghịch lý.',
    );
    expect(leaks.filter((l) => l.kind === 'SPECIFIC_NUMBER')).toEqual([]);
    expect(leaks).toEqual([]);
  });

  test('a single "Phần" mention with no ordinal list is not a VIDEO_ORDINAL leak', () => {
    const leaks = detectTopicLeak('Chia video thành nhiều Phần theo chủ đề.');
    expect(leaks.filter((l) => l.kind === 'VIDEO_ORDINAL')).toEqual([]);
  });

  test('a plain timestamp-shaped number without giây/phút is not flagged', () => {
    const leaks = detectTopicLeak('Nhắc lại thông điệp chính 3 lần trong video.');
    expect(leaks.filter((l) => l.kind === 'SPECIFIC_NUMBER')).toEqual([]);
  });
});
