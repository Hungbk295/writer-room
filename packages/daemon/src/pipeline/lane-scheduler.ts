/**
 * Lane Scheduler — the single owner of pipeline `requestTurn` calls (SDD §5.3, §6.6
 * DISPATCH). Turns `(batchId, itemId, stage, attempt)` into a dispatched, tracked
 * turn; applies the commit rule (SDD §5.2) when that turn settles.
 *
 * Scope note (M0.5 admission policy): `maxParallel` is a hard cap with no
 * re-admission queue. When the cap is hit, `dispatchItem` returns `WAITING_LANE`
 * immediately — no clone is acquired, no `requestTurn` call is made. Re-admitting a
 * `WAITING_LANE` item is the CALLER's job: call `dispatchItem` again once a lane is
 * believed free (e.g. after an `onItemSettled` event frees one). A real
 * queue/backoff/poll loop is out of scope here — HANDOFF §4 places it at M2.
 */
import type { Dirent } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { commitArtifact, turnKey as computeTurnKey } from '@writer-room/pipeline-core';
import type { AgentManager } from '../agents/index.ts';
import type { TeamWorkflow, TurnSettledEvent } from '../team/workflow.ts';
import { acquireClone, reapClone } from './agent-pool.ts';
import type { StageLedger } from './ledger.ts';

export interface DispatchItemParams {
  batchId: string;
  itemId: string;
  stage: string;
  attempt: number;
  /** Which agent template to clone — 'claude' | 'codex' (or any configured agent id). */
  templateId: string;
  /** The real instructions written to `prompt.md` (SDD §5.2). */
  promptMarkdown: string;
  /** Opaque to the scheduler — written verbatim to `input/envelope.json`. */
  envelope: unknown;
  inputHashes: string[];
  promptVersion: string;
  /** Per-dispatch override of the scoped-budget placeholder defaults (see class doc). */
  maxTurns?: number;
  maxDurationMinutes?: number;
  /** Forwarded to `agent-pool.ts`'s `acquireClone` — see its doc comment. When set, this
   * dispatch's clone id is stable across `attempt`, letting the underlying CLI session
   * resume turn over turn instead of starting fresh (SDD §12a session-continuity fix,
   * 2026-08-09). Omit for the default M0.5 behavior (fresh clone every attempt). */
  sessionGroup?: string;
  /**
   * Optional domain-owned grounding check (SDD §5.2 commit-rule Branch 4,
   * `AGENT_UNGROUNDED`) — e.g. Training-core's `validateAnalysis` bound to the
   * segments pinned for this dispatch. Runs after the parsed-JSON check (Branch 3)
   * and before the sandbox-violation check (Branch 5). Left `undefined` by M0.5's
   * existing callers (and any future non-Training caller) — that is the ONLY case
   * this file changes behavior for zero: skip straight to Branch 5, exactly as
   * before this field existed.
   */
  validateContent?: (parsed: unknown) => { ok: true } | { ok: false; errorCode: string; reason?: string };
}

export interface DispatchItemResult {
  turnId?: number;
  itemRunDir: string;
  status: 'RUNNING' | 'WAITING_LANE' | 'FAILED';
  reason?: string;
}

export interface ItemSettledResult {
  batchId: string;
  itemId: string;
  stage: string;
  attempt: number;
  outcome: 'COMMITTED' | 'FAILED';
  errorCode?: string;
  artifactHash?: string;
}

interface TurnRegistryEntry {
  turnKey: string;
  batchId: string;
  itemId: string;
  stage: string;
  attempt: number;
  itemRunDir: string;
  cloneId: string;
  sandboxRoot: string;
  baselineFiles: Set<string>;
  validateContent?: DispatchItemParams['validateContent'];
}

/** Placeholder scoped-budget defaults (SDD §5.4 — these are explicitly "placeholder
 * defaults, not magic constants with no override"; every dispatch can override them
 * via `DispatchItemParams.maxTurns`/`maxDurationMinutes`, and the constructor can set
 * a different batch-wide default). 40 turns / 120 minutes gives a multi-item batch
 * meaningful headroom (many stages × several items) while still bounding a runaway
 * loop, without pretending to know the real Training/Writer stage counts yet. */
const DEFAULT_MAX_PARALLEL = 3;
const DEFAULT_MAX_TURNS = 40;
const DEFAULT_MAX_DURATION_MINUTES = 120;

/** SDD §5.2 dispatch options table. */
/** Bumped 2026-08-09 after a real M1 run stalled at exactly ~180.0s twice in a row on
 * a ~90KB transcript prompt — timing that precise points at the turnBridge heartbeat
 * never landing at all (see investigation in plan/writer-train/STATUS.md), not at
 * genuine model "thinking" time. Widened as a safety margin while that's diagnosed;
 * revisit once the heartbeat path is confirmed working for real workloads. */
const STALL_MS = 600_000;
const TIMEOUT_MS = 900_000;

/** SDD §5.2 lines ~492-497: the turn's `taskNote` is a short pointer to `prompt.md`,
 * not the instructions themselves. Adapted to relative paths since `overrideCwd` is
 * already the item run dir the pointer refers to. */
const ASSIGNMENT_TASK_NOTE =
  'Read prompt.md in your working directory and follow it exactly. Write your result to out/result.json inside it. Do not write anywhere else.';

/** Appended to the end of every `prompt.md` — same "write your result, nowhere else"
 * pointer as the taskNote above, reworded for a first-person read from inside the
 * file itself rather than a reference back to it. */
const STANDING_POINTER =
  'Write your result to out/result.json. Do not write anywhere else. Reply "done" when the file exists.';

/** SDD §5.4: guard/budget rejections from `requestTurn` are backpressure — the item
 * stays WAITING_LANE, never FAILED. Everything else (disabled agent, workflow
 * stopped, an unexpected exclusive collision) is AGENT_UNAVAILABLE-shaped and should
 * surface as FAILED so a human can act (SDD §5.3 ADMIT pseudocode's two branches). */
function isBackpressureRejection(reason: string | undefined): boolean {
  if (!reason) return false;
  return /đạt (scoped )?max(Turns|DurationMinutes|QueueDepth|TurnsPerPair)|đang có turn khác/.test(reason);
}

async function listFilesRecursive(root: string): Promise<Set<string>> {
  const result = new Set<string>();
  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else result.add(relative(root, full));
    }));
  }
  await walk(root);
  return result;
}

export class LaneScheduler {
  private readonly maxParallel: number;
  private readonly defaultMaxTurns: number;
  private readonly defaultMaxDurationMinutes: number;
  private readonly liveClones = new Set<string>();
  private readonly turnRegistry = new Map<number, TurnRegistryEntry>();
  private readonly settledListeners = new Set<(result: ItemSettledResult) => void>();
  private readonly unsubscribeSettled: () => void;

  constructor(private readonly deps: {
    /** Deliberately the two harness sub-objects the scheduler actually needs, not
     * the full `AgentHarness` — `harness.ts` constructs `agents`/`workflow` before
     * it can construct the harness object that would embed this scheduler, so
     * depending on the full harness would be circular. Tests can also construct a
     * `LaneScheduler` directly against a lighter fake without building a whole harness. */
    agents: AgentManager;
    workflow: TeamWorkflow;
    ledger: StageLedger;
    dataDir: string;
    maxParallel?: number;
    defaultMaxTurns?: number;
    defaultMaxDurationMinutes?: number;
  }) {
    this.maxParallel = deps.maxParallel ?? DEFAULT_MAX_PARALLEL;
    this.defaultMaxTurns = deps.defaultMaxTurns ?? DEFAULT_MAX_TURNS;
    this.defaultMaxDurationMinutes = deps.defaultMaxDurationMinutes ?? DEFAULT_MAX_DURATION_MINUTES;
    this.unsubscribeSettled = this.deps.workflow.onTurnSettled((event) => this.onSettled(event));
  }

  getMaxParallel(): number {
    return this.maxParallel;
  }

  getLiveCloneCount(): number {
    return this.liveClones.size;
  }

  onItemSettled(listener: (result: ItemSettledResult) => void): () => void {
    this.settledListeners.add(listener);
    return () => this.settledListeners.delete(listener);
  }

  /**
   * Minimal boot-time reconciliation (NOT full M3 orphan-pid recovery — see
   * HANDOFF §4 M3 and SDD §5.6). Any ledger row still `non-terminal` at the moment
   * this is called predates the current process (a fresh `LaneScheduler` has
   * dispatched nothing yet), so it can only be a turn that never got to settle —
   * most likely the daemon was killed mid-turn. Mark it `INTERRUPTED` (terminal,
   * "not the agent's fault") so its `turnKey` stops blocking idempotent re-attach.
   *
   * TODO(M3): this does NOT read a `turn.json` or kill an orphan OS process — that
   * infrastructure (recording a pid at dispatch time, killing it on boot) does not
   * exist yet. A caller that wants to retry an INTERRUPTED item just calls
   * `dispatchItem` again with `attempt + 1`, which naturally gets a fresh `turnKey`.
   */
  reconcileOnBoot(): void {
    for (const row of this.deps.ledger.all()) {
      if (row.status !== 'non-terminal') continue;
      this.deps.ledger.updateStatus(row.turnKey, { status: 'terminal', outcome: 'INTERRUPTED' });
    }
  }

  async dispatchItem(params: DispatchItemParams): Promise<DispatchItemResult> {
    const {
      batchId, itemId, stage, attempt, templateId, promptMarkdown, envelope, inputHashes, promptVersion,
    } = params;

    const itemRunDir = join(
      this.deps.dataDir, 'workspaces', 'pipeline', batchId, itemId, 'attempts', String(attempt), stage,
    );
    const tk = computeTurnKey({ batchId, itemId, stage, attempt, inputHashes, promptVersion });

    // Step 2 (§6.6 DISPATCH): idempotent re-attach — refuse a second dispatch for a
    // turn_key still non-terminal, re-attach to the recorded turnId instead.
    const existing = this.deps.ledger.findByTurnKey(tk);
    if (existing && existing.status === 'non-terminal' && existing.turnId) {
      return { turnId: Number(existing.turnId), itemRunDir, status: 'RUNNING' };
    }

    // Step 3: write the file-based Agent I/O Contract (SDD §5.2).
    const outDir = join(itemRunDir, 'out');
    await mkdir(join(itemRunDir, 'input'), { recursive: true });
    await mkdir(outDir, { recursive: true });
    await writeFile(join(itemRunDir, 'input', 'envelope.json'), JSON.stringify(envelope, null, 2), 'utf8');
    const promptContent = `${promptMarkdown.trimEnd()}\n\n---\n\n${STANDING_POINTER}\n`;
    await writeFile(join(itemRunDir, 'prompt.md'), promptContent, 'utf8');

    // Sandbox baseline snapshot. Judgment call: this snapshots ONE LEVEL ABOVE
    // itemRunDir (the `attempts/{attempt}` dir), not itemRunDir itself. The stub
    // agent's `write-outside` mode — and realistically any relative `../` escape
    // from an agent whose cwd is itemRunDir (e.g. unconfined Codex, SDD §5.2 "Codex
    // specifics") — lands exactly one level up. Scoping the walk to itemRunDir alone
    // would make the detector blind to precisely the escape vector it exists to
    // catch. Known limitation: two DIFFERENT STAGES of the same (item, attempt)
    // dispatched concurrently would share this snapshot root and could false-flag
    // each other's legitimate writes; M0.5 stages run sequentially per item, so this
    // does not arise in practice yet. (Everything WITHIN one stage's own directory —
    // `out/` or otherwise — is allowed; see the post-settle check below.)
    const sandboxRoot = join(itemRunDir, '..');
    const baselineFiles = await listFilesRecursive(sandboxRoot);

    // Step 4: lane admission — backpressure, not failure.
    if (this.liveClones.size >= this.maxParallel) {
      return { itemRunDir, status: 'WAITING_LANE', reason: 'LANE_BUSY' };
    }

    // Step 5 (ACQUIRE): clone the template agent for this turn.
    const clone = acquireClone(this.deps.agents, {
      templateId, batchId, itemId, attempt, itemRunDir, sessionGroup: params.sessionGroup,
    });
    const cloneId = clone.id;

    // Step 6: dispatch — exclusive + scoped budget, never mcp__team.
    const r = this.deps.workflow.requestTurn(cloneId, 'assignment', undefined, {
      taskNote: ASSIGNMENT_TASK_NOTE,
      overrideCwd: itemRunDir,
      skipWorktree: true,
      allowedTools: ['Read', 'Write', 'Glob'],
      orchestrated: true,
      exclusive: true,
      stallMs: STALL_MS,
      timeoutMs: TIMEOUT_MS,
      budget: {
        scope: batchId,
        maxTurns: params.maxTurns ?? this.defaultMaxTurns,
        maxDurationMinutes: params.maxDurationMinutes ?? this.defaultMaxDurationMinutes,
        cooldownSeconds: 0,
      },
    });

    if (!r.ok || r.turnId === undefined) {
      reapClone(this.deps.agents, cloneId);
      if (isBackpressureRejection(r.reason)) {
        return { itemRunDir, status: 'WAITING_LANE', reason: r.reason };
      }
      return { itemRunDir, status: 'FAILED', reason: r.reason ?? 'AGENT_UNAVAILABLE' };
    }

    // Step 8: record turn_key -> turnId, status RUNNING; track for settlement.
    this.deps.ledger.append({
      turnKey: tk,
      itemId,
      stage,
      attempt,
      status: 'non-terminal',
      turnId: String(r.turnId),
      recordedAt: new Date().toISOString(),
      batchId,
      outcome: 'RUNNING',
    });
    this.liveClones.add(cloneId);
    this.turnRegistry.set(r.turnId, {
      turnKey: tk, batchId, itemId, stage, attempt, itemRunDir, cloneId, sandboxRoot, baselineFiles,
      validateContent: params.validateContent,
    });

    return { turnId: r.turnId, itemRunDir, status: 'RUNNING' };
  }

  private onSettled(event: TurnSettledEvent): void {
    void this.handleSettled(event);
  }

  /** Step 9 (§6.6 DISPATCH): apply the commit rule (SDD §5.2), reap the clone, emit. */
  private async handleSettled(event: TurnSettledEvent): Promise<void> {
    const entry = this.turnRegistry.get(event.turnId);
    if (!entry) return; // Not a pipeline turn (e.g. a Board-loop turn) — ignore.
    this.turnRegistry.delete(event.turnId);
    this.liveClones.delete(entry.cloneId);
    // Always reap, on every path below (success or failure) — a settled turn's
    // clone must not linger (SDD §5.3: "HUMAN_WAIT reaps its clone immediately").
    reapClone(this.deps.agents, entry.cloneId);

    const fail = (errorCode: string): void => {
      this.deps.ledger.updateStatus(entry.turnKey, { status: 'terminal', outcome: 'FAILED', errorCode });
      this.publish({
        batchId: entry.batchId, itemId: entry.itemId, stage: entry.stage, attempt: entry.attempt,
        outcome: 'FAILED', errorCode,
      });
    };

    try {
      // Branch 1: exit code.
      if (event.exitCode !== 0) {
        fail('AGENT_EXIT');
        return;
      }

      // Branch 2: missing output.
      const resultPath = join(entry.itemRunDir, 'out', 'result.json');
      let raw: string;
      try {
        raw = await readFile(resultPath, 'utf8');
      } catch {
        fail('AGENT_NO_OUTPUT');
        return;
      }

      // Branch 3: schema/parse failure.
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        fail('AGENT_SCHEMA');
        return;
      }

      // Branch 4: AGENT_UNGROUNDED — domain-owned grounding check (SDD §5.2). M0.5
      // shipped with no validator wired up (no caller passed one); Training's M1
      // `validateAnalysis` (packages/training-core) is the first caller to supply
      // `validateContent`. Absent it, this is a no-op and every existing/future
      // non-Training caller sees zero behavior change.
      if (entry.validateContent) {
        const validation = entry.validateContent(parsed);
        if (!validation.ok) {
          if (validation.reason) {
            console.error(`[pipeline] ${validation.errorCode} for ${entry.itemId}/${entry.stage}: ${validation.reason}`);
          }
          fail(validation.errorCode);
          return;
        }
      }

      // Branch 5: sandbox violation — post-hoc tree diff (SDD §5.2 "Codex specifics":
      // Codex cannot be technically confined, so this is a detector, not enforcement).
      // Allowed prefix is the WHOLE `{stage}/` cwd, not just `{stage}/out/` (fixed
      // 2026-08-10, real Grok Build bug: `writeGrokMcpConfig` — daemon-owned
      // infrastructure, not agent action — writes `.grok/config.toml` into the turn's
      // own cwd because Grok has no `--mcp-config` flag; that landed at
      // `{stage}/.grok/config.toml` and was being flagged as an escape even though it
      // never left the turn's own directory. The actual threat this branch exists to
      // catch (SDD §5.2 "Codex specifics") is an agent escaping ITS OWN stage
      // directory into a sibling stage or above (see the `write-outside` stub-agent
      // test, which writes to `../escaped.txt` — outside `{stage}/` entirely, still
      // caught). A file anywhere inside `{stage}/`, however it got there, is
      // contained and not a violation.
      const afterFiles = await listFilesRecursive(entry.sandboxRoot);
      const allowedPrefix = `${entry.stage}/`;
      for (const relPath of afterFiles) {
        if (entry.baselineFiles.has(relPath)) continue;
        if (relPath.startsWith(allowedPrefix)) continue;
        fail('AGENT_SANDBOX_VIOLATION');
        return;
      }

      // Branch 6: commit.
      const commit = await commitArtifact({
        runDir: entry.itemRunDir, stage: entry.stage, version: entry.attempt, content: parsed,
      });
      this.deps.ledger.updateStatus(entry.turnKey, { status: 'terminal', outcome: 'COMMITTED', artifactHash: commit.hash });
      this.publish({
        batchId: entry.batchId, itemId: entry.itemId, stage: entry.stage, attempt: entry.attempt,
        outcome: 'COMMITTED', artifactHash: commit.hash,
      });
    } catch (err) {
      // Defensive: never let a bug in the commit path leave the ledger stuck non-terminal.
      fail(`AGENT_INTERNAL:${(err as Error).message}`);
    }
  }

  private publish(result: ItemSettledResult): void {
    for (const listener of this.settledListeners) {
      try { listener(result); } catch { /* isolate bad listeners */ }
    }
  }

  dispose(): void {
    this.unsubscribeSettled();
  }
}
