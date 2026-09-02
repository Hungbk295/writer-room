/**
 * Writer v2 STUDY / story-planning contract.
 *
 * DIVERGE is deliberately source-blind. CONFRONT receives only already
 * validated hypotheses and a validated ResearchMap. This module is pure and
 * owns no run lifecycle, filesystem path, prompt dispatch, or checkpoint state.
 */
import {
  COMPETITOR_HOOK_TYPES,
  HOOK_TYPE_LABELS,
  type CompetitorHookType,
  type SelectedHook,
} from './hook-doi-thu.ts';
import {
  deriveAuthorizedClaimPermissions,
  deriveFactsLedger,
  hasDisputedCaveatLanguage,
  type AuthorizedClaimPermission,
  type ResearchClaim,
  type ResearchEvidence,
  type ResearchMap,
} from './research-map.ts';
import {
  validateWriterVideoPlan,
  type WriterVideoPlanBeat,
  type WriterVideoPlan,
} from './video-plan.ts';

export const DIVERGE_SCHEMA_VERSION = 'writer-study-diverge-v1' as const;
export const CONFRONT_SCHEMA_VERSION = 'writer-study-confront-v1' as const;
export const MAX_DIVERGE_BYTES = 16 * 1024;
export const MAX_CONFRONT_BYTES = 32 * 1024;

export const STORY_PROVOCATIONS = [
  'CONTRADICTION',
  'ZOOM_IN',
  'EXTREME_TEST',
  'INVERSION',
] as const;

export type Provocation = (typeof STORY_PROVOCATIONS)[number];

export const HYPOTHESIS_VERDICTS = ['KEEP', 'REBUILD', 'REJECT'] as const;
export type HypothesisVerdict = (typeof HYPOTHESIS_VERDICTS)[number];

export const HOOK_STATUSES = ['KEEP', 'REWRITE', 'REJECT'] as const;
export type HookStatus = (typeof HOOK_STATUSES)[number];

export interface StoryHypothesis {
  id: string;
  provocation: Provocation;
  thesisHypothesis: string;
  beliefBefore: string;
  beliefAfter: string;
  centralTension: string;
  hookDebt: string;
  beatQuestions: string[];
  evidenceNeeds: string[];
  falsifiers: string[];
  proposedPayoff: string;
}

export interface DivergeArtifact {
  schemaVersion: typeof DIVERGE_SCHEMA_VERSION;
  hypotheses: [StoryHypothesis, StoryHypothesis, StoryHypothesis];
}

export const HYPOTHESIS_DELTA_FIELDS = [
  'thesisHypothesis',
  'beliefBefore',
  'beliefAfter',
  'centralTension',
  'hookDebt',
  'beatQuestions',
  'evidenceNeeds',
  'falsifiers',
  'proposedPayoff',
] as const;

export type HypothesisDeltaField = (typeof HYPOTHESIS_DELTA_FIELDS)[number];

export interface ConfrontDelta {
  field: HypothesisDeltaField;
  before: string;
  after: string;
  reason: string;
  claimIds: string[];
}

export interface HypothesisAssessment {
  hypothesisId: string;
  verdict: HypothesisVerdict;
  supportClaimIds: string[];
  counterClaimIds: string[];
  falsifierHits: string[];
  unsupportedEvidenceNeeds: string[];
  deltas: ConfrontDelta[];
  rebuiltHypothesis?: StoryHypothesis;
}

export interface HookVerdict {
  status: HookStatus;
  rationale: string;
  claimIds: string[];
  replacementHook?: SelectedHook;
}

export interface BeatEvidence {
  beatIndex: number;
  claimIds: string[];
  evidenceIds: string[];
}

export const STORY_BEAT_KINDS = ['FACTUAL', 'NARRATIVE', 'PERSONA'] as const;
export type StoryBeatKind = (typeof STORY_BEAT_KINDS)[number];

export interface StoryVideoPlanBeat extends WriterVideoPlanBeat {
  kind: StoryBeatKind;
  personaEntryId?: string;
}

export interface StoryVideoPlan extends Omit<WriterVideoPlan, 'progression'> {
  progression: StoryVideoPlanBeat[];
}

export interface ConfrontArtifact {
  schemaVersion: typeof CONFRONT_SCHEMA_VERSION;
  assessments: [HypothesisAssessment, HypothesisAssessment, HypothesisAssessment];
  selectedHypothesisId?: string;
  hookVerdict: HookVerdict;
  finalPlan?: StoryVideoPlan;
  beatEvidence?: BeatEvidence[];
}

export type StoryPlanningErrorCode =
  | 'STORY_SCHEMA'
  | 'STORY_ARTIFACT_OVERSIZE'
  | 'STORY_SOURCE_LEAK'
  | 'STORY_FORBIDDEN_TOPOLOGY'
  | 'STORY_DISTINCTNESS'
  | 'STORY_REFERENCE'
  | 'STORY_VERDICT'
  | 'STORY_HOOK'
  | 'STORY_PLAN'
  | 'STORY_EVIDENCE'
  | 'STORY_PERSONA'
  | 'STORY_DISPUTED_UNQUALIFIED';

export interface StoryPlanningValidationError {
  ok: false;
  errorCode: StoryPlanningErrorCode;
  reason: string;
  path?: string;
}

export type DivergeValidationResult =
  | { ok: true; artifact: DivergeArtifact }
  | StoryPlanningValidationError;

export type ConfrontValidationResult =
  | { ok: true; artifact: ConfrontArtifact; authorizedClaims: AuthorizedClaimPermission[] }
  | StoryPlanningValidationError;

export interface DivergeValidationContext {
  /** Pinned identifiers which a source-blind call must never echo. */
  sourceVideoIds?: readonly string[];
  /** Host/channel names from the Topic Pack envelope. */
  sourceHostNames?: readonly string[];
  /** High-signal raw-pack fragments; short/generic fragments are ignored. */
  forbiddenSourceFragments?: readonly string[];
  /** Numbers already visible in the human-selected hook are not fabricated here. */
  allowedHookText?: string;
  maxBytes?: number;
}

export interface ConfrontValidationContext {
  divergeArtifact: DivergeArtifact;
  researchMap: ResearchMap;
  selectedHook: SelectedHook;
  /** Coordinator-derived APPROVED Persona experience IDs; no Persona prose. */
  approvedPersonaExperienceIds?: readonly string[];
  maxBytes?: number;
}

const TOP_DIVERGE_KEYS = new Set(['schemaVersion', 'hypotheses']);
const HYPOTHESIS_KEYS = new Set([
  'id',
  'provocation',
  'thesisHypothesis',
  'beliefBefore',
  'beliefAfter',
  'centralTension',
  'hookDebt',
  'beatQuestions',
  'evidenceNeeds',
  'falsifiers',
  'proposedPayoff',
]);
const TOP_CONFRONT_KEYS = new Set([
  'schemaVersion',
  'assessments',
  'selectedHypothesisId',
  'hookVerdict',
  'finalPlan',
  'beatEvidence',
]);
const ASSESSMENT_KEYS = new Set([
  'hypothesisId',
  'verdict',
  'supportClaimIds',
  'counterClaimIds',
  'falsifierHits',
  'unsupportedEvidenceNeeds',
  'deltas',
  'rebuiltHypothesis',
]);
const DELTA_KEYS = new Set(['field', 'before', 'after', 'reason', 'claimIds']);
const HOOK_VERDICT_KEYS = new Set(['status', 'rationale', 'claimIds', 'replacementHook']);
const SELECTED_HOOK_KEYS = new Set(['id', 'type', 'typeLabel', 'text']);
const BEAT_EVIDENCE_KEYS = new Set(['beatIndex', 'claimIds', 'evidenceIds']);
const PLAN_KEYS = new Set(['coreInsight', 'memoryAnchor', 'progression', 'endingPayoff', 'cutList']);
const MEMORY_ANCHOR_KEYS = new Set(['kind', 'value']);
const PLAN_BEAT_KEYS = new Set([
  'kind',
  'beat',
  'newInformation',
  'characterOrArgumentChange',
  'visualAnchor',
  'personaEntryId',
]);
const ENDING_PAYOFF_KEYS = new Set(['resolvesOpening', 'audienceCanDo']);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

const SOURCE_MARKER_RE = /\b(?:video\s*id|facts\s*ledger|research\s*map|source\s*pack|topic\s*pack|transcript\s*quote)\b/iu;
const OUTLINE_LABEL_RE = /(?:mở\s*bài|thân\s*bài|kết\s*bài|\bintro(?:duction)?\b|\boutro\b|\bsection\s*\d+\b|\bbeat\s*\d+\b|phần\s*(?:thứ\s*)?\d+)/iu;
const NUMERIC_FACT_RE = /(?:[$€£]\s*\d+(?:[.,]\d+)?|\b\d+(?:[.,]\d+)?\s*(?:%|phần\s*trăm|triệu|tỷ|nghìn|ngàn|đồng|usd|vnd|năm|tháng|tuần|ngày|giờ|tuổi|lần|người))(?=$|[^\p{L}\p{N}_])/giu;
const EVIDENCE_INQUIRY_RE = /^(?:cần|kiểm\s*tra|xác\s*định|tìm|đối\s*chiếu|liệu|bằng\s*chứng|nguồn\s*nào|điều\s*gì|dữ\s*liệu)/iu;
const FALSIFIER_RE = /(?:^|\b)(?:nếu|khi|trừ\s*khi|sẽ\s*bác\s*bỏ|không\s*đúng\s*nếu|thất\s*bại\s*nếu|unless|if|when)(?:\b|$)/iu;
const DISTINCT_FIELDS = [
  'thesisHypothesis',
  'beliefBefore',
  'beliefAfter',
  'centralTension',
] as const;

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it',
  'of', 'on', 'or', 'that', 'the', 'this', 'to', 'with',
  'ai', 'ban', 'bi', 'cai', 'cac', 'cho', 'co', 'cua', 'da', 'dang', 'de', 'do',
  'duoc', 'gi', 'hay', 'hon', 'khi', 'khong', 'la', 'lam', 'mot', 'nhung', 'nguoi',
  'o', 'qua', 'rang', 'se', 'thi', 'the', 'trong', 'tu', 'va', 'voi',
  'contradiction', 'zoom', 'extreme', 'test', 'inversion',
]);

function fail(
  errorCode: StoryPlanningErrorCode,
  reason: string,
  path?: string,
): StoryPlanningValidationError {
  return { ok: false, errorCode, reason, ...(path ? { path } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unknownKey(value: Record<string, unknown>, allowed: ReadonlySet<string>): string | null {
  return Object.keys(value).find((key) => !allowed.has(key)) ?? null;
}

function serializedBytes(value: unknown): number | null {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return null;
  }
}

function requiredString(
  value: unknown,
  path: string,
  maxLength = 4_000,
): string | StoryPlanningValidationError {
  if (typeof value !== 'string' || !value.trim()) {
    return fail('STORY_SCHEMA', `${path} must be a non-empty string`, path);
  }
  const text = value.normalize('NFC').trim();
  if (text.length > maxLength) {
    return fail('STORY_SCHEMA', `${path} exceeds ${maxLength} characters`, path);
  }
  return text;
}

function idString(value: unknown, path: string): string | StoryPlanningValidationError {
  const text = requiredString(value, path, 80);
  if (typeof text !== 'string') return text;
  if (!ID_RE.test(text)) {
    return fail('STORY_SCHEMA', `${path} must match ${ID_RE.source}`, path);
  }
  return text;
}

function stringArray(
  value: unknown,
  path: string,
  options: { min?: number; max?: number; ids?: boolean } = {},
): string[] | StoryPlanningValidationError {
  const min = options.min ?? 0;
  const max = options.max ?? 32;
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    return fail('STORY_SCHEMA', `${path} must contain ${min}-${max} strings`, path);
  }
  const result: string[] = [];
  for (const [index, item] of value.entries()) {
    const parsed = options.ids
      ? idString(item, `${path}[${index}]`)
      : requiredString(item, `${path}[${index}]`);
    if (typeof parsed !== 'string') return parsed;
    result.push(parsed);
  }
  if (new Set(result).size !== result.length) {
    return fail('STORY_SCHEMA', `${path} must not contain duplicates`, path);
  }
  return result;
}

function normalizeMeaning(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function meaningTokens(text: string): Set<string> {
  return new Set(
    normalizeMeaning(text)
      .split(/\s+/u)
      .filter((token) => token.length > 1 && !STOP_WORDS.has(token)),
  );
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function overlapCoefficient(left: Set<string>, right: Set<string>): number {
  const denominator = Math.min(left.size, right.size);
  if (denominator === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / denominator;
}

function parseHypothesis(raw: unknown, path: string): StoryHypothesis | StoryPlanningValidationError {
  if (!isRecord(raw)) return fail('STORY_SCHEMA', `${path} must be an object`, path);
  const extra = unknownKey(raw, HYPOTHESIS_KEYS);
  if (extra) return fail('STORY_SCHEMA', `unknown hypothesis key "${extra}"`, `${path}.${extra}`);

  const id = idString(raw['id'], `${path}.id`);
  if (typeof id !== 'string') return id;
  const provocation = raw['provocation'];
  if (!STORY_PROVOCATIONS.includes(provocation as Provocation)) {
    return fail(
      'STORY_SCHEMA',
      `${path}.provocation must be one of ${STORY_PROVOCATIONS.join(', ')}`,
      `${path}.provocation`,
    );
  }

  const scalarFields = [
    'thesisHypothesis',
    'beliefBefore',
    'beliefAfter',
    'centralTension',
    'hookDebt',
    'proposedPayoff',
  ] as const;
  const scalars = {} as Record<(typeof scalarFields)[number], string>;
  for (const field of scalarFields) {
    const parsed = requiredString(raw[field], `${path}.${field}`);
    if (typeof parsed !== 'string') return parsed;
    scalars[field] = parsed;
  }

  const beatQuestions = stringArray(raw['beatQuestions'], `${path}.beatQuestions`, { min: 2, max: 8 });
  if (!Array.isArray(beatQuestions)) return beatQuestions;
  for (const [index, question] of beatQuestions.entries()) {
    if (!question.endsWith('?')) {
      return fail(
        'STORY_SCHEMA',
        `${path}.beatQuestions[${index}] must be a question ending in ?`,
        `${path}.beatQuestions[${index}]`,
      );
    }
  }

  const evidenceNeeds = stringArray(raw['evidenceNeeds'], `${path}.evidenceNeeds`, { min: 1, max: 8 });
  if (!Array.isArray(evidenceNeeds)) return evidenceNeeds;
  for (const [index, need] of evidenceNeeds.entries()) {
    if (!need.endsWith('?') && !EVIDENCE_INQUIRY_RE.test(need)) {
      return fail(
        'STORY_SCHEMA',
        `${path}.evidenceNeeds[${index}] must ask for evidence, not assert a source fact`,
        `${path}.evidenceNeeds[${index}]`,
      );
    }
  }

  const falsifiers = stringArray(raw['falsifiers'], `${path}.falsifiers`, { min: 1, max: 8 });
  if (!Array.isArray(falsifiers)) return falsifiers;
  for (const [index, condition] of falsifiers.entries()) {
    if (!FALSIFIER_RE.test(condition)) {
      return fail(
        'STORY_SCHEMA',
        `${path}.falsifiers[${index}] must state a falsifying condition`,
        `${path}.falsifiers[${index}]`,
      );
    }
  }

  if (normalizeMeaning(scalars.beliefBefore) === normalizeMeaning(scalars.beliefAfter)) {
    return fail(
      'STORY_DISTINCTNESS',
      `${path} must change the viewer belief; beliefBefore equals beliefAfter after normalization`,
      path,
    );
  }

  return {
    id,
    provocation: provocation as Provocation,
    ...scalars,
    beatQuestions,
    evidenceNeeds,
    falsifiers,
  };
}

function allHypothesisText(hypothesis: StoryHypothesis): string[] {
  return [
    hypothesis.thesisHypothesis,
    hypothesis.beliefBefore,
    hypothesis.beliefAfter,
    hypothesis.centralTension,
    hypothesis.hookDebt,
    ...hypothesis.beatQuestions,
    ...hypothesis.evidenceNeeds,
    ...hypothesis.falsifiers,
    hypothesis.proposedPayoff,
  ];
}

function validateSourceBlindness(
  hypotheses: readonly StoryHypothesis[],
  context: DivergeValidationContext,
): StoryPlanningValidationError | null {
  const joined = hypotheses.flatMap(allHypothesisText).join('\n').normalize('NFC');
  if (SOURCE_MARKER_RE.test(joined)) {
    return fail(
      'STORY_SOURCE_LEAK',
      'DIVERGE output contains source-pack or ledger vocabulary unavailable to a source-blind call',
    );
  }

  if (
    OUTLINE_LABEL_RE.test(joined)
    || (
      /đầu\s*tiên/iu.test(joined)
      && /(?:sau\s*đó|tiếp\s*theo)/iu.test(joined)
      && /cuối\s*cùng/iu.test(joined)
    )
  ) {
    return fail(
      'STORY_FORBIDDEN_TOPOLOGY',
      'DIVERGE output contains ordered outline/section language; candidates must remain belief hypotheses',
    );
  }

  const forbiddenVideoIds = (context.sourceVideoIds ?? [])
    .map((item) => item.normalize('NFC').trim())
    .filter(Boolean);
  for (const token of forbiddenVideoIds) {
    if (joined.toLocaleLowerCase('vi').includes(token.toLocaleLowerCase('vi'))) {
      return fail('STORY_SOURCE_LEAK', `DIVERGE output leaked pinned source video ID "${token}"`);
    }
  }
  const forbiddenHosts = (context.sourceHostNames ?? [])
    .map((item) => item.normalize('NFC').trim())
    .filter((item) => item.length >= 4);
  for (const host of forbiddenHosts) {
    if (joined.toLocaleLowerCase('vi').includes(host.toLocaleLowerCase('vi'))) {
      return fail('STORY_SOURCE_LEAK', `DIVERGE output leaked pinned source host "${host}"`);
    }
  }

  const normalizedLeakText = joined.toLocaleLowerCase('vi').replace(/\s+/gu, ' ');
  for (const fragment of context.forbiddenSourceFragments ?? []) {
    const normalized = fragment.normalize('NFC').trim().toLocaleLowerCase('vi').replace(/\s+/gu, ' ');
    if (normalized.length >= 24 && normalizedLeakText.includes(normalized)) {
      return fail('STORY_SOURCE_LEAK', 'DIVERGE output copied a pinned raw-pack fragment');
    }
  }

  const allowedHookText = (context.allowedHookText ?? '').normalize('NFC').toLocaleLowerCase('vi');
  for (const hypothesis of hypotheses) {
    for (const text of allHypothesisText(hypothesis)) {
      for (const match of text.matchAll(NUMERIC_FACT_RE)) {
        const numericClaim = match[0].normalize('NFC').toLocaleLowerCase('vi');
        if (!allowedHookText.includes(numericClaim)) {
          return fail(
            'STORY_SOURCE_LEAK',
            `DIVERGE output asserts ungrounded statistic "${match[0]}"`,
          );
        }
      }
    }
  }
  return null;
}

function hypothesisDeltaValue(
  hypothesis: StoryHypothesis,
  field: HypothesisDeltaField,
): string {
  const value = hypothesis[field];
  return Array.isArray(value) ? JSON.stringify(value) : value;
}

function validateDistinctHypotheses(
  hypotheses: readonly StoryHypothesis[],
): StoryPlanningValidationError | null {
  for (let leftIndex = 0; leftIndex < hypotheses.length; leftIndex += 1) {
    const left = hypotheses[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < hypotheses.length; rightIndex += 1) {
      const right = hypotheses[rightIndex]!;
      const duplicateFields = DISTINCT_FIELDS.filter(
        (field) => normalizeMeaning(left[field]) === normalizeMeaning(right[field]),
      );
      if (duplicateFields.length > 0) {
        return fail(
          'STORY_DISTINCTNESS',
          `hypotheses "${left.id}" and "${right.id}" duplicate normalized field(s): ${duplicateFields.join(', ')}`,
          '$.hypotheses',
        );
      }
      for (const field of DISTINCT_FIELDS) {
        const similarity = jaccard(meaningTokens(left[field]), meaningTokens(right[field]));
        if (similarity >= 0.82) {
          return fail(
            'STORY_DISTINCTNESS',
            `hypotheses "${left.id}" and "${right.id}" have a near-duplicate ${field} (token similarity ${similarity.toFixed(2)})`,
            '$.hypotheses',
          );
        }
      }
      const leftJourney = DISTINCT_FIELDS.map((field) => left[field]).join(' ');
      const rightJourney = DISTINCT_FIELDS.map((field) => right[field]).join(' ');
      const similarity = jaccard(meaningTokens(leftJourney), meaningTokens(rightJourney));
      if (similarity >= 0.72) {
        return fail(
          'STORY_DISTINCTNESS',
          `hypotheses "${left.id}" and "${right.id}" are wording variants (token similarity ${similarity.toFixed(2)})`,
          '$.hypotheses',
        );
      }
    }
  }
  return null;
}

export function validateDivergeArtifact(
  value: unknown,
  context: DivergeValidationContext = {},
): DivergeValidationResult {
  const bytes = serializedBytes(value);
  if (bytes === null) return fail('STORY_SCHEMA', 'DIVERGE artifact must be JSON-serializable');
  const maxBytes = context.maxBytes ?? MAX_DIVERGE_BYTES;
  if (bytes > maxBytes) {
    return fail(
      'STORY_ARTIFACT_OVERSIZE',
      `DIVERGE artifact is ${bytes} bytes; maximum is ${maxBytes}`,
    );
  }
  if (!isRecord(value)) return fail('STORY_SCHEMA', 'DIVERGE artifact must be an object');
  const extra = unknownKey(value, TOP_DIVERGE_KEYS);
  if (extra) return fail('STORY_SCHEMA', `unknown DIVERGE key "${extra}"`, `$.${extra}`);
  if (value['schemaVersion'] !== DIVERGE_SCHEMA_VERSION) {
    return fail(
      'STORY_SCHEMA',
      `schemaVersion must be "${DIVERGE_SCHEMA_VERSION}"`,
      '$.schemaVersion',
    );
  }
  if (!Array.isArray(value['hypotheses']) || value['hypotheses'].length !== 3) {
    return fail('STORY_SCHEMA', '$.hypotheses must contain exactly three candidates', '$.hypotheses');
  }

  const parsed: StoryHypothesis[] = [];
  for (const [index, raw] of value['hypotheses'].entries()) {
    const hypothesis = parseHypothesis(raw, `$.hypotheses[${index}]`);
    if ('ok' in hypothesis) return hypothesis;
    parsed.push(hypothesis);
  }
  if (new Set(parsed.map((item) => item.id)).size !== 3) {
    return fail('STORY_SCHEMA', 'DIVERGE hypothesis IDs must be unique', '$.hypotheses');
  }
  if (new Set(parsed.map((item) => item.provocation)).size !== 3) {
    return fail(
      'STORY_DISTINCTNESS',
      'DIVERGE must use three distinct provocations (at least three of the four registry values)',
      '$.hypotheses',
    );
  }
  const distinctnessError = validateDistinctHypotheses(parsed);
  if (distinctnessError) return distinctnessError;
  const blindnessError = validateSourceBlindness(parsed, context);
  if (blindnessError) return blindnessError;

  return {
    ok: true,
    artifact: {
      schemaVersion: DIVERGE_SCHEMA_VERSION,
      hypotheses: [parsed[0]!, parsed[1]!, parsed[2]!],
    },
  };
}

function parseSelectedHook(raw: unknown, path: string): SelectedHook | StoryPlanningValidationError {
  if (!isRecord(raw)) return fail('STORY_HOOK', `${path} must be an object`, path);
  const extra = unknownKey(raw, SELECTED_HOOK_KEYS);
  if (extra) return fail('STORY_HOOK', `unknown hook key "${extra}"`, `${path}.${extra}`);
  const id = idString(raw['id'], `${path}.id`);
  if (typeof id !== 'string') return id;
  const type = raw['type'];
  if (!COMPETITOR_HOOK_TYPES.includes(type as CompetitorHookType)) {
    return fail(
      'STORY_HOOK',
      `${path}.type must be one of ${COMPETITOR_HOOK_TYPES.join(', ')}`,
      `${path}.type`,
    );
  }
  const typeLabel = requiredString(raw['typeLabel'], `${path}.typeLabel`, 200);
  if (typeof typeLabel !== 'string') return typeLabel;
  if (typeLabel !== HOOK_TYPE_LABELS[type as CompetitorHookType]) {
    return fail('STORY_HOOK', `${path}.typeLabel does not match the hook registry`, `${path}.typeLabel`);
  }
  const text = requiredString(raw['text'], `${path}.text`);
  if (typeof text !== 'string') return text;
  return { id, type: type as CompetitorHookType, typeLabel, text };
}

function validateStrictPlanShape(raw: unknown, path: string): StoryPlanningValidationError | null {
  if (!isRecord(raw)) return fail('STORY_PLAN', `${path} must be an object`, path);
  const extra = unknownKey(raw, PLAN_KEYS);
  if (extra) return fail('STORY_PLAN', `unknown finalPlan key "${extra}"`, `${path}.${extra}`);
  const memoryAnchor = raw['memoryAnchor'];
  if (!isRecord(memoryAnchor)) return fail('STORY_PLAN', `${path}.memoryAnchor must be an object`, `${path}.memoryAnchor`);
  const anchorExtra = unknownKey(memoryAnchor, MEMORY_ANCHOR_KEYS);
  if (anchorExtra) {
    return fail('STORY_PLAN', `unknown memoryAnchor key "${anchorExtra}"`, `${path}.memoryAnchor.${anchorExtra}`);
  }
  if (!Array.isArray(raw['progression'])) {
    return fail('STORY_PLAN', `${path}.progression must be an array`, `${path}.progression`);
  }
  for (const [index, beat] of raw['progression'].entries()) {
    if (!isRecord(beat)) return fail('STORY_PLAN', `${path}.progression[${index}] must be an object`);
    const beatExtra = unknownKey(beat, PLAN_BEAT_KEYS);
    if (beatExtra) {
      return fail(
        'STORY_PLAN',
        `unknown progression beat key "${beatExtra}"`,
        `${path}.progression[${index}].${beatExtra}`,
      );
    }
  }
  const ending = raw['endingPayoff'];
  if (!isRecord(ending)) return fail('STORY_PLAN', `${path}.endingPayoff must be an object`, `${path}.endingPayoff`);
  const endingExtra = unknownKey(ending, ENDING_PAYOFF_KEYS);
  if (endingExtra) {
    return fail('STORY_PLAN', `unknown endingPayoff key "${endingExtra}"`, `${path}.endingPayoff.${endingExtra}`);
  }
  return null;
}

function parseStoryVideoPlan(
  raw: unknown,
  basePlan: WriterVideoPlan,
  approvedPersonaExperienceIds: readonly string[],
): StoryVideoPlan | StoryPlanningValidationError {
  if (!isRecord(raw) || !Array.isArray(raw['progression'])) {
    return fail('STORY_PLAN', '$.finalPlan.progression must be an array', '$.finalPlan.progression');
  }
  const approvedPersonaIds = new Set(approvedPersonaExperienceIds);
  const progression: StoryVideoPlanBeat[] = [];
  for (const [index, rawBeat] of raw['progression'].entries()) {
    if (!isRecord(rawBeat)) {
      return fail('STORY_PLAN', `$.finalPlan.progression[${index}] must be an object`);
    }
    const kind = rawBeat['kind'];
    if (!STORY_BEAT_KINDS.includes(kind as StoryBeatKind)) {
      return fail(
        'STORY_PLAN',
        `$.finalPlan.progression[${index}].kind must be one of ${STORY_BEAT_KINDS.join(', ')}`,
        `$.finalPlan.progression[${index}].kind`,
      );
    }
    const personaEntryId = rawBeat['personaEntryId'];
    if (kind !== 'PERSONA' && personaEntryId !== undefined) {
      return fail(
        'STORY_PERSONA',
        `beat ${index} is ${String(kind)} and may not carry personaEntryId`,
        `$.finalPlan.progression[${index}].personaEntryId`,
      );
    }
    if (kind === 'PERSONA') {
      if (
        typeof personaEntryId !== 'string'
        || !ID_RE.test(personaEntryId.trim())
        || !approvedPersonaIds.has(personaEntryId.trim())
      ) {
        return fail(
          'STORY_PERSONA',
          `PERSONA beat ${index} needs a coordinator-approved Persona experience ID`,
          `$.finalPlan.progression[${index}].personaEntryId`,
        );
      }
    }
    const baseBeat = basePlan.progression[index]!;
    progression.push({
      ...baseBeat,
      kind: kind as StoryBeatKind,
      ...(kind === 'PERSONA' ? { personaEntryId: (personaEntryId as string).trim() } : {}),
    });
  }
  return { ...basePlan, progression };
}

function knownNonRejectedClaims(
  claimIds: readonly string[],
  claimById: ReadonlyMap<string, ResearchClaim>,
  path: string,
): StoryPlanningValidationError | null {
  for (const claimId of claimIds) {
    const claim = claimById.get(claimId);
    if (!claim) return fail('STORY_REFERENCE', `${path} references unknown claim "${claimId}"`, path);
    if (claim.status === 'REJECTED') {
      return fail('STORY_REFERENCE', `${path} references REJECTED claim "${claimId}"`, path);
    }
  }
  return null;
}

function parseDelta(
  raw: unknown,
  path: string,
  original: StoryHypothesis,
  claimById: ReadonlyMap<string, ResearchClaim>,
): ConfrontDelta | StoryPlanningValidationError {
  if (!isRecord(raw)) return fail('STORY_SCHEMA', `${path} must be an object`, path);
  const extra = unknownKey(raw, DELTA_KEYS);
  if (extra) return fail('STORY_SCHEMA', `unknown delta key "${extra}"`, `${path}.${extra}`);
  const field = raw['field'];
  if (!HYPOTHESIS_DELTA_FIELDS.includes(field as HypothesisDeltaField)) {
    return fail(
      'STORY_VERDICT',
      `${path}.field must be one of ${HYPOTHESIS_DELTA_FIELDS.join(', ')}`,
      `${path}.field`,
    );
  }
  const before = requiredString(raw['before'], `${path}.before`);
  if (typeof before !== 'string') return before;
  const after = requiredString(raw['after'], `${path}.after`);
  if (typeof after !== 'string') return after;
  const reason = requiredString(raw['reason'], `${path}.reason`);
  if (typeof reason !== 'string') return reason;
  const claimIds = stringArray(raw['claimIds'], `${path}.claimIds`, { min: 1, max: 16, ids: true });
  if (!Array.isArray(claimIds)) return claimIds;
  const claimError = knownNonRejectedClaims(claimIds, claimById, `${path}.claimIds`);
  if (claimError) return claimError;
  const typedField = field as HypothesisDeltaField;
  if (before !== hypothesisDeltaValue(original, typedField)) {
    return fail(
      'STORY_VERDICT',
      `${path}.before must exactly match the original ${typedField}`,
      `${path}.before`,
    );
  }
  if (before === after || normalizeMeaning(before) === normalizeMeaning(after)) {
    return fail('STORY_VERDICT', `${path} is only a wording/no-op delta`, path);
  }
  return { field: typedField, before, after, reason, claimIds };
}

function subsetError(
  values: readonly string[],
  allowed: readonly string[],
  path: string,
): StoryPlanningValidationError | null {
  const allowedSet = new Set(allowed);
  const unknown = values.find((item) => !allowedSet.has(item));
  return unknown
    ? fail('STORY_VERDICT', `${path} contains undeclared item "${unknown}"`, path)
    : null;
}

function parseAssessment(
  raw: unknown,
  path: string,
  originalById: ReadonlyMap<string, StoryHypothesis>,
  claimById: ReadonlyMap<string, ResearchClaim>,
): HypothesisAssessment | StoryPlanningValidationError {
  if (!isRecord(raw)) return fail('STORY_SCHEMA', `${path} must be an object`, path);
  const extra = unknownKey(raw, ASSESSMENT_KEYS);
  if (extra) return fail('STORY_SCHEMA', `unknown assessment key "${extra}"`, `${path}.${extra}`);
  const hypothesisId = idString(raw['hypothesisId'], `${path}.hypothesisId`);
  if (typeof hypothesisId !== 'string') return hypothesisId;
  const original = originalById.get(hypothesisId);
  if (!original) {
    return fail('STORY_REFERENCE', `${path} references unknown hypothesis "${hypothesisId}"`, `${path}.hypothesisId`);
  }
  const verdict = raw['verdict'];
  if (!HYPOTHESIS_VERDICTS.includes(verdict as HypothesisVerdict)) {
    return fail(
      'STORY_VERDICT',
      `${path}.verdict must be one of ${HYPOTHESIS_VERDICTS.join(', ')}`,
      `${path}.verdict`,
    );
  }
  const supportClaimIds = stringArray(raw['supportClaimIds'], `${path}.supportClaimIds`, { max: 32, ids: true });
  if (!Array.isArray(supportClaimIds)) return supportClaimIds;
  const counterClaimIds = stringArray(raw['counterClaimIds'], `${path}.counterClaimIds`, { max: 32, ids: true });
  if (!Array.isArray(counterClaimIds)) return counterClaimIds;
  for (const [claimIds, suffix] of [
    [supportClaimIds, 'supportClaimIds'],
    [counterClaimIds, 'counterClaimIds'],
  ] as const) {
    const claimError = knownNonRejectedClaims(claimIds, claimById, `${path}.${suffix}`);
    if (claimError) return claimError;
  }
  const overlap = supportClaimIds.find((id) => counterClaimIds.includes(id));
  if (overlap) {
    return fail('STORY_VERDICT', `${path} uses claim "${overlap}" as both support and counter-evidence`, path);
  }

  const falsifierHits = stringArray(raw['falsifierHits'], `${path}.falsifierHits`, { max: 8 });
  if (!Array.isArray(falsifierHits)) return falsifierHits;
  const falsifierError = subsetError(falsifierHits, original.falsifiers, `${path}.falsifierHits`);
  if (falsifierError) return falsifierError;
  const unsupportedEvidenceNeeds = stringArray(
    raw['unsupportedEvidenceNeeds'],
    `${path}.unsupportedEvidenceNeeds`,
    { max: 8 },
  );
  if (!Array.isArray(unsupportedEvidenceNeeds)) return unsupportedEvidenceNeeds;
  const needsError = subsetError(
    unsupportedEvidenceNeeds,
    original.evidenceNeeds,
    `${path}.unsupportedEvidenceNeeds`,
  );
  if (needsError) return needsError;

  if (!Array.isArray(raw['deltas']) || raw['deltas'].length > 8) {
    return fail('STORY_SCHEMA', `${path}.deltas must be an array with at most 8 entries`, `${path}.deltas`);
  }
  const deltas: ConfrontDelta[] = [];
  for (const [index, item] of raw['deltas'].entries()) {
    const delta = parseDelta(item, `${path}.deltas[${index}]`, original, claimById);
    if ('ok' in delta) return delta;
    deltas.push(delta);
  }
  if (new Set(deltas.map((item) => item.field)).size !== deltas.length) {
    return fail('STORY_VERDICT', `${path}.deltas may change each field only once`, `${path}.deltas`);
  }

  const typedVerdict = verdict as HypothesisVerdict;
  if ((typedVerdict === 'KEEP' || typedVerdict === 'REBUILD') && supportClaimIds.length === 0) {
    return fail('STORY_VERDICT', `${path} ${typedVerdict} requires non-rejected supporting claims`, path);
  }
  if (typedVerdict === 'KEEP' && falsifierHits.length > 0) {
    return fail('STORY_VERDICT', `${path} cannot KEEP a hypothesis with a hit declared falsifier`, path);
  }
  if (
    typedVerdict === 'REJECT'
    && counterClaimIds.length === 0
    && falsifierHits.length === 0
    && unsupportedEvidenceNeeds.length === 0
  ) {
    return fail(
      'STORY_VERDICT',
      `${path} REJECT requires a counter-claim, falsifier hit, or unsupported evidence need`,
      path,
    );
  }

  let rebuiltHypothesis: StoryHypothesis | undefined;
  if (typedVerdict === 'REBUILD') {
    if (deltas.length === 0) {
      return fail('STORY_VERDICT', `${path} REBUILD requires explicit before/after deltas`, `${path}.deltas`);
    }
    const parsed = parseHypothesis(raw['rebuiltHypothesis'], `${path}.rebuiltHypothesis`);
    if ('ok' in parsed) return parsed;
    rebuiltHypothesis = parsed;
    if (rebuiltHypothesis.id !== original.id || rebuiltHypothesis.provocation !== original.provocation) {
      return fail(
        'STORY_VERDICT',
        `${path}.rebuiltHypothesis must preserve candidate id and provocation`,
        `${path}.rebuiltHypothesis`,
      );
    }
    const deltaByField = new Map(deltas.map((item) => [item.field, item]));
    for (const field of HYPOTHESIS_DELTA_FIELDS) {
      const originalValue = hypothesisDeltaValue(original, field);
      const rebuiltValue = hypothesisDeltaValue(rebuiltHypothesis, field);
      const changed = Array.isArray(original[field])
        ? originalValue !== rebuiltValue
        : normalizeMeaning(originalValue) !== normalizeMeaning(rebuiltValue);
      const delta = deltaByField.get(field);
      if (changed && !delta) {
        return fail('STORY_VERDICT', `${path} changed ${field} without an auditable delta`, path);
      }
      if (!changed && delta) {
        return fail('STORY_VERDICT', `${path}.deltas declares ${field}, but rebuilt value is unchanged`, path);
      }
      if (delta && delta.after !== rebuiltValue) {
        return fail(
          'STORY_VERDICT',
          `${path} delta.after for ${field} must exactly match rebuiltHypothesis`,
          path,
        );
      }
    }
    const beliefShiftFields: readonly HypothesisDeltaField[] = [
      'thesisHypothesis',
      'beliefBefore',
      'beliefAfter',
      'centralTension',
    ];
    if (!deltas.some((item) => beliefShiftFields.includes(item.field))) {
      return fail('STORY_VERDICT', `${path} REBUILD must change the thesis or belief journey`, path);
    }
  } else {
    if (raw['rebuiltHypothesis'] !== undefined) {
      return fail('STORY_VERDICT', `${path} may include rebuiltHypothesis only for REBUILD`, `${path}.rebuiltHypothesis`);
    }
    if (deltas.length > 0) {
      return fail('STORY_VERDICT', `${path} may include deltas only for REBUILD`, `${path}.deltas`);
    }
  }

  return {
    hypothesisId,
    verdict: typedVerdict,
    supportClaimIds,
    counterClaimIds,
    falsifierHits,
    unsupportedEvidenceNeeds,
    deltas,
    ...(rebuiltHypothesis ? { rebuiltHypothesis } : {}),
  };
}

function parseHookVerdict(
  raw: unknown,
  path: string,
  selectedHook: SelectedHook,
  claimById: ReadonlyMap<string, ResearchClaim>,
): HookVerdict | StoryPlanningValidationError {
  if (!isRecord(raw)) return fail('STORY_HOOK', `${path} must be an object`, path);
  const extra = unknownKey(raw, HOOK_VERDICT_KEYS);
  if (extra) return fail('STORY_HOOK', `unknown hook verdict key "${extra}"`, `${path}.${extra}`);
  const status = raw['status'];
  if (!HOOK_STATUSES.includes(status as HookStatus)) {
    return fail('STORY_HOOK', `${path}.status must be one of ${HOOK_STATUSES.join(', ')}`, `${path}.status`);
  }
  const rationale = requiredString(raw['rationale'], `${path}.rationale`);
  if (typeof rationale !== 'string') return rationale;
  const claimIds = stringArray(raw['claimIds'], `${path}.claimIds`, { max: 32, ids: true });
  if (!Array.isArray(claimIds)) return claimIds;
  const claimError = knownNonRejectedClaims(claimIds, claimById, `${path}.claimIds`);
  if (claimError) return claimError;

  const typedStatus = status as HookStatus;
  if (claimIds.length === 0) {
    return fail('STORY_HOOK', `${path} ${typedStatus} requires an evidence-linked claim ID`, `${path}.claimIds`);
  }
  if (typedStatus !== 'REWRITE') {
    if (raw['replacementHook'] !== undefined) {
      return fail('STORY_HOOK', `${path}.replacementHook is allowed only for REWRITE`, `${path}.replacementHook`);
    }
    return { status: typedStatus, rationale, claimIds };
  }

  const replacement = parseSelectedHook(raw['replacementHook'], `${path}.replacementHook`);
  if ('ok' in replacement) return replacement;
  if (replacement.id === selectedHook.id) {
    return fail('STORY_HOOK', 'replacement hook needs a new ID so the human selection remains auditable', `${path}.replacementHook.id`);
  }
  if (replacement.type !== selectedHook.type) {
    return fail(
      'STORY_HOOK',
      'REWRITE may tighten grounding but may not change the human-selected hook type/promise',
      `${path}.replacementHook.type`,
    );
  }
  if (normalizeMeaning(replacement.text) === normalizeMeaning(selectedHook.text)) {
    return fail('STORY_HOOK', 'replacement hook must make a real change', `${path}.replacementHook.text`);
  }
  const promiseOverlap = overlapCoefficient(
    meaningTokens(selectedHook.text),
    meaningTokens(replacement.text),
  );
  if (promiseOverlap < 0.7) {
    return fail(
      'STORY_HOOK',
      `replacement hook changes the selected promise too much (token overlap ${promiseOverlap.toFixed(2)}); use REJECT`,
      `${path}.replacementHook.text`,
    );
  }
  return { status: typedStatus, rationale, claimIds, replacementHook: replacement };
}

function parseBeatEvidence(
  raw: unknown,
  path: string,
): BeatEvidence | StoryPlanningValidationError {
  if (!isRecord(raw)) return fail('STORY_EVIDENCE', `${path} must be an object`, path);
  const extra = unknownKey(raw, BEAT_EVIDENCE_KEYS);
  if (extra) return fail('STORY_EVIDENCE', `unknown beatEvidence key "${extra}"`, `${path}.${extra}`);
  const beatIndex = raw['beatIndex'];
  if (!Number.isInteger(beatIndex) || (beatIndex as number) < 0) {
    return fail('STORY_EVIDENCE', `${path}.beatIndex must be a non-negative integer`, `${path}.beatIndex`);
  }
  const claimIds = stringArray(raw['claimIds'], `${path}.claimIds`, { min: 1, max: 16, ids: true });
  if (!Array.isArray(claimIds)) return claimIds;
  const evidenceIds = stringArray(raw['evidenceIds'], `${path}.evidenceIds`, { min: 1, max: 32, ids: true });
  if (!Array.isArray(evidenceIds)) return evidenceIds;
  return { beatIndex: beatIndex as number, claimIds, evidenceIds };
}

function beatText(plan: StoryVideoPlan, beatIndex: number): string {
  const beat = plan.progression[beatIndex];
  return beat
    ? [beat.beat, beat.newInformation, beat.characterOrArgumentChange, beat.visualAnchor].join(' ')
    : '';
}

interface BeatGroundingSuccess {
  ok: true;
  groundedClaimIds: string[];
  authorizedClaims: AuthorizedClaimPermission[];
}

function validateBeatGrounding(
  beatEvidence: readonly BeatEvidence[],
  plan: StoryVideoPlan,
  researchMap: ResearchMap,
): BeatGroundingSuccess | StoryPlanningValidationError {
  const factualBeatIndexes = new Set(
    plan.progression
      .map((beat, index) => beat.kind === 'FACTUAL' ? index : -1)
      .filter((index) => index >= 0),
  );
  if (beatEvidence.length !== factualBeatIndexes.size) {
    return fail(
      'STORY_EVIDENCE',
      `beatEvidence must contain one grounded mapping for each of `
        + `${factualBeatIndexes.size} FACTUAL beats; got ${beatEvidence.length}`,
      '$.beatEvidence',
    );
  }
  const claimById = new Map(researchMap.claims.map((claim) => [claim.id, claim]));
  const evidenceById = new Map(researchMap.evidence.map((item) => [item.id, item]));
  const seenIndexes = new Set<number>();
  const selectedEvidenceIds: string[] = [];
  const groundedClaimIds: string[] = [];

  for (const item of beatEvidence) {
    if (item.beatIndex >= plan.progression.length || seenIndexes.has(item.beatIndex)) {
      return fail(
        'STORY_EVIDENCE',
        `beatEvidence beatIndex ${item.beatIndex} is duplicate or outside finalPlan.progression`,
        '$.beatEvidence',
      );
    }
    seenIndexes.add(item.beatIndex);
    if (!factualBeatIndexes.has(item.beatIndex)) {
      return fail(
        'STORY_EVIDENCE',
        `beatEvidence targets ${plan.progression[item.beatIndex]!.kind} beat ${item.beatIndex}; `
          + 'only FACTUAL beats may carry claim/evidence grounding',
        `$.beatEvidence[${item.beatIndex}]`,
      );
    }
    const claimError = knownNonRejectedClaims(item.claimIds, claimById, `$.beatEvidence[${item.beatIndex}].claimIds`);
    if (claimError) return claimError;
    const evidencedClaims = new Set<string>();
    for (const evidenceId of item.evidenceIds) {
      const evidence: ResearchEvidence | undefined = evidenceById.get(evidenceId);
      if (!evidence) {
        return fail('STORY_REFERENCE', `beat ${item.beatIndex} references unknown evidence "${evidenceId}"`);
      }
      if (!item.claimIds.includes(evidence.claimId)) {
        return fail(
          'STORY_EVIDENCE',
          `evidence "${evidenceId}" belongs to claim "${evidence.claimId}", not this beat's claimIds`,
        );
      }
      if (evidence.relation === 'CONTRADICTS') {
        return fail(
          'STORY_EVIDENCE',
          `evidence "${evidenceId}" contradicts claim "${evidence.claimId}" and cannot authorize it`,
        );
      }
      evidencedClaims.add(evidence.claimId);
      selectedEvidenceIds.push(evidenceId);
    }
    const unsupportedClaim = item.claimIds.find((claimId) => !evidencedClaims.has(claimId));
    if (unsupportedClaim) {
      return fail(
        'STORY_EVIDENCE',
        `beat ${item.beatIndex} claim "${unsupportedClaim}" has no supporting/qualifying evidence in the beat mapping`,
      );
    }
    for (const claimId of item.claimIds) {
      if (!groundedClaimIds.includes(claimId)) groundedClaimIds.push(claimId);
    }
    for (const claimId of item.claimIds) {
      const claim = claimById.get(claimId)!;
      if (
        claim.status === 'DISPUTED'
        && !hasDisputedCaveatLanguage(beatText(plan, item.beatIndex))
      ) {
        return fail(
          'STORY_DISPUTED_UNQUALIFIED',
          `beat ${item.beatIndex} selects DISPUTED claim "${claimId}" without visible conflict/caveat language`,
          `$.finalPlan.progression[${item.beatIndex}]`,
        );
      }
    }
  }
  for (const index of factualBeatIndexes) {
    if (!seenIndexes.has(index)) {
      return fail('STORY_EVIDENCE', `beatEvidence is missing FACTUAL beat ${index}`, '$.beatEvidence');
    }
  }

  const ledger = deriveFactsLedger(researchMap, selectedEvidenceIds);
  if (!ledger.ok) return fail('STORY_EVIDENCE', ledger.reason, '$.beatEvidence');
  const permissions = deriveAuthorizedClaimPermissions(researchMap, selectedEvidenceIds);
  if (!permissions.ok) return fail('STORY_EVIDENCE', permissions.reason, '$.beatEvidence');
  return { ok: true, groundedClaimIds, authorizedClaims: permissions.permissions };
}

export function validateConfrontArtifact(
  value: unknown,
  context: ConfrontValidationContext,
): ConfrontValidationResult {
  const bytes = serializedBytes(value);
  if (bytes === null) return fail('STORY_SCHEMA', 'CONFRONT artifact must be JSON-serializable');
  const maxBytes = context.maxBytes ?? MAX_CONFRONT_BYTES;
  if (bytes > maxBytes) {
    return fail(
      'STORY_ARTIFACT_OVERSIZE',
      `CONFRONT artifact is ${bytes} bytes; maximum is ${maxBytes}`,
    );
  }
  if (!isRecord(value)) return fail('STORY_SCHEMA', 'CONFRONT artifact must be an object');
  const extra = unknownKey(value, TOP_CONFRONT_KEYS);
  if (extra) return fail('STORY_SCHEMA', `unknown CONFRONT key "${extra}"`, `$.${extra}`);
  if (value['schemaVersion'] !== CONFRONT_SCHEMA_VERSION) {
    return fail(
      'STORY_SCHEMA',
      `schemaVersion must be "${CONFRONT_SCHEMA_VERSION}"`,
      '$.schemaVersion',
    );
  }

  const originalById = new Map(context.divergeArtifact.hypotheses.map((item) => [item.id, item]));
  const claimById = new Map(context.researchMap.claims.map((item) => [item.id, item]));
  if (!Array.isArray(value['assessments']) || value['assessments'].length !== 3) {
    return fail('STORY_SCHEMA', '$.assessments must contain exactly three entries', '$.assessments');
  }
  const assessments: HypothesisAssessment[] = [];
  for (const [index, raw] of value['assessments'].entries()) {
    const assessment = parseAssessment(
      raw,
      `$.assessments[${index}]`,
      originalById,
      claimById,
    );
    if ('ok' in assessment) return assessment;
    assessments.push(assessment);
  }
  const assessedIds = assessments.map((item) => item.hypothesisId);
  if (new Set(assessedIds).size !== 3 || [...originalById.keys()].some((id) => !assessedIds.includes(id))) {
    return fail('STORY_REFERENCE', 'CONFRONT must assess each DIVERGE hypothesis exactly once', '$.assessments');
  }
  if (!assessments.some((item) => item.verdict === 'KEEP' || item.verdict === 'REBUILD')) {
    return fail('STORY_VERDICT', 'at least one hypothesis must survive as KEEP or REBUILD', '$.assessments');
  }

  const hookVerdict = parseHookVerdict(
    value['hookVerdict'],
    '$.hookVerdict',
    context.selectedHook,
    claimById,
  );
  if ('ok' in hookVerdict) return hookVerdict;

  if (hookVerdict.status === 'REJECT') {
    if (
      value['selectedHypothesisId'] !== undefined
      || value['finalPlan'] !== undefined
      || value['beatEvidence'] !== undefined
    ) {
      return fail(
        'STORY_HOOK',
        'hook REJECT is terminal: selectedHypothesisId, finalPlan, and beatEvidence must be absent',
      );
    }
    return {
      ok: true,
      artifact: {
        schemaVersion: CONFRONT_SCHEMA_VERSION,
        assessments: [assessments[0]!, assessments[1]!, assessments[2]!],
        hookVerdict,
      },
      authorizedClaims: [],
    };
  }

  const selectedHypothesisId = idString(value['selectedHypothesisId'], '$.selectedHypothesisId');
  if (typeof selectedHypothesisId !== 'string') return selectedHypothesisId;
  const selectedAssessment = assessments.find((item) => item.hypothesisId === selectedHypothesisId);
  if (!selectedAssessment) {
    return fail('STORY_REFERENCE', `selected hypothesis "${selectedHypothesisId}" was not assessed`);
  }
  if (selectedAssessment.verdict === 'REJECT') {
    return fail('STORY_VERDICT', `REJECT hypothesis "${selectedHypothesisId}" cannot be selected`);
  }

  const planShapeError = validateStrictPlanShape(value['finalPlan'], '$.finalPlan');
  if (planShapeError) return planShapeError;
  const planResult = validateWriterVideoPlan(value['finalPlan']);
  if (!planResult.ok) return fail('STORY_PLAN', planResult.reason, '$.finalPlan');
  const storyPlan = parseStoryVideoPlan(
    value['finalPlan'],
    planResult.videoPlan,
    context.approvedPersonaExperienceIds ?? [],
  );
  if ('ok' in storyPlan) return storyPlan;

  if (!Array.isArray(value['beatEvidence'])) {
    return fail('STORY_EVIDENCE', '$.beatEvidence must be an array', '$.beatEvidence');
  }
  const beatEvidence: BeatEvidence[] = [];
  for (const [index, raw] of value['beatEvidence'].entries()) {
    const parsed = parseBeatEvidence(raw, `$.beatEvidence[${index}]`);
    if ('ok' in parsed) return parsed;
    beatEvidence.push(parsed);
  }
  const grounding = validateBeatGrounding(beatEvidence, storyPlan, context.researchMap);
  if (!grounding.ok) return grounding;
  const orphanHookClaim = hookVerdict.claimIds.find(
    (claimId) => !grounding.groundedClaimIds.includes(claimId),
  );
  if (orphanHookClaim) {
    return fail(
      'STORY_HOOK',
      `hook claim "${orphanHookClaim}" is not grounded by any FACTUAL beat`,
      '$.hookVerdict.claimIds',
    );
  }

  return {
    ok: true,
    artifact: {
      schemaVersion: CONFRONT_SCHEMA_VERSION,
      assessments: [assessments[0]!, assessments[1]!, assessments[2]!],
      selectedHypothesisId,
      hookVerdict,
      finalPlan: storyPlan,
      beatEvidence,
    },
    authorizedClaims: grounding.authorizedClaims,
  };
}

/** Return the hook WRITE may receive after a validated CONFRONT artifact. */
export function effectiveHookFromConfront(
  selectedHook: SelectedHook,
  confront: ConfrontArtifact,
): SelectedHook | null {
  if (confront.hookVerdict.status === 'REJECT') return null;
  if (confront.hookVerdict.status === 'REWRITE') {
    return confront.hookVerdict.replacementHook ?? null;
  }
  return selectedHook;
}

/** Stable, de-duplicated evidence selection for mechanical ledger derivation. */
export function selectedEvidenceIdsFromConfront(confront: ConfrontArtifact): string[] {
  return [...new Set((confront.beatEvidence ?? []).flatMap((item) => item.evidenceIds))];
}
