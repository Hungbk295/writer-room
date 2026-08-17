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
  type TopicLeakKind,
  type WriterReadyProfile,
  type WriterReadyProfileGuideline,
} from '@writer-room/training-core';
import { ensureDir, trainingRoot } from '../paths.ts';
import { saveProfile } from './profile-store.ts';
import { getFormula, saveFormula } from './storage.ts';

/**
 * A picked rule's migration classification (plan/writer-train/
 * FORMULA-MIGRATION-TO-WRITER.md §2.4): what a human decides a rule IS, browsing the
 * pool with `WRITER_READY_PROFILE` migration in mind —
 *  - `PROFILE` — a candidate consistency guideline; eligible for `publishProfile`.
 *  - `TASTE` — a real editorial decision, but FM2 (Taste capture) is not built yet;
 *    tagging it now costs nothing and the classification survives on the pick for
 *    when FM2 lands.
 *  - `SOURCE_ONLY` — useful as training evidence, not as writer guidance.
 *  - `REJECT` — not worth carrying forward at all.
 * Purely a pick-level tag: it does NOT change clustering/synthesize (those still run
 * over every pick, exactly as before FM1 — see `recomputeClusters`), so the
 * pre-existing compound-Formula merge flow (training-only) is untouched by this
 * field. Only `publishProfile` reads it, to decide which ACCEPTED proposals become
 * profile guidelines.
 */
export type RuleClassification = 'PROFILE' | 'TASTE' | 'SOURCE_ONLY' | 'REJECT';

/** A rule ref as the UI sends it back when picking — identifies one rule inside one
 * committed L1 Formula. The Studio re-reads the Formula to get the statement and
 * evidence, so a stale/edited client payload can never inject an invented rule. */
export interface RuleRef {
  formulaId: string;
  ruleId: string;
  /** Set via `classifyPick`, after the pick already exists in a session. Absent =
   * not yet triaged. */
  classification?: RuleClassification;
}

/** One row in the browse-and-pick pool: every rule of every pickable Formula. */
export interface PoolRule extends RuleRef {
  /** Lets the UI show "v2 (đã tinh chỉnh)" so the user knows a refined rule from an
   * original one — the whole reason refined Formulas became pickable (ADR-5 fix). */
  formulaVersion: number;
  formulaOrigin: FormulaArtifact['origin'];
  videoSnapshotId: string;
  channelTitle: string;
  /** Display name of the parent Formula (video title / rename), for pool grouping. */
  formulaTitle: string;
  videoTitle?: string;
  statement: string;
  evidenceCount: number;
  formulaCreatedAt: string;
}

/**
 * An LLM-proposed merged/genericized rule awaiting a human decision.
 *
 * Shape changed 2026-08-11 (FM1, plan §2.5/§6): a bare `statement` string is what a
 * training-only compound Formula rule needs, but it is NOT enough to publish a
 * `WriterReadyProfile` guideline — that needs the SAME generic-hoá pass to also
 * separate out WHEN a rule applies from what it says to do, and how strongly (§2.2's
 * `instruction`/`when`/`avoidWhen`/`priority`). Rather than run two separate
 * generic-ization passes (one for compound Formulas, one for profiles), this shape
 * change makes the ONE SYNTHESIZE turn (`studio-synthesize.ts`) serve both: a
 * compound Formula rule's `statement` is `instruction` (see `rebuildCompound`); a
 * profile guideline takes all four fields (see `publishProfile`).
 */
export interface RuleProposal {
  id: string;
  clusterId: string;
  /** What the LLM (or the human, after an edit) proposes the merged rule should say —
   * the reusable technique itself, stripped of topic/video specifics. */
  instruction: string;
  /** Free text, optional — when this applies. */
  when?: string;
  /** Free text, optional — when this should NOT be followed. */
  avoidWhen?: string;
  priority: 'CORE' | 'OPTIONAL';
  sources: RuleSource[];
  decision: 'PENDING' | 'ACCEPTED' | 'REJECTED';
  /** Set when the human rewrote `instruction` instead of taking the LLM's wording. */
  edited?: boolean;
  /** Set when what the human submitted as `instruction` is verbatim one of the
   * cluster's original source statements — i.e. "keep the original", not an edit.
   * Distinguished so the committed rule reports `CARRIED` rather than mislabelling
   * the decision as `HUMAN_EDITED`; see `applyProposalDecision`. */
  keptOriginal?: boolean;
}

export interface StudioSession {
  id: string;
  genre: string;
  /**
   * L1 Formulas the human scoped this session to. The rule pool only offers rules
   * from these ids — empty means "chưa chọn nguồn", not "mọi formula" (đổ hết rule
   * vào một kho là loạn khi có nhiều video).
   */
  sourceFormulaIds: string[];
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
    return {
      synthesizeStatus: 'IDLE',
      synthesizeAttempt: 0,
      ...raw,
      // Guard: older sessions may lack the array entirely; never leave undefined.
      // Placed after `...raw` so it always wins over a missing/invalid on-disk value.
      sourceFormulaIds: Array.isArray(raw.sourceFormulaIds) ? raw.sourceFormulaIds : [],
    } as StudioSession;
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
    sourceFormulaIds: [],
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

/**
 * Scopes the session to a set of L1 Formulas. Picks that fall outside the new set
 * are dropped and clusters/compound are recomputed. COMPOUND Formulas cannot be
 * sources (would double-merge).
 */
export async function setSourceFormulas(
  session: StudioSession,
  formulaIds: string[],
  dataDir?: string,
): Promise<StudioSession> {
  const unique = [...new Set(formulaIds.map((id) => id.trim()).filter(Boolean))];
  for (const id of unique) {
    const formula = await getFormula(id, dataDir);
    if (!formula) throw new Error(`Formula nguồn không tồn tại: ${id}`);
    if (formula.origin === 'COMPOUND') {
      throw new Error('Không chọn Formula COMPOUND làm nguồn — chỉ L1 (ANALYZED/REFINED)');
    }
  }
  const allowed = new Set(unique);
  session.sourceFormulaIds = unique;
  session.picks = session.picks.filter((p) => allowed.has(p.formulaId));
  // Changing the source set invalidates proposals that referenced old clusters;
  // recompute from remaining picks. Proposals for clusters that no longer exist
  // are dropped so the UI does not show orphan "chờ duyệt" rows.
  await recomputeClusters(session, dataDir);
  const liveClusterIds = new Set(session.clusters.map((c) => c.id));
  session.proposals = session.proposals.filter((p) => liveClusterIds.has(p.clusterId));
  await rebuildCompound(session, dataDir);
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
  opts: { includeOlderVersions?: boolean; formulaIds?: string[] } = {},
): Promise<PoolRule[]> {
  const root = join(trainingRoot(dataDir), 'formulas');
  await ensureDir(root);
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }

  const allowIds = opts.formulaIds ? new Set(opts.formulaIds) : null;

  const formulas: FormulaArtifact[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const formula = normalizeFormula(JSON.parse(await readFile(join(root, name), 'utf8')) as FormulaArtifact);
      // A COMPOUND Formula's rules are already merged output — picking them back into
      // another merge would double-count provenance and compound the wording twice.
      if (formula.origin === 'COMPOUND') continue;
      if (allowIds && !allowIds.has(formula.id)) continue;
      formulas.push(formula);
    } catch {
      // skip corrupt
    }
  }

  // When the caller scopes to explicit formula ids, honor every selected version —
  // "latest per video" would hide a v1 the user deliberately added next to its v3.
  const visible =
    opts.includeOlderVersions || allowIds ? formulas : keepLatestPerVideo(formulas);

  const pool: PoolRule[] = [];
  for (const formula of visible) {
    const formulaTitle =
      formula.title?.trim() ||
      formula.videoTitle?.trim() ||
      formula.channelTitle?.trim() ||
      'Formula';
    for (const rule of formula.rules) {
      pool.push({
        formulaId: formula.id,
        ruleId: rule.id,
        formulaVersion: formula.version,
        formulaOrigin: formula.origin,
        videoSnapshotId: formula.videoSnapshotId ?? 'unknown',
        channelTitle: formula.channelTitle ?? 'unknown',
        formulaTitle,
        ...(formula.videoTitle ? { videoTitle: formula.videoTitle } : {}),
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
      // A training-only compound Formula rule only needs the bare technique text —
      // `when`/`avoidWhen`/`priority` are Profile-only concerns (see `publishProfile`).
      statement: accepted.instruction,
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
 * `edit.instruction`, when provided, overwrites the LLM's wording. It then marks the
 * rule either `HUMAN_EDITED` or — if what the human submitted is character-for-
 * character one of the cluster's ORIGINAL source statements — `CARRIED`.
 *
 * That one equality check exists for a specific reason, not as cleverness: the whole
 * point of SYNTHESIZE is to genericize, and an LLM can genericize a rule into
 * something worse. The human's escape hatch is to put the original wording back. That
 * is a "keep the original" decision, not an edit, and labelling it `HUMAN_EDITED`
 * would quietly misreport what happened — while `CARRIED` (which exists in
 * `CompoundRuleOrigin`) would otherwise have no code path at all and rot as a dead
 * enum value. Restoring the original is the only case where equality carries
 * unambiguous intent, so it is the only case inferred; any other text is an edit.
 *
 * `edit.when`/`avoidWhen`/`priority`, when provided, simply overwrite — no
 * inference needed there, they carry no "is this still the original" ambiguity.
 */
export function applyProposalDecision(
  session: StudioSession,
  proposalId: string,
  decision: 'ACCEPTED' | 'REJECTED',
  edit?: { instruction?: string; when?: string; avoidWhen?: string; priority?: 'CORE' | 'OPTIONAL' },
): StudioSession {
  const proposal = session.proposals.find((p) => p.id === proposalId);
  if (!proposal) throw new Error('proposal không tồn tại');
  proposal.decision = decision;
  if (typeof edit?.instruction === 'string' && edit.instruction.trim().length > 0) {
    const next = edit.instruction.trim();
    const cluster = session.clusters.find((c) => c.id === proposal.clusterId);
    const isOriginal = (cluster?.members ?? []).some((m) => m.statement.trim() === next);
    proposal.instruction = next;
    proposal.edited = !isOriginal;
    proposal.keptOriginal = isOriginal;
  }
  if (typeof edit?.when === 'string') proposal.when = edit.when.trim() || undefined;
  if (typeof edit?.avoidWhen === 'string') proposal.avoidWhen = edit.avoidWhen.trim() || undefined;
  if (edit?.priority) proposal.priority = edit.priority;
  return session;
}

/** The human triage step of migration (§2.4): tag one already-picked rule with what
 * it IS for the purposes of moving it toward the Writer. Throws on a ref that was
 * never picked into this session — same "never fake it" precedent `resolvePicks`
 * follows for a Formula that no longer resolves. */
export function classifyPick(
  session: StudioSession,
  ref: { formulaId: string; ruleId: string },
  classification: RuleClassification,
): StudioSession {
  const pick = session.picks.find((p) => p.formulaId === ref.formulaId && p.ruleId === ref.ruleId);
  if (!pick) throw new Error('rule chưa được chọn vào session — không thể phân loại');
  pick.classification = classification;
  return session;
}

export type PublishProfileResult =
  | { ok: true; profile: WriterReadyProfile }
  | { ok: false; errorCode: 'PROFILE_EMPTY'; reason: string }
  | {
      ok: false;
      errorCode: 'PROFILE_LEAK_DETECTED';
      reason: string;
      leaks: { proposalId: string; kind: TopicLeakKind; excerpt: string }[];
    };

/**
 * Migration publish (§2.4/§2.5, ADR-FM10/FM13): turns the session's ACCEPTED
 * proposals whose picks were ALL classified `PROFILE` into one immutable
 * `WriterReadyProfile`, always `readiness: 'TRIAL'` — there is no parameter for
 * `VALIDATED` and no caller of this function can ever produce one (ADR-FM13, same
 * hard-assert precedent as `formulaFromSingleAnalysis`'s `status: 'TRIAL'`).
 *
 * Unlike `promoteCompound`'s topic-leak scan (advisory-only, training-only output),
 * this IS a gate (§2.4 "Leak check chặn") — a leaking guideline blocks publish
 * entirely, because a Profile is what the Writer actually reads, and a source leak
 * there is exactly the failure this whole migration exists to prevent (§1).
 *
 * Deliberately does not require multi-video clustering (ADR-FM14): a `SINGLE`
 * cluster built from one formula's one rule is a completely normal, expected input
 * here — the thin path is 1 formula -> 1 profile (§2.5), not a warning case.
 */
export async function publishProfile(
  session: StudioSession,
  input: {
    label: string;
    scope: { language: string; genre?: string; contentModes: string[] };
    editorialPromise?: string;
    antiPatterns?: string[];
  },
  dataDir?: string,
): Promise<PublishProfileResult> {
  const picksByRef = new Map(session.picks.map((p) => [`${p.formulaId}:${p.ruleId}`, p]));

  const eligible = session.proposals.filter((proposal) => {
    if (proposal.decision !== 'ACCEPTED') return false;
    const cluster = session.clusters.find((c) => c.id === proposal.clusterId);
    if (!cluster || cluster.members.length === 0) return false;
    // Every rule the merged guideline came from must have been triaged PROFILE — a
    // cluster with even one TASTE/SOURCE_ONLY/REJECT member must not silently
    // contribute a guideline built partly from a rule the human said was NOT
    // profile material.
    return cluster.members.every(
      (m) => picksByRef.get(`${m.sourceFormulaId}:${m.sourceRuleId}`)?.classification === 'PROFILE',
    );
  });

  if (eligible.length === 0) {
    return {
      ok: false,
      errorCode: 'PROFILE_EMPTY',
      reason: 'Không có guideline nào đã duyệt (ACCEPTED) và được phân loại PROFILE để publish',
    };
  }

  const leaks: { proposalId: string; kind: TopicLeakKind; excerpt: string }[] = [];
  for (const proposal of eligible) {
    for (const text of [proposal.instruction, proposal.when, proposal.avoidWhen]) {
      if (!text) continue;
      for (const leak of detectTopicLeak(text)) {
        leaks.push({ proposalId: proposal.id, kind: leak.kind, excerpt: leak.excerpt });
      }
    }
  }
  if (leaks.length > 0) {
    return {
      ok: false,
      errorCode: 'PROFILE_LEAK_DETECTED',
      reason: `${leaks.length} chỗ còn dính leak nguồn — sửa lại instruction/when/avoidWhen hoặc reject proposal trước khi publish`,
      leaks,
    };
  }

  const guidelines: WriterReadyProfileGuideline[] = eligible.map((proposal) => {
    const cluster = session.clusters.find((c) => c.id === proposal.clusterId)!;
    return {
      id: proposal.id,
      instruction: proposal.instruction,
      when: proposal.when,
      avoidWhen: proposal.avoidWhen,
      priority: proposal.priority,
      sourceRuleIds: cluster.members.map((m) => `${m.sourceFormulaId}:${m.sourceRuleId}`),
    };
  });

  const profile: WriterReadyProfile = {
    kind: 'WRITER_READY_PROFILE',
    id: randomUUID(),
    version: 1,
    label: input.label,
    readiness: 'TRIAL',
    scope: input.scope,
    editorialPromise: input.editorialPromise,
    guidelines,
    antiPatterns: input.antiPatterns ?? [],
    createdAt: new Date().toISOString(),
  };

  await saveProfile(profile, dataDir);
  return { ok: true, profile };
}

/**
 * ADR-6: explicit human promotion, `DRAFT` → `TRIAL`, and the moment the compound
 * Formula enters the shared `formulas/` store where Training can read it (list,
 * pick back into another Studio session, etc). `VALIDATED` remains unreachable.
 *
 * Training-only (FM1, ADR-FM1/FM3): a promoted compound Formula does NOT enter the
 * Writer's picker — Formulas of every origin (`ANALYZED`/`REFINED`/`COMPOUND`) are
 * `FORMULA_TRAINING_ONLY`. The only path to something a Writer can pin is
 * `publishProfile` above, which is a SEPARATE human action producing a SEPARATE
 * artifact in a SEPARATE store (`profile-store.ts`) — this function never touches
 * that store and never sets anything a Writer reads.
 */
export async function promoteCompound(session: StudioSession, dataDir?: string): Promise<StudioSession> {
  if (!session.compound) throw new Error('no compound Formula to promote');
  if (session.compound.rules.length === 0) throw new Error('compound Formula has no rules');

  // Advisory topic-leak scan (training-core's `leak.ts`, 2026-08-10) — a
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
