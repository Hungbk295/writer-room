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
 * Scope note: this file owns session state + pool + merge. Dispatching the LLM turns
 * (SYNTHESIZE, and the DRAFT/CRITIQUE test-write) lives in `studio-turns.ts` so the
 * pure state handling here stays testable without a scheduler.
 */
import { randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  clusterRules,
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
}

export interface StudioSession {
  id: string;
  genre: string;
  picks: RuleRef[];
  clusters: RuleCluster[];
  proposals: RuleProposal[];
  /** Latest assembled compound Formula; rebuilt whenever decisions change. */
  compound: FormulaArtifact | null;
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

export async function getStudioSession(id: string, dataDir?: string): Promise<StudioSession | null> {
  try {
    return JSON.parse(await readFile(sessionPath(id, dataDir), 'utf8')) as StudioSession;
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
  summaries.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
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
    createdAt: now,
    updatedAt: now,
  };
  await saveStudioSession(session, dataDir);
  return session;
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
  pool.sort((a, b) => Date.parse(b.formulaCreatedAt) - Date.parse(a.formulaCreatedAt));
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

function sourceOf(rule: PickedRule): RuleSource {
  return {
    videoSnapshotId: rule.videoSnapshotId,
    channelTitle: rule.channelTitle,
    sourceFormulaId: rule.sourceFormulaId,
    sourceRuleId: rule.sourceRuleId,
    evidence: rule.evidence,
  };
}

/**
 * Turns accepted proposals — plus every `SINGLE` cluster, carried through unchanged —
 * into the session's compound Formula.
 *
 * A `SINGLE` cluster needs no LLM and no human wording decision: nothing resembled it,
 * so it enters the compound as `CARRIED` with its original statement. Only `SIMILAR`
 * clusters require a proposal, because only those involve a real merge judgment.
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
    if (cluster.kind === 'SINGLE') {
      const only = cluster.members[0]!;
      rules.push({
        // Content-derived like the cluster id it comes from, so a rule keeps its
        // identity across re-clustering (see `RuleCluster.id`).
        id: `${cluster.id}-carried`,
        statement: only.statement,
        evidence: only.evidence,
        sources: [sourceOf(only)],
        mergeOrigin: 'CARRIED',
      });
      continue;
    }
    const accepted = session.proposals.find((p) => p.clusterId === cluster.id && p.decision === 'ACCEPTED');
    if (!accepted) continue; // still pending or rejected — not in the compound yet
    rules.push({
      id: accepted.id,
      statement: accepted.statement,
      // A merged rule inherits the evidence of every rule it was merged from — this
      // is what keeps it grounded and what the lean CRITIQUE envelope ships.
      evidence: accepted.sources.flatMap((s) => s.evidence),
      sources: accepted.sources,
      mergeOrigin: accepted.edited ? 'HUMAN_EDITED' : 'SYNTHESIZED',
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
    warnings:
      sourceVideoCount(rules) < 2
        ? ['SINGLE_SOURCE: every rule came from one video — this is not yet a cross-video Formula']
        : [],
    createdAt: new Date().toISOString(),
  };
  void dataDir;
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
  session.compound.status = 'TRIAL';
  await saveFormula(session.compound, dataDir);
  return session;
}
