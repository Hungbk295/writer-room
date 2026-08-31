import { describe, expect, test } from 'bun:test';
import {
  COMPETITOR_HOOK_TYPES,
  validateClarifyOutput,
  validateSuggestOutput,
} from '../../src/writer/hook-doi-thu.ts';

describe('validateClarifyOutput', () => {
  test('accepts 1–4 non-empty questions', () => {
    const ok = validateClarifyOutput({ questions: ['Ai đang xem?', 'Góc nào?'] });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.questions).toEqual(['Ai đang xem?', 'Góc nào?']);
  });

  test('rejects empty, too many, or blank items', () => {
    expect(validateClarifyOutput({ questions: [] }).ok).toBe(false);
    expect(validateClarifyOutput({ questions: ['a', 'b', 'c', 'd', 'e'] }).ok).toBe(false);
    expect(validateClarifyOutput({ questions: ['ok', '  '] }).ok).toBe(false);
    expect(validateClarifyOutput(null).ok).toBe(false);
  });
});

describe('validateSuggestOutput', () => {
  const hook = (i: number, type = 'direct-question') => ({
    id: `h${i}`,
    type,
    text: `Hook số ${i} cho title này.`,
  });

  test('accepts 3–5 typed hooks and fills typeLabel', () => {
    const ok = validateSuggestOutput({
      candidates: [hook(1), hook(2, 'crisis-by-hour'), hook(3, 'forked-paths')],
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.candidates).toHaveLength(3);
    expect(ok.candidates[1]!.typeLabel).toBe('Khủng hoảng cụ thể theo giờ');
  });

  test('assigns id when missing', () => {
    const ok = validateSuggestOutput({
      candidates: [
        { type: 'direct-question', text: 'Một' },
        { type: 'stat-open', text: 'Hai' },
        { type: 'street-paradox', text: 'Ba' },
      ],
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.candidates.map((c) => c.id)).toEqual(['h1', 'h2', 'h3']);
  });

  test('rejects unknown type, duplicate ids, wrong count', () => {
    expect(validateSuggestOutput({ candidates: [hook(1), hook(2)] }).ok).toBe(false);
    expect(validateSuggestOutput({
      candidates: [hook(1), hook(2), { id: 'h3', type: 'nope', text: 'x' }],
    }).ok).toBe(false);
    expect(validateSuggestOutput({
      candidates: [hook(1), hook(2), { ...hook(3), id: 'h1' }],
    }).ok).toBe(false);
  });

  test('known types cover the six competitor frames', () => {
    expect(COMPETITOR_HOOK_TYPES).toHaveLength(6);
  });
});
