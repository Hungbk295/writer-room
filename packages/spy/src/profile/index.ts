import type { LlmPort } from '../adapters/llm.ts';
import type { SpyStore } from '../store.ts';
import { analyzeHooks } from './hook.ts';
import { analyzeTopics } from './cluster.ts';
import { analyzeVoice } from './voice.ts';
import { analyzeStructure } from './structure.ts';
import { analyzeOutlier } from './outlier.ts';

/** Gom evidence ref từ payload (mảng item có .evidence, hoặc object đơn có .evidence). */
function collectEvidence(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload.flatMap((item) => collectEvidence(item));
  if (payload && typeof payload === 'object') {
    const evidence = (payload as { evidence?: unknown }).evidence;
    if (Array.isArray(evidence)) return evidence;
  }
  return [];
}

export class ProfileService {
  constructor(
    private readonly store: SpyStore,
    private readonly llm: LlmPort,
  ) {}

  /**
   * Ghi kết quả phân tích vào bảng `profiles`.
   * Trước đây store.saveProfile không có caller nào → bảng luôn rỗng →
   * spy_channel_profile luôn trả hooks:null, topics:null.
   */
  private persist(spyRunId: string, kind: string, scope: 'channel' | 'video', scopeId: string, payload: unknown): void {
    if (payload === null || payload === undefined) return;
    this.store.saveProfile({
      scope,
      scopeId,
      spyRunId,
      kind,
      payload,
      evidence: collectEvidence(payload),
      model: this.llm.model,
    });
  }

  private channelScopeId(spyRunId: string): string {
    const run = this.store.getSpyRun(spyRunId);
    return run?.sourceIdentity ?? spyRunId;
  }

  async hookTaxonomy(spyRunId: string, videoIds?: string[]) {
    const result = await analyzeHooks(this.store, this.llm, spyRunId, videoIds);
    // Chỉ cache khi phân tích toàn kênh; bản lọc theo videoIds không đại diện cho kênh.
    if (!videoIds || videoIds.length === 0) {
      this.persist(spyRunId, 'hooks', 'channel', this.channelScopeId(spyRunId), result);
    }
    return result;
  }

  async topicClusters(spyRunId: string) {
    const result = await analyzeTopics(this.store, this.llm, spyRunId);
    this.persist(spyRunId, 'topics', 'channel', this.channelScopeId(spyRunId), result);
    return result;
  }

  async voiceProfile(spyRunId: string) {
    const result = await analyzeVoice(this.store, this.llm, spyRunId);
    this.persist(spyRunId, 'voice', 'channel', this.channelScopeId(spyRunId), result);
    return result;
  }

  async videoStructure(spyRunId: string, sourceVideoId: string) {
    const result = await analyzeStructure(this.store, this.llm, spyRunId, sourceVideoId);
    this.persist(spyRunId, 'structure', 'video', sourceVideoId, result);
    return result;
  }

  async outlierExplanation(spyRunId: string, sourceVideoId: string, outlierScore: number, cohort: string) {
    const result = await analyzeOutlier(this.store, this.llm, spyRunId, sourceVideoId, outlierScore, cohort);
    this.persist(spyRunId, 'outlier', 'video', sourceVideoId, result);
    return result;
  }
}

export * from './evidence.ts';
export * from './hook.ts';
export * from './cluster.ts';
export * from './voice.ts';
export * from './structure.ts';
export * from './outlier.ts';
