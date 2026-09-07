/**
 * Human pack loader/validator (SDD 007 §2). Same absence semantics as
 * `mode-pack.test.ts`/`persona-pack.test.ts` (`null` for missing/empty,
 * re-thrown for a real read failure) plus the fail-closed heading check —
 * a PRESENT file missing a gesture heading is a configuration error, but
 * unlike the mode pack, an ABSENT file is a normal, fully-supported state.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getHumanPack, hashHumanPack, HUMAN_PACK_GESTURE_IDS, validateHumanPack } from '../../src/writer/human-pack.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wr-human-pack-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Minimal fixture with all 8 required headings, no real quotes. */
function completeHumanPackMarkdown(): string {
  const sections = HUMAN_PACK_GESTURE_IDS.map((id) => `## Cử chỉ: ${id} — Tên\nNội dung.\n`);
  return ['# Human pack test fixture', '', ...sections].join('\n');
}

describe('getHumanPack', () => {
  test('a missing file is null, not an error', async () => {
    expect(await getHumanPack(dir)).toBeNull();
  });

  test('an empty (or whitespace-only) file is null, same as absent', async () => {
    mkdirSync(join(dir, 'writer'), { recursive: true });
    writeFileSync(join(dir, 'writer', 'human-pack.md'), '   \n\n  ', 'utf8');
    expect(await getHumanPack(dir)).toBeNull();
  });

  test('a read failure other than ENOENT is re-thrown, not swallowed as absence', async () => {
    mkdirSync(join(dir, 'writer', 'human-pack.md'), { recursive: true });
    await expect(getHumanPack(dir)).rejects.toThrow(/human-pack\.md/);
  });

  test('a present file returns path/hash/markdown matching hashHumanPack', async () => {
    mkdirSync(join(dir, 'writer'), { recursive: true });
    const markdown = completeHumanPackMarkdown();
    writeFileSync(join(dir, 'writer', 'human-pack.md'), markdown, 'utf8');
    const pack = await getHumanPack(dir);
    expect(pack).not.toBeNull();
    expect(pack!.path).toBe('human-pack.md');
    expect(pack!.markdown).toBe(markdown);
    expect(pack!.hash).toBe(hashHumanPack(markdown));
    expect(pack!.hash).toHaveLength(64);
  });
});

describe('validateHumanPack', () => {
  test('accepts a fixture with all 8 headings', () => {
    expect(validateHumanPack(completeHumanPackMarkdown())).toEqual({ ok: true });
  });

  test('accepts the real writer-room-data/writer/human-pack.md (Lane H), if present', () => {
    // Resolve relative to the repo's writer-room-data, independent of cwd.
    const repoRoot = join(import.meta.dir, '..', '..', '..', '..');
    const realHumanPackPath = join(repoRoot, 'writer-room-data', 'writer', 'human-pack.md');
    let markdown: string;
    try {
      markdown = readFileSync(realHumanPackPath, 'utf8');
    } catch {
      // Lane H's file is gitignored (writer-room-data trap) and may not be
      // present in every checkout — skip rather than fail when it's absent.
      return;
    }
    expect(validateHumanPack(markdown)).toEqual({ ok: true });
  });

  test('fail-closed: missing one Cử chỉ heading is reported by id', () => {
    const withoutKhongBiet = completeHumanPackMarkdown()
      .replace('## Cử chỉ: khong-biet — Tên\nNội dung.\n', '');
    const result = validateHumanPack(withoutKhongBiet);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missing).toContain('Cử chỉ: khong-biet');
  });

  test('fail-closed: an empty file is missing all 8 headings', () => {
    const result = validateHumanPack('');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missing).toHaveLength(HUMAN_PACK_GESTURE_IDS.length);
  });

  test('accepts a heading with an em dash suffix and extra spacing', () => {
    const markdown = '##  Cử chỉ:  lech-chuan — Lệch chuẩn\nNội dung.\n'
      + HUMAN_PACK_GESTURE_IDS.filter((id) => id !== 'lech-chuan')
        .map((id) => `## Cử chỉ: ${id} — Tên\n`).join('\n');
    expect(validateHumanPack(markdown)).toEqual({ ok: true });
  });
});
