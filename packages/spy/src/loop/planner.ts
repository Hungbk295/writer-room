/**
 * loop/planner.ts — Pure planner, không gọi API.
 *
 * Tính ngân sách quota, chọn keyword ưu tiên, trả TickPlan.
 */
import type { SpyStore } from '../store.ts';
import type { QuotaLedger } from '../quota.ts';
import { quotaDay } from '../quota.ts';
import type { TickPlan } from './types.ts';

export interface PlannerOptions {
  /** Override ngày quota (test). */
  now?: Date;
}

export function planTick(
  store: SpyStore,
  quota: QuotaLedger,
  topicId: string,
  opts: PlannerOptions = {},
): TickPlan {
  const now = opts.now ?? new Date();
  const day = quotaDay(now);

  // Lấy topic config
  const topicRow = store.getTopic(topicId);
  if (!topicRow) {
    return {
      topicId,
      quotaDay: day,
      dryRun: false,
      estimatedSearchCalls: 0,
      estimatedGeneralUnits: 0,
      keywordsToSearch: [],
      channelsToExpand: [],
      canProceed: false,
      blockers: [`Topic '${topicId}' không tồn tại trong DB`],
    };
  }

  const status = String(topicRow['status']);
  if (status === 'paused' || status === 'archived') {
    return {
      topicId,
      quotaDay: day,
      dryRun: false,
      estimatedSearchCalls: 0,
      estimatedGeneralUnits: 0,
      keywordsToSearch: [],
      channelsToExpand: [],
      canProceed: false,
      blockers: [`Topic '${topicId}' đang ${status}`],
    };
  }

  const dailySearchBudget = Number(topicRow['daily_search_budget']) || 20;
  const searchRemaining = quota.remaining('search', now);
  const generalRemaining = quota.remaining('general', now);

  // Chọn keywords ưu tiên: seed pending → searched (≤20% budget) → theo yield_channels
  const allKeywords = store.listTopicKeywords(topicId);
  const pendingSeeds = allKeywords.filter(
    (k) => String(k['status']) === 'pending' && String(k['relation']) === 'seed',
  );
  const otherPending = allKeywords.filter(
    (k) => String(k['status']) === 'pending' && String(k['relation']) !== 'seed',
  );
  const topYield = allKeywords
    .filter((k) => String(k['status']) === 'searched' && Number(k['yield_channels']) > 0)
    .sort((a, b) => Number(b['yield_channels']) - Number(a['yield_channels']));

  const budget = Math.min(dailySearchBudget, searchRemaining);
  const reSearchBudget = Math.floor(budget * 0.2);

  const selected: string[] = [];
  for (const k of pendingSeeds) {
    if (selected.length >= budget - reSearchBudget) break;
    selected.push(String(k['term_key']));
  }
  for (const k of otherPending) {
    if (selected.length >= budget - reSearchBudget) break;
    selected.push(String(k['term_key']));
  }
  for (const k of topYield) {
    if (selected.length >= budget) break;
    selected.push(String(k['term_key']));
  }

  // Channels to expand: shortlisted/studied chưa expand trong 7 ngày
  const channelsToExpand = store.listTopicChannels(topicId, {
    status: 'shortlisted',
    limit: 20,
  }).map((r) => String(r['channel_id']));

  const studiedChannels = store.listTopicChannels(topicId, {
    status: 'studied',
    limit: 10,
  }).map((r) => String(r['channel_id']));

  const allExpandChannels = [...new Set([...channelsToExpand, ...studiedChannels])].slice(0, 30);

  // Ước lượng quota: expand ~1 unit/kênh, enrich ~2 unit/kênh search result
  const estimatedGeneralUnits = allExpandChannels.length + selected.length * 4;

  const blockers: string[] = [];
  if (budget === 0) blockers.push('Hết quota search hôm nay');
  if (generalRemaining < estimatedGeneralUnits * 0.5) {
    blockers.push(`Quota general còn ${generalRemaining} unit, ước tính cần ${estimatedGeneralUnits}`);
  }

  return {
    topicId,
    quotaDay: day,
    dryRun: false,
    estimatedSearchCalls: selected.length,
    estimatedGeneralUnits,
    keywordsToSearch: selected,
    channelsToExpand: allExpandChannels,
    canProceed: blockers.length === 0,
    blockers,
  };
}
