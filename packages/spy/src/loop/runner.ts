/**
 * loop/runner.ts — LoopRunner: thực thi một tick/ngày/topic theo nhịp v3-lean.
 *
 * Mọi tick đi qua runV3Tick (daily | weekly | setup); `mode` mặc định 'daily' —
 * nhịp thận trọng nhất (0 search call, không đụng status) nên caller nào quên
 * truyền mode vẫn nằm trong vùng an toàn của máy. Pipeline legacy v2
 * (expand/search/enrich/triage) đã bị gỡ — preview chi phí đi qua planTick().
 *
 * Idempotency: UNIQUE(topic_id, quota_day, mode). Resume nhận lại tick cũ.
 * Lock: khoá toàn cục CHARGEABLE_WORK_RUNNING (kế toán quota = hiệu số sổ).
 */
import { randomUUID } from 'node:crypto';
import type { SpyStore } from '../store.ts';
import type { QuotaLedger } from '../quota.ts';
import { quotaDay } from '../quota.ts';
import type { DiscoveryService } from '../discovery.ts';
import type { YouTubeDataApiPort } from '../adapters/data-api.ts';
import { topicToNicheMarket } from '../topic.ts';
import type { LoopMode } from '../store.ts';
import type { FacelessVerdictPort, SetupStep } from './types.ts';
import { topicConfigSchema } from './types.ts';
import type { TickResult, LoopStatus, LoopTickBrief } from './types.ts';
import { buildV3Report } from './report.ts';
import { runDailyMode, runWeeklyMode, runSetupMode, type ModeContext } from './modes.ts';
import { AppError } from '../errors.ts';

/**
 * KHOÁ TOÀN CỤC cho mọi việc tiêu quota, KHÔNG phải khoá theo topic.
 *
 * Vì sao không theo topic: kế toán quota của một tick là HIỆU SỐ sổ giữa lúc
 * bắt đầu và lúc đọc (xem `charged()` trong runTick). Sổ là của cả ngày, không
 * mang tick_id. Hai topic chạy chồng nhau thì mỗi tick nhìn thấy cả phần tiêu
 * của tick kia và cả hai cùng báo tổng — hai tick mỗi tick 1 search sẽ đều khai
 * 2, tổng thành 4 trong khi thực tế 2.
 *
 * Khoá theo topic KHÔNG chặn được điều đó: route và scheduler cho phép hai
 * topic KHÁC NHAU chạy đồng thời ngay hôm nay.
 *
 * ĐIỀU KIỆN ĐỂ GỠ KHOÁ NÀY (đừng gỡ mà không làm): chuyển kế toán từ "hiệu số
 * sổ" sang **charge event mang tick_id** — mỗi lần consume ghi một dòng gắn với
 * tick, rồi tổng theo tick_id. Chừng nào còn tính bằng hiệu số thì song song =
 * số liệu sai, và sai một cách im lặng.
 */
let CHARGEABLE_WORK_RUNNING: string | null = null;

export interface LoopRunnerOptions {
  store: SpyStore;
  quota: QuotaLedger;
  discovery: DiscoveryService; // giữ trong options — caller (SpyService) đã dựng sẵn
  dataApi: YouTubeDataApiPort;
  dataRoot: string;
  /**
   * Seam cho vòng agent vision (§3). P0 LUÔN undefined → runner bỏ qua hoàn
   * toàn bước tính verdict và `topic_channels.faceless_score` giữ NULL.
   * Khi port được implement, cắm vào đây là đủ — không phải sửa runner.
   */
  facelessJudge?: FacelessVerdictPort;
}

export class LoopRunner {
  private readonly store: SpyStore;
  private readonly quota: QuotaLedger;
  private readonly dataApi: YouTubeDataApiPort;
  private readonly dataRoot: string;
  private readonly facelessJudge: FacelessVerdictPort | undefined;

  constructor(opts: LoopRunnerOptions) {
    this.store = opts.store;
    this.quota = opts.quota;
    this.dataApi = opts.dataApi;
    this.dataRoot = opts.dataRoot;
    this.facelessJudge = opts.facelessJudge;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * `mode` mặc định 'daily' — nhịp thận trọng nhất (0 search call, không ghi
   * status ngoài vùng máy) nên caller nào quên truyền mode vẫn an toàn.
   * `dryRun` không còn trên runTick: xem trước chi phí bằng planTick() của
   * adapter — ném tường minh thay vì lặng lẽ chạy tick thật.
   */
  async runTick(
    topicId: string,
    opts: { dryRun?: boolean; now?: Date; mode?: LoopMode; setupStep?: SetupStep } = {},
  ): Promise<TickResult> {
    if (opts.dryRun) {
      throw new AppError('invalid_input', 'runTick không còn dryRun — dùng planTick để xem trước chi phí');
    }
    return this.runV3Tick(topicId, {
      mode: opts.mode ?? 'daily',
      setupStep: opts.setupStep,
      now: opts.now,
    });
  }


  /**
   * Tick theo nhịp v3-lean: daily | weekly | setup. Tái dùng khoá toàn cục và
   * kế toán "hiệu số sổ" của legacy — những luật đó không đổi theo mode.
   *
   * Khác biệt cốt lõi so với legacy: tick này KHÔNG tự triage. Mọi ghi status
   * đều đi qua store contract (new / pending / rejected lang_mismatch /
   * suggestion) — active/paused là việc của endpoint duyệt với actor='human'.
   */
  private async runV3Tick(
    topicId: string,
    opts: { mode: LoopMode; setupStep?: SetupStep; now?: Date },
  ): Promise<TickResult> {
    const mode = opts.mode;
    const now = opts.now ?? new Date();
    const day = quotaDay(now);
    const nowIso = now.toISOString();

    if (CHARGEABLE_WORK_RUNNING !== null) {
      throw new AppError(
        'invalid_input',
        CHARGEABLE_WORK_RUNNING === topicId
          ? `Topic '${topicId}' đang chạy tick, không chạy song song`
          : `Đang có tick chạy cho topic '${CHARGEABLE_WORK_RUNNING}'. Chạy tuần tự vì kế toán quota tính bằng hiệu số sổ.`,
      );
    }

    const topicRow = this.store.getTopic(topicId);
    if (!topicRow) throw new AppError('not_found', `Topic '${topicId}' không tồn tại`);

    const topic = topicConfigSchema.parse({
      topicId: String(topicRow['topic_id']),
      label: String(topicRow['label']),
      market: String(topicRow['market']),
      language: String(topicRow['language']),
      region: String(topicRow['region'] ?? ''),
      status: String(topicRow['status']),
      ownChannelIds: JSON.parse(String(topicRow['own_channel_ids_json'])) as string[],
      brief: String(topicRow['brief_md']),
      facelessRequired: Boolean(topicRow['faceless_required']),
      dailySearchBudget: Number(topicRow['daily_search_budget']),
      seedKeywords: [],
    });

    if (topic.status !== 'active') {
      return this.makeSkippedResult(topicId, day, `Topic ${topic.status}`, mode, opts.setupStep);
    }

    const settings = this.store.getTopicSettings(topicId);

    // D1/W0: pre-flight quota — fail sạch, không ghi dữ liệu nghiệp vụ.
    if (mode === 'daily' && this.quota.remaining('general', now) <= 0) {
      return this.makeSkippedResult(topicId, day, 'Hết quota general', mode, opts.setupStep);
    }
    if (mode !== 'daily' && this.quota.remaining('search', now) <= 0) {
      return this.makeSkippedResult(topicId, day, 'Hết quota search', mode, opts.setupStep);
    }

    // Idempotency theo (topic_id, quota_day, mode) — cùng ngày có thể có
    // daily + weekly + setup song song mà không đè nhau.
    let tickId: string = randomUUID();
    const started = Date.now();
    let searchBaselineCalls = this.store.getQuotaUsage('search', day).calls;
    let generalBaselineUnits = this.store.getQuotaUsage('general', day).units;
    const inserted = this.store.createLoopTick({
      tickId, topicId, quotaDay: day, mode, searchBaselineCalls, generalBaselineUnits,
    });
    if (!inserted) {
      const existing = this.store.getTickByDay(topicId, day, mode);
      if (existing && String(existing['status']) === 'done') {
        return this.makeSkippedResult(topicId, day, `Tick ${mode} hôm nay đã hoàn thành`, mode, opts.setupStep);
      }
      if (existing) {
        // RESUME giữ mốc sổ GỐC — phần quota đã tiêu trước khi chết vẫn thuộc tick.
        searchBaselineCalls = Number(existing['search_baseline_calls'] ?? 0);
        generalBaselineUnits = Number(existing['general_baseline_units'] ?? 0);
        tickId = String(existing['tick_id']);
        this.store.updateLoopTick(tickId, { status: 'running', error: null });
      }
    }

    CHARGEABLE_WORK_RUNNING = topicId;
    const { market } = topicToNicheMarket(topic);
    if (topic.region) market.regionCode = topic.region;
    const regionCode = market.regionCode;

    const charged = (): { searchCalls: number; generalUnits: number } => ({
      searchCalls: Math.max(0, this.store.getQuotaUsage('search', day).calls - searchBaselineCalls),
      generalUnits: Math.max(0, this.store.getQuotaUsage('general', day).units - generalBaselineUnits),
    });

    const ctx: ModeContext = {
      store: this.store,
      quota: this.quota,
      dataApi: this.dataApi,
      topicId,
      language: topic.language,
      regionCode,
      settings,
      tickId,
      day,
      nowIso,
    };

    let keywordsSearched: string[] = [];
    let channelsProposed = 0;
    let keywordsProposed = 0;
    let autoRejected = 0;
    let channelsScanned = 0;
    let daily: import('./types.ts').DailyReportSection | undefined;
    let weekly: import('./types.ts').WeeklyReportSection | undefined;
    let setup: import('./types.ts').SetupReportSection | undefined;

    try {
      this.store.updateLoopTick(tickId, {
        step: mode === 'daily' ? 'scan' : mode === 'weekly' ? 'search' : 'enrich',
      });

      if (mode === 'daily') {
        const result = await runDailyMode(ctx);
        daily = result.section;
        channelsScanned = result.channelsScanned;
      } else if (mode === 'weekly') {
        const result = await runWeeklyMode(ctx);
        weekly = result.section;
        keywordsSearched = result.keywordsSearched;
        channelsProposed = result.channelsProposed;
        keywordsProposed = result.keywordsProposed;
        autoRejected = result.section.channelsRejectedLang;
      } else {
        const step = opts.setupStep ?? 'channels';
        const result = await runSetupMode(ctx, step);
        setup = result.section;
        keywordsSearched = result.keywordsSearched;
        channelsProposed = result.channelsProposed;
        keywordsProposed = result.keywordsProposed;
        autoRejected = result.section.channelsRejectedLang;
      }

      // Report phải nằm trên đĩa TRƯỚC khi tick done — cùng hợp đồng với
      // legacy (done mà không có report = report mất vĩnh viễn).
      this.store.updateLoopTick(tickId, {
        step: 'report',
        searchCallsUsed: charged().searchCalls,
        generalUnitsUsed: charged().generalUnits,
        keywordsSearchedJson: JSON.stringify(keywordsSearched),
      });
      const chargedAtReport = charged();
      const { summaryJson, markdown } = await buildV3Report(
        this.store, this.quota, topicId, day,
        {
          tickId,
          mode,
          startedAt: nowIso,
          searchCallsUsed: chargedAtReport.searchCalls,
          generalUnitsUsed: chargedAtReport.generalUnits,
          keywordsSearched,
          newCandidates: channelsProposed,
          newShortlistedAuto: 0,
          autoRejected,
          keywordsHarvested: keywordsProposed,
          daily,
          weekly,
          setup,
        },
      );
      this.store.insertDailyReportOnce({
        reportId: randomUUID(),
        reportDate: day,
        topicId,
        mode,
        summaryJson,
        markdown,
      });

      const finalCharged = charged();
      this.store.updateLoopTick(tickId, {
        status: 'done',
        step: 'report',
        searchCallsUsed: finalCharged.searchCalls,
        generalUnitsUsed: finalCharged.generalUnits,
        keywordsSearchedJson: JSON.stringify(keywordsSearched),
        newCandidates: channelsProposed,
        scannedChannels: channelsScanned,
        keywordsHarvested: keywordsProposed,
        error: null,
      });

      const counts = this.store.countTopicChannelsByStatus(topicId);
      return {
        tickId,
        topicId,
        quotaDay: day,
        mode,
        setupStep: opts.setupStep,
        status: 'done',
        dryRun: false,
        searchCallsUsed: finalCharged.searchCalls,
        generalUnitsUsed: finalCharged.generalUnits,
        newCandidates: channelsProposed,
        newShortlistedAuto: 0,
        pendingReview: counts['new'] ?? 0,
        autoRejected,
        keywordsSearched,
        keywordsHarvested: keywordsProposed,
        error: null,
        durationSec: Math.round((Date.now() - started) / 1000),
      };
    } catch (err) {
      const error = (err as Error).message;
      const chargedAtFailure = charged();
      this.store.updateLoopTick(tickId, {
        status: 'failed',
        error,
        searchCallsUsed: chargedAtFailure.searchCalls,
        generalUnitsUsed: chargedAtFailure.generalUnits,
        keywordsSearchedJson: JSON.stringify(keywordsSearched),
        newCandidates: channelsProposed,
      });
      throw err;
    } finally {
      CHARGEABLE_WORK_RUNNING = null;
    }
  }

  status(topicId: string): LoopStatus | null {
    const topicRow = this.store.getTopic(topicId);
    if (!topicRow) return null;

    const lastTick = this.store.getLastTick(topicId);
    const counts = this.store.countTopicChannelsByStatus(topicId);
    const kwRows = this.store.listTopicKeywords(topicId, 'pending');
    const quotaStatus = this.quota.status();
    const searchBucket = quotaStatus.buckets.find((b) => b.bucket === 'search');
    const generalBucket = quotaStatus.buckets.find((b) => b.bucket === 'general');

    const toBrief = (row: Record<string, unknown> | null): LoopTickBrief | null =>
      row ? {
        tickId: String(row['tick_id']),
        quotaDay: String(row['quota_day']),
        status: String(row['status']) as LoopTickBrief['status'],
        step: String(row['step']) as LoopTickBrief['step'],
        startedAt: String(row['started_at']),
        finishedAt: row['finished_at'] ? String(row['finished_at']) : null,
        error: row['error'] ? String(row['error']) : null,
      } : null;
    const lastTickByMode: LoopStatus['lastTickByMode'] = {};
    for (const mode of ['setup', 'daily', 'weekly'] as const) {
      const row = this.store.getLastTick(topicId, mode);
      if (row) lastTickByMode[mode] = toBrief(row);
    }

    return {
      topicId,
      topicLabel: String(topicRow['label']),
      topicStatus: String(topicRow['status']) as 'active' | 'paused' | 'archived',
      setupStatus: topicRow['setup_status'] ? String(topicRow['setup_status']) : undefined,
      lastTick: toBrief(lastTick ?? null),
      lastTickByMode,
      nextTickAt: null,
      inboxTotal: counts['new'] ?? 0,
      activeTotal: counts['active'] ?? 0,
      pausedTotal: counts['paused'] ?? 0,
      keywordsPending: kwRows.length,
      quota: {
        searchUsed: searchBucket?.used ?? 0,
        searchBudget: Number(topicRow['daily_search_budget']),
        searchRemainingDay: searchBucket?.remaining ?? 0,
        generalUsed: generalBucket?.used ?? 0,
        generalLimit: generalBucket?.limit ?? 10000,
      },
    };
  }

  listTopics() {
    return this.store.listTopics();
  }

  inbox(topicId: string, filter: { status?: string; limit?: number; cursor?: number } = {}) {
    return this.store.listTopicChannels(topicId, {
      status: filter.status,
      limit: filter.limit ?? 20,
      cursor: filter.cursor ?? 0,
    });
  }

  /**
   * Quyết định HITL của người duyệt — đường DUY NHẤT đổi status kênh sang
   * active|paused|rejected (về 'new' = undo). Đi qua decideChannel của hợp
   * đồng store để ghi decisions actor='human'.
   */
  decide(topicId: string, channelIds: string[], status: 'new' | 'active' | 'paused' | 'rejected') {
    for (const channelId of channelIds) {
      this.store.decideChannel(topicId, channelId, status, null);
    }
  }

  /**
   * Cold start đường 2 (§1.2): nạp các kênh ĐÃ có trong corpus (`channels` —
   * kênh từng spy thủ công) vào topic làm hạt giống.
   *
   * **0 quota tuyệt đối** — không chạm Data API, chỉ copy trong SQLite. Nhờ vậy
   * ngày đầu tiên đã có Inbox mà chưa tốn call search nào.
   */
  importCorpusChannelsToTopic(topicId: string): { imported: string[]; skipped: string[] } {
    const topicRow = this.store.getTopic(topicId);
    if (!topicRow) throw new AppError('not_found', `Topic '${topicId}' không tồn tại`);
    return this.store.importCorpusChannelsToTopic(topicId, String(topicRow['market']));
  }

  async report(topicId: string, date?: string, mode?: LoopMode) {
    const day = date ?? quotaDay();
    const row = this.store.getDailyReportByDate(topicId, day, mode);
    if (!row) return null;
    return {
      reportId: String(row['report_id']),
      topicId: String(row['topic_id']),
      reportDate: String(row['report_date']),
      summaryJson: String(row['summary_json']),
      markdown: String(row['markdown']),
      delivered: JSON.parse(String(row['delivered_json'])) as Record<string, string>,
    };
  }

  private makeSkippedResult(
    topicId: string,
    day: string,
    reason: string,
    mode?: LoopMode,
    setupStep?: SetupStep,
  ): TickResult {
    return {
      tickId: 'skipped',
      topicId,
      quotaDay: day,
      mode,
      setupStep,
      status: 'skipped_quota',
      dryRun: false,
      searchCallsUsed: 0,
      generalUnitsUsed: 0,
      newCandidates: 0,
      newShortlistedAuto: 0,
      pendingReview: 0,
      autoRejected: 0,
      keywordsSearched: [],
      keywordsHarvested: 0,
      error: reason,
      durationSec: 0,
    };
  }
}
