/**
 * P0-C C3 recommendation capture boundary.
 *
 * This is deliberately not part of YoutubePort/YtDlpAdapter: yt-dlp keyword
 * search and generic feeds are not evidence that YouTube displayed a target
 * beside a particular seed. Production browser-persona capture is deferred;
 * the port exists now for deterministic fixtures and a future authorized,
 * human-approved browser implementation.
 */
import { AppError } from '../errors.ts';

export const DIRECT_SUGGESTION_DEPTH = 1 as const;
export const DIRECT_SUGGESTION_LIMIT = 20 as const;

export interface DirectSuggestionSeed {
  corpusMembershipId: string;
  sourceVideoId: string;
  canonicalUrl: string;
}

export interface CapturedDirectSuggestion {
  /** Untrusted until the service runs canonicalVideoUrl() itself. */
  observedUrl: string;
  /** Position on the captured surface, not a market/search rank. */
  observedPosition: number;
  title?: string | null;
  channelTitle?: string | null;
  channelId?: string | null;
}

export interface DirectSuggestionCapture {
  method: string;
  adapterVersion: string;
  observedAt: string;
  /** Must identify the same canonical video as the requested seed. */
  observedSeedUrl: string;
  /**
   * Optional adapter receipt. The service never persists it verbatim: it
   * writes a bounded, whitelist-only evidence receipt computed from validated
   * fields so cookies/session state/full HTML cannot enter Spy storage.
   */
  normalizedEvidence?: Uint8Array;
  suggestions: readonly CapturedDirectSuggestion[];
}

export interface RecommendationCapturePort {
  captureDirect(input: {
    seed: DirectSuggestionSeed;
    depth: typeof DIRECT_SUGGESTION_DEPTH;
    limit: typeof DIRECT_SUGGESTION_LIMIT;
    signal?: AbortSignal;
  }): Promise<DirectSuggestionCapture>;
}

/** Default runtime has no C3 browser collector. Never silently search instead. */
export class UnavailableRecommendationCapturePort implements RecommendationCapturePort {
  async captureDirect(): Promise<DirectSuggestionCapture> {
    throw new AppError(
      'capability_missing',
      'C3 direct-suggestion capture chưa được cấu hình; yt-dlp/Data API không phải fallback',
    );
  }
}

