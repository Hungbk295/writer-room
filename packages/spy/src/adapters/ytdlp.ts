import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppError } from '../errors.ts';
import { isJson3, parseJson3 } from '../evidence/json3.ts';
import { parseVtt, type ParsedVttSegment } from '../evidence/vtt.ts';
import { requireSuccessfulProcess } from './process.ts';

export interface YoutubeVideoInfo {
  sourceVideoId: string;
  canonicalUrl: string;
  title: string;
  channelTitle: string;
  channelId: string | null;
  viewCount: number;
  durationSec: number;
  publishedAt: string | null;
  thumbnailUrl: string | null;
}

export interface YoutubeTranscript {
  status: 'ok' | 'missing' | 'error';
  language: string | null;
  source: 'manual' | 'auto' | 'unknown';
  /** Consumers only need timing and text; parser metadata remains optional. */
  segments: Array<Pick<ParsedVttSegment, 'startSec' | 'endSec' | 'text'>>;
  error?: string;
}

export interface YoutubePort {
  inspectVideo(canonicalUrl: string, signal?: AbortSignal): Promise<YoutubeVideoInfo>;
  listChannel(canonicalUrl: string, limit: number, signal?: AbortSignal): Promise<YoutubeVideoInfo[]>;
  /** Zero-config keyword search used by Writer Room's Source Pack explorer. */
  searchVideos?(query: string, limit: number, signal?: AbortSignal): Promise<YoutubeVideoInfo[]>;
  fetchTranscript(canonicalUrl: string, signal?: AbortSignal): Promise<YoutubeTranscript>;
  streamUrl(canonicalUrl: string, signal?: AbortSignal): Promise<string>;
  thumbnail(url: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mimeType: string }>;
}

interface YtDlpJson {
  id?: string;
  webpage_url?: string;
  title?: string;
  channel?: string;
  channel_id?: string;
  uploader?: string;
  view_count?: number;
  duration?: number;
  upload_date?: string;
  timestamp?: number;
  thumbnail?: string;
  thumbnails?: Array<{ url?: string }>;
  entries?: YtDlpJson[];
  /** Human-authored caption tracks, keyed by language. */
  subtitles?: Record<string, unknown[]>;
  /** Machine-generated tracks. `<lang>-orig` is the ASR original; `<lang>` alone is a translation of it. */
  automatic_captions?: Record<string, unknown[]>;
}

function publishedAt(value: YtDlpJson): string | null {
  if (value.timestamp) return new Date(value.timestamp * 1000).toISOString();
  if (value.upload_date && /^\d{8}$/.test(value.upload_date)) {
    return `${value.upload_date.slice(0, 4)}-${value.upload_date.slice(4, 6)}-${value.upload_date.slice(6, 8)}`;
  }
  return null;
}

function toInfo(value: YtDlpJson): YoutubeVideoInfo {
  const sourceVideoId = value.id ?? '';
  if (!/^[A-Za-z0-9_-]{11}$/.test(sourceVideoId)) {
    throw new AppError('provider_error', 'yt-dlp trả video ID không hợp lệ');
  }
  return {
    sourceVideoId,
    canonicalUrl: `https://www.youtube.com/watch?v=${sourceVideoId}`,
    title: value.title ?? sourceVideoId,
    channelTitle: value.channel ?? value.uploader ?? '',
    channelId: value.channel_id ?? null,
    viewCount: Math.max(0, Math.round(value.view_count ?? 0)),
    durationSec: Math.max(0, value.duration ?? 0),
    publishedAt: publishedAt(value),
    thumbnailUrl: value.thumbnail ?? value.thumbnails?.at(-1)?.url ?? null,
  };
}

function parseJson(buffer: Buffer): YtDlpJson {
  try {
    return JSON.parse(buffer.toString('utf8')) as YtDlpJson;
  } catch (error) {
    throw new AppError('provider_error', 'yt-dlp trả JSON không hợp lệ', { cause: error });
  }
}

const SUBTITLE_LANGUAGE_PREFERENCE = ['vi', 'en'];

/**
 * Rank the available caption tracks. Prefers a real human transcript, then the
 * original-language auto track (`vi-orig`) over machine translations of it (`vi`).
 */
function preferredTrack(
  info: YtDlpJson,
): { language: string; source: 'manual' | 'auto' } | null {
  for (const [source, tracks] of [
    ['manual', info.subtitles],
    ['auto', info.automatic_captions],
  ] as const) {
    const languages = Object.keys(tracks ?? {});
    for (const wanted of SUBTITLE_LANGUAGE_PREFERENCE) {
      const original = languages.find((language) => language === `${wanted}-orig`);
      const exact = languages.find((language) => language === wanted);
      const prefixed = languages.find((language) => language.startsWith(`${wanted}-`));
      const chosen = original ?? exact ?? prefixed;
      if (chosen) return { language: chosen, source };
    }
  }
  return null;
}

export class YtDlpAdapter implements YoutubePort {
  constructor(
    private readonly binary = 'yt-dlp',
    private readonly cookieFile?: string,
  ) {}

  private baseArgs(): string[] {
    return [
      '--no-warnings',
      '--no-progress',
      ...(this.cookieFile ? ['--cookies', this.cookieFile] : []),
    ];
  }

  async inspectVideo(canonicalUrl: string, signal?: AbortSignal): Promise<YoutubeVideoInfo> {
    const result = await requireSuccessfulProcess(
      this.binary,
      [...this.baseArgs(), '--dump-single-json', '--skip-download', canonicalUrl],
      { signal, timeoutMs: 90_000, maximumStdoutBytes: 8 * 1024 * 1024 },
    );
    return toInfo(parseJson(result.stdout));
  }

  async listChannel(canonicalUrl: string, limit: number, signal?: AbortSignal): Promise<YoutubeVideoInfo[]> {
    const result = await requireSuccessfulProcess(
      this.binary,
      [
        ...this.baseArgs(),
        '--dump-single-json',
        '--flat-playlist',
        '--playlist-end',
        String(limit),
        canonicalUrl,
      ],
      { signal, timeoutMs: 120_000, maximumStdoutBytes: 32 * 1024 * 1024 },
    );
    const parsed = parseJson(result.stdout);
    return (parsed.entries ?? []).flatMap((entry) => {
      try {
        return [toInfo(entry)];
      } catch {
        return [];
      }
    });
  }

  /**
   * `ytsearch` gives Source Pack exploration the same zero-config search path
   * as DNA Spy. Flat playlist metadata is sufficient for the picker; full
   * metadata and transcripts are fetched only for videos the editor selects.
   */
  async searchVideos(query: string, limit: number, signal?: AbortSignal): Promise<YoutubeVideoInfo[]> {
    const clean = query.replace(/[\r\n\0]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!clean) return [];
    const count = Math.max(1, Math.min(limit, 50));
    const result = await requireSuccessfulProcess(
      this.binary,
      [
        ...this.baseArgs(),
        '--flat-playlist',
        '--dump-single-json',
        '--skip-download',
        `ytsearch${count}:${clean}`,
      ],
      { signal, timeoutMs: 60_000, maximumStdoutBytes: 16 * 1024 * 1024 },
    );
    const parsed = parseJson(result.stdout);
    return (parsed.entries ?? []).flatMap((entry) => {
      try {
        return [toInfo(entry)];
      } catch {
        return [];
      }
    });
  }

  async fetchTranscript(canonicalUrl: string, signal?: AbortSignal): Promise<YoutubeTranscript> {
    const directory = await mkdtemp(join(tmpdir(), 'writer-room-subs-'));
    try {
      // Two calls on purpose. yt-dlp writes manual and automatic tracks to the same
      // `<id>.<lang>.<ext>` path, so the filename cannot tell them apart — the metadata
      // can, and it also says which language tracks actually exist before we download.
      const metadata = parseJson((await requireSuccessfulProcess(
        this.binary,
        [...this.baseArgs(), '--dump-single-json', '--skip-download', canonicalUrl],
        { signal, timeoutMs: 90_000, maximumStdoutBytes: 16 * 1024 * 1024 },
      )).stdout);
      const track = preferredTrack(metadata);
      if (!track) return { status: 'missing', language: null, source: 'unknown', segments: [] };

      const result = await requireSuccessfulProcess(
        this.binary,
        [
          ...this.baseArgs(),
          '--skip-download',
          track.source === 'manual' ? '--write-subs' : '--write-auto-subs',
          '--sub-langs',
          track.language,
          // json3 is the data form of a caption track; vtt is the display form and
          // repeats every line as it rolls up the screen.
          '--sub-format',
          'json3/vtt',
          '--output',
          join(directory, '%(id)s.%(ext)s'),
          canonicalUrl,
        ],
        { signal, timeoutMs: 120_000, maximumStdoutBytes: 2 * 1024 * 1024 },
      ).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (/subtitle|subtitles|requested format/i.test(message)) return null;
        throw error;
      });
      void result;

      const files = (await readdir(directory))
        .filter((file) => file.endsWith('.json3') || file.endsWith('.vtt'))
        .toSorted((a, b) => Number(b.endsWith('.json3')) - Number(a.endsWith('.json3')));
      const preferred = files[0];
      if (!preferred) return { status: 'missing', language: null, source: 'unknown', segments: [] };
      const contents = await readFile(join(directory, preferred), 'utf8');
      return {
        status: 'ok',
        language: track.language,
        source: track.source,
        segments: isJson3(contents) ? parseJson3(contents) : parseVtt(contents),
      };
    } catch (error) {
      // Cancellation must propagate — swallowing it here as a normal per-video error
      // let the channel-spy loop march through every remaining video after an abort.
      if (error instanceof AppError && error.code === 'cancelled') throw error;
      return {
        status: 'error',
        language: null,
        source: 'unknown',
        segments: [],
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async streamUrl(canonicalUrl: string, signal?: AbortSignal): Promise<string> {
    const result = await requireSuccessfulProcess(
      this.binary,
      [...this.baseArgs(), '--get-url', '--format', 'best[ext=mp4]/best', canonicalUrl],
      { signal, timeoutMs: 90_000, maximumStdoutBytes: 256 * 1024 },
    );
    const url = result.stdout.toString('utf8').split(/\r?\n/).find(Boolean)?.trim();
    if (!url) throw new AppError('provider_error', 'yt-dlp không trả stream URL', { retryable: true });
    return url;
  }

  async thumbnail(url: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mimeType: string }> {
    const response = await fetch(url, { signal: signal ?? null });
    if (!response.ok) {
      throw new AppError('provider_error', `Không tải được thumbnail (${response.status})`, {
        retryable: response.status >= 500 || response.status === 429,
      });
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > 10 * 1024 * 1024) throw new AppError('quota_exceeded', 'Thumbnail vượt 10 MiB');
    return { bytes: buffer, mimeType: response.headers.get('content-type') ?? 'image/jpeg' };
  }
}
