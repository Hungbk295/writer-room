import { afterEach, describe, expect, test } from 'bun:test';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArticleLibrary } from '../src/library.ts';
import type { CodexReviewArtifact, RunState, WriterDraftArtifact } from '../src/domain.ts';
import { HARD_GATE_IDS, normalizeConfig, SCHEMA_VERSION } from '../src/domain.ts';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('Writer Room Article Library', () => {
  test('publishes one immutable accepted version and searches Vietnamese text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'writer-room-library-'));
    dirs.push(root);
    const library = new ArticleLibrary(join(root, 'library.sqlite'));
    const config = normalizeConfig({ title: 'Sự thật về sáng tạo', guidePath: '/tmp/guide', criteriaPath: '/tmp/criteria' });
    const state: RunState = {
      schemaVersion: SCHEMA_VERSION, id: 'r-library-123456', tmuxSession: 'wr-library', createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), stage: 'complete', config, round: 2,
      reviews: [{ round: 2, level: 2, allHardGatesPass: true, reviewArtifact: 'artifacts/codex-review-r2.json', draftArtifact: 'artifacts/draft-r2.json' }],
      scores: [], autoRepairCount: 0, lastPassingRound: 2,
      lastPassingReviewArtifact: 'artifacts/codex-review-r2.json', acceptedRound: 2, acceptedBy: 'human',
    };
    const draft: WriterDraftArtifact = { draftMarkdown: '# Sáng tạo\n\nMột sự thật có bằng chứng.', changeLog: [], appliedHumanInsights: [], preservedHumanSignals: [] };
    const review: CodexReviewArtifact = {
      summary: 'All hard gates pass.',
      hardGates: HARD_GATE_IDS.map((id) => ({ id, status: 'pass', evidence: 'draft evidence', reason: 'No blocking issue found.', passCondition: '' })),
      qualityFloors: {
        emotion: { status: 'meets_floor', evidence: 'Human stakes are clear.', opportunity: '' },
        information: { status: 'meets_floor', evidence: 'Core claim is explained.', opportunity: '' },
      },
      suggestions: [], regressions: [],
    };
    const first = library.publish(state, draft, review);
    expect(library.publish(state, draft, review)).toEqual(first);
    expect(library.list('sang tao')).toHaveLength(1);
    expect(library.list('sang tao')[0]?.finalGateStatus).toBe('pass');
    expect(library.get(first.articleId).versions).toHaveLength(1);
    const exported = library.exportArticle(first.articleId);
    await access(exported.path);
    const backup = library.backup();
    await access(backup.path);
    library.setArchived(first.articleId, true);
    expect(library.list()).toHaveLength(0);
    expect(library.list('', true)[0]?.status).toBe('archived');
    library.close();
  });
});
