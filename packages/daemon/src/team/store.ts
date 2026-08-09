/**
 * Team store — SQLite. Messages with monotonic cursor; turns + audit for automation.
 * Daemon restart: unfinished turns → 'stale'.
 */
import { randomUUID } from 'node:crypto';
import type {
  AgentRuntimeState, AgentStatus, TeamAssignment, TeamAuditEvent, TeamMessage,
  TeamReadParams, TeamSendParams, TurnReason, TurnRequest,
} from '@writer-room/shared';
import { nowIso, type Db } from './db.ts';
import { redactSecrets } from './redact.ts';

function rowToMessage(r: Record<string, unknown>): TeamMessage {
  return {
    cursor: Number(r['cursor']),
    id: String(r['id']),
    channel: String(r['channel']),
    senderAgentId: String(r['sender_agent_id']),
    body: String(r['body']),
    mentions: JSON.parse(String(r['mentions_json'] ?? '[]')) as string[],
    replyTo: (r['reply_to'] as string | null) ?? null,
    createdAt: String(r['created_at']),
  };
}

function rowToTurn(r: Record<string, unknown>): TurnRequest {
  return {
    id: Number(r['id']),
    agentId: String(r['agent_id']),
    reason: String(r['reason']) as TurnReason,
    messageCursor: Number(r['message_cursor']),
    status: String(r['status']) as TurnRequest['status'],
    attempts: Number(r['attempts']),
    createdAt: String(r['created_at']),
  };
}

export class TeamStore {
  constructor(private db: Db) {}

  reconcileStale(): number {
    const rows = this.db
      .prepare(`SELECT id FROM team_turns WHERE status IN ('queued','running')`)
      .all() as Array<Record<string, unknown>>;
    this.db
      .prepare(`UPDATE team_turns SET status = 'stale', updated_at = ? WHERE status IN ('queued','running')`)
      .run(nowIso());
    if (rows.length) this.audit('guard_triggered', null, `daemon restart: ${rows.length} turn dở dang → stale`);
    return rows.length;
  }

  send(params: TeamSendParams): TeamMessage {
    if (!params.channel?.trim()) throw new Error('channel trống');
    if (!params.body?.trim()) throw new Error('body trống');
    if (params.idempotencyKey) {
      const existing = this.db
        .prepare('SELECT * FROM team_messages WHERE idempotency_key = ?')
        .get(params.idempotencyKey) as Record<string, unknown> | null;
      if (existing) return rowToMessage(existing);
    }
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO team_messages (id, channel, sender_agent_id, body, mentions_json, reply_to, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.channel,
        params.senderAgentId,
        redactSecrets(params.body),
        JSON.stringify(params.mentions ?? []),
        params.replyTo ?? null,
        params.idempotencyKey ?? null,
        nowIso(),
      );
    const row = this.db.prepare('SELECT * FROM team_messages WHERE id = ?').get(id) as Record<string, unknown>;
    return rowToMessage(row);
  }

  read(params: TeamReadParams): TeamMessage[] {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 500);
    const rows = this.db
      .prepare('SELECT * FROM team_messages WHERE channel = ? AND cursor > ? ORDER BY cursor ASC LIMIT ?')
      .all(params.channel, params.afterCursor ?? 0, limit) as Array<Record<string, unknown>>;
    return rows.map(rowToMessage);
  }

  latestCursor(channel: string): number {
    const row = this.db.prepare('SELECT MAX(cursor) AS c FROM team_messages WHERE channel = ?').get(channel) as Record<string, unknown> | null;
    return Number(row?.['c'] ?? 0);
  }

  channels(): string[] {
    return (this.db
      .prepare('SELECT DISTINCT channel FROM team_messages ORDER BY channel')
      .all() as Array<Record<string, unknown>>)
      .map((r) => String(r['channel']));
  }

  ack(channel: string, agentId: string, throughCursor: number): void {
    this.db
      .prepare(
        `INSERT INTO team_acks (channel, agent_id, through_cursor, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(channel, agent_id) DO UPDATE SET
           through_cursor = CASE WHEN excluded.through_cursor > team_acks.through_cursor THEN excluded.through_cursor ELSE team_acks.through_cursor END,
           updated_at = excluded.updated_at`,
      )
      .run(channel, agentId, throughCursor, nowIso());
  }

  getAck(channel: string, agentId: string): number {
    const row = this.db
      .prepare('SELECT through_cursor FROM team_acks WHERE channel = ? AND agent_id = ?')
      .get(channel, agentId) as Record<string, unknown> | null;
    return Number(row?.['through_cursor'] ?? 0);
  }

  setAssignment(agentId: string, task: string, assignedBy: string): TeamAssignment {
    this.db
      .prepare(
        `INSERT INTO team_assignments (agent_id, task, assigned_by, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET task = excluded.task, assigned_by = excluded.assigned_by, created_at = excluded.created_at`,
      )
      .run(agentId, task, assignedBy, nowIso());
    return this.getAssignment(agentId)!;
  }

  getAssignment(agentId: string): TeamAssignment | null {
    const r = this.db.prepare('SELECT * FROM team_assignments WHERE agent_id = ?').get(agentId) as Record<string, unknown> | null;
    if (!r) return null;
    return {
      agentId: String(r['agent_id']),
      task: String(r['task']),
      assignedBy: String(r['assigned_by']),
      createdAt: String(r['created_at']),
    };
  }

  setAgentState(agentId: string, status: AgentStatus, summary?: string, resumeSessionRef?: string): void {
    this.db
      .prepare(
        `INSERT INTO team_agent_state (agent_id, status, summary, resume_session_ref, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET status = excluded.status,
           summary = COALESCE(excluded.summary, team_agent_state.summary),
           resume_session_ref = COALESCE(excluded.resume_session_ref, team_agent_state.resume_session_ref),
           updated_at = excluded.updated_at`,
      )
      .run(agentId, status, summary ?? null, resumeSessionRef ?? null, nowIso());
  }

  agentStates(): AgentRuntimeState[] {
    return (this.db.prepare('SELECT * FROM team_agent_state').all() as Array<Record<string, unknown>>).map((r) => ({
      agentId: String(r['agent_id']),
      status: String(r['status']) as AgentStatus,
      summary: (r['summary'] as string | null) ?? undefined,
      resumeSessionRef: (r['resume_session_ref'] as string | null) ?? undefined,
      updatedAt: String(r['updated_at']),
    }));
  }

  resumeRef(agentId: string): string | undefined {
    const r = this.db.prepare('SELECT resume_session_ref FROM team_agent_state WHERE agent_id = ?').get(agentId) as Record<string, unknown> | null;
    return (r?.['resume_session_ref'] as string | null) ?? undefined;
  }

  createTurn(agentId: string, reason: TurnReason, messageCursor: number): TurnRequest {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO team_turns (agent_id, reason, message_cursor, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, 'queued', 0, ?, ?)`,
      )
      .run(agentId, reason, messageCursor, now, now);
    const r = this.db
      .prepare('SELECT * FROM team_turns WHERE agent_id = ? ORDER BY id DESC LIMIT 1')
      .get(agentId) as Record<string, unknown>;
    return rowToTurn(r);
  }

  getTurn(id: number): TurnRequest | null {
    const r = this.db.prepare('SELECT * FROM team_turns WHERE id = ?').get(id) as Record<string, unknown> | null;
    return r ? rowToTurn(r) : null;
  }

  updateTurn(id: number, patch: { status?: TurnRequest['status']; attempts?: number }): void {
    const cur = this.getTurn(id);
    if (!cur) return;
    this.db
      .prepare('UPDATE team_turns SET status = ?, attempts = ?, updated_at = ? WHERE id = ?')
      .run(patch.status ?? cur.status, patch.attempts ?? cur.attempts, nowIso(), id);
  }

  turnsByStatus(status: TurnRequest['status'], agentId?: string): TurnRequest[] {
    const rows = (agentId
      ? this.db.prepare('SELECT * FROM team_turns WHERE status = ? AND agent_id = ? ORDER BY id ASC').all(status, agentId)
      : this.db.prepare('SELECT * FROM team_turns WHERE status = ? ORDER BY id ASC').all(status)) as Array<Record<string, unknown>>;
    return rows.map(rowToTurn);
  }

  cancelQueued(): number {
    const n = this.turnsByStatus('queued').length;
    this.db
      .prepare(`UPDATE team_turns SET status = 'cancelled', updated_at = ? WHERE status = 'queued'`)
      .run(nowIso());
    return n;
  }

  cancelTurnsFor(agentId: string): { cancelledQueued: number; runningIds: number[] } {
    const running = this.turnsByStatus('running', agentId).map((t) => t.id);
    const queued = this.turnsByStatus('queued', agentId).length;
    this.db
      .prepare(`UPDATE team_turns SET status = 'cancelled', updated_at = ? WHERE agent_id = ? AND status IN ('queued','running')`)
      .run(nowIso(), agentId);
    return { cancelledQueued: queued, runningIds: running };
  }

  cancelTurn(turnId: number): { cancelled: boolean; agentId: string | null; wasRunning: boolean } {
    const turn = this.getTurn(turnId);
    if (!turn || !['queued', 'running'].includes(turn.status)) {
      return { cancelled: false, agentId: turn?.agentId ?? null, wasRunning: false };
    }
    this.db
      .prepare(`UPDATE team_turns SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('queued','running')`)
      .run(nowIso(), turnId);
    const current = this.getTurn(turnId);
    return {
      cancelled: current?.status === 'cancelled',
      agentId: turn.agentId,
      wasRunning: turn.status === 'running',
    };
  }

  latestTurn(agentId: string): TurnRequest | null {
    const r = this.db.prepare('SELECT * FROM team_turns WHERE agent_id = ? ORDER BY id DESC LIMIT 1').get(agentId) as Record<string, unknown> | null;
    return r ? rowToTurn(r) : null;
  }

  audit(kind: TeamAuditEvent['kind'], agentId: string | null, detail: string): void {
    this.db
      .prepare('INSERT INTO team_audit_events (kind, agent_id, detail, created_at) VALUES (?, ?, ?, ?)')
      .run(kind, agentId, redactSecrets(detail), nowIso());
  }

  listAudit(limit = 100): TeamAuditEvent[] {
    return (this.db
      .prepare('SELECT * FROM team_audit_events ORDER BY id DESC LIMIT ?')
      .all(Math.min(limit, 500)) as Array<Record<string, unknown>>)
      .map((r) => ({
        id: Number(r['id']),
        kind: String(r['kind']) as TeamAuditEvent['kind'],
        agentId: (r['agent_id'] as string | null) ?? null,
        detail: String(r['detail']),
        createdAt: String(r['created_at']),
      }));
  }
}
