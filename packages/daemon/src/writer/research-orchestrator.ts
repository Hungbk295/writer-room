/**
 * Source Pack -> Topic Pack fan-out.
 *
 * Each worker receives exactly one complete video section. The coordinator validates
 * exact quotes against that section, persists the committed artifact, and combines
 * only the compact research maps. Raw transcripts never enter the later STUDY turn.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DispatchItemResult, LaneScheduler } from '../pipeline/lane-scheduler.ts';
import { videoSectionsFromMarkdown, type WriterPack } from '../writer-packs.ts';
import {
  buildResearchPrompt,
  MAX_RESEARCH_MAP_BYTES,
  RESEARCH_MAP_SCHEMA_VERSION,
  RESEARCH_PROMPT_VERSION,
  validateResearchMap,
  type ResearchMap,
  type ResearchMapAgentOutput,
} from './research-map.ts';

export const RESEARCH_SOURCE_STAGE = 'research-source-v1';
export const RESEARCH_SOURCE_PROMPT_VERSION = `${RESEARCH_PROMPT_VERSION}-single-source-v1`;
export const MAX_RESEARCH_SOURCES = 5;
/** Leave room for the Markdown Topic Pack wrapper beneath the 60 KiB map ceiling. */
export const RESEARCH_SOURCE_TOTAL_BUDGET_BYTES = 48 * 1024;
export const MAX_TOPIC_PACK_BYTES = 60 * 1024;

export type ResearchSourceStatus = 'PENDING' | 'RUNNING' | 'COMMITTED' | 'FAILED' | 'INTERRUPTED';

export interface ResearchSourceCheckpoint {
  videoId: string;
  itemId: string;
  sourceHash: string;
  status: ResearchSourceStatus;
  attempt: number;
  /** Every daemon turn used for this transcript, including retries after restart. */
  turnIds: number[];
  activeTurnId?: number;
  artifactHash?: string;
  /** Relative to dataDir. */
  artifactPath?: string;
  errorCode?: string;
  errorReason?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface TopicPackCheckpoint {
  /** Relative to dataDir. */
  path: string;
  hash: string;
  /** Relative to dataDir. */
  researchMapPath: string;
  researchMapHash: string;
  sourcePackHash: string;
  videoIds: string[];
  createdAt: string;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function uniqueVideoSections(pack: WriterPack): Map<string, string> {
  const sections = new Map<string, string>();
  for (const section of videoSectionsFromMarkdown(pack.markdown)) {
    if (!section.videoId) continue;
    if (sections.has(section.videoId)) {
      throw new Error(`Source Pack có videoId trùng: ${section.videoId}`);
    }
    sections.set(section.videoId, section.body);
  }
  return sections;
}

export function researchSourceSections(pack: WriterPack): Array<{ videoId: string; markdown: string }> {
  const sections = uniqueVideoSections(pack);
  const declaredIds = pack.videoIds.map((id) => id.trim()).filter(Boolean);
  const videoIds = [...new Set(declaredIds.length > 0 ? declaredIds : [...sections.keys()])];
  if (videoIds.length < 2) return [];
  if (videoIds.length > MAX_RESEARCH_SOURCES) {
    throw new Error(
      `Source Pack có ${videoIds.length} video; fan-out hiện giới hạn ${MAX_RESEARCH_SOURCES} transcript mỗi Writer run`,
    );
  }
  return videoIds.map((videoId) => {
    const markdown = sections.get(videoId);
    if (!markdown) throw new Error(`Source Pack thiếu H2 section cho videoId ${videoId}`);
    if (!/^###\s+Transcript\s*$/imu.test(markdown)) {
      throw new Error(`Source Pack thiếu Transcript cho videoId ${videoId}`);
    }
    return { videoId, markdown };
  });
}

export function createResearchCheckpoints(pack: WriterPack): ResearchSourceCheckpoint[] {
  return researchSourceSections(pack).map((source, index) => ({
    videoId: source.videoId,
    itemId: `research-${String(index + 1).padStart(2, '0')}-${sha256(source.videoId).slice(0, 8)}`,
    sourceHash: sha256(source.markdown),
    status: 'PENDING',
    attempt: 1,
    turnIds: [],
  }));
}

export function sourceMarkdownForCheckpoint(pack: WriterPack, checkpoint: ResearchSourceCheckpoint): string {
  const source = researchSourceSections(pack).find((item) => item.videoId === checkpoint.videoId);
  if (!source) throw new Error(`Không tìm thấy transcript đã pin: ${checkpoint.videoId}`);
  const actualHash = sha256(source.markdown);
  if (actualHash !== checkpoint.sourceHash) {
    throw new Error(`Transcript ${checkpoint.videoId} đã thay đổi sau khi fan-out được pin`);
  }
  return source.markdown;
}

export function researchSourceBudget(sourceCount: number): number {
  return Math.floor(RESEARCH_SOURCE_TOTAL_BUDGET_BYTES / Math.max(1, sourceCount));
}

export async function dispatchResearchSource(input: {
  scheduler: LaneScheduler;
  runId: string;
  templateId: string;
  substrate: 'terminal' | 'external';
  title: string;
  brief: string;
  audience: string;
  pack: WriterPack;
  checkpoint: ResearchSourceCheckpoint;
  sourceCount: number;
}): Promise<DispatchItemResult> {
  const sourceMarkdown = sourceMarkdownForCheckpoint(input.pack, input.checkpoint);
  const maxBytes = researchSourceBudget(input.sourceCount);
  const sourceFile = { path: 'source/source.md', content: sourceMarkdown };
  const envelope = {
    contract: {
      role: 'Writer v2 — single-source RESEARCH worker',
      scope: 'one complete transcript only',
      output: 'compact grounded ResearchMap; no story topology',
    },
    title: input.title,
    brief: input.brief,
    audience: input.audience,
    topicPack: {
      videoIds: [input.checkpoint.videoId],
      contentFiles: [`input/${sourceFile.path}`],
      maxOutputBytes: maxBytes,
    },
  };
  return input.scheduler.dispatchItem({
    batchId: input.runId,
    itemId: input.checkpoint.itemId,
    stage: RESEARCH_SOURCE_STAGE,
    attempt: input.checkpoint.attempt,
    templateId: input.templateId,
    substrate: input.substrate,
    promptMarkdown: buildResearchPrompt({
      singleSourceVideoId: input.checkpoint.videoId,
      maxBytes,
    }),
    envelope,
    inputFiles: [sourceFile],
    inputHashes: [sha256(JSON.stringify(envelope)), input.checkpoint.sourceHash],
    promptVersion: RESEARCH_SOURCE_PROMPT_VERSION,
    // A worker is intentionally one-shot. No persistent PTY/session survives settle.
    interactivePty: false,
    freshContext: true,
    maxTurns: 1,
    budgetScope: `${input.runId}:${input.checkpoint.itemId}:research:a${input.checkpoint.attempt}`,
    maxContentRetries: 0,
    validateContent: (parsed) => {
      const validation = validateResearchMap(parsed, {
        packMarkdown: sourceMarkdown,
        videoIds: [input.checkpoint.videoId],
        maxBytes,
      });
      return validation.ok
        ? { ok: true as const }
        : { ok: false as const, errorCode: validation.errorCode, reason: validation.reason };
    },
  });
}

function namespacedId(sourceIndex: number, id: string): string {
  const prefix = `s${String(sourceIndex + 1).padStart(2, '0')}:`;
  if (prefix.length + id.length <= 80) return `${prefix}${id}`;
  const suffix = `:${sha256(id).slice(0, 8)}`;
  return `${prefix}${id.slice(0, 80 - prefix.length - suffix.length)}${suffix}`;
}

/** Combine validated worker outputs without asking another model to reread transcripts. */
export function combineResearchMaps(
  maps: ResearchMap[],
  pack: WriterPack,
): { researchMap: ResearchMap; markdown: string } {
  const combined: ResearchMapAgentOutput = {
    schemaVersion: RESEARCH_MAP_SCHEMA_VERSION,
    sourceAudit: [],
    claims: [],
    evidence: [],
    conflicts: [],
    openQuestions: [],
    overusedAngles: [],
  };

  maps.forEach((map, sourceIndex) => {
    combined.sourceAudit.push(...map.sourceAudit.map(({ videoId, mainClaim, angle, limitations }) => ({
      videoId, mainClaim, angle, limitations,
    })));
    const claimIds = new Map(map.claims.map((claim) => [claim.id, namespacedId(sourceIndex, claim.id)]));
    const evidenceIds = new Map(map.evidence.map((item) => [item.id, namespacedId(sourceIndex, item.id)]));
    combined.claims.push(...map.claims.map((claim) => ({
      id: claimIds.get(claim.id)!,
      text: claim.text,
      status: claim.status,
      evidenceIds: claim.evidenceIds.map((id) => evidenceIds.get(id)!),
      caveats: [...claim.caveats],
    })));
    combined.evidence.push(...map.evidence.map((item) => ({
      id: evidenceIds.get(item.id)!,
      claimId: claimIds.get(item.claimId)!,
      videoId: item.videoId,
      quote: item.quote,
      relation: item.relation,
    })));
    combined.conflicts.push(...map.conflicts.map((conflict) => ({
      claimIds: conflict.claimIds.map((id) => claimIds.get(id)!),
      explanation: conflict.explanation,
    })));
    combined.openQuestions.push(...map.openQuestions);
    combined.overusedAngles.push(...map.overusedAngles);
  });
  combined.openQuestions = [...new Set(combined.openQuestions)].slice(0, 64);
  combined.overusedAngles = [...new Set(combined.overusedAngles)].slice(0, 64);

  const validated = validateResearchMap(combined, {
    packMarkdown: pack.markdown,
    videoIds: combined.sourceAudit.map((audit) => audit.videoId),
    maxBytes: MAX_RESEARCH_MAP_BYTES,
  });
  if (!validated.ok) {
    throw new Error(`Không ghép được Topic Pack (${validated.errorCode}): ${validated.reason}`);
  }
  const researchMap = validated.researchMap;
  const auditByVideo = new Map(researchMap.sourceAudit.map((audit) => [audit.videoId, audit]));
  const claimsByVideo = new Map<string, typeof researchMap.claims>();
  for (const claim of researchMap.claims) {
    const videoId = researchMap.evidence.find((item) => item.claimId === claim.id)?.videoId;
    if (!videoId) continue;
    const list = claimsByVideo.get(videoId) ?? [];
    list.push(claim);
    claimsByVideo.set(videoId, list);
  }
  const lines = [
    '# Topic Pack — VERIFIED RESEARCH OUTPUT',
    '',
    '> Sinh tự động từ các ResearchMap đã được code kiểm tra exact quote theo từng transcript.',
    '> Đây là input của STUDY; transcript gốc không được chuyển tiếp.',
  ];
  researchMap.sourceAudit.map((audit) => audit.videoId).forEach((videoId, index) => {
    const audit = auditByVideo.get(videoId)!;
    lines.push('', `## Source ${index + 1}`, '', `- videoId: \`${videoId}\``, '',
      '### Main claim', '', audit.mainClaim, '', '### Angle', '', audit.angle);
    if (audit.limitations.length) {
      lines.push('', '### Limitations', '', ...audit.limitations.map((item) => `- ${item}`));
    }
    lines.push('', '### Grounded claims');
    for (const claim of claimsByVideo.get(videoId) ?? []) {
      lines.push('', `#### ${claim.id}`, '', `- Status: ${claim.status}`, `- Claim: ${claim.text}`);
      for (const caveat of claim.caveats) lines.push(`- Caveat: ${caveat}`);
      for (const evidenceId of claim.evidenceIds) {
        const evidence = researchMap.evidence.find((item) => item.id === evidenceId)!;
        lines.push('', `Evidence ${evidence.id} (${evidence.relation}):`, '', '<quote>', evidence.quote, '</quote>');
      }
    }
  });
  if (researchMap.openQuestions.length) {
    lines.push('', '## Open questions', '', ...researchMap.openQuestions.map((item) => `- ${item}`));
  }
  if (researchMap.overusedAngles.length) {
    lines.push('', '## Overused angles', '', ...researchMap.overusedAngles.map((item) => `- ${item}`));
  }
  const markdown = `${lines.join('\n').trim()}\n`;
  const bytes = Buffer.byteLength(markdown, 'utf8');
  if (bytes > MAX_TOPIC_PACK_BYTES) {
    throw new Error(`Topic Pack sau research là ${bytes} bytes; giới hạn ${MAX_TOPIC_PACK_BYTES}`);
  }
  return { researchMap, markdown };
}

export async function persistTopicPack(input: {
  dataDir: string;
  runId: string;
  sourcePackHash: string;
  videoIds: string[];
  researchMap: ResearchMap;
  markdown: string;
}): Promise<TopicPackCheckpoint> {
  const relativeRoot = join('writer', 'research', input.runId);
  const root = join(input.dataDir, relativeRoot);
  await mkdir(root, { recursive: true });
  const researchJson = `${JSON.stringify(input.researchMap, null, 2)}\n`;
  const topicPath = join(relativeRoot, 'topic-pack.md');
  const researchMapPath = join(relativeRoot, 'research-map.json');
  await writeFile(join(input.dataDir, topicPath), input.markdown, 'utf8');
  await writeFile(join(input.dataDir, researchMapPath), researchJson, 'utf8');
  return {
    path: topicPath,
    hash: sha256(input.markdown),
    researchMapPath,
    researchMapHash: sha256(researchJson),
    sourcePackHash: input.sourcePackHash,
    videoIds: [...input.videoIds],
    createdAt: new Date().toISOString(),
  };
}

export async function readTopicPack(
  dataDir: string,
  checkpoint: TopicPackCheckpoint,
): Promise<string> {
  const markdown = await readFile(join(dataDir, checkpoint.path), 'utf8');
  if (sha256(markdown) !== checkpoint.hash) throw new Error('Topic Pack artifact không khớp hash đã pin');
  return markdown;
}

/** Exact evidence spans the legacy STUDY facts ledger is allowed to quote. */
export async function readAuthorizedTopicQuotes(
  dataDir: string,
  checkpoint: TopicPackCheckpoint,
): Promise<string[]> {
  const raw = await readFile(join(dataDir, checkpoint.researchMapPath), 'utf8');
  if (sha256(raw) !== checkpoint.researchMapHash) {
    throw new Error('ResearchMap aggregate không khớp hash đã pin');
  }
  const map = JSON.parse(raw) as ResearchMap;
  const claims = new Map(map.claims.map((claim) => [claim.id, claim]));
  return [...new Set(map.evidence
    .filter((evidence) => {
      const claim = claims.get(evidence.claimId);
      return Boolean(claim) && claim!.status !== 'REJECTED'
        && (evidence.relation === 'SUPPORTS' || evidence.relation === 'QUALIFIES');
    })
    .map((evidence) => evidence.quote))];
}
