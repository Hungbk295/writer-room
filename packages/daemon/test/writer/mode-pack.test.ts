/**
 * Mode pack loader/validator (SDD 006 §5). Same absence semantics as
 * `persona-pack.test.ts` (`null` for missing/empty, re-thrown for a real read
 * failure) plus the fail-closed heading check that persona packs don't have —
 * WRITE cannot run without a complete mode pack, so `validateModePack` must
 * name exactly what's missing.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getModePack, hashModePack, validateModePack } from '../../src/writer/mode-pack.ts';
import { WRITER_BEAT_MODES, WRITER_BEAT_TURNS } from '../../src/writer/video-plan.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wr-mode-pack-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Minimal fixture with all 12 required headings, no real quotes. */
function completeModePackMarkdown(): string {
  const modeSections = WRITER_BEAT_MODES.map((mode) => `## Mode: ${mode} — Tên\nNội dung.\n`);
  const turnSections = WRITER_BEAT_TURNS.map((turn) => `## Phép lật: ${turn} — Tên\nNội dung.\n`);
  return ['# Mode pack test fixture', '', ...modeSections, ...turnSections].join('\n');
}

describe('getModePack', () => {
  test('a missing file is null, not an error', async () => {
    expect(await getModePack(dir)).toBeNull();
  });

  test('an empty (or whitespace-only) file is null, same as absent', async () => {
    mkdirSync(join(dir, 'writer'), { recursive: true });
    writeFileSync(join(dir, 'writer', 'mode-pack.md'), '   \n\n  ', 'utf8');
    expect(await getModePack(dir)).toBeNull();
  });

  test('a read failure other than ENOENT is re-thrown, not swallowed as absence', async () => {
    mkdirSync(join(dir, 'writer', 'mode-pack.md'), { recursive: true });
    await expect(getModePack(dir)).rejects.toThrow(/mode-pack\.md/);
  });

  test('a present file returns path/hash/markdown matching hashModePack', async () => {
    mkdirSync(join(dir, 'writer'), { recursive: true });
    const markdown = completeModePackMarkdown();
    writeFileSync(join(dir, 'writer', 'mode-pack.md'), markdown, 'utf8');
    const pack = await getModePack(dir);
    expect(pack).not.toBeNull();
    expect(pack!.path).toBe('mode-pack.md');
    expect(pack!.markdown).toBe(markdown);
    expect(pack!.hash).toBe(hashModePack(markdown));
    expect(pack!.hash).toHaveLength(64);
  });
});

describe('validateModePack', () => {
  test('accepts a fixture with all 12 headings', () => {
    expect(validateModePack(completeModePackMarkdown())).toEqual({ ok: true });
  });

  test('accepts the real writer-room-data/writer/mode-pack.md (Lane A)', () => {
    // Resolve relative to the repo's writer-room-data, independent of cwd.
    const repoRoot = join(import.meta.dir, '..', '..', '..', '..');
    const realModePackPath = join(repoRoot, 'writer-room-data', 'writer', 'mode-pack.md');
    let markdown: string;
    try {
      markdown = readFileSync(realModePackPath, 'utf8');
    } catch {
      // Lane A's file is gitignored (writer-room-data trap) and may not be
      // present in every checkout — skip rather than fail when it's absent.
      return;
    }
    expect(validateModePack(markdown)).toEqual({ ok: true });
  });

  test('fail-closed: missing one Mode heading is reported by id', () => {
    const withoutCanh = completeModePackMarkdown().replace('## Mode: canh — Tên\nNội dung.\n', '');
    const result = validateModePack(withoutCanh);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missing).toContain('Mode: canh');
  });

  test('fail-closed: missing one Phép lật heading is reported by id', () => {
    const missingRealTurn = completeModePackMarkdown().replace('## Phép lật: doi-ten — Tên\nNội dung.\n', '');
    const result = validateModePack(missingRealTurn);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missing).toContain('Phép lật: doi-ten');
  });

  test('fail-closed: an empty file is missing all 12 headings', () => {
    const result = validateModePack('');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missing).toHaveLength(WRITER_BEAT_MODES.length + WRITER_BEAT_TURNS.length);
  });

  test('accepts a heading with an em dash suffix and extra spacing', () => {
    const markdown = '##  Mode:  canh — Cảnh (mở rộng)\nNội dung.\n'
      + WRITER_BEAT_MODES.filter((m) => m !== 'canh').map((mode) => `## Mode: ${mode} — Tên\n`).join('\n')
      + WRITER_BEAT_TURNS.map((turn) => `## Phép lật: ${turn} — Tên\n`).join('\n');
    expect(validateModePack(markdown)).toEqual({ ok: true });
  });
});
