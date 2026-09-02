/**
 * Typed composition boundary for Writer v2 gates and editor routing.
 *
 * Dependency direction is intentionally one-way: this module consumes results
 * from deterministic-gate and assertion-boundary. Neither validator imports it
 * or imports the other validator in reverse. The coordinator will wire these
 * pure contracts in a separately approved change.
 */
import type {
  AssertionBoundaryResult,
  AssertionBoundaryViolationCode,
} from './assertion-boundary.ts';
import type {
  GateResult,
  GateViolationCode,
} from './deterministic-gate.ts';

export const READING_EXPERIENCE_DEFECT_CODES = [
  'MEMORY_ANCHOR_WEAK',
  'PROGRESSION_FLAT',
  'STRUCTURE_SWAPPABLE',
  'HOOK_PAYOFF_MISSED',
  'ENDING_DECAY',
  'PACING',
  'PROSE_DRY',
  'CLARITY',
] as const;

export type ReadingExperienceDefectCode =
  (typeof READING_EXPERIENCE_DEFECT_CODES)[number];

export const CLAIM_BOUNDARY_DEFECT_CODES = [
  'EMPIRICAL_CLAIM_UNAUTHORIZED',
  'SPECIFIC_DRIFT',
  'DISPUTED_UNQUALIFIED',
  'PERSONA_UNAUTHORIZED',
  'ASSERTION_UNANCHORED',
  'SOURCE_MISREPRESENTED',
  'ARITHMETIC_ERROR',
] as const;

export type ClaimBoundaryDefectCode =
  (typeof CLAIM_BOUNDARY_DEFECT_CODES)[number];

export type EditorDefectSeverity = 'HIGH' | 'MEDIUM' | 'LOW';

interface EditorDefectBase {
  /** Exact substring of the reviewed script. */
  quote: string;
  severity: EditorDefectSeverity;
  note: string;
}

export type TypedEditorDefect = EditorDefectBase & (
  | { kind: 'READING_EXPERIENCE'; code: ReadingExperienceDefectCode }
  | { kind: 'CLAIM_BOUNDARY'; code: ClaimBoundaryDefectCode }
);

export type TypedEditorReviewValidationResult =
  | { ok: true; defects: TypedEditorDefect[] }
  | { ok: false; errorCode: 'AGENT_SCHEMA' | 'AGENT_UNGROUNDED'; reason: string };

export type CombinedGateViolation =
  | {
      source: 'DETERMINISTIC';
      code: GateViolationCode;
      detail: string;
      quote?: string;
    }
  | {
      source: 'CLAIM_BOUNDARY';
      code: AssertionBoundaryViolationCode;
      detail: string;
      quote?: string;
    };

export interface CombinedWriterGateResult {
  passed: boolean;
  deterministic: GateResult;
  claimBoundary: AssertionBoundaryResult;
  violations: CombinedGateViolation[];
}

export type EditorRoute = 'CLEAN' | 'AUTO_REPAIR' | 'FAILED_GATE';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unknownKey(value: Record<string, unknown>, allowed: ReadonlySet<string>): string | null {
  return Object.keys(value).find((key) => !allowed.has(key)) ?? null;
}

const REVIEW_KEYS = new Set(['defects']);
const DEFECT_KEYS = new Set(['kind', 'code', 'quote', 'severity', 'note']);
const SEVERITIES = new Set<EditorDefectSeverity>(['HIGH', 'MEDIUM', 'LOW']);
const READING_CODES = new Set<string>(READING_EXPERIENCE_DEFECT_CODES);
const CLAIM_CODES = new Set<string>(CLAIM_BOUNDARY_DEFECT_CODES);

/** Strict parser for the existing independent EDIT_REVIEW result. */
export function validateTypedEditorReview(
  parsed: unknown,
  script: string,
): TypedEditorReviewValidationResult {
  if (!isRecord(parsed)) {
    return { ok: false, errorCode: 'AGENT_SCHEMA', reason: 'editor output is not an object' };
  }
  const extra = unknownKey(parsed, REVIEW_KEYS);
  if (extra) {
    return { ok: false, errorCode: 'AGENT_SCHEMA', reason: `unknown editor key "${extra}"` };
  }
  if (!Array.isArray(parsed['defects'])) {
    return {
      ok: false,
      errorCode: 'AGENT_SCHEMA',
      reason: 'defects must be an array (use [] when the piece is genuinely clean)',
    };
  }
  const haystack = script.normalize('NFC');
  const defects: TypedEditorDefect[] = [];
  for (const [index, raw] of parsed['defects'].entries()) {
    if (!isRecord(raw)) {
      return { ok: false, errorCode: 'AGENT_SCHEMA', reason: `defects[${index}] must be an object` };
    }
    const defectExtra = unknownKey(raw, DEFECT_KEYS);
    if (defectExtra) {
      return {
        ok: false,
        errorCode: 'AGENT_SCHEMA',
        reason: `unknown defects[${index}] key "${defectExtra}"`,
      };
    }
    const kind = raw['kind'];
    const code = raw['code'];
    const severity = raw['severity'];
    const quote = typeof raw['quote'] === 'string' ? raw['quote'].normalize('NFC').trim() : '';
    const note = typeof raw['note'] === 'string' ? raw['note'].trim() : '';
    if (!quote || !note) {
      return {
        ok: false,
        errorCode: 'AGENT_SCHEMA',
        reason: `defects[${index}] needs a quote and a note`,
      };
    }
    if (!SEVERITIES.has(severity as EditorDefectSeverity)) {
      return {
        ok: false,
        errorCode: 'AGENT_SCHEMA',
        reason: `defects[${index}].severity must be HIGH/MEDIUM/LOW`,
      };
    }
    const codeMatchesKind =
      (kind === 'READING_EXPERIENCE' && typeof code === 'string' && READING_CODES.has(code))
      || (kind === 'CLAIM_BOUNDARY' && typeof code === 'string' && CLAIM_CODES.has(code));
    if (!codeMatchesKind) {
      return {
        ok: false,
        errorCode: 'AGENT_SCHEMA',
        reason: `defects[${index}].code is not allowed for kind "${String(kind)}"`,
      };
    }
    if (!haystack.includes(quote)) {
      return {
        ok: false,
        errorCode: 'AGENT_UNGROUNDED',
        reason:
          `defects[${index}] quotes "${quote.slice(0, 60)}…", which is not an exact substring `
          + 'of the script',
      };
    }
    if (kind === 'READING_EXPERIENCE') {
      defects.push({
        kind,
        code: code as ReadingExperienceDefectCode,
        quote,
        severity: severity as EditorDefectSeverity,
        note,
      });
    } else {
      defects.push({
        kind: 'CLAIM_BOUNDARY',
        code: code as ClaimBoundaryDefectCode,
        quote,
        severity: severity as EditorDefectSeverity,
        note,
      });
    }
  }
  return { ok: true, defects };
}

/** Combine results after the coordinator has called both validators independently. */
export function combineWriterGateResults(
  deterministic: GateResult,
  claimBoundary: AssertionBoundaryResult,
): CombinedWriterGateResult {
  const violations: CombinedGateViolation[] = [
    ...deterministic.violations.map((violation) => ({
      source: 'DETERMINISTIC' as const,
      code: violation.code,
      detail: violation.detail,
      ...(violation.quote ? { quote: violation.quote } : {}),
    })),
    ...claimBoundary.violations.map((violation) => ({
      source: 'CLAIM_BOUNDARY' as const,
      code: violation.code,
      detail: violation.detail,
      ...(violation.quote ? { quote: violation.quote } : {}),
    })),
  ];
  return {
    passed: deterministic.passed && claimBoundary.passed && violations.length === 0,
    deterministic,
    claimBoundary,
    violations,
  };
}

/**
 * Semantic Claim Boundary findings cannot be auto-repaired without a second
 * editor call. Code-computed failures and reading defects keep the existing one
 * repair opportunity because both code validators can run again afterward.
 */
export function routeEditorOutcome(
  gate: CombinedWriterGateResult,
  defects: readonly TypedEditorDefect[],
): EditorRoute {
  if (defects.some((defect) => defect.kind === 'CLAIM_BOUNDARY')) return 'FAILED_GATE';
  if (!gate.passed || defects.length > 0) return 'AUTO_REPAIR';
  return 'CLEAN';
}
