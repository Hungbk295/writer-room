import { deterministic } from './gates.ts';

export interface TranscriptSegmentInput {
  startSec: number;
  endSec: number;
  text: string;
}

export interface SpeechMetrics {
  wordsTotal: number;
  speechRateWpm: number;
  speechRateByWindow: Array<{ startSec: number; endSec: number; wpm: number }>;
  hookWordCount: number;
  hookSpeechRateWpm: number;
  sentenceLengthMean: number;
  questionDensity: number;
  secondPersonDensity: number;
  silenceGaps: Array<{ startSec: number; durationSec: number }>;
}

const SECOND_PERSON_RE = /\b(bạn|mày|anh|chị|you|your)\b/gi;
const SENTENCE_SPLIT_RE = /[.!?…]+/;

function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).filter(Boolean).length;
}

function wordsInRange(segments: TranscriptSegmentInput[], startSec: number, endSec: number): number {
  let total = 0;
  for (const seg of segments) {
    if (seg.endSec <= startSec || seg.startSec >= endSec) continue;
    total += countWords(seg.text);
  }
  return total;
}

function wpmForRange(segments: TranscriptSegmentInput[], startSec: number, endSec: number): number {
  const words = wordsInRange(segments, startSec, endSec);
  const minutes = Math.max((endSec - startSec) / 60, 1 / 60);
  return words / minutes;
}

function totalDurationSec(segments: TranscriptSegmentInput[]): number {
  if (segments.length === 0) return 0;
  return Math.max(...segments.map((s) => s.endSec));
}

function computeSilenceGaps(segments: TranscriptSegmentInput[], minGapSec = 2): Array<{ startSec: number; durationSec: number }> {
  if (segments.length < 2) return [];
  const sorted = [...segments].sort((a, b) => a.startSec - b.startSec);
  const gaps: Array<{ startSec: number; durationSec: number }> = [];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const curr = sorted[i]!;
    const gap = curr.startSec - prev.endSec;
    if (gap > minGapSec) {
      gaps.push({ startSec: prev.endSec, durationSec: gap });
    }
  }

  return gaps;
}

function splitSentences(segments: TranscriptSegmentInput[]): string[] {
  const fullText = segments.map((s) => s.text).join(' ');
  return fullText
    .split(SENTENCE_SPLIT_RE)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function computeSpeechMetrics(segments: TranscriptSegmentInput[]): SpeechMetrics {
  if (segments.length === 0) {
    return {
      wordsTotal: 0,
      speechRateWpm: 0,
      speechRateByWindow: [],
      hookWordCount: 0,
      hookSpeechRateWpm: 0,
      sentenceLengthMean: 0,
      questionDensity: 0,
      secondPersonDensity: 0,
      silenceGaps: [],
    };
  }

  const fullText = segments.map((s) => s.text).join(' ');
  const wordsTotal = countWords(fullText);
  const durationSec = totalDurationSec(segments);
  const speechRateWpm = wpmForRange(segments, 0, durationSec);

  const windowSizeSec = 30;
  const speechRateByWindow: Array<{ startSec: number; endSec: number; wpm: number }> = [];
  for (let start = 0; start < durationSec; start += windowSizeSec) {
    const end = Math.min(start + windowSizeSec, durationSec);
    speechRateByWindow.push({
      startSec: start,
      endSec: end,
      wpm: wpmForRange(segments, start, end),
    });
  }

  const hookWordCount = wordsInRange(segments, 0, 30);
  const hookSpeechRateWpm = wpmForRange(segments, 0, 30);

  const sentences = splitSentences(segments);
  const sentenceLengths = sentences.map(countWords);
  const sentenceLengthMean =
    sentenceLengths.length > 0
      ? sentenceLengths.reduce((a, b) => a + b, 0) / sentenceLengths.length
      : 0;

  const questionSentences = sentences.filter((s) => /\?/.test(s) || /^(tại sao|vì sao|làm sao|why|how|what)/i.test(s));
  const questionDensity = sentences.length > 0 ? (questionSentences.length / sentences.length) * 100 : 0;

  const secondPersonMatches = fullText.match(SECOND_PERSON_RE);
  const secondPersonCount = secondPersonMatches?.length ?? 0;
  const secondPersonDensity = wordsTotal > 0 ? (secondPersonCount / wordsTotal) * 100 : 0;

  return {
    wordsTotal,
    speechRateWpm,
    speechRateByWindow,
    hookWordCount,
    hookSpeechRateWpm,
    sentenceLengthMean,
    questionDensity,
    secondPersonDensity,
    silenceGaps: computeSilenceGaps(segments),
  };
}

export function speechMetricsValue(segments: TranscriptSegmentInput[]) {
  return deterministic(computeSpeechMetrics(segments));
}
