/**
 * Writer v2 STUDY / RESEARCH contract.
 *
 * This module is deliberately pure: it validates the agent-produced evidence
 * map against a pinned Topic Pack, but it does not know hooks, hypotheses, or
 * story order. Keeping those concepts out of the type is part of the blindness
 * boundary, not merely a prompt instruction.
 */
import type { LedgerEntry } from './deterministic-gate.ts';
import { videoSectionsFromMarkdown } from '../writer-packs.ts';

export const RESEARCH_MAP_SCHEMA_VERSION = 'writer-research-map-v1' as const;
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

export type ResearchMapErrorCode =
  | 'RESEARCH_SCHEMA'
  | 'RESEARCH_FORBIDDEN_TOPOLOGY'
  | 'RESEARCH_ARTIFACT_OVERSIZE'
  | 'RESEARCH_SOURCE_AUDIT'
  | 'RESEARCH_SOURCE_GROUNDING'
  | 'RESEARCH_REFERENCE'
  | 'RESEARCH_ORIGIN'
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
const SOURCE_AUDIT_KEYS = new Set(['videoId', 'mainClaim', 'angle', 'originGroup', 'limitations']);
const CLAIM_KEYS = new Set(['id', 'text', 'status', 'evidenceIds', 'independentOriginGroups', 'caveats']);
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

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(right);
  return left.every((value) => expected.has(value));
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
    const originGroup = idString(raw['originGroup'], `${path}.originGroup`);
    if (typeof originGroup !== 'string') return originGroup;
    const trustedOriginGroup = context.originGroupByVideoId?.[videoId]?.trim() || 'unknown';
    if (originGroup !== trustedOriginGroup) {
      return fail(
        'RESEARCH_ORIGIN',
        `${path}.originGroup must equal coordinator-pinned provenance "${trustedOriginGroup}"; `
        + 'the research agent may not declare source independence',
        `${path}.originGroup`,
      );
    }
    const limitations = stringArray(raw['limitations'], `${path}.limitations`, { max: 32 });
    if (!Array.isArray(limitations)) return limitations;
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
    const independentOriginGroups = stringArray(
      raw['independentOriginGroups'],
      `${path}.independentOriginGroups`,
      { min: 1, max: 32, ids: true },
    );
    if (!Array.isArray(independentOriginGroups)) return independentOriginGroups;
    const caveats = stringArray(raw['caveats'], `${path}.caveats`, { max: 32 });
    if (!Array.isArray(caveats)) return caveats;
    claims.push({
      id,
      text,
      status: status as ResearchStatus,
      evidenceIds: listedEvidenceIds,
      independentOriginGroups,
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
    const derivedGroups = [...new Set(items.map((item) => auditByVideo.get(item.videoId)!.originGroup))];
    if (!sameSet(claim.independentOriginGroups, derivedGroups)) {
      return fail(
        'RESEARCH_ORIGIN',
        `claim "${claim.id}" independentOriginGroups must equal evidence-derived groups: ${derivedGroups.join(', ')}`,
      );
    }
    if (claim.status === 'MULTI_SOURCE_ATTESTED' && derivedGroups.length < 2) {
      return fail(
        'RESEARCH_ORIGIN',
        `claim "${claim.id}" cannot be MULTI_SOURCE_ATTESTED with ${derivedGroups.length} origin group`,
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
    if (claim.status === 'DISPUTED' && (!relations.has('SUPPORTS') || !relations.has('CONTRADICTS'))) {
      return fail(
        'RESEARCH_STATUS',
        `DISPUTED claim "${claim.id}" needs both SUPPORTS and CONTRADICTS evidence`,
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
    const key = `${claim.id}\u0000${item.videoId}\u0000${item.quote}`;
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
