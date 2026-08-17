/**
 * Formula display label + rename — video title preferred over channel; rename only
 * touches `title`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FormulaArtifact } from '@writer-room/training-core';
import {
  formulaDisplayLabel,
  getFormula,
  listFormulas,
  renameFormula,
  saveFormula,
} from '../../src/training/storage.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wr-formula-rename-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function baseFormula(overrides: Partial<FormulaArtifact> & { id: string }): FormulaArtifact {
  return {
    status: 'TRIAL',
    origin: 'ANALYZED',
    version: 1,
    videoSnapshotId: 'v1',
    channelTitle: 'Anh Ba Tài Chính',
    videoTitle: 'Bất Kỳ Ai Làm Theo Cách Này Đều Sẽ GIÀU CÓ',
    title: 'Bất Kỳ Ai Làm Theo Cách Này Đều Sẽ GIÀU CÓ',
    rules: [{ id: 'rule-1', statement: 's', evidence: [{ segmentIds: ['s1'], quote: 'q' }] }],
    includedArtifacts: [],
    lineage: {},
    warnings: [],
    createdAt: '2026-08-10T00:00:00.000Z',
    ...overrides,
  };
}

describe('formulaDisplayLabel', () => {
  test('prefers title over videoTitle over channelTitle', () => {
    expect(
      formulaDisplayLabel(
        baseFormula({
          id: 'x',
          title: 'Tên đã đổi',
          videoTitle: 'Video gốc',
          channelTitle: 'Kênh',
        }),
      ),
    ).toBe('Tên đã đổi');
    expect(
      formulaDisplayLabel(
        baseFormula({
          id: 'x',
          title: undefined,
          videoTitle: 'Video gốc',
          channelTitle: 'Kênh',
        }),
      ),
    ).toBe('Video gốc');
    expect(
      formulaDisplayLabel(
        baseFormula({
          id: 'x',
          title: undefined,
          videoTitle: undefined,
          channelTitle: 'Kênh',
        }),
      ),
    ).toBe('Kênh');
  });

  test('COMPOUND uses genre when untitled', () => {
    expect(
      formulaDisplayLabel(
        baseFormula({
          id: 'c',
          origin: 'COMPOUND',
          genre: 'soi-tc',
          title: undefined,
          videoTitle: undefined,
          channelTitle: undefined,
        }),
      ),
    ).toBe('soi-tc');
  });
});

describe('renameFormula', () => {
  test('persists title and leaves videoTitle/channelTitle alone', async () => {
    await saveFormula(baseFormula({ id: 'f1' }), dir);
    const renamed = await renameFormula('f1', '  Formula Soi TC  ', dir);
    expect(renamed?.title).toBe('Formula Soi TC');
    expect(renamed?.videoTitle).toBe('Bất Kỳ Ai Làm Theo Cách Này Đều Sẽ GIÀU CÓ');
    expect(renamed?.channelTitle).toBe('Anh Ba Tài Chính');

    const list = await listFormulas(dir);
    expect(list[0]!.label).toBe('Formula Soi TC');
    expect(list[0]!.videoTitle).toBe('Bất Kỳ Ai Làm Theo Cách Này Đều Sẽ GIÀU CÓ');

    const again = await getFormula('f1', dir);
    expect(again?.title).toBe('Formula Soi TC');
  });

  test('rejects empty title', async () => {
    await saveFormula(baseFormula({ id: 'f1' }), dir);
    await expect(renameFormula('f1', '   ', dir)).rejects.toThrow(/rỗng/);
  });
});
