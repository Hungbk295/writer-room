import { createHash } from 'node:crypto';

export interface ParsedVttSegment {
  index: number;
  startSec: number;
  endSec: number;
  text: string;
  contentHash: string;
}

function parseTime(value: string): number {
  const match = value.trim().match(/(?:(\d+):)?(\d+):(\d+)[.,](\d{3})/);
  if (!match) return 0;
  return Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

function cleanText(value: string): string {
  return value
    .replace(/<\d{2}:\d{2}:\d{2}[.,]\d{3}>/g, '')
    .replace(/<\/?c[^>]*>/g, '')
    .replace(/<\/?[biu]>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Length of the longest suffix of `previous` that is also a prefix of `next`.
 *
 * YouTube's auto-caption VTT rolls text up the screen: each cue repeats the tail of
 * the one before it and appends a few new words, so a naive join triples the
 * transcript. Cues are never byte-identical, so an equality check alone drops nothing.
 */
function overlapLength(previous: string, next: string): number {
  const max = Math.min(previous.length, next.length);
  for (let size = max; size > 0; size--) {
    if (previous.endsWith(next.slice(0, size))) return size;
  }
  return 0;
}

export function parseVtt(value: string): ParsedVttSegment[] {
  const output: ParsedVttSegment[] = [];
  let previous = '';
  for (const block of value.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex < 0) continue;
    const timing = lines[timingIndex]!.split('-->');
    const raw = cleanText(lines.slice(timingIndex + 1).join(' '));
    if (!raw || raw === previous) continue;
    // Compare against the previous cue as it arrived, even when that cue produced no
    // new text — the rolling window advances cue by cue regardless of what we emitted.
    const text = raw.slice(overlapLength(previous, raw)).trim();
    previous = raw;
    if (!text) continue;
    output.push({
      index: output.length,
      startSec: parseTime(timing[0] ?? ''),
      endSec: parseTime(timing[1] ?? ''),
      text,
      contentHash: createHash('sha256').update(text).digest('hex'),
    });
  }
  return output;
}

export function transcriptText(segments: readonly Pick<ParsedVttSegment, 'text'>[]): string {
  return segments.map((segment) => segment.text).join(' ').replace(/\s+/g, ' ').trim();
}
