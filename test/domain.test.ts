import { describe, expect, test } from 'bun:test';
import {
  allHardGatesPass, defaultAgentProfiles, extractJson, normalizeConfig, normalizeHumanBrief,
  parseBackbone, parseClaudeRevision, parseCodexReview, safeRunId, validateReviewBranch,
} from '../src/domain.ts';

const evidence = [{ id: 'E1', kind: 'fact', text: 'Supported fact', sourceRef: 'source:1', confidence: 'high', corroborationIds: [], contradictionIds: [] }];
const insight = [{ id: 'I1', statement: 'Insight', audiencePriorBelief: 'Old belief', audienceDesireOrFear: 'A real desire', tension: 'Evidence creates tension', evidenceIds: ['E1'], counterEvidenceIds: [] }];
const angle = [{ id: 'angle-a', label: 'Angle A', rationale: 'Distinct route', angle: 'Angle', beats: ['beat-1', 'beat-2', 'beat-3'], centralQuestion: 'What is true?', hypothesis: 'A falsifiable claim', throughline: 'One line', audiencePayoff: 'Truthful payoff', evidenceIds: ['E1'], riskFlags: [], recommended: true }];
const hook = [{ id: 'hook-a1', angleId: 'angle-a', label: 'Hook 1', rationale: 'Supported opening', text: 'A concrete opening', strategy: 'scene', promise: 'A truthful promise', openLoop: 'What happens?', payoffBeatId: 'beat-3', evidenceIds: ['E1'], truthRisk: 'low', clickbaitRisk: 'low', recommended: true }];

function backboneFixture() {
  return {
    titlePromise: 'Viewer understands the mechanism.',
    centralQuestion: 'What is true?',
    viewerBefore: 'Unsure',
    viewerAfter: 'Clear',
    mainTakeaway: 'One useful idea',
    contentMode: 'explanatory',
    emotionalIntent: 'Quiet recognition',
    informationIntent: 'Clear mechanism and limits',
    protectedElements: ['Natural voice'],
    evidenceLedger: evidence,
    insightStatements: insight,
    outlineOptions: angle,
    hookOptions: hook,
    interviewQuestions: [],
    selfNotes: [],
  };
}

const hardGateIds = [
  'title_promise_completed',
  'no_major_factual_error',
  'no_major_logical_contradiction',
  'no_unsupported_core_conclusion',
  'no_unresolved_primary_open_loop',
  'no_serious_audience_misleading',
] as const;

function reviewFixture(pass: boolean) {
  return {
    summary: pass ? 'Ready for user.' : 'Title promise needs repair.',
    hardGates: hardGateIds.map((id) => ({
      id,
      status: !pass && id === 'title_promise_completed' ? 'fail' : 'pass',
      evidence: 'Specific draft evidence.',
      reason: 'Listener impact.',
      passCondition: !pass && id === 'title_promise_completed' ? 'Complete the title payoff.' : '',
    })),
    qualityFloors: {
      emotion: { status: 'meets_floor', evidence: 'Natural emotional effect.', opportunity: '' },
      information: { status: 'meets_floor', evidence: 'Clear mechanism.', opportunity: '' },
    },
    suggestions: [{
      id: 'S1',
      level: pass ? 2 : 1,
      ...(!pass ? { targetGate: 'title_promise_completed' } : {}),
      area: pass ? 'emotion' : 'title',
      observation: 'One focused opportunity.',
      evidence: 'Paragraph 3.',
      intendedGain: pass ? 'More resonance.' : 'Clear the gate.',
      options: [{ id: 'S1-A', label: 'Minimal', approach: 'Use existing material.', tradeoff: 'Small change.' }],
      protect: ['Natural voice'],
      riskIfUnchanged: 'Known trade-off.',
    }],
    regressions: [],
  };
}

describe('schema-v3 domain gates', () => {
  test('extracts structured JSON without trusting surrounding prose', () => {
    expect(extractJson('preface\n```json\n{"ok":true,"text":"a } brace"}\n```\nafter')).toEqual({ ok: true, text: 'a } brace' });
  });

  test('normalizes a floor-based two-agent run config', () => {
    const config = normalizeConfig({
      title: 'Video',
      guideText: 'Custom writer guide',
      criteriaText: 'Custom reviewer preferences',
    });
    expect(config.maxAutoRepairRounds).toBe(3);
    expect(config.agentProfiles).toHaveLength(2);
    expect(config.agentProfiles.map((item) => item.role)).toEqual(['writer', 'editor']);
    expect(config).not.toHaveProperty('targetScore');
    expect(safeRunId('r-mock-123456')).toBe(true);
    expect(safeRunId('../escape')).toBe(false);
  });

  test('accepts a compact backbone without forcing three angles or six hooks', () => {
    const backbone = parseBackbone(backboneFixture());
    expect(backbone.outlineOptions).toHaveLength(1);
    expect(backbone.hookOptions).toHaveLength(1);
    const brief = normalizeHumanBrief({
      selectedAngleId: 'angle-a',
      selectedHookId: 'custom',
      customHook: 'Mở bằng câu của chính tôi.',
      answers: {},
    }, backbone);
    expect(brief.customHook).toContain('chính tôi');
  });

  test('derives Level 1 or Level 2 from the six Hard Gates', () => {
    const failing = validateReviewBranch(parseCodexReview(reviewFixture(false)));
    expect(allHardGatesPass(failing)).toBe(false);
    expect(failing.suggestions[0]?.level).toBe(1);
    const passing = validateReviewBranch(parseCodexReview(reviewFixture(true)));
    expect(allHardGatesPass(passing)).toBe(true);
    expect(passing.suggestions[0]?.level).toBe(2);
  });

  test('rejects a Level 2 suggestion while a Hard Gate is unresolved', () => {
    const invalid = reviewFixture(false);
    invalid.suggestions[0]!.level = 2;
    expect(() => validateReviewBranch(parseCodexReview(invalid))).toThrow('Level 1');
  });

  test('requires Codex to offer a Level 2 option even after all gates pass', () => {
    const invalid = reviewFixture(true);
    invalid.suggestions = [];
    expect(() => validateReviewBranch(parseCodexReview(invalid))).toThrow('at least one optional experience suggestion');
  });

  test('requires Claude to decide every Codex suggestion exactly once', () => {
    const review = validateReviewBranch(parseCodexReview(reviewFixture(true)));
    const revision = parseClaudeRevision({
      draftMarkdown: 'Revised full script.',
      changeLog: ['Kept naturalness'],
      appliedHumanInsights: [],
      preservedHumanSignals: ['Natural voice'],
      suggestionDecisions: [{
        suggestionId: 'S1',
        decision: 'rejected',
        reason: 'The trade-off would make the scene feel forced.',
      }],
    }, review);
    expect(revision.suggestionDecisions[0]?.decision).toBe('rejected');
    expect(() => parseClaudeRevision({
      draftMarkdown: 'x',
      changeLog: [],
      appliedHumanInsights: [],
      preservedHumanSignals: [],
      suggestionDecisions: [],
    }, review)).toThrow('every Codex suggestion');
  });

  test('defaults fixed profiles to Claude and Codex', () => {
    expect(defaultAgentProfiles()).toMatchObject([
      { slot: 'agent-1', role: 'writer', adapter: 'claude' },
      { slot: 'agent-2', role: 'editor', adapter: 'codex' },
    ]);
  });
});
