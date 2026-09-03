/**
 * Persona pack loader (2A) — `null` for the two states that mean "no persona
 * pack" (absent file, empty file), and a re-thrown error for anything else, so
 * `dispatchWrite` can fail the run visibly instead of silently writing without
 * the narrator's identity. Decision: eng review 2026-09-02.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getApprovedPersonaPack, getPersonaPack } from '../../src/writer/persona-pack.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wr-persona-pack-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('getPersonaPack', () => {
  test('a missing file is null, not an error', async () => {
    expect(await getPersonaPack(dir)).toBeNull();
  });

  test('an empty (or whitespace-only) file is null, same as absent', async () => {
    mkdirSync(join(dir, 'writer'), { recursive: true });
    writeFileSync(join(dir, 'writer', 'persona-pack.md'), '   \n\n  ', 'utf8');
    expect(await getPersonaPack(dir)).toBeNull();
  });

  test('a read failure other than ENOENT is re-thrown, not swallowed as absence', async () => {
    // Stub a directory in place of the file: readFile on a directory fails
    // with EISDIR, which is exactly the "real problem, not an absence" case
    // this function must not silently treat as "no persona pack".
    mkdirSync(join(dir, 'writer', 'persona-pack.md'), { recursive: true });
    await expect(getPersonaPack(dir)).rejects.toThrow(/persona-pack\.md/);
  });
});

describe('getApprovedPersonaPack', () => {
  test('absent file → null', async () => {
    expect(await getApprovedPersonaPack(dir)).toBeNull();
  });

  test('zero APPROVED entries → null, exactly like an absent file', async () => {
    mkdirSync(join(dir, 'writer'), { recursive: true });
    writeFileSync(
      join(dir, 'writer', 'persona-pack.md'),
      [
        '# Persona Pack — chưa duyệt',
        '### 1.1 Một lập trường chưa duyệt',
        '**Lập trường kênh**: Với tôi, đây là một lựa chọn.',
      ].join('\n'),
      'utf8',
    );
    expect(await getApprovedPersonaPack(dir)).toBeNull();
  });

  test('a non-ENOENT read failure still propagates', async () => {
    mkdirSync(join(dir, 'writer', 'persona-pack.md'), { recursive: true });
    await expect(getApprovedPersonaPack(dir)).rejects.toThrow(/persona-pack\.md/);
  });

  test('only APPROVED entries survive, re-hashed against the filtered content', async () => {
    const markdown = [
      '# Persona Pack — test',
      '### 1.1 Đã duyệt — `[ĐÃ DUYỆT]`',
      '**Lập trường kênh**: Với tôi, giữ quyền đổi ý quan trọng hơn tối đa hóa lợi nhuận.',
      '### 1.2 Chờ duyệt — `[CHỜ CHỦ KÊNH DUYỆT]`',
      '**Lập trường kênh**: Tôi không tin bất động sản luôn an toàn hơn cổ phiếu.',
    ].join('\n');
    mkdirSync(join(dir, 'writer'), { recursive: true });
    writeFileSync(join(dir, 'writer', 'persona-pack.md'), markdown, 'utf8');

    const result = await getApprovedPersonaPack(dir);
    expect(result).not.toBeNull();
    expect(result!.markdown).toContain('Đã duyệt');
    expect(result!.markdown).not.toContain('Chờ duyệt');
    expect(result!.markdown).not.toContain('bất động sản');
  });
});
