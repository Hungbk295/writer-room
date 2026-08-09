// Terminal & Agent workflow contracts (dna-spy decision 0010, ported to writer-room).
// Shared DTOs for web ↔ Tauri PTY ↔ daemon. No React/Rust/DB deps.

// ---------- Client ↔ Rust PTY ----------

export interface TerminalCreateRequest {
  executable: string;
  args: string[];
  /** empty → Rust uses home dir */
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  agentId?: string;
  readOnly?: boolean;
  turnId?: number;
}

export interface TerminalCreateResult {
  sessionId: string;
  pid: number;
}

export interface TerminalOutputChunk {
  sequence: number;
  /** base64 raw bytes */
  data: string;
}

export interface TerminalSnapshot {
  sequence: number;
  data: string;
}

export interface TerminalSessionSummary {
  sessionId: string;
  pid: number;
  executable: string;
  agentId?: string | null;
  readOnly: boolean;
  running: boolean;
}

export interface TerminalExitEvent {
  sessionId: string;
  exitCode?: number | null;
  turnId?: number | null;
}

// ---------- Agent config (data/agents/team.json) ----------

export type AgentAdapterKind = 'claude-code' | 'codex' | 'agy' | 'gemini' | 'grok';

export interface AgentDefinition {
  id: string;
  name: string;
  color: string;
  role: string;
  prompt: string;
  adapter: AgentAdapterKind;
  executable: string;
  args: string[];
  projectRoot: string;
  workingDirectoryMode: 'project' | 'isolated-worktree';
  enabled: boolean;
  /** True for a pipeline lane-scheduler clone (`daemon/src/pipeline/agent-pool.ts`).
   * Ephemeral agents are excluded from `GET /api/agents` and the Settings UI — they
   * exist only for the lifetime of one turn and must never pollute the Agents page. */
  ephemeral?: boolean;
}

export interface AgentConfigFile {
  version: 1;
  agents: AgentDefinition[];
  guards?: TeamGuardConfig;
}

export interface AgentLaunchSpec {
  agentId: string;
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  preview: string;
  warnings: string[];
  mode: 'interactive' | 'headless-turn';
}

export interface CliAvailability {
  adapter: AgentAdapterKind;
  executable: string;
  found: boolean;
  version?: string;
  error?: string;
}

// ---------- Team hub ----------

export interface TeamMessage {
  cursor: number;
  id: string;
  channel: string;
  senderAgentId: string;
  body: string;
  mentions: string[];
  replyTo?: string | null;
  createdAt: string;
}

export interface TeamSendParams {
  channel: string;
  senderAgentId: string;
  body: string;
  mentions?: string[];
  replyTo?: string;
  idempotencyKey?: string;
}

export interface TeamReadParams {
  channel: string;
  afterCursor?: number;
  limit?: number;
}

export type AgentStatus = 'idle' | 'running' | 'paused' | 'error';

export interface AgentRuntimeState {
  agentId: string;
  status: AgentStatus;
  summary?: string;
  resumeSessionRef?: string;
  updatedAt: string;
}

export interface TeamAssignment {
  agentId: string;
  task: string;
  assignedBy: string;
  createdAt: string;
}

export type TurnReason = 'mention' | 'assignment' | 'human_continue';

export interface TurnRequest {
  id: number;
  agentId: string;
  reason: TurnReason;
  messageCursor: number;
  status: 'queued' | 'running' | 'done' | 'failed' | 'stale' | 'cancelled';
  attempts: number;
  createdAt: string;
}

export interface TeamGuardConfig {
  maxTurns: number;
  maxTurnsPerPair: number;
  maxDurationMinutes: number;
  maxWakeRetries: number;
  maxQueueDepth: number;
  cooldownSeconds: number;
}

export interface TeamAuditEvent {
  id: number;
  kind:
    | 'turn_requested'
    | 'turn_started'
    | 'turn_completed'
    | 'turn_failed'
    | 'turn_paused'
    | 'manual_send'
    | 'agent_killed'
    | 'stop_all'
    | 'guard_triggered';
  agentId?: string | null;
  detail: string;
  createdAt: string;
}

export interface AgentTurnSpawnRequest {
  turnId: number;
  agentId: string;
  spec: AgentLaunchSpec;
}

export interface McpServerInfo {
  url: string;
  token: string;
}

/** Daemon → client automation events (SSE). */
export type TeamEvent =
  | { kind: 'message'; message: TeamMessage }
  | {
      kind: 'spawnTurn';
      turnId: number;
      agentId: string;
      spec: AgentLaunchSpec;
      injectText: string;
      forceHeadless: boolean;
      interactiveRequired?: boolean;
      restartInteractive?: boolean;
    }
  | { kind: 'turnSettled'; turnId: number; agentId: string; status: 'done' | 'failed'; exitCode: number | null }
  | { kind: 'turnTimeout'; turnId: number; agentId: string }
  | { kind: 'interrupt'; agentId: string; turnIds: number[] }
  | { kind: 'agentPaused'; agentId: string; reason: string }
  | { kind: 'guard'; reason: string }
  | { kind: 'stopAll'; cancelled: number };
