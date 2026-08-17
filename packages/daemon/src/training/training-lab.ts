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
import { commitArtifact } from '@writer-room/pipeline-core';
import type { SpyService } from '@writer-room/spy';
import {
  toTrainingDraftView,
  validateAnalysis,
  validateCritique,
  type AnalysisArtifact,
  type AnalysisRule,
  type CritiqueArtifact,
  type CritiquePattern,
  type DraftArtifact,
  type FormulaArtifact,
} from '@writer-room/training-core';
import { DEFAULT_AGENT_IDS, type DefaultAgentId } from '../agents/defaults.ts';
import { createJobDoneNotification } from '../notifications.ts';
import type { DispatchItemResult, ItemSettledResult, LaneScheduler } from '../pipeline/lane-scheduler.ts';
import { parseAgentResultJson } from '../pipeline/parse-agent-json.ts';
import { getTrainingLabRun, saveFormula, saveTrainingLabRun } from './storage.ts';

export { DEFAULT_AGENT_IDS, type DefaultAgentId };

/** Training Lab stage ids (SDD §12a stage table) — new `stage: string` values; no
 * code elsewhere in the pipeline layer hardcodes an enum of allowed stages. */
export const DRAFT_STAGE = 'draft';
export const CRITIQUE_STAGE = 'critique';
export const REFINE_STAGE = 'refine';

/**
 * SDD §12a shipped "up to 3 rounds"; Write Loop v2 Phase 1 cuts that to 2 (and
 * lets a caller ask for 1). Evidence: across 9 real lab runs, round 3 never
 * produced a rule change that round 2 had not already produced — it produced
 * agreement. The lab's job here is narrow: surface the rules a draft cannot
 * actually execute, then stop. Convergence is not a goal (see `ruleVerdicts`).
 */
export const DEFAULT_MAX_ROUNDS = 2;

/** Hard ceiling if a caller passes something larger — the old §12a limit. */
export const MAX_ALLOWED_ROUNDS = 3;

/**
 * Absolute draft word band (Write Loop v2 Phase 1) — replaces the old
 * "~25-45% of the source video's length" band. The point of the lab draft is a
 * *compressed* piece an agent can genuinely write in one turn and a critic can
 * read whole; tying that to source length made an 18k-char source demand a
 * 2000-3000 word draft, which is a different (worse) test of the same rules.
 */
export const LAB_MIN_WORDS = 800;
export const LAB_MAX_WORDS = 1500;

/** Same generous single-page transcript fetch precedent as `orchestrator.ts`'s
 * `TRANSCRIPT_FETCH_LIMIT` — a real full-length video transcript is very unlikely
 * to exceed 2000 segments. */
const TRANSCRIPT_FETCH_LIMIT = 2000;

/** SDD §5.5 turn_key inputs — bump manually if a stage's prompt template changes. */
const DRAFT_PROMPT_VERSION = 'training-lab-draft-v5-absolute-band';
const CRITIQUE_PROMPT_VERSION = 'training-lab-critique-v3';
const REFINE_PROMPT_VERSION = 'training-lab-refine-v4-forced-choice';

/** Formula versions are plain `FormulaArtifact`s now (2026-08-10 unification):
 * `version` and `lineage.parentFormulaId` live on the base type, so the old
 * `FormulaVersion` wrapper no longer exists. Re-exported for callers/tests. */
export type FormulaVersion = FormulaArtifact;
export type { FormulaArtifact };

export interface TrainingLabRound {
  round: number;
  formulaVersionIn: FormulaVersion;
  draft: DraftArtifact | null;
  draftArtifactHash: string | null;
  critique: CritiqueArtifact | null;
  critiqueArtifactHash: string | null;
  formulaVersionOut: FormulaVersion | null;
  /** Agent's own free-text justification for each rule change this round (added
   * 2026-08-10 — previously the REFINE agent produced this per its prompt
   * instruction but the settle-listener parsed and discarded it, so the UI had no
   * way to answer "which pattern caused this rule to change". Not validated/grounded
   * like evidence — plain trust-the-agent text, same caveat as the REFINE prompt's
   * own instruction to reference pattern ids. */
  changeLog: string[] | null;
  /** Forced-choice REFINE output (Write Loop v2 Phase 1): what the refiner decided
   * to DO about each negative pattern. Null for rounds refined before this shipped. */
  ruleChanges: TrainingLabRuleChange[] | null;
  /** The other half of the forced choice: patterns the refiner explicitly declines
   * to blame on a rule ("the draft executed badly, the rule is fine"). */
  notARuleProblem: TrainingLabNotARuleProblem[] | null;
  status: 'DRAFTING' | 'CRITIQUING' | 'REFINING' | 'DONE' | 'FAILED';
  errorCode?: string;
  /** Detail from the failed stage's validator (e.g. actual vs target word count). */
  errorReason?: string;
}

/** One decision the REFINE stage made about the rule set. */
export interface TrainingLabRuleChange {
  ruleId: string;
  action: 'edit' | 'add' | 'remove' | 'narrow';
  statement: string;
  /** Critique pattern ids that justify this change — checked against the round's
   * real pattern ids, so "justified by n7" cannot be invented. */
  sourcePatternIds: string[];
}

/** A negative pattern the refiner attributes to execution, not to a rule. */
export interface TrainingLabNotARuleProblem {
  patternId: string;
  reason: string;
}

/**
 * End-of-run per-rule read-out (Write Loop v2 Phase 1). This is what the human
 * actually needs at merge time, and what 9 lab runs never produced: which rules a
 * draft could genuinely execute, and which ones only ever looked good on paper.
 *
 *  - `DROP_BEFORE_MERGE` — never applied by any draft. A rule no writer executes
 *    is not a strict rule, it is a wish.
 *  - `SUSPECT` — applied, but every round it was applied it drew a negative
 *    pattern. The human decides at merge; the lab does not delete rules.
 *  - `KEEP` — applied and not consistently harmful.
 */
export interface TrainingLabRuleVerdict {
  ruleId: string;
  statement: string;
  /** Rounds whose draft self-reported applying this rule. */
  exercised: number;
  /** Negative critique patterns pointing at this rule, across all rounds. */
  hurtCount: number;
  verdict: 'KEEP' | 'SUSPECT' | 'DROP_BEFORE_MERGE';
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
  /** Which of the 4 default agents (`DEFAULT_AGENT_IDS`) plays each role, chosen at
   * start time (2026-08-10, user: "cần có thêm setup chọn loại agent cho agent 1 và
   * agent 2"). Persisted on the run (not passed per-dispatch) because every round
   * after the first is driven by `handleTrainingLabSettle`, which only has the
   * persisted `TrainingLabRun` to read from, never the original HTTP call's params.
   * `draftAgent` = "agent 2" (viết, DRAFT stage). `critiqueAgent` = "agent 1" (chấm +
   * căn chỉnh, CRITIQUE+REFINE stages — same agent for both, per `CRITIQUE_REFINE_SESSION_GROUP`). */
  draftAgent: DefaultAgentId;
  critiqueAgent: DefaultAgentId;
  /** Filled when the run reaches DONE — see `TrainingLabRuleVerdict`. */
  ruleVerdicts?: TrainingLabRuleVerdict[];
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

async function notifyTrainingLabDone(run: TrainingLabRun, dataDir: string): Promise<void> {
  try {
    await createJobDoneNotification({
      kind: 'training-lab',
      jobId: run.id,
      title: 'Training Lab đã hoàn tất',
      detail: `${run.channelTitle || 'Formula'} · ${run.rounds.length}/${run.maxRounds} vòng`,
    }, dataDir);
  } catch (err) {
    // Completion is already durable. A notification failure must never turn a
    // successful Lab job into FAILED or trigger another agent turn.
    console.error('[notifications] không tạo được thông báo Training Lab:', (err as Error).message);
  }
}

// ── Prompts ───────────────────────────────────────────────────────────────

function buildDraftPrompt(
  formulaVersionIn: FormulaVersion,
  previousCritique: CritiqueArtifact | null,
  wordRange: { minWords: number; maxWords: number },
): string {
  /* `toTrainingDraftView` (training-core/draft-view.ts) strips evidence off the rules:
   * DRAFT composes a NEW script from them, so it should no more see per-rule
   * `evidence`/`sources`/`segmentIds` than a real Writer prompt would. It is the
   * Training-Lab draft projection ONLY — the name says so deliberately (FM1). It is
   * NOT Writer input: statements can still be source-bound, which is exactly why
   * Writer takes a migrated `WRITER_READY_PROFILE` instead (plan §1). Shared and
   * exported rather than inlined here so it stays under test — this projection has
   * had a real bug before (legacy shape returning an empty label). */
  const writerFormula = toTrainingDraftView(formulaVersionIn);
  const { minWords, maxWords } = wordRange;
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
    `## Length target: ${minWords}-${maxWords} words`,
    '',
    "This is DELIBERATELY much shorter than the source video, on purpose — the point",
    'of this exercise is to test whether you genuinely understood and can compress the',
    "Formula's rules into a small space, not to reproduce the source at full length.",
    'The band is absolute: it does NOT scale with how long the source video is.',
    'A script padded out with filler to look more complete is a WORSE test than a short,',
    'dense one that clearly shows each rule actually applied. Do not write an outline or',
    'a bullet list either — write real prose at this length, just compressed.',
    'This is checked programmatically: a script outside this range will be rejected and',
    'you will be asked to rewrite it at the right length.',
    '',
    'Word count = whitespace-separated tokens of `script` (same as JS',
    '`script.trim().split(/\\s+/).length`). Before you finish, count the words in the',
    `script you wrote and confirm it is between ${minWords} and ${maxWords}. If it is`,
    'over the max, cut filler; if under the min, expand into real prose — do not leave',
    'an out-of-range file and reply "done".',
    '',
    '## Formula rules to apply',
    '',
    ...writerFormula.rules.map((r) => `- **${r.id}**: ${r.statement}`),
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

function buildCritiquePrompt(previousNegativePatterns: CritiquePattern[]): string {
  const lines = [
    '# Training Lab — CRITIQUE stage (one video, one round)',
    '',
    'Read `input/envelope.json` in your working directory. It contains:',
    "- `transcript`: the ORIGINAL video's transcript segments, each with a unique `id` and `text`.",
    '- `formulaVersionIn`: the Formula rules the draft below was supposed to apply.',
    "- `draft`: the draft script produced this round (`title`, `script`, and its self-reported `appliedRules`).",
  ];
  if (previousNegativePatterns.length > 0) {
    lines.push("- `previousNegativePatterns`: issues flagged in the PREVIOUS round's draft.");
  }
  lines.push(
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
  );
  if (previousNegativePatterns.length > 0) {
    lines.push(
      "## Regression check (previous round's issues)",
      '',
      'For EACH item in `previousNegativePatterns` below, add one entry to a',
      '`regressionCheck` array reporting whether THIS round\'s draft fixed it:',
      '`{ "patternId": "...", "status": "fixed" | "still-present" | "partial", "note": "..." }`.',
      '`note` is a short free-text explanation (same language as the transcript). This is',
      'NOT graded against evidence — just your honest read of whether the issue recurs.',
      'Every id below MUST have exactly one `regressionCheck` entry, or the critique is',
      'rejected.',
      '',
      ...previousNegativePatterns.map((p) => `- **${p.id}**: ${p.description}`),
      '',
    );
  }
  lines.push(
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
    '  "negativePatterns": [ ]' + (previousNegativePatterns.length > 0 ? ',' : ''),
    ...(previousNegativePatterns.length > 0
      ? ['  "regressionCheck": [ { "patternId": "...", "status": "fixed", "note": "..." } ]']
      : []),
    '}',
    '```',
  );
  return lines.join('\n');
}

function buildRefinePrompt(negativePatterns: CritiquePattern[]): string {
  const forcedChoice = negativePatterns.length > 0
    ? [
      '',
      '## Forced choice — every negative pattern must be decided',
      '',
      'For EACH negative pattern id below you MUST do exactly one of two things:',
      '',
      '1. Put its id in the `sourcePatternIds` of a `ruleChanges` entry — you are',
      '   saying a rule caused it, and here is the change to that rule.',
      '2. Put it in `notARuleProblem` with a reason — you are saying the rule is fine',
      '   and the draft simply executed it badly.',
      '',
      'A pattern that appears in neither is a rejected refinement, checked',
      'programmatically. "Everything is fine" is not available: the critique already',
      'found these problems. Across 9 real runs this stage returned zero rule changes',
      'every single time; that is the behaviour this check exists to stop.',
      '',
      ...negativePatterns.map((p) => `- **${p.id}**: ${p.description}`),
      '',
      '`ruleChanges[].action` is one of `edit` | `add` | `remove` | `narrow`.',
      '`ruleChanges[].statement` is the rule text AFTER the change (for `remove`,',
      'say in one line what is being removed and why).',
      'Every `ruleChanges[].ruleId` that is not `add` must be an existing rule id.',
    ].join('\n')
    : '';
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
    'The updated set MUST contain at least one rule marked `"role": "payoff"` that',
    'describes how the source video resolves its tension, delivers its opening promise,',
    'or lands its final takeaway/reward. Ground it in evidence from the actual payoff',
    'or closing beat, not merely the opening promise. A CTA, sign-off, or disclaimer',
    'alone is not a payoff. If the current Formula omitted payoff, add that missing',
    'rule now and explain the addition in `changeLog`. This is a programmatic gate.',
    '',
    'Every change you make MUST reference which pattern(s) justified it — record this in',
    'a `changeLog` array of short free-text strings, e.g.',
    '"kept rule-1: pattern p1 confirms it works" or',
    '"dropped rule-4: pattern n2 shows the draft could not follow it".',
    forcedChoice,
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
    '{ "rules": [ { "id": "rule-1", "statement": "...", "role": "payoff", "evidence": [ { "segmentIds": ["..."], "quote": "..." } ] } ],',
    '  "changeLog": [ "..." ],',
    '  "ruleChanges": [ { "ruleId": "rule-3", "action": "narrow", "statement": "...",',
    '    "sourcePatternIds": ["n1", "n2"] } ],',
    '  "notARuleProblem": [ { "patternId": "n3", "reason": "..." } ] }',
    '```',
  ].join('\n');
}

export interface RefineOutput {
  rules: AnalysisRule[];
  changeLog?: string[];
  ruleChanges?: TrainingLabRuleChange[];
  notARuleProblem?: TrainingLabNotARuleProblem[];
}

const RULE_CHANGE_ACTIONS = new Set(['edit', 'add', 'remove', 'narrow']);

/**
 * Write Loop v2 Phase 1.3 — the forced choice.
 *
 * The grounding half of REFINE (`validateAnalysis`) already stops invented
 * evidence. It does not stop the actual failure seen in production: 9 of 9 lab
 * runs came back with `ruleChanges = 0` while their own critique listed negative
 * patterns. That is a refiner declining to decide, and it makes the whole
 * calibration loop unfalsifiable. So: every negative pattern must be assigned
 * either to a rule change or to "the rule is fine, the draft executed it badly".
 *
 * Referencing a pattern id that does not exist is also rejected — otherwise
 * coverage could be satisfied with invented ids.
 */
export function validateRefineForcedChoice(
  parsed: unknown,
  negativePatternIds: string[],
): { ok: true } | { ok: false; errorCode: string; reason: string } {
  if (negativePatternIds.length === 0) return { ok: true };
  const p = (parsed ?? {}) as Partial<RefineOutput>;
  const ruleChanges = Array.isArray(p.ruleChanges) ? p.ruleChanges : [];
  const notARuleProblem = Array.isArray(p.notARuleProblem) ? p.notARuleProblem : [];
  const known = new Set(negativePatternIds);
  const decided = new Set<string>();

  for (const [i, change] of ruleChanges.entries()) {
    if (!change || typeof change !== 'object') {
      return { ok: false, errorCode: 'REFINE_UNDECIDED', reason: `ruleChanges[${i}] is not an object` };
    }
    if (typeof change.ruleId !== 'string' || !change.ruleId.trim()) {
      return { ok: false, errorCode: 'REFINE_UNDECIDED', reason: `ruleChanges[${i}].ruleId is missing` };
    }
    if (typeof change.action !== 'string' || !RULE_CHANGE_ACTIONS.has(change.action)) {
      return {
        ok: false,
        errorCode: 'REFINE_UNDECIDED',
        reason: `ruleChanges[${i}].action must be one of edit/add/remove/narrow`,
      };
    }
    if (typeof change.statement !== 'string' || !change.statement.trim()) {
      return { ok: false, errorCode: 'REFINE_UNDECIDED', reason: `ruleChanges[${i}].statement is empty` };
    }
    if (!Array.isArray(change.sourcePatternIds) || change.sourcePatternIds.length === 0) {
      return {
        ok: false,
        errorCode: 'REFINE_UNDECIDED',
        reason: `ruleChanges[${i}] ("${change.ruleId}") cites no sourcePatternIds — say which pattern justified it`,
      };
    }
    for (const patternId of change.sourcePatternIds) {
      if (!known.has(patternId)) {
        return {
          ok: false,
          errorCode: 'REFINE_UNDECIDED',
          reason:
            `ruleChanges[${i}] cites pattern "${patternId}", which is not a negative pattern of this round `
            + `(valid ids: ${negativePatternIds.join(', ')})`,
        };
      }
      decided.add(patternId);
    }
  }

  for (const [i, entry] of notARuleProblem.entries()) {
    if (!entry || typeof entry !== 'object' || typeof entry.patternId !== 'string') {
      return { ok: false, errorCode: 'REFINE_UNDECIDED', reason: `notARuleProblem[${i}].patternId is missing` };
    }
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) {
      return {
        ok: false,
        errorCode: 'REFINE_UNDECIDED',
        reason: `notARuleProblem[${i}] ("${entry.patternId}") has an empty reason`,
      };
    }
    if (!known.has(entry.patternId)) {
      return {
        ok: false,
        errorCode: 'REFINE_UNDECIDED',
        reason: `notARuleProblem[${i}] cites pattern "${entry.patternId}", which is not a negative pattern of this round`,
      };
    }
    decided.add(entry.patternId);
  }

  const undecided = negativePatternIds.filter((id) => !decided.has(id));
  if (undecided.length > 0) {
    return {
      ok: false,
      errorCode: 'REFINE_UNDECIDED',
      reason:
        `negative pattern(s) ${undecided.join(', ')} appear in neither ruleChanges[].sourcePatternIds nor `
        + 'notARuleProblem — decide each one: change a rule, or say the rule is fine and the draft executed it badly',
    };
  }
  return { ok: true };
}

/**
 * End-of-run rule read-out. Deliberately computed from what actually happened
 * (draft self-reports + critique patterns), not from what REFINE claimed.
 */
export function computeRuleVerdicts(rounds: TrainingLabRound[]): TrainingLabRuleVerdict[] {
  const statements = new Map<string, string>();
  for (const round of rounds) {
    for (const rule of round.formulaVersionIn.rules) statements.set(rule.id, rule.statement);
    for (const rule of round.formulaVersionOut?.rules ?? []) statements.set(rule.id, rule.statement);
  }

  const verdicts: TrainingLabRuleVerdict[] = [];
  for (const [ruleId, statement] of statements) {
    let exercised = 0;
    let hurtCount = 0;
    let hurtWhileExercised = 0;
    for (const round of rounds) {
      const applied = round.draft?.appliedRules?.includes(ruleId) ?? false;
      const hurtThisRound = (round.critique?.negativePatterns ?? []).filter((p) => p.ruleId === ruleId).length;
      hurtCount += hurtThisRound;
      if (applied) {
        exercised += 1;
        if (hurtThisRound > 0) hurtWhileExercised += 1;
      }
    }
    const verdict: TrainingLabRuleVerdict['verdict'] =
      exercised === 0
        ? 'DROP_BEFORE_MERGE'
        : hurtWhileExercised === exercised
          ? 'SUSPECT'
          : 'KEEP';
    verdicts.push({ ruleId, statement, exercised, hurtCount, verdict });
  }
  return verdicts;
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

function buildRefinedVersion(formulaVersionIn: FormulaVersion, rules: AnalysisRule[], labRunId: string): FormulaVersion {
  // Carry `videoSnapshotId`/`channelTitle`/`includedArtifacts`/`warnings`/
  // `sourceBatchId` forward unchanged (SDD §12a: stable across versions within one
  // run) — only `rules`/`version`/`lineage`/`id`/`createdAt` change per version.
  return {
    ...formulaVersionIn,
    id: randomUUID(),
    origin: 'REFINED',
    version: formulaVersionIn.version + 1,
    lineage: { parentFormulaId: formulaVersionIn.id, labRunId },
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
/**
 * Length-target check, added 2026-08-10, REDESIGNED same day per the user's second
 * pass: an initial version targeted ~100% of the source's word count (fixing drafts
 * that were coming out at only 15-40% of source length, too short to compare
 * against). The user then reframed the actual goal: DRAFT is not trying to
 * reproduce the source, it is a TEST of whether the Formula's rules were extracted
 * well enough that an agent can compress them into a MUCH shorter script and still
 * apply them faithfully — "Mục tiêu là chấm formula để kiểm định lại agent đã thực
 * sự hiểu và trích xuất formula đủ chưa."
 *
 * Band history:
 * - 30-40% hard band (2026-08-10): too tight for LLM length control. A real dual-agy
 *   run wrote 2919 words against a 2050-2750 target (only ~6% over max), exhausted
 *   content-retries without rewriting, and the UI showed generic `AGENT_SCHEMA`.
 * - 25-45% accept band (2026-08-11): still clearly compressed vs full source, with
 *   enough headroom that agents can land a pass without surgical word-count edits.
 * Length failures use `DRAFT_LENGTH` (not `AGENT_SCHEMA`) so the UI can say "độ dài"
 * rather than "sai định dạng". Reuses `LaneScheduler`'s content-retry: a draft
 * outside the band is rejected with its actual word count in `reason`.
 */
function validateDraftShape(
  parsed: unknown,
  wordRange: { minWords: number; maxWords: number },
): { ok: true } | { ok: false; errorCode: string; reason: string } {
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
  const wordCount = p.script.trim().split(/\s+/).length;
  const { minWords, maxWords } = wordRange;
  if (wordCount < minWords) {
    return {
      ok: false,
      errorCode: 'DRAFT_LENGTH',
      reason: `draft.script is only ${wordCount} words — target is ${minWords}-${maxWords}. `
        + `Too short to judge; expand it into a real script, not an outline. `
        + `Overwrite out/result.json with a longer script; do not leave this file and reply "done".`,
    };
  }
  if (wordCount > maxWords) {
    return {
      ok: false,
      errorCode: 'DRAFT_LENGTH',
      reason: `draft.script is ${wordCount} words — target is ${minWords}-${maxWords}. `
        + `Too long; this is a compression test, cut it down, don't pad it out. `
        + `Overwrite out/result.json with a shorter script; do not leave this file and reply "done".`,
    };
  }
  return { ok: true };
}

/**
 * Stable across all DRAFT rounds. `interactivePty` keeps the writable TUI for this
 * clone id alive and wakes it with the next absolute-path assignment, so the writer
 * retains useful drafting context without relying on headless `exec resume`.
 */
const DRAFT_SESSION_GROUP = 'draft';

/**
 * Stable role identity for CRITIQUE and REFINE. Their transcript-sized assignments
 * deliberately set `freshContext`, so the PTY bridge replaces the critic pane before
 * each assignment instead of carrying an unbounded transcript history forward.
 */
const CRITIQUE_REFINE_SESSION_GROUP = 'critique-refine';

/**
 * Absolute band since Write Loop v2 Phase 1 (was ~25-45% of the source video's
 * word count). A rule set either survives compression to ~1k words or it does
 * not; making the target track source length only changed how much filler a long
 * source demanded. Kept as a function so callers/tests have one name to import.
 */
export function draftTargetWordRange(): { minWords: number; maxWords: number } {
  return { minWords: LAB_MIN_WORDS, maxWords: LAB_MAX_WORDS };
}

async function dispatchDraftRound(
  deps: TrainingLabDeps,
  run: TrainingLabRun,
  round: TrainingLabRound,
  previousCritique: CritiqueArtifact | null,
): Promise<void> {
  const wordRange = draftTargetWordRange();

  const envelope = { formulaVersionIn: round.formulaVersionIn, previousCritique: previousCritique ?? null };
  const dispatch = await deps.scheduler.dispatchItem({
    batchId: run.id,
    itemId: run.videoSnapshotId,
    stage: DRAFT_STAGE,
    attempt: round.round,
    // User-selectable per run ("agent 2"). All Lab stages now launch an actual
    // writable PTY and receive a short assignment message after the TUI has booted.
    templateId: run.draftAgent,
    promptMarkdown: buildDraftPrompt(round.formulaVersionIn, previousCritique, wordRange),
    envelope,
    inputHashes: [envelopeHash(envelope)],
    promptVersion: DRAFT_PROMPT_VERSION,
    sessionGroup: DRAFT_SESSION_GROUP,
    interactivePty: true,
    validateContent: (parsed) => validateDraftShape(parsed, wordRange),
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
  // "Gate" fix (2026-08-10, user: "khi agent 1 check thì cũng k có gate để verify là
  // đã sửa đúng chưa") — the previous round's negative patterns, so THIS round's
  // CRITIQUE can be asked "did the new draft actually fix these" instead of grading
  // from a blank slate every time (grok has no real memory of a prior round's
  // critique — see `DRAFT_SESSION_GROUP`'s doc comment — so this has to be passed
  // explicitly, not assumed to be "remembered").
  const previousRound = run.rounds.find((r) => r.round === round.round - 1);
  const previousNegativePatterns = previousRound?.critique?.negativePatterns ?? [];
  const previousNegativePatternIds = previousNegativePatterns.map((p) => p.id);
  const envelope = {
    transcript: envelopeSegments, formulaVersionIn: round.formulaVersionIn, draft,
    ...(previousNegativePatterns.length > 0 ? { previousNegativePatterns } : {}),
  };
  const draftScript = draft.script;

  const dispatch = await deps.scheduler.dispatchItem({
    batchId: run.id,
    itemId: run.videoSnapshotId,
    stage: CRITIQUE_STAGE,
    attempt: round.round,
    // User-selectable per run (2026-08-10, "agent 1") — see DRAFT dispatch above for
    // rationale. Distinct clone identity from DRAFT's clone is preserved automatically
    // even when both roles pick the SAME agent id: `cloneAgentId`'s `sessionGroup`
    // hash differs per group name (`draft` vs `critique-refine`) — see `agent-pool.ts`.
    templateId: run.critiqueAgent,
    promptMarkdown: buildCritiquePrompt(previousNegativePatterns),
    envelope,
    inputHashes: [envelopeHash(envelope)],
    promptVersion: CRITIQUE_PROMPT_VERSION,
    sessionGroup: CRITIQUE_REFINE_SESSION_GROUP,
    interactivePty: true,
    // Fresh critic context: the PTY bridge replaces this pane before injecting the
    // transcript-sized assignment — see `CRITIQUE_REFINE_SESSION_GROUP`.
    freshContext: true,
    validateContent: (parsed) => {
      const p = parsed as Partial<CritiqueArtifact>;
      const critique: CritiqueArtifact = {
        positivePatterns: Array.isArray(p.positivePatterns) ? p.positivePatterns : [],
        negativePatterns: Array.isArray(p.negativePatterns) ? p.negativePatterns : [],
        regressionCheck: Array.isArray(p.regressionCheck) ? p.regressionCheck : undefined,
      };
      return validateCritique(critique, segmentsById, draftScript, previousNegativePatternIds);
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
  const negativePatterns = critique.negativePatterns ?? [];
  const negativePatternIds = negativePatterns.map((p) => p.id);

  const dispatch = await deps.scheduler.dispatchItem({
    batchId: run.id,
    itemId: run.videoSnapshotId,
    stage: REFINE_STAGE,
    attempt: round.round,
    // Same agent as CRITIQUE (user-selectable "agent 1") — see CRITIQUE dispatch above.
    templateId: run.critiqueAgent,
    promptMarkdown: buildRefinePrompt(negativePatterns),
    envelope,
    inputHashes: [envelopeHash(envelope)],
    promptVersion: REFINE_PROMPT_VERSION,
    sessionGroup: CRITIQUE_REFINE_SESSION_GROUP,
    interactivePty: true,
    // Fresh critic context: the PTY bridge replaces this pane before injecting the
    // transcript-sized assignment — see `CRITIQUE_REFINE_SESSION_GROUP`.
    freshContext: true,
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
      // with the same evidence shape grounded in the same transcript.
      const grounded = validateAnalysis(analysis, segmentsById, { requirePayoff: true });
      if (!grounded.ok) return grounded;
      // Write Loop v2 Phase 1.3: grounding is not enough — the refiner must also
      // have DECIDED something about every negative pattern (see
      // `validateRefineForcedChoice`).
      return validateRefineForcedChoice(p, negativePatternIds);
    },
  });
  await handleDispatchFailure(deps, run, round, dispatch);
}

// ── Public API ───────────────────────────────────────────────────────────

export async function startTrainingLabRun(
  deps: TrainingLabDeps,
  params: {
    videoSnapshotId: string;
    startingFormula: FormulaArtifact;
    draftAgent: DefaultAgentId;
    critiqueAgent: DefaultAgentId;
    /** 1 or 2 (Write Loop v2 Phase 1); defaults to `DEFAULT_MAX_ROUNDS`. */
    maxRounds?: number;
  },
): Promise<TrainingLabRun> {
  const { videoSnapshotId, startingFormula, draftAgent, critiqueAgent } = params;
  const maxRounds = params.maxRounds === undefined
    ? DEFAULT_MAX_ROUNDS
    : Math.min(MAX_ALLOWED_ROUNDS, Math.max(1, Math.round(params.maxRounds)));
  const v1: FormulaVersion = { ...startingFormula };
  const now = new Date().toISOString();
  const channelTitle = startingFormula.channelTitle ?? '';

  const round1: TrainingLabRound = {
    round: 1,
    formulaVersionIn: v1,
    draft: null,
    draftArtifactHash: null,
    critique: null,
    critiqueArtifactHash: null,
    formulaVersionOut: null,
    changeLog: null,
    ruleChanges: null,
    notARuleProblem: null,
    status: 'DRAFTING',
  };

  const run: TrainingLabRun = {
    id: randomUUID(),
    videoSnapshotId,
    channelTitle,
    status: 'RUNNING',
    maxRounds,
    rounds: [round1],
    createdAt: now,
    updatedAt: now,
    draftAgent,
    critiqueAgent,
  };

  await saveTrainingLabRun(run, deps.dataDir);
  // Fire-and-forget, same as `runFormulaDiscovery` already does for ANALYZE — the
  // settle-listener drives everything after this dispatch returns.
  await dispatchDraftRound(deps, run, round1, null);
  return run;
}

/**
 * Recover a failed DRAFT when its interactive agent wrote `out/result.json` after
 * the bridge had already settled the turn as `AGENT_EXIT`. The recovery repeats
 * the scheduler's artifact validation/commit boundary, then continues at
 * CRITIQUE; it never re-runs or silently replaces the writer's finished draft.
 */
export async function continueTrainingLabFromSalvagedDraft(
  deps: TrainingLabDeps,
  runId: string,
): Promise<TrainingLabRun> {
  const run = await getTrainingLabRun(runId, deps.dataDir);
  if (!run) throw new Error('Training Lab run không tồn tại');

  if (run.status === 'DONE') return run;
  if (run.status === 'RUNNING') {
    throw new Error('Training Lab đang chạy — chỉ khôi phục sau khi DRAFT đã fail');
  }

  const round = [...run.rounds].reverse().find((candidate) =>
    candidate.status === 'FAILED'
      && candidate.errorCode === 'AGENT_EXIT'
      && candidate.draft === null
      && candidate.draftArtifactHash === null
  );
  if (!round) {
    throw new Error('Không có DRAFT lỗi AGENT_EXIT để khôi phục');
  }

  const itemRunDir = join(
    deps.dataDir,
    'workspaces',
    'pipeline',
    run.id,
    run.videoSnapshotId,
    'attempts',
    String(round.round),
    DRAFT_STAGE,
  );
  const resultPath = join(itemRunDir, 'out', 'result.json');
  let raw: string;
  try {
    raw = await readFile(resultPath, 'utf8');
  } catch {
    throw new Error(`Không thấy kết quả DRAFT cần khôi phục tại ${resultPath}`);
  }

  const parsedResult = parseAgentResultJson(raw);
  if (!parsedResult.ok) {
    throw new Error(`Kết quả DRAFT không phải JSON hợp lệ: ${parsedResult.error}`);
  }
  const wordRange = draftTargetWordRange();
  const shape = validateDraftShape(parsedResult.value, wordRange);
  if (!shape.ok) {
    throw new Error(`Kết quả DRAFT không qua gate: ${shape.reason}`);
  }

  const draft = parsedResult.value as DraftArtifact;
  const commit = await commitArtifact({
    runDir: itemRunDir,
    stage: DRAFT_STAGE,
    version: round.round,
    content: draft,
  });

  round.draft = draft;
  round.draftArtifactHash = commit.hash;
  round.status = 'CRITIQUING';
  delete round.errorCode;
  delete round.errorReason;
  run.status = 'RUNNING';
  run.updatedAt = new Date().toISOString();
  await saveTrainingLabRun(run, deps.dataDir);

  await dispatchCritiqueRound(deps, run, round);

  const latest = await getTrainingLabRun(runId, deps.dataDir);
  if (!latest) throw new Error('Training Lab run biến mất sau khi khôi phục');
  // `dispatchCritiqueRound` may immediately fail its admission and persist FAILED;
  // return that authoritative state rather than the optimistic state above.
  return latest;
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
    if (event.errorReason) round.errorReason = event.errorReason;
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
      const parsed = await readCommittedArtifact<RefineOutput>(deps.dataDir, event);
      const formulaVersionOut = buildRefinedVersion(round.formulaVersionIn, parsed.rules, run.id);
      round.formulaVersionOut = formulaVersionOut;
      round.changeLog = Array.isArray(parsed.changeLog) ? parsed.changeLog : null;
      round.ruleChanges = Array.isArray(parsed.ruleChanges) ? parsed.ruleChanges : null;
      round.notARuleProblem = Array.isArray(parsed.notARuleProblem) ? parsed.notARuleProblem : null;
      round.status = 'DONE';
      // 2026-08-10: a refined version is saved to the SHARED Formula store, not only
      // inside this run's log. Before this, every improvement the Training Lab made
      // was invisible to the Studio's rule pool and unusable by the Writer — the run
      // log contained the artifact instead of referencing it. The run still keeps its
      // own copy for the round-by-round history the UI shows.
      await saveFormula(formulaVersionOut, deps.dataDir);

      if (round.round < run.maxRounds) {
        const nextRound: TrainingLabRound = {
          round: round.round + 1,
          formulaVersionIn: formulaVersionOut,
          draft: null,
          draftArtifactHash: null,
          critique: null,
          critiqueArtifactHash: null,
          formulaVersionOut: null,
          changeLog: null,
          ruleChanges: null,
          notARuleProblem: null,
          status: 'DRAFTING',
        };
        run.rounds.push(nextRound);
        run.updatedAt = now;
        await saveTrainingLabRun(run, deps.dataDir);
        await dispatchDraftRound(deps, run, nextRound, round.critique);
      } else {
        run.status = 'DONE';
        // The read-out the human merges from (Write Loop v2 Phase 1.4).
        run.ruleVerdicts = computeRuleVerdicts(run.rounds);
        run.updatedAt = now;
        await saveTrainingLabRun(run, deps.dataDir);
        await notifyTrainingLabDone(run, deps.dataDir);
      }
      return;
    }
    default:
      return;
  }
}
