import type { WriterProfileView } from '@writer-room/training-core';
import type { WriterVideoPlan } from './video-plan.ts';

export const WRITER_QUALITY_THRESHOLD = 70;
export const WRITER_ANTI_PATTERN_PENALTY = 10;
export const WRITER_ANTI_PATTERN_PENALTY_CAP = 30;

export type WriterQualityStatus = 'PASS' | 'PARTIAL' | 'MISS' | 'NA';
export type WriterQualityCheckpointKind =
  | 'EDITORIAL_DECISION'
  | 'VIDEO_EFFECT'
  | 'PROFILE_GUIDELINE';

export interface WriterQualityCheckpointDefinition {
  refId: string;
  kind: WriterQualityCheckpointKind;
  label: string;
  instruction: string;
  weight: number;
  optional: boolean;
}

export interface WriterQualityAntiPatternDefinition {
  refId: string;
  pattern: string;
  /** A violated factual-integrity boundary cannot be offset by style points. */
  blocking: boolean;
}

export interface WriterQualityCheckpointResult {
  refId: string;
  status: WriterQualityStatus;
  note: string;
  evidenceQuote?: string;
}

export interface WriterQualityAntiPatternResult {
  refId: string;
  violated: boolean;
  note: string;
  evidenceQuote?: string;
}

export interface WriterQualityReviewArtifact {
  checkpoints: WriterQualityCheckpointResult[];
  antiPatterns: WriterQualityAntiPatternResult[];
  summary?: string;
}

export interface WriterQualityReview extends WriterQualityReviewArtifact {
  round: number;
  score: number;
  threshold: number;
  passed: boolean;
  hardGateViolations: string[];
}

export interface WriterDecisionForQuality {
  id: string;
  decisionType: string;
  situation: string;
  rhetoricalNeed?: string;
}

/**
 * The drafting agent receives only the small creative brief: promise, negative
 * guardrails and CORE guidance. OPTIONAL guidance is deliberately withheld from
 * drafting and used later as a soft diagnostic rubric. This prevents a long Profile
 * from turning into a prose assembly checklist.
 */
export function toWriterDraftProfileView(profile: WriterProfileView): WriterProfileView {
  return {
    ...profile,
    guidelines: profile.guidelines.filter((guideline) => guideline.priority === 'CORE'),
    antiPatterns: [...profile.antiPatterns],
  };
}

/** Build the complete post-draft rubric from the pinned Profile and this run's plan. */
export function buildWriterQualityRubric(
  profile: WriterProfileView,
  decisions: WriterDecisionForQuality[],
  videoPlan?: WriterVideoPlan | null,
): {
  checkpoints: WriterQualityCheckpointDefinition[];
  antiPatterns: WriterQualityAntiPatternDefinition[];
} {
  return {
    checkpoints: [
      ...decisions.map((decision) => ({
        refId: `decision:${decision.id}`,
        kind: 'EDITORIAL_DECISION' as const,
        label: decision.decisionType,
        instruction: decision.rhetoricalNeed || decision.situation,
        weight: 2,
        optional: false,
      })),
      ...(videoPlan ? buildVideoEffectCheckpoints(videoPlan) : []),
      ...profile.guidelines.map((guideline) => ({
        refId: `guideline:${guideline.id}`,
        kind: 'PROFILE_GUIDELINE' as const,
        label: guideline.priority,
        instruction: [
          guideline.instruction,
          guideline.when ? `Khi áp dụng: ${guideline.when}` : '',
          guideline.avoidWhen ? `Không áp dụng khi: ${guideline.avoidWhen}` : '',
        ].filter(Boolean).join('\n'),
        weight: guideline.priority === 'CORE' ? 1.5 : 1,
        optional: guideline.priority === 'OPTIONAL',
      })),
    ],
    antiPatterns: buildAntiPatternDefinitions(profile.antiPatterns),
  };
}

function buildVideoEffectCheckpoints(
  videoPlan: WriterVideoPlan,
): WriterQualityCheckpointDefinition[] {
  return [
    {
      refId: 'video:memorable-core',
      kind: 'VIDEO_EFFECT',
      label: 'Ý chính dễ nhớ',
      instruction: [
        'Sau khi xem, người nghe có thể kể lại ý chính bằng một câu rõ ràng không?',
        `Ý chính đã chọn: ${videoPlan.coreInsight}`,
        `Điểm neo trí nhớ (${videoPlan.memoryAnchor.kind}): ${videoPlan.memoryAnchor.value}`,
        'Chấm hiệu quả thực tế; không bắt draft phải lặp nguyên văn plan hoặc sáng tạo thêm thuật ngữ.',
      ].join('\n'),
      weight: 1.5,
      optional: false,
    },
    {
      refId: 'video:information-progression',
      kind: 'VIDEO_EFFECT',
      label: 'Thông tin tiến triển',
      instruction: [
        'Mỗi phần có thêm diễn biến, bằng chứng hoặc phát hiện mới không?',
        'Đánh dấu yếu nếu nhiều đoạn chỉ chứng minh lại cùng một ý, hoặc có thể bỏ/đổi chỗ mà hành trình gần như không đổi.',
        `Các phát hiện plan dự kiến: ${videoPlan.progression.map((beat) => beat.newInformation).join(' → ')}`,
      ].join('\n'),
      weight: 1.5,
      optional: false,
    },
    {
      refId: 'video:ending-payoff',
      kind: 'VIDEO_EFFECT',
      label: 'Kết bài trả lời lời hứa',
      instruction: [
        'Đoạn kết có hoàn tất lời hứa đầu video và để lại một việc cụ thể người nghe có thể tự làm không?',
        `Cách trả lời phần mở đã chọn: ${videoPlan.endingPayoff.resolvesOpening}`,
        `Điều người nghe có thể làm: ${videoPlan.endingPayoff.audienceCanDo}`,
        'Một phép tự kiểm tra hoặc câu hỏi cụ thể vẫn hợp lệ; không đòi lời khuyên đầu tư hay checklist dài.',
      ].join('\n'),
      weight: 1.5,
      optional: false,
    },
  ];
}

const SOURCE_GROUNDING_HARD_GATE =
  'Không bịa số liệu, case study hoặc dữ kiện không có trong Source Pack.';

function normalizedPattern(pattern: string): string {
  return pattern
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** Existing Profiles used several wordings for the same factual-integrity boundary. */
function isSourceGroundingHardGate(pattern: string): boolean {
  const normalized = normalizedPattern(pattern);
  return normalized.includes('fake specificity')
    || (
      normalized.includes('bia')
      && (
        normalized.includes('so lieu')
        || normalized.includes('case study')
        || normalized.includes('du kien')
        || normalized.includes('source pack')
      )
    );
}

function buildAntiPatternDefinitions(patterns: string[]): WriterQualityAntiPatternDefinition[] {
  const definitions = patterns.map((pattern, index) => ({
    refId: `anti:${index + 1}`,
    pattern,
    blocking: isSourceGroundingHardGate(pattern),
  }));
  if (!definitions.some((definition) => definition.blocking)) {
    definitions.push({
      refId: 'hard:source-grounding',
      pattern: SOURCE_GROUNDING_HARD_GATE,
      blocking: true,
    });
  }
  return definitions;
}

function isExactQuote(script: string, quote: unknown): quote is string {
  return typeof quote === 'string' && quote.trim().length > 0 && script.includes(quote);
}

function scoreValue(status: WriterQualityStatus): number {
  if (status === 'PASS') return 1;
  if (status === 'PARTIAL') return 0.5;
  return 0;
}

/**
 * Validate the review shape and compute the score in code. The reviewer never gets
 * to choose its own percentage. NA checkpoints are removed from the denominator;
 * no single missed positive guideline can fail a piece by itself.
 */
export function validateAndScoreWriterQualityReview(
  parsed: unknown,
  opts: {
    round: number;
    script: string;
    checkpoints: WriterQualityCheckpointDefinition[];
    antiPatterns: WriterQualityAntiPatternDefinition[];
    threshold?: number;
  },
):
  | { ok: true; review: WriterQualityReview }
  | { ok: false; errorCode: string; reason: string } {
  const artifact = parsed as Partial<WriterQualityReviewArtifact> | null;
  if (!artifact || typeof artifact !== 'object') {
    return { ok: false, errorCode: 'AGENT_SCHEMA', reason: 'writer quality review is not an object' };
  }
  if (!Array.isArray(artifact.checkpoints) || !Array.isArray(artifact.antiPatterns)) {
    return {
      ok: false,
      errorCode: 'AGENT_SCHEMA',
      reason: 'quality review needs checkpoints[] and antiPatterns[]',
    };
  }

  const expectedCheckpoints = new Map(opts.checkpoints.map((definition) => [definition.refId, definition]));
  const seenCheckpoints = new Set<string>();
  let earned = 0;
  let available = 0;
  const checkpoints: WriterQualityCheckpointResult[] = [];

  for (const raw of artifact.checkpoints) {
    const item = raw as Partial<WriterQualityCheckpointResult>;
    const refId = typeof item.refId === 'string' ? item.refId : '';
    const definition = expectedCheckpoints.get(refId);
    if (!definition || seenCheckpoints.has(refId)) {
      return { ok: false, errorCode: 'AGENT_SCHEMA', reason: `unknown or duplicate checkpoint: ${refId || '(empty)'}` };
    }
    seenCheckpoints.add(refId);
    const status = item.status;
    if (status !== 'PASS' && status !== 'PARTIAL' && status !== 'MISS' && status !== 'NA') {
      return { ok: false, errorCode: 'AGENT_SCHEMA', reason: `invalid checkpoint status for ${refId}` };
    }
    if (status === 'NA' && !definition.optional) {
      return { ok: false, errorCode: 'AGENT_SCHEMA', reason: `${refId} is not optional and cannot be NA` };
    }
    const note = typeof item.note === 'string' ? item.note.trim() : '';
    if (!note) {
      return { ok: false, errorCode: 'AGENT_SCHEMA', reason: `checkpoint ${refId} needs a note` };
    }
    if ((status === 'PASS' || status === 'PARTIAL') && !isExactQuote(opts.script, item.evidenceQuote)) {
      return {
        ok: false,
        errorCode: 'AGENT_UNGROUNDED',
        reason: `checkpoint ${refId} needs an exact evidenceQuote from draft.script`,
      };
    }
    if (status !== 'NA') {
      available += definition.weight;
      earned += definition.weight * scoreValue(status);
    }
    checkpoints.push({
      refId,
      status,
      note,
      ...(isExactQuote(opts.script, item.evidenceQuote) ? { evidenceQuote: item.evidenceQuote } : {}),
    });
  }
  if (seenCheckpoints.size !== expectedCheckpoints.size) {
    const missing = [...expectedCheckpoints.keys()].filter((refId) => !seenCheckpoints.has(refId));
    return { ok: false, errorCode: 'AGENT_SCHEMA', reason: `quality review missing checkpoints: ${missing.join(', ')}` };
  }

  const expectedAntiPatterns = new Map(opts.antiPatterns.map((definition) => [definition.refId, definition]));
  const seenAntiPatterns = new Set<string>();
  const antiPatterns: WriterQualityAntiPatternResult[] = [];
  let violationCount = 0;
  const hardGateViolations: string[] = [];

  for (const raw of artifact.antiPatterns) {
    const item = raw as Partial<WriterQualityAntiPatternResult>;
    const refId = typeof item.refId === 'string' ? item.refId : '';
    if (!expectedAntiPatterns.has(refId) || seenAntiPatterns.has(refId)) {
      return { ok: false, errorCode: 'AGENT_SCHEMA', reason: `unknown or duplicate anti-pattern: ${refId || '(empty)'}` };
    }
    seenAntiPatterns.add(refId);
    if (typeof item.violated !== 'boolean') {
      return { ok: false, errorCode: 'AGENT_SCHEMA', reason: `anti-pattern ${refId} needs violated:boolean` };
    }
    const note = typeof item.note === 'string' ? item.note.trim() : '';
    if (!note) {
      return { ok: false, errorCode: 'AGENT_SCHEMA', reason: `anti-pattern ${refId} needs a note` };
    }
    if (item.violated && !isExactQuote(opts.script, item.evidenceQuote)) {
      return {
        ok: false,
        errorCode: 'AGENT_UNGROUNDED',
        reason: `violated anti-pattern ${refId} needs an exact evidenceQuote from draft.script`,
      };
    }
    if (item.violated) {
      violationCount += 1;
      const expected = expectedAntiPatterns.get(refId)!;
      // Legacy on-disk runs predate `blocking`; recognize their factual pattern too.
      if (expected.blocking || isSourceGroundingHardGate(expected.pattern)) {
        hardGateViolations.push(refId);
      }
    }
    antiPatterns.push({
      refId,
      violated: item.violated,
      note,
      ...(isExactQuote(opts.script, item.evidenceQuote) ? { evidenceQuote: item.evidenceQuote } : {}),
    });
  }
  if (seenAntiPatterns.size !== expectedAntiPatterns.size) {
    const missing = [...expectedAntiPatterns.keys()].filter((refId) => !seenAntiPatterns.has(refId));
    return { ok: false, errorCode: 'AGENT_SCHEMA', reason: `quality review missing anti-patterns: ${missing.join(', ')}` };
  }

  const positiveScore = available > 0 ? (earned / available) * 100 : 100;
  const penalty = Math.min(
    WRITER_ANTI_PATTERN_PENALTY_CAP,
    violationCount * WRITER_ANTI_PATTERN_PENALTY,
  );
  const score = Math.max(0, Math.round(positiveScore - penalty));
  const threshold = opts.threshold ?? WRITER_QUALITY_THRESHOLD;
  return {
    ok: true,
    review: {
      round: opts.round,
      checkpoints,
      antiPatterns,
      summary: typeof artifact.summary === 'string' ? artifact.summary.trim() : undefined,
      score,
      threshold,
      passed: score >= threshold && hardGateViolations.length === 0,
      hardGateViolations,
    },
  };
}
