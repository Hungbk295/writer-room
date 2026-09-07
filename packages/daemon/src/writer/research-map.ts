/**
 * Writer v2 STUDY / RESEARCH contract.
 *
 * This module is deliberately pure: it validates the agent-produced evidence
 * map against a pinned Topic Pack, but it does not know hooks, hypotheses, or
 * story order. Keeping those concepts out of the type is part of the blindness
 * boundary, not merely a prompt instruction.
 */
import {
  unauthorizedProtectedSpecifics,
  type LedgerEntry,
} from './deterministic-gate.ts';
import { videoSectionsFromMarkdown } from '../writer-packs.ts';

export const RESEARCH_MAP_SCHEMA_VERSION = 'writer-research-map-v1' as const;
export const RESEARCH_PROMPT_VERSION = 'writer-v2-research-v1' as const;
export const MAX_RESEARCH_MAP_BYTES = 60 * 1024;

export const RESEARCH_STATUSES = [
  'ATTESTED',
  'MULTI_SOURCE_ATTESTED',
  'DISPUTED',
  'REJECTED',
] as const;

export type ResearchStatus = (typeof RESEARCH_STATUSES)[number];

export const RESEARCH_EVIDENCE_RELATIONS = [
  'SUPPORTS',
  'CONTRADICTS',
  'QUALIFIES',
] as const;

export type ResearchEvidenceRelation = (typeof RESEARCH_EVIDENCE_RELATIONS)[number];

/**
 * Deliberately narrow, shared vocabulary for a visible DISPUTED qualification.
 * Additions change both planning and final-script permission, so they must be
 * made here with cross-layer fixtures rather than independently in consumers.
 */
export const DISPUTED_CAVEAT_MARKERS = [
  'nhưng',
  'mặt khác',
  'tranh cãi',
  'chưa rõ',
  'không thống nhất',
  'có thể',
  'không phải lúc nào',
] as const;

export function hasDisputedCaveatLanguage(text: string): boolean {
  const normalized = text.normalize('NFC').toLocaleLowerCase('vi');
  return DISPUTED_CAVEAT_MARKERS.some((marker) => normalized.includes(marker));
}

export interface ResearchSourceAudit {
  videoId: string;
  mainClaim: string;
  angle: string;
  /** Same value means “do not count these videos as independent support.” */
  originGroup: string;
  limitations: string[];
}

export interface ResearchEvidence {
  id: string;
  claimId: string;
  videoId: string;
  /** Exact substring of the corresponding video section in the Topic Pack. */
  quote: string;
  relation: ResearchEvidenceRelation;
}

export interface ResearchClaim {
  id: string;
  text: string;
  status: ResearchStatus;
  evidenceIds: string[];
  independentOriginGroups: string[];
  caveats: string[];
}

export interface ResearchConflict {
  claimIds: string[];
  explanation: string;
}

export interface ResearchMap {
  schemaVersion: typeof RESEARCH_MAP_SCHEMA_VERSION;
  sourceAudit: ResearchSourceAudit[];
  claims: ResearchClaim[];
  evidence: ResearchEvidence[];
  conflicts: ResearchConflict[];
  openQuestions: string[];
  overusedAngles: string[];
}

/**
 * Model-authored shape before validation. Provenance fields are deliberately
 * absent: when application code already knows an answer, asking a model to
 * repeat it and then comparing the repetition only creates retry risk. The
 * validator hydrates both fields into the validated `ResearchMap` above.
 */
export type ResearchMapAgentOutput = Omit<ResearchMap, 'sourceAudit' | 'claims'> & {
  sourceAudit: Array<Omit<ResearchSourceAudit, 'originGroup'>>;
  claims: Array<Omit<ResearchClaim, 'independentOriginGroups'>>;
};

export type AuthorizedResearchStatus = Exclude<ResearchStatus, 'REJECTED'>;

/**
 * Capability derived by application code from CONFRONT-selected evidence.
 * It is never accepted from model output and intentionally contains only the
 * exact quotes selected for this run, not every quote in ResearchMap.
 */
export interface AuthorizedClaimPermission {
  claimId: string;
  text: string;
  status: AuthorizedResearchStatus;
  caveats: string[];
  evidenceIds: string[];
  quotes: string[];
}

export type ResearchMapErrorCode =
  | 'RESEARCH_SCHEMA'
  | 'RESEARCH_FORBIDDEN_TOPOLOGY'
  | 'RESEARCH_ARTIFACT_OVERSIZE'
  | 'RESEARCH_SOURCE_AUDIT'
  | 'RESEARCH_SOURCE_GROUNDING'
  | 'RESEARCH_REFERENCE'
  | 'RESEARCH_ORIGIN'
  | 'RESEARCH_CLAIM_SPECIFIC'
  | 'RESEARCH_STATUS';

export interface ResearchMapValidationError {
  ok: false;
  errorCode: ResearchMapErrorCode;
  reason: string;
  path?: string;
}

export type ResearchMapValidationResult =
  | { ok: true; researchMap: ResearchMap }
  | ResearchMapValidationError;

export interface ResearchMapValidationContext {
  packMarkdown: string;
  videoIds: readonly string[];
  /** Trusted provenance supplied by the coordinator, never inferred by the agent. */
  originGroupByVideoId?: Readonly<Record<string, string>>;
  maxBytes?: number;
}

const TOP_LEVEL_KEYS = new Set([
  'schemaVersion',
  'sourceAudit',
  'claims',
  'evidence',
  'conflicts',
  'openQuestions',
  'overusedAngles',
]);
const SOURCE_AUDIT_KEYS = new Set(['videoId', 'mainClaim', 'angle', 'limitations']);
const CLAIM_KEYS = new Set(['id', 'text', 'status', 'evidenceIds', 'caveats']);
const EVIDENCE_KEYS = new Set(['id', 'claimId', 'videoId', 'quote', 'relation']);
const CONFLICT_KEYS = new Set(['claimIds', 'explanation']);

const FORBIDDEN_TOPOLOGY_KEYS = new Set([
  'outline',
  'hook',
  'selectedhook',
  'thesis',
  'thesishypothesis',
  'beat',
  'beats',
  'beatorder',
  'intro',
  'introduction',
  'ending',
  'payoff',
  'narration',
  'script',
  'story',
  'storyspine',
  'spine',
  'recommendation',
  'recommendedstory',
  'memoryanchor',
  'progression',
  'finalplan',
]);

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

function fail(
  errorCode: ResearchMapErrorCode,
  reason: string,
  path?: string,
): ResearchMapValidationError {
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

function normalizeTopologyKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z]/g, '');
}

function findForbiddenTopologyKey(value: unknown, path = '$'): { key: string; path: string } | null {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findForbiddenTopologyKey(item, `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const [key, item] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (FORBIDDEN_TOPOLOGY_KEYS.has(normalizeTopologyKey(key))) {
      return { key, path: childPath };
    }
    const found = findForbiddenTopologyKey(item, childPath);
    if (found) return found;
  }
  return null;
}

function requiredString(value: unknown, path: string, maxLength = 8_000): string | ResearchMapValidationError {
  if (typeof value !== 'string' || !value.trim()) {
    return fail('RESEARCH_SCHEMA', `${path} must be a non-empty string`, path);
  }
  const text = value.normalize('NFC').trim();
  if (text.length > maxLength) {
    return fail('RESEARCH_SCHEMA', `${path} exceeds ${maxLength} characters`, path);
  }
  return text;
}

function idString(value: unknown, path: string): string | ResearchMapValidationError {
  const text = requiredString(value, path, 80);
  if (typeof text !== 'string') return text;
  if (!ID_RE.test(text)) {
    return fail('RESEARCH_SCHEMA', `${path} must match ${ID_RE.source}`, path);
  }
  return text;
}

function stringArray(
  value: unknown,
  path: string,
  options: { min?: number; max?: number; ids?: boolean } = {},
): string[] | ResearchMapValidationError {
  const min = options.min ?? 0;
  const max = options.max ?? 128;
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    return fail('RESEARCH_SCHEMA', `${path} must contain ${min}-${max} strings`, path);
  }
  const out: string[] = [];
  for (const [index, item] of value.entries()) {
    const parsed = options.ids
      ? idString(item, `${path}[${index}]`)
      : requiredString(item, `${path}[${index}]`);
    if (typeof parsed !== 'string') return parsed;
    out.push(parsed);
  }
  if (new Set(out).size !== out.length) {
    return fail('RESEARCH_SCHEMA', `${path} must not contain duplicates`, path);
  }
  return out;
}

function serializedBytes(value: unknown): number | null {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return null;
  }
}

function sourceSections(
  packMarkdown: string,
  videoIds: readonly string[],
): Map<string, string> | ResearchMapValidationError {
  const wanted = new Set(videoIds);
  const sections = new Map<string, string[]>();
  for (const section of videoSectionsFromMarkdown(packMarkdown.normalize('NFC'))) {
    if (!section.videoId || !wanted.has(section.videoId)) continue;
    const transcriptHeading = section.body.match(/^###\s+Transcript\s*$/imu);
    if (!transcriptHeading || transcriptHeading.index === undefined) {
      return fail(
        'RESEARCH_SOURCE_AUDIT',
        `videoId "${section.videoId}" has no parseable Transcript section`,
        'sourceAudit',
      );
    }
    const transcript = section.body
      .slice(transcriptHeading.index + transcriptHeading[0].length)
      .normalize('NFC')
      .trim();
    if (!transcript) {
      return fail(
        'RESEARCH_SOURCE_AUDIT',
        `videoId "${section.videoId}" has an empty Transcript section`,
        'sourceAudit',
      );
    }
    const bodies = sections.get(section.videoId) ?? [];
    bodies.push(transcript);
    sections.set(section.videoId, bodies);
  }
  for (const videoId of videoIds) {
    if (!sections.has(videoId)) {
      return fail(
        'RESEARCH_SOURCE_AUDIT',
        `Topic Pack has no parseable H2 section for videoId "${videoId}"`,
        'sourceAudit',
      );
    }
  }
  return new Map([...sections].map(([videoId, bodies]) => [videoId, bodies.join('\n')]));
}

export function validateResearchMap(
  value: unknown,
  context: ResearchMapValidationContext,
): ResearchMapValidationResult {
  const bytes = serializedBytes(value);
  if (bytes === null) return fail('RESEARCH_SCHEMA', 'ResearchMap must be JSON-serializable');
  const maxBytes = context.maxBytes ?? MAX_RESEARCH_MAP_BYTES;
  if (bytes > maxBytes) {
    return fail(
      'RESEARCH_ARTIFACT_OVERSIZE',
      `ResearchMap is ${bytes} bytes; maximum is ${maxBytes}. Do not repeat source text.`,
    );
  }
  if (!isRecord(value)) return fail('RESEARCH_SCHEMA', 'ResearchMap must be an object');

  const forbidden = findForbiddenTopologyKey(value);
  if (forbidden) {
    return fail(
      'RESEARCH_FORBIDDEN_TOPOLOGY',
      `ResearchMap may not contain story-topology key "${forbidden.key}"`,
      forbidden.path,
    );
  }
  const extraTop = unknownKey(value, TOP_LEVEL_KEYS);
  if (extraTop) return fail('RESEARCH_SCHEMA', `unknown ResearchMap key "${extraTop}"`, `$.${extraTop}`);
  if (value['schemaVersion'] !== RESEARCH_MAP_SCHEMA_VERSION) {
    return fail(
      'RESEARCH_SCHEMA',
      `schemaVersion must be "${RESEARCH_MAP_SCHEMA_VERSION}"`,
      '$.schemaVersion',
    );
  }

  const videoIds = [...new Set(context.videoIds.map((id) => id.trim()).filter(Boolean))];
  if (videoIds.length === 0 || videoIds.length !== context.videoIds.length) {
    return fail('RESEARCH_SOURCE_AUDIT', 'validation context needs unique non-empty videoIds');
  }
  const sectionMap = sourceSections(context.packMarkdown, videoIds);
  if (!(sectionMap instanceof Map)) return sectionMap;

  if (!Array.isArray(value['sourceAudit']) || value['sourceAudit'].length !== videoIds.length) {
    return fail(
      'RESEARCH_SOURCE_AUDIT',
      `sourceAudit must contain exactly one entry for each of ${videoIds.length} videos`,
      '$.sourceAudit',
    );
  }
  const sourceAudit: ResearchSourceAudit[] = [];
  const auditedIds = new Set<string>();
  for (const [index, raw] of value['sourceAudit'].entries()) {
    const path = `$.sourceAudit[${index}]`;
    if (!isRecord(raw)) return fail('RESEARCH_SCHEMA', `${path} must be an object`, path);
    const extra = unknownKey(raw, SOURCE_AUDIT_KEYS);
    if (extra) return fail('RESEARCH_SCHEMA', `unknown key "${extra}"`, `${path}.${extra}`);
    const videoId = idString(raw['videoId'], `${path}.videoId`);
    if (typeof videoId !== 'string') return videoId;
    if (!videoIds.includes(videoId)) {
      return fail('RESEARCH_SOURCE_AUDIT', `${path}.videoId "${videoId}" is not in this pack`, `${path}.videoId`);
    }
    if (auditedIds.has(videoId)) {
      return fail('RESEARCH_SOURCE_AUDIT', `duplicate sourceAudit videoId "${videoId}"`, `${path}.videoId`);
    }
    auditedIds.add(videoId);
    const mainClaim = requiredString(raw['mainClaim'], `${path}.mainClaim`);
    if (typeof mainClaim !== 'string') return mainClaim;
    const angle = requiredString(raw['angle'], `${path}.angle`);
    if (typeof angle !== 'string') return angle;
    const limitations = stringArray(raw['limitations'], `${path}.limitations`, { max: 32 });
    if (!Array.isArray(limitations)) return limitations;
    // Provenance is coordinator-owned. `originGroup` is intentionally absent
    // from the raw allowlist above and is filled only after the video ID has
    // been checked against the pinned manifest.
    const originGroup = context.originGroupByVideoId?.[videoId]?.trim() || 'unknown';
    if (!ID_RE.test(originGroup)) {
      return fail(
        'RESEARCH_ORIGIN',
        `coordinator-pinned origin group for videoId "${videoId}" must match ${ID_RE.source}`,
        `${path}.videoId`,
      );
    }
    sourceAudit.push({ videoId, mainClaim, angle, originGroup, limitations });
  }

  if (!Array.isArray(value['evidence']) || value['evidence'].length < 1 || value['evidence'].length > 256) {
    return fail('RESEARCH_SCHEMA', '$.evidence must contain 1-256 entries', '$.evidence');
  }
  const evidence: ResearchEvidence[] = [];
  const evidenceIds = new Set<string>();
  for (const [index, raw] of value['evidence'].entries()) {
    const path = `$.evidence[${index}]`;
    if (!isRecord(raw)) return fail('RESEARCH_SCHEMA', `${path} must be an object`, path);
    const extra = unknownKey(raw, EVIDENCE_KEYS);
    if (extra) return fail('RESEARCH_SCHEMA', `unknown key "${extra}"`, `${path}.${extra}`);
    const id = idString(raw['id'], `${path}.id`);
    if (typeof id !== 'string') return id;
    if (evidenceIds.has(id)) return fail('RESEARCH_REFERENCE', `duplicate evidence id "${id}"`, `${path}.id`);
    evidenceIds.add(id);
    const claimId = idString(raw['claimId'], `${path}.claimId`);
    if (typeof claimId !== 'string') return claimId;
    const videoId = idString(raw['videoId'], `${path}.videoId`);
    if (typeof videoId !== 'string') return videoId;
    const section = sectionMap.get(videoId);
    if (!section) {
      return fail('RESEARCH_SOURCE_GROUNDING', `evidence videoId "${videoId}" is not in this pack`, `${path}.videoId`);
    }
    const quote = requiredString(raw['quote'], `${path}.quote`);
    if (typeof quote !== 'string') return quote;
    if (!section.includes(quote)) {
      return fail(
        'RESEARCH_SOURCE_GROUNDING',
        `evidence "${id}" quote is not an exact substring of videoId "${videoId}"`,
        `${path}.quote`,
      );
    }
    const relation = raw['relation'];
    if (!RESEARCH_EVIDENCE_RELATIONS.includes(relation as ResearchEvidenceRelation)) {
      return fail(
        'RESEARCH_SCHEMA',
        `${path}.relation must be one of ${RESEARCH_EVIDENCE_RELATIONS.join(', ')}`,
        `${path}.relation`,
      );
    }
    evidence.push({ id, claimId, videoId, quote, relation: relation as ResearchEvidenceRelation });
  }

  if (!Array.isArray(value['claims']) || value['claims'].length < 1 || value['claims'].length > 128) {
    return fail('RESEARCH_SCHEMA', '$.claims must contain 1-128 entries', '$.claims');
  }
  const claims: ResearchClaim[] = [];
  const claimIds = new Set<string>();
  for (const [index, raw] of value['claims'].entries()) {
    const path = `$.claims[${index}]`;
    if (!isRecord(raw)) return fail('RESEARCH_SCHEMA', `${path} must be an object`, path);
    const extra = unknownKey(raw, CLAIM_KEYS);
    if (extra) return fail('RESEARCH_SCHEMA', `unknown key "${extra}"`, `${path}.${extra}`);
    const id = idString(raw['id'], `${path}.id`);
    if (typeof id !== 'string') return id;
    if (claimIds.has(id)) return fail('RESEARCH_REFERENCE', `duplicate claim id "${id}"`, `${path}.id`);
    claimIds.add(id);
    const text = requiredString(raw['text'], `${path}.text`);
    if (typeof text !== 'string') return text;
    const status = raw['status'];
    if (!RESEARCH_STATUSES.includes(status as ResearchStatus)) {
      return fail(
        'RESEARCH_SCHEMA',
        `${path}.status must be one of ${RESEARCH_STATUSES.join(', ')}`,
        `${path}.status`,
      );
    }
    const listedEvidenceIds = stringArray(raw['evidenceIds'], `${path}.evidenceIds`, {
      min: 1,
      max: 64,
      ids: true,
    });
    if (!Array.isArray(listedEvidenceIds)) return listedEvidenceIds;
    const caveats = stringArray(raw['caveats'], `${path}.caveats`, { max: 32 });
    if (!Array.isArray(caveats)) return caveats;
    claims.push({
      id,
      text,
      status: status as ResearchStatus,
      evidenceIds: listedEvidenceIds,
      // Hydrated from this claim's validated evidence below. The model cannot
      // declare independence that coordinator-pinned provenance does not show.
      independentOriginGroups: [],
      caveats,
    });
  }

  const claimById = new Map(claims.map((claim) => [claim.id, claim]));
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const auditByVideo = new Map(sourceAudit.map((audit) => [audit.videoId, audit]));
  for (const item of evidence) {
    const claim = claimById.get(item.claimId);
    if (!claim) {
      return fail('RESEARCH_REFERENCE', `evidence "${item.id}" references unknown claim "${item.claimId}"`);
    }
    if (!claim.evidenceIds.includes(item.id)) {
      return fail(
        'RESEARCH_REFERENCE',
        `evidence "${item.id}" is not listed by its claim "${item.claimId}"`,
      );
    }
  }
  for (const claim of claims) {
    const items: ResearchEvidence[] = [];
    for (const evidenceId of claim.evidenceIds) {
      const item = evidenceById.get(evidenceId);
      if (!item) return fail('RESEARCH_REFERENCE', `claim "${claim.id}" references unknown evidence "${evidenceId}"`);
      if (item.claimId !== claim.id) {
        return fail(
          'RESEARCH_REFERENCE',
          `claim "${claim.id}" lists evidence "${evidenceId}" owned by "${item.claimId}"`,
        );
      }
      items.push(item);
    }
    const unauthorizedSpecifics = unauthorizedProtectedSpecifics(
      claim.text,
      items.map((item) => item.quote),
    );
    if (unauthorizedSpecifics.length > 0) {
      const detail = unauthorizedSpecifics
        .map((specific) => `${specific.kind}:${specific.raw}`)
        .join(', ');
      return fail(
        'RESEARCH_CLAIM_SPECIFIC',
        `claim "${claim.id}" contains specifics absent from its own exact evidence quotes: ${detail}`,
      );
    }
    const derivedGroups = [...new Set(items.map((item) => auditByVideo.get(item.videoId)!.originGroup))];
    claim.independentOriginGroups = derivedGroups;
    const positiveItems = items.filter(
      (item) => item.relation === 'SUPPORTS' || item.relation === 'QUALIFIES',
    );
    const supportOriginGroups = [
      ...new Set(positiveItems.map((item) => auditByVideo.get(item.videoId)!.originGroup)),
    ];
    const hasContradiction = items.some((item) => item.relation === 'CONTRADICTS');
    const isAttested = claim.status === 'ATTESTED' || claim.status === 'MULTI_SOURCE_ATTESTED';
    if (isAttested && hasContradiction) {
      return fail(
        'RESEARCH_STATUS',
        `attested claim "${claim.id}" contains CONTRADICTS evidence and must be DISPUTED or REJECTED`,
      );
    }
    if (claim.status === 'MULTI_SOURCE_ATTESTED' && supportOriginGroups.length < 2) {
      return fail(
        'RESEARCH_ORIGIN',
        `claim "${claim.id}" cannot be MULTI_SOURCE_ATTESTED with `
        + `${supportOriginGroups.length} supporting origin group`,
      );
    }
    const relations = new Set(items.map((item) => item.relation));
    if (
      (claim.status === 'ATTESTED' || claim.status === 'MULTI_SOURCE_ATTESTED')
      && !relations.has('SUPPORTS')
      && !relations.has('QUALIFIES')
    ) {
      return fail('RESEARCH_STATUS', `attested claim "${claim.id}" has no supporting/qualifying evidence`);
    }
    if (claim.status === 'DISPUTED' && (positiveItems.length === 0 || !hasContradiction)) {
      return fail(
        'RESEARCH_STATUS',
        `DISPUTED claim "${claim.id}" needs positive (SUPPORTS/QUALIFIES) and CONTRADICTS evidence`,
      );
    }
  }

  if (!Array.isArray(value['conflicts']) || value['conflicts'].length > 64) {
    return fail('RESEARCH_SCHEMA', '$.conflicts must be an array with at most 64 entries', '$.conflicts');
  }
  const conflicts: ResearchConflict[] = [];
  for (const [index, raw] of value['conflicts'].entries()) {
    const path = `$.conflicts[${index}]`;
    if (!isRecord(raw)) return fail('RESEARCH_SCHEMA', `${path} must be an object`, path);
    const extra = unknownKey(raw, CONFLICT_KEYS);
    if (extra) return fail('RESEARCH_SCHEMA', `unknown key "${extra}"`, `${path}.${extra}`);
    const conflictClaimIds = stringArray(raw['claimIds'], `${path}.claimIds`, {
      min: 2,
      max: 8,
      ids: true,
    });
    if (!Array.isArray(conflictClaimIds)) return conflictClaimIds;
    for (const claimId of conflictClaimIds) {
      if (!claimById.has(claimId)) {
        return fail('RESEARCH_REFERENCE', `${path} references unknown claim "${claimId}"`, `${path}.claimIds`);
      }
    }
    const explanation = requiredString(raw['explanation'], `${path}.explanation`);
    if (typeof explanation !== 'string') return explanation;
    conflicts.push({ claimIds: conflictClaimIds, explanation });
  }

  const claimsWithConflictPayload = new Set(conflicts.flatMap((conflict) => conflict.claimIds));
  for (const claim of claims) {
    if (
      claim.status === 'DISPUTED'
      && claim.caveats.length === 0
      && !claimsWithConflictPayload.has(claim.id)
    ) {
      return fail(
        'RESEARCH_STATUS',
        `DISPUTED claim "${claim.id}" needs a non-empty caveat or conflicts entry`,
      );
    }
  }

  const openQuestions = stringArray(value['openQuestions'], '$.openQuestions', { max: 64 });
  if (!Array.isArray(openQuestions)) return openQuestions;
  const overusedAngles = stringArray(value['overusedAngles'], '$.overusedAngles', { max: 64 });
  if (!Array.isArray(overusedAngles)) return overusedAngles;

  return {
    ok: true,
    researchMap: {
      schemaVersion: RESEARCH_MAP_SCHEMA_VERSION,
      sourceAudit,
      claims,
      evidence,
      conflicts,
      openQuestions,
      overusedAngles,
    },
  };
}

export interface ResearchCoverageEntry {
  videoId: string;
  mainClaim: string;
  angle: string;
}

export function coverageMapFromResearchMap(researchMap: ResearchMap): ResearchCoverageEntry[] {
  return researchMap.sourceAudit.map(({ videoId, mainClaim, angle }) => ({ videoId, mainClaim, angle }));
}

export type FactsLedgerDerivationResult =
  | { ok: true; factsLedger: LedgerEntry[] }
  | { ok: false; errorCode: 'RESEARCH_LEDGER'; reason: string };

export type AuthorizedClaimPermissionDerivationResult =
  | { ok: true; permissions: AuthorizedClaimPermission[] }
  | { ok: false; errorCode: 'RESEARCH_PERMISSION'; reason: string };

/**
 * Derive factual capability records from selected positive evidence only.
 * Unselected non-rejected claims deliberately confer no permission.
 */
export function deriveAuthorizedClaimPermissions(
  researchMap: ResearchMap,
  selectedEvidenceIds: readonly string[],
): AuthorizedClaimPermissionDerivationResult {
  const evidenceById = new Map(researchMap.evidence.map((item) => [item.id, item]));
  const claimById = new Map(researchMap.claims.map((claim) => [claim.id, claim]));
  const selectedByClaim = new Map<string, { evidenceIds: string[]; quotes: string[] }>();

  for (const evidenceId of selectedEvidenceIds) {
    const evidence = evidenceById.get(evidenceId);
    if (!evidence) {
      return { ok: false, errorCode: 'RESEARCH_PERMISSION', reason: `unknown evidence "${evidenceId}"` };
    }
    const claim = claimById.get(evidence.claimId);
    if (!claim) {
      return {
        ok: false,
        errorCode: 'RESEARCH_PERMISSION',
        reason: `evidence "${evidenceId}" has no claim`,
      };
    }
    if (claim.status === 'REJECTED') {
      return {
        ok: false,
        errorCode: 'RESEARCH_PERMISSION',
        reason: `claim "${claim.id}" is REJECTED`,
      };
    }
    if (evidence.relation === 'CONTRADICTS') {
      return {
        ok: false,
        errorCode: 'RESEARCH_PERMISSION',
        reason: `evidence "${evidenceId}" CONTRADICTS claim "${claim.id}" and cannot authorize it`,
      };
    }
    const selected = selectedByClaim.get(claim.id) ?? { evidenceIds: [], quotes: [] };
    if (!selected.evidenceIds.includes(evidence.id)) selected.evidenceIds.push(evidence.id);
    if (!selected.quotes.includes(evidence.quote)) selected.quotes.push(evidence.quote);
    selectedByClaim.set(claim.id, selected);
  }

  const permissions: AuthorizedClaimPermission[] = [];
  for (const [claimId, selected] of selectedByClaim) {
    const claim = claimById.get(claimId)!;
    if (claim.status === 'REJECTED') continue;
    permissions.push({
      claimId: claim.id,
      text: claim.text,
      status: claim.status,
      caveats: [...claim.caveats],
      evidenceIds: selected.evidenceIds,
      quotes: selected.quotes,
    });
  }
  return { ok: true, permissions };
}

/**
 * Convert evidence selected by CONFRONT into the legacy writer facts ledger.
 * The application owns this mapping; a model may not invent a fact label around
 * an unrelated but real quote.
 */
export function deriveFactsLedger(
  researchMap: ResearchMap,
  selectedEvidenceIds: readonly string[],
  options: { minEntries?: number } = {},
): FactsLedgerDerivationResult {
  const minEntries = options.minEntries ?? 3;
  const evidenceById = new Map(researchMap.evidence.map((item) => [item.id, item]));
  const claimById = new Map(researchMap.claims.map((claim) => [claim.id, claim]));
  const factsLedger: LedgerEntry[] = [];
  const seen = new Set<string>();

  for (const evidenceId of selectedEvidenceIds) {
    const item = evidenceById.get(evidenceId);
    if (!item) return { ok: false, errorCode: 'RESEARCH_LEDGER', reason: `unknown evidence "${evidenceId}"` };
    const claim = claimById.get(item.claimId);
    if (!claim) {
      return { ok: false, errorCode: 'RESEARCH_LEDGER', reason: `evidence "${evidenceId}" has no claim` };
    }
    if (claim.status === 'REJECTED') {
      return { ok: false, errorCode: 'RESEARCH_LEDGER', reason: `claim "${claim.id}" is REJECTED` };
    }
    if (item.relation === 'CONTRADICTS') {
      return {
        ok: false,
        errorCode: 'RESEARCH_LEDGER',
        reason: `evidence "${evidenceId}" CONTRADICTS claim "${claim.id}" and cannot source that fact label`,
      };
    }
    // Ledger breadth is evidence breadth, not the number of agent-authored
    // claim labels attached to one transcript substring. Claim authorization
    // remains a separate planning concern.
    const key = `${item.videoId}\u0000${item.quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // The claim label is agent-authored interpretation. It remains useful to
    // CONFRONT, but it must not become factual authorization. The only text code
    // can prove here is the exact transcript evidence itself.
    factsLedger.push({ fact: item.quote, videoId: item.videoId, quote: item.quote });
  }

  if (factsLedger.length < minEntries) {
    return {
      ok: false,
      errorCode: 'RESEARCH_LEDGER',
      reason: `factsLedger needs at least ${minEntries} unique grounded entries; got ${factsLedger.length}`,
    };
  }
  return { ok: true, factsLedger };
}

const RESEARCH_PROMPT_EXAMPLE: ResearchMapAgentOutput = {
  schemaVersion: RESEARCH_MAP_SCHEMA_VERSION,
  sourceAudit: [
    {
      videoId: 'video-1',
      mainClaim: 'Khoảng đệm bảo vệ khả năng đổi hướng.',
      angle: 'quyền lựa chọn',
      limitations: ['Transcript không định lượng mức tác động.'],
    },
    {
      videoId: 'video-2',
      mainClaim: 'Cam kết cố định có thể thu hẹp thời gian ra quyết định.',
      angle: 'áp lực thời gian',
      limitations: ['Ví dụ chỉ phản ánh một bối cảnh.'],
    },
  ],
  claims: [
    {
      id: 'claim-choice',
      text: 'Khoảng đệm có thể bảo vệ quyền đổi hướng.',
      status: 'ATTESTED',
      evidenceIds: ['evidence-choice'],
      caveats: ['Pack không cho biết cơ chế này mạnh tới đâu.'],
    },
    {
      id: 'claim-pressure',
      text: 'Cam kết cố định luôn làm quyết định tốt hơn.',
      status: 'DISPUTED',
      evidenceIds: ['evidence-pressure-for', 'evidence-pressure-against'],
      caveats: ['Hai transcript mô tả tác động theo hướng khác nhau.'],
    },
  ],
  evidence: [
    {
      id: 'evidence-choice',
      claimId: 'claim-choice',
      videoId: 'video-1',
      quote: 'Khoảng đệm giúp một người còn lựa chọn đổi hướng.',
      relation: 'SUPPORTS',
    },
    {
      id: 'evidence-pressure-for',
      claimId: 'claim-pressure',
      videoId: 'video-1',
      quote: 'Một cam kết rõ ràng đôi khi giúp quyết định dứt khoát hơn.',
      relation: 'QUALIFIES',
    },
    {
      id: 'evidence-pressure-against',
      claimId: 'claim-pressure',
      videoId: 'video-2',
      quote: 'Cam kết cố định có thể làm thời gian lựa chọn ngắn lại.',
      relation: 'CONTRADICTS',
    },
  ],
  conflicts: [
    {
      claimIds: ['claim-choice', 'claim-pressure'],
      explanation: 'Quyền đổi hướng và lợi ích của cam kết phụ thuộc vào bối cảnh khác nhau.',
    },
  ],
  openQuestions: ['Điều kiện nào quyết định cam kết trở thành hỗ trợ hay áp lực?'],
  overusedAngles: ['Liệt kê lời khuyên mà không chỉ ra giới hạn của evidence.'],
};

/** Stable RESEARCH instructions; title/brief/audience and source files are staged separately. */
export function buildResearchPrompt(options: {
  /** A fan-out worker sees exactly one source. Kept optional for the full-pack contract tests. */
  singleSourceVideoId?: string;
  /** Coordinator-owned output budget for this worker. */
  maxBytes?: number;
} = {}): string {
  const maxBytes = options.maxBytes ?? MAX_RESEARCH_MAP_BYTES;
  return [
    '# Writer v2 — RESEARCH (lập bản đồ evidence, không đề xuất câu chuyện)',
    '',
    ...(options.singleSourceVideoId
      ? [
          `Đây là worker độc lập cho DUY NHẤT videoId \`${options.singleSourceVideoId}\`.`,
          'Không tìm, đọc hoặc suy đoán transcript khác. sourceAudit phải có đúng một entry cho video này.',
          'Dùng ATTESTED/REJECTED theo evidence của nguồn này; không dùng MULTI_SOURCE_ATTESTED.',
          '',
        ]
      : []),
    'Đọc `input/envelope.json`, rồi đọc MỌI file trong `topicPack.contentFiles` theo đúng thứ tự.',
    'Envelope chỉ cung cấp title, brief, audience và source manifest. Bạn KHÔNG được xem selectedHook,',
    'DIVERGE hypotheses, General Pack, Formula hay Persona Pack; không hỏi xin hoặc cố đoán chúng.',
    '',
    'Nhiệm vụ duy nhất là mô tả PACK CHỨNG THỰC GÌ: từng nguồn nói gì, evidence exact nào hỗ trợ/',
    'mâu thuẫn/giới hạn claim nào, còn xung đột và câu hỏi mở nào. Status không tuyên bố sự thật ngoài đời;',
    'nó chỉ mô tả mức chứng thực bên trong pack đã pin.',
    '',
    '## Ranh giới chống story topology',
    '',
    'Không gợi ý outline, hook, thesis, beat, beat order, intro, ending, payoff, narration, script, story spine,',
    'memory anchor, progression hay recommendation — ở top-level hoặc giấu trong object lồng. “Giúp thêm”',
    'bằng cấu trúc bài là LỖI schema, không phải đóng góp. Chỉ lập evidence map; không sắp thứ tự kể chuyện.',
    '',
    '## Source audit và provenance do code sở hữu',
    '',
    '- `sourceAudit` phải có đúng một entry cho MỖI videoId trong source manifest; không thiếu, không trùng,',
    '  không thêm ID ngoài pack. Mỗi entry chỉ có `videoId`, `mainClaim`, `angle`, `limitations`.',
    '- KHÔNG khai `originGroup` ở sourceAudit và KHÔNG khai `independentOriginGroups` ở claim.',
    '  Coordinator đã biết provenance và sẽ tự điền cả hai sau validation. Có mặt dù giá trị đúng vẫn là',
    '  `RESEARCH_SCHEMA`; đừng bắt code so lại một đáp án code đã biết.',
    '- `limitations` là 0–32 giới hạn cụ thể của transcript, không phải lời khuyên dựng bài.',
    '',
    '## Evidence phải truy được tới đúng Transcript',
    '',
    '- `evidence` có 1–256 entry. Mỗi entry chỉ có `id`, `claimId`, `videoId`, `quote`, `relation`.',
    '- `quote` phải là substring CHÍNH XÁC, liên tục, NFC, của phần `### Transcript` thuộc ĐÚNG videoId.',
    '  Copy nguyên ký tự, dấu câu và khoảng trắng; không sửa chính tả, rút gọn hay paraphrase quote.',
    '- Không lấy title, heading, `videoId`, URL hoặc metadata ngoài Transcript làm quote, dù text đó có trong file.',
    '- `relation` chỉ là `SUPPORTS`, `QUALIFIES`, hoặc `CONTRADICTS`.',
    '- Mỗi evidence ID unique, phải trỏ tới claim tồn tại; claim phải liệt kê lại đúng evidence ID đó.',
    '  Liên kết hai chiều phải khớp: evidence.claimId ↔ claims[].evidenceIds.',
    '',
    '## Claim, protected specifics và status',
    '',
    '- `claims` có 1–128 entry. Mỗi claim chỉ có `id`, `text`, `status`, `evidenceIds`, `caveats`.',
    '  Claim ID phải unique; evidence ID cũng phải unique trong toàn artifact.',
    '- `text` được paraphrase proposition, nhưng mọi số tiền, phần trăm đo lường, tuổi, năm, “N lần” và',
    '  proper noun trong text phải xuất hiện với cùng specific trong ít nhất một exact quote CỦA CHÍNH claim.',
    '  Lý do: text sẽ trở thành quyền paraphrase ở WRITE; quote chỉ cấp quyền cho concrete specifics thực có.',
    '  ĐÚNG: quote “năm ngoái tôi lỗ gần 800 triệu” → text “Có người lỗ gần 800 triệu trong một năm.”',
    '  SAI: cùng quote đó → text “Có người mất gần một tỷ trong một năm.” vì số đã trôi.',
    '- `evidenceIds` có 1–64 ID unique. `caveats` có 0–32 chuỗi unique.',
    '- `ATTESTED`: có SUPPORTS/QUALIFIES và không có CONTRADICTS.',
    '- `MULTI_SOURCE_ATTESTED`: như ATTESTED, đồng thời positive evidence thuộc ít nhất hai origin group',
    '  khác nhau đã được coordinator pin. Chỉ dùng khi source manifest xác nhận; không tự suy luận độc lập.',
    '- Có cả positive evidence và CONTRADICTS thì bắt buộc `DISPUTED` hoặc `REJECTED`, không được chọn nhãn mạnh.',
    '- `DISPUTED`: cần cả SUPPORTS/QUALIFIES lẫn CONTRADICTS, và phải có caveat không rỗng hoặc một',
    '  `conflicts` entry chứa claim đó. `REJECTED` dùng khi pack không chống lưng được proposition như đã viết.',
    '',
    '## Conflicts và danh sách cuối',
    '',
    '- `conflicts` có tối đa 64 entry; mỗi entry chỉ có `claimIds` (2–8 ID unique đã tồn tại) và',
    '  `explanation` không rỗng.',
    '- `openQuestions` và `overusedAngles` mỗi array tối đa 64 chuỗi không rỗng, không trùng.',
    '- Không lặp source text để làm output phình to; chỉ giữ exact quote thực sự cần cho claim.',
    '',
    '## Strict JSON contract',
    '',
    `Output phải JSON-serializable và không quá ${maxBytes} bytes. Chỉ ghi JSON vào \`out/result.json\`; không Markdown ngoài file.`,
    `Top-level chỉ được có: ${promptKeyList(TOP_LEVEL_KEYS)}.`,
    `\`schemaVersion\` = \`${RESEARCH_MAP_SCHEMA_VERSION}\`. Không thêm key ngoài allowlist ở bất kỳ object lồng nào.`,
    `SourceAudit keys: ${promptKeyList(SOURCE_AUDIT_KEYS)}.`,
    `Claim keys: ${promptKeyList(CLAIM_KEYS)}. Evidence keys: ${promptKeyList(EVIDENCE_KEYS)}.`,
    `Conflict keys: ${promptKeyList(CONFLICT_KEYS)}.`,
    'Mọi chuỗi bắt buộc phải không rỗng và tối đa 8000 ký tự. ID tối đa 80 ký tự, bắt đầu bằng chữ/số',
    'và chỉ dùng chữ/số hoặc `._:-`.',
    'Mọi array string/ID không được có phần tử trùng.',
    '',
    'Ví dụ output đầy đủ về cấu trúc. ID và quote dưới đây chỉ minh họa; thay bằng videoId và exact Transcript',
    'quote thật từ pack. Nếu pack có số video khác, sourceAudit phải có đúng số entry tương ứng:',
    '',
    '```json',
    JSON.stringify(RESEARCH_PROMPT_EXAMPLE, null, 2),
    '```',
  ].join('\n');
}
