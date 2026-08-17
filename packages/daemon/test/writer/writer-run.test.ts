/**
 * Writer — plan stage first; draft only after decisions + Taste retrieve.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WriterReadyProfile } from '@writer-room/training-core';
import { toWriterProfileView } from '@writer-room/training-core';
import { createAgentHarness } from '../../src/harness.ts';
import { listJobNotifications } from '../../src/notifications.ts';
import { saveProfile } from '../../src/training/profile-store.ts';
import { createWriterPack } from '../../src/writer-packs.ts';
import {
  continueWriterFromSalvagedDraft,
  findIdentityLeak,
  forbiddenHostNames,
  pinProfileHash,
  registerWriterSettleListener,
  startWriterRun,
  targetWordRange,
  validateEditorialPlan,
  WRITER_DRAFT_STAGE,
  WRITER_PLAN_STAGE,
  WRITER_REVIEW_STAGE,
} from '../../src/writer/writer-run.ts';
import {
  buildWriterQualityRubric,
  toWriterDraftProfileView,
  validateAndScoreWriterQualityReview,
} from '../../src/writer/quality-review.ts';
import { getWriterRun, listWriterRuns, saveWriterRun } from '../../src/writer/run-store.ts';
import type { DispatchItemParams, DispatchItemResult, LaneScheduler } from '../../src/pipeline/lane-scheduler.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wr-writer-run-'));
  process.env.WRITER_TASTE_RAG_SKIP_QMD = '1';
  process.env.WRITER_TASTE_RAG_ROOT = join(dir, 'empty-taste-store');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.WRITER_TASTE_RAG_SKIP_QMD;
  delete process.env.WRITER_TASTE_RAG_ROOT;
});

function profile(id = 'prof-1'): WriterReadyProfile {
  return {
    kind: 'WRITER_READY_PROFILE',
    id,
    version: 1,
    label: 'Tài chính cá nhân — series A',
    readiness: 'TRIAL',
    scope: { language: 'vi', contentModes: ['short-form'] },
    editorialPromise: 'Rõ ràng, có số liệu, không hype',
    guidelines: [
      {
        id: 'g1',
        instruction: 'Mở bằng tình huống có số liệu cụ thể từ nguồn',
        priority: 'CORE',
        sourceRuleIds: ['secret-formula-rule-1'],
      },
    ],
    antiPatterns: ['Fake specificity'],
    createdAt: '2026-08-11T00:00:00.000Z',
  };
}

function fakeScheduler(
  result: DispatchItemResult = { status: 'RUNNING', turnId: 1, itemRunDir: '/tmp/fake-item' },
): LaneScheduler {
  const calls: DispatchItemParams[] = [];
  return {
    dispatchItem: async (params: DispatchItemParams) => {
      calls.push(params);
      return result;
    },
    onItemSettled: () => {},
    _calls: calls,
  } as unknown as LaneScheduler & { _calls: DispatchItemParams[] };
}

function videoPlan() {
  return {
    coreInsight: 'Thu nhập chỉ có ý nghĩa khi còn phần được quyền quyết định.',
    memoryAnchor: {
      kind: 'contrast' as const,
      value: 'Lương đi vào và lương còn quyền quyết định',
    },
    progression: [
      {
        beat: 'Số dư cuối tháng',
        newInformation: 'Thu nhập cao nhưng phần còn lại rất thấp.',
        characterOrArgumentChange: 'Nhân vật thôi nhìn tổng lương và bắt đầu nhìn phần còn lại.',
        visualAnchor: '25 triệu đi vào, 5 triệu còn lại',
      },
      {
        beat: 'Khoản tiền đã được hẹn trước',
        newInformation: 'Phần lớn lương đã bị khóa vào nghĩa vụ cố định.',
        characterOrArgumentChange: 'Người xem có một phép tính để tự soi.',
        visualAnchor: 'Các khoản trừ phủ kín cột thu nhập',
      },
    ],
    endingPayoff: {
      resolvesOpening: 'Giải thích vì sao lương 25 triệu vẫn không tạo cảm giác có tiền.',
      audienceCanDo: 'Lấy thu nhập thực nhận trừ các nghĩa vụ bắt buộc.',
    },
    cutList: ['Mốc tự do tài chính 25 lần chi phí'],
  };
}

describe('toWriterProfileView', () => {
  test('strips sourceRuleIds from agent projection', () => {
    const view = toWriterProfileView(profile());
    expect(view.guidelines[0]).not.toHaveProperty('sourceRuleIds');
  });

  test('draft projection keeps CORE guidance and hides OPTIONAL checkpoints', () => {
    const view = toWriterProfileView({
      ...profile(),
      guidelines: [
        ...profile().guidelines,
        {
          id: 'g-optional',
          instruction: 'Dùng ẩn dụ khi phù hợp',
          priority: 'OPTIONAL',
          sourceRuleIds: [],
        },
      ],
    });
    const draftView = toWriterDraftProfileView(view);
    expect(draftView.guidelines.map((guideline) => guideline.id)).toEqual(['g1']);
    expect(draftView.antiPatterns).toEqual(['Fake specificity']);
  });
});

describe('writer quality checkpoints', () => {
  test('adds three soft video-effect checkpoints without making them hard gates', () => {
    const rubric = buildWriterQualityRubric(toWriterProfileView(profile()), [], videoPlan());
    const effects = rubric.checkpoints.filter((checkpoint) => checkpoint.kind === 'VIDEO_EFFECT');
    expect(effects.map((checkpoint) => checkpoint.refId)).toEqual([
      'video:memorable-core',
      'video:information-progression',
      'video:ending-payoff',
    ]);
    expect(effects.every((checkpoint) => checkpoint.optional === false)).toBe(true);
    expect(rubric.antiPatterns.every((pattern) => pattern.refId !== 'video:memorable-core')).toBe(true);
  });

  test('uses a percentage threshold, excludes NA, and applies anti-pattern penalties', () => {
    const view = toWriterProfileView({
      ...profile(),
      guidelines: [
        ...profile().guidelines,
        {
          id: 'g-optional',
          instruction: 'Dùng ẩn dụ khi phù hợp',
          priority: 'OPTIONAL',
          sourceRuleIds: [],
        },
      ],
    });
    const rubric = buildWriterQualityRubric(view, [{
      id: 'd1',
      decisionType: 'OPENING',
      situation: 'Mở bằng một tình huống cụ thể',
    }]);
    const script = 'An mở ứng dụng ngân hàng. Phần tiền giữ lại gần như đứng yên.';
    const result = validateAndScoreWriterQualityReview({
      checkpoints: [
        {
          refId: 'decision:d1',
          status: 'PASS',
          note: 'Có cảnh cụ thể.',
          evidenceQuote: 'An mở ứng dụng ngân hàng.',
        },
        {
          refId: 'guideline:g1',
          status: 'PARTIAL',
          note: 'Có số liệu nhưng chưa đủ rõ.',
          evidenceQuote: 'Phần tiền giữ lại gần như đứng yên.',
        },
        {
          refId: 'guideline:g-optional',
          status: 'NA',
          note: 'Bài này không cần ẩn dụ.',
        },
      ],
      antiPatterns: [
        {
          refId: 'anti:1',
          violated: true,
          note: 'Chi tiết chưa có nguồn.',
          evidenceQuote: 'An mở ứng dụng ngân hàng.',
        },
      ],
    }, {
      round: 1,
      script,
      checkpoints: rubric.checkpoints,
      antiPatterns: rubric.antiPatterns,
      threshold: 70,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // (2 + 0.75) / (2 + 1.5) = 79%, then one 10-point penalty = 69%.
      expect(result.review.score).toBe(69);
      expect(result.review.passed).toBe(false);
    }
  });

  test('a fabricated-source hard gate fails even when the numeric score is above threshold', () => {
    const rubric = buildWriterQualityRubric(toWriterProfileView(profile()), []);
    expect(rubric.antiPatterns[0]?.blocking).toBe(true);

    const script = 'Minh nhận 25 triệu mỗi tháng theo một case không có trong nguồn.';
    const result = validateAndScoreWriterQualityReview({
      checkpoints: [
        {
          refId: 'guideline:g1',
          status: 'PASS',
          note: 'Có tình huống và số cụ thể.',
          evidenceQuote: 'Minh nhận 25 triệu mỗi tháng',
        },
      ],
      antiPatterns: [
        {
          refId: 'anti:1',
          violated: true,
          note: 'Case và số tiền không tồn tại trong Source Pack.',
          evidenceQuote: 'Minh nhận 25 triệu mỗi tháng',
        },
      ],
    }, {
      round: 1,
      script,
      checkpoints: rubric.checkpoints,
      antiPatterns: rubric.antiPatterns,
      threshold: 70,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.review.score).toBe(90);
      expect(result.review.passed).toBe(false);
      expect(result.review.hardGateViolations).toEqual(['anti:1']);
    }
  });

  test('adds the factual hard gate when an older Profile does not declare one', () => {
    const rubric = buildWriterQualityRubric(toWriterProfileView({
      ...profile(),
      antiPatterns: ['Forced humor'],
    }), []);
    expect(rubric.antiPatterns).toContainEqual({
      refId: 'hard:source-grounding',
      pattern: 'Không bịa số liệu, case study hoặc dữ kiện không có trong Source Pack.',
      blocking: true,
    });
  });
});

describe('validateEditorialPlan', () => {
  test('accepts a video packaging plan plus 2–4 decisions', () => {
    const v = validateEditorialPlan({
      videoPlan: videoPlan(),
      decisions: [
        {
          decisionType: 'OPENING',
          situation: 'Contrast office vs side hustle before listing models',
          geometryTags: ['hook_strategy', 'contrast'],
          query: {
            intent: 'Find decision_case on opening contrast not topic SME',
            lex: 'decision_case hook_strategy contrast',
            vec: 'Audience comparing office salary to small business models',
            hyde: 'A decision case opens with contrast then lists models with transfer limits',
          },
        },
        {
          decisionType: 'ANGLE',
          situation: 'Define "lãi hơn" as cashflow and time not vanity revenue',
          geometryTags: ['angle_selection'],
        },
      ],
    });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.videoPlan.memoryAnchor.kind).toBe('contrast');
      expect(v.decisions).toHaveLength(2);
      expect(v.decisions[0]!.query?.lex).toContain('decision_case');
    }
  });

  test('rejects fewer than 2 decisions', () => {
    const v = validateEditorialPlan({
      videoPlan: videoPlan(),
      decisions: [{ decisionType: 'OPENING', situation: 'x' }],
    });
    expect(v.ok).toBe(false);
  });

  test('rejects decisions without the video packaging contract', () => {
    const v = validateEditorialPlan({
      decisions: [
        { decisionType: 'OPENING', situation: 'x' },
        { decisionType: 'ANGLE', situation: 'y' },
      ],
    });
    expect(v.ok).toBe(false);
  });
});

describe('startWriterRun', () => {
  test('dispatches PLAN stage first — no draft, no preloaded taste from title', async () => {
    const p = profile();
    await saveProfile(p, dir);
    const pack = await createWriterPack({
      title: 'Pack demo',
      markdown: '# Fact\n\nLương trung bình 15 triệu.\n\n## Video A\n\ntext',
      channelTitle: 'Demo',
    }, dir);

    const scheduler = fakeScheduler();
    const run = await startWriterRun(
      { scheduler, dataDir: dir },
      {
        brief: 'Viết script ngắn',
        title: '5 Mô Hình Kinh Doanh Nhỏ Nhưng Lãi Hơn Cả Đi Làm Văn Phòng',
        packId: pack.id,
        profileId: p.id,
        agentId: 'codex',
      },
    );

    expect(run.status).toBe('RUNNING');
    expect(run.phase).toBe('PLANNING');
    expect(run.profileHash).toBe(pinProfileHash(p));
    expect(run.editorialDecisions).toEqual([]);
    expect(run.videoPlan).toBeNull();
    expect(run.tastePrecedents).toEqual([]);
    expect(run.draft).toBeNull();

    const calls = (scheduler as unknown as { _calls: DispatchItemParams[] })._calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.stage).toBe(WRITER_PLAN_STAGE);
    expect(calls[0]!.promptMarkdown).toContain('PLAN the video');
    expect(calls[0]!.promptMarkdown).not.toContain('title-first draft');
    expect(calls[0]!.promptMarkdown).toContain('one dominant progression');
    expect(calls[0]!.promptMarkdown).toContain('memoryAnchor');
    expect(calls[0]!.promptMarkdown).toContain('cutList');
    const env = calls[0]!.envelope as {
      packMeta?: { videoTitles?: string[] };
      sourcePack?: unknown;
    };
    // Plan must not ship full pack markdown
    expect(env.sourcePack).toBeUndefined();
    expect(env.packMeta?.videoTitles?.length).toBeGreaterThan(0);
  });

  test('marks FAILED when plan dispatch fails immediately', async () => {
    const p = profile();
    await saveProfile(p, dir);
    const pack = await createWriterPack({
      markdown: 'fact A B C D E F G H I J enough words here for pack',
      title: 'p',
    }, dir);
    const run = await startWriterRun(
      {
        scheduler: fakeScheduler({
          status: 'FAILED',
          reason: 'AGENT_UNAVAILABLE',
          itemRunDir: '/tmp/fake-item',
        }),
        dataDir: dir,
      },
      { brief: 'Viết bài từ pack', packId: pack.id, profileId: p.id },
    );
    expect(run.status).toBe('FAILED');
    expect(run.phase).toBe('FAILED');
    expect(run.errorCode).toBe('AGENT_UNAVAILABLE');
  });
});

describe('Writer completion notification', () => {
  test('creates one alert only when a passing final quality review makes Writer DONE', async () => {
    const harness = await createAgentHarness({ dataDir: dir, defaultProjectRoot: dir });
    try {
      registerWriterSettleListener(harness.pipeline.scheduler, { dataDir: dir });
      const script = 'Một câu có thể kiểm chứng từ bản thảo.';
      await saveWriterRun({
        id: 'writer-notification-test',
        status: 'RUNNING',
        phase: 'REVIEWING',
        brief: 'Kiểm tra thông báo hoàn tất',
        packId: 'pack-notification-test',
        packTitle: 'Pack kiểm tra',
        profileId: 'profile-notification-test',
        profileVersion: 1,
        profileLabel: 'Profile kiểm tra',
        profileHash: 'hash',
        agentId: 'codex',
        editorialDecisions: [],
        videoPlan: null,
        draft: { title: 'Tiêu đề đã hoàn tất', script },
        draftArtifactHash: 'draft-hash',
        currentTitle: 'Tiêu đề đã hoàn tất',
        currentScript: script,
        edits: [],
        tastePrecedents: [],
        tasteRagWarnings: [],
        qualityChecklist: [{
          refId: 'check-1', kind: 'PROFILE_GUIDELINE', label: 'Profile',
          instruction: 'Có bằng chứng từ bản thảo', weight: 1, optional: false,
        }],
        qualityAntiPatterns: [{
          refId: 'hard:source-grounding', pattern: 'Không bịa dữ kiện Source Pack.', blocking: true,
        }],
        qualityThreshold: 70,
        qualityReviews: [],
        refineArtifactHash: null,
        createdAt: '2026-08-15T00:00:00.000Z',
        updatedAt: '2026-08-15T00:00:00.000Z',
      }, dir);

      const dispatch = await harness.pipeline.scheduler.dispatchItem({
        batchId: 'writer-notification-test',
        itemId: 'pack-notification-test',
        stage: WRITER_REVIEW_STAGE,
        attempt: 1,
        templateId: 'codex',
        promptMarkdown: 'Review this test draft.',
        envelope: {},
        inputHashes: ['notification-test'],
        promptVersion: 'notification-test',
        validateContent: () => ({ ok: true }),
      });
      expect(dispatch.status).toBe('RUNNING');
      await Bun.write(
        join(dispatch.itemRunDir, 'out', 'result.json'),
        JSON.stringify({
          checkpoints: [{ refId: 'check-1', status: 'PASS', note: 'Có bằng chứng.', evidenceQuote: script }],
          antiPatterns: [{ refId: 'hard:source-grounding', violated: false, note: 'Không có bịa dữ kiện.' }],
        }),
      );
      harness.workflow.turnComplete(dispatch.turnId!, { exitCode: 0 });

      const completed = await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('Writer did not reach DONE')), 3_000);
        const poll = async () => {
          const run = await getWriterRun('writer-notification-test', dir);
          const notifications = await listJobNotifications(dir);
          if (run?.status === 'DONE' && notifications.length === 1) {
            clearTimeout(deadline);
            resolve();
            return;
          }
          setTimeout(() => { void poll(); }, 10);
        };
        void poll();
      });
      await completed;
      expect(await listJobNotifications(dir)).toEqual([
        expect.objectContaining({ kind: 'writer', jobId: 'writer-notification-test', readAt: null }),
      ]);
    } finally {
      harness.dispose();
    }
  });
});

describe('continueWriterFromSalvagedDraft', () => {
  test('commits orphan draft and dispatches quality review', async () => {
    const p = profile();
    await saveProfile(p, dir);
    const pack = await createWriterPack({
      title: 'Pack demo',
      markdown: '# Fact\n\nLương trung bình 15 triệu.\n\n## Video A\n\ntext',
      channelTitle: 'Demo',
    }, dir);

    const runId = 'salvage-run-1';
    const itemRunDir = join(
      dir,
      'workspaces',
      'pipeline',
      runId,
      pack.id,
      'attempts',
      '1',
      WRITER_DRAFT_STAGE,
    );
    mkdirSync(join(itemRunDir, 'out'), { recursive: true });
    writeFileSync(
      join(itemRunDir, 'out', 'result.json'),
      JSON.stringify({
        title: 'Lương cao vẫn kẹt tiền',
        script: 'Minh nhận 25 triệu. Tiền đã bị hẹn trước. '.repeat(20),
      }),
      'utf8',
    );

    const checklist = buildWriterQualityRubric(toWriterProfileView(p), [{
      id: 'd1',
      decisionType: 'OPENING',
      situation: 'Mở bằng tình huống cụ thể',
    }]);
    await saveWriterRun({
      id: runId,
      status: 'FAILED',
      phase: 'FAILED',
      brief: 'Lương 25 triệu vẫn không có tiền',
      packId: pack.id,
      packTitle: pack.title,
      profileId: p.id,
      profileVersion: p.version,
      profileLabel: p.label,
      profileHash: pinProfileHash(p),
      agentId: 'grok',
      editorialDecisions: [],
      videoPlan: null,
      draft: null,
      draftArtifactHash: null,
      currentTitle: null,
      currentScript: null,
      edits: [],
      tastePrecedents: [],
      tasteRagWarnings: [],
      qualityChecklist: checklist.checkpoints,
      qualityAntiPatterns: checklist.antiPatterns,
      qualityThreshold: 70,
      qualityReviews: [],
      refineArtifactHash: null,
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
      errorCode: 'AGENT_EXIT',
    }, dir);

    const scheduler = fakeScheduler();
    const run = await continueWriterFromSalvagedDraft({ scheduler, dataDir: dir }, runId);

    expect(run.status).toBe('RUNNING');
    expect(run.phase).toBe('REVIEWING');
    expect(run.draft?.title).toContain('Lương');
    expect(run.currentScript).toBeTruthy();
    expect(run.draftArtifactHash).toBeTruthy();
    expect(run.errorCode).toBeUndefined();

    const calls = (scheduler as unknown as { _calls: DispatchItemParams[] })._calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.stage).toBe(WRITER_REVIEW_STAGE);
    expect(calls[0]!.attempt).toBe(1);
    expect(calls[0]!.promptMarkdown).toContain('Judge whole-piece shape');
    expect(calls[0]!.promptMarkdown).toContain('blocking: true');
  });
});

describe('targetWordRange', () => {
  test('keeps ±20% with floor 80', () => {
    expect(targetWordRange(100)).toEqual({ minWords: 80, maxWords: 140 });
  });
});

describe('identity fence', () => {
  test('catches Hiếu host identity', () => {
    const forbidden = forbiddenHostNames({ channelTitle: 'Hieu Nguyen' });
    expect(findIdentityLeak('Xin chào, tôi là Hiếu.', forbidden)).toBeTruthy();
  });
});

describe('listWriterRuns', () => {
  test('lists summaries newest first', async () => {
    const base = {
      status: 'DONE' as const,
      phase: 'DONE' as const,
      brief: 'b',
      packId: 'p',
      packTitle: 'Pack',
      profileId: 'pr',
      profileVersion: 1,
      profileLabel: 'L',
      profileHash: 'h',
      agentId: 'codex' as const,
      editorialDecisions: [],
      videoPlan: null,
      draft: { title: 't', script: 's' },
      draftArtifactHash: null,
      currentTitle: 't',
      currentScript: 's',
      edits: [],
      tastePrecedents: [],
      tasteRagWarnings: [],
      qualityChecklist: [],
      qualityAntiPatterns: [],
      qualityThreshold: 70,
      qualityReviews: [],
      refineArtifactHash: null,
    };
    await saveWriterRun({
      ...base,
      id: 'r1',
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:00.000Z',
    }, dir);
    await saveWriterRun({
      ...base,
      id: 'r2',
      createdAt: '2026-08-11T01:00:00.000Z',
      updatedAt: '2026-08-11T01:00:00.000Z',
    }, dir);
    const list = await listWriterRuns(dir);
    expect(list.map((r) => r.id)).toEqual(['r2', 'r1']);
    expect(await getWriterRun('r1', dir)).not.toBeNull();
  });
});
