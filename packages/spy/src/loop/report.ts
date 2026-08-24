/**
 * loop/report.ts — buildDailyReport + renderReport.
 *
 * `buildDailyReport` → ReportSummaryJson (immutable) + markdown.
 * `renderReport` → markdown Vietnamese cho DB / Telegram / MCP / web <pre>.
 */
import { randomUUID } from 'node:crypto';
import type { SpyStore } from '../store.ts';
import type { QuotaLedger } from '../quota.ts';
import type { ReportSummaryJson, TopLearnEntry, ReportDelta } from './types.ts';

export interface TickBrief {
  tickId: string;
  searchCallsUsed: number;
  generalUnitsUsed: number;
  keywordsSearched: string[];
  newCandidates: number;
  newShortlistedAuto: number;
  autoRejected: number;
  keywordsHarvested: number;
}

export async function buildDailyReport(
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

  // Top 5 learn_value
  const topChannels = store.listTopicChannels(topicId, { limit: 100 });
  const topLearn: TopLearnEntry[] = topChannels
    .filter((r) => r['learn_value_score'] !== null)
    .sort((a, b) => Number(b['learn_value_score']) - Number(a['learn_value_score']))
    .slice(0, 5)
    .map((r) => {
      const channelId = String(r['channel_id']);
      const cand = store.listCandidates({ limit: 1, cursor: 0 }).find((c) => c.channelId === channelId);
      return {
        channelId,
        title: cand?.title ?? null,
        url: `https://www.youtube.com/channel/${channelId}`,
        subscriberCount: cand?.subscriberCount ?? null,
        ageMonths: null,
        medianViews: null,
        medianViewsVsOwn: null,
        ownChannelTitle: null,
        facelessScore: r['faceless_score'] === null || r['faceless_score'] === undefined
          ? null
          : Number(r['faceless_score']),
        facelessHint: r['faceless_hint'] === null || r['faceless_hint'] === undefined
          ? null
          : Number(r['faceless_hint']),
        fitScore: r['fit_score'] ? Number(r['fit_score']) : null,
        learnValueScore: r['learn_value_score'] ? Number(r['learn_value_score']) : null,
        foundVia: 'search',
        status: String(r['status']),
        decidedBy: r['decided_by'] ? String(r['decided_by']) : null,
        why: [],
      } as TopLearnEntry;
    });

  // Delta vs previous report
  const prevReports = store.listDailyReports(topicId, 2);
  const prevRow = prevReports.find((r) => String(r['report_date']) !== reportDate);
  let delta: ReportDelta = {
    vsReportId: null,
    vsDate: null,
    newCandidatesPrev: null,
    inboxTotalPrev: null,
    shortlistedTotalPrev: null,
    studiedTotalPrev: null,
    keywordsPendingPrev: null,
    firstSeenToday: [],
    movedToShortlistToday: [],
    userDecisionsSinceLast: { shortlisted: 0, rejected: 0 },
    newlyExhausted: [],
  };

  if (prevRow) {
    try {
      const prevSummary = JSON.parse(String(prevRow['summary_json'])) as ReportSummaryJson;
      delta = {
        vsReportId: String(prevRow['report_id']),
        vsDate: String(prevRow['report_date']),
        newCandidatesPrev: prevSummary.funnel?.newCandidates ?? null,
        inboxTotalPrev: prevSummary.inboxTotal ?? null,
        shortlistedTotalPrev: prevSummary.funnel?.autoShortlisted ?? null,
        studiedTotalPrev: null,
        keywordsPendingPrev: null,
        firstSeenToday: [],
        movedToShortlistToday: [],
        userDecisionsSinceLast: { shortlisted: 0, rejected: 0 },
        newlyExhausted: [],
      };
    } catch {
      // Ignore parse error
    }
  }

  // New keywords (harvested today)
  const allKeywords = store.listTopicKeywords(topicId);
  const newKeywords = allKeywords
    .filter((k) => {
      const addedAt = String(k['added_at'] ?? '');
      return addedAt.startsWith(reportDate) && String(k['relation']) === 'harvested_title';
    })
    .map((k) => String(k['display_term']));

  const exhaustedKeywords = allKeywords
    .filter((k) => String(k['status']) === 'exhausted')
    .map((k) => ({
      term: String(k['display_term']),
      rejectRate: 0,
      yieldChannels: Number(k['yield_channels']),
    }));

  const summary: ReportSummaryJson = {
    version: 1,
    reportId: randomUUID(),
    reportDate,
    topicId,
    topicLabel,
    tick: {
      tickId: tick.tickId,
      status: 'done',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationSec: 0,
      error: null,
      dryRun: false,
      // Quota của RIÊNG tick này (khối `quota` bên dưới là của cả ngày). Hai con
      // số này phải bằng đúng số call đã bị charge cho tick, kể cả call lỗi và
      // phần đã tiêu trước khi resume.
      searchCallsUsed: tick.searchCallsUsed,
      generalUnitsUsed: tick.generalUnitsUsed,
    },
    // Khối `quota` = TOÀN NGÀY, cả bốn số cùng một namespace (sổ global).
    //
    // Trước đây `searchUsed`/`generalUsed` lấy từ tick còn `searchRemainingDay`/
    // `generalLimit` lấy từ sổ global — trộn hai phạm vi trông giống nhau, nên
    // report có thể hiện "1/10000" trong khi sổ thật đã tiêu 9999 cho việc khác,
    // và người đọc tưởng còn nguyên ngân sách. Số theo tick nằm ở `tick.*`.
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
      autoShortlisted: tick.newShortlistedAuto,
      pendingReview: inboxTotal,
      autoRejected: tick.autoRejected,
      scanned: 0,
      keywordsHarvested: tick.keywordsHarvested,
    },
    inboxTotal,
    topLearn,
    newKeywords,
    exhaustedKeywords,
    scannedChannels: [],
    delta,
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

  lines.push(`📊 Spy Loop — ${summary.topicLabel} — ${summary.reportDate}`);
  lines.push('');

  if (mode === 'tick' && summary.tick) {
    lines.push(`**Tick:** ${summary.tick.status}${summary.tick.error ? ` — ⚠ ${summary.tick.error}` : ''}`);
    lines.push(`**Quota:** ${summary.quota.searchUsed}/${summary.quota.searchBudget} search · ${summary.quota.generalUsed}/${summary.quota.generalLimit} unit`);
    lines.push('');
  }

  // Funnel
  const f = summary.funnel;
  lines.push(`**Kênh mới:** ${f.newCandidates} → auto-shortlist ${f.autoShortlisted} · chờ duyệt ${f.pendingReview} · auto-reject ${f.autoRejected}`);
  lines.push(`**Inbox:** ${summary.inboxTotal} kênh chờ duyệt`);
  lines.push('');

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
  if (summary.exhaustedKeywords.length > 0) {
    const ex = summary.exhaustedKeywords.slice(0, 3);
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
