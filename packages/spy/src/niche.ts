/**
 * File chiến lược nội dung (`<data>/config/niche.json`).
 *
 * Phần JSON strict lo việc sinh query và lọc cứng — chạy được ngay, không cần LLM.
 * Trường `notes` là prose, dành cho bước chấm fit bằng LLM ở phase sau.
 *
 * Hai thị trường tách riêng: mỗi market có ngôn ngữ + vùng + bộ seed keyword của
 * mình, và kết quả KHÔNG trộn khi xếp hạng — 50k sub ở thị trường Việt không so
 * trực tiếp với 50k sub ở thị trường Anh ngữ.
 */
import { z } from 'zod';
import { tokenizeTitle } from './metrics/title.ts';

export const nicheMarketSchema = z.object({
  id: z.string().min(1),
  label: z.string().default(''),
  /** ISO 639-1, ví dụ 'vi' | 'en' — search.list relevanceLanguage. */
  relevanceLanguage: z.string().min(2).max(5),
  /** ISO 3166-1 alpha-2, ví dụ 'VN' | 'US' — search.list regionCode. */
  regionCode: z.string().length(2),
  seedKeywords: z.array(z.string().min(1)).default([]),
});

export const nicheConfigSchema = z.object({
  version: z.literal(1).default(1),
  markets: z.array(nicheMarketSchema).min(1),
  /** Từ khoá loại trừ: xuất hiện trong title/description kênh thì bị trừ điểm mạnh. */
  negativeKeywords: z.array(z.string().min(1)).default([]),
  format: z.object({
    videoDuration: z.enum(['any', 'short', 'medium', 'long']).default('any'),
    minDurationSec: z.number().int().min(0).default(0),
    maxDurationSec: z.number().int().min(0).default(0),
  }).default({ videoDuration: 'any', minDurationSec: 0, maxDurationSec: 0 }),
  channelFilter: z.object({
    minSubscribers: z.number().int().min(0).default(0),
    maxSubscribers: z.number().int().min(0).default(0),
    minVideos: z.number().int().min(0).default(0),
  }).default({ minSubscribers: 0, maxSubscribers: 0, minVideos: 0 }),
  excludeChannelIds: z.array(z.string()).default([]),
  scoring: z.object({
    keywordOverlap: z.number().min(0).default(40),
    subscriberBand: z.number().min(0).default(20),
    uploadRecency: z.number().min(0).default(15),
    avgViewsPerVideo: z.number().min(0).default(15),
    languageMatch: z.number().min(0).default(10),
  }).default({
    keywordOverlap: 40,
    subscriberBand: 20,
    uploadRecency: 15,
    avgViewsPerVideo: 15,
    languageMatch: 10,
  }),
  notes: z.string().default(''),
}).strict();

export type NicheMarket = z.infer<typeof nicheMarketSchema>;
export type NicheConfig = z.infer<typeof nicheConfigSchema>;

export const NICHE_TEMPLATE: NicheConfig = nicheConfigSchema.parse({
  version: 1,
  markets: [
    { id: 'vi', label: 'Việt Nam', relevanceLanguage: 'vi', regionCode: 'VN', seedKeywords: [] },
    { id: 'en', label: 'Global EN', relevanceLanguage: 'en', regionCode: 'US', seedKeywords: [] },
  ],
  negativeKeywords: [],
  notes: 'Mô tả chiến lược kênh: khán giả mục tiêu, giọng điệu, định dạng, và thứ KHÔNG làm.',
});

export interface FitReason {
  factor: string;
  points: number;
  max: number;
  detail: string;
}

export interface FitResult {
  score: number;
  reasons: FitReason[];
  /** true khi kênh vi phạm channelFilter hoặc nằm trong excludeChannelIds. */
  excluded: boolean;
  excludeReason: string | null;
}

export interface FitCandidateInput {
  channelId: string;
  title?: string | null;
  description?: string | null;
  subscriberCount?: number | null;
  videoCount?: number | null;
  viewCount?: number | null;
  country?: string | null;
  publishedAt?: string | null;
}

function normalize(value: string): string {
  return value.toLowerCase().normalize('NFC');
}

/** Đếm seed keyword xuất hiện trong text (khớp cụm, không chỉ token đơn). */
function keywordHits(text: string, keywords: readonly string[]): string[] {
  const haystack = normalize(text);
  return keywords.filter((keyword) => haystack.includes(normalize(keyword)));
}

/**
 * Chấm độ hợp niche 0–100, HOÀN TOÀN XÁC ĐỊNH — không gọi LLM.
 * Mọi factor đều trả `reasons` để biết điểm đến từ đâu; một điểm số không giải
 * thích được thì không dùng để loại kênh.
 */
export function scoreChannelFit(
  candidate: FitCandidateInput,
  niche: NicheConfig,
  market?: NicheMarket,
): FitResult {
  const weights = niche.scoring;
  const reasons: FitReason[] = [];
  const text = `${candidate.title ?? ''} ${candidate.description ?? ''}`;

  if (niche.excludeChannelIds.includes(candidate.channelId)) {
    return { score: 0, reasons, excluded: true, excludeReason: 'nằm trong excludeChannelIds' };
  }

  const filter = niche.channelFilter;
  const subs = candidate.subscriberCount ?? null;
  if (filter.minSubscribers > 0 && subs !== null && subs < filter.minSubscribers) {
    return { score: 0, reasons, excluded: true, excludeReason: `dưới ngưỡng ${filter.minSubscribers} sub` };
  }
  if (filter.maxSubscribers > 0 && subs !== null && subs > filter.maxSubscribers) {
    return { score: 0, reasons, excluded: true, excludeReason: `trên ngưỡng ${filter.maxSubscribers} sub` };
  }
  if (filter.minVideos > 0 && (candidate.videoCount ?? 0) < filter.minVideos) {
    return { score: 0, reasons, excluded: true, excludeReason: `dưới ${filter.minVideos} video` };
  }

  // 1. Overlap từ khoá — trọng số lớn nhất.
  const seeds = market?.seedKeywords ?? niche.markets.flatMap((m) => m.seedKeywords);
  const hits = keywordHits(text, seeds);
  const tokenHits = seeds.length === 0
    ? []
    : tokenizeTitle(text).filter((token) => seeds.some((seed) => normalize(seed).includes(token)));
  const overlapRatio = seeds.length === 0
    ? 0
    : Math.min(1, (hits.length * 2 + Math.min(tokenHits.length, 6)) / Math.max(3, seeds.length));
  const overlapPoints = overlapRatio * weights.keywordOverlap;
  reasons.push({
    factor: 'keywordOverlap',
    points: round2(overlapPoints),
    max: weights.keywordOverlap,
    detail: hits.length ? `khớp cụm: ${hits.slice(0, 5).join(', ')}` : 'không khớp cụm seed keyword nào',
  });

  // 2. Negative keyword — phạt thẳng, có thể đẩy điểm về 0.
  const negatives = keywordHits(text, niche.negativeKeywords);
  const penalty = negatives.length * 15;
  if (negatives.length) {
    reasons.push({
      factor: 'negativeKeywords',
      points: -penalty,
      max: 0,
      detail: `dính từ loại trừ: ${negatives.slice(0, 5).join(', ')}`,
    });
  }

  // 3. Dải subscriber — thưởng kênh đủ lớn để học nhưng chưa quá lớn để so.
  let subPoints = 0;
  let subDetail = 'không có dữ liệu subscriber';
  if (subs !== null) {
    const low = filter.minSubscribers > 0 ? filter.minSubscribers : 1_000;
    const high = filter.maxSubscribers > 0 ? filter.maxSubscribers : 5_000_000;
    if (subs >= low && subs <= high) {
      // Điểm cao nhất ở giữa dải theo thang log.
      const position = (Math.log10(subs) - Math.log10(low)) / Math.max(0.001, Math.log10(high) - Math.log10(low));
      subPoints = weights.subscriberBand * (1 - Math.abs(position - 0.5) * 2 * 0.4);
      subDetail = `${subs.toLocaleString('en-US')} sub, trong dải mục tiêu`;
    } else {
      subDetail = `${subs.toLocaleString('en-US')} sub, ngoài dải mục tiêu`;
    }
  }
  reasons.push({ factor: 'subscriberBand', points: round2(subPoints), max: weights.subscriberBand, detail: subDetail });

  // 4. Độ tươi — kênh chết thì không học được gì về xu hướng hiện tại.
  let recencyPoints = 0;
  let recencyDetail = 'không có dữ liệu ngày đăng';
  if (candidate.publishedAt) {
    const ageDays = (Date.now() - Date.parse(candidate.publishedAt)) / 86_400_000;
    if (Number.isFinite(ageDays)) {
      // publishedAt của channel là ngày TẠO kênh — kênh quá mới thì mẫu chưa đủ.
      recencyPoints = ageDays >= 180 ? weights.uploadRecency : weights.uploadRecency * (ageDays / 180);
      recencyDetail = `kênh tạo ${Math.round(ageDays)} ngày trước`;
    }
  }
  reasons.push({ factor: 'uploadRecency', points: round2(recencyPoints), max: weights.uploadRecency, detail: recencyDetail });

  // 5. View trung bình mỗi video — proxy cho chất lượng, không phải quy mô.
  let avgPoints = 0;
  let avgDetail = 'không đủ dữ liệu view/video';
  if (candidate.viewCount && candidate.videoCount) {
    const avgViews = candidate.viewCount / Math.max(1, candidate.videoCount);
    // 10k view/video coi là tốt; thang log để kênh khủng không nuốt hết điểm.
    avgPoints = Math.min(1, Math.log10(Math.max(1, avgViews)) / 5) * weights.avgViewsPerVideo;
    avgDetail = `${Math.round(avgViews).toLocaleString('en-US')} view/video`;
  }
  reasons.push({ factor: 'avgViewsPerVideo', points: round2(avgPoints), max: weights.avgViewsPerVideo, detail: avgDetail });

  // 6. Khớp thị trường theo country của kênh.
  let langPoints = 0;
  let langDetail = 'không có country';
  if (market && candidate.country) {
    const matched = candidate.country.toUpperCase() === market.regionCode.toUpperCase();
    langPoints = matched ? weights.languageMatch : 0;
    langDetail = matched ? `country ${candidate.country} khớp market ${market.id}` : `country ${candidate.country} khác market ${market.id}`;
  }
  reasons.push({ factor: 'languageMatch', points: round2(langPoints), max: weights.languageMatch, detail: langDetail });

  const raw = overlapPoints + subPoints + recencyPoints + avgPoints + langPoints - penalty;
  return {
    score: round2(Math.max(0, Math.min(100, raw))),
    reasons,
    excluded: false,
    excludeReason: null,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Sinh ma trận truy vấn cho một market.
 * search.list chỉ có 100 call/ngày nên số query phải khai báo trước và giới hạn được.
 */
export function buildQueryMatrix(
  market: NicheMarket,
  options: { maxQueries?: number; orders?: Array<'relevance' | 'viewCount' | 'date'> } = {},
): Array<{ q: string; order: 'relevance' | 'viewCount' | 'date'; market: string }> {
  const orders = options.orders ?? ['relevance', 'viewCount'];
  const matrix: Array<{ q: string; order: 'relevance' | 'viewCount' | 'date'; market: string }> = [];
  for (const keyword of market.seedKeywords) {
    for (const order of orders) {
      matrix.push({ q: keyword, order, market: market.id });
    }
  }
  const max = options.maxQueries ?? matrix.length;
  return matrix.slice(0, Math.max(0, max));
}
