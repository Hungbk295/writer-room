/**
 * Formula Studio — SYNTHESIZE stage (SDD §12b, ADR-13, P3, added 2026-08-10).
 *
 * The first (and, for this phase, only) point where the Studio spends a token: ONE
 * bounded LLM turn per session that proposes a merged, GENERIC statement for EVERY
 * cluster the human has picked — `SINGLE` clusters included (see `studio.ts`'s
 * `rebuildCompound` doc comment for why `SINGLE` is no longer auto-carried). The
 * prompt ships only cluster ids + member statements — no transcript, no evidence —
 * so the envelope stays tiny regardless of how many videos the picks span.
 *
 * Dispatch mechanics deliberately mirror `training-lab.ts`'s
 * `LaneScheduler.dispatchItem` + `onItemSettled` pattern (same file this task's brief
 * points at as the template), simplified for a single one-shot turn instead of a
 * multi-round loop — the closer precedent is actually `orchestrator.ts`'s ANALYZE
 * dispatch (also one turn, no rounds), just replayed here with a settle LISTENER
 * (rather than aggregating inline) because the caller (`http.ts`) has no synchronous
 * access to the turn's result — same reason `training-lab.ts` needs one.
 *
 * The LLM never commits anything (ADR-13): its output becomes `RuleProposal`s with
 * `decision: 'PENDING'`, and `sources` is always derived by THIS file from the
 * cluster's own members — never taken from the model's output — so a hallucinated or
 * malformed source can never enter a compound Formula's provenance.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateCompoundRule, type CompoundRule, type RuleCluster } from '@writer-room/training-core';
import type { DefaultAgentId } from '../agents/defaults.ts';
import type { DispatchItemResult, ItemSettledResult, LaneScheduler } from '../pipeline/lane-scheduler.ts';
import { getStudioSession, saveStudioSession, sourceOf, type RuleProposal, type StudioSession } from './studio.ts';

/** The Studio's SYNTHESIZE stage id — distinct from Training Lab's `draft`/
 * `critique`/`refine` (`training-lab.ts`) and M1's `analyze` (`aggregator.ts`), so
 * every settle listener can keep ignoring events it does not own by checking `stage`
 * alone, same convention those two files already established. */
export const SYNTHESIZE_STAGE = 'synthesize';

/** SYNTHESIZE dispatches ONE turn for the WHOLE session, not one per video/item —
 * `batchId` (= the session id) already scopes it uniquely, so `itemId` only needs to
 * be a stable constant, never read as a real id anywhere (contrast with
 * `training-lab.ts`'s `itemId = videoSnapshotId`, which IS meaningful there). */
export const SYNTHESIZE_ITEM_ID = 'proposals';

/** SDD §5.5 turn_key inputs — bump manually if the SYNTHESIZE prompt template changes. */
const SYNTHESIZE_PROMPT_VERSION = 'studio-synthesize-v1';

/** No per-role picker in the UI for this phase (unlike Training Lab's draft/critique
 * agent choice) — SYNTHESIZE has no transcript and no stall-prone envelope, so any
 * default agent is fine; 'claude' matches ANALYZE's (`orchestrator.ts`) default. */
const DEFAULT_SYNTHESIZE_AGENT: DefaultAgentId = 'claude';

interface SynthesizeEnvelopeCluster {
  id: string;
  kind: RuleCluster['kind'];
  statements: string[];
}

function envelopeHash(envelope: unknown): string {
  return createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
}

function buildEnvelope(clusters: RuleCluster[]): { clusters: SynthesizeEnvelopeCluster[] } {
  return {
    clusters: clusters.map((c) => ({
      id: c.id,
      kind: c.kind,
      statements: c.members.map((m) => m.statement),
    })),
  };
}

function buildSynthesizePrompt(clusters: RuleCluster[]): string {
  const lines = [
    '# Formula Studio — SYNTHESIZE stage (one turn, every cluster in the session)',
    '',
    'Read `input/envelope.json`. It lists every rule cluster the human has picked into',
    'this Studio session — each cluster has an `id`, a `kind` (`SIMILAR` = several',
    'near-duplicate rules from different videos, `SINGLE` = one rule nothing else',
    'resembled), and the `statements` of the rule(s) inside it.',
    '',
    'For EVERY cluster listed, propose ONE merged `statement` that is as GENERIC as',
    'possible: strip topic nouns, quoted verbatim phrases copied from one specific',
    'video, and numbers/timestamps tied to that one video — keep only the reusable',
    'TECHNIQUE. A writer applying this rule to a brand-new, unrelated topic must be',
    'able to follow it without ever having seen the original video(s).',
    '',
    'Example: "Đặt tên ẩn dụ riêng cho một khái niệm tài chính (\\"thuế ở lại thành',
    'phố\\") rồi lặp lại" -> "Đặt tên ẩn dụ riêng cho khái niệm cốt lõi rồi lặp lại',
    'xuyên bài như nhãn nhận diện".',
    '',
    'This applies EQUALLY to `SINGLE` clusters. A `SINGLE` cluster has nothing else to',
    'compare against, but it still needs genericizing — do not just copy its one',
    'statement back verbatim; use your own judgment about what is technique vs. what',
    'is specific to that one video/topic.',
    '',
    "Write every `statement` in the SAME language as the input statements' language.",
    '',
    'Write your result as JSON to `out/result.json` in exactly this shape:',
    '',
    '```json',
    '{ "proposals": [ { "clusterId": "...", "statement": "..." } ] }',
    '```',
    '',
    'Include exactly one entry per cluster id below, using each id VERBATIM:',
    '',
    ...clusters.map(
      (c) => `- **${c.id}** (${c.kind}): ${c.members.map((m) => `"${m.statement}"`).join('; ')}`,
    ),
  ];
  return lines.join('\n');
}

/**
 * Shape-only sanity check (same spirit as `training-lab.ts`'s `validateDraftShape`):
 * just "is this even shaped like a proposals list", NOT grounding. Per-proposal
 * grounding (unknown clusterId, empty statement) is deliberately NOT checked here —
 * failing the WHOLE turn over one bad entry among many would throw away every other
 * cluster's good proposal for no reason. That filtering happens per-item in
 * `handleSynthesizeSettle`, after commit, which can accept the good ones and only
 * skip+log the bad one.
 */
function validateSynthesizeShape(parsed: unknown): { ok: true } | { ok: false; errorCode: string; reason: string } {
  const p = parsed as { proposals?: unknown } | null;
  if (!p || typeof p !== 'object') {
    return { ok: false, errorCode: 'AGENT_SCHEMA', reason: 'synthesize output is not an object' };
  }
  if (!Array.isArray(p.proposals) || p.proposals.length === 0) {
    return { ok: false, errorCode: 'AGENT_SCHEMA', reason: 'proposals missing or empty' };
  }
  return { ok: true };
}

interface SynthesizeDeps {
  scheduler: LaneScheduler;
  dataDir: string;
}

async function dispatchSynthesizeTurn(
  deps: SynthesizeDeps,
  session: StudioSession,
  attempt: number,
  templateId: DefaultAgentId,
): Promise<DispatchItemResult> {
  const envelope = buildEnvelope(session.clusters);
  return deps.scheduler.dispatchItem({
    batchId: session.id,
    itemId: SYNTHESIZE_ITEM_ID,
    stage: SYNTHESIZE_STAGE,
    attempt,
    templateId,
    promptMarkdown: buildSynthesizePrompt(session.clusters),
    envelope,
    inputHashes: [envelopeHash(envelope)],
    promptVersion: SYNTHESIZE_PROMPT_VERSION,
    validateContent: validateSynthesizeShape,
  });
}

/**
 * Kicks off ONE SYNTHESIZE turn for a session and returns the (immediately) updated
 * session with `synthesizeStatus: 'RUNNING'`. The actual proposals arrive later via
 * `handleSynthesizeSettle` re-reading and re-saving the session — same
 * read-mutate-save-around-every-step idiom `studio.ts` already uses throughout, no
 * in-memory run registry.
 *
 * Safe to call again on a session that already has proposals: existing proposals
 * (any decision, including `PENDING`) are never touched — see
 * `handleSynthesizeSettle` — so re-running after picking MORE rules only produces
 * proposals for the newly-formed clusters.
 */
export async function startStudioSynthesize(
  deps: SynthesizeDeps,
  session: StudioSession,
  templateId: DefaultAgentId = DEFAULT_SYNTHESIZE_AGENT,
): Promise<StudioSession> {
  if (session.clusters.length === 0) {
    throw new Error('Chưa có rule nào được chọn — không có cụm nào để ghép');
  }
  if (session.synthesizeStatus === 'RUNNING') {
    throw new Error('Đang có một lượt ghép chạy rồi — đợi lượt đó xong');
  }

  const attempt = session.synthesizeAttempt + 1;
  session.synthesizeAttempt = attempt;
  session.synthesizeStatus = 'RUNNING';
  session.synthesizeError = undefined;
  await saveStudioSession(session, deps.dataDir);

  const dispatch = await dispatchSynthesizeTurn(deps, session, attempt, templateId);
  // If the scheduler never actually admitted the turn (`WAITING_LANE`/`FAILED`), no
  // `onItemSettled` event will ever arrive for it — same known gap `training-lab.ts`
  // documents for its own `handleDispatchFailure` (no re-admission loop this phase).
  if (dispatch.status !== 'RUNNING') {
    session.synthesizeStatus = 'FAILED';
    session.synthesizeError = dispatch.reason ?? 'DISPATCH_FAILED';
    await saveStudioSession(session, deps.dataDir);
  }
  return session;
}

/** Same committed-artifact re-read + hash re-verification precedent as
 * `training-lab.ts`'s `readCommittedArtifact` — kept as a local copy rather than a
 * shared helper (that file is off-limits per this task's boundary, and the two
 * modules' needs are nearly but not exactly identical: this one has no per-round
 * indexing). */
async function readCommittedSynthesizeArtifact(
  dataDir: string,
  event: ItemSettledResult,
): Promise<{ proposals?: unknown }> {
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
        `[studio-synthesize] artifact hash mismatch for ${event.itemId}/${event.stage} v${event.attempt} `
        + `(ledger said ${event.artifactHash}, disk has ${actualHash})`,
      );
    }
  }
  return JSON.parse(raw) as { proposals?: unknown };
}

async function handleSynthesizeSettle(deps: SynthesizeDeps, event: ItemSettledResult): Promise<void> {
  const session = await getStudioSession(event.batchId, deps.dataDir);
  if (!session) return; // Not a Studio session's batchId (or a stray event) — ignore.
  // A session can only ever have ONE synthesize attempt in flight at a time
  // (`startStudioSynthesize`'s RUNNING guard) — an event for any other attempt is
  // stale (e.g. a very late settle after the caller moved on) and must not overwrite
  // newer state.
  if (event.attempt !== session.synthesizeAttempt) return;

  if (event.outcome === 'FAILED') {
    session.synthesizeStatus = 'FAILED';
    session.synthesizeError = event.errorCode ?? 'SYNTHESIZE_FAILED';
    await saveStudioSession(session, deps.dataDir);
    return;
  }

  const artifact = await readCommittedSynthesizeArtifact(deps.dataDir, event);
  const proposalsRaw = Array.isArray(artifact.proposals) ? artifact.proposals : [];
  const clustersById = new Map(session.clusters.map((c) => [c.id, c]));
  // Clusters that already have a proposal (ANY decision — PENDING/ACCEPTED/REJECTED)
  // are skipped: re-synthesizing must never clobber a human's prior decision, or even
  // silently replace an untouched PENDING one from the outcome of an EARLIER attempt.
  const alreadyProposed = new Set(session.proposals.map((p) => p.clusterId));

  const added: RuleProposal[] = [];
  for (const raw of proposalsRaw) {
    const entry = raw as { clusterId?: unknown; statement?: unknown };
    const clusterId = typeof entry.clusterId === 'string' ? entry.clusterId : '';
    const statement = typeof entry.statement === 'string' ? entry.statement.trim() : '';

    const cluster = clustersById.get(clusterId);
    if (!cluster) {
      // "LLM trả clusterId không tồn tại trong session -> bỏ qua, ghi log, không tạo
      // proposal ma" — the model hallucinating an id must never fabricate a proposal
      // with no real cluster/sources behind it.
      console.error(`[studio-synthesize] proposal cites unknown clusterId "${clusterId}" — skipped`);
      continue;
    }
    if (alreadyProposed.has(clusterId)) continue;

    const sources = cluster.members.map(sourceOf);
    const candidate: CompoundRule = {
      id: randomUUID(),
      statement,
      evidence: sources.flatMap((s) => s.evidence),
      sources,
      mergeOrigin: 'SYNTHESIZED',
    };
    // Same gate a rebuilt compound rule must pass (`validateCompoundRule`,
    // `STUDIO_RULE_UNGROUNDED`) — run here too so a malformed proposal (e.g. an empty
    // statement) never even reaches the human's review queue as something to decide on.
    const check = validateCompoundRule(candidate);
    if (!check.ok) {
      console.error(`[studio-synthesize] proposal for cluster "${clusterId}" rejected: ${check.reason}`);
      continue;
    }

    added.push({ id: candidate.id, clusterId, statement, sources, decision: 'PENDING' });
    alreadyProposed.add(clusterId);
  }

  session.proposals.push(...added);
  session.synthesizeStatus = 'IDLE';
  session.synthesizeError = undefined;
  await saveStudioSession(session, deps.dataDir);
}

/**
 * Registers the settle listener exactly once per daemon process (`http.ts`, right
 * beside the M1/Training Lab registrations — see those files' own doc comments for
 * why all three coexist safely on the same `onItemSettled` source).
 */
export function registerStudioSynthesizeSettleListener(
  scheduler: LaneScheduler,
  deps: { dataDir: string },
): () => void {
  const fullDeps: SynthesizeDeps = { scheduler, dataDir: deps.dataDir };
  return scheduler.onItemSettled((event) => {
    if (event.stage !== SYNTHESIZE_STAGE) return;
    void handleSynthesizeSettle(fullDeps, event).catch((err) => {
      console.error('[studio-synthesize] handleSynthesizeSettle failed:', (err as Error).message);
    });
  });
}
