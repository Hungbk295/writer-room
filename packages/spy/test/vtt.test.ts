import { describe, expect, test } from 'bun:test';
import { parseVtt } from '../src/evidence/vtt.ts';

// Real shape of a yt-dlp `--write-auto-subs --sub-format vtt` file: inline
// per-word timing tags (`<00:00:00.240><c> on</c>`), and every cue repeats
// the tail of the previous one as the caption rolls up the screen.
const SAMPLE_VTT = `WEBVTT
Kind: captions
Language: en

00:00:00.000 --> 00:00:02.190 align:start position:0%
It's<00:00:00.240><c> 11:40</c><00:00:00.960><c> on</c><00:00:01.280><c> a</c><00:00:01.520><c> Tuesday</c>

00:00:02.190 --> 00:00:02.200 align:start position:0%
It's 11:40 on a Tuesday

00:00:02.200 --> 00:00:04.550 align:start position:0%
It's 11:40 on a Tuesday
morning<00:00:02.960><c> in</c><00:00:03.280><c> late</c><00:00:03.520><c> March</c>

00:00:04.550 --> 00:00:04.560 align:start position:0%
morning in late March
`;

describe('parseVtt', () => {
  test('strips inline timing/style tags and dedupes YouTube\'s rolling-cue repeats', () => {
    const segments = parseVtt(SAMPLE_VTT);

    // Four cue blocks roll up to two genuinely new spans of text.
    expect(segments).toHaveLength(2);

    expect(segments[0]!.text).toBe("It's 11:40 on a Tuesday");
    expect(segments[0]!.startSec).toBeCloseTo(0, 3);
    expect(segments[0]!.endSec).toBeCloseTo(2.19, 3);

    expect(segments[1]!.text).toBe('morning in late March');
    expect(segments[1]!.startSec).toBeCloseTo(2.2, 3);
    expect(segments[1]!.endSec).toBeCloseTo(4.55, 3);

    // No leftover <...> tags anywhere in the parsed text.
    for (const segment of segments) {
      expect(segment.text).not.toMatch(/<[^>]*>/);
    }
  });

  test('drops WEBVTT header and metadata lines', () => {
    const segments = parseVtt(SAMPLE_VTT);
    for (const segment of segments) {
      expect(segment.text).not.toMatch(/WEBVTT|Kind:|Language:/);
    }
  });

  test('empty input yields no segments', () => {
    expect(parseVtt('')).toEqual([]);
    expect(parseVtt('WEBVTT\n')).toEqual([]);
  });
});
