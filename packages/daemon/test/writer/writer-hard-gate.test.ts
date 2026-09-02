import { describe, expect, test } from 'bun:test';
import type { AssertionBoundaryResult } from '../../src/writer/assertion-boundary.ts';
import type { GateResult } from '../../src/writer/deterministic-gate.ts';
import {
  combineWriterGateResults,
  routeEditorOutcome,
  validateTypedEditorReview,
  type TypedEditorDefect,
} from '../../src/writer/writer-hard-gate.ts';

const SCRIPT = 'Khoản lỗ gần 800 triệu cho thấy quyết định này có rủi ro.';
const CLEAN_DETERMINISTIC: GateResult = { passed: true, violations: [] };
const CLEAN_BOUNDARY: AssertionBoundaryResult = { passed: true, anchors: [], violations: [] };

function cleanCombined() {
  return combineWriterGateResults(CLEAN_DETERMINISTIC, CLEAN_BOUNDARY);
}

describe('combineWriterGateResults', () => {
  test('keeps validator sources typed and requires both results to be clean', () => {
    const deterministic: GateResult = {
      passed: false,
      violations: [{
        code: 'NUMBER_UNSOURCED',
        detail: '800 triệu is not grounded',
        quote: '800 triệu',
      }],
    };
    const boundary: AssertionBoundaryResult = {
      passed: false,
      anchors: [],
      violations: [{
        code: 'ASSERTION_CLAIM_REQUIRED',
        detail: 'FACT needs an authorized claim',
        quote: '800 triệu',
      }],
    };
    const result = combineWriterGateResults(deterministic, boundary);
    expect(result.passed).toBe(false);
    expect(result.violations.map((violation) => [violation.source, violation.code])).toEqual([
      ['DETERMINISTIC', 'NUMBER_UNSOURCED'],
      ['CLAIM_BOUNDARY', 'ASSERTION_CLAIM_REQUIRED'],
    ]);
  });
});

describe('validateTypedEditorReview', () => {
  test('accepts disjoint reading and claim-boundary defect codes', () => {
    const result = validateTypedEditorReview({
      defects: [
        {
          kind: 'READING_EXPERIENCE',
          code: 'PROGRESSION_FLAT',
          quote: 'quyết định này có rủi ro',
          severity: 'MEDIUM',
          note: 'Beat mới không làm lập luận tiến thêm.',
        },
        {
          kind: 'CLAIM_BOUNDARY',
          code: 'SPECIFIC_DRIFT',
          quote: 'Khoản lỗ gần 800 triệu',
          severity: 'HIGH',
          note: 'Con số này không khớp permission đã chọn.',
        },
      ],
    }, SCRIPT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.defects.map((defect) => defect.kind)).toEqual([
      'READING_EXPERIENCE',
      'CLAIM_BOUNDARY',
    ]);
  });

  test('rejects a code paired with the wrong discriminator', () => {
    const result = validateTypedEditorReview({
      defects: [{
        kind: 'READING_EXPERIENCE',
        code: 'SPECIFIC_DRIFT',
        quote: 'Khoản lỗ gần 800 triệu',
        severity: 'HIGH',
        note: 'Không được giấu claim defect dưới nhãn reading.',
      }],
    }, SCRIPT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('AGENT_SCHEMA');
  });

  test('requires every defect quote to be an exact script substring', () => {
    const result = validateTypedEditorReview({
      defects: [{
        kind: 'CLAIM_BOUNDARY',
        code: 'EMPIRICAL_CLAIM_UNAUTHORIZED',
        quote: 'một tỷ',
        severity: 'HIGH',
        note: 'Reviewer must quote the actual prose.',
      }],
    }, SCRIPT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe('AGENT_UNGROUNDED');
  });
});

describe('routeEditorOutcome', () => {
  const readingDefect: TypedEditorDefect = {
    kind: 'READING_EXPERIENCE',
    code: 'PROSE_DRY',
    quote: 'quyết định này có rủi ro',
    severity: 'MEDIUM',
    note: 'Câu đúng nhưng khô.',
  };
  const claimDefect: TypedEditorDefect = {
    kind: 'CLAIM_BOUNDARY',
    code: 'SPECIFIC_DRIFT',
    quote: 'Khoản lỗ gần 800 triệu',
    severity: 'HIGH',
    note: 'Specific drift cần semantic re-review.',
  };

  test('routes a clean result to CLEAN and code/reading failures to one-shot repair', () => {
    expect(routeEditorOutcome(cleanCombined(), [])).toBe('CLEAN');
    expect(routeEditorOutcome(cleanCombined(), [readingDefect])).toBe('AUTO_REPAIR');

    const dirtyCodeGate = combineWriterGateResults(
      {
        passed: false,
        violations: [{ code: 'NUMBER_UNSOURCED', detail: 'amount is missing' }],
      },
      CLEAN_BOUNDARY,
    );
    expect(routeEditorOutcome(dirtyCodeGate, [])).toBe('AUTO_REPAIR');
  });

  test('routes every CLAIM_BOUNDARY editor defect directly to FAILED_GATE', () => {
    expect(routeEditorOutcome(cleanCombined(), [claimDefect])).toBe('FAILED_GATE');
    expect(routeEditorOutcome(cleanCombined(), [readingDefect, claimDefect])).toBe('FAILED_GATE');
  });
});
