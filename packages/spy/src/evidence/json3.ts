import { createHash } from 'node:crypto';
import type { ParsedVttSegment } from './vtt.ts';

/**
 * YouTube's json3 caption format.
 *
 * This is the data form of a caption track, as opposed to WebVTT which is the
 * *display* form: VTT deliberately repeats the tail of each cue so text can roll
 * up the screen, which triples the word count of any transcript read from it.
 * json3 carries each word exactly once, with word-level timing.
 *
 * Shape:
 *   events[] — a window definition (no `segs`), a content line (`segs` of words),
 *   or a line-break separator (`aAppend: 1`, whose only seg is "\n").
 */
interface Json3Seg {
  utf8?: string;
  tOffsetMs?: number;
}

interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  aAppend?: number;
  segs?: Json3Seg[];
}

interface Json3Document {
  events?: Json3Event[];
}

export function isJson3(value: string): boolean {
  return /^\s*\{/.test(value) && value.includes('"events"');
}

export function parseJson3(value: string): ParsedVttSegment[] {
  let document: Json3Document;
  try {
    document = JSON.parse(value) as Json3Document;
  } catch {
    return [];
  }

  const output: ParsedVttSegment[] = [];
  for (const event of document.events ?? []) {
    // Window definitions carry no text; append events carry only the newline that
    // separates two rolling lines of the *same* sentence, never new words.
    if (!event.segs || event.aAppend) continue;
    const text = event.segs
      .map((seg) => seg.utf8 ?? '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    const startSec = (event.tStartMs ?? 0) / 1000;
    output.push({
      index: output.length,
      startSec,
      endSec: startSec + (event.dDurationMs ?? 0) / 1000,
      text,
      contentHash: createHash('sha256').update(text).digest('hex'),
    });
  }
  return output;
}
