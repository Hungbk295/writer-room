import { describe, expect, test } from 'bun:test';
import {
  buildClaimBoundaryReviewIndex,
  parsePersonaRegistry,
  validateAssertionBoundary,
  type AssertionAnchor,
} from '../../src/writer/assertion-boundary.ts';
import type { AuthorizedClaimPermission } from '../../src/writer/research-map.ts';
import { DISPUTED_CAVEAT_FIXTURES } from './disputed-caveat-fixtures.ts';

const PERSONA = [
  '# Persona Pack — test',
  '',
  '### 1.1 Quyền đổi ý — `[ĐÃ DUYỆT]`',
  '',
  '**Chuẩn chung**: tối đa hóa lợi nhuận.',
  '',
  '**Lập trường kênh**: Với tôi, giữ quyền đổi ý quan trọng hơn tối đa hóa lợi nhuận. Tôi chọn quỹ dự phòng 12 tháng.',
  '',
  '> nguồn gốc có nhắc 70% nhưng không thuộc lập trường được phép',
  '',
  '### 1.2 Bất động sản — `[CHỜ CHỦ KÊNH DUYỆT]`',
  '',
  '**Lập trường kênh**: Tôi không tin bất động sản luôn an toàn hơn cổ phiếu.',
  '',
  '> quote nguồn',
  '',
  '### A1. Mua nhà sớm rồi phải bán',
  '',
  '**Bản gốc**: host thật từng mất 500 triệu tại Hà Nội.',
  '',
  '**Phóng tác** (3-5 câu): "Tôi từng vội mua một căn nhà nhỏ rồi phải bán lại. Đó là bài học về chi phí cơ hội."',
  '',
  '**Ghi chú khi dùng**: không thêm địa điểm hoặc số tiền cụ thể.',
  '',
  '---',
  '',
  '## 3. Từ vựng cá nhân',
  '',
  '> quote nguồn toàn cục nhắc 900 triệu tại Đà Nẵng',
].join('\n');

const REGISTRY = parsePersonaRegistry(PERSONA);

const PERMISSIONS: AuthorizedClaimPermission[] = [
  {
    claimId: 'claim-buffer',
    text: '70% hộ gia đình trong mẫu có quỹ dự phòng.',
    status: 'ATTESTED',
    caveats: [],
    evidenceIds: ['e-buffer'],
    quotes: ['Khảo sát ghi nhận 70% hộ gia đình trong mẫu có quỹ dự phòng.'],
  },
  {
    claimId: 'claim-disputed',
    text: 'Một quan hệ còn tranh cãi.',
    status: 'DISPUTED',
    caveats: ['hai nguồn không thống nhất'],
    evidenceIds: ['e-disputed'],
    quotes: ['Hai nguồn mô tả quan hệ này theo hướng trái ngược.'],
  },
];

function check(
  script: string,
  assertionAnchors: AssertionAnchor[],
  permissions: readonly AuthorizedClaimPermission[] = PERMISSIONS,
) {
  return validateAssertionBoundary({
    script,
    assertionAnchors,
    permissions,
    personaRegistry: REGISTRY,
    pinnedPersonaPackHash: REGISTRY.hash,
  });
}

describe('parsePersonaRegistry', () => {
  test('extracts only channel-owned stance/phóng tác text and preserves approval state', () => {
    expect(REGISTRY.violations).toEqual([]);
    expect(REGISTRY.entries.map((entry) => [entry.id, entry.kind, entry.status])).toEqual([
      ['stance-1.1', 'STANCE', 'APPROVED'],
      ['stance-1.2', 'STANCE', 'PENDING'],
      ['experience-A1', 'PERSONA_EXPERIENCE', 'APPROVED'],
    ]);
    const experience = REGISTRY.entries.find((entry) => entry.id === 'experience-A1')!;
    expect(experience.allowedText).toContain('Tôi từng vội mua');
    expect(experience.allowedText).not.toContain('500 triệu');
    expect(experience.allowedText).not.toContain('Hà Nội');
    expect(experience.guardrails).toContain('không thêm địa điểm');
    expect(experience.guardrails).not.toContain('900 triệu');
  });

  test('an unmarked stance is still pending; approval must be explicit', () => {
    const registry = parsePersonaRegistry([
      '### 1.9 Một stance chưa gắn trạng thái',
      '**Lập trường kênh**: Với tôi, đây là một lựa chọn.',
      '> quote nguồn',
    ].join('\n'));
    expect(registry.entries[0]!.status).toBe('PENDING');
  });

  test('makes a duplicated Persona ID ineligible everywhere it could grant permission', () => {
    const registry = parsePersonaRegistry([
      '### 1.7 Quyền lựa chọn — `[ĐÃ DUYỆT]`',
      '**Lập trường kênh**: Với tôi, giữ quyền lựa chọn là ưu tiên.',
      '',
      '### 1.7 Trùng mã — `[ĐÃ DUYỆT]`',
      '**Lập trường kênh**: Với tôi, lợi nhuận là ưu tiên.',
    ].join('\n'));
    expect(registry.violations).toEqual([{
      code: 'PERSONA_DUPLICATE_ID',
      detail: 'duplicate persona entry "stance-1.7"; the colliding ID is ineligible',
      entryId: 'stance-1.7',
    }]);
    expect(registry.entries.find((entry) => entry.id === 'stance-1.7')?.status).toBe('REJECTED');

    const script = 'Với tôi, giữ quyền lựa chọn là ưu tiên.';
    const result = validateAssertionBoundary({
      script,
      assertionAnchors: [{
        id: 'a-duplicate-stance',
        quote: script,
        kind: 'STANCE',
        stanceId: 'stance-1.7',
      }],
      permissions: [],
      personaRegistry: registry,
      pinnedPersonaPackHash: registry.hash,
    });
    expect(result.passed).toBe(false);
    expect(result.violations.map((item) => item.code)).toContain('ASSERTION_PERSONA_PENDING');
    expect(buildClaimBoundaryReviewIndex({ permissions: [], personaRegistry: registry }).stances).toEqual([]);
  });
});

describe('ADR-004 minimum fixtures', () => {
  test('passes an approved narrator STANCE without a research claim', () => {
    const script = 'Với tôi, giữ quyền đổi ý quan trọng hơn tối đa hóa lợi nhuận.';
    const result = check(script, [{
      id: 'a-stance',
      quote: script,
      kind: 'STANCE',
      stanceId: 'stance-1.1',
    }]);
    expect(result.passed).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test('a stance marker never overrides a descriptive statistic', () => {
    const script = 'Theo tôi, 70% người Việt không có quỹ dự phòng.';
    const result = check(script, [{
      id: 'a-disguised-fact',
      quote: script,
      kind: 'STANCE',
      stanceId: 'stance-1.1',
    }]);
    expect(result.passed).toBe(false);
    expect(result.anchors[0]!.effectiveKind).toBe('FACT');
    expect(result.violations.map((item) => item.code)).toContain('ASSERTION_KIND_MISMATCH');
    expect(result.violations.map((item) => item.code)).toContain('ASSERTION_CLAIM_REQUIRED');
  });

  test('catches an empirical comparison with no number or source entity', () => {
    const script = 'Tôi tin bất động sản luôn an toàn hơn cổ phiếu.';
    const result = check(script, [{
      id: 'a-comparison',
      quote: script,
      kind: 'STANCE',
      stanceId: 'stance-1.1',
    }]);
    expect(result.passed).toBe(false);
    expect(result.anchors[0]!.effectiveKind).toBe('FACT');
    expect(result.violations.map((item) => item.code)).toContain('ASSERTION_CLAIM_REQUIRED');
  });

  test('rejects first-person history without an approved Persona experience ID', () => {
    const script = 'Tôi từng mất 500 triệu vì quyết định này.';
    const result = check(script, [{ id: 'a-history', quote: script, kind: 'PERSONA_EXPERIENCE' }]);
    expect(result.passed).toBe(false);
    expect(result.violations.map((item) => item.code)).toContain('ASSERTION_PERSONA_REQUIRED');
  });

  test('passes a visibly marked, anonymous hypothetical', () => {
    const script = 'Giả sử bạn có 100 triệu để chia thành hai khoản.';
    const result = check(script, [{ id: 'a-hypo', quote: script, kind: 'HYPOTHETICAL' }]);
    expect(result.passed).toBe(true);
  });

  test('passes a FACT linked to a non-rejected claim', () => {
    const script = 'Theo dữ liệu trong pack, 70% hộ gia đình có quỹ dự phòng.';
    const result = check(script, [{
      id: 'a-fact',
      quote: script,
      kind: 'FACT',
      claimIds: ['claim-buffer'],
    }]);
    expect(result.passed).toBe(true);
  });

  test('does not authorize a non-rejected claim that factual beats did not select', () => {
    const script = 'Theo dữ liệu trong pack, 70% hộ gia đình có quỹ dự phòng.';
    const result = check(script, [{
      id: 'a-unselected',
      quote: script,
      kind: 'FACT',
      claimIds: ['claim-unselected'],
    }]);
    expect(result.passed).toBe(false);
    expect(result.violations.map((item) => item.code)).toContain('ASSERTION_CLAIM_UNKNOWN');
  });

  test('allows factual paraphrase wording but rejects protected amount drift', () => {
    const permissions: AuthorizedClaimPermission[] = [{
      claimId: 'claim-loss',
      text: 'Có người lỗ gần 800 triệu chỉ trong một năm.',
      status: 'ATTESTED',
      caveats: [],
      evidenceIds: ['e-loss'],
      quotes: ['năm ngoái tôi lỗ gần 800 triệu'],
    }];
    const preserved = 'Có người lỗ gần 800 triệu chỉ trong một năm.';
    const preservedResult = check(preserved, [{
      id: 'a-loss-preserved',
      quote: preserved,
      kind: 'FACT',
      claimIds: ['claim-loss'],
    }], permissions);
    expect(preservedResult.passed).toBe(true);

    const drifted = 'Có người mất gần một tỷ chỉ trong một năm.';
    const driftedResult = check(drifted, [{
      id: 'a-loss-drifted',
      quote: drifted,
      kind: 'FACT',
      claimIds: ['claim-loss'],
    }], permissions);
    expect(driftedResult.passed).toBe(false);
    expect(driftedResult.violations.map((item) => item.code)).toContain(
      'ASSERTION_SPECIFIC_UNAUTHORIZED',
    );
  });
});

describe('persona and metadata hard gates', () => {
  test('allows an approved numeric policy threshold but not a descriptive statistic', () => {
    const script = 'Tôi chọn quỹ dự phòng 12 tháng.';
    const result = check(script, [{
      id: 'a-policy',
      quote: script,
      kind: 'STANCE',
      stanceId: 'stance-1.1',
    }]);
    expect(result.passed).toBe(true);
    expect(result.anchors[0]!.effectiveKind).toBe('STANCE');
  });

  test('file presence does not approve a pending stance entry', () => {
    const script = 'Tôi không tin bất động sản luôn an toàn hơn cổ phiếu.';
    const result = check(script, [{
      id: 'a-pending',
      quote: script,
      kind: 'STANCE',
      stanceId: 'stance-1.2',
    }]);
    expect(result.passed).toBe(false);
    // The empirical comparison is factual first; the pending stance cannot be
    // used as provenance to downgrade it.
    expect(result.anchors[0]!.effectiveKind).toBe('FACT');
  });

  test('does not legalize a forbidden Bản gốc detail through an experience ID', () => {
    const script = 'Tôi từng mất 500 triệu vì mua nhà.';
    const result = check(script, [{
      id: 'a-original-detail',
      quote: script,
      kind: 'PERSONA_EXPERIENCE',
      personaEntryId: 'experience-A1',
    }]);
    expect(result.passed).toBe(false);
    expect(result.violations.map((item) => item.code)).toContain('ASSERTION_PERSONA_DETAIL_UNGROUNDED');
  });

  test('allows the adapted experience without importing original identity detail', () => {
    const script = 'Tôi từng vội mua một căn nhà nhỏ rồi phải bán lại.';
    const result = check(script, [{
      id: 'a-adapted',
      quote: script,
      kind: 'PERSONA_EXPERIENCE',
      personaEntryId: 'experience-A1',
    }]);
    expect(result.passed).toBe(true);
  });

  test('rejects a named hypothetical even though its number is visibly hypothetical', () => {
    const script = 'Giả sử Hoàng Anh có 100 triệu để đầu tư.';
    const result = check(script, [{ id: 'a-named-hypo', quote: script, kind: 'HYPOTHETICAL' }]);
    expect(result.passed).toBe(false);
    expect(result.violations.map((item) => item.code)).toContain('ASSERTION_HYPOTHETICAL_NAMED');
  });

  test('requires visible caveat language for a DISPUTED claim', () => {
    const script = 'Nghiên cứu này kết luận quan hệ đó là chắc chắn.';
    const result = check(script, [{
      id: 'a-disputed',
      quote: script,
      kind: 'FACT',
      claimIds: ['claim-disputed'],
    }]);
    expect(result.passed).toBe(false);
    expect(result.violations.map((item) => item.code)).toContain('ASSERTION_DISPUTED_UNQUALIFIED');
  });

  test('uses the shared narrow caveat registry for DISPUTED assertion permission', () => {
    for (const fixture of DISPUTED_CAVEAT_FIXTURES) {
      const result = check(fixture.text, [{
        id: 'a-disputed-registry',
        quote: fixture.text,
        kind: 'FACT',
        claimIds: ['claim-disputed'],
      }]);
      expect({ text: fixture.text, passed: result.passed }).toEqual({
        text: fixture.text,
        passed: fixture.accepted,
      });
      if (!fixture.accepted) {
        expect(result.violations.map((item) => item.code)).toContain('ASSERTION_DISPUTED_UNQUALIFIED');
      }
    }
  });
});

describe('anchor completeness and reviewer index', () => {
  test('scans factual prose even when its planning beat was declared NARRATIVE', () => {
    const script = 'Đây chỉ là nhịp chuyển cảnh, nhưng 70% người đã đổi quyết định.';
    const result = check(script, []);
    expect(result.passed).toBe(false);
    expect(result.violations.map((item) => item.code)).toContain('ASSERTION_UNANCHORED');
  });

  test('does not let an omitted anchor hide single-word protected money', () => {
    const script = 'Có người mất gần một tỷ chỉ trong một năm.';
    const result = check(script, []);
    expect(result.passed).toBe(false);
    expect(result.violations).toContainEqual(expect.objectContaining({
      code: 'ASSERTION_UNANCHORED',
      quote: 'một tỷ',
    }));
  });

  test('does not let a stance marker downgrade single-word protected money', () => {
    const script = 'Theo tôi, mất một tỷ là chuyện bình thường.';
    const result = check(script, [{
      id: 'a-money-stance',
      quote: script,
      kind: 'STANCE',
      stanceId: 'stance-1.1',
    }]);
    expect(result.passed).toBe(false);
    expect(result.violations.map((item) => item.code)).toContain('ASSERTION_KIND_MISMATCH');
  });

  test('scans the whole script and rejects a protected claim omitted from anchors', () => {
    const stance = 'Với tôi, giữ quyền đổi ý quan trọng hơn tối đa hóa lợi nhuận.';
    const script = `${stance} Nhưng 70% hộ gia đình không có quỹ dự phòng.`;
    const result = check(script, [{
      id: 'a-only-stance',
      quote: stance,
      kind: 'STANCE',
      stanceId: 'stance-1.1',
    }]);
    expect(result.passed).toBe(false);
    expect(result.violations.map((item) => item.code)).toContain('ASSERTION_UNANCHORED');
  });

  test('rejects an exact quote that is repeated and therefore ambiguous', () => {
    const repeated = 'Giả sử bạn có 100 triệu.';
    const result = check(`${repeated} ${repeated}`, [{
      id: 'a-repeat',
      quote: repeated,
      kind: 'HYPOTHETICAL',
    }]);
    expect(result.passed).toBe(false);
    expect(result.violations.map((item) => item.code)).toContain('ASSERTION_QUOTE_AMBIGUOUS');
  });

  test('review index exposes only non-rejected claims and approved persona material', () => {
    const index = buildClaimBoundaryReviewIndex({ permissions: PERMISSIONS, personaRegistry: REGISTRY });
    expect(index.claims.map((claim) => claim.claimId)).toEqual(['claim-buffer', 'claim-disputed']);
    expect(index.claims).toEqual(PERMISSIONS);
    expect(index.stances.map((entry) => entry.id)).toEqual(['stance-1.1']);
    expect(index.experiences.map((entry) => entry.id)).toEqual(['experience-A1']);
    expect(JSON.stringify(index)).not.toContain('500 triệu');
    expect(JSON.stringify(index)).not.toContain('Hà Nội');
  });
});
