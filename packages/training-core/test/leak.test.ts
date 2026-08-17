/**
 * `detectTopicLeak` (see `../src/leak.ts`'s doc comment). The leak fixtures below
 * are taken verbatim from a real committed Formula (`0fcb21c0-...json`) that was
 * flagged as leaking topic — this is the actual evidence the task was scoped from,
 * not invented text.
 *
 * Renamed from `writer-view.test.ts` 2026-08-11 (FM1) alongside `writer-view.ts` →
 * `leak.ts` — same file, same test bodies, just following the source rename.
 * `toWriterFormula`/`WriterFormula` and their tests were removed 2026-08-11 (FM1,
 * plan/writer-train/FORMULA-MIGRATION-TO-WRITER.md §1/§6); see `leak.ts`'s doc
 * comment for where that projection lives now (`draft-view.ts`, Training-only).
 */
import { describe, expect, test } from 'bun:test';
import { detectTopicLeak } from '../src/leak.ts';

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
