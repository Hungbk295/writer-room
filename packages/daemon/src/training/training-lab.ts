/**
 * Training Lab — the DRAFT -> CRITIQUE -> REFINE calibration loop (SDD 002 §12a,
 * added 2026-08-09, post-M1). Round-trips one video's Formula through up to
 * `maxRounds` (3) rounds of: Codex drafts a script applying the latest Formula
 * version, Claude critiques the draft against the REAL transcript (both-sided
 * grounded evidence, §12a "Grounding rule for CRITIQUE"), then Claude refines the
 * Formula's rules based on what the critique found. Every round's Formula version is
 * kept — v1, v2, v3... are never deleted (§12a "Formula versioning") — and nothing
 * here auto-promotes a version to canonical, same ADR-6 spirit `formulaFromSingleAnalysis`
 * (`training-core/validator.ts`) already follows for the M1 ANALYZE flow.
 *
 * This module does NOT re-run `ANALYZE` — `startTrainingLabRun` takes an existing,
 * already-committed `FormulaArtifact` (e.g. via `getFormula` from `storage.ts`) as
 * `version: 1` and starts the loop from there.
 *
 * Dispatch mechanism: every stage (`draft`/`critique`/`refine`) goes through the
 * EXACT SAME `LaneScheduler.dispatchItem` the M1 `ANALYZE` stage already uses
 * (`orchestrator.ts`) — no scheduler changes needed. `batchId` = this run's own
 * `id` (so every stage/round of one run shares a `batchId`, matching how
 * `dispatchItem`'s turn-key/ledger namespacing already isolates one run from
 * another); `itemId` = `videoSnapshotId`; `attempt` = the round number (1..3),
 * which is what keeps each round's turn_key distinct and each round's artifact in
 * its own `attempts/{round}/{stage}/` directory, for free, via existing infra.
 *
 * State machine: entirely driven by `registerTrainingLabSettleListener`, a single
 * `onItemSettled` subscriber that switches on `event.stage` + `event.attempt`
 * (=round) to decide what to dispatch next — exactly the pattern `aggregator.ts`'s
 * `registerTrainingSettleListener` already established for `ANALYZE`. This listener
 * and that one both subscribe to the SAME `onItemSettled` source and must each
 * ignore events they don't own (this one gates on `event.stage` being one of
 * `'draft' | 'critique' | 'refine'`, mirroring `aggregator.ts`'s
 * `event.stage === ANALYZE_STAGE` gate).
 *
 * There is no separate in-memory run registry: the listener re-reads the persisted
 * `TrainingLabRun` via `getTrainingLabRun(event.batchId, ...)` at the start of
 * handling every settle event, mutates it, and re-saves via `saveTrainingLabRun` —
 * simplest correct approach at this app's scale, avoids a stale in-memory cache.
 *
 * Judgment-call deviation from the literal task spec, documented here per
 * instructions: `startTrainingLabRun`'s `deps` includes `dataDir` (not just
 * `spy`/`scheduler`) so it can persist the freshly-created run and so tests can
 * point it at an isolated temp dir, exactly like every other Training storage call
 * in this package already does (`registerTrainingSettleListener`,
 * `aggregateSingleVideoFormula`). Without it, the initial run record would have no
 * way to reach the same data root the settle-listener reads from in a test with a
 * temp `dataDir`.
 */
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SpyService } from '@writer-room/spy';
import {
  validateAnalysis,
  validateCritique,
  type AnalysisArtifact,
  type AnalysisRule,
  type CritiqueArtifact,
  type DraftArtifact,
  type FormulaArtifact,
  type FormulaVersion,
} from '@writer-room/training-core';
import type { DispatchItemResult, ItemSettledResult, LaneScheduler } from '../pipeline/lane-scheduler.ts';
import { getTrainingLabRun, saveTrainingLabRun } from './storage.ts';

/** Training Lab stage ids (SDD §12a stage table) — new `stage: string` values; no
 * code elsewhere in the pipeline layer hardcodes an enum of allowed stages. */
export const DRAFT_STAGE = 'draft';
export const CRITIQUE_STAGE = 'critique';
export const REFINE_STAGE = 'refine';

/** SDD §12a: "up to 3 rounds total, then stops" — not user-configurable in this
 * milestone, but kept as a named constant/field on `TrainingLabRun` rather than
 * hardcoded deep in the loop logic, so a future caller CAN override it. */
export const DEFAULT_MAX_ROUNDS = 3;

/** Same generous single-page transcript fetch precedent as `orchestrator.ts`'s
 * `TRANSCRIPT_FETCH_LIMIT` — a real full-length video transcript is very unlikely
 * to exceed 2000 segments. */
const TRANSCRIPT_FETCH_LIMIT = 2000;

/** SDD §5.5 turn_key inputs — bump manually if a stage's prompt template changes. */
const DRAFT_PROMPT_VERSION = 'training-lab-draft-v1';
const CRITIQUE_PROMPT_VERSION = 'training-lab-critique-v2';
const REFINE_PROMPT_VERSION = 'training-lab-refine-v2';

/** Re-exported so callers of this module (routes, tests) don't need a second import
 * from `@writer-room/training-core` just to name the type this module builds new
 * versions of every REFINE round. */
export type { FormulaVersion };

export interface TrainingLabRound {
  round: number;
  formulaVersionIn: FormulaVersion;
  draft: DraftArtifact | null;
  draftArtifactHash: string | null;
  critique: CritiqueArtifact | null;
  critiqueArtifactHash: string | null;
  formulaVersionOut: FormulaVersion | null;
  status: 'DRAFTING' | 'CRITIQUING' | 'REFINING' | 'DONE' | 'FAILED';
  errorCode?: string;
}

export interface TrainingLabRun {
  id: string;
  videoSnapshotId: string;
  channelTitle: string;
  status: 'RUNNING' | 'DONE' | 'FAILED';
  maxRounds: number;
  rounds: TrainingLabRound[];
  createdAt: string;
  updatedAt: string;
}

interface EnvelopeSegment {
  id: string;
  index: number;
  startSec: number;
  endSec: number;
  text: string;
}

interface TrainingLabDeps {
  spy: SpyService;
  scheduler: LaneScheduler;
  dataDir: string;
}

// ── Prompts ───────────────────────────────────────────────────────────────

function buildDraftPrompt(formulaVersionIn: FormulaVersion, previousCritique: CritiqueArtifact | null): string {
  const lines: string[] = [
    '# Training Lab — DRAFT stage (one video, one round)',
    '',
    'Read `input/envelope.json` in your working directory. It contains `formulaVersionIn`',
    `(a Formula's rule set, version ${formulaVersionIn.version}) and, for round >= 2,`,
    "`previousCritique` (patterns found in the previous round's draft, or `null` for round 1).",
    '',
    "Write a NEW video script (any topic in the same general domain as the rules below,",
    "your choice) that applies as many of `formulaVersionIn.rules` as genuinely fit.",
    'Do not force a rule that does not make sense for your chosen topic.',
    '',
    '## Formula rules to apply',
    '',
    ...formulaVersionIn.rules.map((r) => `- **${r.id}**: ${r.statement}`),
  ];

  if (previousCritique && previousCritique.negativePatterns.length > 0) {
    lines.push(
      '',
      "## Avoid repeating these issues (found in the previous round's draft)",
      '',
      ...previousCritique.negativePatterns.map((p) => `- ${p.description}`),
    );
  }
  if (previousCritique && previousCritique.positivePatterns.length > 0) {
    lines.push(
      '',
      "## Keep doing these things (worked well in the previous round's draft)",
      '',
      ...previousCritique.positivePatterns.map((p) => `- ${p.description}`),
    );
  }

  lines.push(
    '',
    'Write your result as JSON to `out/result.json` in exactly this shape:',
    '',
    '```json',
    '{ "title": "...", "script": "...", "appliedRules": ["rule-1", "rule-3"] }',
    '```',
    '',
    "`appliedRules` should list the ids of the rules you actually applied — be honest,",
    'this will be checked against the script text in a later stage.',
  );

  return lines.join('\n');
}

function buildCritiquePrompt(): string {
  return [
    '# Training Lab — CRITIQUE stage (one video, one round)',
    '',
    'Read `input/envelope.json` in your working directory. It contains:',
    "- `transcript`: the ORIGINAL video's transcript segments, each with a unique `id` and `text`.",
    '- `formulaVersionIn`: the Formula rules the draft below was supposed to apply.',
    "- `draft`: the draft script produced this round (`title`, `script`, and its self-reported `appliedRules`).",
    '',
    "Compare the draft against the REAL transcript's actual style — do not trust",
    '`draft.appliedRules` at face value. Identify:',
    '- `positivePatterns`: ways the draft genuinely matches or achieves something real',
    '  about the source style.',
    '- `negativePatterns`: ways the draft deviates from, misses, or fabricates something',
    '  that is not actually characteristic of the source.',
    '',
    'Write every `description` in the SAME language as the transcript.',
    '',
    'For EVERY pattern (positive or negative), you MUST cite evidence on BOTH sides:',
    '- `sourceEvidence`: at least one `{ "segmentIds": ["..."], "quote": "..." }`.',
    '  `segmentIds` is one or more segment ids, IN TRANSCRIPT ORDER — use more than one',
    '  when the natural quote spans a segment boundary (segments are short, ~4s',
    '  auto-caption chunks and often split mid-sentence; prefer citing 2-3 consecutive',
    "  segments over a truncated quote). `quote` must be copied VERBATIM — an exact",
    "  substring of those segments' `text` values joined with a single space, in the",
    '  order you listed them.',
    '- `draftEvidence`: at least one `{ "quote": "..." }` where `quote` is copied',
    "  VERBATIM — an exact substring — from `draft.script` (no `segmentIds` needed here).",
    '',
    'This is checked programmatically: a paraphrased, summarized, or invented quote on',
    'either side will be rejected and the entire critique will fail. Copy exact',
    'characters, do not clean up punctuation or casing. A critique with zero patterns',
    'total is also rejected — you must find at least one positive or negative pattern.',
    '',
    'Write your result as JSON to `out/result.json` in exactly this shape:',
    '',
    '```json',
    '{',
    '  "positivePatterns": [ { "id": "p1", "ruleId": "rule-1", "description": "...",',
    '    "sourceEvidence": [ { "segmentIds": ["..."], "quote": "..." } ],',
    '    "draftEvidence": [ { "quote": "..." } ] } ],',
    '  "negativePatterns": [ ]',
    '}',
    '```',
  ].join('\n');
}

function buildRefinePrompt(): string {
  return [
    '# Training Lab — REFINE stage (one video, one round)',
    '',
    'Read `input/envelope.json` in your working directory. It contains:',
    "- `transcript`: the ORIGINAL video's transcript segments, each with a unique `id` and `text`.",
    '- `formulaVersionIn`: the current Formula rule set.',
    "- `critique`: this round's `positivePatterns` and `negativePatterns` (each with source",
    "  and draft evidence) about how well the draft applied `formulaVersionIn`.",
    '',
    'Produce an UPDATED rule set for the Formula. For each existing rule, decide: keep it',
    'as-is, tighten its wording, or drop it — based on which patterns support or',
    'contradict it. Propose a new rule if a strong recurring pattern is not covered by',
    'any existing rule.',
    '',
    'Every change you make MUST reference which pattern(s) justified it — record this in',
    'a `changeLog` array of short free-text strings, e.g.',
    '"kept rule-1: pattern p1 confirms it works" or',
    '"dropped rule-4: pattern n2 shows the draft could not follow it".',
    '',
    'Write every `statement` in the SAME language as the transcript.',
    '',
    'Rules must stay evidence-grounded in the ORIGINAL transcript, same as before: every',
    'rule needs at least one `{ "segmentIds": ["..."], "quote": "..." }`. `segmentIds` is',
    'one or more segment ids, IN TRANSCRIPT ORDER — use more than one when the natural',
    'quote spans a segment boundary (segments are short, ~4s auto-caption chunks and',
    'often split mid-sentence; prefer citing 2-3 consecutive segments over a truncated',
    "quote). `quote` must be copied VERBATIM — an exact substring of those segments'",
    '`text` values joined with a single space, in the order you listed them. This is',
    'checked programmatically; a paraphrased, summarized, or invented quote will be',
    'rejected and the entire refinement will fail.',
    '',
    'Write your result as JSON to `out/result.json` in exactly this shape:',
    '',
    '```json',
    '{ "rules": [ { "id": "rule-1", "statement": "...", "evidence": [ { "segmentIds": ["..."], "quote": "..." } ] } ],',
    '  "changeLog": [ "..." ] }',
    '```',
  ].join('\n');
}

// ── Helpers ───────────────────────────────────────────────────────────────

function envelopeHash(envelope: unknown): string {
  return createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
}

function fetchTranscriptSegments(spy: SpyService, videoSnapshotId: string): {
  envelopeSegments: EnvelopeSegment[];
  segmentsById: Map<string, { text: string }>;
} {
  const { segments } = spy.getTranscript(videoSnapshotId, 0, TRANSCRIPT_FETCH_LIMIT);
  const envelopeSegments: EnvelopeSegment[] = segments.map((s) => ({
    id: s.id, index: s.index, startSec: s.startSec, endSec: s.endSec, text: s.text,
  }));
  const segmentsById = new Map(envelopeSegments.map((s) => [s.id, { text: s.text }]));
  return { envelopeSegments, segmentsById };
}

/**
 * Reads a committed stage artifact off disk, same path shape `aggregator.ts`'s
 * `artifactPath` already uses (`attempts/{attempt}/{stage}/artifacts/{stage}-v{attempt}.json`),
 * with the same hash re-verification precedent (SDD §6.6 AGGREGATE_FORMULA step 2,
 * adapted). Used at three call sites in this file (after DRAFT, CRITIQUE, and REFINE
 * each settle) — factored into one helper here since all three are identical in
 * shape, but this stays local to this file rather than shared with `aggregator.ts`
 * (two modules with two slightly different needs; not worth a cross-file abstraction
 * for this).
 */
async function readCommittedArtifact<T>(dataDir: string, event: ItemSettledResult): Promise<T> {
  const path = join(
    dataDir, 'workspaces', 'pipeline', event.batchId, event.itemId,
    'attempts', String(event.attempt), event.stage,
    'artifacts', `${event.stage}-v${event.attempt}.json`,
  );
  const raw = await readFile(path, 'utf8');
  if (event.artifactHash) {
    const actualHash = createHash('sha256').update(raw).digest('hex');
    if (actualHash !== event.artifactHash) {
      throw new Error(
        `[training-lab] artifact hash mismatch for ${event.itemId}/${event.stage} v${event.attempt} `
        + `(ledger said ${event.artifactHash}, disk has ${actualHash})`,
      );
    }
  }
  return JSON.parse(raw) as T;
}

function buildRefinedVersion(formulaVersionIn: FormulaVersion, rules: AnalysisRule[]): FormulaVersion {
  // Carry `scope`/`channelGroups`/`includedArtifacts`/`warnings`/`sourceBatchId`
  // forward unchanged (SDD §12a: stable across versions within one run) — only
  // `rules`/`version`/`parentFormulaId`/`id`/`createdAt` actually change per version.
  return {
    ...formulaVersionIn,
    id: randomUUID(),
    version: formulaVersionIn.version + 1,
    parentFormulaId: formulaVersionIn.id,
    // ADR-6 hard-assert principle, same as `formulaFromSingleAnalysis`: a refined
    // Formula version is NEVER anything other than TRIAL — never auto-promoted.
    status: 'TRIAL',
    rules,
    createdAt: new Date().toISOString(),
  };
}

/**
 * After a dispatch call, if the scheduler did not actually admit the turn
 * (`status !== 'RUNNING'`), no `onItemSettled` event will ever arrive for it — so
 * nothing else would ever advance this round/run. `FAILED` dispatches (e.g. agent
 * unavailable) are handled here the same way a settled `FAILED` outcome is handled
 * elsewhere: mark the round and run FAILED and stop.
 *
 * Known, documented limitation (SDD §12a gives no guidance here, and the M1
 * `runFormulaDiscovery` precedent leaves the same case to its HTTP caller):
 * `WAITING_LANE` (lane backpressure, SDD §5.3 ADMIT) is NOT specially handled — per
 * `LaneScheduler`'s own doc comment, re-admission is the caller's job, and this
 * fire-and-forget listener has no re-admission loop. A round that hits
 * `WAITING_LANE` at dispatch time will stay stuck in its current in-progress status
 * until a future caller adds one; this is not silently swallowed, it is simply out
 * of scope for this milestone (no retry-mid-loop logic, per task instructions).
 */
async function handleDispatchFailure(
  deps: TrainingLabDeps,
  run: TrainingLabRun,
  round: TrainingLabRound,
  dispatch: DispatchItemResult,
): Promise<void> {
  if (dispatch.status !== 'FAILED') return;
  round.status = 'FAILED';
  round.errorCode = dispatch.reason ?? 'DISPATCH_FAILED';
  run.status = 'FAILED';
  run.updatedAt = new Date().toISOString();
  await saveTrainingLabRun(run, deps.dataDir);
}

// ── Stage dispatch ───────────────────────────────────────────────────────

/**
 * Shape-only sanity check for DRAFT output (added 2026-08-09, after a real run showed
 * a Codex turn commit `{"status":"blocked","reason":"..."}` — a refusal/error object,
 * NOT a draft — as if it were valid, because DRAFT previously had no check at all.
 * This is deliberately NOT a grounding check (that stays CRITIQUE's job, per §12a) —
 * just "is this even shaped like a draft" so garbage can't silently propagate into
 * CRITIQUE's envelope and produce a confusing downstream failure two stages later.
 */
function validateDraftShape(parsed: unknown): { ok: true } | { ok: false; errorCode: string; reason: string } {
  const p = parsed as Partial<DraftArtifact> | null;
  if (!p || typeof p !== 'object') {
    return { ok: false, errorCode: 'AGENT_SCHEMA', reason: 'draft output is not an object' };
  }
  if (typeof p.title !== 'string' || !p.title.trim()) {
    return { ok: false, errorCode: 'AGENT_SCHEMA', reason: 'draft.title missing or empty' };
  }
  if (typeof p.script !== 'string' || !p.script.trim()) {
    return { ok: false, errorCode: 'AGENT_SCHEMA', reason: 'draft.script missing or empty' };
  }
  return { ok: true };
}

/** Stable across all rounds of one run's DRAFT stage (SDD §12a session-continuity fix,
 * 2026-08-09) — combined with `batchId`/`itemId` (already hashed into the clone id by
 * `cloneAgentId`), this keeps the SAME clone id round over round, which is what lets
 * `TeamWorkflow`'s existing `store.resumeRef(agentId)` find and resume the prior
 * round's session (verified for real against codex-cli 0.147.0 — see
 * `docs/plans/agent-harness-architecture.md` §5.8; Grok's adapter does not wire
 * `resumeSessionRef` yet, see `dispatchDraftRound` below — a stable identity is still
 * useful there for the turnBridge single-pane-per-agent fix, §12a "Session identity").
 * "agent 2 viết bài mỗi turn không cần fresh context" — the DRAFT/writer role. */
const DRAFT_SESSION_GROUP = 'draft';

/** Stable across all rounds AND across CRITIQUE/REFINE both (added 2026-08-10, user:
 * "2 agent chạy thì chỉ chạy ở 2 session thôi" — CRITIQUE/REFINE previously only
 * shared a clone id WITHIN one round via matching `attempt`; a real 3-round run showed
 * 3 distinct identities for this role (one per round) plus DRAFT's 1 — 4 total, not
 * the 2 the user expects (one per agent ROLE, not per round). Naming this "the critic"
 * to match §12a's "agent 1 sẽ là người chấm luôn" — CRITIQUE and REFINE are the same
 * conceptual agent (the analyst who already has the transcript), just two stages. */
const CRITIQUE_REFINE_SESSION_GROUP = 'critique-refine';

async function dispatchDraftRound(
  deps: TrainingLabDeps,
  run: TrainingLabRun,
  round: TrainingLabRound,
  previousCritique: CritiqueArtifact | null,
): Promise<void> {
  const envelope = { formulaVersionIn: round.formulaVersionIn, previousCritique: previousCritique ?? null };
  const dispatch = await deps.scheduler.dispatchItem({
    batchId: run.id,
    itemId: run.videoSnapshotId,
    stage: DRAFT_STAGE,
    attempt: round.round,
    // Swapped codex -> grok 2026-08-10: Claude/Codex headless turns were repeatedly
    // hitting the (still-unresolved) heartbeat/stall watchdog bug. Grok Build CLI is a
    // separate binary/session lineage, unaffected by that bug, and its adapter
    // (`agents/adapters.ts`) is already wired for headless turns. Note: the grok
    // adapter does NOT wire `resumeSessionRef` into its CLI args (no `resume` flag
    // support built yet), so DRAFT still gets a stable clone id/agent identity across
    // rounds via `sessionGroup` below, but each round's turn currently starts fresh at
    // the CLI level rather than truly resuming a prior session.
    templateId: 'grok',
    promptMarkdown: buildDraftPrompt(round.formulaVersionIn, previousCritique),
    envelope,
    inputHashes: [envelopeHash(envelope)],
    promptVersion: DRAFT_PROMPT_VERSION,
    sessionGroup: DRAFT_SESSION_GROUP,
    validateContent: validateDraftShape,
  });
  await handleDispatchFailure(deps, run, round, dispatch);
}

async function dispatchCritiqueRound(
  deps: TrainingLabDeps,
  run: TrainingLabRun,
  round: TrainingLabRound,
): Promise<void> {
  const { envelopeSegments, segmentsById } = fetchTranscriptSegments(deps.spy, run.videoSnapshotId);
  const draft = round.draft;
  if (!draft) throw new Error('[training-lab] dispatchCritiqueRound called before round.draft was set');
  const envelope = { transcript: envelopeSegments, formulaVersionIn: round.formulaVersionIn, draft };
  const draftScript = draft.script;

  const dispatch = await deps.scheduler.dispatchItem({
    batchId: run.id,
    itemId: run.videoSnapshotId,
    stage: CRITIQUE_STAGE,
    attempt: round.round,
    // Swapped claude -> grok 2026-08-10, same reason as DRAFT above (stall bug
    // workaround). Distinct clone identity from DRAFT's grok clone is preserved
    // automatically: `cloneAgentId`'s `sessionGroup` hash differs per group name
    // (`draft` vs `critique-refine`) — see `agent-pool.ts`.
    templateId: 'grok',
    promptMarkdown: buildCritiquePrompt(),
    envelope,
    inputHashes: [envelopeHash(envelope)],
    promptVersion: CRITIQUE_PROMPT_VERSION,
    sessionGroup: CRITIQUE_REFINE_SESSION_GROUP,
    validateContent: (parsed) => {
      const p = parsed as Partial<CritiqueArtifact>;
      const critique: CritiqueArtifact = {
        positivePatterns: Array.isArray(p.positivePatterns) ? p.positivePatterns : [],
        negativePatterns: Array.isArray(p.negativePatterns) ? p.negativePatterns : [],
      };
      return validateCritique(critique, segmentsById, draftScript);
    },
  });
  await handleDispatchFailure(deps, run, round, dispatch);
}

async function dispatchRefineRound(
  deps: TrainingLabDeps,
  run: TrainingLabRun,
  round: TrainingLabRound,
): Promise<void> {
  const { envelopeSegments, segmentsById } = fetchTranscriptSegments(deps.spy, run.videoSnapshotId);
  const critique = round.critique;
  if (!critique) throw new Error('[training-lab] dispatchRefineRound called before round.critique was set');
  const envelope = { transcript: envelopeSegments, formulaVersionIn: round.formulaVersionIn, critique };

  const dispatch = await deps.scheduler.dispatchItem({
    batchId: run.id,
    itemId: run.videoSnapshotId,
    stage: REFINE_STAGE,
    attempt: round.round,
    // Swapped claude -> grok 2026-08-10 — see CRITIQUE dispatch above for rationale.
    templateId: 'grok',
    promptMarkdown: buildRefinePrompt(),
    envelope,
    inputHashes: [envelopeHash(envelope)],
    promptVersion: REFINE_PROMPT_VERSION,
    sessionGroup: CRITIQUE_REFINE_SESSION_GROUP,
    validateContent: (parsed) => {
      const p = parsed as { rules?: unknown };
      const analysis: AnalysisArtifact = {
        videoSnapshotId: run.videoSnapshotId,
        channelTitle: run.channelTitle,
        rules: Array.isArray(p.rules) ? (p.rules as AnalysisRule[]) : [],
        createdAt: new Date().toISOString(),
      };
      // Reuse the EXISTING `validateAnalysis` (training-core) rather than a
      // near-duplicate — a `FormulaVersion`'s `rules` are still `AnalysisRule[]`
      // with the same evidence shape grounded in the same transcript (SDD §12a: the
      // "every rule change must cite which pattern justified it" requirement is a
      // PROMPT instruction to the agent via `changeLog`, not a new grounding shape
      // the validator needs to check).
      return validateAnalysis(analysis, segmentsById);
    },
  });
  await handleDispatchFailure(deps, run, round, dispatch);
}

// ── Public API ───────────────────────────────────────────────────────────

export async function startTrainingLabRun(
  deps: TrainingLabDeps,
  params: { videoSnapshotId: string; startingFormula: FormulaArtifact },
): Promise<TrainingLabRun> {
  const { videoSnapshotId, startingFormula } = params;
  const v1: FormulaVersion = { ...startingFormula, version: 1, parentFormulaId: undefined };
  const now = new Date().toISOString();
  const channelTitle = startingFormula.channelGroups[0]?.channelTitle ?? '';

  const round1: TrainingLabRound = {
    round: 1,
    formulaVersionIn: v1,
    draft: null,
    draftArtifactHash: null,
    critique: null,
    critiqueArtifactHash: null,
    formulaVersionOut: null,
    status: 'DRAFTING',
  };

  const run: TrainingLabRun = {
    id: randomUUID(),
    videoSnapshotId,
    channelTitle,
    status: 'RUNNING',
    maxRounds: DEFAULT_MAX_ROUNDS,
    rounds: [round1],
    createdAt: now,
    updatedAt: now,
  };

  await saveTrainingLabRun(run, deps.dataDir);
  // Fire-and-forget, same as `runFormulaDiscovery` already does for ANALYZE — the
  // settle-listener drives everything after this dispatch returns.
  await dispatchDraftRound(deps, run, round1, null);
  return run;
}

/**
 * The single `onItemSettled` subscriber that drives the whole DRAFT -> CRITIQUE ->
 * REFINE -> (next round's DRAFT | DONE) loop. Registered exactly once per daemon
 * process (see `http.ts`, right next to `registerTrainingSettleListener`).
 */
export function registerTrainingLabSettleListener(
  scheduler: LaneScheduler,
  deps: { spy: SpyService; dataDir: string },
): () => void {
  const fullDeps: TrainingLabDeps = { spy: deps.spy, dataDir: deps.dataDir, scheduler };
  return scheduler.onItemSettled((event) => {
    if (event.stage !== DRAFT_STAGE && event.stage !== CRITIQUE_STAGE && event.stage !== REFINE_STAGE) return;
    void handleTrainingLabSettle(fullDeps, event).catch((err) => {
      console.error('[training-lab] handleTrainingLabSettle failed:', (err as Error).message);
    });
  });
}

async function handleTrainingLabSettle(deps: TrainingLabDeps, event: ItemSettledResult): Promise<void> {
  const run = await getTrainingLabRun(event.batchId, deps.dataDir);
  if (!run) return; // Not a Training Lab run (or a stray event) — ignore, same as
                     // `aggregator.ts` ignoring events outside its own stage.
  if (run.status !== 'RUNNING') return; // Already terminal — a stray late settle must not resurrect it.

  const round = run.rounds.find((r) => r.round === event.attempt);
  if (!round) return;

  const now = new Date().toISOString();

  if (event.outcome === 'FAILED') {
    round.status = 'FAILED';
    round.errorCode = event.errorCode;
    run.status = 'FAILED';
    run.updatedAt = now;
    await saveTrainingLabRun(run, deps.dataDir);
    return;
  }

  // COMMITTED.
  switch (event.stage) {
    case DRAFT_STAGE: {
      const draft = await readCommittedArtifact<DraftArtifact>(deps.dataDir, event);
      round.draft = draft;
      round.draftArtifactHash = event.artifactHash ?? null;
      round.status = 'CRITIQUING';
      run.updatedAt = now;
      await saveTrainingLabRun(run, deps.dataDir);
      await dispatchCritiqueRound(deps, run, round);
      return;
    }
    case CRITIQUE_STAGE: {
      const critique = await readCommittedArtifact<CritiqueArtifact>(deps.dataDir, event);
      round.critique = critique;
      round.critiqueArtifactHash = event.artifactHash ?? null;
      round.status = 'REFINING';
      run.updatedAt = now;
      await saveTrainingLabRun(run, deps.dataDir);
      await dispatchRefineRound(deps, run, round);
      return;
    }
    case REFINE_STAGE: {
      const parsed = await readCommittedArtifact<{ rules: AnalysisRule[]; changeLog?: string[] }>(deps.dataDir, event);
      const formulaVersionOut = buildRefinedVersion(round.formulaVersionIn, parsed.rules);
      round.formulaVersionOut = formulaVersionOut;
      round.status = 'DONE';

      if (round.round < run.maxRounds) {
        const nextRound: TrainingLabRound = {
          round: round.round + 1,
          formulaVersionIn: formulaVersionOut,
          draft: null,
          draftArtifactHash: null,
          critique: null,
          critiqueArtifactHash: null,
          formulaVersionOut: null,
          status: 'DRAFTING',
        };
        run.rounds.push(nextRound);
        run.updatedAt = now;
        await saveTrainingLabRun(run, deps.dataDir);
        await dispatchDraftRound(deps, run, nextRound, round.critique);
      } else {
        run.status = 'DONE';
        run.updatedAt = now;
        await saveTrainingLabRun(run, deps.dataDir);
      }
      return;
    }
    default:
      return;
  }
}
