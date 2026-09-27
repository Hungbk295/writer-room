/**
 * loop/report.ts — buildV3Report + renderReport.
 *
 * `buildV3Report` → ReportSummaryJson (immutable) + markdown, gắn mode nhịp.
 * `renderReport` → markdown Vietnamese cho DB / Telegram / MCP / web <pre>.
 */
import { randomUUID } from 'node:crypto';
import type { SpyStore, LoopMode } from '../store.ts';
import type { QuotaLedger } from '../quota.ts';
import type {
  DailyReportSection,
  ReportSummaryJson,
  SetupReportSection,
  WeeklyReportSection,
} from './types.ts';

export interface TickBrief {
  tickId: string;
  /** v3: nhịp của tick — report phải gắn mode (§2: report mode=daily/weekly). */
  mode?: LoopMode;
  searchCallsUsed: number;
  generalUnitsUsed: number;
  keywordsSearched: string[];
  newCandidates: number;
  newShortlistedAuto: number;
  autoRejected: number;
  keywordsHarvested: number;
  /** Số liệu riêng của nhịp — đúng một trong ba tuỳ mode. */
  daily?: DailyReportSection;
  weekly?: WeeklyReportSection;
  setup?: SetupReportSection;
  /** Mốc thời gian thật của tick — fallback now() nếu caller không truyền. */
  startedAt?: string;
  finishedAt?: string;
}

/**
 * Report cho tick v3 (daily | weekly | setup). Cùng skeleton với
 * buildDailyReport — nhãn topic, quota ngày, inbox, delta — cộng section riêng
 * của nhịp. KHÔNG suy diễn hành động của người duyệt: số liệu chỉ đến từ tick.
 */
export async function buildV3Report(
  store: SpyStore,
  quota: QuotaLedger,
  topicId: string,
  reportDate: string,
  tick: TickBrief,
): Promise<{ summaryJson: string; markdown: string }> {
  const topicRow = store.getTopic(topicId);
  const topicLabel = topicRow ? String(topicRow['label']) : topicId;
  const dailyBudget = topicRow ? Number(topicRow['daily_search_budget']) : 20;

  const counts = store.countTopicChannelsByStatus(topicId);
  const inboxTotal = counts['new'] ?? 0;

  const quotaStatus = quota.status();
  const searchBucket = quotaStatus.buckets.find((b) => b.bucket === 'search');
  const generalBucket = quotaStatus.buckets.find((b) => b.bucket === 'general');

  const summary: ReportSummaryJson = {
    version: 1,
    reportId: randomUUID(),
    reportDate,
    topicId,
    topicLabel,
    mode: tick.mode,
    daily: tick.daily,
    weekly: tick.weekly,
    setup: tick.setup,
    tick: {
      tickId: tick.tickId,
      status: 'done',
      startedAt: tick.startedAt ?? new Date().toISOString(),
      finishedAt: tick.finishedAt ?? new Date().toISOString(),
      durationSec: tick.startedAt
        ? Math.max(0, Math.round((Date.parse(tick.finishedAt ?? new Date().toISOString()) - Date.parse(tick.startedAt)) / 1000))
        : 0,
      error: null,
      dryRun: false,
      searchCallsUsed: tick.searchCallsUsed,
      generalUnitsUsed: tick.generalUnitsUsed,
    },
    quota: {
      searchUsed: searchBucket?.used ?? 0,
      searchBudget: dailyBudget,
      searchRemainingDay: searchBucket?.remaining ?? 0,
      generalUsed: generalBucket?.used ?? 0,
      generalLimit: generalBucket?.limit ?? 10000,
    },
    funnel: {
      expanded: 0,
      searched: tick.searchCallsUsed,
      newCandidates: tick.newCandidates,
      autoShortlisted: 0,
      pendingReview: inboxTotal,
      autoRejected: tick.autoRejected,
      scanned: 0,
      keywordsHarvested: tick.keywordsHarvested,
    },
    inboxTotal,
    topLearn: [],
    newKeywords: tick.weekly?.newKeywords.map((k) => k.display) ?? [],
    pausedKeywords: [],
    scannedChannels: [],
    delta: {
      vsReportId: null,
      vsDate: null,
      newCandidatesPrev: null,
      inboxTotalPrev: null,
      activeTotalPrev: null,
      pausedTotalPrev: null,
      keywordsPendingPrev: null,
      firstSeenToday: [],
      movedToActiveToday: [],
      userDecisionsSinceLast: { active: 0, rejected: 0 },
      newlyPaused: [],
    },
    warnings: [],
    links: {
      dashboard: `http://127.0.0.1:4187/#/spy/loop?topic=${topicId}`,
      mcpTool: `spy_loop_report(topic_id="${topicId}")`,
    },
  };

  const markdown = renderReport(summary, { mode: 'tick' });
  return { summaryJson: JSON.stringify(summary), markdown };
}

export function renderReport(summary: ReportSummaryJson, opts: { mode: 'tick' | 'digest' }): string {
  const lines: string[] = [];
  const { mode } = opts;
  const tickMode = summary.mode ? ` [${summary.mode}]` : '';

  lines.push(`📊 Spy Loop — ${summary.topicLabel} — ${summary.reportDate}${tickMode}`);
  lines.push('');

  if (mode === 'tick' && summary.tick) {
    lines.push(`**Tick:** ${summary.tick.status}${summary.tick.error ? ` — ⚠ ${summary.tick.error}` : ''}`);
    lines.push(`**Quota:** ${summary.quota.searchUsed}/${summary.quota.searchBudget} search · ${summary.quota.generalUsed}/${summary.quota.generalLimit} unit`);
    lines.push('');
  }

  // Funnel — dòng legacy chỉ render khi thật sự có funnel cũ; tick v3 ghi
  // autoShortlisted=0 và section riêng bên dưới kể phần còn lại.
  const f = summary.funnel;
  if (!summary.mode) {
    lines.push(`**Kênh mới:** ${f.newCandidates} → auto-shortlist ${f.autoShortlisted} · chờ duyệt ${f.pendingReview} · auto-reject ${f.autoRejected}`);
    lines.push('');
  }
  lines.push(`**Inbox:** ${summary.inboxTotal} kênh chờ duyệt`);
  lines.push('');

  // --- Section theo nhịp v3 ---
  if (summary.daily) {
    const d = summary.daily;
    lines.push(`🌅 **Daily:** quét ${d.channelsScanned}/${d.channelsChecked} kênh active · ${d.newVideos} video mới`);
    if (d.topGained24h.length > 0) {
      lines.push('');
      lines.push('🚀 **Tăng view 24h**');
      for (const v of d.topGained24h.slice(0, 5)) {
        lines.push(`• ${v.title} — +${v.viewsGained24h.toLocaleString('en-US')} (${v.channelTitle})`);
      }
    }
    if (d.topOutliers.length > 0) {
      lines.push('');
      lines.push('🔥 **Outlier**');
      for (const v of d.topOutliers.slice(0, 5)) {
        lines.push(`• ${v.title} — ×${v.outlierScore} (${v.channelTitle})`);
      }
    }
    if (d.suggestions.length > 0) {
      lines.push('');
      lines.push(`💤 **Gợi ý pause_silent:** ${d.suggestions.map((s) => s.title ?? s.channelId).join(', ')}`);
    }
    lines.push('');
  }

  if (summary.weekly) {
    const w = summary.weekly;
    lines.push(`📈 **Weekly:** search ${w.keywordsSearched.length} keyword · đề xuất ${w.newChannelsProposed.length} kênh · ${w.newKeywords.length} keyword mới`);
    if (w.keywordsSearched.length > 0) {
      lines.push('');
      lines.push('**Keyword đã search**');
      for (const k of w.keywordsSearched.slice(0, 8)) {
        lines.push(`• "${k.term}" — ${k.nResults} kết quả, ${k.nFollowed} trong follow`);
      }
    }
    if (w.outliersInFollow.length > 0) {
      lines.push('');
      lines.push('🔥 **Outlier trong follow**');
      for (const v of w.outliersInFollow.slice(0, 5)) {
        lines.push(`• ${v.title} — ×${v.outlierScore} (${v.channelTitle})`);
      }
    }
    if (w.newChannelsProposed.length > 0) {
      lines.push('');
      lines.push('🆕 **Kênh đề xuất (chờ duyệt)**');
      for (const c of w.newChannelsProposed.slice(0, 8)) {
        const base = c.baselineMedianViews !== null ? `median ${c.baselineMedianViews}` : 'chưa có baseline';
        lines.push(`• ${c.title ?? c.channelId} — ×${c.outlierScore ?? '?'} · ${base} · qua "${c.foundByKeyword}"`);
      }
    }
    if (w.channelsRejectedLang > 0 || w.channelsFilteredDeadLottery > 0) {
      lines.push('');
      lines.push(`🚫 Lọc: ${w.channelsRejectedLang} lệch ngôn ngữ · ${w.channelsFilteredDeadLottery} dead/lottery`);
    }
    lines.push('');
  }

  if (summary.setup) {
    const s = summary.setup;
    lines.push(`🧱 **Setup (${s.step}):** ${s.channelsProposed} kênh đề xuất · ${s.channelsRejectedLang} lệch ngôn ngữ · ${s.channelsFilteredDeadLottery} dead/lottery · ${s.keywordsProposed} keyword đề xuất`);
    lines.push(`⏸ **Đang chờ:** ${s.awaitingStatus} — người duyệt quyết định bước tiếp`);
    lines.push('');
  }

  // Delta
  if (summary.delta.vsDate) {
    const d = summary.delta;
    const lines2: string[] = [];
    if (d.newCandidatesPrev !== null) {
      lines2.push(`kênh mới ${d.newCandidatesPrev} → ${f.newCandidates}`);
    }
    if (d.inboxTotalPrev !== null) {
      lines2.push(`Inbox ${d.inboxTotalPrev} → ${summary.inboxTotal}`);
    }
    if (lines2.length > 0) {
      lines.push(`🔄 **So với ${d.vsDate}:** ${lines2.join(' · ')}`);
      lines.push('');
    }
  }

  // Top Learn
  if (summary.topLearn.length > 0) {
    lines.push('⭐ **Đáng học nhất**');
    for (let i = 0; i < summary.topLearn.length; i++) {
      const ch = summary.topLearn[i]!;
      const sub = ch.subscriberCount ? `${(ch.subscriberCount / 1000).toFixed(1)}k sub` : '';
      // Verdict thì nói thẳng; hint thì BẮT BUỘC kèm "(đoán từ chữ)" — không được
      // để người đọc tưởng máy đã nhìn thumbnail (§3).
      const faceless = ch.facelessScore !== null
        ? ` · faceless ${ch.facelessScore.toFixed(2)}`
        : ch.facelessHint !== null
          ? ` · faceless? ${ch.facelessHint.toFixed(2)} (đoán từ chữ)`
          : '';
      const fit = ch.fitScore !== null ? ` · fit ${ch.fitScore}` : '';
      lines.push(`${i + 1}. **${ch.title ?? ch.channelId}** — ${sub}${faceless}${fit}`);
      lines.push(`   → ${ch.url}`);
    }
    lines.push('');
  }

  // New keywords
  if (summary.newKeywords.length > 0) {
    lines.push(`🔑 **Keyword mới (${summary.newKeywords.length}):** ${summary.newKeywords.slice(0, 10).map((k) => `"${k}"`).join(', ')}`);
    lines.push('');
  }

  // Exhausted
  if (summary.pausedKeywords.length > 0) {
    const ex = summary.pausedKeywords.slice(0, 3);
    lines.push(`⚠ **Keyword exhausted:** ${ex.map((e) => `"${e.term}" (yield ${e.yieldChannels})`).join(', ')}`);
    lines.push('');
  }

  // Warnings
  for (const w of summary.warnings) {
    lines.push(`⚠ ${w}`);
  }

  lines.push(`👉 Duyệt: ${summary.links.dashboard}`);

  return lines.join('\n');
}
