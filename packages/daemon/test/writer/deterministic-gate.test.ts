/**
 * Write Loop v2 — Phase 0 acceptance.
 *
 * The headline case is the real audit fixture: the script of Writer run
 * `7d626c50` against the topic pack `1c24954b` it was actually written from
 * (`fixtures/`, trimmed to the first two video sections so the fixture stays a
 * readable size — trimming can only ADD unsourced numbers, never hide one).
 * An LLM reviewer scored that script 89/100 and said the case was not fabricated;
 * the gate has to disagree, in code, every time.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  extractCoinedLabels,
  extractNumericClaims,
  extractProperNouns,
  parseVietnameseNumeral,
  runDeterministicGate,
  type LedgerEntry,
} from '../../src/writer/deterministic-gate.ts';
import type { WriterVideoPlan } from '../../src/writer/video-plan.ts';

const FIXTURES = join(import.meta.dir, 'fixtures');
const auditScript = readFileSync(join(FIXTURES, 'run-7d626c50-script.txt'), 'utf8');
const auditPack = readFileSync(join(FIXTURES, 'pack-1c24954b.md'), 'utf8');

function outline(beats: string[]): WriterVideoPlan {
  return {
    coreInsight: 'Lương cao không đồng nghĩa còn quyền quyết định',
    memoryAnchor: { kind: 'contrast', value: 'thu nhập tăng vs quyền chọn giảm' },
    progression: beats.map((beat) => ({
      beat,
      newInformation: 'x',
      characterOrArgumentChange: 'y',
      visualAnchor: 'z',
    })),
    endingPayoff: { resolvesOpening: 'a', audienceCanDo: 'b' },
    cutList: [],
  };
}

describe('numeric claim extraction', () => {
  test('Vietnamese thousands separator vs decimal comma do not collapse', () => {
    const claims = extractNumericClaims('Số dư 380.000 đồng, tiền nhà 2,5 triệu, lương 25 triệu.');
    expect(claims.map((c) => [c.value, c.unit])).toEqual([
      [380000, 'đồng'],
      [2.5, 'triệu'],
      [25, 'triệu'],
    ]);
  });

  test('compound Vietnamese numerals are scored to the same value as digits', () => {
    expect(parseVietnameseNumeral('hai mươi lăm')).toBe(25);
    expect(parseVietnameseNumeral('ba trăm')).toBe(300);
    expect(parseVietnameseNumeral('mười lăm')).toBe(15);
    const claims = extractNumericClaims('Hai mươi lăm triệu một tháng.');
    expect(claims[0]?.value).toBe(25);
    expect(claims[0]?.unit).toBe('triệu');
  });
});

/**
 * Money is written half a dozen ways in Vietnamese and the gate used to key on the
 * spelling, so run `d638638b` was blocked on "900 nghìn" and "một trăm nghìn" while
 * the pack held the same two amounts as "900.000đ" and "100k". That turned the gate
 * into a style rule: to pass, the writer had to paste the pack's characters into a
 * voiceover. These tests pin the fold to VND, and pin the three things the fold must
 * NOT do.
 */
describe('money unit normalisation', () => {
  const gate = (script: string, packMarkdown: string) =>
    runDeterministicGate({ script, packMarkdown });

  /** Same amount, two spellings: one in the script, one in the pack. */
  const spelledDifferently = (inScript: string, inPack: string) =>
    gate(
      `Khoản đó rơi vào khoảng ${inScript} mỗi tháng.`,
      `# pack\n\nnguồn ghi rõ ${inPack} mỗi tháng.`,
    );

  test('an amount matches the pack whichever way each side spells it', () => {
    expect(spelledDifferently('900 nghìn', '900.000đ').violations).toEqual([]);
    expect(spelledDifferently('một trăm nghìn', '100k').violations).toEqual([]);
    expect(spelledDifferently('13 triệu', '13tr').violations).toEqual([]);
    expect(spelledDifferently('2 tỷ', '2.000.000.000 đồng').violations).toEqual([]);
  });

  test('and in the other direction — neither spelling is privileged', () => {
    expect(spelledDifferently('900.000đ', '900 nghìn').violations).toEqual([]);
    expect(spelledDifferently('100k', 'một trăm nghìn').violations).toEqual([]);
  });

  test('scaling happens after parseDigits, so 2,5 triệu is not 25 triệu', () => {
    // The whole safety argument for the fold. Collapsing these would let a
    // fabricated 2,5 triệu borrow its source from a real 25 triệu.
    const result = gate(
      'Tiền nhà của người đó là 2,5 triệu một tháng.',
      '# pack\n\nlương tháng của người đó là 25 triệu.',
    );
    expect(result.violations.map((v) => v.code)).toEqual(['NUMBER_UNSOURCED']);
  });

  test('dollars are not folded into đồng — the rate moves, the match would be invented', () => {
    const result = gate(
      'Người đó giữ 4000 đô trong tài khoản.',
      '# pack\n\nnguồn ghi 4.000đ phí chuyển và 100 triệu tiền gửi.',
    );
    expect(result.violations.map((v) => v.code)).toEqual(['NUMBER_UNSOURCED']);
    // Dollars still match dollars.
    expect(gate('Người đó giữ 4000 đô.', '# pack\n\nnguồn ghi 4000 usd.').violations).toEqual([]);
  });

  test('the short suffixes do not fire inside ordinary words', () => {
    expect(extractNumericClaims('Đi 3 km rồi mua 2 kg gạo, 5 kể cả phí.')).toEqual([]);
    expect(extractNumericClaims('Anh ấy trở lại sau 3 trận, mất 9 được 2 trăm.')).toEqual([]);
    const claims = extractNumericClaims('Trong 5 năm, tôi được 2 lần tăng lương, đến 3 tháng thì nghỉ.');
    expect(claims.map((c) => [c.value, c.unit])).toEqual([[5, 'năm'], [2, 'lần'], [3, 'tháng']]);
  });

  test('money in a short suffix is still never common knowledge', () => {
    const result = gate(
      'Thông thường mỗi món như vậy chỉ 100k một tháng.',
      '# pack\n\nKhông có con số nào ở đây.',
    );
    expect(result.violations.map((v) => v.code)).toEqual(['NUMBER_UNSOURCED']);
  });

  test('an amount that is nowhere in the pack is still unsourced', () => {
    const result = gate(
      'Số dư còn lại là 380.000 đồng vào cuối tháng.',
      '# pack\n\nnguồn chỉ nói về 25 triệu và 900k.',
    );
    expect(result.violations.map((v) => v.code)).toEqual(['NUMBER_UNSOURCED']);
  });
});

describe('proper noun extraction', () => {
  test('clause-initial capitals are not names, mid-sentence ones are', () => {
    // "Minh" opens its sentence here, so it is deliberately NOT a candidate —
    // orthography capitalises it either way. It is caught the moment it appears
    // mid-sentence, which any real script with a recurring character does.
    const found = extractProperNouns('Nhưng rồi mọi thứ đổi. Minh sống ở Sài Gòn.');
    expect(found.map((f) => f.name)).toEqual(['Sài Gòn']);
    expect(extractProperNouns('Chín giờ tối, Minh mở app ngân hàng.').map((f) => f.name))
      .toEqual(['Minh']);
  });
});

describe('audit fixture — run 7d626c50 vs pack 1c24954b', () => {
  const result = runDeterministicGate({
    script: auditScript,
    packMarkdown: auditPack,
    forbiddenNames: ['Hiếu', 'Hieu Nguyen'],
  });

  test('fails, and flags at least 12 unsourced numeric claims', () => {
    expect(result.passed).toBe(false);
    const numbers = result.violations.filter((v) => v.code === 'NUMBER_UNSOURCED');
    expect(numbers.length).toBeGreaterThanOrEqual(12);
  });

  test('flags the invented character "Minh"', () => {
    const names = result.violations.filter((v) => v.code === 'PROPER_NOUN_UNSOURCED');
    expect(names.some((v) => v.detail.includes('"Minh"'))).toBe(true);
  });
});

describe('a script that only uses pack facts', () => {
  const ledger: LedgerEntry[] = [
    {
      fact: 'nguyên tắc 25 lần chi phí năm',
      videoId: 'PJPhR58LBYA',
      quote: auditPack.slice(auditPack.indexOf('xin chào các anh chị'), auditPack.indexOf('xin chào các anh chị') + 120),
    },
  ];

  test('passes with zero violations', () => {
    const script = [
      'Có một câu hỏi đơn giản mà ít người trả lời được: tiền của bạn đang đi đâu.',
      'Nguồn dẫn ở đây nói về những nguyên tắc chi tiêu, không phải một công thức làm giàu.',
      'Việc bạn làm được sau bài này rất nhỏ: lấy thu nhập trừ các khoản bắt buộc.',
    ].join(' ');
    const result = runDeterministicGate({
      script,
      packMarkdown: auditPack,
      factsLedger: ledger,
      forbiddenNames: ['Hiếu'],
    });
    expect(result.violations).toEqual([]);
    expect(result.passed).toBe(true);
  });

  test('a ledger quote that is not in the pack is itself a violation', () => {
    const result = runDeterministicGate({
      script: 'Một câu trung tính.',
      packMarkdown: auditPack,
      factsLedger: [{ fact: 'bịa', quote: 'câu này không có trong pack' }],
    });
    expect(result.violations.map((v) => v.code)).toEqual(['LEDGER_QUOTE_UNGROUNDED']);
  });
});

describe('assumption-marker escape', () => {
  test('an unsourced number inside a marked hypothetical passes', () => {
    const result = runDeterministicGate({
      script: 'Giả sử lương bạn 30 triệu một tháng, phần bắt buộc đã chiếm bao nhiêu?',
      packMarkdown: '# pack\n\nKhông có con số nào ở đây.',
    });
    expect(result.passed).toBe(true);
  });

  test('the same number without a marker is a violation', () => {
    const result = runDeterministicGate({
      script: 'Lương bạn 30 triệu một tháng, phần bắt buộc đã chiếm bao nhiêu?',
      packMarkdown: '# pack\n\nKhông có con số nào ở đây.',
    });
    expect(result.violations.map((v) => v.code)).toContain('NUMBER_UNSOURCED');
  });

  test('a marked hypothetical still may not name a person', () => {
    const result = runDeterministicGate({
      script: 'Giả sử một người tên Hoàng Anh kiếm 30 triệu một tháng.',
      packMarkdown: '# pack\n\nKhông có tên nào ở đây.',
    });
    // The marker excuses the number; the invented biography is not excused by it —
    // the WRITE prompt forbids naming a hypothetical person, and check 2 sees the
    // name in a sentence the writer chose to mark.
    expect(result.violations.map((v) => v.code)).toEqual([]);
  });
});

describe('common-knowledge exemption', () => {
  const pack = '# pack\n\nKhông có con số nào ở đây.';
  const gate = (script: string) => runDeterministicGate({ script, packMarkdown: pack });

  test('everyday time spans pass without any hedging', () => {
    expect(gate('Quỹ dự phòng nên đủ cho 3 tới 6 tháng chi tiêu.').passed).toBe(true);
    expect(gate('Gói trả góp 0% trong 12 tháng nghe rất dễ chịu.').passed).toBe(true);
  });

  test('a longer convention passes only with a visible attribution', () => {
    expect(gate('Chuyên gia thường khuyên không vay quá 30 năm.').passed).toBe(true);
    expect(gate('Bạn không nên vay quá 30 năm.').violations.map((v) => v.code))
      .toContain('NUMBER_UNSOURCED');
  });

  test('money is never common knowledge, however it is worded', () => {
    const result = gate('Thông thường lương của một người như vậy là 25 triệu một tháng.');
    expect(result.violations.map((v) => v.code)).toContain('NUMBER_UNSOURCED');
  });

  test('an age is never common knowledge — that is what makes an invented case feel real', () => {
    const result = gate('Nhìn chung một người 28 tuổi sẽ nghĩ khác.');
    expect(result.violations.map((v) => v.code)).toContain('NUMBER_UNSOURCED');
  });

  test('a research multiple stays strict', () => {
    const result = gate('Người ta thường nói cần 25 lần chi phí một năm.');
    expect(result.violations.map((v) => v.code)).toContain('NUMBER_UNSOURCED');
  });

  test('a historical year stays strict — invented research is the thing this must stop', () => {
    const result = gate('Một nghiên cứu ở Mỹ năm 1994 đã tính ra con số đó.');
    expect(result.violations.map((v) => v.code)).toContain('NUMBER_UNSOURCED');
  });

  test('a decimal is a measurement, not a convention', () => {
    const result = gate('Thông thường người ta mất 2,5 năm cho việc đó.');
    expect(result.violations.map((v) => v.code)).toContain('NUMBER_UNSOURCED');
  });
});

describe('beat coverage', () => {
  const script = 'Câu mở đầu ở đây. Đoạn giữa nói chuyện khác. Câu kết đóng lại vấn đề.';

  test('every beat needs an anchor that is an exact substring', () => {
    const ok = runDeterministicGate({
      script,
      packMarkdown: '# pack',
      outline: outline(['mở', 'giữa', 'kết']),
      beatAnchors: ['Câu mở đầu ở đây', 'Đoạn giữa nói chuyện khác', 'Câu kết đóng lại vấn đề'],
    });
    expect(ok.passed).toBe(true);
  });

  test('a missing anchor is a violation (the script dropped a beat)', () => {
    const result = runDeterministicGate({
      script,
      packMarkdown: '# pack',
      outline: outline(['mở', 'giữa', 'kết']),
      beatAnchors: ['Câu mở đầu ở đây', 'Đoạn giữa nói chuyện khác'],
    });
    expect(result.violations.map((v) => v.code)).toEqual(['BEAT_ANCHOR_MISSING']);
  });

  test('a paraphrased anchor is a violation (self-report cannot be trusted)', () => {
    const result = runDeterministicGate({
      script,
      packMarkdown: '# pack',
      outline: outline(['mở', 'giữa']),
      beatAnchors: ['Câu mở đầu ở đây', 'đoạn giữa nói về chuyện khác'],
    });
    expect(result.violations.map((v) => v.code)).toEqual(['BEAT_ANCHOR_UNGROUNDED']);
  });
});

describe('coined labels', () => {
  test('three declared labels overflow the cap of two', () => {
    const script = 'mặt sàn lối sống. '.repeat(3) + 'chi tiêu danh tính. '.repeat(3) + 'quyền nhúc nhích. '.repeat(3);
    const result = runDeterministicGate({
      script,
      packMarkdown: '# pack',
      declaredCoinedLabels: ['mặt sàn lối sống', 'chi tiêu danh tính', 'quyền nhúc nhích'],
    });
    expect(result.violations.map((v) => v.code)).toContain('COINED_LABEL_OVERLOAD');
  });

  test('a quoted label repeated three times is detected without a declaration', () => {
    const script = 'Gọi nó là “vùng va chạm”. Cái “vùng va chạm” đó lớn dần. Rồi “vùng va chạm” biến mất.';
    expect(extractCoinedLabels(script).map((c) => c.label)).toEqual(['vùng va chạm']);
  });

  test('two labels are still allowed', () => {
    const result = runDeterministicGate({
      script: 'x',
      packMarkdown: '# pack',
      declaredCoinedLabels: ['nhãn một', 'nhãn hai'],
    });
    expect(result.passed).toBe(true);
  });
});

describe('word band and host identity', () => {
  test('out-of-band length fails', () => {
    const result = runDeterministicGate({
      script: 'ngắn quá',
      packMarkdown: '# pack',
      wordRange: { minWords: 800, maxWords: 1500 },
    });
    expect(result.violations.map((v) => v.code)).toEqual(['WORD_BAND']);
  });

  test('adopting the source host identity fails', () => {
    const result = runDeterministicGate({
      script: 'Xin chào, tôi là Hiếu, hôm nay chúng ta nói về tiền.',
      packMarkdown: '# pack',
      forbiddenNames: ['Hiếu'],
    });
    expect(result.violations.map((v) => v.code)).toContain('HOST_IDENTITY');
  });
});
