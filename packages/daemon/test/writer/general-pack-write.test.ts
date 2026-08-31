/**
 * General pack write-side (General Pack MCP backing logic): grounding checks,
 * staging, and commit. The read side (list/get/hash) already has coverage via
 * the MCP's own consumers; this file covers what's new.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commitGeneralPack,
  getGeneralPack,
  quoteIsGrounded,
  readStagingState,
  stageEntry,
  stageTasteDna,
  validateGeneralPackEntryDraft,
  validateTasteDnaDraft,
  type GeneralPackEntryDraft,
} from '../../src/writer/general-pack.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wr-general-pack-write-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const TRANSCRIPT_A = 'thường thì những người chuyên gia họ sẽ khuyên   là phải có 6 tháng nhưng mà tôi thì tôi theo 1 năm';
const TRANSCRIPT_B = 'ví dụ mỗi khi mà tôi hỏi ai đó về bức tranh giàu có thì họ hay nói có biệt thự có xe hơi';
const TRANSCRIPT_C = 'ban đầu tôi dự định gói gọn trong một bài nhưng mà nói tới đây thì đã khá dài rồi';

describe('quoteIsGrounded', () => {
  test('matches on whitespace-normalized substring, case-sensitive', () => {
    expect(quoteIsGrounded('tôi thì tôi theo 1 năm', TRANSCRIPT_A)).toBe(true);
    expect(quoteIsGrounded('tôi   thì tôi theo 1 năm', TRANSCRIPT_A)).toBe(true); // whitespace runs collapse
    expect(quoteIsGrounded('Tôi thì tôi theo 1 năm', TRANSCRIPT_A)).toBe(false); // no case-folding
    expect(quoteIsGrounded('tôi thì tôi theo 2 năm', TRANSCRIPT_A)).toBe(false); // not verbatim
    expect(quoteIsGrounded('', TRANSCRIPT_A)).toBe(false);
  });
});

describe('validateTasteDnaDraft', () => {
  const sourceVideoIds = ['A', 'B', 'C'];
  const transcripts = { A: TRANSCRIPT_A, B: TRANSCRIPT_B, C: TRANSCRIPT_C };

  function principles(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      title: `Nguyên tắc ${i + 1}`,
      note: 'mô tả',
      quotes: [
        { videoId: 'A', text: 'tôi thì tôi theo 1 năm' },
        { videoId: 'B', text: 'có biệt thự có xe hơi' },
      ],
    }));
  }

  test('ok when 5-8 principles, every quote grounded, cross-video', () => {
    const result = validateTasteDnaDraft(principles(5), sourceVideoIds, transcripts);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.quoteCharRatio).toBeGreaterThan(0);
  });

  test('rejects fewer than 5 or more than 8 principles', () => {
    expect(validateTasteDnaDraft(principles(4), sourceVideoIds, transcripts).ok).toBe(false);
    expect(validateTasteDnaDraft(principles(9), sourceVideoIds, transcripts).ok).toBe(false);
  });

  test('flags a quote attributed to the wrong video even if the text is real', () => {
    const drafted = principles(5);
    drafted[0]!.quotes = [{ videoId: 'A', text: 'có biệt thự có xe hơi' }]; // real quote, wrong videoId
    const result = validateTasteDnaDraft(drafted, sourceVideoIds, transcripts);
    expect(result.ok).toBe(false);
    expect(result.violations[0]!.reason).toMatch(/substring/);
  });

  test('warns SINGLE_SOURCE when a principle only cites one video', () => {
    const drafted = principles(5);
    drafted[0]!.quotes = [{ videoId: 'A', text: 'tôi thì tôi theo 1 năm' }];
    const result = validateTasteDnaDraft(drafted, sourceVideoIds, transcripts);
    expect(result.warnings.some((w) => w.reason === 'SINGLE_SOURCE')).toBe(true);
  });

  test('rejects fewer than 3 source videos', () => {
    expect(validateTasteDnaDraft(principles(5), ['A'], transcripts).ok).toBe(false);
  });
});

function validEntry(overrides: Partial<GeneralPackEntryDraft> = {}): GeneralPackEntryDraft {
  return {
    videoId: 'A',
    title: 'Phần 1',
    hook: { quote: 'thường thì những người chuyên gia họ sẽ khuyên', debt: 'món nợ' },
    beats: [
      { beat: 'Beat 1', quotes: ['là phải có 6 tháng'], newInformation: 'cái mới 1' },
      { beat: 'Beat 2', quotes: ['tôi thì tôi theo 1 năm'], newInformation: 'cái mới 2' },
    ],
    examples: [{ text: 'ví dụ 1 năm', tag: 'kinh nghiệm host' }],
    payoff: { quote: 'tôi theo 1 năm', note: 'trả nợ' },
    boundary: { quote: 'nhưng mà tôi thì', note: 'ranh giới' },
    ...overrides,
  };
}

describe('validateGeneralPackEntryDraft', () => {
  test('ok when every field is grounded and shape is valid', () => {
    const result = validateGeneralPackEntryDraft(validEntry(), TRANSCRIPT_A);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test('rejects an ungrounded quote', () => {
    const draft = validEntry({ hook: { quote: 'câu này không có trong transcript', debt: 'x' } });
    const result = validateGeneralPackEntryDraft(draft, TRANSCRIPT_A);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.field === 'hook.quote')).toBe(true);
  });

  test('rejects an example tag outside the fixed 11-tag list', () => {
    const draft = validEntry({ examples: [{ text: 'x', tag: 'tag bịa ra' as never }] });
    const result = validateGeneralPackEntryDraft(draft, TRANSCRIPT_A);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.field === 'examples.tag')).toBe(true);
  });

  test('rejects fewer than 2 or more than 8 beats', () => {
    expect(validateGeneralPackEntryDraft(validEntry({ beats: [] }), TRANSCRIPT_A).ok).toBe(false);
  });

  test('requires a boundary quote — cannot be inferred from silence', () => {
    const draft = validEntry({ boundary: { quote: '', note: 'ranh giới' } });
    const result = validateGeneralPackEntryDraft(draft, TRANSCRIPT_A);
    expect(result.ok).toBe(false);
    expect(result.violations.some((v) => v.field === 'boundary.quote')).toBe(true);
  });
});

describe('staging + commit round trip', () => {
  test('stageEntry writes even a failing draft, so a reviewer can see what broke', async () => {
    const bad = validEntry({ hook: { quote: 'không có thật', debt: 'x' } });
    const result = await stageEntry('test-channel', bad, TRANSCRIPT_A, dir);
    expect(result.staged).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);

    const state = await readStagingState('test-channel', dir);
    expect(state.entries['A']).toBeDefined();
    expect(state.entries['A']!.validation.ok).toBe(false);
  });

  test('commitGeneralPack refuses an entry that failed validation', async () => {
    const bad = validEntry({ hook: { quote: 'không có thật', debt: 'x' } });
    await stageEntry('test-channel', bad, TRANSCRIPT_A, dir);
    await expect(
      commitGeneralPack('test-channel', { includeTasteDna: false, videoIds: ['A'], reviewerNote: 'đã soi' }, dir),
    ).rejects.toThrow(/chưa validate ok/);
  });

  test('commitGeneralPack refuses without a reviewer note', async () => {
    await stageEntry('test-channel', validEntry(), TRANSCRIPT_A, dir);
    await expect(
      commitGeneralPack('test-channel', { includeTasteDna: false, videoIds: ['A'], reviewerNote: '' }, dir),
    ).rejects.toThrow(/reviewerNote/);
  });

  test('commits a valid staged entry into a new channel file, pins version 1, clears staging', async () => {
    await stageEntry('test-channel', validEntry(), TRANSCRIPT_A, dir);
    const result = await commitGeneralPack(
      'test-channel',
      { includeTasteDna: false, videoIds: ['A'], reviewerNote: 'đã soi tag + ranh giới' },
      dir,
    );
    expect(result.committed).toBe(true);
    expect(result.newVersion).toBe(1);
    expect(result.previousHash).toBeNull();

    const pack = await getGeneralPack('test-channel.md', dir);
    expect(pack).not.toBeNull();
    expect(pack!.hash).toBe(result.newHash);
    expect(pack!.markdown).toContain('<!-- video: A -->');
    expect(pack!.markdown).toContain('tôi theo 1 năm');

    const stateAfter = await readStagingState('test-channel', dir);
    expect(stateAfter.entries['A']).toBeUndefined();
  });

  test('committing TASTE DNA and an entry together bumps version and merges both sections', async () => {
    const principles = Array.from({ length: 5 }, (_, i) => ({
      title: `Nguyên tắc ${i + 1}`,
      note: 'mô tả',
      quotes: [
        { videoId: 'A', text: 'tôi thì tôi theo 1 năm' },
        { videoId: 'B', text: 'có biệt thự có xe hơi' },
      ],
    }));
    await stageTasteDna('test-channel', ['A', 'B', 'C'], principles, { A: TRANSCRIPT_A, B: TRANSCRIPT_B, C: TRANSCRIPT_C }, dir);
    await stageEntry('test-channel', validEntry(), TRANSCRIPT_A, dir);

    const result = await commitGeneralPack(
      'test-channel',
      { includeTasteDna: true, videoIds: ['A'], reviewerNote: 'đã soi' },
      dir,
    );
    expect(result.committed).toBe(true);

    const pack = await getGeneralPack('test-channel.md', dir);
    expect(pack!.markdown).toContain('<!-- taste-dna -->');
    expect(pack!.markdown).toContain('<!-- video: A -->');
  });

  test('re-committing a second entry preserves the first entry section untouched', async () => {
    await stageEntry('test-channel', validEntry(), TRANSCRIPT_A, dir);
    await commitGeneralPack('test-channel', { includeTasteDna: false, videoIds: ['A'], reviewerNote: 'r1' }, dir);

    await stageEntry('test-channel', validEntry({ videoId: 'B' }), TRANSCRIPT_A, dir);
    const result = await commitGeneralPack('test-channel', { includeTasteDna: false, videoIds: ['B'], reviewerNote: 'r2' }, dir);
    expect(result.newVersion).toBe(2);

    const pack = await getGeneralPack('test-channel.md', dir);
    expect(pack!.markdown).toContain('<!-- video: A -->');
    expect(pack!.markdown).toContain('<!-- video: B -->');
  });
});
