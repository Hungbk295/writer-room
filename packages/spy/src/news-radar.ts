/**
 * News radar: daily pull of the newest videos from news/press channels, with transcripts,
 * so an external agent (Hermes) can summarise them and post a digest.
 *
 * Independent of Channel Watch (faceless competitors): its own channel list comes from the
 * caller and its own state lives under `<spy data>/news-radar/videos/<videoId>.json`.
 * yt-dlp only, no Data API quota. Delivery is at-least-once: a video counts as sent only
 * after `ack`, so a run that dies before acking re-pulls the same videos next time.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError, asAppError } from './errors.ts';
import type { YoutubePort, YoutubeTranscript } from './adapters/ytdlp.ts';

const HOUR_MS = 3_600_000;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export interface NewsPullInput {
  /** `@handle`, `UC…` id, or a youtube.com channel URL. */
  channels: string[];
  maxPerChannel?: number;
  sinceHours?: number;
  maxTranscriptChars?: number;
  /** Re-send videos that were already acked (manual re-runs, testing). */
  includeDelivered?: boolean;
  /** Wall-clock budget for the whole pull; unfinished videos are reported, not lost. */
  budgetMs?: number;
  now?: Date;
  signal?: AbortSignal;
}

export interface NewsTranscript {
  status: YoutubeTranscript['status'];
  language: string | null;
  source: YoutubeTranscript['source'];
  text: string;
  chars: number;
  truncated: boolean;
  error?: string;
}

export interface NewsVideoRecord {
  videoId: string;
  url: string;
  channelUrl: string;
  channelTitle: string | null;
  title: string | null;
  publishedAt: string | null;
  durationSec: number | null;
  transcript: NewsTranscript;
  firstPulledAt: string;
  lastPulledAt: string;
  deliveredAt: string | null;
  summary: string | null;
}

export interface NewsPullResult {
  pulledAt: string;
  sinceHours: number;
  items: NewsVideoRecord[];
  skipped: Array<{ channelUrl: string; videoId?: string; reason: string }>;
  notes: string[];
}

export interface NewsAckResult {
  acked: string[];
  missing: string[];
}

/** Builds the `/videos` tab URL ourselves so caller input never reaches yt-dlp verbatim. */
export function newsChannelVideosUrl(input: string): string {
  const value = input.trim();
  const handle = /^@([A-Za-z0-9._-]{3,100})$/.exec(value);
  if (handle) return `https://www.youtube.com/@${handle[1]}/videos`;
  if (/^UC[A-Za-z0-9_-]{22}$/.test(value)) return `https://www.youtube.com/channel/${value}/videos`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError('invalid_input', `channel không hợp lệ: ${value.slice(0, 80)}`);
  }
  if (url.protocol !== 'https:' || !/^(www\.|m\.)?youtube\.com$/.test(url.hostname)) {
    throw new AppError('invalid_input', 'channel phải là @handle, UC id hoặc URL youtube.com');
  }
  const path = /^\/(@[A-Za-z0-9._-]{3,100}|channel\/UC[A-Za-z0-9_-]{22})(\/videos)?\/?$/.exec(url.pathname);
  if (!path) throw new AppError('invalid_input', 'URL kênh phải có dạng youtube.com/@handle hoặc youtube.com/channel/UC…');
  return `https://www.youtube.com/${path[1]}/videos`;
}

/** Auto captions roll up the screen and repeat lines; keep each line once. */
export function dedupedCaptionText(segments: YoutubeTranscript['segments']): string {
  const lines: string[] = [];
  for (const segment of segments) {
    const line = segment.text.replace(/\s+/g, ' ').trim();
    if (line && line !== lines.at(-1)) lines.push(line);
  }
  return lines.join(' ');
}

/** Day-only dates (no upload timestamp) count until the end of that day, so they are not dropped early. */
function publishedMs(publishedAt: string | null): number | null {
  if (!publishedAt) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(publishedAt)) return Date.parse(`${publishedAt}T23:59:59Z`);
  const ms = Date.parse(publishedAt);
  return Number.isFinite(ms) ? ms : null;
}

export class NewsRadarService {
  constructor(
    private readonly root: string,
    private readonly youtube: YoutubePort,
  ) {}

  async pull(input: NewsPullInput): Promise<NewsPullResult> {
    if (!this.youtube.listChannelObservation || !this.youtube.inspectVideoObservation) {
      throw new AppError('capability_missing', 'yt-dlp adapter không hỗ trợ liệt kê/inspect video kênh');
    }
    if (input.channels.length === 0) throw new AppError('invalid_input', 'channels không được rỗng');
    const channelUrls = [...new Set(input.channels.map(newsChannelVideosUrl))];
    const now = input.now ?? new Date();
    const maxPerChannel = input.maxPerChannel ?? 5;
    const sinceHours = input.sinceHours ?? 36;
    const maxChars = input.maxTranscriptChars ?? 12_000;
    const deadline = Date.now() + (input.budgetMs ?? 240_000);
    const since = now.getTime() - sinceHours * HOUR_MS;
    const items: NewsVideoRecord[] = [];
    const skipped: NewsPullResult['skipped'] = [];
    const notes: string[] = [];
    let alreadyDelivered = 0;

    for (const channelUrl of channelUrls) {
      let inventory;
      try {
        // Newest first; list a few extra so already-sent videos do not starve the quota.
        inventory = await this.youtube.listChannelObservation(channelUrl, Math.min(50, maxPerChannel * 3), input.signal);
      } catch (error) {
        skipped.push({ channelUrl, reason: `liệt kê kênh lỗi: ${asAppError(error).message}` });
        continue;
      }
      let taken = 0;
      for (const entry of inventory) {
        if (taken >= maxPerChannel) break;
        if (Date.now() > deadline) {
          skipped.push({ channelUrl, videoId: entry.sourceVideoId, reason: 'hết ngân sách thời gian, sẽ lấy ở lần sau' });
          continue;
        }
        const existing = await this.read(entry.sourceVideoId);
        if (existing?.deliveredAt && !input.includeDelivered) {
          alreadyDelivered += 1;
          continue;
        }
        try {
          const detail = await this.youtube.inspectVideoObservation(entry.canonicalUrl, input.signal);
          const published = publishedMs(detail.publishedAt ?? entry.publishedAt);
          // The /videos tab is newest-first: once one video is older than the window, the rest are too.
          if (published !== null && published < since) break;
          const transcript = await this.transcript(entry.canonicalUrl, maxChars, input.signal);
          const pulledAt = now.toISOString();
          const record: NewsVideoRecord = {
            videoId: entry.sourceVideoId,
            url: entry.canonicalUrl,
            channelUrl,
            channelTitle: detail.channelTitle ?? entry.channelTitle,
            title: detail.title ?? entry.title,
            publishedAt: detail.publishedAt ?? entry.publishedAt,
            durationSec: detail.durationSec,
            transcript: transcript.full,
            firstPulledAt: existing?.firstPulledAt ?? pulledAt,
            lastPulledAt: pulledAt,
            deliveredAt: existing?.deliveredAt ?? null,
            summary: existing?.summary ?? null,
          };
          await this.write(record);
          items.push({ ...record, transcript: transcript.returned });
          taken += 1;
        } catch (error) {
          const appError = asAppError(error);
          if (appError.code === 'cancelled') throw appError;
          skipped.push({ channelUrl, videoId: entry.sourceVideoId, reason: appError.message });
        }
      }
    }
    if (alreadyDelivered > 0) notes.push(`Bỏ qua ${alreadyDelivered} video đã gửi ở lần trước.`);
    if (items.length === 0) notes.push(`Không có video mới trong ${sinceHours} giờ qua.`);
    return { pulledAt: now.toISOString(), sinceHours, items, skipped, notes };
  }

  async ack(entries: Array<{ videoId: string; summary?: string }>, now = new Date()): Promise<NewsAckResult> {
    const acked: string[] = [];
    const missing: string[] = [];
    for (const entry of entries) {
      if (!VIDEO_ID.test(entry.videoId)) throw new AppError('invalid_input', `video_id không hợp lệ: ${entry.videoId}`);
      const record = await this.read(entry.videoId);
      if (!record) {
        missing.push(entry.videoId);
        continue;
      }
      await this.write({
        ...record,
        deliveredAt: record.deliveredAt ?? now.toISOString(),
        summary: entry.summary?.trim() || record.summary,
      });
      acked.push(entry.videoId);
    }
    return { acked, missing };
  }

  async read(videoId: string): Promise<NewsVideoRecord | null> {
    try {
      return JSON.parse(await readFile(this.path(videoId), 'utf8')) as NewsVideoRecord;
    } catch {
      return null;
    }
  }

  private async transcript(url: string, maxChars: number, signal?: AbortSignal): Promise<{ full: NewsTranscript; returned: NewsTranscript }> {
    let raw = await this.youtube.fetchTranscript(url, signal);
    if (raw.status !== 'ok' && this.youtube.fetchAutoSubsFallback) raw = await this.youtube.fetchAutoSubsFallback(url, signal);
    const text = raw.status === 'ok' ? dedupedCaptionText(raw.segments) : '';
    const base = {
      status: raw.status,
      language: raw.language,
      source: raw.source,
      chars: text.length,
      ...(raw.error ? { error: raw.error.slice(0, 300) } : {}),
    };
    return {
      full: { ...base, text, truncated: false },
      returned: { ...base, text: text.slice(0, maxChars), truncated: text.length > maxChars },
    };
  }

  private path(videoId: string): string {
    return join(this.root, 'videos', `${videoId}.json`);
  }

  private async write(record: NewsVideoRecord): Promise<void> {
    await mkdir(join(this.root, 'videos'), { recursive: true });
    const target = this.path(record.videoId);
    await writeFile(`${target}.tmp`, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await rename(`${target}.tmp`, target);
  }
}
