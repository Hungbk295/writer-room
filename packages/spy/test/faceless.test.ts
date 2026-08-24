/**
 * faceless.test.ts — scoreFacelessHint(): PHỎNG ĐOÁN text-only.
 *
 * Detector local đã bị gỡ khỏi scope (quyết định 21-08) nên ở đây không còn
 * thumbnail, không download, không detector. Test bám hai điều duy nhất mà hint
 * được phép hứa: công thức, và "không đủ mẫu thì không đoán".
 */
import { describe, expect, test } from 'bun:test';
import { scoreFacelessHint, type FacelessHintInput } from '../src/faceless.ts';

/** 6 title trung tính — đủ mẫu (≥6) nhưng không kích tín hiệu nào. */
const NEUTRAL_TITLES = [
  'Bảng cân đối kế toán',
  'Quỹ mở và ETF',
  'Chi phí cơ hội',
  'Lạm phát 2026',
  'Trái phiếu doanh nghiệp',
  'Bảo hiểm nhân thọ',
];

function makeInput(overrides: Partial<FacelessHintInput> = {}): FacelessHintInput {
  return {
    channelTitle: 'TestChannel',
    videoTitles: NEUTRAL_TITLES,
    ...overrides,
  };
}

describe('scoreFacelessHint — gate mẫu', () => {
  test('dưới 6 title → hint null, method insufficient_sample', () => {
    const result = scoreFacelessHint(makeInput({ videoTitles: ['giải thích lãi kép'] }));
    expect(result.hint).toBeNull();
    expect(result.method).toBe('insufficient_sample');
  });

  test('không có title nào → hint null', () => {
    const result = scoreFacelessHint(makeInput({ videoTitles: [] }));
    expect(result.hint).toBeNull();
    expect(result.method).toBe('insufficient_sample');
  });

  test('đủ 6 title trung tính → hint = 0.5 (không biết), method text_only', () => {
    const result = scoreFacelessHint(makeInput());
    expect(result.method).toBe('text_only');
    expect(result.hint).toBe(0.5);
    expect(result.reasons).toEqual([]);
  });
});

describe('scoreFacelessHint — tín hiệu HOST kéo hint xuống', () => {
  test('title vlog/reaction (vi + en) → hint < 0.5 và có reason keyword', () => {
    const result = scoreFacelessHint(
      makeInput({
        videoTitles: [
          'vlog ngày 1 ở Đà Lạt',
          'day in my life at home',
          'reaction to viral video',
          'một ngày của mình khi làm freelancer',
          'podcast số 4: tiền và hạnh phúc',
          'đập hộp máy ảnh mới',
        ],
      }),
    );
    expect(result.method).toBe('text_only');
    expect(result.hint).not.toBeNull();
    expect(result.hint!).toBeLessThan(0.5);
    expect(result.reasons.some((r) => r.kind === 'keyword' && r.ref === 'host_titles')).toBe(true);
  });

  test('deixis trong text được tính (ngôi thứ nhất một mình thì không)', () => {
    const withDeixis = scoreFacelessHint(
      makeInput({ description: 'Như các bạn thấy, trên tay mình là cuốn sổ chi tiêu' }),
    );
    expect(withDeixis.reasons.some((r) => r.kind === 'deixis')).toBe(true);
    expect(withDeixis.hint!).toBeLessThan(0.5);

    // "mình" không kèm deixis → kênh kể chuyện VN vẫn faceless, không bị trừ.
    const firstPersonOnly = scoreFacelessHint(
      makeInput({ description: 'Mình tổng hợp các con số từ báo cáo tài chính' }),
    );
    expect(firstPersonOnly.reasons.some((r) => r.kind === 'deixis')).toBe(false);
  });

  test('tên kênh dạng Họ Tên → reason name_brand', () => {
    const result = scoreFacelessHint(makeInput({ channelTitle: 'Nguyen Minh' }));
    expect(result.reasons.some((r) => r.kind === 'name_brand')).toBe(true);
    expect(result.hint!).toBeLessThan(0.5);
  });
});

describe('scoreFacelessHint — tín hiệu FACELESS-EXPLAINER kéo hint lên', () => {
  test('title giải thích vi + en → hint > 0.5', () => {
    const result = scoreFacelessHint(
      makeInput({
        videoTitles: [
          'giải thích về đầu tư chứng khoán',
          'top 10 sự thật về crypto',
          'tại sao kinh tế suy thoái',
          'sự thật về nợ xấu',
          'compound interest explained',
          'what if you save 10% every month',
        ],
      }),
    );
    expect(result.method).toBe('text_only');
    expect(result.hint!).toBeGreaterThan(0.5);
    expect(result.reasons.some((r) => r.kind === 'keyword' && r.ref === 'faceless_titles')).toBe(true);
  });

  test('boilerplate mô tả (TTS vendor / stock) là tín hiệu mạnh', () => {
    const result = scoreFacelessHint(
      makeInput({ description: 'Giọng đọc bởi Vbee. Footage: Pexels. fair use' }),
    );
    expect(result.reasons.some((r) => r.kind === 'boilerplate')).toBe(true);
    expect(result.hint!).toBeGreaterThan(0.5);
  });

  test('synthetic presenter (HeyGen/VTuber) đẩy về phía faceless, không phải cổng chặn', () => {
    const result = scoreFacelessHint(
      makeInput({ description: 'Video được tạo bằng AI avatar HeyGen Studio' }),
    );
    expect(result.method).toBe('text_only');
    expect(result.hint).not.toBeNull();
    expect(result.hint!).toBeGreaterThan(0.5);
    expect(result.reasons.some((r) => r.kind === 'synthetic_presenter')).toBe(true);
  });
});

describe('scoreFacelessHint — hợp đồng đầu ra', () => {
  test('hint luôn nằm trong [0,1] kể cả khi cả hai phía cùng bắn tín hiệu', () => {
    const result = scoreFacelessHint(
      makeInput({
        videoTitles: [
          'vlog: một ngày của mình',
          'reaction to storytime',
          'podcast tâm sự',
          'giải thích lãi kép',
          'top 5 sự thật về tiền',
          'documentary narrated',
        ],
        description: 'Giọng đọc bởi Vbee. Như các bạn thấy, trên tay mình...',
      }),
    );
    expect(result.hint!).toBeGreaterThanOrEqual(0);
    expect(result.hint!).toBeLessThanOrEqual(1);
  });

  test('reasons có shape {kind, ref, value, weight} và ≤ 8 phần tử', () => {
    const result = scoreFacelessHint(
      makeInput({
        channelTitle: 'Nguyen Minh',
        videoTitles: [
          'vlog ngày 1',
          'giải thích lãi kép',
          'top 3 lý do bạn nghèo',
          'day in my life',
          'reaction video',
          'documentary narrated',
        ],
        description: 'Giọng đọc bởi Vbee — như các bạn thấy — AI avatar HeyGen',
        videoDescriptions: ['podcast tâm sự', 'giải mã bí ẩn'],
      }),
    );
    expect(result.reasons.length).toBeLessThanOrEqual(8);
    for (const reason of result.reasons) {
      expect(typeof reason.kind).toBe('string');
      expect(typeof reason.ref).toBe('string');
      expect(typeof reason.value).toBe('number');
      expect(typeof reason.weight).toBe('number');
    }
  });

  test('thuần hàm: transcriptExcerpt được đọc, không có I/O nào', () => {
    const result = scoreFacelessHint(
      makeInput({ transcriptExcerpt: 'as you can see, right here on camera' }),
    );
    expect(result.reasons.some((r) => r.kind === 'deixis')).toBe(true);
  });
});
