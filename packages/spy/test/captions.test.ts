import { describe, expect, test } from 'bun:test';
import { isJson3, parseJson3 } from '../src/evidence/json3.ts';
import { parseVtt, transcriptText } from '../src/evidence/vtt.ts';

const words = (text: string) => text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;

/**
 * A rolling auto-caption window as YouTube actually emits it: every cue repeats the
 * tail of the previous one. Read naively this triples the transcript.
 */
const ROLLING_VTT = `WEBVTT

00:00:00.199 --> 00:00:02.270
Có người mất 500 triệu để mở một quán cà

00:00:02.270 --> 00:00:02.280
Có người mất 500 triệu để mở một quán cà
phê thật đẹp. Đèn đẹp, bàn ghế đẹp, menu

00:00:02.280 --> 00:00:05.639
phê thật đẹp. Đèn đẹp, bàn ghế đẹp, menu

00:00:05.639 --> 00:00:05.649
phê thật đẹp. Đèn đẹp, bàn ghế đẹp, menu
đẹp, ảnh khai trương đăng lên ai cũng

00:00:05.649 --> 00:00:08.000
đẹp, ảnh khai trương đăng lên ai cũng`;

const EXPECTED = 'Có người mất 500 triệu để mở một quán cà phê thật đẹp. '
  + 'Đèn đẹp, bàn ghế đẹp, menu đẹp, ảnh khai trương đăng lên ai cũng';

const JSON3 = JSON.stringify({
  wireMagic: 'pb3',
  events: [
    { tStartMs: 0, dDurationMs: 1548080, id: 1, wpWinPosId: 1 },
    {
      tStartMs: 199,
      dDurationMs: 5441,
      segs: [
        { utf8: 'Có' }, { utf8: ' người', tOffsetMs: 200 }, { utf8: ' mất', tOffsetMs: 361 },
      ],
    },
    { tStartMs: 2270, dDurationMs: 3370, aAppend: 1, segs: [{ utf8: '\n' }] },
    { tStartMs: 2280, dDurationMs: 5559, segs: [{ utf8: '500' }, { utf8: ' triệu', tOffsetMs: 160 }] },
  ],
});

describe('caption parsing', () => {
  test('json3 keeps every word exactly once and drops window/append events', () => {
    expect(isJson3(JSON3)).toBe(true);
    const segments = parseJson3(JSON3);
    expect(segments.map(({ startSec, endSec, text }) => ({ startSec, endSec, text }))).toEqual([
      { startSec: 0.199, endSec: 5.64, text: 'Có người mất' },
      { startSec: 2.28, endSec: 7.839, text: '500 triệu' },
    ]);
    expect(transcriptText(segments)).toBe('Có người mất 500 triệu');
  });

  test('json3 rejects non-json3 payloads instead of throwing', () => {
    expect(isJson3(ROLLING_VTT)).toBe(false);
    expect(parseJson3('not json at all')).toEqual([]);
  });

  test('vtt fallback strips the rolling window instead of tripling the transcript', () => {
    const segments = parseVtt(ROLLING_VTT);
    const text = transcriptText(segments);
    expect(text).toBe(EXPECTED);
    // 5 cues carrying 3 lines' worth of words; a naive join would yield ~3x.
    expect(words(text)).toBe(words(EXPECTED));
  });

  test('vtt without rolling repetition is untouched', () => {
    const segments = parseVtt(`WEBVTT

00:00:00.000 --> 00:00:02.000
Hello world

00:00:02.000 --> 00:00:04.500
Second line`);
    expect(segments.map(({ startSec, endSec, text }) => ({ startSec, endSec, text }))).toEqual([
      { startSec: 0, endSec: 2, text: 'Hello world' },
      { startSec: 2, endSec: 4.5, text: 'Second line' },
    ]);
  });
});
