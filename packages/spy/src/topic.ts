/**
 * topic.ts — Load/validate topic config files từ <data>/config/topics/*.json
 * và upsert vào DB khi boot. Bridge sang scoreChannelFit (niche.ts).
 */
import { readdir, readFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AppError } from './errors.ts';
import type { SpyStore } from './store.ts';
import { topicConfigSchema, type TopicConfig } from './loop/types.ts';
import {
  scoreChannelFit,
  type NicheConfig,
  type NicheMarket,
  type FitResult,
  type FitCandidateInput,
} from './niche.ts';

export { topicConfigSchema, type TopicConfig } from './loop/types.ts';

// ---------------------------------------------------------------------------
// Import từ file JSON vào DB
// ---------------------------------------------------------------------------

/**
 * Đọc toàn bộ *.json trong <dataDir>/../config/topics/, validate, upsert vào DB.
 * Gọi khi khởi động SpyService.
 */
export async function importTopicFiles(dataDir: string, store: SpyStore): Promise<TopicConfig[]> {
  const topicsDir = join(resolve(dataDir, '..'), 'config', 'topics');
  await mkdir(topicsDir, { recursive: true });

  let files: string[];
  try {
    files = await readdir(topicsDir);
  } catch {
    return [];
  }

  const jsonFiles = files.filter((f) => f.endsWith('.json'));
  const configs: TopicConfig[] = [];

  for (const file of jsonFiles) {
    const path = join(topicsDir, file);
    try {
      const raw = await readFile(path, 'utf8');
      const config = topicConfigSchema.parse(JSON.parse(raw));
      configs.push(config);
      store.upsertTopic({
        topicId: config.topicId,
        label: config.label,
        market: config.market,
        language: config.language,
        status: config.status,
        ownChannelIds: config.ownChannelIds,
        briefMd: config.brief,
        facelessRequired: config.facelessRequired,
        dailySearchBudget: config.dailySearchBudget,
      });
      // Seed channels → cold start 0 quota (§1.2 đường 1). Kênh user tự biết đi
      // thẳng vào candidate_channels(discovered_via='seed_config') + topic_channels(new).
      // KHÔNG dùng 'manual_user': đây là đường tự động đọc file, không phải người
      // dán vào dashboard — nhãn attestation chỉ dành cho entrypoint của người.
      // upsertCandidate không đè status nên kênh đã reject không quay lại 'new'.
      for (const channelId of config.seedChannelIds) {
        const trimmed = channelId.trim();
        if (!trimmed) continue;
        try {
          store.upsertCandidate({
            channelId: trimmed,
            market: config.market,
            discoveredVia: 'seed_config',
          });
          store.upsertTopicChannel({ topicId: config.topicId, channelId: trimmed, status: 'new' });
          store.addTopicChannelSource({
            topicId: config.topicId,
            channelId: trimmed,
            relation: 'seed_config',
          });
        } catch (error) {
          console.warn(`[topic] seedChannelIds '${trimmed}': ${(error as Error).message}`);
        }
      }
      // Seed keywords → upsert vào topic_keywords nếu chưa tồn tại.
      for (const keyword of config.seedKeywords) {
        const termKey = normalizeTermKey(keyword);
        try {
          store.upsertTopicKeyword({
            topicId: config.topicId,
            termKey,
            displayTerm: keyword,
            relation: 'seed',
            addedBy: 'user',
            status: 'pending',
          });
        } catch {
          // Bỏ qua nếu đã có
        }
      }
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') continue;
      // Lỗi parse zod — log nhưng không dừng boot
      console.warn(`[topic] Bỏ qua file lỗi ${path}: ${(error as Error).message}`);
    }
  }

  return configs;
}

// ---------------------------------------------------------------------------
// Bridge: TopicConfig → NicheConfig để dùng lại scoreChannelFit
// ---------------------------------------------------------------------------

/**
 * Chuyển TopicConfig → NicheConfig cực tiểu để gọi scoreChannelFit.
 * Cho phép chạy discoverVideos mà không cần niche.json.
 */
export function topicToNicheMarket(topic: TopicConfig): { niche: NicheConfig; market: NicheMarket } {
  const market: NicheMarket = {
    id: topic.market,
    label: topic.label,
    relevanceLanguage: topic.language,
    regionCode: topic.market.toUpperCase().slice(0, 2),
    seedKeywords: topic.seedKeywords,
  };
  const niche: NicheConfig = {
    version: 1,
    markets: [market],
    negativeKeywords: topic.negativeKeywords,
    format: {
      videoDuration: topic.preferLongform ? 'long' : 'any',
      minDurationSec: 0,
      maxDurationSec: 0,
    },
    channelFilter: {
      minSubscribers: 0,
      maxSubscribers: 0,
      minVideos: 0,
    },
    excludeChannelIds: [],
    scoring: {
      keywordOverlap: 40,
      subscriberBand: 20,
      uploadRecency: 15,
      avgViewsPerVideo: 15,
      languageMatch: 10,
    },
    notes: topic.brief,
  };
  return { niche, market };
}

/**
 * Chấm fit cho ứng viên theo TopicConfig thay vì niche.json.
 */
export function scoreTopicFit(candidate: FitCandidateInput, topic: TopicConfig): FitResult {
  const { niche, market } = topicToNicheMarket(topic);
  return scoreChannelFit(candidate, niche, market);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize từ khoá → term_key: lowercase, bỏ dấu tiếng Việt → ASCII.
 * Dùng cùng logic với keyword-reach để tránh xung đột PK.
 */
export function normalizeTermKey(term: string): string {
  return term
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '_')
    .trim();
}
