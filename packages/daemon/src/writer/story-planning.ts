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
  DISPUTED_CAVEAT_MARKERS,
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
export const DIVERGE_PROMPT_VERSION = 'writer-v2-diverge-v1' as const;
export const CONFRONT_PROMPT_VERSION = 'writer-v2-confront-v1' as const;
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
const PLAN_KEYS = new Set(['coreInsight', 'memoryAnchor', 'frame', 'progression', 'endingPayoff', 'cutList']);
const MEMORY_ANCHOR_KEYS = new Set(['kind', 'value']);
const FRAME_KEYS = new Set(['kind', 'value']);
const PLAN_BEAT_KEYS = new Set([
  'kind',
  'beat',
  'newInformation',
  'characterOrArgumentChange',
  'visualAnchor',
  'mode',
  'turn',
  'familiarObject',
  'whyNotEarlier',
  'personaEntryId',
]);
const ENDING_PAYOFF_KEYS = new Set([
  'resolvesOpening',
  'audienceCanDo',
  'directAnswer',
  'reframedQuestion',
]);
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

function promptKeyList(keys: ReadonlySet<string>): string {
  return [...keys].map((key) => `\`${key}\``).join(', ');
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
  const frame = raw['frame'];
  if (!isRecord(frame)) return fail('STORY_PLAN', `${path}.frame must be an object`, `${path}.frame`);
  const frameExtra = unknownKey(frame, FRAME_KEYS);
  if (frameExtra) {
    return fail('STORY_PLAN', `unknown frame key "${frameExtra}"`, `${path}.frame.${frameExtra}`);
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

const DIVERGE_PROMPT_EXAMPLE: DivergeArtifact = {
  schemaVersion: DIVERGE_SCHEMA_VERSION,
  hypotheses: [
    {
      id: 'h-contradiction',
      provocation: 'CONTRADICTION',
      thesisHypothesis: 'Thứ làm ta thấy an toàn đôi khi lại làm quyền đổi hướng nhỏ đi.',
      beliefBefore: 'Người xem tin tích lũy thêm cam kết luôn làm đời sống vững hơn.',
      beliefAfter: 'Người xem nhận ra an toàn còn nằm ở những lựa chọn mình vẫn có thể từ chối.',
      centralTension: 'Cảm giác chắc chắn tăng lên trong khi lối thoát thực tế hẹp lại.',
      hookDebt: 'Giải thích nghịch lý giữa vẻ chắc chắn và quyền rời đi.',
      beatQuestions: [
        'Cam kết nào âm thầm lấy đi quyền đổi hướng?',
        'Dấu hiệu nào cho thấy cảm giác an toàn đang đánh lừa ta?',
      ],
      evidenceNeeds: [
        'Điều gì cho thấy một cam kết có thể làm khả năng từ chối giảm đi?',
        'Cần kiểm tra khi nào tích lũy thêm không đồng nghĩa với linh hoạt hơn?',
      ],
      falsifiers: [
        'Nếu cam kết lớn hơn vẫn luôn giữ nguyên quyền đổi hướng thì nghịch lý này sai.',
      ],
      proposedPayoff: 'Người xem có một phép thử dựa trên quyền lựa chọn còn lại.',
    },
    {
      id: 'h-zoom-in',
      provocation: 'ZOOM_IN',
      thesisHypothesis: 'Cơ chế đáng nhìn là khoảnh khắc thời gian chờ biến thành áp lực phải nhận lời.',
      beliefBefore: 'Người xem tin sức mạnh thương lượng chủ yếu đến từ vị thế hiện tại.',
      beliefAfter: 'Người xem thấy khả năng chờ mới quyết định mình có thể bỏ qua một lựa chọn tệ hay không.',
      centralTension: 'Mỗi cam kết cố định làm chiếc đồng hồ ra quyết định chạy nhanh hơn.',
      hookDebt: 'Làm rõ khoảnh khắc quyền chờ đợi biến mất.',
      beatQuestions: [
        'Điều gì khiến một người không còn đủ thời gian để nói không?',
        'Khả năng chờ thay đổi một cuộc thương lượng ra sao?',
      ],
      evidenceNeeds: [
        'Cần xác định cơ chế nối áp lực cố định với thời gian ra quyết định?',
        'Bằng chứng nào phân biệt vị thế bề ngoài với khả năng chờ thực tế?',
      ],
      falsifiers: [
        'Nếu khả năng chờ không làm thay đổi hành vi thương lượng thì cơ chế này không đứng vững.',
      ],
      proposedPayoff: 'Người xem biết quan sát chiếc đồng hồ quyết định thay vì chỉ nhìn vị thế.',
    },
    {
      id: 'h-inversion',
      provocation: 'INVERSION',
      thesisHypothesis: 'Giữ mọi cánh cửa mở quá lâu có thể biến tự do thành cách né một cam kết đáng làm.',
      beliefBefore: 'Người xem tin càng giữ được nhiều lựa chọn thì quyết định càng tốt.',
      beliefAfter: 'Người xem phân biệt quyền đổi hướng có chủ đích với thói quen không chịu chọn.',
      centralTension: 'Linh hoạt bảo vệ ta khỏi lựa chọn xấu nhưng cũng có thể giữ ta đứng yên.',
      hookDebt: 'Chỉ ra điểm quyền lựa chọn đảo chiều thành trì hoãn.',
      beatQuestions: [
        'Khi nào một cánh cửa mở còn tạo ra giá trị?',
        'Dấu hiệu nào cho thấy linh hoạt đã trở thành né tránh?',
      ],
      evidenceNeeds: [
        'Cần đối chiếu lợi ích của linh hoạt với chi phí của việc không cam kết?',
        'Điều gì cho thấy một giới hạn tự chọn có thể cải thiện hành động?',
      ],
      falsifiers: [
        'Nếu giữ thêm lựa chọn luôn làm hành động tốt hơn thì phép đảo chiều này bị bác bỏ.',
      ],
      proposedPayoff: 'Người xem có tiêu chí để đóng một cánh cửa mà không đánh mất quyền tự chủ.',
    },
  ],
};

/**
 * Stable, context-free DIVERGE instructions. Runtime title/brief/hook data lives
 * in the stage envelope; keeping it out of this function makes the prompt text
 * independently hashable and keeps accidental source material out of the API.
 */
export function buildDivergePrompt(): string {
  return [
    '# Writer v2 — DIVERGE (tạo ba hành trình niềm tin, chưa lập outline)',
    '',
    'Đọc `input/envelope.json` để lấy title, brief, audience và selectedHook đã được con người chọn.',
    'Bạn đang ở một phiên SOURCE-BLIND: bạn không biết Topic Pack có gì và không được cố đoán.',
    'Không hỏi xin nguồn, không mở hay dò file ngoài những file được liệt kê trong envelope, không nhắc',
    'video/transcript/source ID/host, không bịa số liệu cụ thể và không chép lại chi tiết nguồn giả định.',
    'Một con số chỉ được lặp lại nếu nó đã xuất hiện nguyên dạng trong selectedHook.',
    '',
    'Nhiệm vụ duy nhất: tạo đúng ba hypothesis cạnh tranh để CONFRONT kiểm bằng evidence sau này.',
    'Đây KHÔNG phải ba cách diễn đạt của một ý và KHÔNG phải ba outline. Không viết mở bài, thân bài,',
    'kết bài, section, beat order, narration, intro, outro hay thứ tự “đầu tiên/sau đó/cuối cùng”.',
    '',
    '## Belief shift là tiêu chuẩn chất lượng',
    '',
    '- `beliefBefore` là điều NGƯỜI XEM tin trước khi xem; `beliefAfter` là điều NGƯỜI XEM tin sau khi xem.',
    '- Mỗi candidate phải đổi một niềm tin khác nhau về bản chất, không chỉ đổi ví dụ, nhân vật hay câu chữ.',
    '- Hai candidate cùng đi từ “tôi cần cố hơn” sang “tôi cần đổi hệ thống” vẫn là TRÙNG, dù dùng hai ví dụ khác nhau.',
    '- `thesisHypothesis`, `beliefBefore`, `beliefAfter`, `centralTension` phải khác đáng kể giữa cả ba candidate.',
    '- `hookDebt` nói món nợ nhận thức phải trả; `proposedPayoff` nói người xem hiểu/làm được gì khi món nợ được trả.',
    '- `beatQuestions` chỉ là các câu hỏi cần mở khóa, không phải danh sách phần hay trình tự kể chuyện.',
    '',
    '## Bốn provocation — chọn đúng ba loại khác nhau',
    '',
    '- `CONTRADICTION`: tìm một sự thật đối nghịch nhưng đáng tin làm tiền đề trực giác trở nên chưa đủ.',
    '- `ZOOM_IN`: thu hẹp vào một cơ chế, khoảnh khắc hay quyết định có hệ quả; không tóm tắt toàn chủ đề.',
    '- `EXTREME_TEST`: đẩy logic tới trường hợp biên để thấy điều kiện nào làm nó đứng vững hoặc gãy.',
    '- `INVERSION`: hỏi khi nào bài học tưởng đúng đảo chiều và điều ngược lại mới hữu ích.',
    'Dùng ba provocation khác nhau; tên provocation không tự làm candidate khác biệt — belief shift mới làm được điều đó.',
    '',
    '## evidenceNeeds và falsifiers',
    '',
    '- `evidenceNeeds` gồm 1–8 CÂU HỎI cần evidence trả lời, không phải khẳng định rằng evidence đã tồn tại.',
    '  ĐÚNG: “Điều gì cho thấy áp lực cố định làm quyền từ chối giảm đi?”',
    '  SAI: “Dữ liệu đã chứng minh áp lực cố định luôn làm quyền từ chối giảm.”',
    '- `falsifiers` gồm 1–8 ĐIỀU KIỆN quan sát được khiến hypothesis sai hoặc không đứng vững.',
    '  ĐÚNG: “Nếu khả năng chờ không đổi hành vi thương lượng thì hypothesis này sai.”',
    '  SAI: “Khả năng chờ ảnh hưởng đến thương lượng.”',
    '- `beatQuestions` gồm 2–8 câu, mỗi câu phải kết thúc bằng `?`. Mọi array không được có phần tử trùng.',
    '',
    '## Strict JSON contract',
    '',
    `Output phải JSON-serializable và không quá ${MAX_DIVERGE_BYTES} bytes. Chỉ ghi JSON vào \`out/result.json\`; không Markdown, không giải thích ngoài JSON.`,
    `Top-level chỉ được có đúng các key: ${promptKeyList(TOP_DIVERGE_KEYS)}. \`schemaVersion\` = \`${DIVERGE_SCHEMA_VERSION}\`.`,
    `Mỗi hypothesis chỉ được có đúng các key: ${promptKeyList(HYPOTHESIS_KEYS)}.`,
    'Không thêm key “hữu ích” nào khác. `id` phải unique, tối đa 80 ký tự, bắt đầu bằng chữ/số',
    'và chỉ dùng chữ/số hoặc `._:-`; mọi chuỗi phải không rỗng và tối đa 4000 ký tự.',
    'Phải có đúng ba hypothesis và đúng ba provocation khác nhau.',
    '',
    'Ví dụ output đầy đủ, hợp lệ về schema và đúng mức abstraction:',
    '',
    '```json',
    JSON.stringify(DIVERGE_PROMPT_EXAMPLE, null, 2),
    '```',
  ].join('\n');
}

const CONFRONT_EXAMPLE_ZOOM = DIVERGE_PROMPT_EXAMPLE.hypotheses[1];
const CONFRONT_EXAMPLE_REBUILT_ZOOM: StoryHypothesis = {
  ...CONFRONT_EXAMPLE_ZOOM,
  beliefAfter: 'Người xem thấy áp lực cố định và khả năng chờ cùng quyết định quyền từ chối.',
  evidenceNeeds: [
    'Cần xác định cơ chế nối áp lực cố định với thời gian ra quyết định?',
    'Điều gì cho thấy khả năng chờ thay đổi quyền từ chối một lựa chọn tệ?',
  ],
};

const CONFRONT_PROMPT_EXAMPLE: ConfrontArtifact = {
  schemaVersion: CONFRONT_SCHEMA_VERSION,
  assessments: [
    {
      hypothesisId: 'h-contradiction',
      verdict: 'KEEP',
      supportClaimIds: ['claim-choice'],
      counterClaimIds: [],
      falsifierHits: [],
      unsupportedEvidenceNeeds: [],
      deltas: [],
    },
    {
      hypothesisId: 'h-zoom-in',
      verdict: 'REBUILD',
      supportClaimIds: ['claim-pressure', 'claim-wait'],
      counterClaimIds: [],
      falsifierHits: [],
      unsupportedEvidenceNeeds: [CONFRONT_EXAMPLE_ZOOM.evidenceNeeds[1]!],
      deltas: [
        {
          field: 'beliefAfter',
          before: CONFRONT_EXAMPLE_ZOOM.beliefAfter,
          after: CONFRONT_EXAMPLE_REBUILT_ZOOM.beliefAfter,
          reason: 'Evidence chỉ đỡ cơ chế kết hợp giữa áp lực cố định và khả năng chờ.',
          claimIds: ['claim-pressure', 'claim-wait'],
        },
        {
          field: 'evidenceNeeds',
          before: JSON.stringify(CONFRONT_EXAMPLE_ZOOM.evidenceNeeds),
          after: JSON.stringify(CONFRONT_EXAMPLE_REBUILT_ZOOM.evidenceNeeds),
          reason: 'Câu hỏi cũ đòi một phép so sánh mà ResearchMap không cung cấp.',
          claimIds: ['claim-pressure', 'claim-wait'],
        },
      ],
      rebuiltHypothesis: CONFRONT_EXAMPLE_REBUILT_ZOOM,
    },
    {
      hypothesisId: 'h-inversion',
      verdict: 'REJECT',
      supportClaimIds: [],
      counterClaimIds: ['claim-overload'],
      falsifierHits: [DIVERGE_PROMPT_EXAMPLE.hypotheses[2].falsifiers[0]!],
      unsupportedEvidenceNeeds: [],
      deltas: [],
    },
  ],
  selectedHypothesisId: 'h-zoom-in',
  hookVerdict: {
    status: 'KEEP',
    rationale: 'Hook được claim về áp lực cố định chống lưng mà không cần đổi lời hứa.',
    claimIds: ['claim-pressure'],
  },
  finalPlan: {
    coreInsight: 'Quyền từ chối phụ thuộc cả áp lực cố định lẫn khả năng chờ.',
    memoryAnchor: {
      kind: 'equation',
      value: 'quyền lựa chọn = khả năng chờ - áp lực cố định',
    },
    frame: {
      kind: 'con-so',
      value: 'khoản áp lực cố định hằng tháng',
    },
    progression: [
      {
        kind: 'FACTUAL',
        beat: 'Lối thoát',
        newInformation: 'Khoảng đệm bảo vệ quyền đổi hướng.',
        characterOrArgumentChange: 'Từ nhìn tài sản sang nhìn lựa chọn còn lại.',
        visualAnchor: 'Một cánh cửa còn mở.',
        mode: 'canh',
        turn: 'doi-thoi-diem',
        familiarObject: 'cánh cửa thoát hiểm của căn hộ',
        whyNotEarlier: 'chưa có gì để so sánh nếu mở bằng cảnh này trước hook',
      },
      {
        kind: 'NARRATIVE',
        beat: 'Câu hỏi ở giữa',
        newInformation: 'Đổi nhịp bằng một câu hỏi dẫn sang cơ chế.',
        characterOrArgumentChange: 'Người xem chuyển từ kết quả sang nguyên nhân.',
        visualAnchor: 'Một chiếc đồng hồ bắt đầu chạy.',
        mode: 'zoom-chu',
        turn: 'doi-cau-hoi',
        familiarObject: 'chữ "lối thoát" vừa dùng ở beat trước',
        whyNotEarlier: 'phải có chữ đó xuất hiện trước mới soi lại được',
      },
      {
        kind: 'FACTUAL',
        beat: 'Áp lực',
        newInformation: 'Cam kết cố định làm thời gian quyết định ngắn lại.',
        characterOrArgumentChange: 'Áp lực được nhìn như một giới hạn thời gian.',
        visualAnchor: 'Lịch đếm ngược.',
        mode: 'mo-so',
        turn: 'doi-thang',
        familiarObject: 'khoản trả góp hằng tháng',
        whyNotEarlier: 'câu hỏi dẫn phải đứng trước để con số có mục tiêu',
      },
      {
        kind: 'FACTUAL',
        beat: 'Vị thế',
        newInformation: 'Khả năng chờ cho phép từ chối một lựa chọn kém.',
        characterOrArgumentChange: 'Thời gian trở thành sức mạnh thương lượng.',
        visualAnchor: 'Hai lời đề nghị trên bàn.',
        mode: 'phan-bac',
        turn: 'doi-chu-the',
        familiarObject: 'lời đề nghị công việc đang chờ trả lời',
        whyNotEarlier: 'con số áp lực phải lộ ra trước mới có gì để cãi',
      },
    ],
    endingPayoff: {
      resolvesOpening: 'Vẻ an toàn không đủ nếu quyền rời đi đã biến mất.',
      audienceCanDo: 'Kiểm tra khả năng chờ và áp lực cố định trước một cam kết mới.',
      directAnswer: 'có, mức lương này vẫn an toàn',
      reframedQuestion: 'quyền rời đi của bạn còn lại bao nhiêu sau áp lực cố định?',
    },
    cutList: ['Không biến kế hoạch thành danh sách công thức rời rạc.'],
  },
  beatEvidence: [
    { beatIndex: 0, claimIds: ['claim-choice'], evidenceIds: ['evidence-choice'] },
    { beatIndex: 2, claimIds: ['claim-pressure'], evidenceIds: ['evidence-pressure'] },
    { beatIndex: 3, claimIds: ['claim-wait'], evidenceIds: ['evidence-wait'] },
  ],
};

/** Stable CONFRONT instructions; validated DIVERGE/RESEARCH data is staged separately. */
export function buildConfrontPrompt(): string {
  return [
    '# Writer v2 — CONFRONT (để evidence sửa hoặc giết ý tưởng)',
    '',
    'Đọc `input/envelope.json`, rồi đọc đúng các file validated DIVERGE và ResearchMap được envelope liệt kê.',
    'Bạn chỉ được dùng các claim/evidence ID có trong ResearchMap, selectedHook và danh sách',
    'approved Persona experience ID đã pin. Không dò raw Topic Pack, General Pack, Formula hay Persona prose.',
    'Mục tiêu không phải bảo vệ ý tưởng ban đầu. Nếu evidence bác hypothesis hoặc không đỡ được hook,',
    '`REJECT` là kết luận đúng — không phải một lần làm bài thất bại.',
    '',
    '## Đánh giá đủ ba hypothesis',
    '',
    '- `assessments` phải có đúng ba entry và đánh giá mỗi hypothesis ID đúng một lần.',
    '- `verdict` chỉ là `KEEP`, `REBUILD`, hoặc `REJECT`; ít nhất một hypothesis phải sống bằng KEEP/REBUILD.',
    '- KEEP/REBUILD cần ít nhất một `supportClaimIds` không REJECTED. Một claim không được vừa support vừa counter.',
    '- Mỗi assessment luôn phải có đủ năm array: `supportClaimIds`, `counterClaimIds`, `falsifierHits`,',
    '  `unsupportedEvidenceNeeds`, `deltas` và các ID tương ứng; khi không có dữ liệu hãy dùng `[]`, không bỏ key.',
    '- KEEP không được có `falsifierHits`. `falsifierHits` phải chép đúng chuỗi từ falsifiers của hypothesis gốc.',
    '- `unsupportedEvidenceNeeds` chỉ được chép đúng câu hỏi từ evidenceNeeds của hypothesis gốc.',
    '- REJECT phải chỉ ra ít nhất một counter claim, falsifier hit, hoặc evidence need chưa được đáp ứng.',
    '- Chỉ REBUILD được có `deltas` và `rebuiltHypothesis`; KEEP/REJECT phải dùng `deltas: []` và bỏ `rebuiltHypothesis`.',
    '',
    '## REBUILD là thay đổi có kiểm toán, không phải sửa câu chữ',
    '',
    `Mỗi delta chỉ được đổi một field trong: ${HYPOTHESIS_DELTA_FIELDS.map((field) => `\`${field}\``).join(', ')}.`,
    '`before` phải khớp CHÍNH XÁC giá trị gốc; `after` phải khớp CHÍNH XÁC giá trị trong rebuiltHypothesis;',
    '`reason` không rỗng và `claimIds` phải chứa claim hợp lệ giải thích thay đổi.',
    'Với field dạng array (`beatQuestions`, `evidenceNeeds`, `falsifiers`), encode `before` và `after` bằng',
    '`JSON.stringify(array)` — chuỗi JSON compact, đúng thứ tự, không thêm khoảng trắng tùy ý.',
    'Ví dụ: `["câu A?","câu B?"]`, không phải `câu A?, câu B?`.',
    'MỌI field thay đổi phải có đúng một delta; field không đổi không được khai delta. ID và provocation phải giữ nguyên.',
    '`rebuiltHypothesis` phải lặp lại đầy đủ schema hypothesis: beatQuestions có 2–8 câu kết thúc bằng `?`;',
    'evidenceNeeds và falsifiers có 1–8 mục đúng dạng câu hỏi/điều kiện; các array không trùng.',
    'REBUILD bắt buộc đổi ít nhất một trong thesisHypothesis/beliefBefore/beliefAfter/centralTension;',
    'chỉ sửa payoff hay danh sách câu hỏi vẫn là no-op và sẽ bị reject.',
    '',
    '## Hook verdict',
    '',
    '- `hookVerdict.status` chỉ là `KEEP`, `REWRITE`, `REJECT`; cả ba đều cần rationale và ít nhất một claimId không REJECTED.',
    '- KEEP/REWRITE: mọi hook claimId phải nằm trong union claimIds của các FACTUAL beat đã grounded.',
    '- REWRITE: thêm `replacementHook` đủ `id`, `type`, `typeLabel`, `text`; ID phải mới, type/typeLabel phải giữ',
    `  loại hook con người đã chọn (${COMPETITOR_HOOK_TYPES.join('|')}), text phải đổi thật và giữ ít nhất`,
    '  0.70 lexical overlap với lời hứa cũ. Muốn đổi lời hứa thì dùng REJECT.',
    '- KEEP và REJECT không được có `replacementHook`.',
    '- REJECT là terminal: vẫn trả ba assessments và hookVerdict có evidence-linked claimIds, nhưng PHẢI BỎ',
    '  `selectedHypothesisId`, `finalPlan`, `beatEvidence`. Không cố dựng plan để cứu một hook evidence không đỡ được.',
    '',
    '## Final plan và typed beats',
    '',
    '- Với hook KEEP/REWRITE, chọn một hypothesis đã KEEP/REBUILD rồi trả `selectedHypothesisId`, `finalPlan`, `beatEvidence`.',
    '- `finalPlan` chỉ có `coreInsight`, `memoryAnchor`, `frame`, `progression`, `endingPayoff`, `cutList`.',
    '- `memoryAnchor` chỉ có `kind` (`name|equation|contrast|image`) và `value`.',
    '- `frame` chỉ có `kind` (`nhan-vat|an-du|con-so`) và `value` — một sợi dây cho cả bài (SDD 006 §3).',
    '- `progression` có 2–8 beat tiến triển. Mỗi beat chỉ có `kind`, `beat`, `newInformation`,',
    '  `characterOrArgumentChange`, `visualAnchor`, `mode`, `turn`, `familiarObject`, `whyNotEarlier`,',
    '  và chỉ PERSONA mới được thêm `personaEntryId`. `mode`/`turn` không được trùng ở hai beat liền kề;',
    '  một `mode` tối đa 2 lần, `doi-y` tối đa 1 lần và không ở beat cuối (SDD 006 §3-4).',
    '- `endingPayoff` chỉ có `resolvesOpening`, `audienceCanDo`, `directAnswer`, `reframedQuestion`;',
    '  `directAnswer` không được trùng nghĩa với `resolvesOpening`. `cutList` là tối đa 8 chuỗi không rỗng.',
    '- FACTUAL: cần đúng một beatEvidence ở đúng `beatIndex`, với claimIds không REJECTED và evidenceIds',
    '  SUPPORTS/QUALIFIES đúng các claim đó. Mỗi claim của beat phải có evidence dương tương ứng.',
    '- NARRATIVE: không có beatEvidence và không có personaEntryId; chỉ dùng cho chuyển nhịp/câu hỏi dẫn.',
    '- PERSONA: không có beatEvidence; bắt buộc một `personaEntryId` nằm trong approved experience ID allowlist.',
    '- Khai NARRATIVE hoặc PERSONA để né evidence KHÔNG có tác dụng: toàn bộ script sau này vẫn bị Claim Boundary',
    '  quét độc lập; factual payload không có authorized claim vẫn fail gate.',
    '- DISPUTED claim chỉ được vào beat khi văn beat giữ caveat/xung đột nhìn thấy được, chẳng hạn:',
    `  ${DISPUTED_CAVEAT_MARKERS.map((marker) => `“${marker}”`).join(', ')}.`,
    '- Các FACTUAL mapping phải chọn ít nhất ba exact evidence khác nhau theo `(videoId, quote)` để ledger legacy hợp lệ.',
    '',
    '## Strict JSON contract',
    '',
    `Output phải JSON-serializable và không quá ${MAX_CONFRONT_BYTES} bytes. Chỉ ghi JSON vào \`out/result.json\`; không Markdown ngoài file.`,
    `Top-level chỉ được có: ${promptKeyList(TOP_CONFRONT_KEYS)}.`,
    `\`schemaVersion\` = \`${CONFRONT_SCHEMA_VERSION}\`. Không thêm key ngoài allowlist ở bất kỳ object lồng nào.`,
    `Assessment keys: ${promptKeyList(ASSESSMENT_KEYS)}.`,
    `Mỗi \`rebuiltHypothesis\` dùng lại đúng allowlist DIVERGE: ${promptKeyList(HYPOTHESIS_KEYS)}.`,
    `\`replacementHook\` chỉ có ${promptKeyList(SELECTED_HOOK_KEYS)} và typeLabel phải khớp hook registry.`,
    `Delta keys: ${promptKeyList(DELTA_KEYS)}.`,
    `Hook verdict keys: ${promptKeyList(HOOK_VERDICT_KEYS)}.`,
    `FinalPlan keys: ${promptKeyList(PLAN_KEYS)}; memoryAnchor keys: ${promptKeyList(MEMORY_ANCHOR_KEYS)}.`,
    `Progression beat keys: ${promptKeyList(PLAN_BEAT_KEYS)}; endingPayoff keys: ${promptKeyList(ENDING_PAYOFF_KEYS)}.`,
    `BeatEvidence keys: ${promptKeyList(BEAT_EVIDENCE_KEYS)}; beatIndex là integer không âm và không trùng.`,
    'Giới hạn array: support/counter/hook claimIds tối đa 32; falsifierHits/unsupportedEvidenceNeeds/deltas',
    'tối đa 8; delta.claimIds và beatEvidence.claimIds 1–16; beatEvidence.evidenceIds 1–32.',
    'Mọi ID/string bắt buộc phải không rỗng; ID tối đa 80 ký tự, bắt đầu bằng chữ/số và chỉ dùng',
    'chữ/số hoặc `._:-`; các array ID/string không được chứa phần tử trùng.',
    '',
    'Ví dụ output non-terminal đầy đủ dưới đây dùng ID minh họa; thay chúng bằng ID thật trong hai artifact input:',
    '',
    '```json',
    JSON.stringify(CONFRONT_PROMPT_EXAMPLE, null, 2),
    '```',
  ].join('\n');
}
