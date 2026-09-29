/**
 * loop/deepdive.ts — lượt "Đào sâu" (plan spy-analyst-workflow §B1, §H bước 6):
 * người chọn vài video → kéo comment + transcript để hiểu vì sao chúng thắng.
 *
 * Dùng lại đường chuẩn, không viết collector mới:
 * - transcript: SpyService.videoSpy(depth='transcript') — tạo snapshot rồi mới
 *   gắn segment, nên agent đọc được qua spy_read_video_material. (Gọi thẳng
 *   fetchTranscripts với video chưa có snapshot sẽ LƯU record nhưng VỨT chữ.)
 * - comment: SpyService.videoComments — đã tự lưu vào video_comments.
 *
 * Chống trùng (chốt 2026-09-29): comment mỗi video kéo MỘT lần; transcript đã
 * có (snapshot transcript_status='ok') thì bỏ qua. Tra theo video_id toàn cục —
 * video đã đào ở topic khác không bị đào lại. Mỗi lần bỏ qua ghi skip_reason.
 *
 * Thẻ lượt chạy ghi chung sổ keyword_runs (type='deepdive'), mỗi video một
 * keyword_run_items (term_key = video_id, n_results = số comment lưu được).
 */
import { randomUUID } from 'node:crypto';
import { quotaDay } from '../quota.ts';
import type { QuotaLedger } from '../quota.ts';
import type { RunItemStatus, RunTrigger, SpyStore } from '../store.ts';
import { acquireChargeableWork, releaseChargeableWork } from './runner.ts';

/** Trần số video mỗi lượt Đào sâu — mỗi video tốn yt-dlp + ~1–2 unit. */
export const DEEPDIVE_MAX_VIDEOS = 20;
/** Số comment thread kéo mỗi video (commentThreads.list, 1 unit/trang 100). */
export const DEEPDIVE_COMMENTS_PER_VIDEO = 100;
/** Trần chờ một lượt spy video (yt-dlp) — hết thì ghi lỗi, không treo cả lượt. */
const VIDEO_SPY_TIMEOUT_MS = 5 * 60_000;

/** Phần SpyService mà Đào sâu cần — tách ra để test không phải dựng cả service. */
export interface DeepDivePorts {
  store: SpyStore;
  quota: QuotaLedger;
  videoSpy(input: { url: string; depth: 'transcript'; idempotencyKey: string }): { operationId: string };
  wait(operationId: string, timeoutMs: number): Promise<{ status: string; errorMessage: string | null }>;
  videoComments(input: { videoId: string; maxResults: number; order: 'relevance' }): Promise<{ saved: number }>;
  /** Mặc định hasTranscript(store) — test thay được mà không dựng spy_run/snapshot. */
  transcriptPresent?(videoId: string): boolean;
}

export interface DeepDiveItemResult {
  videoId: string;
  status: RunItemStatus;
  commentsSaved: number;
  transcript: 'fetched' | 'present' | 'failed';
  skipReason: string | null;
  error: string | null;
}

export function hasComments(store: SpyStore, videoId: string): boolean {
  return store.listVideoComments(videoId, 1).length > 0;
}

export function hasTranscript(store: SpyStore, videoId: string): boolean {
  return store.listSnapshotsBySourceVideoId(videoId).some((s) => s.transcriptStatus === 'ok');
}

export class DeepDiveService {
  constructor(private readonly ports: DeepDivePorts) {}

  private transcriptPresent(videoId: string): boolean {
    return this.ports.transcriptPresent
      ? this.ports.transcriptPresent(videoId)
      : hasTranscript(this.ports.store, videoId);
  }

  /** Tạo thẻ lượt chạy + bắn nền; trả runId ngay cho route. */
  startRun(
    topicId: string,
    videoIds: string[],
    card: { note?: string | null; groupKey?: string | null; triggeredBy?: RunTrigger } = {},
  ): string {
    const runId = randomUUID();
    this.ports.store.createKeywordRun({
      runId,
      topicId,
      paramsJson: JSON.stringify({ videoIds, commentsPerVideo: DEEPDIVE_COMMENTS_PER_VIDEO }),
      nKeywords: videoIds.length,
      startedAt: new Date().toISOString(),
      type: 'deepdive',
      note: card.note ?? null,
      groupKey: card.groupKey ?? null,
      triggeredBy: card.triggeredBy ?? 'human',
    });
    void this.execute(runId, videoIds);
    return runId;
  }

  /** Chạy một lượt đã tạo sẵn; tự kết thúc thẻ: done | failed | cancelled (mất khoá). */
  async execute(runId: string, videoIds: string[]): Promise<void> {
    const { store } = this.ports;
    try {
      acquireChargeableWork(`deepdive:${runId}`);
    } catch (error) {
      store.updateKeywordRun(runId, {
        status: 'cancelled',
        finishedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const day = quotaDay(new Date());
    const unitsBaseline = store.getQuotaUsage('general', day).units;
    const usedUnits = () => Math.max(0, store.getQuotaUsage('general', day).units - unitsBaseline);
    let done = 0;
    let nNew = 0;
    let nSkipped = 0;
    try {
      for (const videoId of videoIds) {
        const item = await this.diveOne(runId, videoId);
        store.insertKeywordRunItem({
          runId,
          termKey: videoId,
          status: item.status,
          nResults: item.commentsSaved,
          nNew: item.commentsSaved > 0 || item.transcript === 'fetched' ? 1 : 0,
          skipReason: item.skipReason,
          error: item.error,
        });
        done++;
        if (item.commentsSaved > 0 || item.transcript === 'fetched') nNew++;
        if (item.status === 'skipped_dedup') nSkipped++;
        store.updateKeywordRun(runId, { keywordsDone: done, generalUnitsUsed: usedUnits(), nNew, nSkipped });
      }
      store.updateKeywordRun(runId, {
        status: 'done',
        keywordsDone: done,
        generalUnitsUsed: usedUnits(),
        nNew,
        nSkipped,
        finishedAt: new Date().toISOString(),
      });
    } catch (error) {
      store.updateKeywordRun(runId, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      releaseChargeableWork(`deepdive:${runId}`);
    }
  }

  /** Một video: comment (nếu chưa có) + transcript (nếu chưa có). Lỗi phần nào ghi phần đó. */
  async diveOne(runId: string, videoId: string): Promise<DeepDiveItemResult> {
    const { store } = this.ports;
    const skips: string[] = [];
    const errors: string[] = [];
    let commentsSaved = 0;
    let transcript: DeepDiveItemResult['transcript'] = 'present';

    if (hasComments(store, videoId)) {
      skips.push('comments_present');
    } else {
      try {
        const res = await this.ports.videoComments({
          videoId, maxResults: DEEPDIVE_COMMENTS_PER_VIDEO, order: 'relevance',
        });
        commentsSaved = res.saved;
      } catch (error) {
        errors.push(`comments: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (this.transcriptPresent(videoId)) {
      skips.push('transcript_present');
    } else {
      try {
        const op = this.ports.videoSpy({
          url: `https://www.youtube.com/watch?v=${videoId}`,
          depth: 'transcript',
          idempotencyKey: `deepdive:${runId}:${videoId}`,
        });
        const finished = await this.ports.wait(op.operationId, VIDEO_SPY_TIMEOUT_MS);
        if (finished.status === 'completed' && this.transcriptPresent(videoId)) {
          transcript = 'fetched';
        } else {
          transcript = 'failed';
          errors.push(`transcript: ${finished.errorMessage ?? `spy video ${finished.status}, không có caption`}`);
        }
      } catch (error) {
        transcript = 'failed';
        errors.push(`transcript: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const bothSkipped = skips.length === 2;
    const status: RunItemStatus = bothSkipped
      ? 'skipped_dedup'
      : errors.length > 0 && commentsSaved === 0 && transcript !== 'fetched'
        ? 'failed'
        : 'done';
    return {
      videoId,
      status,
      commentsSaved,
      transcript,
      skipReason: skips.length ? skips.join(',') : null,
      error: errors.length ? errors.join(' | ') : null,
    };
  }
}
