/**
 * Formula Discovery orchestrator — the PREPARE -> ANALYZE -> DONE flow for ONE video
 * (SDD §6.1 "Primary Flow A", "Item stage machine (Training)" table).
 *
 * Scope note (explicit, per task instructions): the stage table also lists an
 * optional `(REVIEW)` stage (Codex, per SDD §6.1 step 5 "optional per config") and a
 * `REPAIR` stage. Neither is built here — M1's literal DoD (SDD §12) is "One video
 * produces a reviewable, provenance-linked TRIAL Formula," reviewable by a HUMAN,
 * not by Codex. Building the Codex review/repair turn, its prompt, and its budget
 * wiring now would double this milestone's scope for no M1 requirement. This file's
 * only path is PREPARE -> ANALYZE -> DONE; it does not hardcode that ANALYZE always
 * leads straight to "committed" in a way that could not grow a REVIEW branch later —
 * `runFormulaDiscovery` returns as soon as ANALYZE is dispatched, and the actual
 * "what happens when analyze settles" decision lives in the settle-listener
 * (`aggregator.ts`), which is exactly where a future REVIEW branch would be inserted
 * (branch on `event.outcome`/`event.stage` before deciding to aggregate vs. dispatch
 * REVIEW next) without restructuring this function.
 *
 * Wiring note: this module intentionally takes `{ spy, agents, scheduler }` as an
 * explicit per-call deps object rather than being wired onto `harness.ts`.
 * `harness.ts` does not hold a `SpyService` reference — that lives in
 * `packages/daemon/src/http.ts`'s `HttpApp`, constructed separately (see
 * `createHttpApp`). Inventing a cross-module dependency from `harness.ts` to
 * `SpyService` just for Training would reverse that boundary for no benefit, since
 * `http.ts` already has both `harness` and `spy` in scope together. `http.ts` is
 * therefore where the HTTP routes AND the one-time settle-listener registration
 * live (see `aggregator.ts`'s `registerTrainingSettleListener`).
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentLaunchSpec } from '@writer-room/shared';
import type { SpyService } from '@writer-room/spy';
import { validateAnalysis, type AnalysisArtifact, type AnalysisRule, type FormulaArtifact } from '@writer-room/training-core';
import type { AgentManager } from '../agents/index.ts';
import type { LaneScheduler } from '../pipeline/lane-scheduler.ts';
import { getFormula, saveFormula } from './storage.ts';
import { ANALYZE_STAGE } from './aggregator.ts';
import { preflightVideo, type PreflightResult } from './preflight.ts';

/** SDD §5.5 turn_key inputs — bump manually if the ANALYZE prompt template changes. */
const PROMPT_VERSION = 'training-analyze-v3-payoff-gate';

/**
 * Generous single-page transcript fetch limit (M1 simplification, documented
 * per task instructions rather than silently assumed): a real full-length video
 * transcript is very unlikely to exceed 2000 segments, so one page covers the
 * realistic M1 case. Full pagination-until-exhausted is a straightforward
 * follow-up (loop on `nextCursor` from `spy.getTranscript`) but is not required to
 * prove the M1 flow and is left out to avoid over-engineering a streaming reader
 * this milestone does not need.
 */
const TRANSCRIPT_FETCH_LIMIT = 2000;

export interface RunFormulaDiscoveryParams {
  batchId: string;
  videoSnapshotId: string;
  templateId?: string;
}

export interface RunFormulaDiscoveryResult {
  status: 'DISPATCHED' | 'BLOCKED' | 'WAITING_LANE' | 'FAILED';
  turnId?: number;
  blockers?: PreflightResult['blockers'];
  reason?: string;
}

interface EnvelopeSegment {
  id: string;
  index: number;
  startSec: number;
  endSec: number;
  text: string;
}

function buildAnalyzePrompt(): string {
  return [
    '# Formula Discovery — ANALYZE stage (one video)',
    '',
    'Read `input/envelope.json` in your working directory. It contains one video\'s',
    'transcript as a list of `segments`, each with a unique `id`, `index`, `startSec`,',
    '`endSec`, and `text`.',
    '',
    'Extract 4 to 10 concrete, evidence-backed style/content patterns from this video —',
    'observations about hooks, structure, pacing, recurring phrases, argument style, or',
    'anything else genuinely observable in the transcript. Do not force a fixed set of',
    'categories; only report patterns the transcript actually supports.',
    '',
    '## Required payoff coverage',
    '',
    'At least ONE rule must explain the video\'s payoff: how it resolves the tension,',
    'delivers the promise/open loop, crystallizes the takeaway, or lands the emotional',
    'or practical reward for the viewer. Mark that rule with `"role": "payoff"` and',
    'cite evidence from the actual payoff/closing beat — not from the opening promise.',
    'A CTA, channel sign-off, or disclaimer alone is NOT a payoff. If payoff and CTA',
    'are adjacent, describe the payoff separately. This requirement is checked by code;',
    'a result with no `role: "payoff"` rule is rejected.',
    '',
    'Write every `statement` in the SAME language as the transcript\'s `text` (e.g. if',
    'the transcript is Vietnamese, write the statement in Vietnamese, not English).',
    '',
    'For EVERY rule you report, cite at least one piece of evidence as',
    '`{ "segmentIds": ["..."], "quote": "..." }`. `segmentIds` is one or more segment',
    'ids, IN TRANSCRIPT ORDER — use more than one when the natural quote you want spans',
    'a segment boundary (segments are short, ~4s auto-caption chunks and often split',
    'mid-sentence; prefer citing 2-3 consecutive segments over a truncated quote).',
    '`quote` must be copied VERBATIM — an exact substring of those segments\' `text`',
    'values joined with a single space, in the order you listed them. This is checked',
    'programmatically against the pinned transcript: a paraphrased, summarized, or',
    'invented quote will be rejected and the entire analysis will fail. Copy the exact',
    'characters from the segment text, do not clean up punctuation or casing.',
    '',
    'Write your result as JSON to `out/result.json` in exactly this shape:',
    '',
    '```json',
    '{ "rules": [ { "id": "rule-1", "statement": "...", "role": "payoff", "evidence": [ { "segmentIds": ["..."], "quote": "..." } ] } ] }',
    '```',
  ].join('\n');
}

export async function runFormulaDiscovery(
  deps: { spy: SpyService; agents: AgentManager; scheduler: LaneScheduler },
  params: RunFormulaDiscoveryParams,
): Promise<RunFormulaDiscoveryResult> {
  const { spy, agents, scheduler } = deps;
  const { batchId, videoSnapshotId } = params;
  const templateId = params.templateId ?? 'claude';

  // Step 1: preflight (SDD §6.1 step 3 — "Preflight runs before the Start button
  // enables"). Never dispatch a blocked video.
  const preflight = await preflightVideo(spy, agents, videoSnapshotId);
  if (!preflight.ready) {
    return { status: 'BLOCKED', blockers: preflight.blockers };
  }

  // Step 2 — PREPARE (app-owned, SDD §6.1 stage table): fetch the transcript and
  // build the envelope the ANALYZE prompt will reference.
  const { segments } = spy.getTranscript(videoSnapshotId, 0, TRANSCRIPT_FETCH_LIMIT);
  const envelopeSegments: EnvelopeSegment[] = segments.map((s) => ({
    id: s.id, index: s.index, startSec: s.startSec, endSec: s.endSec, text: s.text,
  }));
  const channelTitle = preflight.channelTitle ?? '';
  const envelope = { videoSnapshotId, channelTitle, segments: envelopeSegments };
  const segmentsById = new Map(envelopeSegments.map((s) => [s.id, { text: s.text }]));

  // Step 4: input hash — pins the exact transcript content dispatched, so the
  // turn_key changes if the pinned transcript ever changes (SDD §5.5).
  const contentHash = createHash('sha256').update(JSON.stringify(envelopeSegments)).digest('hex');

  // Step 5: dispatch ANALYZE with the grounding validator wired in (SDD §5.2
  // commit-rule Branch 4, closed by `LaneScheduler`'s new `validateContent` hook).
  const dispatch = await scheduler.dispatchItem({
    batchId,
    itemId: videoSnapshotId,
    stage: ANALYZE_STAGE,
    attempt: 1,
    templateId,
    promptMarkdown: buildAnalyzePrompt(),
    envelope,
    inputHashes: [contentHash],
    promptVersion: PROMPT_VERSION,
    validateContent: (parsed) => {
      const rules = (parsed as { rules?: unknown }).rules;
      const analysis: AnalysisArtifact = {
        videoSnapshotId,
        channelTitle,
        rules: Array.isArray(rules) ? (rules as AnalysisRule[]) : [],
        createdAt: new Date().toISOString(),
      };
      return validateAnalysis(analysis, segmentsById, { requirePayoff: true });
    },
  });

  if (dispatch.status === 'RUNNING') {
    return { status: 'DISPATCHED', turnId: dispatch.turnId };
  }
  if (dispatch.status === 'WAITING_LANE') {
    return { status: 'WAITING_LANE', reason: dispatch.reason };
  }
  return { status: 'FAILED', reason: dispatch.reason };
}

// ── Interactive (PTY) Formula Discovery — semi-auto path (2026-08-10) ──────
//
// User request: headless `-p` one-shot turns always self-terminate the CLI process,
// which is required for the automatic pipeline commit-rule to work at all (a bug
// found earlier the same day — Grok's bare positional prompt launched an
// INTERACTIVE session that never exited, hanging the pipeline forever — is the
// exact failure mode a real interactive session has by design). The user does not
// want that automatic path for ANALYZE; they want a REAL interactive terminal they
// (or the agent) can drive by hand, with no auto-completion — mirroring their own
// prior "semi-auto" pattern from the sibling repo dna-spy: starting the session
// pre-creates a placeholder Formula (status `DRAFT`, empty `rules`) in the Formula
// tab immediately, and that Formula's own page carries an "Import" action the user
// clicks once the interactive session is done — see `importFormulaDiscoveryResult`
// below. This intentionally does NOT go through `LaneScheduler`/the settle-listener
// at all: there is no turn_key, no ledger row, no automatic commit-rule — the only
// automation is (a) staging `input/envelope.json` + `prompt.md` in a scratch dir and
// (b) launching that agent's REAL interactive session (`AgentManager.prepareLaunch`,
// the exact same call the Agents page's "Launch" button uses) pointed at that dir.

/** Same "write here, nothing else" pointer `LaneScheduler` appends to every
 * pipeline `prompt.md` (`lane-scheduler.ts`'s `STANDING_POINTER`) — duplicated
 * rather than imported since this path deliberately does NOT depend on the
 * pipeline module (no ledger, no turn_key, nothing pipeline-shaped here). */
const MANUAL_STANDING_POINTER =
  'Write your result to out/result.json. Do not write anywhere else. If out/result.json '
  + 'already exists from a rejected attempt, overwrite it with a corrected version. '
  + 'Reply "done" only after the corrected file is written.';

function manualAnalyzeDir(dataDir: string, formulaId: string): string {
  return join(dataDir, 'workspaces', 'manual-analyze', formulaId);
}

export interface StartInteractiveFormulaDiscoveryParams {
  videoSnapshotId: string;
  templateId: string;
}

export interface StartInteractiveFormulaDiscoveryResult {
  status: 'STARTED' | 'BLOCKED' | 'FAILED';
  formulaId?: string;
  launchSpec?: AgentLaunchSpec;
  /** Short instruction text the client sends into the freshly-opened PTY pane
   * (`terminals.termWrite`) right after launch — deliberately NOT the full ANALYZE
   * prompt itself (pasting a long multi-line prompt as simulated keystrokes into a
   * TUI is fragile across CLIs); the agent is told to go read the real prompt from
   * `prompt.md`, exactly what already sits in its cwd. */
  initialMessage?: string;
  blockers?: PreflightResult['blockers'];
  reason?: string;
}

export async function startInteractiveFormulaDiscovery(
  deps: { spy: SpyService; agents: AgentManager; dataDir: string },
  params: StartInteractiveFormulaDiscoveryParams,
): Promise<StartInteractiveFormulaDiscoveryResult> {
  const { spy, agents, dataDir } = deps;
  const { videoSnapshotId, templateId } = params;

  const preflight = await preflightVideo(spy, agents, videoSnapshotId);
  if (!preflight.ready) {
    return { status: 'BLOCKED', blockers: preflight.blockers };
  }
  const channelTitle = preflight.channelTitle ?? '';
  // Display name = video title (not channel). Channel is provenance/filter only.
  const snapshot = spy.store.getVideoSnapshot(videoSnapshotId);
  const videoTitle = snapshot?.title?.trim() || undefined;

  const { segments } = spy.getTranscript(videoSnapshotId, 0, TRANSCRIPT_FETCH_LIMIT);
  const envelopeSegments: EnvelopeSegment[] = segments.map((s) => ({
    id: s.id, index: s.index, startSec: s.startSec, endSec: s.endSec, text: s.text,
  }));
  const envelope = { videoSnapshotId, channelTitle, segments: envelopeSegments };

  // Placeholder Formula (SDD §7.7-adjacent, `FormulaStatus.DRAFT` — previously only
  // used by Studio's compound-rule flow, now also the "waiting for manual import"
  // marker here): created up front so it shows up in the Formula tab immediately,
  // named after the video, with an obvious "not real yet" status badge.
  const formula: FormulaArtifact = {
    id: randomUUID(),
    status: 'DRAFT',
    origin: 'ANALYZED',
    version: 1,
    videoSnapshotId,
    channelTitle,
    ...(videoTitle ? { videoTitle, title: videoTitle } : {}),
    rules: [],
    includedArtifacts: [],
    lineage: {},
    warnings: ['Đang chờ import kết quả từ phiên PTY tương tác — mở phiên, chạy xong, bấm "Import kết quả" trên trang này.'],
    createdAt: new Date().toISOString(),
  };
  await saveFormula(formula, dataDir);

  const workDir = manualAnalyzeDir(dataDir, formula.id);
  await mkdir(join(workDir, 'input'), { recursive: true });
  await mkdir(join(workDir, 'out'), { recursive: true });
  await writeFile(join(workDir, 'input', 'envelope.json'), JSON.stringify(envelope, null, 2), 'utf8');
  const promptContent = `${buildAnalyzePrompt().trimEnd()}\n\n---\n\n${MANUAL_STANDING_POINTER}\n`;
  await writeFile(join(workDir, 'prompt.md'), promptContent, 'utf8');

  let launchSpec: AgentLaunchSpec;
  try {
    launchSpec = await agents.prepareLaunch(templateId, workDir);
  } catch (err) {
    return { status: 'FAILED', reason: err instanceof Error ? err.message : String(err) };
  }

  return {
    status: 'STARTED',
    formulaId: formula.id,
    launchSpec,
    initialMessage: 'Read prompt.md and input/envelope.json in this directory, follow the instructions in prompt.md, then write your result to out/result.json.',
  };
}

export interface ImportFormulaDiscoveryResultParams {
  formulaId: string;
}

export type ImportFormulaDiscoveryResult =
  | { status: 'IMPORTED'; formula: FormulaArtifact }
  | { status: 'NOT_DRAFT'; reason: string }
  | { status: 'NO_OUTPUT'; reason: string }
  | { status: 'INVALID'; reason: string };

/**
 * Reads `out/result.json` from the scratch dir the interactive session was pointed
 * at, validates it with the SAME grounding gate the automatic pipeline path uses
 * (`validateAnalysis`), and finalizes the placeholder Formula in place — SAME `id`,
 * so any link the user already has to this Formula's page keeps working, and the
 * Formula tab does not end up with a duplicate entry.
 */
export async function importFormulaDiscoveryResult(
  deps: { spy: SpyService; dataDir: string },
  params: ImportFormulaDiscoveryResultParams,
): Promise<ImportFormulaDiscoveryResult> {
  const { spy, dataDir } = deps;
  const { formulaId } = params;

  const draft = await getFormula(formulaId, dataDir);
  if (!draft) return { status: 'NOT_DRAFT', reason: 'Formula không tồn tại' };
  if (draft.status !== 'DRAFT') {
    return { status: 'NOT_DRAFT', reason: 'Formula này đã import rồi (không còn ở trạng thái DRAFT)' };
  }
  const videoSnapshotId = draft.videoSnapshotId;
  if (!videoSnapshotId) return { status: 'NOT_DRAFT', reason: 'Formula thiếu videoSnapshotId' };

  const workDir = manualAnalyzeDir(dataDir, formulaId);
  let raw: string;
  try {
    raw = await readFile(join(workDir, 'out', 'result.json'), 'utf8');
  } catch {
    return { status: 'NO_OUTPUT', reason: 'Chưa thấy out/result.json trong thư mục làm việc — phiên đã ghi kết quả chưa?' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'INVALID', reason: 'out/result.json không phải JSON hợp lệ' };
  }

  const { segments } = spy.getTranscript(videoSnapshotId, 0, TRANSCRIPT_FETCH_LIMIT);
  const segmentsById = new Map(segments.map((s) => [s.id, { text: s.text }]));
  const rules = (parsed as { rules?: unknown }).rules;
  const analysis: AnalysisArtifact = {
    videoSnapshotId,
    channelTitle: draft.channelTitle ?? '',
    rules: Array.isArray(rules) ? (rules as AnalysisRule[]) : [],
    createdAt: new Date().toISOString(),
  };
  // Interactive import must enforce the same completeness gate as the automatic
  // ANALYZE path; otherwise the manual route could still persist payoff-less Formulas.
  const validation = validateAnalysis(analysis, segmentsById, { requirePayoff: true });
  if (!validation.ok) {
    return { status: 'INVALID', reason: validation.reason };
  }

  const artifactHash = createHash('sha256').update(raw).digest('hex');
  const finalized: FormulaArtifact = {
    ...draft,
    status: 'TRIAL',
    rules: analysis.rules,
    includedArtifacts: [{ videoSnapshotId, analysisArtifactHash: artifactHash }],
    warnings: ['LOW_SAMPLE: Formula built from 1 video — TRIAL only, not statistically validated'],
  };
  await saveFormula(finalized, dataDir);
  return { status: 'IMPORTED', formula: finalized };
}
