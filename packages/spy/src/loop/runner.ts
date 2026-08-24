/**
 * loop/runner.ts — LoopRunner: thực thi một tick/ngày/topic.
 *
 * Bước 0–4 + 7 (theo §2.1):
 *   0. Kiểm tra quota + idempotency (UNIQUE quota_day)
 *   1. EXPAND — mở rộng đồ thị từ kênh shortlisted/studied
 *   2. SEARCH — discoverVideos từng keyword theo ưu tiên
 *   3. ENRICH + SCORE — channels.list + playlistItems + videos.list + score
 *   4. AUTO-TRIAGE
 *   7. REPORT
 *
 * Checkpoint: ghi loop_ticks.step sau mỗi bước.
 * Resume: nếu tick cùng quota_day đã có → bỏ qua keyword đã searched hôm nay.
 * In-memory lock theo topicId.
 */
import { randomUUID } from 'node:crypto';
import type { SpyStore } from '../store.ts';
import type { QuotaLedger } from '../quota.ts';
import { quotaDay, quotaDayOf } from '../quota.ts';
import type { DiscoveryService } from '../discovery.ts';
import type { YouTubeDataApiPort } from '../adapters/data-api.ts';
import { scoreChannelFit } from '../niche.ts';
import { scoreFacelessHint } from '../faceless.ts';
import { evaluateChannelLanguage, type LanguageSampleVideo } from './language.ts';
import { scoreLearnValue } from '../learn-value.ts';
import { topicToNicheMarket, normalizeTermKey } from '../topic.ts';
import type { TopicConfig, FacelessVerdictPort } from './types.ts';
import { topicConfigSchema } from './types.ts';
import { planTick } from './planner.ts';
import type { TickResult, LoopStatus } from './types.ts';
import { buildDailyReport, renderReport } from './report.ts';
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
  discovery: DiscoveryService;
  dataApi: YouTubeDataApiPort;
  dataRoot: string;
  /**
   * Seam cho vòng agent vision (§3). P0 LUÔN undefined → runner bỏ qua hoàn
   * toàn bước tính verdict và `topic_channels.faceless_score` giữ NULL.
   * Khi port được implement, cắm vào đây là đủ — không phải sửa runner.
   */
  facelessJudge?: FacelessVerdictPort;
  /**
   * Hook quan sát checkpoint CÓ TÊN bên trong tick.
   *
   * Ném từ hook = mô phỏng tiến trình chết đúng tại điểm đó, dùng cho test
   * resume (G3). Checkpoint `search:before-term:<termKey>` nằm NGOÀI try/catch
   * của từng keyword — nếu đặt trong đó thì lỗi bị nuốt và tick vẫn chạy tiếp,
   * tức là không mô phỏng được cú chết thật.
   */
  checkpoint?: (name: string) => void | Promise<void>;
}

export class LoopRunner {
  private readonly store: SpyStore;
  private readonly quota: QuotaLedger;
  private readonly discovery: DiscoveryService;
  private readonly dataApi: YouTubeDataApiPort;
  private readonly dataRoot: string;
  private readonly facelessJudge: FacelessVerdictPort | undefined;
  private readonly checkpointHook: ((name: string) => void | Promise<void>) | undefined;

  constructor(opts: LoopRunnerOptions) {
    this.store = opts.store;
    this.quota = opts.quota;
    this.discovery = opts.discovery;
    this.dataApi = opts.dataApi;
    this.dataRoot = opts.dataRoot;
    this.facelessJudge = opts.facelessJudge;
    this.checkpointHook = opts.checkpoint;
  }

  /** Đi qua một checkpoint có tên. Lỗi từ hook được cố ý cho nổi lên. */
  private async reachCheckpoint(name: string): Promise<void> {
    if (this.checkpointHook) await this.checkpointHook(name);
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  async runTick(topicId: string, opts: { dryRun?: boolean; now?: Date } = {}): Promise<TickResult> {
    const now = opts.now ?? new Date();
    const day = quotaDay(now);

    // Lock toàn cục — xem chú thích ở CHARGEABLE_WORK_RUNNING.
    if (CHARGEABLE_WORK_RUNNING !== null) {
      throw new AppError(
        'invalid_input',
        CHARGEABLE_WORK_RUNNING === topicId
          ? `Topic '${topicId}' đang chạy tick, không chạy song song`
          : `Đang có tick chạy cho topic '${CHARGEABLE_WORK_RUNNING}'. P0 chạy tuần tự vì kế toán quota tính bằng hiệu số sổ — chạy song song sẽ báo sai số liệu.`,
      );
    }

    // Load topic config
    const topicRow = this.store.getTopic(topicId);
    if (!topicRow) throw new AppError('not_found', `Topic '${topicId}' không tồn tại`);

    const topic = topicConfigSchema.parse({
      topicId: String(topicRow['topic_id']),
      label: String(topicRow['label']),
      market: String(topicRow['market']),
      language: String(topicRow['language']),
      status: String(topicRow['status']),
      ownChannelIds: JSON.parse(String(topicRow['own_channel_ids_json'])) as string[],
      brief: String(topicRow['brief_md']),
      facelessRequired: Boolean(topicRow['faceless_required']),
      dailySearchBudget: Number(topicRow['daily_search_budget']),
      seedKeywords: [],
    });

    if (topic.status !== 'active') {
      return this.makeSkippedResult(topicId, day, `Topic ${topic.status}`);
    }

    // Dry-run
    const plan = planTick(this.store, this.quota, topicId, { now });
    if (opts.dryRun) {
      return {
        tickId: 'dry-run',
        topicId,
        quotaDay: day,
        status: 'done',
        dryRun: true,
        searchCallsUsed: 0,
        generalUnitsUsed: 0,
        newCandidates: 0,
        newShortlistedAuto: 0,
        pendingReview: 0,
        autoRejected: 0,
        keywordsSearched: plan.keywordsToSearch,
        keywordsHarvested: 0,
        error: plan.canProceed ? null : plan.blockers.join('; '),
        durationSec: 0,
      };
    }

    if (!plan.canProceed && this.quota.remaining('search', now) === 0) {
      return this.makeSkippedResult(topicId, day, plan.blockers.join('; '));
    }

    // Idempotency — UNIQUE(topic_id, quota_day)
    let tickId: string = randomUUID();
    const started = Date.now();
    // Mốc sổ quota lúc tick bắt đầu — mọi con số "đã tiêu" của tick đều tính từ
    // đây, thay vì tự cộng ước lượng ở từng chỗ gọi.
    let searchBaselineCalls = this.store.getQuotaUsage('search', day).calls;
    let generalBaselineUnits = this.store.getQuotaUsage('general', day).units;
    const inserted = this.store.insertLoopTick({
      tickId, topicId, quotaDay: day, searchBaselineCalls, generalBaselineUnits,
    });
    if (!inserted) {
      const existing = this.store.getTickByDay(topicId, day);
      if (existing && String(existing['status']) === 'done') {
        return this.makeSkippedResult(topicId, day, 'Tick hôm nay đã hoàn thành');
      }
      if (existing) {
        // RESUME giữ mốc GỐC: phần quota đã tiêu trước khi chết vẫn thuộc về tick
        // này. Lấy mốc mới ở đây sẽ báo cáo thiếu đúng phần đã tiêu lần trước.
        searchBaselineCalls = Number(existing['search_baseline_calls'] ?? 0);
        generalBaselineUnits = Number(existing['general_baseline_units'] ?? 0);
        // RESUME: nhận lại đúng tick_id cũ. Nếu giữ id mới vừa random thì mọi
        // updateLoopTick sau đó cập nhật 0 dòng — tick cũ kẹt 'failed'/'running'
        // vĩnh viễn dù lần chạy này hoàn tất, và checkpoint mất sạch.
        tickId = String(existing['tick_id']);
        this.store.updateLoopTick(tickId, { status: 'running', error: null });
      }
    }

    CHARGEABLE_WORK_RUNNING = topicId;
    const keywordsSearched: string[] = [];
    let newCandidates = 0;
    let newShortlistedAuto = 0;
    let autoRejected = 0;
    let keywordsHarvested = 0;

    const { niche, market } = topicToNicheMarket(topic);

    /**
     * Số quota tick này ĐÃ BỊ TÍNH, đọc thẳng từ sổ.
     *
     * Không đếm tay ở từng chỗ gọi: decorator charge TRƯỚC khi gửi request, nên
     * một request lỗi vẫn vào sổ trong khi `++counter` sau khi thành công thì
     * không — report sẽ báo tiêu ÍT hơn thực tế và người đọc tưởng còn ngân sách.
     * Đọc hiệu số với mốc đầu tick bắt được cả call lỗi, call nằm sâu trong
     * discovery, lẫn phần đã tiêu trước khi resume.
     *
     * Giới hạn đã biết: nếu hai tick CHỒNG NHAU trong cùng quota-day thì hiệu số
     * này lẫn của nhau. Khoá theo topic KHÔNG đủ để chặn — hai topic khác nhau
     * vẫn chạy đồng thời được — nên P0 dùng khoá TOÀN CỤC
     * (`CHARGEABLE_WORK_RUNNING`). Muốn chạy song song thì phải chuyển sang
     * charge event mang tick_id trước, xem chú thích ở khoá đó.
     */
    const charged = (): { searchCalls: number; generalUnits: number } => ({
      searchCalls: Math.max(0, this.store.getQuotaUsage('search', day).calls - searchBaselineCalls),
      generalUnits: Math.max(0, this.store.getQuotaUsage('general', day).units - generalBaselineUnits),
    });

    try {
      // --- Bước 1: EXPAND ---
      this.store.updateLoopTick(tickId, { step: 'expand' });
      await this.reachCheckpoint('expand:start');
      const channelsToExpand = plan.channelsToExpand;
      if (channelsToExpand.length > 0 && this.dataApi.fetchFeaturedChannels) {
        try {
          const expandResult = await this.discovery.expandGraph(niche, { channelIds: channelsToExpand, maxSeeds: 20 });
          // Record sources
          for (const channelId of channelsToExpand) {
            this.store.addTopicChannelSource({ topicId, channelId, relation: 'graph', fromChannelId: channelId });
          }
        } catch (err) {
          // Non-fatal — log and continue
          console.warn(`[loop/${topicId}] expand error: ${(err as Error).message}`);
        }
      }


      // --- Bước 2: SEARCH ---
      this.store.updateLoopTick(tickId, { step: 'search' });
      await this.reachCheckpoint('search:start');
      const allKeywords = this.store.listTopicKeywords(topicId);
      const keywordsToSearch = plan.keywordsToSearch;
      const newChannelIds = new Set<string>();

      for (const termKey of keywordsToSearch) {
        if (this.quota.remaining('search', now) <= 0) break;
        const kwRow = allKeywords.find((k) => String(k['term_key']) === termKey);
        const displayTerm = kwRow ? String(kwRow['display_term']) : termKey;

        // Skip nếu đã searched trong CÙNG QUOTA-DAY (resume).
        //
        // Phải quy last_searched_at (ISO UTC) về quota-day Pacific rồi mới so.
        // So bằng `startsWith(day)` là sai: từ 16:00 Pacific trở đi, UTC đã sang
        // ngày mới nên chuỗi không bao giờ khớp, và mỗi lần restart trong khung
        // giờ đó sẽ search lại toàn bộ keyword — đốt đúng cái bucket khan hiếm
        // nhất, đúng lúc tick hằng ngày (15:30 VN) hay chạy.
        const lastSearched = kwRow ? String(kwRow['last_searched_at'] ?? '') : '';
        if (quotaDayOf(lastSearched) === day) continue;

        // Checkpoint NGOÀI try/catch: keyword trước đã persist xong, keyword này
        // chưa bắt đầu. Ném ở đây làm hỏng cả tick — đúng như tiến trình bị giết.
        await this.reachCheckpoint(`search:before-term:${termKey}`);

        try {
          const order = keywordsSearched.length % 2 === 0 ? 'viewCount' : 'relevance';
          const result = await this.discovery.discoverVideos(niche, {
            query: displayTerm,
            marketId: market.id,
            order,
            maxResults: 50,
            publishedAfter: new Date(Date.now() - 548 * 86_400_000).toISOString(),
          });
          keywordsSearched.push(termKey);

          // Ghi sources
          const channelIdsFromSearch: string[] = [];
          if (result && 'videos' in result) {
            for (const v of (result as any).videos ?? []) {
              if (v.channelId) {
                newChannelIds.add(v.channelId);
                channelIdsFromSearch.push(v.channelId);
                this.store.addTopicChannelSource({
                  topicId,
                  channelId: v.channelId,
                  relation: 'search_video',
                  termKey,
                });
              }
            }
          }
          // Mark keyword searched
          this.store.markKeywordSearched(topicId, termKey, channelIdsFromSearch.length);
        } catch (err) {
          console.warn(`[loop/${topicId}] search '${termKey}' error: ${(err as Error).message}`);
        }
      }

      // Cập nhật checkpoint
      this.store.updateLoopTick(tickId, {
        step: 'enrich',
        searchCallsUsed: charged().searchCalls,
        generalUnitsUsed: charged().generalUnits,
        keywordsSearchedJson: JSON.stringify(keywordsSearched),
      });

      // --- Bước 3: ENRICH + SCORE ---
      await this.reachCheckpoint('enrich:start');
      // Kênh bị loại vì ngôn ngữ trong tick này — dùng để không đếm trùng ở triage.
      const langRejected = new Set<string>();
      // Lấy all topic_channels có status=new chưa được scored
      const unscoredChannels = this.store.listTopicChannels(topicId, { status: 'new', limit: 100 });
      const channelIdsToEnrich = [
        ...new Set([
          ...unscoredChannels.map((r) => String(r['channel_id'])),
          ...Array.from(newChannelIds),
        ]),
      ].slice(0, 100);

      if (channelIdsToEnrich.length > 0) {
        const channelStats = await this.dataApi.fetchChannelStatistics(channelIdsToEnrich);

        for (const [channelId, stats] of channelStats) {
          // Upsert vào candidate_channels
          this.store.upsertCandidate({
            channelId,
            title: stats.title,
            market: topic.market,
            discoveredVia: 'search_video',
            subscriberCount: stats.subscriberCount,
            videoCount: stats.videoCount,
            viewCount: null,
            country: stats.country,
            publishedAt: stats.publishedAt,
            description: null,
          });

          // Enrich 12 video mới nhất qua playlistItems.
          // Thumbnail được LƯU (≤6) cho lưới review trong Inbox — không phải để
          // chấm faceless. Verdict vision vẫn thuộc vòng thiết kế riêng (§3).
          const thumbnailUrls: string[] = [];
          const videoData: Array<{ viewCount: number | null; publishedAt: string | null }> = [];
          const videoTitles: string[] = [];
          const langSample: LanguageSampleVideo[] = [];

          if (stats.uploadsPlaylistId && this.dataApi.listUploadsPlaylistItems) {
            try {
              const items = await this.dataApi.listUploadsPlaylistItems(stats.uploadsPlaylistId, 12);

              const videoIds = items.map((it) => it.videoId).filter(Boolean);
              if (videoIds.length > 0) {
                const videoStats = await this.dataApi.fetchVideoStatistics(videoIds);

                // Mẫu ngôn ngữ đi theo TOÀN BỘ slot đã chọn (≤12), không theo số
                // row mà videos.list trả về. Nếu chỉ đẩy row có thật thì một
                // response thiếu row biến mẫu 12 thành mẫu 1: một video tiếng Anh
                // duy nhất thành "100% khai báo, đa số en" và kênh Việt bị loại
                // vĩnh viễn. Slot thiếu row = slot KHÔNG khai báo, mẫu số giữ nguyên.
                for (const item of items) {
                  if (!item.videoId) continue;
                  const vs = videoStats.get(item.videoId);
                  langSample.push({
                    title: vs?.title ?? item.title ?? null,
                    defaultAudioLanguage: vs?.defaultAudioLanguage ?? null,
                    defaultLanguage: vs?.defaultLanguage ?? null,
                  });
                  if (!vs) continue;
                  videoData.push({ viewCount: vs.viewCount, publishedAt: vs.publishedAt });
                  if (vs.title) videoTitles.push(vs.title);
                  if (vs.thumbnailUrl && thumbnailUrls.length < 6) thumbnailUrls.push(vs.thumbnailUrl);
                }
              }
            } catch {
              // Non-fatal
            }
          }

          // --- LANGUAGE post-filter (§2.1 bước 3) ---
          // Chỉ `evaluateChannelLanguage` mới được quyết định reject. Không đọc
          // stats.country ở đây: country là prior yếu, reject theo nó là sai.
          const langVerdict = evaluateChannelLanguage(langSample, topic.language);

          // Score fit
          const fitResult = scoreChannelFit(
            {
              channelId,
              title: stats.title,
              description: stats.description,
              subscriberCount: stats.subscriberCount,
              videoCount: stats.videoCount,
              viewCount: stats.viewCount,
              country: stats.country,
              publishedAt: stats.publishedAt,
            },
            niche,
            market,
          );

          // Faceless: CHỈ phỏng đoán từ chữ. Verdict (faceless_score) để NULL cho
          // tới khi có FacelessVerdictPort — hint không bao giờ được nâng cấp
          // thành verdict, kể cả khi nó rất cao.
          const facelessHint = scoreFacelessHint({
            channelTitle: stats.title ?? channelId,
            description: stats.description,
            videoTitles,
          });

          // Score learn value
          const ownChannelIds = topic.ownChannelIds;
          let ownMedianViews: number | null = null;
          if (ownChannelIds.length > 0) {
            // Lấy từ DB nếu đã có metrics; hiện dùng placeholder
            ownMedianViews = null;
          }
          const learnResult = scoreLearnValue(
            {
              videos: videoData,
              subscriberCount: stats.subscriberCount,
              channelCreatedAt: stats.publishedAt,
            },
            { medianViews: ownMedianViews },
            { medianViews: null },
          );

          // Upsert topic_channel — faceless_score LUÔN null ở P0 (§3).
          this.store.upsertTopicChannel({
            topicId,
            channelId,
            fitScore: fitResult.score,
            fitReasonsJson: JSON.stringify(fitResult.reasons),
            facelessScore: null,
            facelessHint: facelessHint.hint,
            facelessHintReasonsJson: JSON.stringify({
              method: facelessHint.method,
              reasons: facelessHint.reasons,
            }),
            thumbnailsJson: JSON.stringify(thumbnailUrls),
            learnValueScore: learnResult.score,
            // §7: điểm nào cũng phải nói được vì sao và đo trên mẫu bao nhiêu.
            learnValueReasonsJson: JSON.stringify({
              method: learnResult.method,
              sampleSize: learnResult.sampleSize,
              reasons: learnResult.reasons,
            }),
            status: 'new',
            langDetected: langVerdict.langDetected,
            langConfidence: langVerdict.langConfidence,
            langEvidenceJson: JSON.stringify({
              method: langVerdict.method,
              decisive: langVerdict.decisive,
              evidenceField: langVerdict.evidenceField,
              declaredByField: langVerdict.declaredByField,
              declaredCounts: langVerdict.declaredCounts,
              declaredCount: langVerdict.declaredCount,
              sampleSize: langVerdict.sampleSize,
              majority: langVerdict.langDetected,
            }),
          });
          newCandidates++;

          // Reject ngôn ngữ ngay tại đây: chỉ xảy ra ở nhánh 'declared_fields'
          // (≥50% video khai báo và đa số lệch topic.language).
          if (langVerdict.reject) {
            this.store.decideTopicChannels(topicId, [channelId], 'rejected', 'loop_auto', 'lang_mismatch');
            langRejected.add(channelId);
            autoRejected++;
          }
        }
      }

      // --- Bước 4: AUTO-TRIAGE ---
      this.store.updateLoopTick(tickId, {
        step: 'triage', newCandidates,
        searchCallsUsed: charged().searchCalls,
        generalUnitsUsed: charged().generalUnits,
      });
      await this.reachCheckpoint('triage:start');
      const allNew = this.store.listTopicChannels(topicId, { status: 'new', limit: 200 });

      // Luật §2.1 bước 4 — cố ý hẹp:
      //   shortlist khi fit ≥ 70 VÀ learn_value ≥ 50
      //   reject   khi fit < 30 HOẶC lang_mismatch (đã xử lý ở bước 3)
      //   faceless_hint KHÔNG tham gia triage — nó là phỏng đoán từ chữ, dùng
      //   nó để loại kênh là loại nhầm kênh faceless viết title kiểu vlog.
      for (const row of allNew) {
        const fit = row['fit_score'] === null ? null : Number(row['fit_score']);
        const learn = row['learn_value_score'] === null ? null : Number(row['learn_value_score']);
        const channelId = String(row['channel_id']);

        let newStatus: string | null = null;
        let reason: string | null = null;

        if (fit !== null && fit >= 70 && learn !== null && learn >= 50) {
          newStatus = 'shortlisted';
          reason = 'fit_learn_auto';
          newShortlistedAuto++;
        } else if (fit !== null && fit < 30) {
          newStatus = 'rejected';
          reason = 'low_fit';
          if (!langRejected.has(channelId)) autoRejected++;
        }

        if (newStatus) {
          this.store.decideTopicChannels(topicId, [channelId], newStatus, 'loop_auto', reason);
        }
      }

      // Skip bước 5 (SCAN) và 6 (HARVEST) ở P0 theo spec.

      // --- Bước 7: REPORT ---
      //
      // THỨ TỰ Ở ĐÂY LÀ MỘT HỢP ĐỒNG, đừng đảo lại: report phải nằm trên đĩa
      // TRƯỚC khi tick được đánh `done`. Nếu set `done` trước rồi mới build,
      // một cú chết ở giữa để lại tick `done` vĩnh viễn mà không có report —
      // và lần chạy sau sẽ skip vì thấy `done`, nên report mất luôn, không bao
      // giờ tự khôi phục. Lỗi ở bước report cũng KHÔNG được nuốt: nuốt lỗi là
      // tạo ra đúng trạng thái "done nhưng rỗng" đó bằng một đường khác.
      this.store.updateLoopTick(tickId, {
        step: 'report',
        newShortlistedAuto,
        searchCallsUsed: charged().searchCalls,
        generalUnitsUsed: charged().generalUnits,
      });
      await this.reachCheckpoint('report:start');
      const counts = this.store.countTopicChannelsByStatus(topicId);

      const reportDate = day;
      const chargedAtReport = charged();
      const { summaryJson, markdown } = await buildDailyReport(
        this.store, this.quota, topicId, reportDate,
        {
          tickId,
          searchCallsUsed: chargedAtReport.searchCalls,
          generalUnitsUsed: chargedAtReport.generalUnits,
          keywordsSearched,
          newCandidates,
          newShortlistedAuto,
          autoRejected,
          keywordsHarvested,
        },
      );
      await this.reachCheckpoint('report:before-persist');
      // Idempotent: chạy lại sau crash không sinh report thứ hai.
      this.store.insertDailyReportOnce({
        reportId: randomUUID(),
        reportDate,
        topicId,
        summaryJson,
        markdown,
      });
      await this.reachCheckpoint('report:persisted');

      // Chỉ tới đây tick mới được coi là xong.
      const finalCharged = charged();
      this.store.updateLoopTick(tickId, {
        status: 'done',
        step: 'report',
        searchCallsUsed: finalCharged.searchCalls,
        generalUnitsUsed: finalCharged.generalUnits,
        keywordsSearchedJson: JSON.stringify(keywordsSearched),
        newCandidates,
        newShortlistedAuto,
        keywordsHarvested,
        error: null,
      });

      return {
        tickId,
        topicId,
        quotaDay: day,
        status: 'done',
        dryRun: false,
        searchCallsUsed: finalCharged.searchCalls,
        generalUnitsUsed: finalCharged.generalUnits,
        newCandidates,
        newShortlistedAuto,
        pendingReview: counts['new'] ?? 0,
        autoRejected,
        keywordsSearched,
        keywordsHarvested,
        error: null,
        durationSec: Math.round((Date.now() - started) / 1000),
      };
    } catch (err) {
      const error = (err as Error).message;
      // Tick lỗi vẫn phải khai đúng số quota đã bị tính — "chết giữa chừng"
      // không xoá được những call đã gửi đi.
      const chargedAtFailure = charged();
      this.store.updateLoopTick(tickId, {
        status: 'failed',
        error,
        searchCallsUsed: chargedAtFailure.searchCalls,
        generalUnitsUsed: chargedAtFailure.generalUnits,
        keywordsSearchedJson: JSON.stringify(keywordsSearched),
        newCandidates,
        newShortlistedAuto,
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

    return {
      topicId,
      topicLabel: String(topicRow['label']),
      topicStatus: String(topicRow['status']) as 'active' | 'paused' | 'archived',
      lastTick: lastTick ? {
        tickId: String(lastTick['tick_id']),
        quotaDay: String(lastTick['quota_day']),
        status: String(lastTick['status']) as any,
        step: String(lastTick['step']) as any,
        startedAt: String(lastTick['started_at']),
        finishedAt: lastTick['finished_at'] ? String(lastTick['finished_at']) : null,
        error: lastTick['error'] ? String(lastTick['error']) : null,
      } : null,
      nextTickAt: null,
      inboxTotal: counts['new'] ?? 0,
      shortlistedTotal: counts['shortlisted'] ?? 0,
      studiedTotal: counts['studied'] ?? 0,
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

  decide(topicId: string, channelIds: string[], status: 'shortlisted' | 'rejected' | 'new') {
    this.store.decideTopicChannels(topicId, channelIds, status, 'user');
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

  async report(topicId: string, date?: string) {
    const day = date ?? quotaDay();
    const row = this.store.getDailyReportByDate(topicId, day);
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

  private makeSkippedResult(topicId: string, day: string, reason: string): TickResult {
    return {
      tickId: 'skipped',
      topicId,
      quotaDay: day,
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
