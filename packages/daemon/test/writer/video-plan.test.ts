/**
 * Beat grammar (SDD 006) — `WriterVideoPlan` schema and validator.
 *
 * `validateWriterVideoPlan` is the single machine-checkable gate on outline
 * shape: mode/turn per beat, one frame for the whole piece, and an ending that
 * must not answer the hook directly. Prose quality (does the beat actually
 * *perform* its declared mode?) is the editor's job, not this validator's.
 */
import { describe, expect, test } from 'bun:test';
import {
  parseCoverageSequence,
  validateWriterVideoPlan,
  type WriterVideoPlan,
} from '../../src/writer/video-plan.ts';

/** A clean, 5-beat outline with no adjacent mode/turn repeats and no overuse. */
function validOutline(): WriterVideoPlan {
  return {
    coreInsight: 'Chi phí cố định quyết định quyền lựa chọn, không phải mức lương',
    memoryAnchor: { kind: 'contrast', value: 'lương tăng vs quyền chọn giảm' },
    frame: { kind: 'con-so', value: 'khoản chi phí cố định hằng tháng' },
    progression: [
      {
        beat: 'mở',
        newInformation: 'đặt câu hỏi ngân sách',
        characterOrArgumentChange: 'a',
        visualAnchor: 'b',
        mode: 'canh',
        turn: 'doi-thoi-diem',
        familiarObject: 'bảng sao kê ngân hàng cuối tháng',
        whyNotEarlier: 'chưa có con số cụ thể để neo câu hỏi',
      },
      {
        beat: 'mổ số',
        newInformation: 'cố định phình',
        characterOrArgumentChange: 'c',
        visualAnchor: 'd',
        mode: 'mo-so',
        turn: 'doi-thang',
        familiarObject: 'khoản trả góp xe hằng tháng',
        whyNotEarlier: 'cần cảnh mở trước để con số có bối cảnh',
      },
      {
        beat: 'phản bác',
        newInformation: 'câu cãi mạnh nhất',
        characterOrArgumentChange: 'e',
        visualAnchor: 'f',
        mode: 'phan-bac',
        turn: 'doi-ten',
        familiarObject: 'lãi suất ưu đãi năm đầu',
        whyNotEarlier: 'phải có con số trước mới có gì để cãi',
      },
      {
        beat: 'cực trị',
        newInformation: 'đẩy công thức tới input vô lý',
        characterOrArgumentChange: 'g',
        visualAnchor: 'h',
        mode: 'cuc-tri',
        turn: 'doi-cau-hoi',
        familiarObject: 'công thức 25 lần chi phí năm',
        whyNotEarlier: 'phản bác phải đứng trước để cực trị có mục tiêu',
      },
      {
        beat: 'zoom chữ',
        newInformation: 'soi lại một chữ đã dùng',
        characterOrArgumentChange: 'i',
        visualAnchor: 'k',
        mode: 'zoom-chu',
        turn: 'doi-chu-the',
        familiarObject: 'chữ "cố định" trong câu mở',
        whyNotEarlier: 'chữ đó phải đã xuất hiện trước mới soi được',
      },
    ],
    endingPayoff: {
      resolvesOpening: 'quyền lựa chọn còn lại sau khi trừ khoản cố định',
      audienceCanDo: 'trừ nghĩa vụ khỏi thu nhập trước khi tự nhận là an toàn',
      directAnswer: 'có, lương tăng vẫn đủ sống',
      reframedQuestion: 'quyền lựa chọn của bạn còn lại bao nhiêu sau các khoản cố định?',
    },
    cutList: ['mẹo đầu tư'],
  };
}

describe('validateWriterVideoPlan — accepts a well-formed outline', () => {
  test('the clean fixture passes', () => {
    const result = validateWriterVideoPlan(validOutline());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.videoPlan.frame.kind).toBe('con-so');
    expect(result.videoPlan.progression).toHaveLength(5);
    expect(result.videoPlan.endingPayoff.directAnswer).toBe('có, lương tăng vẫn đủ sống');
  });
});

describe('validateWriterVideoPlan — rejects (SDD 006 §8)', () => {
  test('adjacent beats sharing a mode are rejected', () => {
    const outline = validOutline();
    outline.progression[1]!.mode = outline.progression[0]!.mode;
    const result = validateWriterVideoPlan(outline);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('adjacent beats share mode');
  });

  test('adjacent beats sharing a turn are rejected', () => {
    const outline = validOutline();
    outline.progression[1]!.turn = outline.progression[0]!.turn;
    const result = validateWriterVideoPlan(outline);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('adjacent beats share turn');
  });

  test('a mode used 3 times is rejected, even non-adjacent', () => {
    const outline = validOutline();
    // canh, mo-so, canh, phan-bac, canh — no two adjacent beats share a mode,
    // but "canh" appears 3 times.
    outline.progression[2]!.mode = 'canh';
    outline.progression[2]!.turn = 'doi-don-vi';
    outline.progression[4]!.mode = 'canh';
    outline.progression[4]!.turn = 'doi-ten';
    const result = validateWriterVideoPlan(outline);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('mode overused');
  });

  test('"doi-y" as the last beat is rejected even when used only once', () => {
    const outline = validOutline();
    outline.progression[4]!.mode = 'doi-y';
    const result = validateWriterVideoPlan(outline);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('mode overused');
    expect(result.reason).toContain('doi-y');
  });

  test('an ending that answers the hook directly is rejected', () => {
    const outline = validOutline();
    outline.endingPayoff.directAnswer = outline.endingPayoff.resolvesOpening;
    const result = validateWriterVideoPlan(outline);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('ending answers the hook directly');
  });

  test('an outline that copies a 3-beat source sequence is rejected', () => {
    const outline = validOutline();
    const sourceModes = outline.progression.slice(0, 3).map((beat) => beat.mode);
    const result = validateWriterVideoPlan(outline, { sourceSequences: [sourceModes] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('outline copies source sequence');
  });

  test('a source sequence window is still checked when "khac" entries are filtered out', () => {
    const outline = validOutline();
    const sourceModes = outline.progression.slice(0, 3).map((beat) => beat.mode);
    // "khac" is spliced in but must be ignored, not treated as a wildcard slot.
    const result = validateWriterVideoPlan(outline, {
      sourceSequences: [[sourceModes[0]!, 'khac', sourceModes[1]!, sourceModes[2]!]],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('outline copies source sequence');
  });

  test('a valid outline is not rejected by an unrelated source sequence', () => {
    const outline = validOutline();
    const result = validateWriterVideoPlan(outline, {
      sourceSequences: [['zoom-chu', 'zoom-chu', 'zoom-chu']],
    });
    expect(result.ok).toBe(true);
  });
});

describe('validateWriterVideoPlan — field-level beat grammar checks', () => {
  test('an unknown mode is rejected', () => {
    const outline = validOutline();
    (outline.progression[0] as unknown as Record<string, unknown>).mode = 'khong-hop-le';
    const result = validateWriterVideoPlan(outline);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('videoPlan.progression[0]');
  });

  test('a familiarObject shorter than 12 characters is rejected', () => {
    const outline = validOutline();
    outline.progression[0]!.familiarObject = 'quá ngắn';
    const result = validateWriterVideoPlan(outline);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('familiarObject');
  });

  test('a missing frame is rejected', () => {
    const outline = validOutline() as unknown as Record<string, unknown>;
    delete outline['frame'];
    const result = validateWriterVideoPlan(outline);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('frame');
  });

  test('an unknown frame kind is rejected', () => {
    const outline = validOutline();
    (outline.frame as unknown as Record<string, unknown>).kind = 'khong-hop-le';
    const result = validateWriterVideoPlan(outline);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('frame.kind');
  });
});

describe('parseCoverageSequence', () => {
  test('an absent sequence defaults to empty', () => {
    const result = parseCoverageSequence(undefined, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sequence).toEqual([]);
  });

  test('a valid sequence of modes and "khac" is accepted', () => {
    const result = parseCoverageSequence(['canh', 'mo-so', 'khac'], 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sequence).toEqual(['canh', 'mo-so', 'khac']);
  });

  test('an unknown token is rejected', () => {
    const result = parseCoverageSequence(['canh', 'not-a-mode'], 2);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('coverageMap[2].sequence');
  });

  test('more than 12 entries is rejected', () => {
    const result = parseCoverageSequence(Array(13).fill('canh'), 1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('coverageMap[1].sequence');
  });
});
