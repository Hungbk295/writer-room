/**
 * loop/modes.ts — ba nhịp của Spy Pipeline v3-lean (plan §2).
 *
 *   daily  — D1–D5: KHÔNG search. Quét kênh active (playlistItems + videos.list),
 *            snapshot views/ngày, baseline/outlier/gained, suggestion pause_silent.
 *   weekly — W1–W5: search ≤ weekly_keyword_budget keyword xoay theo
 *            last_checked_at, publishedAfter 28 ngày; outlier trong/ngoài follow;
 *            n-gram từ outlier → keyword pending.
 *   setup  — S2: seed keyword → kênh new → setup_status='awaiting_channels'.
 *            S3: n-gram từ kênh active → keyword pending → 'awaiting_keywords'.
 *
 * LUẬT BẤT BIẾN HITL: các hàm này chỉ được ghi status 'new' (qua
 * upsertTopicChannelCandidate), 'pending' (upsertKeywordCandidate), 'rejected'
 * DUY NHẤT với lý do lang_mismatch (rejectChannelForLanguage), và suggestion.
 * active/paused/rejected khác chỉ qua endpoint duyệt với actor='human' —
 * không một dòng code nào ở đây được phép chuyển status đó.
 */
import { median } from '../metrics/stats.ts';
import { evaluateChannelLanguage, type LanguageSampleVideo } from './language.ts';
import {
  baselineOf,
  harvestNgrams,
  outlierScore,
  viewsGained24h,
  type BaselineVideoInput,
} from './metrics.ts';
import type { SpyStore } from '../store.ts';
import type { VideoStatistics, YouTubeDataApiPort } from '../adapters/data-api.ts';
import type { QuotaLedger } from '../quota.ts';
import type {
  DailyReportSection,
  SetupReportSection,
  SetupStep,
  WeeklyReportSection,
} from './types.ts';
import type {
  TopicChannelRow,
  TopicSettings,
  TopicVideoRow,
} from '../store.ts';

/** Ngữ cảnh một tick — runner dựng sẵn rồi gọi mode tương ứng. */
export interface ModeContext {
  store: SpyStore;
  quota: QuotaLedger;
  dataApi: YouTubeDataApiPort;
  topicId: string;
  /** Ngôn ngữ topic (topics.language) — cổng post-filter. */
  language: string;
  /** ISO 3166-1 đã resolve theo ADR-7 (topic.region, rỗng → derive cũ). */
  regionCode: string;
  settings: TopicSettings;
  tickId: string;
  /** quota-day Pacific của tick — khoá snapshot video_daily_views. */
  day: string;
  nowIso: string;
}

const DAY_MS = 86_400_000;
/** Setup không có budget riêng trong plan — trần phòng seed list phình bất thường. */
const SETUP_CHANNEL_SCAN_CAP = 100;
/** Số video quét để dựng baseline của kênh mới (plan S2: 30 video). */
const CHANNEL_BASELINE_SCAN = 30;

// ---------------------------------------------------------------------------
// Helpers chung
// ---------------------------------------------------------------------------

function rowChannelId(row: TopicChannelRow): string {
  return row.channelId;
}

/** Map TopicVideoRow → input của baselineOf. */
function toBaselineInputs(videos: readonly TopicVideoRow[]): BaselineVideoInput[] {
  return videos.map((v) => ({
    views: v.latestViews,
    durationSec: v.durationSec,
    publishedAt: v.publishedAt,
  }));
}

/**
 * Quét video mới nhất của một kênh qua uploads playlist + videos.list.
 * Trả video đủ metadata để upsert topic_videos + mẫu ngôn ngữ. Lỗi từng kênh
 * được nuốt ở đây — một kênh hỏng playlist không được làm chết cả tick.
 */
interface ChannelScan {
  items: Array<{ videoId: string; publishedAt: string | null; title: string | null }>;
  stats: Map<string, VideoStatistics>;
  langSample: LanguageSampleVideo[];
}

async function scanChannelVideos(
  ctx: ModeContext,
  uploadsPlaylistId: string | null,
  limit: number,
): Promise<ChannelScan> {
  const empty: ChannelScan = { items: [], stats: new Map(), langSample: [] };
  if (!uploadsPlaylistId || !ctx.dataApi.listUploadsPlaylistItems) return empty;
  try {
    const items = (await ctx.dataApi.listUploadsPlaylistItems(uploadsPlaylistId, limit))
      .filter((it) => Boolean(it.videoId))
      .map((it) => ({ videoId: it.videoId, publishedAt: it.publishedAt, title: it.title }));
    if (items.length === 0) return empty;
    const stats = await ctx.dataApi.fetchVideoStatistics(items.map((i) => i.videoId));
    // Mẫu ngôn ngữ theo TOÀN BỘ slot đã chọn — slot thiếu row = không khai báo,
    // giữ nguyên cỡ mẫu để evaluateChannelLanguage không kết luận trên mẫu bị
    // co lại (xem comment tương tự trong runner.ts legacy).
    const langSample: LanguageSampleVideo[] = items.map((item) => {
      const vs = stats.get(item.videoId);
      return {
        title: vs?.title ?? item.title ?? null,
        defaultAudioLanguage: vs?.defaultAudioLanguage ?? null,
        defaultLanguage: vs?.defaultLanguage ?? null,
      };
    });
    return { items, stats, langSample };
  } catch {
    return empty;
  }
}

function newestPublishedAt(
  items: ReadonlyArray<{ publishedAt: string | null }>,
): string | null {
  let best: string | null = null;
  let bestT = Number.NEGATIVE_INFINITY;
  for (const it of items) {
    const t = it.publishedAt ? Date.parse(it.publishedAt) : Number.NaN;
    if (Number.isFinite(t) && t > bestT) {
      bestT = t;
      best = it.publishedAt;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// DAILY — D1–D5 (plan §2.2). KHÔNG một call search nào (acceptance §6.3).
// ---------------------------------------------------------------------------

export interface DailyModeResult {
  section: DailyReportSection;
  channelsScanned: number;
}

export async function runDailyMode(ctx: ModeContext): Promise<DailyModeResult> {
  const { store, settings } = ctx;
  // D2: chỉ kênh 'active' — follow list do người duyệt duyệt, không do loop tự thêm.
  const channels = store.listTopicChannelsByStatus(ctx.topicId, ['active']);
  const channelIds = channels.map(rowChannelId);
  const statsByChannel = channelIds.length
    ? await ctx.dataApi.fetchChannelStatistics(channelIds)
    : new Map();

  const section: DailyReportSection = {
    newVideos: 0,
    channelsScanned: 0,
    channelsChecked: 0,
    topGained24h: [],
    topOutliers: [],
    suggestions: [],
  };

  const gained: DailyReportSection['topGained24h'] = [];
  const outliers: DailyReportSection['topOutliers'] = [];

  for (const row of channels) {
    const channelId = rowChannelId(row);
    const chStats = statsByChannel.get(channelId) ?? null;
    const channelTitle = chStats?.title ?? row.title ?? channelId;
    section.channelsChecked++;

    const scanned = await scanChannelVideos(
      ctx,
      chStats?.uploadsPlaylistId ?? null,
      settings.dailyScanPerChannel,
    );

    // --- upsert video + snapshot ngày ---
    let scannedNewVideos = 0;
    const seenVideoIds: string[] = [];
    for (const item of scanned.items) {
      const vs = scanned.stats.get(item.videoId);
      if (!vs) continue;
      seenVideoIds.push(item.videoId);
      store.upsertTopicVideo({
        topicId: ctx.topicId,
        videoId: item.videoId,
        channelId,
        title: vs.title ?? item.title ?? item.videoId,
        publishedAt: vs.publishedAt ?? item.publishedAt,
        durationSec: vs.durationSec,
        thumbnailUrl: vs.thumbnailUrl,
        source: 'daily_scan',
        views: vs.viewCount,
        likes: vs.likeCount,
        comments: vs.commentCount,
        capturedAt: ctx.nowIso,
      });
      // INSERT OR IGNORE (topic, video, day) — chạy lại tick cùng ngày không nhân
      // bản. views là NOT NULL trong contract — video thiếu viewCount thì bỏ
      // snapshot (không ghi 0 giả).
      if (vs.viewCount !== null) {
        store.recordVideoDailyView({
          topicId: ctx.topicId,
          videoId: item.videoId,
          day: ctx.day,
          views: vs.viewCount,
          likes: vs.likeCount,
          comments: vs.commentCount,
          capturedAt: ctx.nowIso,
        });
      }
      scannedNewVideos++;
    }
    if (scanned.items.length > 0) section.channelsScanned++;
    section.newVideos += scannedNewVideos;

    // --- baseline từ TOÀN BỘ topic_videos đã lưu (không chỉ 15 video hôm nay),
    // để cửa sổ 30 được lấp dần qua nhiều ngày quét.
    const stored = store.listTopicVideos(ctx.topicId, { channelId });
    const baseline = baselineOf(toBaselineInputs(stored), settings);

    const lastPublishedAt =
      newestPublishedAt(scanned.items) ?? row.lastPublishedAt ?? null;
    store.updateChannelBaseline(ctx.topicId, channelId, {
      baselineMedianViews: baseline.medianViews,
      baselineN: baseline.n,
      maxViews: baseline.maxViews,
      lastPublishedAt,
      lastCheckedAt: ctx.nowIso,
    });

    // --- D3: derived metrics trên video vừa quét ---
    for (const videoId of seenVideoIds) {
      const snaps = store.listVideoDailyViews(ctx.topicId, videoId);
      const gained24h = viewsGained24h(snaps);
      const vs = scanned.stats.get(videoId);
      const oScore = outlierScore(vs?.viewCount ?? null, baseline);
      store.updateVideoDerived(ctx.topicId, videoId, {
        viewsGained24h: gained24h,
        outlierScore: oScore,
      });
      if (gained24h !== null) {
        gained.push({
          videoId,
          title: vs?.title ?? videoId,
          channelTitle,
          viewsGained24h: gained24h,
          views: vs?.viewCount ?? null,
        });
      }
      if (oScore !== null && oScore >= settings.outlierMultiple) {
        outliers.push({
          videoId,
          title: vs?.title ?? videoId,
          channelTitle,
          outlierScore: oScore,
          views: vs?.viewCount ?? null,
        });
      }
    }

    // --- D4: suggestion, KHÔNG phải status ---
    // Kênh im quá silent_days → gợi ý 'pause_silent' để người duyệt quyết.
    let suggestion: string | null = null;
    if (lastPublishedAt) {
      const silentMs = Date.parse(ctx.nowIso) - Date.parse(lastPublishedAt);
      if (silentMs > settings.silentDays * DAY_MS) suggestion = 'pause_silent';
    }
    store.setChannelSuggestion(ctx.topicId, channelId, suggestion);
    if (suggestion) section.suggestions.push({ channelId, title: channelTitle, suggestion });
  }

  section.topGained24h = gained
    .sort((a, b) => b.viewsGained24h - a.viewsGained24h)
    .slice(0, 10);
  section.topOutliers = outliers
    .sort((a, b) => b.outlierScore - a.outlierScore)
    .slice(0, 10);

  return { section, channelsScanned: section.channelsScanned };
}

// ---------------------------------------------------------------------------
// WEEKLY — W1–W5 (plan §2.3). Search ≤ weekly_keyword_budget, publishedAfter 28d.
// ---------------------------------------------------------------------------

export interface WeeklyModeResult {
  section: WeeklyReportSection;
  keywordsSearched: string[];
  channelsProposed: number;
  keywordsProposed: number;
}

export async function runWeeklyMode(ctx: ModeContext): Promise<WeeklyModeResult> {
  const { store, settings } = ctx;
  const section: WeeklyReportSection = {
    keywordsSearched: [],
    outliersInFollow: [],
    newChannelsProposed: [],
    channelsRejectedLang: 0,
    channelsFilteredDeadLottery: 0,
    newKeywords: [],
  };
  const keywordsSearched: string[] = [];

  if (!ctx.dataApi.search) {
    // Không có search capability thì weekly không làm gì được — report rỗng.
    return { section, keywordsSearched, channelsProposed: 0, keywordsProposed: 0 };
  }

  const followedRows = store.listTopicChannelsByStatus(ctx.topicId, ['active']);
  const followed = new Set(followedRows.map(rowChannelId));
  // Baseline per kênh từ cột đã lưu — đỡ phải query topic_videos cho từng hit.
  const baselineByChannel = new Map(
    followedRows.map((r) => [
      rowChannelId(r),
      { medianViews: r.baselineMedianViews ?? null, reliable: (r.baselineN ?? 0) >= settings.baselineMinN },
    ]),
  );
  // Kênh đã có trong sổ (mọi status) — không scan/đề xuất lại.
  const knownChannels = new Set(
    store
      .listTopicChannelsByStatus(ctx.topicId, ['new', 'active', 'paused', 'rejected', 'own'])
      .map(rowChannelId),
  );

  // --- W1: search keyword active, xoay theo last_checked_at (null trước) ---
  const activeKeywords = store
    .listKeywordsByStatus(ctx.topicId, ['active'])
    .sort((a, b) => String(a.lastCheckedAt ?? '').localeCompare(String(b.lastCheckedAt ?? '')))
    .slice(0, settings.weeklyKeywordBudget);

  const publishedAfter = new Date(Date.parse(ctx.nowIso) - 28 * DAY_MS).toISOString();

  interface OutsideHit {
    channelId: string;
    videoId: string;
    title: string;
    views: number;
    termKey: string;
  }
  const outsideHits = new Map<string, OutsideHit>(); // best video theo kênh
  const outlierVideoIds: Array<{ videoId: string; title: string; channelTitle: string }> = [];

  for (const kw of activeKeywords) {
    if (ctx.quota.remaining('search') <= 0) break;
    const termKey = kw.termKey;
    const term = kw.displayTerm || termKey;

    let hits: Awaited<ReturnType<NonNullable<typeof ctx.dataApi.search>>>['hits'] = [];
    try {
      const result = await ctx.dataApi.search({
        q: term,
        type: 'video',
        order: 'viewCount',
        maxResults: 50,
        regionCode: ctx.regionCode || undefined,
        relevanceLanguage: ctx.language,
        publishedAfter,
      });
      hits = result.hits;
    } catch {
      continue; // keyword hỏng không được làm chết cả tick weekly
    }
    keywordsSearched.push(termKey);

    const videoIds = hits.map((h) => h.videoId).filter((v): v is string => Boolean(v));
    const vstats = videoIds.length ? await ctx.dataApi.fetchVideoStatistics(videoIds) : new Map();

    let nFollowed = 0;
    const hitViews: number[] = [];
    for (const hit of hits) {
      const channelId = hit.channelId ?? vstats.get(hit.videoId ?? '')?.channelId ?? null;
      const vs = hit.videoId ? vstats.get(hit.videoId) : undefined;
      const views = vs?.viewCount ?? null;
      if (views !== null) hitViews.push(views);
      if (!channelId) continue;

      if (followed.has(channelId)) {
        nFollowed++;
        // W2: outlier TRONG follow — so với baseline của chính kênh đó.
        const oScore = outlierScore(views, baselineByChannel.get(channelId) ?? { medianViews: null, reliable: false });
        if (hit.videoId && oScore !== null && oScore >= settings.outlierMultiple) {
          section.outliersInFollow.push({
            videoId: hit.videoId,
            title: vs?.title ?? hit.title ?? hit.videoId,
            channelTitle: vs?.channelTitle ?? hit.channelTitle ?? channelId,
            outlierScore: oScore,
          });
          outlierVideoIds.push({ videoId: hit.videoId, title: vs?.title ?? hit.title ?? hit.videoId, channelTitle: '' });
        }
        // Video của kênh follow lọt qua search → vẫn ghi vào sổ để daily không bỏ sót.
        if (hit.videoId && vs) {
          store.upsertTopicVideo({
            topicId: ctx.topicId,
            videoId: hit.videoId,
            channelId,
            title: vs.title ?? hit.title ?? hit.videoId,
            publishedAt: vs.publishedAt ?? hit.publishedAt,
            durationSec: vs.durationSec,
            thumbnailUrl: vs.thumbnailUrl ?? hit.thumbnailUrl,
            source: 'weekly_search',
            foundByKeyword: termKey,
            views: vs.viewCount,
            likes: vs.likeCount,
            comments: vs.commentCount,
            capturedAt: ctx.nowIso,
          });
          if (vs.viewCount !== null) {
            store.recordVideoDailyView({
              topicId: ctx.topicId,
              videoId: hit.videoId,
              day: ctx.day,
              views: vs.viewCount,
              likes: vs.likeCount,
              comments: vs.commentCount,
              capturedAt: ctx.nowIso,
            });
          }
        }
      } else if (hit.videoId && views !== null && vs) {
        // W3: kênh ngoài follow — giữ video "hit" mạnh nhất mỗi kênh.
        const prev = outsideHits.get(channelId);
        if (!prev || views > prev.views) {
          outsideHits.set(channelId, {
            channelId,
            videoId: hit.videoId,
            title: vs.title ?? hit.title ?? hit.videoId,
            views,
            termKey,
          });
        }
      }
    }

    store.updateKeywordCheck(ctx.topicId, termKey, {
      lastCheckedAt: ctx.nowIso,
      lastNResults: hits.length,
      lastNFollowed: nFollowed,
      lastMedianViews: hitViews.length ? median(hitViews) : null,
    });
    section.keywordsSearched.push({
      termKey,
      term,
      nResults: hits.length,
      nFollowed,
      medianViews: hitViews.length ? median(hitViews) : null,
    });
  }

  // --- W3: quét nhanh kênh ngoài follow, ≤ weekly_new_channel_scan ---
  const candidates = [...outsideHits.values()]
    .filter((h) => !knownChannels.has(h.channelId))
    .sort((a, b) => b.views - a.views)
    .slice(0, settings.weeklyNewChannelScan);

  if (candidates.length > 0) {
    const channelStats = await ctx.dataApi.fetchChannelStatistics(candidates.map((c) => c.channelId));
    for (const cand of candidates) {
      const stats = channelStats.get(cand.channelId);
      if (!stats) continue;
      const scanned = await scanChannelVideos(ctx, stats.uploadsPlaylistId, CHANNEL_BASELINE_SCAN);
      const langVerdict = evaluateChannelLanguage(scanned.langSample, ctx.language);
      if (langVerdict.reject) {
        // Contract: rejectChannelForLanguage yêu cầu dòng topic_channels đã tồn
        // tại → insert 'new' rồi reject ngay (quyết định auto DUY NHẤT của loop).
        store.upsertTopicChannelCandidate({
          topicId: ctx.topicId,
          channelId: cand.channelId,
          title: stats.title ?? cand.channelId,
          subscriberCount: stats.subscriberCount ?? undefined,
          discoveredVia: 'weekly_outlier',
          discoveredFrom: cand.termKey,
          tickId: ctx.tickId,
        });
        store.rejectChannelForLanguage(
          ctx.topicId,
          cand.channelId,
          JSON.stringify({
            method: langVerdict.method,
            decisive: langVerdict.decisive,
            evidenceField: langVerdict.evidenceField,
            declaredByField: langVerdict.declaredByField,
            declaredCounts: langVerdict.declaredCounts,
            declaredCount: langVerdict.declaredCount,
            sampleSize: langVerdict.sampleSize,
            majority: langVerdict.langDetected,
          }),
          ctx.tickId,
        );
        section.channelsRejectedLang++;
        continue;
      }

      const baselineVideos: BaselineVideoInput[] = scanned.items.map((item) => {
        const vs = scanned.stats.get(item.videoId);
        return {
          views: vs?.viewCount ?? null,
          durationSec: vs?.durationSec ?? null,
          publishedAt: vs?.publishedAt ?? item.publishedAt,
        };
      });
      const baseline = baselineOf(baselineVideos, settings);
      // L7: dead/lottery → KHÔNG đề xuất (acceptance §6.4).
      if (baseline.dead || baseline.lottery) {
        section.channelsFilteredDeadLottery++;
        continue;
      }
      const hitOutlier = outlierScore(cand.views, baseline);
      if (hitOutlier === null || hitOutlier < settings.outlierMultiple) continue;

      // status='new' + decisions(actor=loop,to=new) — tất cả trong contract.
      const thumbs = scanned.items
        .map((i) => scanned.stats.get(i.videoId)?.thumbnailUrl)
        .filter((u): u is string => Boolean(u))
        .slice(0, 6);
      store.upsertTopicChannelCandidate({
        topicId: ctx.topicId,
        channelId: cand.channelId,
        title: stats.title ?? cand.channelId,
        subscriberCount: stats.subscriberCount ?? undefined,
        discoveredVia: 'weekly_outlier',
        discoveredFrom: cand.termKey,
        thumbnailsJson: thumbs.length ? JSON.stringify(thumbs) : undefined,
        langDetected: langVerdict.langDetected ?? undefined,
        tickId: ctx.tickId,
      });
      store.updateChannelBaseline(ctx.topicId, cand.channelId, {
        baselineMedianViews: baseline.medianViews,
        baselineN: baseline.n,
        maxViews: baseline.maxViews,
        lastPublishedAt: newestPublishedAt(scanned.items),
        lastCheckedAt: ctx.nowIso,
      });
      for (const item of scanned.items) {
        const vs = scanned.stats.get(item.videoId);
        if (!vs) continue;
        store.upsertTopicVideo({
          topicId: ctx.topicId,
          videoId: item.videoId,
          channelId: cand.channelId,
          title: vs.title ?? item.title ?? item.videoId,
          publishedAt: vs.publishedAt ?? item.publishedAt,
          durationSec: vs.durationSec,
          thumbnailUrl: vs.thumbnailUrl,
          source: 'weekly_search',
          foundByKeyword: item.videoId === cand.videoId ? cand.termKey : null,
          views: vs.viewCount,
          likes: vs.likeCount,
          comments: vs.commentCount,
          capturedAt: ctx.nowIso,
        });
      }
      section.newChannelsProposed.push({
        channelId: cand.channelId,
        title: stats.title,
        outlierScore: hitOutlier,
        baselineMedianViews: baseline.medianViews,
        foundByKeyword: cand.termKey,
      });
      outlierVideoIds.push({ videoId: cand.videoId, title: cand.title, channelTitle: '' });
    }
  }

  // --- W4: n-gram chung của ≥2 video outlier → keyword pending ---
  // Mỗi video outlier là một nhóm (key = videoId) → nChannels = số video chứa cụm.
  const outlierGroups = new Map(
    outlierVideoIds.map((v) => [v.videoId, [{ videoId: v.videoId, title: v.title }]]),
  );
  const ngrams = harvestNgrams(outlierGroups, 2);
  for (const hit of ngrams) {
    const { inserted } = store.upsertKeywordCandidate({
      topicId: ctx.topicId,
      termKey: hit.termKey,
      displayTerm: hit.display,
      origin: 'outlier_title',
      evidenceJson: JSON.stringify({
        nChannels: hit.nChannels,
        nVideos: hit.nVideos,
        sampleVideoIds: hit.sampleVideoIds,
      }),
      tickId: ctx.tickId,
    });
    if (inserted) {
      section.newKeywords.push({ termKey: hit.termKey, display: hit.display, nVideos: hit.nVideos });
    }
  }

  return {
    section,
    keywordsSearched,
    channelsProposed: section.newChannelsProposed.length,
    keywordsProposed: section.newKeywords.length,
  };
}

// ---------------------------------------------------------------------------
// SETUP — S2/S3, mỗi bước một lệnh riêng, dừng chờ người (plan §2.1).
// ---------------------------------------------------------------------------

export interface SetupModeResult {
  section: SetupReportSection;
  keywordsSearched: string[];
  channelsProposed: number;
  keywordsProposed: number;
}

export async function runSetupMode(
  ctx: ModeContext,
  step: SetupStep,
): Promise<SetupModeResult> {
  return step === 'channels' ? runSetupChannels(ctx) : runSetupKeywords(ctx);
}

/**
 * S2: search keyword pending (seed) → gom kênh → cổng ngôn ngữ → quét 30 video
 * → baseline → status='new' (không đề xuất dead/lottery — L7).
 * Kết thúc: setup_status='awaiting_channels', DỪNG chờ người duyệt.
 */
async function runSetupChannels(ctx: ModeContext): Promise<SetupModeResult> {
  const { store, settings } = ctx;
  const section: SetupReportSection = {
    step: 'channels',
    channelsProposed: 0,
    channelsRejectedLang: 0,
    channelsFilteredDeadLottery: 0,
    keywordsProposed: 0,
    awaitingStatus: 'awaiting_channels',
  };
  const keywordsSearched: string[] = [];
  if (!ctx.dataApi.search) {
    store.setTopicSetupStatus(ctx.topicId, 'awaiting_channels');
    return { section, keywordsSearched, channelsProposed: 0, keywordsProposed: 0 };
  }

  const seeds = store.listKeywordsByStatus(ctx.topicId, ['pending']);
  const knownChannels = new Set(
    store
      .listTopicChannelsByStatus(ctx.topicId, ['new', 'active', 'paused', 'rejected', 'own'])
      .map(rowChannelId),
  );

  // Gom kênh từ mọi seed — discoveredFrom giữ termKey đầu tiên dẫn tới kênh.
  const foundChannels = new Map<string, string>(); // channelId → termKey
  for (const kw of seeds) {
    if (ctx.quota.remaining('search') <= 0) break;
    try {
      const result = await ctx.dataApi.search({
        q: kw.displayTerm || kw.termKey,
        type: 'video',
        order: 'viewCount',
        maxResults: 50,
        regionCode: ctx.regionCode || undefined,
        relevanceLanguage: ctx.language,
      });
      keywordsSearched.push(kw.termKey);
      for (const hit of result.hits) {
        if (hit.channelId && !foundChannels.has(hit.channelId)) {
          foundChannels.set(hit.channelId, kw.termKey);
        }
      }
    } catch {
      continue;
    }
  }

  const toScan = [...foundChannels.entries()]
    .filter(([channelId]) => !knownChannels.has(channelId))
    .slice(0, SETUP_CHANNEL_SCAN_CAP);

  if (toScan.length > 0) {
    const channelStats = await ctx.dataApi.fetchChannelStatistics(toScan.map(([id]) => id));
    for (const [channelId, termKey] of toScan) {
      const stats = channelStats.get(channelId);
      if (!stats) continue;
      const scanned = await scanChannelVideos(ctx, stats.uploadsPlaylistId, CHANNEL_BASELINE_SCAN);
      const langVerdict = evaluateChannelLanguage(scanned.langSample, ctx.language);
      if (langVerdict.reject) {
        // Như W3: phải insert 'new' trước khi reject — store ném not_found nếu
        // dòng chưa tồn tại.
        store.upsertTopicChannelCandidate({
          topicId: ctx.topicId,
          channelId,
          title: stats.title ?? channelId,
          subscriberCount: stats.subscriberCount ?? undefined,
          discoveredVia: 'keyword_search',
          discoveredFrom: termKey,
          tickId: ctx.tickId,
        });
        store.rejectChannelForLanguage(
          ctx.topicId,
          channelId,
          JSON.stringify({
            method: langVerdict.method,
            decisive: langVerdict.decisive,
            evidenceField: langVerdict.evidenceField,
            declaredByField: langVerdict.declaredByField,
            declaredCounts: langVerdict.declaredCounts,
            declaredCount: langVerdict.declaredCount,
            sampleSize: langVerdict.sampleSize,
            majority: langVerdict.langDetected,
          }),
          ctx.tickId,
        );
        section.channelsRejectedLang++;
        continue;
      }

      const baseline = baselineOf(
        scanned.items.map((item) => {
          const vs = scanned.stats.get(item.videoId);
          return {
            views: vs?.viewCount ?? null,
            durationSec: vs?.durationSec ?? null,
            publishedAt: vs?.publishedAt ?? item.publishedAt,
          };
        }),
        settings,
      );
      if (baseline.dead || baseline.lottery) {
        section.channelsFilteredDeadLottery++;
        continue;
      }

      const thumbs = scanned.items
        .map((i) => scanned.stats.get(i.videoId)?.thumbnailUrl)
        .filter((u): u is string => Boolean(u))
        .slice(0, 6);
      store.upsertTopicChannelCandidate({
        topicId: ctx.topicId,
        channelId,
        title: stats.title ?? channelId,
        subscriberCount: stats.subscriberCount ?? undefined,
        discoveredVia: 'keyword_search',
        discoveredFrom: termKey,
        thumbnailsJson: thumbs.length ? JSON.stringify(thumbs) : undefined,
        langDetected: langVerdict.langDetected ?? undefined,
        tickId: ctx.tickId,
      });
      store.updateChannelBaseline(ctx.topicId, channelId, {
        baselineMedianViews: baseline.medianViews,
        baselineN: baseline.n,
        maxViews: baseline.maxViews,
        lastPublishedAt: newestPublishedAt(scanned.items),
        lastCheckedAt: ctx.nowIso,
      });
      for (const item of scanned.items) {
        const vs = scanned.stats.get(item.videoId);
        if (!vs) continue;
        store.upsertTopicVideo({
          topicId: ctx.topicId,
          videoId: item.videoId,
          channelId,
          title: vs.title ?? item.title ?? item.videoId,
          publishedAt: vs.publishedAt ?? item.publishedAt,
          durationSec: vs.durationSec,
          thumbnailUrl: vs.thumbnailUrl,
          source: 'setup',
          views: vs.viewCount,
          likes: vs.likeCount,
          comments: vs.commentCount,
          capturedAt: ctx.nowIso,
        });
        if (vs.viewCount !== null) {
          store.recordVideoDailyView({
            topicId: ctx.topicId,
            videoId: item.videoId,
            day: ctx.day,
            views: vs.viewCount,
            likes: vs.likeCount,
            comments: vs.commentCount,
            capturedAt: ctx.nowIso,
          });
        }
      }
      section.channelsProposed++;
    }
  }

  // Điểm dừng HITL: chờ người duyệt kênh trước khi chạy S3.
  store.setTopicSetupStatus(ctx.topicId, 'awaiting_channels');
  return {
    section,
    keywordsSearched,
    channelsProposed: section.channelsProposed,
    keywordsProposed: 0,
  };
}

/**
 * S3: n-gram 2–3 từ title của kênh ACTIVE (đã được người duyệt) → keyword
 * pending. Kết thúc: setup_status='awaiting_keywords', DỪNG chờ người duyệt.
 * Không có kênh active → KHÔNG tiến trạng thái — S2 chưa được duyệt xong.
 */
async function runSetupKeywords(ctx: ModeContext): Promise<SetupModeResult> {
  const { store, settings } = ctx;
  const section: SetupReportSection = {
    step: 'keywords',
    channelsProposed: 0,
    channelsRejectedLang: 0,
    channelsFilteredDeadLottery: 0,
    keywordsProposed: 0,
    awaitingStatus: 'awaiting_keywords',
  };

  const activeChannels = store.listTopicChannelsByStatus(ctx.topicId, ['active']);
  if (activeChannels.length === 0) {
    return { section, keywordsSearched: [], channelsProposed: 0, keywordsProposed: 0 };
  }

  const titlesByChannel = new Map<string, Array<{ videoId: string; title: string }>>();
  for (const row of activeChannels) {
    const videos = store.listTopicVideos(ctx.topicId, {
      channelId: rowChannelId(row),
      limit: settings.baselineWindow,
    });
    const titles = videos
      .filter((v) => (v.durationSec ?? 0) >= settings.minDurationSec && v.title)
      .map((v) => ({ videoId: v.videoId, title: v.title }));
    if (titles.length > 0) titlesByChannel.set(rowChannelId(row), titles);
  }

  const ngrams = harvestNgrams(titlesByChannel, settings.ngramMinChannels);
  let keywordsProposed = 0;
  for (const hit of ngrams) {
    const { inserted } = store.upsertKeywordCandidate({
      topicId: ctx.topicId,
      termKey: hit.termKey,
      displayTerm: hit.display,
      origin: 'title_ngram',
      evidenceJson: JSON.stringify({
        nChannels: hit.nChannels,
        nVideos: hit.nVideos,
        sampleVideoIds: hit.sampleVideoIds,
      }),
      tickId: ctx.tickId,
    });
    if (inserted) keywordsProposed++;
  }
  section.keywordsProposed = keywordsProposed;

  // Điểm dừng HITL: chờ người duyệt keyword trước khi setup_status='done'.
  store.setTopicSetupStatus(ctx.topicId, 'awaiting_keywords');
  return { section, keywordsSearched: [], channelsProposed: 0, keywordsProposed };
}
