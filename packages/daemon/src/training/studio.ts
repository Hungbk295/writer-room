/**
 * Formula Studio (SDD §12b, ADR-5/ADR-13) — session state, rule pool, and the
 * human-gated merge.
 *
 * The Studio is where a human turns many per-video (L1) Formulas into one
 * genre-scoped compound (L2) Formula. The split of labour is the whole point:
 *
 *   human  picks which rules are candidates       <- taste, never automated
 *   code   clusters them (training-core/cluster)  <- deterministic, free, testable
 *   LLM    words one merged rule per cluster      <- synthesis only, never commits
 *   human  accepts / edits / rejects each one     <- the gate
 *   agents test-write + critique the result       <- reuses §12a machinery
 *   human  promotes it to TRIAL for a genre       <- ADR-6, never automatic
 *
 * Storage mirrors `storage.ts`'s JSON-per-record idiom (and `writer-packs.ts`
 * before it) rather than inventing a scheme: one file per session under
 * `trainingRoot()/studio-sessions`, re-read and re-saved around each mutation, so
 * there is no in-memory registry that can desync from disk.
 *
 * Scope note: this file owns session state + pool + merge. Dispatching the SYNTHESIZE
 * LLM turn (P3 — one merged-statement proposal per cluster) lives in
 * `studio-synthesize.ts` so the pure state handling here stays testable without a
 * scheduler; the later DRAFT/CRITIQUE test-write (P4) will follow the same split.
 */
import { randomUUID } from 'node:crypto';
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  clusterRules,
  detectTopicLeak,
  normalizeFormula,
  sourceVideoCount,
  validateCompoundRule,
  type CompoundRule,
  type FormulaArtifact,
  type PickedRule,
  type RuleCluster,
  type RuleSource,
} from '@writer-room/training-core';
import { ensureDir, trainingRoot } from '../paths.ts';
import { getFormula, saveFormula } from './storage.ts';

/** A rule ref as the UI sends it back when picking — identifies one rule inside one
 * committed L1 Formula. The Studio re-reads the Formula to get the statement and
 * evidence, so a stale/edited client payload can never inject an invented rule. */
export interface RuleRef {
  formulaId: string;
  ruleId: string;
}

/** One row in the browse-and-pick pool: every rule of every pickable Formula. */
export interface PoolRule extends RuleRef {
  /** Lets the UI show "v2 (đã tinh chỉnh)" so the user knows a refined rule from an
   * original one — the whole reason refined Formulas became pickable (ADR-5 fix). */
  formulaVersion: number;
  formulaOrigin: FormulaArtifact['origin'];
  videoSnapshotId: string;
  channelTitle: string;
  statement: string;
  evidenceCount: number;
  formulaCreatedAt: string;
}

/** An LLM-proposed merged rule awaiting a human decision. */
export interface RuleProposal {
  id: string;
  clusterId: string;
  /** What the LLM (or the human, after an edit) proposes the merged rule should say. */
  statement: string;
  sources: RuleSource[];
  decision: 'PENDING' | 'ACCEPTED' | 'REJECTED';
  /** Set when the human rewrote the statement instead of taking the LLM's wording. */
  edited?: boolean;
  /** Set when what the human submitted is verbatim one of the cluster's original
   * source statements — i.e. "keep the original", not an edit. Distinguished so the
   * committed rule reports `CARRIED` rather than mislabelling the decision as
   * `HUMAN_EDITED`; see `applyProposalDecision`. */
  keptOriginal?: boolean;
}

export interface StudioSession {
  id: string;
  genre: string;
  picks: RuleRef[];
  clusters: RuleCluster[];
  proposals: RuleProposal[];
  /** Latest assembled compound Formula; rebuilt whenever decisions change. */
  compound: FormulaArtifact | null;
  /**
   * SYNTHESIZE dispatch state (P3, `studio-synthesize.ts`). Deliberately tracks only
   * the MOST RECENT attempt, not a full history — mirrors how `TrainingLabRound`
   * tracks one round's status rather than an audit log. The UI polls
   * `GET .../sessions/:id` and reads this to know when to stop showing "đang ghép…"
   * (`RUNNING` -> `IDLE`/`FAILED`) and re-render `proposals`, without a separate
   * status endpoint.
   */
  synthesizeStatus: 'IDLE' | 'RUNNING' | 'FAILED';
  /** Doubles as the SYNTHESIZE stage's `attempt` (turn_key input) — incremented on
   * every dispatch so re-running SYNTHESIZE after picking more rules gets a fresh
   * turn_key instead of idempotently re-attaching to a settled one. */
  synthesizeAttempt: number;
  synthesizeError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StudioSessionSummary {
  id: string;
  genre: string;
  pickCount: number;
  ruleCount: number;
  status: FormulaArtifact['status'] | 'EMPTY';
  updatedAt: string;
}

function sessionsDir(dataDir?: string): string {
  return join(trainingRoot(dataDir), 'studio-sessions');
}

function sessionPath(id: string, dataDir?: string): string {
  return join(sessionsDir(dataDir), `${id}.json`);
}

export async function saveStudioSession(session: StudioSession, dataDir?: string): Promise<void> {
  await ensureDir(sessionsDir(dataDir));
  session.updatedAt = new Date().toISOString();
  await writeFile(sessionPath(session.id, dataDir), `${JSON.stringify(session, null, 2)}\n`, 'utf8');
}

/** Fields added after a session may have been created (P3's `synthesize*` trio) get
 * defaults spread in BEFORE the parsed data, so an old on-disk session (from P2, or
 * any session written before this field existed) still reads as valid state instead
 * of `undefined` leaking into the UI/dispatch code — same "read-time migration, no
 * rewrite pass" precedent as `normalizeFormula` in training-core, just inline since
 * it is one small object spread rather than a legacy-shape remap. */
export async function getStudioSession(id: string, dataDir?: string): Promise<StudioSession | null> {
  try {
    // Cast to `Partial` (not the full type) so TS does not flag the defaults below as
    // dead/redundant — an on-disk file written before these fields existed really can
    // lack them at runtime, even though the parsed value's static type claims otherwise.
    const raw = JSON.parse(await readFile(sessionPath(id, dataDir), 'utf8')) as Partial<StudioSession>;
    return { synthesizeStatus: 'IDLE', synthesizeAttempt: 0, ...raw } as StudioSession;
  } catch {
    return null;
  }
}

export async function listStudioSessions(dataDir?: string): Promise<StudioSessionSummary[]> {
  const root = sessionsDir(dataDir);
  await ensureDir(root);
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const summaries: StudioSessionSummary[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const session = JSON.parse(await readFile(join(root, name), 'utf8')) as StudioSession;
      summaries.push({
        id: session.id,
        genre: session.genre,
        pickCount: session.picks.length,
        ruleCount: session.compound?.rules.length ?? 0,
        status: session.compound?.status ?? 'EMPTY',
        updatedAt: session.updatedAt,
      });
    } catch {
      // skip corrupt
    }
  }
  summaries.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
  return summaries;
}

export async function createStudioSession(genre: string, dataDir?: string): Promise<StudioSession> {
  const now = new Date().toISOString();
  const session: StudioSession = {
    id: randomUUID(),
    genre,
    picks: [],
    clusters: [],
    proposals: [],
    compound: null,
    synthesizeStatus: 'IDLE',
    synthesizeAttempt: 0,
    createdAt: now,
    updatedAt: now,
  };
  await saveStudioSession(session, dataDir);
  return session;
}

/** Xoá phiên Studio. Compound Formula đã promote (nếu có) nằm riêng trong formulas/ — không xoá theo. */
export async function deleteStudioSession(id: string, dataDir?: string): Promise<boolean> {
  try {
    await unlink(sessionPath(id, dataDir));
    return true;
  } catch {
    return false;
  }
}

/**
 * Every pickable rule, flattened for browsing.
 *
 * **Latest version per video by default.** Since Training Lab started committing every
 * refined version to the shared store (ADR-14), a 3-round lab run on one video leaves
 * v1..v4 on disk — four Formulas describing the same video, mostly near-duplicate
 * rules. Showing them all would put ~30 rows in the pool for a single video. So this
 * keeps only the highest `version` per `videoSnapshotId` unless
 * `includeOlderVersions` is set, which the UI offers as an explicit "xem cả bản cũ"
 * toggle for comparing a rule before and after refinement.
 *
 * `channelTitle`/`videoSnapshotId` are carried as display/filter labels and as
 * provenance — never as a grouping key (ADR-5).
 */
export async function listRulePool(
  dataDir?: string,
  opts: { includeOlderVersions?: boolean } = {},
): Promise<PoolRule[]> {
  const root = join(trainingRoot(dataDir), 'formulas');
  await ensureDir(root);
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }

  const formulas: FormulaArtifact[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const formula = normalizeFormula(JSON.parse(await readFile(join(root, name), 'utf8')) as FormulaArtifact);
      // A COMPOUND Formula's rules are already merged output — picking them back into
      // another merge would double-count provenance and compound the wording twice.
      if (formula.origin === 'COMPOUND') continue;
      formulas.push(formula);
    } catch {
      // skip corrupt
    }
  }

  const visible = opts.includeOlderVersions ? formulas : keepLatestPerVideo(formulas);

  const pool: PoolRule[] = [];
  for (const formula of visible) {
    for (const rule of formula.rules) {
      pool.push({
        formulaId: formula.id,
        ruleId: rule.id,
        formulaVersion: formula.version,
        formulaOrigin: formula.origin,
        videoSnapshotId: formula.videoSnapshotId ?? 'unknown',
        channelTitle: formula.channelTitle ?? 'unknown',
        statement: rule.statement,
        evidenceCount: rule.evidence.length,
        formulaCreatedAt: formula.createdAt,
      });
    }
  }
  pool.sort(
    (a, b) =>
      Date.parse(b.formulaCreatedAt) - Date.parse(a.formulaCreatedAt) ||
      a.formulaId.localeCompare(b.formulaId) ||
      a.ruleId.localeCompare(b.ruleId),
  );
  return pool;
}

/** Highest `version` per video; ties broken by `createdAt` so the result is stable. */
function keepLatestPerVideo(formulas: FormulaArtifact[]): FormulaArtifact[] {
  const best = new Map<string, FormulaArtifact>();
  for (const formula of formulas) {
    const key = formula.videoSnapshotId ?? formula.id;
    const current = best.get(key);
    if (
      !current ||
      formula.version > current.version ||
      (formula.version === current.version && formula.createdAt > current.createdAt)
    ) {
      best.set(key, formula);
    }
  }
  return [...best.values()];
}

/**
 * Resolves saved `RuleRef`s back to full rules by re-reading the committed L1
 * Formulas. Refs that no longer resolve are dropped rather than faked — a rule the
 * Studio cannot read is a rule it must not merge.
 */
export async function resolvePicks(picks: RuleRef[], dataDir?: string): Promise<PickedRule[]> {
  const byFormula = new Map<string, FormulaArtifact | null>();
  const resolved: PickedRule[] = [];

  for (const ref of picks) {
    if (!byFormula.has(ref.formulaId)) {
      byFormula.set(ref.formulaId, await getFormula(ref.formulaId, dataDir));
    }
    const formula = byFormula.get(ref.formulaId);
    if (!formula) continue;
    const rule = formula.rules.find((r) => r.id === ref.ruleId);
    if (!rule) continue;
    resolved.push({
      videoSnapshotId: formula.videoSnapshotId ?? 'unknown',
      channelTitle: formula.channelTitle ?? 'unknown',
      sourceFormulaId: formula.id,
      sourceRuleId: rule.id,
      statement: rule.statement,
      evidence: rule.evidence,
    });
  }
  return resolved;
}

/** Recomputes clusters from the session's current picks. Deterministic, no LLM. */
export async function recomputeClusters(session: StudioSession, dataDir?: string): Promise<StudioSession> {
  const picked = await resolvePicks(session.picks, dataDir);
  session.clusters = clusterRules(picked);
  return session;
}

/** Exported so `studio-synthesize.ts` can build a proposal's `sources` from a
 * cluster's `members` the same way — the app derives provenance, never the LLM
 * (see that file's doc comment). */
export function sourceOf(rule: PickedRule): RuleSource {
  return {
    videoSnapshotId: rule.videoSnapshotId,
    channelTitle: rule.channelTitle,
    sourceFormulaId: rule.sourceFormulaId,
    sourceRuleId: rule.sourceRuleId,
    evidence: rule.evidence,
  };
}

/**
 * Turns accepted proposals into the session's compound Formula.
 *
 * 2026-08-10 design change (user, real data): a `SINGLE` cluster used to skip the LLM
 * entirely and get carried through verbatim as `CARRIED` — but "nothing else
 * resembled it" said nothing about whether its wording was already generic. Real
 * rules showed video-specific nouns and quoted phrases ("khái niệm tài chính ('thuế ở
 * lại thành phố')") baked straight into a `SINGLE` statement, which a writer on an
 * unrelated topic cannot use as-is. So EVERY cluster — `SINGLE` and `SIMILAR` alike —
 * now needs an accepted proposal (SYNTHESIZE, P3) before it enters the compound.
 * `CARRIED` stays a valid `CompoundRuleOrigin` in the contract for a human-initiated
 * "keep the original wording" choice, but nothing in this file produces it anymore —
 * no proposal decision here currently offers that as a distinct path from
 * `HUMAN_EDITED` (typing the original text back in has the same effect, just labeled
 * differently). Flagged as a judgment call, not silently dropped.
 *
 * The result is an ordinary `FormulaArtifact` with `origin: 'COMPOUND'` — the same
 * type the Writer pins and the Formula list shows, not a parallel shape.
 *
 * `status` is always `DRAFT` here; promotion is a separate human action (ADR-6). It is
 * held in the session and only written to the shared Formula store on promotion, so
 * an in-progress merge never appears in the Writer's picker.
 */
export async function rebuildCompound(session: StudioSession, dataDir?: string): Promise<StudioSession> {
  const rules: CompoundRule[] = [];

  for (const cluster of session.clusters) {
    const accepted = session.proposals.find((p) => p.clusterId === cluster.id && p.decision === 'ACCEPTED');
    if (!accepted) continue; // still pending, rejected, or never synthesized — not in the compound yet
    rules.push({
      id: accepted.id,
      statement: accepted.statement,
      // A merged rule inherits the evidence of every rule it was merged from — this
      // is what keeps it grounded and what the lean CRITIQUE envelope ships.
      evidence: accepted.sources.flatMap((s) => s.evidence),
      sources: accepted.sources,
      mergeOrigin: accepted.keptOriginal ? 'CARRIED' : accepted.edited ? 'HUMAN_EDITED' : 'SYNTHESIZED',
    });
  }

  // The gate: nothing enters a compound Formula without naming where it came from.
  for (const rule of rules) {
    const check = validateCompoundRule(rule);
    if (!check.ok) throw new Error(`${check.errorCode}: ${check.reason}`);
  }

  session.compound = {
    id: session.compound?.id ?? randomUUID(),
    status: 'DRAFT',
    origin: 'COMPOUND',
    // Rebuilding after any edit bumps the version and drops back to DRAFT: a promoted
    // Formula whose rules then changed is no longer the thing the human promoted.
    version: (session.compound?.version ?? 0) + 1,
    genre: session.genre,
    rules,
    includedArtifacts: [],
    lineage: { studioSessionId: session.id },
    // Guarded on `rules.length > 0` (fixed 2026-08-10): with SINGLE clusters no
    // longer auto-carried, an empty-so-far compound is now the common in-progress
    // state, and `sourceVideoCount([]) === 0 < 2` would otherwise spuriously claim
    // "every rule came from one video" about a compound that has no rules at all.
    warnings:
      rules.length > 0 && sourceVideoCount(rules) < 2
        ? ['SINGLE_SOURCE: every rule came from one video — this is not yet a cross-video Formula']
        : [],
    createdAt: new Date().toISOString(),
  };
  void dataDir;
  return session;
}

/**
 * The human gate (ADR-13): applies one decision to one pending (or previously
 * decided — a human can change their mind) proposal. Pure state mutation, no I/O —
 * the HTTP route (or a test) is responsible for `rebuildCompound` + `saveStudioSession`
 * afterward, same division as `session.picks` mutation in `http.ts`.
 *
 * `statement`, when provided, overwrites the LLM's wording. It then marks the rule
 * either `HUMAN_EDITED` or — if what the human submitted is character-for-character
 * one of the cluster's ORIGINAL source statements — `CARRIED`.
 *
 * That one equality check exists for a specific reason, not as cleverness: the whole
 * point of SYNTHESIZE is to genericize, and an LLM can genericize a rule into
 * something worse. The human's escape hatch is to put the original wording back. That
 * is a "keep the original" decision, not an edit, and labelling it `HUMAN_EDITED`
 * would quietly misreport what happened — while `CARRIED` (which exists in
 * `CompoundRuleOrigin`) would otherwise have no code path at all and rot as a dead
 * enum value. Restoring the original is the only case where equality carries
 * unambiguous intent, so it is the only case inferred; any other text is an edit.
 */
export function applyProposalDecision(
  session: StudioSession,
  proposalId: string,
  decision: 'ACCEPTED' | 'REJECTED',
  statement?: string,
): StudioSession {
  const proposal = session.proposals.find((p) => p.id === proposalId);
  if (!proposal) throw new Error('proposal không tồn tại');
  proposal.decision = decision;
  if (typeof statement === 'string' && statement.trim().length > 0) {
    const next = statement.trim();
    const cluster = session.clusters.find((c) => c.id === proposal.clusterId);
    const isOriginal = (cluster?.members ?? []).some((m) => m.statement.trim() === next);
    proposal.statement = next;
    proposal.edited = !isOriginal;
    proposal.keptOriginal = isOriginal;
  }
  return session;
}

/**
 * ADR-6: explicit human promotion, `DRAFT` → `TRIAL`, and the moment the compound
 * Formula enters the shared store where the Writer can pin it and the Formula list
 * can show it. `VALIDATED` remains unreachable.
 */
export async function promoteCompound(session: StudioSession, dataDir?: string): Promise<StudioSession> {
  if (!session.compound) throw new Error('no compound Formula to promote');
  if (session.compound.rules.length === 0) throw new Error('compound Formula has no rules');

  // Advisory topic-leak scan (training-core's `writer-view.ts`, 2026-08-10) — a
  // last-look net, not a gate: SYNTHESIZE is asked to genericize every statement, but
  // an LLM can still miss one, and a human accepting/editing a proposal has no reason
  // to re-derive this check by eye. `detectTopicLeak` never blocks — same "advisory,
  // never throws" contract its own doc comment states — so a rule that still smells
  // like one specific video is promoted anyway, just visibly flagged for the human
  // (and whoever picks this compound Formula later) to judge.
  const leakWarnings = session.compound.rules.flatMap((rule) =>
    detectTopicLeak(rule.statement).map((leak) => `TOPIC_LEAK: rule "${rule.id}" còn dính "${leak.excerpt}"`),
  );

  session.compound.warnings = [...session.compound.warnings, ...leakWarnings];
  session.compound.status = 'TRIAL';
  await saveFormula(session.compound, dataDir);
  return session;
}
