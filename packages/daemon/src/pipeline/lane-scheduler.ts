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
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { commitArtifact, turnKey as computeTurnKey } from '@writer-room/pipeline-core';
import type { AgentManager } from '../agents/index.ts';
import type { TeamWorkflow, TurnSettledEvent } from '../team/workflow.ts';
import { acquireClone, reapClone } from './agent-pool.ts';
import type { StageLedger } from './ledger.ts';
import { parseAgentResultJson } from './parse-agent-json.ts';

export interface DispatchItemParams {
  batchId: string;
  itemId: string;
  stage: string;
  attempt: number;
  /** Which agent template to clone — 'claude' | 'codex' (or any configured agent id). */
  templateId: string;
  /** The real instructions written to `prompt.md` (SDD §5.2). */
  promptMarkdown: string;
  /** Opaque, compact metadata — written verbatim to `input/envelope.json`.
   *
   * Large prose belongs in `inputFiles`, never in a JSON string field: a JSON
   * escape turns every Markdown newline into one enormous physical line, which
   * makes line-paginated agent Read tools unable to consume it. */
  envelope: unknown;
  /**
   * Source files staged beneath this turn's `input/` directory. Use ordinary
   * line-readable Markdown/text here (for example `topic-pack.md`) and point to
   * it from the compact envelope with `contentFile: "input/topic-pack.md"`.
   */
  inputFiles?: Array<{
    /** Safe relative path below `input/`; nested directories are allowed. */
    path: string;
    /** File bytes as UTF-8 text. */
    content: string;
  }>;
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
   * Run this item in a live, writable PTY rather than a one-shot `exec` process.
   * The agent must call `team_turn_complete` after writing `out/result.json`; the
   * scheduler remains the only component that validates and commits that file.
   *
   * This is intentionally opt-in. Ordinary pipeline items retain the existing
   * headless, process-exit settlement path.
   */
  interactivePty?: boolean;
  /**
   * When true, never resume the underlying CLI session for this dispatch, even if
   * `sessionGroup` makes the clone id stable (added 2026-08-10, real bug: Training
   * Lab's shared CRITIQUE+REFINE session accumulated 352K+ cached tokens by round
   * 2 — every round's full transcript-sized envelope piling into ONE ever-growing
   * CLI session — and a grok REFINE turn reached `end_turn` without ever calling
   * its write tool, `AGENT_NO_OUTPUT`, likely lost in that much accumulated
   * history). `sessionGroup` still keeps the clone id (and therefore the
   * client-side terminal pane) stable — this field ONLY controls whether
   * `TeamWorkflow.requestTurn`'s `job.freshContext` suppresses `resumeSessionRef`
   * for THIS dispatch, decoupling "stable pane identity" from "unbounded CLI
   * context growth," which were wrongly the same knob before this field existed.
   */
  freshContext?: boolean;
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
  /** Max automatic retries-with-correction on a Branch 4 `validateContent` rejection
   * (added 2026-08-10, user: "trích k đúng thì bắt nó sửa lại là xong sao lại
   * dừng" — a single bad citation used to kill the whole item immediately with no
   * chance to fix it, even though every prompt already tells the agent citations
   * are checked). Defaults to `DEFAULT_MAX_CONTENT_RETRIES`; set 0 to keep the old
   * fail-immediately behavior for a specific caller. Does NOT apply to Branches
   * 1-3/5 (exit code, missing output, bad JSON, sandbox violation) — those are
   * process-level failures, not "content the agent can revise," so retrying them
   * blindly would just mask a different class of bug. */
  maxContentRetries?: number;
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
  /** Free-text detail from `validateContent` (or similar) — surface in UI so
   * `AGENT_SCHEMA`/`DRAFT_LENGTH` are not opaque. Optional; absent on process-level
   * failures (exit/no-output/bad-JSON) that have no further detail. */
  errorReason?: string;
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
  /** The exact params this turn was dispatched with — kept so a Branch 4 rejection
   * can rebuild a corrected retry (`retryWithCorrection`) without the caller having
   * to resupply anything. */
  params: DispatchItemParams;
  maxContentRetries: number;
  retriesUsed: number;
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

/** Up to 3 total tries (1 original + 2 retries) before a Branch 4 rejection becomes
 * a real FAILED — see `DispatchItemParams.maxContentRetries`'s doc comment. */
const DEFAULT_MAX_CONTENT_RETRIES = 2;

/** SDD §5.2 dispatch options table. */
/** Bumped 2026-08-09 after a real M1 run stalled at exactly ~180.0s twice in a row on
 * a ~90KB transcript prompt — timing that precise points at the turnBridge heartbeat
 * never landing at all (see investigation in plan/writer-train/STATUS.md), not at
 * genuine model "thinking" time. Widened as a safety margin while that's diagnosed;
 * revisit once the heartbeat path is confirmed working for real workloads. */
const STALL_MS = 600_000;
const TIMEOUT_MS = 900_000;
/**
 * A live Codex/Claude TUI can be genuinely busy for many minutes without adding
 * text to the terminal ring buffer (for example while composing and writing an
 * 800–1500 word draft). Ring-buffer silence is therefore not a valid PTY failure
 * signal. Keep only a generous absolute cap; normal completion is the agent's
 * `team_turn_complete` MCP call.
 */
const INTERACTIVE_PTY_TIMEOUT_MS = 45 * 60_000;

/**
 * Each dispatch has its own stage directory. A live PTY may deliberately persist
 * across Lab rounds, so its shell cwd can be older than the current stage; pass
 * exact paths instead of relying on the process cwd being current.
 */
function assignmentTaskNote(
  itemRunDir: string,
  inputFiles: ReadonlyArray<NonNullable<DispatchItemParams['inputFiles']>[number]> = [],
): string {
  const promptPath = join(itemRunDir, 'prompt.md');
  const envelopePath = join(itemRunDir, 'input', 'envelope.json');
  const resultPath = join(itemRunDir, 'out', 'result.json');
  const sourcePaths = inputFiles.map((file) => join(itemRunDir, 'input', file.path));
  const sourceNote = sourcePaths.length > 0
    ? ` Read these source text file(s) too: ${sourcePaths.join(', ')}.`
    : '';
  return `Read ${promptPath} and ${envelopePath}.${sourceNote} All staged input is local and line-readable: use filesystem Read only. Do not open Chrome, a browser, Playwright, or file:// URLs. Follow ${promptPath} exactly, then write your result to ${resultPath}. Do not write anywhere else.`;
}

/** Reject paths which could cause a caller-owned input file to escape this turn's
 * `input/` directory. The scheduler owns the filesystem contract, so callers do
 * not need shell access to materialize readable source text. */
function inputFilePath(inputDir: string, filePath: string): string {
  const candidate = join(inputDir, filePath);
  const withinInput = relative(inputDir, candidate);
  if (
    !filePath
    || isAbsolute(filePath)
    || withinInput === ''
    || withinInput === '..'
    || withinInput.startsWith(`..${sep}`)
    || isAbsolute(withinInput)
  ) {
    throw new Error(`inputFiles path must be a non-empty relative path within input/: ${filePath}`);
  }
  return candidate;
}

/** Appended to the end of every `prompt.md` — same "write your result, nowhere else"
 * pointer as the taskNote above, reworded for a first-person read from inside the
 * file itself rather than a reference back to it.
 *
 * Reworded 2026-08-11 after a real agy Training Lab run: the previous "Reply done
 * when the file exists" let content-retries (and session-resumed agents) exit with
 * SUCCESS/`done` while leaving a REJECTED `out/result.json` untouched — file existed,
 * so the agent stopped. Require an overwrite that satisfies the prompt. */
const STANDING_POINTER =
  'Write your result to out/result.json. Do not write anywhere else. If out/result.json '
  + 'already exists from a rejected attempt, you MUST overwrite it with a corrected '
  + 'version that fully satisfies prompt.md (length band, schema, grounding — whatever '
  + 'the prompt requires). Reply "done" only after the corrected file is written.';

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
    return this.dispatchItemInternal(params, 0);
  }

  /** `retriesUsed` is 0 for every real caller (`dispatchItem` above) — only
   * `retryWithCorrection` passes a nonzero value, tracking how many automatic
   * content-retries this logical (batchId, itemId, stage, attempt) has already
   * burned through. */
  private async dispatchItemInternal(params: DispatchItemParams, retriesUsed: number): Promise<DispatchItemResult> {
    const {
      batchId, itemId, stage, attempt, templateId, promptMarkdown, envelope, inputFiles = [], inputHashes, promptVersion,
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
    const inputDir = join(itemRunDir, 'input');
    await mkdir(inputDir, { recursive: true });
    await mkdir(outDir, { recursive: true });
    await writeFile(join(inputDir, 'envelope.json'), JSON.stringify(envelope, null, 2), 'utf8');
    await Promise.all(inputFiles.map(async (file) => {
      const path = inputFilePath(inputDir, file.path);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, file.content, 'utf8');
    }));
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
      taskNote: assignmentTaskNote(itemRunDir, inputFiles),
      overrideCwd: itemRunDir,
      skipWorktree: true,
      allowedTools: ['Read', 'Write', 'Glob'],
      orchestrated: true,
      persistentInteractive: params.interactivePty === true,
      // `freshContext` intentionally discards prior CLI context. In live-PTY mode
      // the equivalent is a replacement pane before the next assignment arrives.
      restartInteractive: params.interactivePty === true && params.freshContext === true,
      exclusive: true,
      freshContext: params.freshContext,
      stallMs: params.interactivePty ? undefined : STALL_MS,
      timeoutMs: params.interactivePty ? INTERACTIVE_PTY_TIMEOUT_MS : TIMEOUT_MS,
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
      params,
      maxContentRetries: params.maxContentRetries ?? DEFAULT_MAX_CONTENT_RETRIES,
      retriesUsed,
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

    const fail = (errorCode: string, errorReason?: string): void => {
      this.deps.ledger.updateStatus(entry.turnKey, { status: 'terminal', outcome: 'FAILED', errorCode });
      this.publish({
        batchId: entry.batchId, itemId: entry.itemId, stage: entry.stage, attempt: entry.attempt,
        outcome: 'FAILED', errorCode, errorReason,
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

      // Branch 3: schema/parse failure — lenient parse (raw newlines in strings are common).
      // No content-retry here (SDD: Branches 1–3 are process-level, not revise-content).
      // Repair recovers the usual agent mistake; still-broken JSON fails with a clear reason.
      const parsedResult = parseAgentResultJson(raw);
      if (!parsedResult.ok) {
        fail('AGENT_SCHEMA', parsedResult.error);
        return;
      }
      if (parsedResult.repaired) {
        console.warn(
          `[pipeline] repaired malformed JSON for ${entry.itemId}/${entry.stage} `
          + `(unescaped control chars and/or trailing junk)`,
        );
        // Persist repaired bytes so later artifact reads match what we committed.
        try {
          await writeFile(resultPath, `${JSON.stringify(parsedResult.value, null, 2)}\n`, 'utf8');
        } catch {
          // non-fatal — commit path still uses `parsed` in memory
        }
      }
      const parsed: unknown = parsedResult.value;

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
          // Mark THIS attempt's own ledger row terminal (accurate bookkeeping — it
          // really was rejected) but do NOT `publish` yet: publishing tells every
          // `onItemSettled` listener (Training Lab, the ANALYZE aggregator) that
          // this (item, stage, attempt) is fully done, and a retry may still turn it
          // into a COMMITTED. Only the LAST attempt (success, or retries exhausted)
          // publishes — see `retryWithCorrection` below.
          this.deps.ledger.updateStatus(entry.turnKey, { status: 'terminal', outcome: 'FAILED', errorCode: validation.errorCode });
          if (entry.retriesUsed < entry.maxContentRetries) {
            await this.retryWithCorrection(entry, validation.errorCode, validation.reason);
            return;
          }
          this.publish({
            batchId: entry.batchId, itemId: entry.itemId, stage: entry.stage, attempt: entry.attempt,
            outcome: 'FAILED', errorCode: validation.errorCode, errorReason: validation.reason,
          });
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

  /**
   * Re-dispatches the SAME logical (batchId, itemId, stage, attempt) with the
   * rejection reason appended to the prompt, asking the agent to fix its own
   * mistake and resubmit (2026-08-10 — see `DispatchItemParams.maxContentRetries`).
   *
   * Deliberately reuses `attempt` (so `itemRunDir` — and therefore `out/result.json`
   * — is the SAME directory the rejected attempt just wrote to; the agent is being
   * asked to fix ITS OWN file, not start from a blank slate) and reuses
   * `sessionGroup` if the caller set one (so `cloneAgentId` — `agent-pool.ts` —
   * produces the SAME clone id, which is what lets the underlying CLI session
   * genuinely resume and see its own prior mistake in context, for adapters with
   * real session resume wired). `inputHashes` gets one new deterministic entry per
   * retry purely so `computeTurnKey` produces a FRESH turn_key — without that, Step
   * 2's idempotent re-attach would treat this as "already dispatched, still
   * running" and never actually spawn a new turn.
   */
  private async retryWithCorrection(
    entry: TurnRegistryEntry,
    errorCode: string,
    reason: string | undefined,
  ): Promise<void> {
    const retryNum = entry.retriesUsed + 1;
    console.error(
      `[pipeline] retrying ${entry.itemId}/${entry.stage} attempt ${entry.attempt} `
      + `(content-retry ${retryNum}/${entry.maxContentRetries})`,
    );
    // Correction text is intentionally stage-neutral (2026-08-11): the previous
    // boilerplate always said "every quote must be verbatim" — that is right for
    // CRITIQUE/ANALYZE grounding failures, but actively MISLEADING on DRAFT length
    // rejections (a real agy run kept rewriting around "quotes" and left the too-long
    // script untouched). Lead with the concrete rejection reason; tell the agent to
    // OVERWRITE the rejected file; only mention verbatim quotes when the reason
    // itself is about grounding/quotes.
    const looksLikeGrounding = Boolean(
      reason && /quote|verbatim|segment|ungrounded|grounding|evidence/i.test(reason),
    );
    const correction = [
      '',
      '---',
      '',
      `RETRY ${retryNum}: your previous out/result.json for this exact task was REJECTED.`,
      reason ? `Reason: ${reason}` : 'Reason: (no further detail available)',
      '',
      'You MUST overwrite out/result.json with a corrected submission. Do not leave the',
      'previous file in place. Do not reply "done" until the new file fully fixes the',
      'rejection above (re-check length/schema/grounding as required by this prompt).',
      ...(looksLikeGrounding
        ? [
            '',
            'Grounding reminder: every quote must be an EXACT verbatim substring of the',
            'source text you were given. Do not paraphrase, summarize, or invent.',
          ]
        : []),
    ].join('\n');
    const retryParams: DispatchItemParams = {
      ...entry.params,
      promptMarkdown: `${entry.params.promptMarkdown}\n${correction}`,
      inputHashes: [
        ...entry.params.inputHashes,
        createHash('sha256').update(`content-retry-${retryNum}`).digest('hex'),
      ],
    };
    const dispatch = await this.dispatchItemInternal(retryParams, retryNum);
    if (dispatch.status !== 'RUNNING') {
      // Could not even start the retry turn (lane busy, agent unavailable) — there
      // is no in-flight turn left that will ever settle this attempt, so publish
      // the ORIGINAL rejection now rather than leaving the item silently stuck.
      this.publish({
        batchId: entry.batchId, itemId: entry.itemId, stage: entry.stage, attempt: entry.attempt,
        outcome: 'FAILED', errorCode, errorReason: reason,
      });
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
