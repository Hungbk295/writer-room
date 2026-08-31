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

const gemini: GeminiFlashAnalysisPort = {
  model: 'gemini-flash-fixture',
  async analyze(input) {
    const evidence = input.manifest['evidence'] as Array<{ evidenceId: string }>;
    return {
      labels: ['education'], keywordCandidates: ['tài chính cá nhân'],
      claims: [{ text: 'Claim chỉ từ evidence.', evidence: [{ evidenceId: evidence[0]!.evidenceId }] }],
      rawResponse: new TextEncoder().encode('{"ok":true}'),
    };
  },
};

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'spy-corpus-intelligence-'));
  const dataApi = new ThrowingDataApi();
  const recommendations = new TraceRecommendations();
  const spy = new SpyService({
    dataRoot: root, youtube, dataApi: dataApi as unknown as YouTubeDataApiPort,
    recommendationCapture: recommendations, geminiFlash: gemini,
  });
  await spy.init();
  spy.store.upsertTopic({ topicId: 'finance-vi', label: 'Tài chính', market: 'VN', language: 'vi' });
  roots.push({ root, spy });
  return { spy, dataApi, recommendations };
}

describe('Corpus Intelligence P0 vertical fixture flow', () => {
  test('draft → confirm → depth-1 draft suggestion → confirm → enrich → evidence-bound Gemini review', async () => {
    const { spy, dataApi, recommendations } = await setup();
    const imported = await spy.corpus.importVideoDraft({
      topicId: 'finance-vi', submittedUrl: 'https://www.youtube.com/watch?v=abc123def45', ownerSubject: 'local-desktop', idempotencyKey: 'import-1',
    });
    expect(imported.batch.status).toBe('draft');
    const retriedWithFreshClientKey = await spy.corpus.importVideoDraft({
      topicId: 'finance-vi', submittedUrl: 'https://youtu.be/abc123def45', ownerSubject: 'local-desktop', idempotencyKey: 'import-retry-after-lost-response',
    });
    expect(retriedWithFreshClientKey).toMatchObject({ reused: true, batch: { id: imported.batch.id } });
    expect(spy.corpus.overview('finance-vi').imports).toHaveLength(1);
    expect(spy.corpus.overview('finance-vi').memberships).toHaveLength(0);
    expect(spy.store.listCandidates()).toHaveLength(0);

    const confirmed = spy.corpus.confirmCorpusImport({ batchId: imported.batch.id, ownerSubject: 'local-desktop' });
    const seed = confirmed.memberships[0]!;
    const captured = await spy.corpus.captureSuggestions({
      topicId: 'finance-vi', seedMembershipId: seed.id, ownerSubject: 'local-desktop', idempotencyKey: 'capture-1',
    });
    expect(recommendations.calls).toEqual([{ depth: 1, limit: 20, seed: 'abc123def45' }]);
    const sameSurface = await spy.corpus.captureSuggestions({
      topicId: 'finance-vi', seedMembershipId: seed.id, ownerSubject: 'local-desktop', idempotencyKey: 'capture-duplicate-key',
    });
    expect(sameSurface).toMatchObject({ reused: true, batch: { id: captured.batch.id } });
    expect(recommendations.calls).toHaveLength(1);
    expect(captured.batch.status).toBe('draft');
    expect(captured.observations[0]).toMatchObject({ fromVideoId: 'abc123def45', targetVideoId: 'zyx987wvu65', status: 'draft' });
    const receipt = await spy.artifacts.read(captured.batch.captureArtifact!);
    expect(receipt.toString()).not.toContain('cookie');
    expect(spy.store.listCandidates()).toHaveLength(0);

    const promoted = spy.corpus.decideSuggestion({ observationId: captured.observations[0]!.id, ownerSubject: 'local-desktop', decision: 'confirmed' });
    expect(promoted.membership?.sourceVideoId).toBe('zyx987wvu65');
    await expect(spy.corpus.captureSuggestions({
      topicId: 'finance-vi', seedMembershipId: promoted.membership!.id, ownerSubject: 'local-desktop', idempotencyKey: 'must-not-recurse',
    })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(recommendations.calls).toHaveLength(1);
    const evidence = await spy.corpus.enrichMembership({ membershipId: promoted.membership!.id, ownerSubject: 'local-desktop' });
    expect(evidence.map((item) => item.status)).toEqual(['available', 'available', 'available']);
    const manifest = spy.corpus.buildAnalysisManifest({ membershipId: promoted.membership!.id });
    expect(manifest.manifest['evidence']).toBeInstanceOf(Array);
    const analyzed = await spy.corpus.analyzeMembership({
      topicId: 'finance-vi', membershipId: promoted.membership!.id, ownerSubject: 'local-desktop', idempotencyKey: 'analysis-1',
    });
    expect(analyzed.run.status).toBe('completed');
    expect(analyzed.run.result).toMatchObject({ source: 'gemini_flash_review' });
    const sameManifest = await spy.corpus.analyzeMembership({
      topicId: 'finance-vi', membershipId: promoted.membership!.id, ownerSubject: 'local-desktop', idempotencyKey: 'analysis-duplicate-key',
    });
    expect(sameManifest).toMatchObject({ reused: true, run: { id: analyzed.run.id } });
    expect(dataApi.calls).toBe(0);
  });

  test('invalid seed/input does not call C3; idempotency does not call it twice', async () => {
    const { spy, recommendations } = await setup();
    await expect(spy.corpus.captureSuggestions({
      topicId: 'finance-vi', seedMembershipId: 'missing', ownerSubject: 'local-desktop', idempotencyKey: 'missing',
    })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(recommendations.calls).toHaveLength(0);
    const imported = await spy.corpus.importVideoDraft({
      topicId: 'finance-vi', submittedUrl: 'https://www.youtube.com/watch?v=abc123def45', ownerSubject: 'local-desktop', idempotencyKey: 'import-1',
    });
    const seed = spy.corpus.confirmCorpusImport({ batchId: imported.batch.id, ownerSubject: 'local-desktop' }).memberships[0]!;
    await expect(spy.corpus.captureSuggestions({
      topicId: 'finance-vi', seedMembershipId: seed.id, ownerSubject: 'local-desktop', idempotencyKey: 'bad-depth', depth: 2,
    })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(recommendations.calls).toHaveLength(0);
    const first = await spy.corpus.captureSuggestions({
      topicId: 'finance-vi', seedMembershipId: seed.id, ownerSubject: 'local-desktop', idempotencyKey: 'same',
    });
    const again = await spy.corpus.captureSuggestions({
      topicId: 'finance-vi', seedMembershipId: seed.id, ownerSubject: 'local-desktop', idempotencyKey: 'same',
    });
    expect(again).toMatchObject({ reused: true, batch: { id: first.batch.id } });
    expect(recommendations.calls).toHaveLength(1);
  });

  test('adapter over limit or a lookalike URL fails closed and creates no drafts', async () => {
    const { spy, recommendations } = await setup();
    const imported = await spy.corpus.importVideoDraft({
      topicId: 'finance-vi', submittedUrl: 'https://www.youtube.com/watch?v=abc123def45', ownerSubject: 'local-desktop', idempotencyKey: 'import-1',
    });
    const seed = spy.corpus.confirmCorpusImport({ batchId: imported.batch.id, ownerSubject: 'local-desktop' }).memberships[0]!;
    recommendations.items = Array.from({ length: 21 }, (_, index) => ({ observedUrl: `https://www.youtube.com/watch?v=${index.toString().padStart(11, 'a')}`, observedPosition: index + 1 }));
    await expect(spy.corpus.captureSuggestions({
      topicId: 'finance-vi', seedMembershipId: seed.id, ownerSubject: 'local-desktop', idempotencyKey: 'over',
    })).rejects.toMatchObject({ code: 'malformed_provider_output' });
    const failed = spy.corpus.overview('finance-vi').recommendationBatches[0]!;
    expect(failed).toMatchObject({ status: 'failed', observations: [] });
    recommendations.items = [{ observedUrl: 'https://www.youtube.com.evil.test/watch?v=zyx987wvu65', observedPosition: 1 }];
    await expect(spy.corpus.captureSuggestions({
      topicId: 'finance-vi', seedMembershipId: seed.id, ownerSubject: 'local-desktop', idempotencyKey: 'lookalike',
    })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(spy.corpus.overview('finance-vi').recommendationBatches[0]).toMatchObject({ status: 'failed', observations: [] });
  });

  test('manual tick honours kill-switch, checkpoints enrichment/review, and writes one report per logical run', async () => {
    const { spy } = await setup();
    const imported = await spy.corpus.importVideoDraft({
      topicId: 'finance-vi', submittedUrl: 'https://www.youtube.com/watch?v=abc123def45', ownerSubject: 'local-desktop', idempotencyKey: 'import-1',
    });
    spy.corpus.confirmCorpusImport({ batchId: imported.batch.id, ownerSubject: 'local-desktop' });
    const blocked = await spy.corpus.runManualTick({ topicId: 'finance-vi', ownerSubject: 'local-desktop', idempotencyKey: 'tick-1' });
    expect(blocked.run.status).toBe('blocked');
    expect(blocked.report).toBeNull();
    spy.corpus.setLoopEnabled({ topicId: 'finance-vi', enabled: true });
    const done = await spy.corpus.runManualTick({ topicId: 'finance-vi', ownerSubject: 'local-desktop', idempotencyKey: 'tick-2' });
    expect(done.run.status).toBe('completed');
    expect(done.report).not.toBeNull();
    const again = await spy.corpus.runManualTick({ topicId: 'finance-vi', ownerSubject: 'local-desktop', idempotencyKey: 'tick-2' });
    expect(again).toMatchObject({ reused: true, report: { id: done.report!.id } });
    expect(spy.corpus.overview('finance-vi').reports).toHaveLength(1);
  });

  test('30-day expiry tombstones public raw evidence and expires its Gemini derivative', async () => {
    const { spy } = await setup();
    const imported = await spy.corpus.importVideoDraft({
      topicId: 'finance-vi', submittedUrl: 'https://www.youtube.com/watch?v=abc123def45', ownerSubject: 'local-desktop', idempotencyKey: 'import-expiry',
    });
    const seed = spy.corpus.confirmCorpusImport({ batchId: imported.batch.id, ownerSubject: 'local-desktop' }).memberships[0]!;
    const captured = await spy.corpus.captureSuggestions({
      topicId: 'finance-vi', seedMembershipId: seed.id, ownerSubject: 'local-desktop', idempotencyKey: 'capture-expiry',
    });
    const promoted = spy.corpus.decideSuggestion({
      observationId: captured.observations[0]!.id, ownerSubject: 'local-desktop', decision: 'confirmed',
    }).membership!;
    const evidence = await spy.corpus.enrichMembership({ membershipId: promoted.id, ownerSubject: 'local-desktop' });
    const analysis = await spy.corpus.analyzeMembership({
      topicId: 'finance-vi', membershipId: promoted.id, ownerSubject: 'local-desktop', idempotencyKey: 'analysis-expiry',
    });
    const expired = await spy.corpus.expirePublicEvidence({ now: '2026-10-01T00:00:00.000Z' });

    expect(expired.considered).toBeGreaterThanOrEqual(6);
    expect(expired.purged).toBeGreaterThanOrEqual(6);
    expect(spy.store.getP0CorpusMembership(seed.id)?.status).toBe('expired');
    expect(spy.store.getP0CorpusMembership(promoted.id)?.status).toBe('expired');
    expect(spy.store.listP0EvidenceRecords(promoted.id).every((item) => item.status === 'expired')).toBe(true);
    expect(spy.store.getP0SemanticAnalysisRun(analysis.run.id)?.status).toBe('expired');
    expect(spy.store.hasP0ArtifactTombstone(captured.batch.captureArtifact!.hash)).toBe(true);
    for (const item of evidence) {
      if (item.artifact) expect(spy.store.hasP0ArtifactTombstone(item.artifact.hash)).toBe(true);
    }
    await expect(spy.artifacts.read(captured.batch.captureArtifact!)).rejects.toMatchObject({ code: 'asset_unavailable' });
    expect(() => spy.corpus.buildAnalysisManifest({ membershipId: promoted.id })).toThrow(/confirm/);
  });
});
