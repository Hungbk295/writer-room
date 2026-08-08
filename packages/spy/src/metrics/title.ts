import {
  deterministic,
  insufficientSample,
  MIN_VIDEOS_FOR_CORRELATION,
  MIN_VIDEOS_FOR_TOKEN_LIFT,
  type MetricValue,
} from './gates.ts';
import { median } from './stats.ts';

export type OpeningPattern = 'how-to' | 'why' | 'list' | 'story' | 'claim' | 'other';

export interface TitleFeatures {
  charLength: number;
  wordCount: number;
  hasNumber: boolean;
  hasQuestion: boolean;
  hasColon: boolean;
  hasBracket: boolean;
  hasQuote: boolean;
  hasAllCapsWord: boolean;
  hasEmoji: boolean;
  hasSuperlative: boolean;
  hasNegation: boolean;
  hasSecondPerson: boolean;
  openingPattern: OpeningPattern;
}

export interface TokenLift {
  token: string;
  videosContaining: number;
  viewMedianWith: number;
  viewMedianWithout: number;
  lift: number;
}

export interface FeatureLift {
  feature: keyof Pick<
    TitleFeatures,
    | 'hasNumber'
    | 'hasQuestion'
    | 'hasColon'
    | 'hasBracket'
    | 'hasQuote'
    | 'hasAllCapsWord'
    | 'hasEmoji'
    | 'hasSuperlative'
    | 'hasNegation'
    | 'hasSecondPerson'
  >;
  videosWith: number;
  viewMedianWith: number;
  viewMedianWithout: number;
  lift: number;
}

export interface TitleVideoInput {
  title: string;
  viewCount: number;
}

const STOPWORDS = new Set([
  'video', 'cách', 'này', 'the', 'a', 'an', 'of', 'to', 'in', 'for', 'on', 'with', 'and', 'or',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
  'và', 'của', 'là', 'một', 'các', 'những', 'được', 'sẽ', 'khi', 'nếu', 'thì', 'mà', 'về',
]);

const SUPERLATIVE_RE = /\b(nhất|duy nhất|không ai|chưa từng|best|only|never|ever|ultimate|top)\b/i;
const NEGATION_RE = /\b(đừng|không|sai lầm|tránh|never|don't|avoid|stop|wrong)\b/i;
const SECOND_PERSON_RE = /\b(bạn|mày|anh\/chị|anh chị|chị|anh|you|your)\b/i;
const QUESTION_OPEN_RE = /^(tại sao|vì sao|làm sao|why|how|what|when|where|who)\b/i;
const HOW_TO_RE = /^(cách|how to|hướng dẫn|guide to)\b/i;
const WHY_RE = /^(tại sao|vì sao|why)\b/i;
const STORY_RE = /^(tôi|mình|my|when i|khi tôi|story)\b/i;
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const LIST_START_RE = /^\d+[\.\)\s]/;

const FEATURE_KEYS: FeatureLift['feature'][] = [
  'hasNumber',
  'hasQuestion',
  'hasColon',
  'hasBracket',
  'hasQuote',
  'hasAllCapsWord',
  'hasEmoji',
  'hasSuperlative',
  'hasNegation',
  'hasSecondPerson',
];

function normalizeWord(word: string): string {
  return word
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

export function tokenizeTitle(title: string): string[] {
  const cleaned = title.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ');
  const words = cleaned.split(/\s+/).map(normalizeWord).filter((w) => w.length > 0);
  return words.filter((w) => !STOPWORDS.has(w));
}

export function titleNgrams(title: string): string[] {
  const tokens = tokenizeTitle(title);
  const ngrams: string[] = [...tokens];
  for (let i = 0; i < tokens.length - 1; i++) {
    ngrams.push(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return ngrams;
}

export function extractTitleFeatures(title: string): TitleFeatures {
  const trimmed = title.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);

  let openingPattern: OpeningPattern = 'other';
  if (LIST_START_RE.test(trimmed) || /\d+\s+cách/i.test(trimmed)) {
    openingPattern = 'list';
  } else if (HOW_TO_RE.test(trimmed)) {
    openingPattern = 'how-to';
  } else if (WHY_RE.test(trimmed) || QUESTION_OPEN_RE.test(trimmed)) {
    openingPattern = 'why';
  } else if (STORY_RE.test(trimmed)) {
    openingPattern = 'story';
  } else if (trimmed.length > 0) {
    openingPattern = 'claim';
  }

  return {
    charLength: trimmed.length,
    wordCount: words.length,
    hasNumber: /\d/.test(trimmed),
    hasQuestion: /\?$/.test(trimmed) || QUESTION_OPEN_RE.test(trimmed),
    hasColon: /:/.test(trimmed),
    hasBracket: /[\(\[]/.test(trimmed),
    hasQuote: /["'""''«»]/.test(trimmed),
    hasAllCapsWord: /\b[A-ZÀ-Ỹ]{2,}\b/.test(trimmed),
    hasEmoji: EMOJI_RE.test(trimmed),
    hasSuperlative: SUPERLATIVE_RE.test(trimmed),
    hasNegation: NEGATION_RE.test(trimmed),
    hasSecondPerson: SECOND_PERSON_RE.test(trimmed),
    openingPattern,
  };
}

function computeLift(withViews: number[], withoutViews: number[]): number {
  const withMedian = withViews.length > 0 ? median(withViews) : 0;
  const withoutMedian = withoutViews.length > 0 ? median(withoutViews) : 0;
  if (withoutMedian === 0) return withMedian > 0 ? Infinity : 1;
  return withMedian / withoutMedian;
}

export function computeTokenLift(videos: TitleVideoInput[]): TokenLift[] {
  const tokenToVideoIds = new Map<string, Set<number>>();

  videos.forEach((video, idx) => {
    const tokens = new Set(titleNgrams(video.title));
    for (const token of tokens) {
      const set = tokenToVideoIds.get(token) ?? new Set<number>();
      set.add(idx);
      tokenToVideoIds.set(token, set);
    }
  });

  const lifts: TokenLift[] = [];

  for (const [token, containing] of tokenToVideoIds) {
    if (containing.size < MIN_VIDEOS_FOR_TOKEN_LIFT) continue;

    const withViews: number[] = [];
    const withoutViews: number[] = [];

    videos.forEach((video, idx) => {
      if (containing.has(idx)) withViews.push(video.viewCount);
      else withoutViews.push(video.viewCount);
    });

    const viewMedianWith = median(withViews);
    const viewMedianWithout = median(withoutViews);

    lifts.push({
      token,
      videosContaining: containing.size,
      viewMedianWith,
      viewMedianWithout,
      lift: computeLift(withViews, withoutViews),
    });
  }

  return lifts.sort((a, b) => Math.abs(b.lift - 1) - Math.abs(a.lift - 1));
}

export function computeFeatureLift(videos: TitleVideoInput[]): FeatureLift[] {
  const features = videos.map((v) => extractTitleFeatures(v.title));
  const lifts: FeatureLift[] = [];

  for (const feature of FEATURE_KEYS) {
    const withViews: number[] = [];
    const withoutViews: number[] = [];

    videos.forEach((video, idx) => {
      if (features[idx]![feature]) withViews.push(video.viewCount);
      else withoutViews.push(video.viewCount);
    });

    if (withViews.length < MIN_VIDEOS_FOR_TOKEN_LIFT) continue;

    lifts.push({
      feature,
      videosWith: withViews.length,
      viewMedianWith: median(withViews),
      viewMedianWithout: median(withoutViews),
      lift: computeLift(withViews, withoutViews),
    });
  }

  return lifts.sort((a, b) => Math.abs(b.lift - 1) - Math.abs(a.lift - 1));
}

export interface TitleMetrics {
  features: TitleFeatures[];
  tokenLift: TokenLift[];
  featureLift: FeatureLift[];
}

export function computeTitleMetrics(videos: TitleVideoInput[]): TitleMetrics {
  return {
    features: videos.map((v) => extractTitleFeatures(v.title)),
    tokenLift: computeTokenLift(videos),
    featureLift: computeFeatureLift(videos),
  };
}

export function titleMetricsValue(videos: TitleVideoInput[]): MetricValue<TitleMetrics> {
  if (videos.length < MIN_VIDEOS_FOR_CORRELATION) {
    return insufficientSample(videos.length, MIN_VIDEOS_FOR_CORRELATION);
  }
  return deterministic(computeTitleMetrics(videos));
}
