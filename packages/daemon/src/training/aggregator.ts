/**
 * Formula aggregation for the single-video case (SDD §6.6 AGGREGATE_FORMULA, M1
 * scope). Fired from the one-time `onItemSettled` listener registered in
 * `registerTrainingSettleListener` below — not called per-`runFormulaDiscovery`
 * call, so it never accumulates duplicate listeners across repeated dispatches
 * (see `orchestrator.ts`).
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SpyService } from '@writer-room/spy';
import { formulaFromSingleAnalysis, type AnalysisArtifact, type AnalysisRule } from '@writer-room/training-core';
import type { ItemSettledResult, LaneScheduler } from '../pipeline/lane-scheduler.ts';
import { saveFormula } from './storage.ts';

/** The Training stage machine's ANALYZE stage id (SDD §6.1 "Item stage machine"). */
export const ANALYZE_STAGE = 'analyze';

function artifactPath(dataDir: string, event: ItemSettledResult): string {
  return join(
    dataDir, 'workspaces', 'pipeline', event.batchId, event.itemId,
    'attempts', String(event.attempt), event.stage,
    'artifacts', `${event.stage}-v${event.attempt}.json`,
  );
}

/**
 * SDD §6.6 AGGREGATE_FORMULA step 2 (adapted to N=1): re-verify the committed
 * artifact's hash still matches on disk before building a Formula from it. In a
 * single daemon process this "stale" branch should never actually trigger (nothing
 * else can touch the file between commit and this listener firing), but the check
 * is cheap and documents the invariant M2's real multi-item aggregator will rely on,
 * rather than silently trusting a hash the caller already reported.
 *
 * Judgment call: the agent's `out/result.json` only ever contains `{ rules: [...] }`
 * (per the ANALYZE prompt in `orchestrator.ts` — the app never asks the agent to
 * echo back `videoSnapshotId`/`channelTitle`). `videoSnapshotId` and `channelTitle`
 * are instead reconstructed here from trusted sources (`event.itemId`, and a fresh
 * Spy snapshot lookup) rather than parsed from agent output — this is what SDD §6.1
 * step 2 means by "channel identity comes from the Spy snapshot, never from the
 * agent," applied at aggregation time as well as at preflight time.
 */
export async function aggregateSingleVideoFormula(
  deps: { dataDir: string; spy: SpyService },
  event: ItemSettledResult,
): Promise<void> {
  if (event.outcome !== 'COMMITTED' || event.stage !== ANALYZE_STAGE || !event.artifactHash) return;

  const path = artifactPath(deps.dataDir, event);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    console.error(`[training] AGGREGATION_STALE: could not re-read committed artifact at ${path}:`, (err as Error).message);
    return;
  }

  const actualHash = createHash('sha256').update(raw).digest('hex');
  if (actualHash !== event.artifactHash) {
    console.error(
      `[training] AGGREGATION_STALE: hash mismatch for ${event.itemId} `
      + `(ledger said ${event.artifactHash}, disk has ${actualHash}) — skipping Formula save`,
    );
    return;
  }

  let parsedRules: unknown;
  try {
    parsedRules = (JSON.parse(raw) as { rules?: unknown }).rules;
  } catch (err) {
    console.error(`[training] could not parse committed artifact at ${path}:`, (err as Error).message);
    return;
  }

  const snapshot = deps.spy.store.getVideoSnapshot(event.itemId);
  const analysis: AnalysisArtifact = {
    videoSnapshotId: event.itemId,
    channelTitle: snapshot?.channelTitle ?? '',
    rules: Array.isArray(parsedRules) ? (parsedRules as AnalysisRule[]) : [],
    createdAt: new Date().toISOString(),
  };

  const formula = formulaFromSingleAnalysis(analysis, {
    videoSnapshotId: event.itemId,
    analysisArtifactHash: event.artifactHash,
  }, event.batchId);
  // Display name = video title (not channel). Channel stays as filter/provenance only.
  const videoTitle = snapshot?.title?.trim() || undefined;
  if (videoTitle) {
    formula.videoTitle = videoTitle;
    formula.title = videoTitle;
  }
  await saveFormula(formula, deps.dataDir);
}

/**
 * Registers the settle listener exactly once (call from `http.ts`'s
 * `createHttpApp()`, once per daemon process — see `orchestrator.ts` doc comment
 * for why this is NOT called from inside `runFormulaDiscovery`). Returns an
 * unsubscribe function for symmetry/tests; production code never needs to call it.
 */
export function registerTrainingSettleListener(
  scheduler: LaneScheduler,
  deps: { dataDir: string; spy: SpyService },
): () => void {
  return scheduler.onItemSettled((event) => {
    void aggregateSingleVideoFormula(deps, event).catch((err) => {
      console.error('[training] aggregateSingleVideoFormula failed:', (err as Error).message);
    });
  });
}
