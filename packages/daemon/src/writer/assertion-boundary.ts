/**
 * Writer v2 Claim Boundary (ADR-004).
 *
 * The writer's assertion kind is metadata to verify, never an exemption it can
 * grant itself. This pure module supplies the deterministic floor; semantic
 * empirical claims outside these signals remain the independent editor's job.
 */
import { createHash } from 'node:crypto';
import {
  extractNumericClaims,
  extractProtectedSpecifics,
  extractProperNouns,
  isCommonKnowledgeClaim,
  unauthorizedProtectedSpecifics,
} from './deterministic-gate.ts';
import {
  hasDisputedCaveatLanguage,
  type AuthorizedClaimPermission,
} from './research-map.ts';

export const ASSERTION_BOUNDARY_VERSION = 'writer-assertion-boundary-v1' as const;

export const ASSERTION_KINDS = [
  'FACT',
  'COMMON_KNOWLEDGE',
  'STANCE',
  'HYPOTHETICAL',
  'PERSONA_EXPERIENCE',
] as const;

export type AssertionKind = (typeof ASSERTION_KINDS)[number];

export interface AssertionAnchor {
  id: string;
  /** A unique exact substring of the script. */
  quote: string;
  kind: AssertionKind;
  claimIds?: string[];
  stanceId?: string;
  personaEntryId?: string;
}

export interface ValidatedAssertionAnchor extends AssertionAnchor {
  effectiveKind: AssertionKind;
  start: number;
  end: number;
}

export type PersonaEntryKind = 'STANCE' | 'PERSONA_EXPERIENCE';
export type PersonaEntryStatus = 'APPROVED' | 'PENDING' | 'REJECTED';

export interface PersonaRegistryEntry {
  id: string;
  kind: PersonaEntryKind;
  title: string;
  status: PersonaEntryStatus;
  /** Only channel-owned stance/adapted prose. Original-host source text is excluded. */
  allowedText: string;
  guardrails: string;
}

export interface PersonaRegistryViolation {
  code: 'PERSONA_SCHEMA' | 'PERSONA_DUPLICATE_ID';
  detail: string;
  entryId?: string;
}

export interface PersonaRegistry {
  hash: string;
  entries: PersonaRegistryEntry[];
  violations: PersonaRegistryViolation[];
}

export type AssertionBoundaryViolationCode =
  | 'ASSERTION_SCHEMA'
  | 'ASSERTION_QUOTE_UNGROUNDED'
  | 'ASSERTION_QUOTE_AMBIGUOUS'
  | 'ASSERTION_ORDER'
  | 'ASSERTION_OVERLAP'
  | 'ASSERTION_UNANCHORED'
  | 'ASSERTION_KIND_MISMATCH'
  | 'ASSERTION_METADATA'
  | 'ASSERTION_CLAIM_REQUIRED'
  | 'ASSERTION_CLAIM_UNKNOWN'
  | 'ASSERTION_CLAIM_REJECTED'
  | 'ASSERTION_SPECIFIC_UNAUTHORIZED'
  | 'ASSERTION_DISPUTED_UNQUALIFIED'
  | 'ASSERTION_PERSONA_HASH'
  | 'ASSERTION_PERSONA_REQUIRED'
  | 'ASSERTION_PERSONA_UNKNOWN'
  | 'ASSERTION_PERSONA_PENDING'
  | 'ASSERTION_PERSONA_DETAIL_UNGROUNDED'
  | 'ASSERTION_HYPOTHETICAL_MARKER'
  | 'ASSERTION_HYPOTHETICAL_NAMED';

export interface AssertionBoundaryViolation {
  code: AssertionBoundaryViolationCode;
  detail: string;
  quote?: string;
  anchorId?: string;
}

export interface AssertionBoundaryInput {
  script: string;
  assertionAnchors: unknown;
  permissions: readonly AuthorizedClaimPermission[];
  personaRegistry?: PersonaRegistry;
  /** Hash pinned when Persona Pack was staged for WRITE. */
  pinnedPersonaPackHash?: string;
}

export interface AssertionBoundaryResult {
  passed: boolean;
  anchors: ValidatedAssertionAnchor[];
  violations: AssertionBoundaryViolation[];
}

export interface ClaimBoundaryReviewIndex {
  contractVersion: typeof ASSERTION_BOUNDARY_VERSION;
  claims: AuthorizedClaimPermission[];
  stances: Array<{ id: string; text: string }>;
  experiences: Array<{ id: string; text: string; guardrails: string }>;
  priorityRule: string;
}

const ANCHOR_KEYS = new Set(['id', 'quote', 'kind', 'claimIds', 'stanceId', 'personaEntryId']);
const ANCHOR_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const MIN_ANCHOR_LENGTH = 8;

const HYPOTHETICAL_MARKERS = [
  'giả sử',
  'giả dụ',
  'giả định',
  'ví dụ',
  'thử hình dung',
  'hình dung thử',
  'tạm lấy',
  'tạm tính',
  'cho dễ hình dung',
];

const STANCE_MARKERS = [
  'theo tôi',
  'tôi tin',
  'với tôi',
  'đối với tôi',
  'quan điểm của tôi',
  'tôi chọn',
  'tôi ưu tiên',
  'tôi không tin',
  'tôi thiên về',
];

const NORMATIVE_STANCE_MARKERS = [
  'tôi chọn',
  'tôi ưu tiên',
  'tôi đặt ngưỡng',
  'tôi thiên về',
  'theo tôi nên',
  'với tôi nên',
];

const PERSONA_EXPERIENCE_RE = /(?:\b(?:tôi|mình)\s+(?:đã|từng)\b|\bnăm ngoái\s+tôi\b|\bngười bạn của tôi\b|\btôi có một người bạn\b|\bmỗi lần tôi hỏi\b)/giu;

const SOURCE_EMPIRICAL_RE = /\b(?:nghiên cứu|khảo sát|dữ liệu|thống kê|báo cáo)\b/giu;
const GENERALIZATION_RES = [
  /\b(?:phần lớn|đa số|hầu hết)\b/giu,
  /\b(?:an toàn|hiệu quả|sinh lời|rủi ro|ổn định|tốt|xấu|cao|thấp)\s+hơn\b/giu,
  /\b(?:luôn|thường)\b[^.!?…\n]{0,100}\b(?:hơn|dẫn đến|khiến|làm tăng|làm giảm)\b/giu,
] as const;

function hashPersona(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textBetween(section: string, start: RegExp, end?: RegExp): string {
  const startMatch = start.exec(section);
  if (!startMatch || startMatch.index === undefined) return '';
  const from = startMatch.index + startMatch[0].length;
  const tail = section.slice(from);
  const endMatch = end?.exec(tail);
  const value = endMatch && endMatch.index !== undefined ? tail.slice(0, endMatch.index) : tail;
  return value.trim();
}

interface PersonaParsedEntry extends PersonaRegistryEntry {
  /** Exact span of this entry's own section in the normalized markdown —
   * used only by `filterApprovedPersonaMarkdown` to re-slice verbatim text.
   * Not part of the public `PersonaRegistry` shape. */
  start: number;
  end: number;
}

/**
 * Shared scan behind `parsePersonaRegistry` and `filterApprovedPersonaMarkdown`.
 * Parses only channel-owned material from Persona Pack. For stances, source
 * transcript quotes and “chuẩn chung” stay outside allowedText. For experience
 * archetypes, “Bản gốc” is excluded; only “Phóng tác” may authorize first-person
 * detail.
 */
function parsePersonaSections(markdown: string): {
  normalized: string;
  entries: PersonaParsedEntry[];
  violations: PersonaRegistryViolation[];
  /** Offset where the first entry heading starts — everything before it is
   * the file's shared preamble (title, house rules, section intros). */
  preambleEnd: number;
} {
  const normalized = markdown.normalize('NFC');
  const headings = [...normalized.matchAll(/^###\s+(1\.\d+|A\d+)\.?\s+(.+)$/gmu)];
  const entries: PersonaParsedEntry[] = [];
  const violations: PersonaRegistryViolation[] = [];
  const seen = new Set<string>();
  const preambleEnd = headings[0]?.index ?? normalized.length;

  for (const [index, match] of headings.entries()) {
    const code = match[1]!;
    const heading = match[2]!.trim();
    const start = match.index!;
    const nextEntry = headings[index + 1]?.index ?? normalized.length;
    const afterHeading = start + match[0].length;
    const nextH2 = normalized.slice(afterHeading).match(/^##(?!#)\s+.+$/mu);
    const nextH2Index = nextH2?.index === undefined ? normalized.length : afterHeading + nextH2.index;
    const end = Math.min(nextEntry, nextH2Index);
    const section = normalized.slice(start, end);
    const isStance = code.startsWith('1.');
    const id = isStance ? `stance-${code}` : `experience-${code}`;
    if (seen.has(id)) {
      const existing = entries.find((entry) => entry.id === id);
      if (existing) existing.status = 'REJECTED';
      violations.push({
        code: 'PERSONA_DUPLICATE_ID',
        detail: `duplicate persona entry "${id}"; the colliding ID is ineligible`,
        entryId: id,
      });
      continue;
    }
    seen.add(id);

    const pending = /\[CHỜ CHỦ KÊNH DUYỆT\]/iu.test(section);
    const rejected = /\[(?:TỪ CHỐI|REJECTED)\]/iu.test(section);
    const explicitlyApproved = /\[(?:ĐÃ DUYỆT|APPROVED)\]/iu.test(section);
    // Fail-closed for BOTH entry kinds (eng review 2026-09-02). Earlier this
    // only applied to STANCE — an experience with no marker at all defaulted
    // to APPROVED, i.e. file presence alone granted narrator permission. Now
    // an entry of either kind is APPROVED only with an explicit
    // [ĐÃ DUYỆT]/[APPROVED] marker in its own section; no marker, or an
    // explicit [CHỜ CHỦ KÊNH DUYỆT], both leave it PENDING until the channel
    // owner marks it.
    const status: PersonaEntryStatus = rejected
      ? 'REJECTED'
      : pending || !explicitlyApproved
      ? 'PENDING'
      : 'APPROVED';
    const allowedText = isStance
      ? textBetween(section, /\*\*Lập trường kênh\*\*\s*:/iu, /(?:\n>\s|\n\*\*[^*]+\*\*)/u)
      : textBetween(section, /\*\*Phóng tác\*\*(?:\s*\([^)]*\))?\s*:/iu, /\n\*\*Ghi chú khi dùng\*\*/iu);
    const guardrails = isStance
      ? ''
      : textBetween(section, /\*\*Ghi chú khi dùng\*\*\s*:/iu, /\n(?:---|##(?!#)\s)/u);
    if (!allowedText) {
      violations.push({
        code: 'PERSONA_SCHEMA',
        detail: `${id} has no parseable ${isStance ? 'Lập trường kênh' : 'Phóng tác'} block`,
        entryId: id,
      });
    }
    entries.push({
      id,
      kind: isStance ? 'STANCE' : 'PERSONA_EXPERIENCE',
      title: heading.replace(/\s+—\s+`?\[[^\]]+\]`?\s*$/u, '').trim(),
      status: allowedText ? status : 'REJECTED',
      allowedText,
      guardrails,
      start,
      end,
    });
  }

  return { normalized, entries, violations, preambleEnd };
}

export function parsePersonaRegistry(markdown: string): PersonaRegistry {
  const { entries, violations } = parsePersonaSections(markdown);
  return {
    hash: hashPersona(markdown),
    entries: entries.map(({ start: _start, end: _end, ...entry }) => entry),
    violations,
  };
}

export interface FilteredPersonaPack {
  markdown: string;
  approvedCount: number;
  /**
   * The APPROVED entries' `allowedText` blocks only, joined — i.e. the channel's
   * own stance sentences and Phóng tác bodies, WITHOUT the `**Chuẩn chung**`
   * contrast block, without the transcript blockquotes, without the preamble and
   * vocabulary tail.
   *
   * `markdown` and this field answer two different questions, and conflating them
   * was a real permission bug (CEO review 2026-09-03, RC1). `markdown` is what the
   * model may READ: the Chuẩn chung block belongs there, because "thường thì X,
   * nhưng tôi Y" is the whole point of a deliberately off-standard stance. This
   * field is what the model may CITE: approving cell 1.1 must not turn the
   * industry figure the channel is arguing AGAINST ("3-6 tháng") into a grounded
   * number the script can state unsourced.
   */
  citableText: string;
}

/**
 * Reduce a persona pack to the only material that may ever reach the model:
 * the file's shared preamble (everything before the first entry heading),
 * each entry whose status is APPROVED (verbatim, marker included), and
 * everything after the LAST entry section — the personal-vocabulary block,
 * which is phrasing, not a claim, and carries no approval status of its own.
 * PENDING and REJECTED entries are dropped entirely; a run must never see
 * them just because the file happens to still contain them.
 *
 * The preamble and tail keep their prose but LOSE their `>` blockquote lines:
 * those are transcript example quotes, and after gate decision 1A anything in
 * this filtered markdown becomes a valid grounding source for numbers/proper
 * nouns — an unapproved "50 triệu" in a vocabulary example must not silently
 * license that figure in a script. Quotes inside an APPROVED entry stay:
 * approving the entry approved its evidence.
 *
 * Returns `null` when zero entries are APPROVED. Every caller (WRITE staging,
 * the deterministic gate) must then behave exactly as if there were no
 * persona pack file at all — this is the fail-closed rule T2 exists for:
 * a file sitting on disk grants no permission by itself.
 */
export function filterApprovedPersonaMarkdown(markdown: string): FilteredPersonaPack | null {
  const { normalized, entries, preambleEnd } = parsePersonaSections(markdown);
  const approved = entries.filter((entry) => entry.status === 'APPROVED');
  if (approved.length === 0) return null;
  const preamble = stripBlockquotes(normalized.slice(0, preambleEnd)).trim();
  const tailStart = entries.at(-1)!.end;
  const tail = stripBlockquotes(normalized.slice(tailStart)).trim();
  const body = approved.map((entry) => normalized.slice(entry.start, entry.end).trim()).join('\n\n');
  const citableText = approved.map((entry) => entry.allowedText.trim()).filter(Boolean).join('\n\n');
  return {
    markdown: [preamble, body, tail].filter(Boolean).join('\n\n'),
    approvedCount: approved.length,
    citableText,
  };
}

function stripBlockquotes(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n');
}

function lower(text: string): string {
  return text.toLocaleLowerCase('vi');
}

function includesMarker(text: string, markers: readonly string[]): boolean {
  const value = lower(text);
  return markers.some((marker) => value.includes(marker));
}

function patternMatches(pattern: RegExp, text: string): boolean {
  return new RegExp(pattern.source, pattern.flags.replaceAll('g', '')).test(text);
}

function hasPersonaExperienceSignal(text: string): boolean {
  return patternMatches(PERSONA_EXPERIENCE_RE, text);
}

function hasSourceEmpiricalSignal(text: string): boolean {
  return patternMatches(SOURCE_EMPIRICAL_RE, text);
}

function hasGeneralizationSignal(text: string): boolean {
  return GENERALIZATION_RES.some((pattern) => patternMatches(pattern, text));
}

function exactOccurrences(haystack: string, needle: string): number[] {
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return out;
    out.push(at);
    from = at + 1;
  }
}

function uniqueStrings(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim() || !ANCHOR_ID_RE.test(item.trim())) return null;
    out.push(item.trim());
  }
  return new Set(out).size === out.length ? out : null;
}

function optionalId(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !ANCHOR_ID_RE.test(value.trim())) return null;
  return value.trim();
}

function sameNumericClaims(left: string, right: string): boolean {
  const allowed = extractNumericClaims(right);
  const ordinaryClaimsMatch = extractNumericClaims(left).every((claim) =>
    allowed.some((candidate) => candidate.value === claim.value && candidate.unit === claim.unit)
  );
  if (!ordinaryClaimsMatch) return false;
  return unauthorizedProtectedSpecifics(left, [right])
    .every((specific) => specific.kind !== 'NUMERIC');
}

function normalizedContains(haystack: string, needle: string): boolean {
  return lower(haystack).includes(lower(needle));
}

function stanceAllowsNumericThreshold(quote: string, entry: PersonaRegistryEntry | undefined): boolean {
  if (!entry || entry.status !== 'APPROVED' || entry.kind !== 'STANCE') return false;
  if (!includesMarker(quote, NORMATIVE_STANCE_MARKERS)) return false;
  return sameNumericClaims(quote, entry.allowedText);
}

function commonKnowledgeAnchor(quote: string): boolean {
  const claims = extractNumericClaims(quote);
  if (claims.length === 0) return false;
  if (hasSourceEmpiricalSignal(quote) || hasGeneralizationSignal(quote)) return false;
  return claims.every((claim) => isCommonKnowledgeClaim(claim, claim.sentence));
}

function effectiveKind(
  anchor: AssertionAnchor,
  personaEntry: PersonaRegistryEntry | undefined,
): AssertionKind {
  const quote = anchor.quote;
  const names = extractProperNouns(quote);
  const numbers = extractNumericClaims(quote);
  const protectedNumbers = extractProtectedSpecifics(quote)
    .filter((specific) => specific.kind === 'NUMERIC');
  if (hasPersonaExperienceSignal(quote)) return 'PERSONA_EXPERIENCE';
  if (
    includesMarker(quote, HYPOTHETICAL_MARKERS)
    && names.length === 0
    && !hasSourceEmpiricalSignal(quote)
  ) {
    return 'HYPOTHETICAL';
  }
  if (
    anchor.kind === 'STANCE'
    && (numbers.length > 0 || protectedNumbers.length > 0)
    && stanceAllowsNumericThreshold(quote, personaEntry)
  ) {
    return 'STANCE';
  }
  if (anchor.kind === 'COMMON_KNOWLEDGE' && names.length === 0 && commonKnowledgeAnchor(quote)) {
    return 'COMMON_KNOWLEDGE';
  }
  if (
    numbers.length > 0
    || protectedNumbers.length > 0
    || names.length > 0
    || hasSourceEmpiricalSignal(quote)
    || hasGeneralizationSignal(quote)
  ) {
    return 'FACT';
  }
  return anchor.kind;
}

function covered(
  start: number,
  end: number,
  anchors: readonly ValidatedAssertionAnchor[],
): boolean {
  return anchors.some((anchor) => anchor.start <= start && anchor.end >= end);
}

interface ProtectedSpan {
  start: number;
  end: number;
  quote: string;
  reason: string;
}

function addLiteralSpans(
  spans: ProtectedSpan[],
  script: string,
  literal: string,
  reason: string,
): void {
  for (const start of exactOccurrences(script, literal)) {
    spans.push({ start, end: start + literal.length, quote: literal, reason });
  }
}

function protectedSpans(script: string): ProtectedSpan[] {
  const spans: ProtectedSpan[] = [];
  for (const claim of extractNumericClaims(script)) {
    addLiteralSpans(spans, script, claim.raw, 'numeric claim');
  }
  // `extractNumericClaims` intentionally ignores a single numeral word (for
  // example "một năm") to avoid over-classifying ordinary prose. Protected
  // money/age/multiple forms such as "một tỷ" still need whole-script coverage;
  // otherwise omitting the FACT anchor would turn declaration into authority.
  for (const specific of extractProtectedSpecifics(script)) {
    if (specific.kind !== 'NUMERIC') continue;
    addLiteralSpans(spans, script, specific.raw, 'protected numeric claim');
  }
  for (const { name } of extractProperNouns(script)) {
    addLiteralSpans(spans, script, name, 'proper noun');
  }
  const patterns = [PERSONA_EXPERIENCE_RE, SOURCE_EMPIRICAL_RE, ...GENERALIZATION_RES];
  for (const pattern of patterns) {
    const globalPattern = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    for (const match of script.matchAll(globalPattern)) {
      if (match.index === undefined || !match[0]) continue;
      spans.push({
        start: match.index,
        end: match.index + match[0].length,
        quote: match[0],
        reason: pattern === PERSONA_EXPERIENCE_RE ? 'persona experience' : 'empirical claim',
      });
    }
  }
  const seen = new Set<string>();
  return spans
    .filter((span) => {
      const key = `${span.start}:${span.end}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

function personaEntryFor(
  anchor: AssertionAnchor,
  registry: PersonaRegistry | undefined,
): PersonaRegistryEntry | undefined {
  const id = anchor.kind === 'STANCE' ? anchor.stanceId : anchor.personaEntryId;
  return id ? registry?.entries.find((entry) => entry.id === id) : undefined;
}

function validatePersonaDetail(
  anchor: ValidatedAssertionAnchor,
  entry: PersonaRegistryEntry,
  violations: AssertionBoundaryViolation[],
): void {
  if (!sameNumericClaims(anchor.quote, entry.allowedText)) {
    violations.push({
      code: 'ASSERTION_PERSONA_DETAIL_UNGROUNDED',
      detail: `numeric detail in persona experience is absent from ${entry.id} allowed Phóng tác text`,
      quote: anchor.quote,
      anchorId: anchor.id,
    });
  }
  for (const { name } of extractProperNouns(anchor.quote)) {
    if (normalizedContains(entry.allowedText, name)) continue;
    violations.push({
      code: 'ASSERTION_PERSONA_DETAIL_UNGROUNDED',
      detail: `proper noun "${name}" is absent from ${entry.id} allowed Phóng tác text`,
      quote: anchor.quote,
      anchorId: anchor.id,
    });
  }
}

export function validateAssertionBoundary(input: AssertionBoundaryInput): AssertionBoundaryResult {
  const script = input.script.normalize('NFC');
  const violations: AssertionBoundaryViolation[] = [];
  const parsed: ValidatedAssertionAnchor[] = [];
  const seenIds = new Set<string>();

  if (!Array.isArray(input.assertionAnchors) || input.assertionAnchors.length > 256) {
    return {
      passed: false,
      anchors: [],
      violations: [{ code: 'ASSERTION_SCHEMA', detail: 'assertionAnchors must be an array with at most 256 entries' }],
    };
  }

  for (const [index, raw] of input.assertionAnchors.entries()) {
    if (!isRecord(raw)) {
      violations.push({ code: 'ASSERTION_SCHEMA', detail: `assertionAnchors[${index}] must be an object` });
      continue;
    }
    const extra = Object.keys(raw).find((key) => !ANCHOR_KEYS.has(key));
    if (extra) {
      violations.push({
        code: 'ASSERTION_SCHEMA',
        detail: `assertionAnchors[${index}] has unknown key "${extra}"`,
      });
    }
    const id = typeof raw['id'] === 'string' ? raw['id'].trim() : '';
    if (!ANCHOR_ID_RE.test(id) || seenIds.has(id)) {
      violations.push({
        code: 'ASSERTION_SCHEMA',
        detail: `assertionAnchors[${index}].id must be unique and match ${ANCHOR_ID_RE.source}`,
        ...(id ? { anchorId: id } : {}),
      });
      continue;
    }
    seenIds.add(id);
    const quote = typeof raw['quote'] === 'string' ? raw['quote'].normalize('NFC').trim() : '';
    if (quote.length < MIN_ANCHOR_LENGTH) {
      violations.push({
        code: 'ASSERTION_SCHEMA',
        detail: `anchor "${id}" quote must contain at least ${MIN_ANCHOR_LENGTH} characters`,
        anchorId: id,
      });
      continue;
    }
    const occurrences = exactOccurrences(script, quote);
    if (occurrences.length === 0) {
      violations.push({
        code: 'ASSERTION_QUOTE_UNGROUNDED',
        detail: `anchor "${id}" is not an exact substring of the script`,
        quote,
        anchorId: id,
      });
      continue;
    }
    if (occurrences.length > 1) {
      violations.push({
        code: 'ASSERTION_QUOTE_AMBIGUOUS',
        detail: `anchor "${id}" occurs ${occurrences.length} times; expand it until unique`,
        quote,
        anchorId: id,
      });
      continue;
    }
    if (!ASSERTION_KINDS.includes(raw['kind'] as AssertionKind)) {
      violations.push({
        code: 'ASSERTION_SCHEMA',
        detail: `anchor "${id}" kind must be one of ${ASSERTION_KINDS.join(', ')}`,
        anchorId: id,
      });
      continue;
    }
    const claimIds = uniqueStrings(raw['claimIds']);
    const stanceId = optionalId(raw['stanceId']);
    const personaEntryId = optionalId(raw['personaEntryId']);
    if (claimIds === null || stanceId === null || personaEntryId === null) {
      violations.push({
        code: 'ASSERTION_SCHEMA',
        detail: `anchor "${id}" has invalid provenance IDs`,
        anchorId: id,
      });
      continue;
    }
    const anchor: AssertionAnchor = {
      id,
      quote,
      kind: raw['kind'] as AssertionKind,
      ...(claimIds.length ? { claimIds } : {}),
      ...(stanceId ? { stanceId } : {}),
      ...(personaEntryId ? { personaEntryId } : {}),
    };
    const personaEntry = personaEntryFor(anchor, input.personaRegistry);
    const start = occurrences[0]!;
    parsed.push({
      ...anchor,
      effectiveKind: effectiveKind(anchor, personaEntry),
      start,
      end: start + quote.length,
    });
  }

  let previous: ValidatedAssertionAnchor | undefined;
  for (const anchor of parsed) {
    if (previous && anchor.start < previous.start) {
      violations.push({
        code: 'ASSERTION_ORDER',
        detail: `anchor "${anchor.id}" appears before "${previous.id}" in the script`,
        anchorId: anchor.id,
      });
    }
    if (previous && anchor.start < previous.end) {
      violations.push({
        code: 'ASSERTION_OVERLAP',
        detail: `anchor "${anchor.id}" partially overlaps "${previous.id}"`,
        anchorId: anchor.id,
      });
    }
    previous = anchor;
  }

  const permissionById = new Map<string, AuthorizedClaimPermission>();
  for (const permission of input.permissions) {
    if (permissionById.has(permission.claimId)) {
      violations.push({
        code: 'ASSERTION_SCHEMA',
        detail: `duplicate authorized claim permission "${permission.claimId}"`,
      });
      continue;
    }
    if ((permission.status as string) === 'REJECTED') {
      violations.push({
        code: 'ASSERTION_CLAIM_REJECTED',
        detail: `REJECTED claim "${permission.claimId}" cannot appear in authorized permissions`,
      });
      continue;
    }
    permissionById.set(permission.claimId, permission);
  }
  for (const anchor of parsed) {
    if (anchor.kind === 'HYPOTHETICAL' && extractProperNouns(anchor.quote).length > 0) {
      violations.push({
        code: 'ASSERTION_HYPOTHETICAL_NAMED',
        detail: `HYPOTHETICAL anchor "${anchor.id}" must keep its actor unnamed`,
        quote: anchor.quote,
        anchorId: anchor.id,
      });
    }
    if (anchor.effectiveKind !== anchor.kind) {
      violations.push({
        code: 'ASSERTION_KIND_MISMATCH',
        detail: `anchor "${anchor.id}" declared ${anchor.kind} but deterministic priority makes it ${anchor.effectiveKind}`,
        quote: anchor.quote,
        anchorId: anchor.id,
      });
    }

    if (anchor.effectiveKind === 'FACT') {
      if (!anchor.claimIds?.length) {
        violations.push({
          code: 'ASSERTION_CLAIM_REQUIRED',
          detail: `FACT anchor "${anchor.id}" needs at least one authorized claimId`,
          quote: anchor.quote,
          anchorId: anchor.id,
        });
      }
      const citedPermissions: AuthorizedClaimPermission[] = [];
      for (const claimId of anchor.claimIds ?? []) {
        const permission = permissionById.get(claimId);
        if (!permission) {
          violations.push({
            code: 'ASSERTION_CLAIM_UNKNOWN',
            detail: `anchor "${anchor.id}" references claim "${claimId}" outside the code-derived permission list`,
            anchorId: anchor.id,
          });
          continue;
        }
        citedPermissions.push(permission);
        if (permission.status === 'DISPUTED' && !hasDisputedCaveatLanguage(anchor.quote)) {
          violations.push({
            code: 'ASSERTION_DISPUTED_UNQUALIFIED',
            detail: `anchor "${anchor.id}" uses DISPUTED claim "${claimId}" without visible caveat`,
            quote: anchor.quote,
            anchorId: anchor.id,
          });
        }
      }
      if (citedPermissions.length > 0) {
        const unauthorizedSpecifics = unauthorizedProtectedSpecifics(
          anchor.quote,
          citedPermissions.flatMap((permission) => permission.quotes),
        );
        if (unauthorizedSpecifics.length > 0) {
          violations.push({
            code: 'ASSERTION_SPECIFIC_UNAUTHORIZED',
            detail:
              `FACT anchor "${anchor.id}" contains specifics absent from its selected exact quotes: `
              + unauthorizedSpecifics.map((specific) => `${specific.kind}:${specific.raw}`).join(', '),
            quote: anchor.quote,
            anchorId: anchor.id,
          });
        }
      }
      if (anchor.stanceId || anchor.personaEntryId) {
        violations.push({
          code: 'ASSERTION_METADATA',
          detail: `FACT anchor "${anchor.id}" may not use stance/persona IDs as factual provenance`,
          anchorId: anchor.id,
        });
      }
      continue;
    }

    if (anchor.effectiveKind === 'STANCE') {
      if (anchor.claimIds?.length || anchor.personaEntryId) {
        violations.push({
          code: 'ASSERTION_METADATA',
          detail: `STANCE anchor "${anchor.id}" may only carry stanceId`,
          anchorId: anchor.id,
        });
      }
      if (!anchor.stanceId) {
        violations.push({
          code: 'ASSERTION_PERSONA_REQUIRED',
          detail: `STANCE anchor "${anchor.id}" needs an approved stanceId`,
          anchorId: anchor.id,
        });
        continue;
      }
      const entry = input.personaRegistry?.entries.find((candidate) => candidate.id === anchor.stanceId);
      validatePersonaReference(anchor, entry, 'STANCE', input, violations);
      continue;
    }

    if (anchor.effectiveKind === 'PERSONA_EXPERIENCE') {
      if (anchor.claimIds?.length || anchor.stanceId) {
        violations.push({
          code: 'ASSERTION_METADATA',
          detail: `PERSONA_EXPERIENCE anchor "${anchor.id}" may only carry personaEntryId`,
          anchorId: anchor.id,
        });
      }
      if (!anchor.personaEntryId) {
        violations.push({
          code: 'ASSERTION_PERSONA_REQUIRED',
          detail: `PERSONA_EXPERIENCE anchor "${anchor.id}" needs an approved personaEntryId`,
          quote: anchor.quote,
          anchorId: anchor.id,
        });
        continue;
      }
      const entry = input.personaRegistry?.entries.find((candidate) => candidate.id === anchor.personaEntryId);
      if (validatePersonaReference(anchor, entry, 'PERSONA_EXPERIENCE', input, violations) && entry) {
        validatePersonaDetail(anchor, entry, violations);
      }
      continue;
    }

    if (anchor.effectiveKind === 'HYPOTHETICAL') {
      if (anchor.claimIds?.length || anchor.stanceId || anchor.personaEntryId) {
        violations.push({
          code: 'ASSERTION_METADATA',
          detail: `HYPOTHETICAL anchor "${anchor.id}" may not carry provenance IDs`,
          anchorId: anchor.id,
        });
      }
      if (!includesMarker(anchor.quote, HYPOTHETICAL_MARKERS)) {
        violations.push({
          code: 'ASSERTION_HYPOTHETICAL_MARKER',
          detail: `HYPOTHETICAL anchor "${anchor.id}" needs a visible hypothetical marker`,
          quote: anchor.quote,
          anchorId: anchor.id,
        });
      }
      if (extractProperNouns(anchor.quote).length > 0) {
        violations.push({
          code: 'ASSERTION_HYPOTHETICAL_NAMED',
          detail: `HYPOTHETICAL anchor "${anchor.id}" must keep its actor unnamed`,
          quote: anchor.quote,
          anchorId: anchor.id,
        });
      }
      continue;
    }

    if (anchor.claimIds?.length || anchor.stanceId || anchor.personaEntryId) {
      violations.push({
        code: 'ASSERTION_METADATA',
        detail: `COMMON_KNOWLEDGE anchor "${anchor.id}" may not carry provenance IDs`,
        anchorId: anchor.id,
      });
    }
  }

  for (const span of protectedSpans(script)) {
    if (covered(span.start, span.end, parsed)) continue;
    violations.push({
      code: 'ASSERTION_UNANCHORED',
      detail: `${span.reason} is not covered by any exact assertionAnchor`,
      quote: span.quote,
    });
  }

  return { passed: violations.length === 0, anchors: parsed, violations };
}

function validatePersonaReference(
  anchor: ValidatedAssertionAnchor,
  entry: PersonaRegistryEntry | undefined,
  expectedKind: PersonaEntryKind,
  input: AssertionBoundaryInput,
  violations: AssertionBoundaryViolation[],
): boolean {
  if (!input.personaRegistry || !input.pinnedPersonaPackHash) {
    violations.push({
      code: 'ASSERTION_PERSONA_HASH',
      detail: `${expectedKind} anchor "${anchor.id}" has no pinned Persona Pack`,
      anchorId: anchor.id,
    });
    return false;
  }
  if (input.personaRegistry.hash !== input.pinnedPersonaPackHash) {
    violations.push({
      code: 'ASSERTION_PERSONA_HASH',
      detail: `Persona Pack hash mismatch for anchor "${anchor.id}"`,
      anchorId: anchor.id,
    });
    return false;
  }
  if (!entry || entry.kind !== expectedKind) {
    const id = expectedKind === 'STANCE' ? anchor.stanceId : anchor.personaEntryId;
    violations.push({
      code: 'ASSERTION_PERSONA_UNKNOWN',
      detail: `anchor "${anchor.id}" references unknown ${expectedKind} entry "${id ?? ''}"`,
      anchorId: anchor.id,
    });
    return false;
  }
  if (entry.status !== 'APPROVED') {
    violations.push({
      code: 'ASSERTION_PERSONA_PENDING',
      detail: `${entry.id} is ${entry.status}; file presence does not grant narrator permission`,
      anchorId: anchor.id,
    });
    return false;
  }
  return true;
}

/** Compact evidence/identity index for the existing independent EDIT_REVIEW call. */
export function buildClaimBoundaryReviewIndex(input: {
  permissions: readonly AuthorizedClaimPermission[];
  personaRegistry?: PersonaRegistry;
}): ClaimBoundaryReviewIndex {
  const eligible = input.personaRegistry?.entries.filter((entry) => entry.status === 'APPROVED') ?? [];
  return {
    contractVersion: ASSERTION_BOUNDARY_VERSION,
    claims: input.permissions.map((permission) => ({
      ...permission,
      caveats: [...permission.caveats],
      evidenceIds: [...permission.evidenceIds],
      quotes: [...permission.quotes],
    })),
    stances: eligible
      .filter((entry) => entry.kind === 'STANCE')
      .map((entry) => ({ id: entry.id, text: entry.allowedText })),
    experiences: eligible
      .filter((entry) => entry.kind === 'PERSONA_EXPERIENCE')
      .map((entry) => ({ id: entry.id, text: entry.allowedText, guardrails: entry.guardrails })),
    priorityRule: 'A factual detector is never overridden by a stance or beat-kind marker.',
  };
}

export function formatAssertionBoundaryViolations(
  violations: readonly AssertionBoundaryViolation[],
): string {
  return violations
    .map((violation) =>
      `- [${violation.code}] ${violation.detail}${violation.quote ? `\n    …${violation.quote}…` : ''}`
    )
    .join('\n');
}
