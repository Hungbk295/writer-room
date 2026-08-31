import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpyService } from '../src/index.ts';
import type { YoutubePort } from '../src/adapters/ytdlp.ts';
import type { CapturedDirectSuggestion, RecommendationCapturePort } from '../src/adapters/recommendation-capture.ts';
import type { GeminiFlashAnalysisPort } from '../src/adapters/gemini-flash.ts';
import type { YouTubeDataApiPort } from '../src/adapters/data-api.ts';

const roots: Array<{ root: string; spy: SpyService }> = [];

afterEach(async () => {
  for (const { root, spy } of roots.splice(0)) {
    spy.store.close();
    await rm(root, { recursive: true, force: true });
  }
});

class ThrowingDataApi {
  calls = 0;
  private fail(): never {
    this.calls += 1;
    throw new Error('Data API must not be touched by Corpus Intelligence P0');
  }
  async search() { return this.fail(); }
  async fetchVideoStatistics() { return this.fail(); }
  async fetchChannelStatistics() { return this.fail(); }
  async fetchFeaturedChannels() { return this.fail(); }
  async fetchPublicSubscriptions() { return this.fail(); }
  async fetchVideoComments() { return this.fail(); }
  async listUploadsPlaylistItems() { return this.fail(); }
}

class TraceRecommendations implements RecommendationCapturePort {
  calls: Array<{ depth: number; limit: number; seed: string }> = [];
  items: CapturedDirectSuggestion[] = [{ observedUrl: 'https://youtu.be/zyx987wvu65', observedPosition: 1, title: 'Target', channelTitle: 'Kênh B' }];

  async captureDirect(input: Parameters<RecommendationCapturePort['captureDirect']>[0]) {
    this.calls.push({ depth: input.depth, limit: input.limit, seed: input.seed.sourceVideoId });
    return {
      method: 'fixture_direct_suggestions', adapterVersion: 'test-v1', observedAt: '2026-08-26T00:00:00.000Z',
      observedSeedUrl: input.seed.canonicalUrl, normalizedEvidence: new TextEncoder().encode('{"cookie":"never persist"}'),
      suggestions: this.items,
    };
  }
}

const youtube = {
  async inspectVideo(canonicalUrl: string) {
    return {
      sourceVideoId: canonicalUrl.includes('abc123def45') ? 'abc123def45' : 'zyx987wvu65', canonicalUrl,
      title: 'Observed title', channelTitle: 'Observed channel', channelId: 'UC_observed', viewCount: 42,
      durationSec: 90, publishedAt: '2026-08-01T00:00:00.000Z', thumbnailUrl: 'https://image.test/thumb.jpg',
    };
  },
  async fetchTranscript() {
    return { status: 'ok' as const, language: 'vi', source: 'manual' as const, segments: [{ startSec: 0, endSec: 2, text: 'Nội dung bằng chứng.' }] };
  },
  async listChannel() { return []; },
  async streamUrl() { return 'https://stream.test/video'; },
  async thumbnail() { return { bytes: new TextEncoder().encode('thumbnail'), mimeType: 'image/jpeg' }; },
} as YoutubePort;

class MockGemini implements GeminiFlashAnalysisPort {
  model = 'gemini-flash-fixture';
  shouldFail = false;
  async analyze(input: any) {
    if (this.shouldFail) {
      throw new Error('Simulated Gemini malformed response error');
    }
    const evidence = input.manifest['evidence'] as Array<{ evidenceId: string }>;
    return {
      labels: ['education'], keywordCandidates: ['tài chính cá nhân'],
      claims: [{ text: 'Claim chỉ từ evidence.', evidence: [{ evidenceId: evidence[0]!.evidenceId }] }],
      rawResponse: new TextEncoder().encode('{"ok":true}'),
    };
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'spy-corpus-intelligence-hardgate-'));
  const dataApi = new ThrowingDataApi();
  const recommendations = new TraceRecommendations();
  const gemini = new MockGemini();
  const spy = new SpyService({
    dataRoot: root, youtube, dataApi: dataApi as unknown as YouTubeDataApiPort,
    recommendationCapture: recommendations, geminiFlash: gemini,
  });
  await spy.init();
  spy.store.upsertTopic({ topicId: 'finance-vi', label: 'Tài chính', market: 'VN', language: 'vi' });
  roots.push({ root, spy });
  return { spy, dataApi, recommendations, gemini };
}

describe('Corpus Intelligence Hard-Gate P0 Constraints', () => {
  test('P0 draft/confirm isolation vs candidate/topic/topic_source & Retry/idempotency & Throwing Data API stays zero calls', async () => {
    const { spy, dataApi } = await setup();
    
    // Draft state must isolate from main topic maps
    const draft = await spy.corpus.importVideoDraft({
      topicId: 'finance-vi', submittedUrl: 'https://www.youtube.com/watch?v=abc123def45', ownerSubject: 'local-desktop', idempotencyKey: 'import-1',
    });
    expect(draft.batch.status).toBe('draft');
    expect(spy.corpus.overview('finance-vi').memberships).toHaveLength(0);
    expect(spy.store.listCandidates()).toHaveLength(0);
    expect(dataApi.calls).toBe(0);

    // Idempotency: Duplicate draft import should yield same batch
    const duplicateDraft = await spy.corpus.importVideoDraft({
      topicId: 'finance-vi', submittedUrl: 'https://www.youtube.com/watch?v=abc123def45', ownerSubject: 'local-desktop', idempotencyKey: 'import-1',
    });
    expect(duplicateDraft).toMatchObject({ reused: true, batch: { id: draft.batch.id } });

    // Confirm promotes and makes visible
    const confirmed = spy.corpus.confirmCorpusImport({ batchId: draft.batch.id, ownerSubject: 'local-desktop' });
    expect(confirmed.memberships).toHaveLength(1);
    expect(spy.corpus.overview('finance-vi').memberships).toHaveLength(1);
    expect(dataApi.calls).toBe(0);
  });

  test('C3 invalid seed/depth/lookalike/over20 with no port call where appropriate & C3 nonrecursive', async () => {
    const { spy, recommendations } = await setup();
    
    // Invalid seed: port should not be called
    await expect(spy.corpus.captureSuggestions({
      topicId: 'finance-vi', seedMembershipId: 'missing-seed', ownerSubject: 'local-desktop', idempotencyKey: 'cap-1',
    })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(recommendations.calls).toHaveLength(0);

    // Setup seed
    const draft = await spy.corpus.importVideoDraft({
      topicId: 'finance-vi', submittedUrl: 'https://www.youtube.com/watch?v=abc123def45', ownerSubject: 'local-desktop', idempotencyKey: 'import-1',
    });
    const seed = spy.corpus.confirmCorpusImport({ batchId: draft.batch.id, ownerSubject: 'local-desktop' }).memberships[0]!;

    // Invalid depth (e.g. depth > 1): port should not be called
    await expect(spy.corpus.captureSuggestions({
      topicId: 'finance-vi', seedMembershipId: seed.id, ownerSubject: 'local-desktop', idempotencyKey: 'cap-2', depth: 2,
    })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(recommendations.calls).toHaveLength(0);

    // Lookalike URL: Port called but batch fails closed
    recommendations.items = [{ observedUrl: 'https://www.youtube.com.evil.test/watch?v=zyx987wvu65', observedPosition: 1, title: 'T', channelTitle: 'C' }];
    await expect(spy.corpus.captureSuggestions({
      topicId: 'finance-vi', seedMembershipId: seed.id, ownerSubject: 'local-desktop', idempotencyKey: 'cap-3',
    })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(spy.corpus.overview('finance-vi').recommendationBatches[0]).toMatchObject({ status: 'failed', observations: [] });
    
    // Over 20 limit from provider fails batch completely
    recommendations.items = Array.from({ length: 21 }, (_, index) => ({ observedUrl: `https://www.youtube.com/watch?v=${index.toString().padStart(11, 'a')}`, observedPosition: index + 1, title: 'T', channelTitle: 'C' }));
    await expect(spy.corpus.captureSuggestions({
      topicId: 'finance-vi', seedMembershipId: seed.id, ownerSubject: 'local-desktop', idempotencyKey: 'cap-4',
    })).rejects.toMatchObject({ code: 'malformed_provider_output' });
    expect(spy.corpus.overview('finance-vi').recommendationBatches[1]).toMatchObject({ status: 'failed', observations: [] });
    
    // Nonrecursive constraint
    recommendations.items = [{ observedUrl: 'https://www.youtube.com/watch?v=zyx987wvu65', observedPosition: 1, title: 'T', channelTitle: 'C' }];
    const captured = await spy.corpus.captureSuggestions({
      topicId: 'finance-vi', seedMembershipId: seed.id, ownerSubject: 'local-desktop', idempotencyKey: 'cap-valid',
    });
    const promoted = spy.corpus.decideSuggestion({ observationId: captured.observations[0]!.id, ownerSubject: 'local-desktop', decision: 'confirmed' });
    await expect(spy.corpus.captureSuggestions({
      topicId: 'finance-vi', seedMembershipId: promoted.membership!.id, ownerSubject: 'local-desktop', idempotencyKey: 'cap-recurse',
    })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  test('Malformed Gemini is failed and no automatic corpus mutation', async () => {
    const { spy, gemini } = await setup();
    const draft = await spy.corpus.importVideoDraft({
      topicId: 'finance-vi', submittedUrl: 'https://www.youtube.com/watch?v=abc123def45', ownerSubject: 'local-desktop', idempotencyKey: 'import-1',
    });
    const seed = spy.corpus.confirmCorpusImport({ batchId: draft.batch.id, ownerSubject: 'local-desktop' }).memberships[0]!;
    await spy.corpus.enrichMembership({ membershipId: seed.id, ownerSubject: 'local-desktop' });
    
    // Force Gemini to throw
    gemini.shouldFail = true;
    const initialOverview = spy.corpus.overview('finance-vi');
    
    await expect(spy.corpus.analyzeMembership({
      topicId: 'finance-vi', membershipId: seed.id, ownerSubject: 'local-desktop', idempotencyKey: 'analysis-malformed',
    })).rejects.toThrow();

    // Verify corpus structurally remains unmutated (no labels/claims/etc from hallucination)
    const failedOverview = spy.corpus.overview('finance-vi');
    expect(failedOverview.memberships[0]!.status).toEqual(initialOverview.memberships[0]!.status);
    expect(failedOverview.memberships[0]!.analyses[0]!.status).toBe('failed');
  });

  test('Evidence 30-day tombstone/analysis expiry', async () => {
    const { spy } = await setup();
    const draft = await spy.corpus.importVideoDraft({
      topicId: 'finance-vi', submittedUrl: 'https://www.youtube.com/watch?v=abc123def45', ownerSubject: 'local-desktop', idempotencyKey: 'import-expiry',
    });
    const seed = spy.corpus.confirmCorpusImport({ batchId: draft.batch.id, ownerSubject: 'local-desktop' }).memberships[0]!;
    const evidence = await spy.corpus.enrichMembership({ membershipId: seed.id, ownerSubject: 'local-desktop' });
    const analysis = await spy.corpus.analyzeMembership({
      topicId: 'finance-vi', membershipId: seed.id, ownerSubject: 'local-desktop', idempotencyKey: 'analysis-expiry',
    });
    
    const expired = await spy.corpus.expirePublicEvidence({ now: '2026-10-01T00:00:00.000Z' });
    expect(expired.purged).toBeGreaterThan(0);
    expect(spy.store.getP0CorpusMembership(seed.id)?.status).toBe('expired');
    expect(spy.store.listP0EvidenceRecords(seed.id).every((item) => item.status === 'expired')).toBe(true);
    expect(spy.store.getP0SemanticAnalysisRun(analysis.run.id)?.status).toBe('expired');
  });
});
