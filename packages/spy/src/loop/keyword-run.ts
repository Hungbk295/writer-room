/**
 * loop/keyword-run.ts — Spy Keyword Run (plan spy-keyword-run-board §2):
 * search theo yêu cầu của NGƯỜI trên một nhóm keyword, KHÔNG phải nhịp loop.
 *
 * Khác weekly: run do người bấm (có thể chọn mọi status, không xoay budget),
 * tiến độ ghi keyword_runs/keyword_run_items để board poll, và video search
 * của kênh follow ghi source='keyword_run' — KHÔNG đủ điều kiện baseline nên
 * video search-view-cao không đẩy baseline kênh lên. Kênh ngoài follow được đo
 * qua scanOutsideChannels: uploads ghi 'outside_scan', lượt đo ghi
 * measured_channels(discovered_via='keyword_run').
 *
 * Chia sẻ runKeywordSearches/scanOutsideChannels của W1/W3 và khoá toàn cục
 * CHARGEABLE_WORK_RUNNING của runner (kế toán quota bằng hiệu số sổ — hai
 * việc chạy song song sẽ đếm sai im lặng, xem runner.ts).
 */
import { randomUUID } from 'node:crypto';
import { quotaDay } from '../quota.ts';
import { topicToNicheMarket } from '../topic.ts';
import { AppError } from '../errors.ts';
import { topicConfigSchema } from './types.ts';
import type { RunTrigger, SpyStore, TopicKeywordRow } from '../store.ts';
import type { QuotaLedger } from '../quota.ts';
import type { YouTubeDataApiPort } from '../adapters/data-api.ts';
import type { ModeContext } from './modes.ts';
import { runKeywordSearches, scanOutsideChannels } from './modes.ts';
import { acquireChargeableWork, releaseChargeableWork } from './runner.ts';

export interface KeywordRunParams {
  publishedAfterDays: number;
  maxResults: number;
  scanChannelsCap: number;
}

export interface KeywordRunServiceOptions {
  store: SpyStore;
  quota: QuotaLedger;
  dataApi: YouTubeDataApiPort;
}

export class KeywordRunService {
  private readonly store: SpyStore;
  private readonly quota: QuotaLedger;
  private readonly dataApi: YouTubeDataApiPort;

  constructor(opts: KeywordRunServiceOptions) {
    this.store = opts.store;
    this.quota = opts.quota;
    this.dataApi = opts.dataApi;
  }

  /**
   * Resolve danh sách keyword của run theo 1 trong 3 cách:
   * termKeys trực tiếp | lọc theo group_key | theo status (mặc định 'active').
   * Trả TopicKeywordRow[] đã dedupe theo term_key, giữ thứ tự input.
   */
  resolveKeywords(
    topicId: string,
    filter: { termKeys?: string[]; group?: string; status?: string },
  ): TopicKeywordRow[] {
    if (filter.termKeys && filter.termKeys.length > 0) {
      const all = new Map(
        this.store.listKeywordsByStatus(topicId, ['pending', 'active', 'paused', 'rejected'])
          .map((k) => [k.termKey, k]),
      );
      const out: TopicKeywordRow[] = [];
      for (const key of filter.termKeys) {
        const row = all.get(key);
        if (row && !out.some((k) => k.termKey === key)) out.push(row);
      }
      return out;
    }
    if (filter.group !== undefined) {
      return this.store.listTopicKeywordsByGroup(topicId, filter.group);
    }
    return this.store.listKeywordsByStatus(topicId, [filter.status ?? 'active']);
  }

  /**
   * Chạy một run đã được tạo sẵn trong keyword_runs (status='running').
   * Route gọi `void svc.execute(...)` — hàm này tự kết thúc run:
   * done | skipped_quota (quota cạn giữa chừng) | failed | cancelled (mất khoá).
   */
  async execute(
    runId: string,
    topicId: string,
    keywords: TopicKeywordRow[],
    params: KeywordRunParams,
  ): Promise<void> {
    const { store, quota } = this;
    const now = new Date();
    const day = quotaDay(now);
    const nowIso = now.toISOString();

    try {
      acquireChargeableWork(`keyword_run:${runId}`);
    } catch (error) {
      store.updateKeywordRun(runId, {
        status: 'cancelled',
        finishedAt: nowIso,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    try {
      const topicRow = store.getTopic(topicId);
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
      const { market } = topicToNicheMarket(topic);
      if (topic.region) market.regionCode = topic.region;

      const ctx: ModeContext = {
        store,
        quota,
        dataApi: this.dataApi,
        topicId,
        language: topic.language,
        regionCode: market.regionCode,
        settings: store.getTopicSettings(topicId),
        tickId: runId,
        day,
        nowIso,
      };

      // Kế toán hiệu số sổ giống runner.charged() — cần khoá toàn cục.
      const searchBaselineCalls = store.getQuotaUsage('search', day).calls;
      const generalBaselineUnits = store.getQuotaUsage('general', day).units;
      const charged = () => ({
        searchCalls: Math.max(0, store.getQuotaUsage('search', day).calls - searchBaselineCalls),
        generalUnits: Math.max(0, store.getQuotaUsage('general', day).units - generalBaselineUnits),
      });

      let keywordsDone = 0;
      let nNew = 0;
      let nSkipped = 0;
      const w1 = await runKeywordSearches(ctx, keywords, {
        publishedAfterDays: params.publishedAfterDays,
        maxResults: params.maxResults,
        runId,
        videoSource: 'keyword_run',
        onItem: (item) => {
          store.insertKeywordRunItem({
            runId,
            termKey: item.termKey,
            status: item.status,
            nResults: item.nResults,
            nFollowed: item.nFollowed,
            medianViews: item.medianViews,
            outliersFound: item.outliersInFollow,
            error: item.error,
            nNew: item.nNew,
            skipReason: item.skipReason,
          });
          keywordsDone++;
          nNew += item.nNew ?? 0;
          if (item.status === 'skipped_dedup') nSkipped++;
          const used = charged();
          store.updateKeywordRun(runId, {
            keywordsDone,
            searchCallsUsed: used.searchCalls,
            generalUnitsUsed: used.generalUnits,
            nNew,
            nSkipped,
          });
        },
      });

      // Quét kênh ngoài follow sau khi search xong — cap của riêng run.
      const w3 = await scanOutsideChannels(ctx, w1.outsideHits, params.scanChannelsCap, {
        videoSource: 'keyword_run',
      });

      // Đếm outlier theo keyword: hit follow (đã ghi từng bước) + kênh ngoài
      // vừa đề xuất — update lại item của keyword tương ứng.
      const proposedByTerm = new Map<string, number>();
      for (const p of w3.proposed) {
        proposedByTerm.set(p.foundByKeyword, (proposedByTerm.get(p.foundByKeyword) ?? 0) + 1);
      }
      for (const item of w1.items) {
        const extra = proposedByTerm.get(item.termKey) ?? 0;
        if (extra === 0) continue;
        store.insertKeywordRunItem({
          runId,
          termKey: item.termKey,
          status: item.status,
          nResults: item.nResults,
          nFollowed: item.nFollowed,
          medianViews: item.medianViews,
          outliersFound: item.outliersInFollow + extra,
          error: item.error,
          nNew: item.nNew,
          skipReason: item.skipReason,
        });
      }

      const used = charged();
      const quotaExhausted = w1.items.some((i) => i.status === 'skipped_quota');
      store.updateKeywordRun(runId, {
        status: quotaExhausted ? 'skipped_quota' : 'done',
        keywordsDone,
        searchCallsUsed: used.searchCalls,
        generalUnitsUsed: used.generalUnits,
        newCandidates: w3.proposed.length,
        finishedAt: new Date().toISOString(),
      });
    } catch (error) {
      store.updateKeywordRun(runId, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      releaseChargeableWork(`keyword_run:${runId}`);
    }
  }

  /** Tạo run mới + bắn async — trả runId cho route trả về ngay. */
  startRun(
    topicId: string,
    keywords: TopicKeywordRow[],
    params: KeywordRunParams,
    paramsJson: string,
    card: { note?: string | null; groupKey?: string | null; triggeredBy?: RunTrigger } = {},
  ): string {
    const runId = randomUUID();
    this.store.createKeywordRun({
      runId,
      topicId,
      paramsJson,
      nKeywords: keywords.length,
      startedAt: new Date().toISOString(),
      type: 'discover',
      note: card.note ?? null,
      groupKey: card.groupKey ?? null,
      triggeredBy: card.triggeredBy ?? 'human',
    });
    void this.execute(runId, topicId, keywords, params);
    return runId;
  }
}
