import { resolve } from 'node:path';

export const SCHEMA_VERSION = 2;

export type HumanGate = 'init_only' | 'every_round';
export type AgentRole = 'writer' | 'editor' | 'seo';
export type AgentSlot = 'agent-1' | 'agent-2' | 'agent-3';
export type AgentAdapter = 'claude' | 'codex' | 'gemini' | 'agy' | 'mock';

export interface AgentProfile {
  slot: AgentSlot;
  name: string;
  role: AgentRole;
  adapter: AgentAdapter;
  executable: string;
  model: string;
  args: string[];
  systemPrompt: string;
  enabled: boolean;
}
export type RunStage =
  | 'writer_init'
  | 'awaiting_human'
  | 'writer_human'
  | 'editor'
  | 'writer_revision'
  | 'awaiting_round_human'
  | 'needs_human'
  | 'seo'
  | 'complete'
  | 'failed'
  | 'cancelled';

export interface RunConfig {
  title: string;
  targetScore: number;
  maxRounds: number;
  humanGate: HumanGate;
  guidePath: string;
  criteriaPath: string;
  sourcePack: string;
  timeoutMinutes: number;
  /** Immutable snapshot: changing the global Agent tab never mutates a run. */
  agentProfiles: AgentProfile[];
}

export interface ActiveJob {
  id: string;
  jobKey: string;
  kind: string;
  role: AgentRole;
  adapter: AgentAdapter;
  attempt: number;
  startedAt: string;
  logPath: string;
  heartbeatPath: string;
  lastHeartbeatAt?: string;
  lastOutputAt?: string;
  status: 'launching' | 'running' | 'retrying' | 'interrupted';
  retryAt?: string;
}

export interface RoundScore {
  round: number;
  score: number;
  passed: boolean;
  reviewArtifact: string;
  draftArtifact: string;
}

export interface RunState {
  schemaVersion: number;
  id: string;
  tmuxSession: string;
  createdAt: string;
  updatedAt: string;
  stage: RunStage;
  config: RunConfig;
  round: number;
  scores: RoundScore[];
  currentJob?: ActiveJob;
  acceptedRound?: number;
  acceptedBy?: 'target' | 'human';
  humanOverrideReason?: string;
  error?: string;
  failedStage?: Exclude<RunStage, 'failed' | 'cancelled' | 'complete'>;
  interrupted?: boolean;
  revision?: number;
  recoveryStatus?: 'none' | 'scheduled' | 'resuming' | 'action_required';
  manualRetryRequested?: boolean;
}

export interface ChoiceOption {
  id: string;
  label: string;
  rationale: string;
}

export interface OutlineOption extends ChoiceOption {
  angle: string;
  beats: string[];
  centralQuestion: string;
  hypothesis: string;
  throughline: string;
  audiencePayoff: string;
  evidenceIds: string[];
  riskFlags: string[];
  recommended: boolean;
}

export interface HookOption extends ChoiceOption {
  angleId: string;
  text: string;
  strategy: 'scene' | 'contradiction' | 'consequence' | 'question';
  promise: string;
  openLoop: string;
  payoffBeatId: string;
  evidenceIds: string[];
  truthRisk: 'low' | 'medium' | 'high';
  clickbaitRisk: 'low' | 'medium' | 'high';
  recommended: boolean;
}

export interface InterviewQuestion {
  id: string;
  question: string;
  why: string;
  gapType: 'audience' | 'experience' | 'voice' | 'evidence';
  relatedOptionIds: string[];
}

export interface EvidenceItem {
  id: string;
  kind: 'fact' | 'quote' | 'scene' | 'number' | 'claim';
  text: string;
  sourceRef: string;
  confidence: 'low' | 'medium' | 'high';
  corroborationIds: string[];
  contradictionIds: string[];
}

export interface InsightStatement {
  id: string;
  statement: string;
  audiencePriorBelief: string;
  audienceDesireOrFear: string;
  tension: string;
  evidenceIds: string[];
  counterEvidenceIds: string[];
}

export interface WriterInitArtifact {
  draftMarkdown: string;
  evidenceLedger: EvidenceItem[];
  insightStatements: InsightStatement[];
  outlineOptions: OutlineOption[];
  hookOptions: HookOption[];
  interviewQuestions: InterviewQuestion[];
  selfNotes: string[];
}

export interface WriterDraftArtifact {
  draftMarkdown: string;
  changeLog: string[];
  appliedHumanInsights: string[];
  preservedHumanSignals: string[];
}

export interface HumanBrief {
  selectedAngleId: string;
  /** Compatibility alias for schema-v1 run artifacts. */
  selectedOutlineId: string;
  selectedHookId: string;
  customHook: string;
  answers: Record<string, string>;
  submittedAt: string;
}

export interface HumanRoundNote {
  afterRound: number;
  note: string;
  submittedAt: string;
}

export interface CriterionScore {
  criterion: string;
  score: number;
  weight: number;
  evidence: string;
  fix: string;
}

export interface EditorArtifact {
  summary: string;
  criteriaScores: CriterionScore[];
  blockingIssues: string[];
  revisionPlan: string[];
  verdict: 'pass' | 'revise';
  modelOverall?: number;
}

export interface SeoCheck {
  criterion: string;
  score: number;
  evidence: string;
  recommendation: string;
}

export interface SeoArtifact {
  score: number;
  verdict: 'strong' | 'revise_metadata' | 'risk';
  checks: SeoCheck[];
  titleSuggestions: string[];
  descriptionOutline: string[];
  keywords: string[];
  notes: string[];
}

export interface JobDescriptor {
  schemaVersion: number;
  id: string;
  runId: string;
  kind: string;
  role: AgentRole;
  adapter: AgentAdapter;
  profile?: AgentProfile;
  cwd: string;
  promptPath: string;
  resultPath: string;
  logPath: string;
  heartbeatPath: string;
  jobKey: string;
  inputHash: string;
  timeoutMs: number;
  stallTimeoutMs: number;
}

export interface JobResultEnvelope {
  schemaVersion: number;
  id: string;
  adapter: AgentAdapter;
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

export type RetryClass = 'transient' | 'repairable' | 'permanent' | 'cancelled';

export interface JobAttemptRecord {
  id: string;
  attempt: number;
  descriptorPath: string;
  resultPath: string;
  logPath: string;
  heartbeatPath: string;
  startedAt: string;
  finishedAt?: string;
  retryClass?: RetryClass;
  error?: string;
}

export interface DurableJobRecord {
  schemaVersion: number;
  jobKey: string;
  inputHash: string;
  kind: string;
  role: AgentRole;
  status: 'pending' | 'running' | 'retrying' | 'settled' | 'action_required' | 'cancelled';
  attempts: JobAttemptRecord[];
  settledResultHash?: string;
  updatedAt: string;
}

const AGENT_ROLE_BY_SLOT: Record<AgentSlot, AgentRole> = {
  'agent-1': 'writer',
  'agent-2': 'editor',
  'agent-3': 'seo',
};

const AGENT_NAME_BY_SLOT: Record<AgentSlot, string> = {
  'agent-1': 'Agent 1',
  'agent-2': 'Agent 2',
  'agent-3': 'Agent 3',
};

const DEFAULT_EXECUTABLE_BY_ADAPTER: Record<AgentAdapter, string> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  agy: 'agy',
  mock: 'mock',
};

export const AGENT_SLOTS: AgentSlot[] = ['agent-1', 'agent-2', 'agent-3'];

export function defaultAgentProfiles(): AgentProfile[] {
  return AGENT_SLOTS.map((slot, index) => ({
    slot,
    name: AGENT_NAME_BY_SLOT[slot],
    role: AGENT_ROLE_BY_SLOT[slot],
    adapter: index === 0 ? 'claude' : index === 1 ? 'codex' : 'agy',
    executable: index === 0
      ? (process.env.WRITER_ROOM_CLAUDE_BIN || 'claude')
      : index === 1
        ? (process.env.WRITER_ROOM_CODEX_BIN || 'codex')
        : (process.env.WRITER_ROOM_AGY_BIN || 'agy'),
    model: index === 2 ? 'Gemini 3.5 Flash (High)' : '',
    args: [],
    systemPrompt: '',
    enabled: true,
  }));
}

function validAdapter(value: unknown): value is AgentAdapter {
  return value === 'claude' || value === 'codex' || value === 'gemini' || value === 'agy' || value === 'mock';
}

function validRole(value: unknown): value is AgentRole {
  return value === 'writer' || value === 'editor' || value === 'seo';
}

function normalizeArgs(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.includes('\n') || item.includes('\r')) throw new Error(`${label}[${index}] must be a single-line string`);
    return item;
  }).slice(0, 40);
}

export function normalizeAgentProfiles(raw: unknown): AgentProfile[] {
  const defaults = defaultAgentProfiles();
  if (raw === undefined) return defaults;
  if (!Array.isArray(raw)) throw new Error('agentProfiles must be an array');
  const rows = new Map(raw.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('each agent profile must be an object');
    const value = item as Record<string, unknown>;
    const slot = value.slot;
    if (!AGENT_SLOTS.includes(slot as AgentSlot)) throw new Error(`invalid agent slot: ${String(slot)}`);
    return [slot as AgentSlot, value] as const;
  }));
  return AGENT_SLOTS.map((slot) => {
    const fallback = defaults.find((item) => item.slot === slot)!;
    const value = rows.get(slot) ?? {};
    const adapter = validAdapter(value.adapter) ? value.adapter : fallback.adapter;
    const role = validRole(value.role) ? value.role : fallback.role;
    const executable = typeof value.executable === 'string' && value.executable.trim()
      ? value.executable.trim() : DEFAULT_EXECUTABLE_BY_ADAPTER[adapter];
    if (/[\s\n\r]/.test(executable)) throw new Error(`${slot}.executable must be a command/path without whitespace`);
    const model = typeof value.model === 'string' ? value.model.trim().slice(0, 160) : '';
    const systemPrompt = typeof value.systemPrompt === 'string' ? value.systemPrompt.trim().slice(0, 8000) : '';
    return {
      slot,
      name: typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 80) : fallback.name,
      role,
      adapter,
      executable,
      model,
      args: normalizeArgs(value.args, `${slot}.args`),
      systemPrompt,
      enabled: value.enabled === undefined ? true : Boolean(value.enabled),
    };
  });
}

export interface RunDetails {
  state: RunState;
  initial: WriterInitArtifact | null;
  humanBrief: HumanBrief | null;
  rounds: Array<{
    round: number;
    draft: WriterDraftArtifact | null;
    review: EditorArtifact | null;
    score: number | null;
    humanNote: HumanRoundNote | null;
  }>;
  seo: SeoArtifact | null;
}

type JsonObject = Record<string, unknown>;

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function texts(value: unknown, label: string, min = 0): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const rows = value.map((item, index) => text(item, `${label}[${index}]`));
  if (rows.length < min) throw new Error(`${label} needs at least ${min} items`);
  return rows;
}

function score10(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 10) throw new Error(`${label} must be between 0 and 10`);
  return Math.round(parsed * 100) / 100;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function uniqueIds(rows: Array<{ id: string }>, label: string): void {
  const ids = new Set(rows.map((row) => row.id));
  if (ids.size !== rows.length) throw new Error(`${label} ids must be unique`);
}

function requireEvidenceIds(ids: string[], evidence: Set<string>, label: string): void {
  if (!ids.length) throw new Error(`${label} needs at least one evidence id`);
  const missing = ids.filter((id) => !evidence.has(id));
  if (missing.length) throw new Error(`${label} references missing evidence: ${missing.join(', ')}`);
}

export function normalizeConfig(raw: unknown): RunConfig {
  const value = object(raw, 'config');
  const title = text(value.title, 'title');
  const targetScore = value.targetScore === undefined ? 9 : score10(value.targetScore, 'targetScore');
  if (targetScore <= 0) throw new Error('targetScore must be greater than 0');
  const maxRounds = Math.round(Number(value.maxRounds ?? 6));
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 12) throw new Error('maxRounds must be in [1,12]');
  const humanGate = value.humanGate === 'every_round' ? 'every_round' : 'init_only';
  const guidePath = typeof value.guidePath === 'string' && value.guidePath.trim()
    ? value.guidePath.trim()
    : process.env.WRITER_ROOM_DEFAULT_GUIDE || resolve(import.meta.dir, '../prompt/kich ban youtube.txt');
  const criteriaPath = typeof value.criteriaPath === 'string' && value.criteriaPath.trim()
    ? value.criteriaPath.trim()
    : process.env.WRITER_ROOM_DEFAULT_CRITERIA || resolve(import.meta.dir, '../prompt/các tiêu chí kịch bản.txt');
  const sourcePack = typeof value.sourcePack === 'string' ? value.sourcePack.trim() : '';
  const timeoutMinutes = Math.round(Number(value.timeoutMinutes ?? 20));
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 120) {
    throw new Error('timeoutMinutes must be in [1,120]');
  }
  const agentProfiles = normalizeAgentProfiles(value.agentProfiles);
  if (agentProfiles.some((profile) => !profile.enabled)) throw new Error('all three agent profiles must be enabled for a run');
  return { title, targetScore, maxRounds, humanGate, guidePath, criteriaPath, sourcePack, timeoutMinutes, agentProfiles };
}

export function parseWriterInit(raw: unknown): WriterInitArtifact {
  const value = object(raw, 'writer init');
  const evidenceLedger = Array.isArray(value.evidenceLedger) ? value.evidenceLedger.map((row, index) => {
    const item = object(row, `evidenceLedger[${index}]`);
    return {
      id: text(item.id, `evidenceLedger[${index}].id`),
      kind: oneOf(item.kind, ['fact', 'quote', 'scene', 'number', 'claim'] as const, `evidenceLedger[${index}].kind`),
      text: text(item.text, `evidenceLedger[${index}].text`),
      sourceRef: text(item.sourceRef, `evidenceLedger[${index}].sourceRef`),
      confidence: oneOf(item.confidence, ['low', 'medium', 'high'] as const, `evidenceLedger[${index}].confidence`),
      corroborationIds: texts(item.corroborationIds ?? [], `evidenceLedger[${index}].corroborationIds`),
      contradictionIds: texts(item.contradictionIds ?? [], `evidenceLedger[${index}].contradictionIds`),
    };
  }) : [];
  if (!evidenceLedger.length || evidenceLedger.length > 200) throw new Error('writer init needs 1-200 evidence items');
  uniqueIds(evidenceLedger, 'evidenceLedger');
  const evidenceIds = new Set(evidenceLedger.map((item) => item.id));

  const insightStatements = Array.isArray(value.insightStatements) ? value.insightStatements.map((row, index) => {
    const item = object(row, `insightStatements[${index}]`);
    const parsed = {
      id: text(item.id, `insightStatements[${index}].id`),
      statement: text(item.statement, `insightStatements[${index}].statement`),
      audiencePriorBelief: text(item.audiencePriorBelief, `insightStatements[${index}].audiencePriorBelief`),
      audienceDesireOrFear: text(item.audienceDesireOrFear, `insightStatements[${index}].audienceDesireOrFear`),
      tension: text(item.tension, `insightStatements[${index}].tension`),
      evidenceIds: texts(item.evidenceIds, `insightStatements[${index}].evidenceIds`, 1),
      counterEvidenceIds: texts(item.counterEvidenceIds ?? [], `insightStatements[${index}].counterEvidenceIds`),
    };
    requireEvidenceIds(parsed.evidenceIds, evidenceIds, `insightStatements[${index}]`);
    for (const id of parsed.counterEvidenceIds) {
      if (!evidenceIds.has(id)) throw new Error(`insightStatements[${index}] references missing counter-evidence: ${id}`);
    }
    return parsed;
  }) : [];
  if (insightStatements.length < 3 || insightStatements.length > 5) throw new Error('writer init needs 3-5 insightStatements');
  uniqueIds(insightStatements, 'insightStatements');

  const outlineOptions = Array.isArray(value.outlineOptions) ? value.outlineOptions.map((row, index) => {
    const item = object(row, `outlineOptions[${index}]`);
    const parsed = {
      id: text(item.id, `outlineOptions[${index}].id`),
      label: text(item.label, `outlineOptions[${index}].label`),
      rationale: text(item.rationale, `outlineOptions[${index}].rationale`),
      angle: text(item.angle, `outlineOptions[${index}].angle`),
      beats: texts(item.beats, `outlineOptions[${index}].beats`, 3),
      centralQuestion: text(item.centralQuestion, `outlineOptions[${index}].centralQuestion`),
      hypothesis: text(item.hypothesis, `outlineOptions[${index}].hypothesis`),
      throughline: text(item.throughline, `outlineOptions[${index}].throughline`),
      audiencePayoff: text(item.audiencePayoff, `outlineOptions[${index}].audiencePayoff`),
      evidenceIds: texts(item.evidenceIds, `outlineOptions[${index}].evidenceIds`, 1),
      riskFlags: texts(item.riskFlags ?? [], `outlineOptions[${index}].riskFlags`),
      recommended: Boolean(item.recommended),
    };
    requireEvidenceIds(parsed.evidenceIds, evidenceIds, `outlineOptions[${index}]`);
    return parsed;
  }) : [];
  uniqueIds(outlineOptions, 'outlineOptions');
  const angleIds = new Set(outlineOptions.map((item) => item.id));
  const hookOptions = Array.isArray(value.hookOptions) ? value.hookOptions.map((row, index) => {
    const item = object(row, `hookOptions[${index}]`);
    const parsed = {
      id: text(item.id, `hookOptions[${index}].id`),
      label: text(item.label, `hookOptions[${index}].label`),
      rationale: text(item.rationale, `hookOptions[${index}].rationale`),
      angleId: text(item.angleId, `hookOptions[${index}].angleId`),
      text: text(item.text, `hookOptions[${index}].text`),
      strategy: oneOf(item.strategy, ['scene', 'contradiction', 'consequence', 'question'] as const, `hookOptions[${index}].strategy`),
      promise: text(item.promise, `hookOptions[${index}].promise`),
      openLoop: text(item.openLoop, `hookOptions[${index}].openLoop`),
      payoffBeatId: text(item.payoffBeatId, `hookOptions[${index}].payoffBeatId`),
      evidenceIds: texts(item.evidenceIds, `hookOptions[${index}].evidenceIds`, 1),
      truthRisk: oneOf(item.truthRisk, ['low', 'medium', 'high'] as const, `hookOptions[${index}].truthRisk`),
      clickbaitRisk: oneOf(item.clickbaitRisk, ['low', 'medium', 'high'] as const, `hookOptions[${index}].clickbaitRisk`),
      recommended: Boolean(item.recommended),
    };
    if (!angleIds.has(parsed.angleId)) throw new Error(`hookOptions[${index}] references missing angle: ${parsed.angleId}`);
    requireEvidenceIds(parsed.evidenceIds, evidenceIds, `hookOptions[${index}]`);
    if (parsed.truthRisk === 'high') throw new Error(`hookOptions[${index}] has high truth risk and is not eligible`);
    return parsed;
  }) : [];
  uniqueIds(hookOptions, 'hookOptions');
  const interviewQuestions = Array.isArray(value.interviewQuestions) ? value.interviewQuestions.map((row, index) => {
    const item = object(row, `interviewQuestions[${index}]`);
    return {
      id: text(item.id, `interviewQuestions[${index}].id`),
      question: text(item.question, `interviewQuestions[${index}].question`),
      why: text(item.why, `interviewQuestions[${index}].why`),
      gapType: oneOf(item.gapType, ['audience', 'experience', 'voice', 'evidence'] as const, `interviewQuestions[${index}].gapType`),
      relatedOptionIds: texts(item.relatedOptionIds ?? [], `interviewQuestions[${index}].relatedOptionIds`),
    };
  }) : [];
  if (outlineOptions.length !== 3) throw new Error('writer init must provide exactly 3 outlineOptions');
  if (hookOptions.length !== 6) throw new Error('writer init must provide exactly 6 hookOptions (2 per angle)');
  for (const angle of outlineOptions) {
    if (hookOptions.filter((hook) => hook.angleId === angle.id).length !== 2) throw new Error(`angle ${angle.id} needs exactly 2 hook options`);
  }
  if (interviewQuestions.length < 1 || interviewQuestions.length > 3) throw new Error('writer init needs 1-3 interviewQuestions');
  uniqueIds(interviewQuestions, 'interviewQuestions');
  return {
    draftMarkdown: text(value.draftMarkdown, 'draftMarkdown'),
    evidenceLedger,
    insightStatements,
    outlineOptions,
    hookOptions,
    interviewQuestions,
    selfNotes: texts(value.selfNotes ?? [], 'selfNotes'),
  };
}

export function parseWriterDraft(raw: unknown): WriterDraftArtifact {
  const value = object(raw, 'writer draft');
  return {
    draftMarkdown: text(value.draftMarkdown, 'draftMarkdown'),
    changeLog: texts(value.changeLog ?? [], 'changeLog'),
    appliedHumanInsights: texts(value.appliedHumanInsights ?? [], 'appliedHumanInsights'),
    preservedHumanSignals: texts(value.preservedHumanSignals ?? [], 'preservedHumanSignals'),
  };
}

export function parseEditor(raw: unknown): EditorArtifact {
  const value = object(raw, 'editor artifact');
  const criteriaScores = Array.isArray(value.criteriaScores) ? value.criteriaScores.map((row, index) => {
    const item = object(row, `criteriaScores[${index}]`);
    const weight = Number(item.weight ?? 1);
    if (!Number.isFinite(weight) || weight <= 0 || weight > 10) throw new Error(`criteriaScores[${index}].weight must be in (0,10]`);
    return {
      criterion: text(item.criterion, `criteriaScores[${index}].criterion`),
      score: score10(item.score, `criteriaScores[${index}].score`),
      weight: Math.round(weight * 100) / 100,
      evidence: text(item.evidence, `criteriaScores[${index}].evidence`),
      fix: typeof item.fix === 'string' ? item.fix.trim() : '',
    };
  }) : [];
  if (!criteriaScores.length) throw new Error('editor artifact needs at least one criterion score');
  const verdict = value.verdict === 'pass' ? 'pass' : value.verdict === 'revise' ? 'revise' : null;
  if (!verdict) throw new Error('verdict must be pass or revise');
  return {
    summary: text(value.summary, 'summary'),
    criteriaScores,
    blockingIssues: texts(value.blockingIssues ?? [], 'blockingIssues'),
    revisionPlan: texts(value.revisionPlan ?? [], 'revisionPlan'),
    verdict,
    ...(value.modelOverall === undefined ? {} : { modelOverall: score10(value.modelOverall, 'modelOverall') }),
  };
}

export function parseSeo(raw: unknown): SeoArtifact {
  const value = object(raw, 'seo artifact');
  const verdict = value.verdict === 'strong' || value.verdict === 'revise_metadata' || value.verdict === 'risk'
    ? value.verdict : null;
  if (!verdict) throw new Error('SEO verdict is invalid');
  const checks = Array.isArray(value.checks) ? value.checks.map((row, index) => {
    const item = object(row, `checks[${index}]`);
    return {
      criterion: text(item.criterion, `checks[${index}].criterion`),
      score: score10(item.score, `checks[${index}].score`),
      evidence: text(item.evidence, `checks[${index}].evidence`),
      recommendation: typeof item.recommendation === 'string' ? item.recommendation.trim() : '',
    };
  }) : [];
  if (!checks.length) throw new Error('SEO artifact needs checks');
  return {
    score: score10(value.score, 'score'),
    verdict,
    checks,
    titleSuggestions: texts(value.titleSuggestions ?? [], 'titleSuggestions'),
    descriptionOutline: texts(value.descriptionOutline ?? [], 'descriptionOutline'),
    keywords: texts(value.keywords ?? [], 'keywords'),
    notes: texts(value.notes ?? [], 'notes'),
  };
}

export function normalizeHumanBrief(raw: unknown, initial: WriterInitArtifact): HumanBrief {
  const value = object(raw, 'human brief');
  const selectedAngleId = text(value.selectedAngleId ?? value.selectedOutlineId, 'selectedAngleId');
  const selectedHookId = text(value.selectedHookId, 'selectedHookId');
  const customHook = typeof value.customHook === 'string' ? value.customHook.trim() : '';
  if (!initial.outlineOptions.some((item) => item.id === selectedAngleId)) throw new Error('selected angle does not exist');
  if (selectedHookId === 'custom') {
    if (!customHook) throw new Error('customHook is required when selectedHookId=custom');
  } else {
    const hook = initial.hookOptions.find((item) => item.id === selectedHookId);
    if (!hook) throw new Error('selected hook does not exist');
    if (hook.angleId !== selectedAngleId) throw new Error('selected hook does not belong to selected angle');
  }
  const answersValue = object(value.answers ?? {}, 'answers');
  const answers = Object.fromEntries(Object.entries(answersValue).map(([key, item]) => [key, typeof item === 'string' ? item.trim() : '']));
  return {
    selectedAngleId,
    selectedOutlineId: selectedAngleId,
    selectedHookId,
    customHook,
    answers,
    submittedAt: new Date().toISOString(),
  };
}

export function calculateEditorScore(review: EditorArtifact): number {
  const totalWeight = review.criteriaScores.reduce((sum, row) => sum + row.weight, 0);
  if (totalWeight <= 0) throw new Error('editor score has no positive weight');
  const value = review.criteriaScores.reduce((sum, row) => sum + row.score * row.weight, 0) / totalWeight;
  return Math.round(value * 100) / 100;
}

export function passesTarget(review: EditorArtifact, target: number): boolean {
  return calculateEditorScore(review) >= target && review.blockingIssues.length === 0 && review.verdict === 'pass';
}

export function safeRunId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{5,63}$/.test(value);
}

/** Extract the first complete JSON object, respecting strings and escapes. */
export function extractJson(textValue: string): unknown {
  const trimmed = textValue.trim();
  try { return JSON.parse(trimmed); } catch { /* find object below */ }
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(unfenced); } catch { /* find object below */ }
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < unfenced.length; index++) {
    const char = unfenced[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const candidate = unfenced.slice(start, index + 1);
        try { return JSON.parse(candidate); } catch { start = -1; }
      }
    }
  }
  throw new Error('agent output does not contain a valid JSON object');
}
