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
  validateCompoundRule,
  type CompoundFormula,
  type CompoundRule,
  type CompoundRuleProvenance,
  type FormulaArtifact,
  type PickedRule,
  type RuleCluster,
} from '@writer-room/training-core';
import { ensureDir, trainingRoot } from '../paths.ts';
import { getFormula } from './storage.ts';

/** A rule ref as the UI sends it back when picking — identifies one rule inside one
 * committed L1 Formula. The Studio re-reads the Formula to get the statement and
 * evidence, so a stale/edited client payload can never inject an invented rule. */
export interface RuleRef {
  formulaId: string;
  ruleId: string;
}

/** One row in the browse-and-pick pool: every rule of every committed L1 Formula. */
export interface PoolRule extends RuleRef {
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
  provenance: CompoundRuleProvenance[];
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
  compound: CompoundFormula | null;
  createdAt: string;
  updatedAt: string;
}

export interface StudioSessionSummary {
  id: string;
  genre: string;
  pickCount: number;
  ruleCount: number;
  status: CompoundFormula['status'] | 'EMPTY';
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
 * Every rule of every committed L1 Formula, flattened for browsing.
 *
 * `channelTitle`/`videoSnapshotId` come from the L1 Formula's `channelGroups[0]`,
 * which is where the existing M1 aggregator records them. They are carried purely as
 * display/filter labels and as provenance — never as a grouping key (ADR-5).
 */
export async function listRulePool(dataDir?: string): Promise<PoolRule[]> {
  const root = join(trainingRoot(dataDir), 'formulas');
  await ensureDir(root);
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }

  const pool: PoolRule[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const formula = JSON.parse(await readFile(join(root, name), 'utf8')) as FormulaArtifact;
      const group = formula.channelGroups[0];
      for (const rule of formula.rules) {
        pool.push({
          formulaId: formula.id,
          ruleId: rule.id,
          videoSnapshotId: group?.videoSnapshotIds[0] ?? 'unknown',
          channelTitle: group?.channelTitle ?? 'unknown',
          statement: rule.statement,
          evidenceCount: rule.evidence.length,
          formulaCreatedAt: formula.createdAt,
        });
      }
    } catch {
      // skip corrupt
    }
  }
  pool.sort((a, b) => Date.parse(b.formulaCreatedAt) - Date.parse(a.formulaCreatedAt));
  return pool;
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
    const group = formula.channelGroups[0];
    resolved.push({
      videoSnapshotId: group?.videoSnapshotIds[0] ?? 'unknown',
      channelTitle: group?.channelTitle ?? 'unknown',
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

function provenanceOf(rule: PickedRule): CompoundRuleProvenance {
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
 * `status` is always `DRAFT` here. Promotion to `TRIAL` is a separate explicit human
 * action (ADR-6) — see `promoteCompound`.
 */
export async function rebuildCompound(session: StudioSession, dataDir?: string): Promise<StudioSession> {
  const rules: CompoundRule[] = [];

  for (const cluster of session.clusters) {
    if (cluster.kind === 'SINGLE') {
      const only = cluster.members[0]!;
      rules.push({
        id: `${cluster.id}-carried`,
        statement: only.statement,
        provenance: [provenanceOf(only)],
        origin: 'CARRIED',
      });
      continue;
    }
    const accepted = session.proposals.find((p) => p.clusterId === cluster.id && p.decision === 'ACCEPTED');
    if (!accepted) continue; // still pending or rejected — not in the compound yet
    rules.push({
      id: accepted.id,
      statement: accepted.statement,
      provenance: accepted.provenance,
      origin: accepted.edited ? 'HUMAN_EDITED' : 'SYNTHESIZED',
    });
  }

  // The gate: nothing enters a compound Formula without naming where it came from.
  for (const rule of rules) {
    const check = validateCompoundRule(rule);
    if (!check.ok) throw new Error(`${check.errorCode}: ${check.reason}`);
  }

  const videos = new Set(rules.flatMap((r) => r.provenance.map((p) => p.videoSnapshotId)));
  session.compound = {
    id: session.compound?.id ?? randomUUID(),
    genre: session.genre,
    // Rebuilding after any edit drops it back to DRAFT: a promoted Formula whose
    // rules then changed is no longer the thing the human promoted.
    status: 'DRAFT',
    rules,
    sourceVideoCount: videos.size,
    sessionId: session.id,
    version: (session.compound?.version ?? 0) + 1,
    createdAt: new Date().toISOString(),
  };
  void dataDir;
  return session;
}

/** ADR-6: explicit human promotion, `DRAFT` → `TRIAL`. `VALIDATED` is unreachable. */
export function promoteCompound(session: StudioSession): StudioSession {
  if (!session.compound) throw new Error('no compound Formula to promote');
  if (session.compound.rules.length === 0) throw new Error('compound Formula has no rules');
  session.compound.status = 'TRIAL';
  return session;
}
