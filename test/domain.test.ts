import { describe, expect, test } from 'bun:test';
import { calculateEditorScore, defaultAgentProfiles, extractJson, normalizeConfig, normalizeHumanBrief, parseEditor, parseWriterInit, passesTarget, safeRunId } from '../src/domain.ts';

describe('domain gates', () => {
  test('extracts fenced and surrounded JSON without accepting prose as state', () => {
    expect(extractJson('preface\n```json\n{"ok":true,"text":"a } brace"}\n```\nafter')).toEqual({ ok: true, text: 'a } brace' });
  });

  test('calculates weighted score instead of trusting modelOverall', () => {
    const review = parseEditor({
      summary: 'Specific review',
      criteriaScores: [
        { criterion: 'Hook', score: 10, weight: 1, evidence: 'Opening line', fix: '' },
        { criterion: 'Truth', score: 7, weight: 3, evidence: 'Claim two', fix: 'Hedge it' },
      ],
      blockingIssues: [], revisionPlan: ['Hedge it'], verdict: 'revise', modelOverall: 10,
    });
    expect(calculateEditorScore(review)).toBe(7.75);
    expect(passesTarget(review, 7)).toBe(false);
  });

  test('requires blockers cleared and explicit pass at target', () => {
    const review = parseEditor({
      summary: 'Good but blocked',
      criteriaScores: [{ criterion: 'Hook', score: 9.5, weight: 1, evidence: 'Line one', fix: '' }],
      blockingIssues: ['Unverified claim'], revisionPlan: [], verdict: 'pass',
    });
    expect(passesTarget(review, 9)).toBe(false);
  });

  test('validates config and safe run ids', () => {
    const config = normalizeConfig({ title: 'Video', guidePath: '/tmp/a', criteriaPath: '/tmp/b' });
    expect(config.targetScore).toBe(9);
    expect(config.maxRounds).toBe(6);
    expect(safeRunId('r-mock-123456')).toBe(true);
    expect(safeRunId('../escape')).toBe(false);
  });

  test('writer init requires exactly three routes and useful questions', () => {
    expect(() => parseWriterInit({ draftMarkdown: 'x', outlineOptions: [], hookOptions: [], interviewQuestions: [] })).toThrow();
  });

  test('writer init binds hooks to evidence/payoff and accepts a human custom hook', () => {
    const evidenceLedger = [{ id: 'E1', kind: 'fact', text: 'Supported fact', sourceRef: 'source:1', confidence: 'high', corroborationIds: [], contradictionIds: [] }];
    const insightStatements = [1, 2, 3].map((id) => ({ id: `I${id}`, statement: `Insight ${id}`, audiencePriorBelief: 'Old belief', audienceDesireOrFear: 'A real desire', tension: 'Evidence creates tension', evidenceIds: ['E1'], counterEvidenceIds: [] }));
    const outlineOptions = ['a', 'b', 'c'].map((id, index) => ({ id: `angle-${id}`, label: `Angle ${id}`, rationale: 'Distinct route', angle: 'Angle', beats: ['beat-1', 'beat-2', 'beat-3'], centralQuestion: 'What is true?', hypothesis: 'A falsifiable claim', throughline: 'One line', audiencePayoff: 'Truthful payoff', evidenceIds: ['E1'], riskFlags: [], recommended: index === 0 }));
    const hookOptions = outlineOptions.flatMap((angle) => [1, 2].map((number) => ({ id: `hook-${angle.id}-${number}`, angleId: angle.id, label: `Hook ${number}`, rationale: 'Supported opening', text: 'A concrete opening', strategy: number === 1 ? 'scene' : 'question', promise: 'A truthful promise', openLoop: 'What happens?', payoffBeatId: 'beat-3', evidenceIds: ['E1'], truthRisk: 'low', clickbaitRisk: 'low', recommended: number === 1 })));
    const initial = parseWriterInit({ draftMarkdown: 'Exploratory draft', evidenceLedger, insightStatements, outlineOptions, hookOptions, interviewQuestions: [{ id: 'voice', question: 'What sounds like you?', why: 'Lock voice', gapType: 'voice', relatedOptionIds: ['angle-a'] }], selfNotes: [] });
    expect(initial.hookOptions).toHaveLength(6);
    const brief = normalizeHumanBrief({ selectedAngleId: 'angle-a', selectedHookId: 'custom', customHook: 'Mở bằng câu của chính tôi.', answers: {} }, initial);
    expect(brief.customHook).toContain('chính tôi');
  });

  test('normalizes three named agent slots with configurable adapter and model', () => {
    const config = normalizeConfig({
      title: 'Video', guidePath: '/tmp/a', criteriaPath: '/tmp/b',
      agentProfiles: [{ slot: 'agent-1', adapter: 'codex', executable: 'codex', model: 'gpt-5-codex', args: ['--reasoning-effort', 'high'] }],
    });
    expect(config.agentProfiles).toHaveLength(3);
    expect(config.agentProfiles[0]).toMatchObject({ slot: 'agent-1', role: 'writer', adapter: 'codex', model: 'gpt-5-codex' });
    expect(config.agentProfiles[1]?.role).toBe('editor');
    expect(config.agentProfiles[2]?.role).toBe('seo');
  });

  test('defaults Agent 3 to the DNA Spy Agy SEO profile', () => {
    expect(defaultAgentProfiles()[2]).toMatchObject({
      role: 'seo',
      adapter: 'agy',
      executable: 'agy',
      model: 'Gemini 3.5 Flash (High)',
    });
  });
});
