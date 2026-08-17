/**
 * TeamWorkflow — guarded automation. Board jobs có thể giữ một terminal
 * interactive sống lâu và đánh thức nó qua MCP; các turn thường vẫn dùng
 * headless fallback như trước.
 */
import type { AgentLaunchSpec, TeamGuardConfig, TeamMessage, TurnReason } from '@writer-room/shared';
import { TEAM_CHANNEL, buildInjectLine, type AgentManager } from '../agents/index.ts';
import type { TeamStore } from './store.ts';

const TURN_TIMEOUT_MS = 15 * 60 * 1000;

export type TeamEvent =
  | { kind: 'message'; message: TeamMessage }
  /** injectText: dòng 1-line để client GÕ vào pane interactive của agent nếu
   * đang mở (idiom agentchattr) — chỉ fallback spawn `spec` khi không có pane. */
  | { kind: 'spawnTurn'; turnId: number; agentId: string; spec: AgentLaunchSpec; injectText: string; forceHeadless: boolean; interactiveRequired?: boolean; restartInteractive?: boolean }
  | { kind: 'turnSettled'; turnId: number; agentId: string; status: 'done' | 'failed'; exitCode: number | null }
  | { kind: 'turnTimeout'; turnId: number; agentId: string }
  /** Dừng có chủ đích 1 agent: client kill pane headless của các turnIds và
   * gõ Esc vào pane interactive để ngắt generation đang chạy. */
  | { kind: 'interrupt'; agentId: string; turnIds: number[] }
  | { kind: 'agentPaused'; agentId: string; reason: string }
  | { kind: 'guard'; reason: string }
  | { kind: 'stopAll'; cancelled: number };

export interface WorkflowDeps {
  store: TeamStore;
  agents: AgentManager;
  guards: () => TeamGuardConfig;
  emit: (data: TeamEvent) => void;
  /** inject được trong test */
  now?: () => number;
}

/** Override cho turn đặc thù (review ping-pong) — in-memory, mất khi restart
 * (turn dở dang lúc đó cũng bị reconcile → stale, nên không cần bền). */
export interface TurnJob {
  taskNote?: string;
  overrideCwd?: string;
  skipWorktree?: boolean;
  allowedTools?: string[];
  /** Orchestrator owns sequencing: agent must do only taskNote, without team
   * chat/mentions that would wake agents out of order. */
  orchestrated?: boolean;
  /** Board loop uses one pre-launched interactive pane per agent. The agent
   * must call MCP team_turn_complete after writing its owner artifact. */
  persistentInteractive?: boolean;
  /** Never reuse an adapter session for this turn (Director repair/Critic isolation). */
  freshContext?: boolean;
  /** Reject instead of attaching to an unrelated queued/running turn for this agent. */
  exclusive?: boolean;
  /** Replace the persistent interactive pane before injecting this assignment. */
  restartInteractive?: boolean;
  timeoutMs?: number;
  /** Stall detection window. When set, the turn is killed after this long with
   * NO new terminal ring-buffer output instead of after a fixed wall-clock
   * timeout. A live agent that keeps streaming is never cut off mid-thought;
   * a hung pane is caught in minutes instead of burning the full timeout.
   * `timeoutMs` remains the absolute upper bound. */
  stallMs?: number;
  /** Board-sized runs use a dedicated budget instead of consuming the global chat guard. */
  budget?: { scope: string; maxTurns: number; maxDurationMinutes: number; cooldownSeconds?: number };
}

export interface TurnSettledEvent {
  turnId: number;
  agentId: string;
  status: 'done' | 'failed';
  exitCode: number | null;
}

export class TeamWorkflow {
  private totalTurns = 0;
  private pairTurns = new Map<string, number>();
  private lastTurnEndAt = new Map<string, number>();
  private startedAt: number;
  private stopped = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private turnTimers = new Map<number, ReturnType<typeof setTimeout>>();
  /** stall watchdog poller + mốc heartbeat cuối, theo turnId */
  private turnStallTimers = new Map<number, ReturnType<typeof setInterval>>();
  private turnHeartbeats = new Map<number, number>();
  /** Watchdog state cho turn có stall detection: hạn chót tuyệt đối + mốc
   * output cuối cùng nhìn thấy trên ring buffer của pane. */
  private turnWatchdogs = new Map<number, {
    agentId: string;
    deadlineAt: number;
    stallMs: number;
    lastProgressAt: number;
  }>();
  private turnJobs = new Map<number, TurnJob>();
  private scopedBudgets = new Map<string, { turns: number; startedAt: number }>();
  private settledListeners = new Set<(event: TurnSettledEvent) => void>();

  constructor(private deps: WorkflowDeps) {
    this.startedAt = this.now();
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private schedule(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    // không giữ process sống chỉ vì backoff/cooldown timer
    (t as { unref?: () => void }).unref?.();
    this.timers.add(t);
  }

  /** Watchdog cho một turn đang chạy.
   *
   * Một wall-clock timeout đơn không phân biệt được "agent đang suy nghĩ" với
   * "pane đã treo": cả hai đều chỉ cháy sau đúng N phút. Trong history Board
   * loop, các turn 282/283/317/339/453/501 đều chết ở đúng 1800.0s — con số
   * tròn tuyệt đối, tức là không có việc gì xảy ra cả, chỉ chờ hết đồng hồ.
   *
   * Nên watchdog có hai mốc:
   *  - stallMs: không có heartbeat nào (ring buffer terminal không sinh output
   *    mới) trong khoảng này → coi là treo, kết thúc sớm. Turn dài hợp lệ vẫn
   *    stream liên tục nên không bị oan.
   *  - timeoutMs: hard cap tuyệt đối, vẫn giữ để một agent stream rác vô hạn
   *    không chạy mãi.
   * Không truyền stallMs thì hành vi y như cũ (chỉ hard cap). */
  private armTurnWatchdog(turnId: number, agentId: string, timeoutMs: number, stallMs?: number): void {
    const startedAt = this.now();
    this.turnHeartbeats.set(turnId, startedAt);
    const fire = (reason: string) => {
      this.clearTurnWatchdog(turnId);
      this.deps.store.audit('turn_failed', agentId, `turn ${turnId} ${reason}`);
      this.deps.emit({ kind: 'turnTimeout', turnId, agentId });
      this.turnComplete(turnId, { exitCode: -1 });
    };
    if (stallMs && stallMs > 0) {
      const tick = Math.max(5_000, Math.min(stallMs, 30_000));
      const poll = setInterval(() => {
        if (this.deps.store.getTurn(turnId)?.status !== 'running') {
          this.clearTurnWatchdog(turnId);
          return;
        }
        const now = this.now();
        const last = this.turnHeartbeats.get(turnId) ?? startedAt;
        if (now - last >= stallMs) {
          fire(`stall ${Math.round((now - last) / 1000)}s không có output (giới hạn ${Math.round(stallMs / 1000)}s)`);
        }
      }, tick);
      (poll as { unref?: () => void }).unref?.();
      this.turnStallTimers.set(turnId, poll);
    }
    const timer = setTimeout(() => {
      this.turnTimers.delete(turnId);
      fire(`timeout sau ${timeoutMs / 60000} phút`);
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    this.turnTimers.set(turnId, timer);
  }

  private clearTurnWatchdog(turnId: number): void {
    const timer = this.turnTimers.get(turnId);
    if (timer) { clearTimeout(timer); this.turnTimers.delete(turnId); }
    const poll = this.turnStallTimers.get(turnId);
    if (poll) { clearInterval(poll); this.turnStallTimers.delete(turnId); }
    this.turnHeartbeats.delete(turnId);
  }

  /** Client báo pane của turn này vẫn còn sinh output (ring buffer sequence
   * đổi). Đây là tín hiệu "còn sống" duy nhất đáng tin: sidecar không sở hữu
   * PTY nên không tự thấy được output (decision 0010). */
  heartbeat(turnId: number): { ok: boolean } {
    if (!this.turnHeartbeats.has(turnId)) return { ok: false };
    if (this.deps.store.getTurn(turnId)?.status !== 'running') return { ok: false };
    this.turnHeartbeats.set(turnId, this.now());
    return { ok: true };
  }

  /** Message mới (từ MCP hoặc human qua RPC) → route mentions thành turns.
   * Mention lấy từ CẢ trường mentions LẪN "@id" trong body (idiom agentchattr):
   * agent hay viết "@2 review giúp" mà quên set mentions — trước đây chuỗi đứt
   * ở đúng chỗ này. "@all" = mọi agent trừ người gửi. */
  handleNewMessage(msg: TeamMessage): void {
    this.deps.emit({ kind: 'message', message: msg });
    if (this.stopped) return;
    const known = new Set(this.deps.agents.list().map((a) => a.id));
    const targets = new Set(msg.mentions);
    for (const m of msg.body.matchAll(/@([a-z0-9][a-z0-9-]*)/gi)) {
      const id = m[1]!.toLowerCase();
      if (id === 'all' || id === 'team') for (const k of known) targets.add(k);
      else if (known.has(id)) targets.add(id);
    }
    for (const agentId of targets) {
      if (agentId === msg.senderAgentId) continue;
      this.requestTurn(agentId, 'mention', msg.senderAgentId);
    }
  }

  /** Guard checks → queued turn. Trả lý do nếu từ chối.
   * `job` gắn override cho turn (review ping-pong): cwd workspace + file-tool. */
  requestTurn(agentId: string, reason: TurnReason, senderAgentId?: string, job?: TurnJob): { ok: boolean; reason?: string; turnId?: number } {
    const g = this.deps.guards();
    const reject = (why: string): { ok: boolean; reason: string } => {
      this.deps.store.audit('guard_triggered', agentId, why);
      this.deps.emit({ kind: 'guard', reason: why });
      return { ok: false, reason: why };
    };
    if (this.stopped) return reject('workflow đã stop — bấm reset để chạy lại');
    const scoped = job?.budget;
    const scopedState = scoped
      ? (this.scopedBudgets.get(scoped.scope) ?? { turns: 0, startedAt: this.now() })
      : null;
    if (scoped && scopedState) {
      this.scopedBudgets.set(scoped.scope, scopedState);
      if (scopedState.turns >= scoped.maxTurns) return reject(`đạt scoped maxTurns (${scoped.maxTurns}) cho ${scoped.scope}`);
      if (this.now() - scopedState.startedAt > scoped.maxDurationMinutes * 60_000) return reject(`đạt scoped maxDurationMinutes (${scoped.maxDurationMinutes}) cho ${scoped.scope}`);
    } else if (this.totalTurns >= g.maxTurns) return reject(`đạt maxTurns (${g.maxTurns})`);
    if (!scoped && this.now() - this.startedAt > g.maxDurationMinutes * 60_000) {
      return reject(`đạt maxDurationMinutes (${g.maxDurationMinutes})`);
    }
    if (this.deps.store.turnsByStatus('queued').length >= g.maxQueueDepth) {
      return reject(`đạt maxQueueDepth (${g.maxQueueDepth})`);
    }
    if (senderAgentId) {
      const key = `${senderAgentId}->${agentId}`;
      if ((this.pairTurns.get(key) ?? 0) >= g.maxTurnsPerPair) {
        return reject(`đạt maxTurnsPerPair (${g.maxTurnsPerPair}) cho ${key}`);
      }
      this.pairTurns.set(key, (this.pairTurns.get(key) ?? 0) + 1);
    }
    let agent;
    try {
      agent = this.deps.agents.get(agentId);
    } catch (err) {
      return reject((err as Error).message);
    }
    if (!agent.enabled) return reject(`agent ${agentId} đang disabled`);
    if (job?.exclusive && (
      this.deps.store.turnsByStatus('queued', agentId).length > 0
      || this.deps.store.turnsByStatus('running', agentId).length > 0
    )) return reject(`agent ${agentId} đang có turn khác; Board loop yêu cầu exclusive headless turn`);
    // dedup: đã có turn chờ → mention mới sẽ được đọc trong cùng turn (đọc từ ack).
    // Với job (review): cập nhật job cho turn đang chờ để không mất override.
    const queued = this.deps.store.turnsByStatus('queued', agentId);
    if (queued.length > 0) {
      if (job && queued[0]) {
        this.turnJobs.set(queued[0].id, job);
        // Interactive Board panes fetch their task through MCP rather than
        // receiving the long assignment in the keystroke. Keep the latest
        // queued task in the TeamStore so `team_get_assignment` is the same
        // source of truth for both interactive and headless adapters.
        if (job.taskNote?.trim()) this.deps.store.setAssignment(agentId, job.taskNote.trim(), 'orchestrator');
      }
      return { ok: true, turnId: queued[0]?.id };
    }
    const turn = this.deps.store.createTurn(agentId, reason, this.deps.store.getAck(TEAM_CHANNEL, agentId));
    if (job) {
      this.turnJobs.set(turn.id, job);
      // The persistent interactive Board path deliberately injects only a
      // short wake-up line. Store the full task before dispatch so the agent
      // can retrieve it with team_get_assignment after the pane is awake.
      if (job.taskNote?.trim()) this.deps.store.setAssignment(agentId, job.taskNote.trim(), 'orchestrator');
    }
    this.deps.store.audit('turn_requested', agentId, `turn ${turn.id} (${reason})`);
    this.dispatchNext(agentId);
    return { ok: true, turnId: turn.id };
  }

  /** Chạy turn kế tiếp của agent nếu không có turn đang chạy (1 active turn/agent). */
  private dispatchNext(agentId: string): void {
    if (this.stopped) return;
    if (this.deps.store.turnsByStatus('running', agentId).length > 0) return;
    const next = this.deps.store.turnsByStatus('queued', agentId)[0];
    if (!next) return;
    const g = this.deps.guards();
    const job = this.turnJobs.get(next.id);
    const last = this.lastTurnEndAt.get(agentId) ?? 0;
    const wait = (job?.budget?.cooldownSeconds ?? g.cooldownSeconds) * 1000 - (this.now() - last);
    if (wait > 0) {
      this.schedule(wait, () => this.dispatchNext(agentId));
      return;
    }
    this.deps.store.updateTurn(next.id, { status: 'running' });
    this.totalTurns += 1;
    if (job?.budget) {
      const state = this.scopedBudgets.get(job.budget.scope) ?? { turns: 0, startedAt: this.now() };
      state.turns += 1;
      this.scopedBudgets.set(job.budget.scope, state);
    }
    this.deps.store.audit('turn_started', agentId, `turn ${next.id} (${next.reason})`);
    const taskNote = job?.taskNote ?? (next.reason === 'assignment' ? this.deps.store.getAssignment(agentId)?.task : undefined);
    const persistentInteractive = job?.persistentInteractive === true;
    // Hard gate (plan §3.2): a persistent interactive orchestrated turn has no
    // headless prompt to fall back on — the pane is told to do exactly this task,
    // and `buildInjectLine` embeds it. A missing task would wake the agent into a
    // turn that says nothing to do; fail fast and settle instead of emitting a
    // spawnTurn that can never make progress. Mirrors the spec-build catch block
    // below (same audit/publish path, no `dispatchNext` — a queued sibling turn
    // of the same agent stays queued rather than retrying a broken job).
    if (persistentInteractive && job?.orchestrated === true && !taskNote?.trim()) {
      this.turnJobs.delete(next.id);
      this.deps.store.updateTurn(next.id, { status: 'failed' });
      this.deps.store.audit('turn_failed', agentId, `turn ${next.id} interactive orchestrated turn thiếu taskNote — không emit spawnTurn`);
      this.deps.emit({ kind: 'agentPaused', agentId, reason: `turn ${next.id} thiếu taskNote cho interactive orchestrated turn` });
      this.publishSettled({ turnId: next.id, agentId, status: 'failed', exitCode: -1 });
      return;
    }
    // A Board turn is delivered to a pane that was already launched by the
    // client. Build an actual interactive spec here as well (rather than a
    // discarded `-p` spec) so logs, side effects, and future bridges cannot
    // silently regress to headless execution.
    const specPromise = persistentInteractive
      ? this.deps.agents.buildInteractiveTurnSpec(agentId, job?.overrideCwd)
      : this.deps.agents.buildHeadlessTurnSpec(agentId, {
          reason: next.reason,
          messageCursor: next.messageCursor,
          resumeSessionRef: job?.freshContext ? undefined : this.deps.store.resumeRef(agentId),
          // assignment turn: nhúng task thẳng vào prompt — agent không MCP vẫn nhận việc
          taskNote,
          // tin nhắn chưa đọc nhúng thẳng vào prompt — mention turn không còn rỗng
          // nghĩa với agent chưa/không nối được MCP (nguyên nhân chính "agents
          // không gọi nhau được": gemini/codex wake dậy nhưng mù nội dung).
          recentMessages: this.deps.store.read({ channel: TEAM_CHANNEL, afterCursor: next.messageCursor, limit: 30 }),
          job,
        });
    void specPromise
      .then((spec) => {
        // stopAll có thể chạy trong lúc build spec async → không spawn nữa
        if (this.stopped) {
          this.deps.store.updateTurn(next.id, { status: 'cancelled' });
          return;
        }
        // A narrow interrupt can cancel a running row while the adapter is
        // still building its launch spec.  Do not resurrect that turn after
        // cancellation (and do not emit a pane that the user already stopped).
        if (this.deps.store.getTurn(next.id)?.status !== 'running') return;
        const timeoutMs = Math.max(60_000, job?.timeoutMs ?? TURN_TIMEOUT_MS);
        this.armTurnWatchdog(next.id, agentId, timeoutMs, job?.stallMs);
        const injectText = buildInjectLine(
          this.deps.agents.get(agentId),
          next.reason,
          next.messageCursor,
          Boolean(taskNote?.trim()),
          job?.orchestrated === true,
          persistentInteractive ? next.id : undefined,
          taskNote,
        );
        this.deps.emit({
          kind: 'spawnTurn',
          turnId: next.id,
          agentId,
          spec,
          injectText,
          // Ordinary orchestrated jobs stay headless; Board jobs explicitly
          // require the already-open interactive pane.
          forceHeadless: job?.orchestrated === true && !persistentInteractive,
          ...(persistentInteractive ? { interactiveRequired: true } : {}),
          ...(persistentInteractive && job?.restartInteractive ? { restartInteractive: true } : {}),
        });
      })
      .catch((err) => {
        // config/worktree error — không retry được bằng máy, cần human sửa
        this.turnJobs.delete(next.id);
        this.deps.store.updateTurn(next.id, { status: 'failed' });
        this.deps.store.audit('turn_failed', agentId, `turn ${next.id} build spec lỗi: ${(err as Error).message}`);
        this.deps.emit({ kind: 'agentPaused', agentId, reason: (err as Error).message });
        this.publishSettled({ turnId: next.id, agentId, status: 'failed', exitCode: -1 });
      });
  }

  /** Client báo turn kết thúc (process exit). */
  turnComplete(turnId: number, result: { exitCode: number | null; resumeSessionRef?: string }): void {
    this.clearTurnWatchdog(turnId);
    const turn = this.deps.store.getTurn(turnId);
    if (!turn) return;
    // An interrupted process reports its exit after the store row was already
    // marked cancelled. It must not retry, but it is still the hand-off point
    // at which an unrelated queued turn for that same agent may safely start.
    if (turn.status === 'cancelled') {
      this.lastTurnEndAt.set(turn.agentId, this.now());
      this.dispatchNext(turn.agentId);
      return;
    }
    if (turn.status !== 'running') return; // idempotent
    const agentId = turn.agentId;
    this.lastTurnEndAt.set(agentId, this.now());
    if (result.resumeSessionRef) {
      this.deps.store.setAgentState(agentId, 'idle', undefined, result.resumeSessionRef);
    }
    const job = this.turnJobs.get(turnId);
    if (result.exitCode !== 0 && job?.orchestrated) {
      // BoardLoop already owns phase-level retry/resume and artifact validation.
      // Retrying the same authentication/configuration failure here created
      // four visible PTYs before the orchestrator ever received one failure.
      // Settle exactly once and let the Board panel expose its explicit Retry.
      this.turnJobs.delete(turnId);
      this.deps.store.updateTurn(turnId, { status: 'failed', attempts: turn.attempts + 1 });
      this.deps.store.audit('turn_failed', agentId, `orchestrated turn ${turnId} exit ${result.exitCode ?? 'unknown'} — không auto-retry`);
      this.publishSettled({ turnId, agentId, status: 'failed', exitCode: result.exitCode });
      this.dispatchNext(agentId);
      return;
    }
    if (result.exitCode === 0) {
      this.turnJobs.delete(turnId);
      this.deps.store.updateTurn(turnId, { status: 'done' });
      this.deps.store.audit('turn_completed', agentId, `turn ${turnId} ok`);
      this.publishSettled({ turnId, agentId, status: 'done', exitCode: result.exitCode });
    } else {
      const g = this.deps.guards();
      const attempts = turn.attempts + 1;
      if (attempts <= g.maxWakeRetries && !this.stopped) {
        this.deps.store.updateTurn(turnId, { status: 'queued', attempts });
        const backoff = Math.min(2 ** attempts * 5000, 5 * 60_000);
        this.deps.store.audit('turn_failed', agentId, `turn ${turnId} exit ${result.exitCode} — retry ${attempts}/${g.maxWakeRetries} sau ${backoff / 1000}s`);
        this.schedule(backoff, () => this.dispatchNext(agentId));
        return;
      }
      this.turnJobs.delete(turnId);
      this.deps.store.updateTurn(turnId, { status: 'failed', attempts });
      this.deps.store.audit('turn_paused', agentId, `turn ${turnId} fail quá maxWakeRetries — cần human /continue`);
      this.deps.emit({ kind: 'agentPaused', agentId, reason: `turn ${turnId} fail quá số lần retry` });
      this.publishSettled({ turnId, agentId, status: 'failed', exitCode: result.exitCode });
    }
    this.dispatchNext(agentId);
  }

  /** Dừng CÓ CHỦ ĐÍCH một agent (nút Dừng của ideate/loop): hủy turn
   * queued/running trong store TRƯỚC (turnComplete về sau không retry), clear
   * timer, rồi emit 'interrupt' để client kill pane headless +
   * gõ Esc ngắt pane interactive. Không đụng workflow.stopped — agent khác
   * vẫn chạy bình thường. */
  interruptAgent(agentId: string): { cancelledQueued: number; runningIds: number[] } {
    const r = this.deps.store.cancelTurnsFor(agentId);
    for (const id of r.runningIds) {
      this.clearTurnWatchdog(id);
      this.turnJobs.delete(id);
    }
    this.deps.store.audit('agent_killed', agentId, `interrupt: hủy ${r.cancelledQueued} queued + ${r.runningIds.length} running`);
    this.deps.emit({ kind: 'interrupt', agentId, turnIds: r.runningIds });
    return r;
  }

  /** Narrow counterpart to interruptAgent for orchestrators that own one
   * specific turn. It cancels only that turn and emits a kill event only when
   * that turn was running; queued work for the same agent is left untouched. */
  interruptTurn(turnId: number): { cancelled: boolean; agentId?: string; wasRunning: boolean } {
    const result = this.deps.store.cancelTurn(turnId);
    if (!result.cancelled) return { cancelled: false, wasRunning: false };
    const agentId = result.agentId ?? undefined;
    this.clearTurnWatchdog(turnId);
    this.turnJobs.delete(turnId);
    if (agentId) {
      this.deps.store.audit('agent_killed', agentId, `interrupt turn ${turnId}: hủy đúng turn được yêu cầu`);
      if (result.wasRunning) this.deps.emit({ kind: 'interrupt', agentId, turnIds: [turnId] });
      // A queued turn may have been removed while another turn for this agent is
      // waiting; let the normal dispatcher continue that queue safely.
      if (!result.wasRunning) this.dispatchNext(agentId);
    }
    return { cancelled: true, ...(agentId ? { agentId } : {}), wasRunning: result.wasRunning };
  }

  /** Nút Stop all agents — luôn khả dụng. Client kill process tree các pane. */
  stopAll(): { cancelled: number } {
    this.stopped = true;
    const cancelled = this.deps.store.cancelQueued();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const t of this.turnTimers.values()) clearTimeout(t);
    this.turnTimers.clear();
    for (const p of this.turnStallTimers.values()) clearInterval(p);
    this.turnStallTimers.clear();
    this.turnHeartbeats.clear();
    this.turnJobs.clear();
    this.deps.store.audit('stop_all', null, `stop all — hủy ${cancelled} turn trong queue`);
    this.deps.emit({ kind: 'stopAll', cancelled });
    return { cancelled };
  }

  /** Reset guard counters + mở lại workflow (human action có chủ đích). */
  reset(): void {
    this.stopped = false;
    this.totalTurns = 0;
    this.pairTurns.clear();
    this.startedAt = this.now();
    this.scopedBudgets.clear();
  }

  resetBudgetScope(scope: string): void {
    this.scopedBudgets.delete(scope);
  }

  onTurnSettled(listener: (event: TurnSettledEvent) => void): () => void {
    this.settledListeners.add(listener);
    return () => this.settledListeners.delete(listener);
  }

  /** MCP callback cho persistent interactive Board turn. Validate agent/turn
   * ownership trước khi chuyển qua cùng một settle path với process exit. */
  completeInteractiveTurn(turnId: number, agentId: string, status: 'done' | 'failed', summary?: string): void {
    const turn = this.deps.store.getTurn(turnId);
    if (!turn) throw new Error(`turn ${turnId} không tồn tại`);
    if (turn.agentId !== agentId) throw new Error(`turn ${turnId} không thuộc agent ${agentId}`);
    if (summary?.trim()) this.deps.store.audit('turn_completed', agentId, `turn ${turnId}: ${summary.trim().slice(0, 500)}`);
    this.turnComplete(turnId, { exitCode: status === 'done' ? 0 : -1 });
  }

  private publishSettled(event: TurnSettledEvent): void {
    this.deps.emit({ kind: 'turnSettled', ...event });
    for (const listener of this.settledListeners) listener(event);
  }

  status(): {
    stopped: boolean;
    totalTurns: number;
    queued: number;
    running: number;
    startedAt: number;
    guards: TeamGuardConfig;
  } {
    return {
      stopped: this.stopped,
      totalTurns: this.totalTurns,
      queued: this.deps.store.turnsByStatus('queued').length,
      running: this.deps.store.turnsByStatus('running').length,
      startedAt: this.startedAt,
      guards: this.deps.guards(),
    };
  }
}
