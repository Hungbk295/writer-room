import { describe, expect, test } from 'bun:test';
import { parseIso8601Duration } from '../src/adapters/data-api.ts';

describe('parseIso8601Duration', () => {
  test('parses hours minutes seconds', () => {
    expect(parseIso8601Duration('PT1H2M3S')).toBe(3723);
  });

  test('parses minutes only', () => {
    expect(parseIso8601Duration('PT8M')).toBe(480);
  });

  test('parses seconds with fraction', () => {
    expect(parseIso8601Duration('PT45.5S')).toBe(45.5);
  });

  test('returns null for invalid', () => {
    expect(parseIso8601Duration('P1D')).toBeNull();
    expect(parseIso8601Duration(null)).toBeNull();
  });
});
