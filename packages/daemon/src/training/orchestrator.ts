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
import { createHash } from 'node:crypto';
import type { SpyService } from '@writer-room/spy';
import { validateAnalysis, type AnalysisArtifact, type AnalysisRule } from '@writer-room/training-core';
import type { AgentManager } from '../agents/index.ts';
import type { LaneScheduler } from '../pipeline/lane-scheduler.ts';
import { ANALYZE_STAGE } from './aggregator.ts';
import { preflightVideo, type PreflightResult } from './preflight.ts';

/** SDD §5.5 turn_key inputs — bump manually if the ANALYZE prompt template changes. */
const PROMPT_VERSION = 'training-analyze-v2';

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
    'Extract 3 to 8 concrete, evidence-backed style/content patterns from this video —',
    'observations about hooks, structure, pacing, recurring phrases, argument style, or',
    'anything else genuinely observable in the transcript. Do not force a fixed set of',
    'categories; only report patterns the transcript actually supports.',
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
    '{ "rules": [ { "id": "rule-1", "statement": "...", "evidence": [ { "segmentIds": ["..."], "quote": "..." } ] } ] }',
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
      return validateAnalysis(analysis, segmentsById);
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
