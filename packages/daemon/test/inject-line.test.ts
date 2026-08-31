/**
 * Interactive inject-line tests (plan inject-real-message-interactive).
 *
 * Unit tests: buildInjectLine emits a PTY-safe Team-MCP wake line for persistent
 * interactive orchestrated turns, keeps the legacy wake lines untouched for
 * headless/team turns, and stays below Claude Code's 1024-byte composer limit.
 *
 * Integration: the workflow hard gate (plan §3.2) fails a persistent interactive
 * orchestrated turn with no taskNote before any spawnTurn, mirroring the
 * spec-build catch path (turn_failed audit, agentPaused, settled with -1).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentDefinition } from '@writer-room/shared';
import {
  buildInjectLine,
  toSafeInteractiveText,
  INTERACTIVE_INJECT_MAX_BYTES,
} from '../src/agents/index.ts';
import { createAgentHarness, type AgentHarness } from '../src/harness.ts';
import type { TeamEvent } from '../src/team/workflow.ts';

const AGENT: AgentDefinition = {
  id: 'codex',
  name: 'Codex',
  role: 'engineer',
  color: '#000',
  prompt: 'You are Codex.',
  adapter: 'codex',
  executable: 'codex',
  args: [],
  projectRoot: '/tmp/project',
  workingDirectoryMode: 'project',
  enabled: true,
};

describe('buildInjectLine', () => {
  test('uses a short Team-MCP wake line for persistent interactive orchestrated turns', () => {
    const line = buildInjectLine(AGENT, 'assignment', 0, true, true, 42, 'Viết file out/result.json');
    expect(line).toContain('team_turn_complete (agentId "codex", turnId 42, status "done")');
    expect(line).toContain('team_get_assignment (agentId "codex")');
    expect(line).not.toContain('Viết file out/result.json');
    expect(line).not.toContain('team_read_messages');
    expect(line).not.toContain('team_send_message (channel');
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(INTERACTIVE_INJECT_MAX_BYTES);
    expect(line.indexOf('team_turn_complete')).toBeLessThan(line.indexOf('team_get_assignment'));
  });

  test('falls back to the orchestrator wake line when taskNote is missing', () => {
    const line = buildInjectLine(AGENT, 'assignment', 0, true, true, 42);
    expect(line).toContain('Gọi team_get_assignment (agentId "codex")');
    expect(line).toContain('team_turn_complete (agentId "codex", turnId 42');
    expect(line).not.toContain('NHIỆM VỤ:');
  });

  test('keeps the orchestrator MCP line for headless orchestrated turns (unchanged contract)', () => {
    const line = buildInjectLine(AGENT, 'assignment', 0, true, true, undefined, 'task for headless');
    expect(line).toContain('Gọi team_get_assignment (agentId "codex")');
    expect(line).toContain('team_update_status (agentId "codex", status "idle")');
    expect(line).not.toContain('NHIỆM VỤ:');
  });

  test('keeps the legacy team lines for non-orchestrated turns (unchanged contract)', () => {
    const assignment = buildInjectLine(AGENT, 'assignment', 0, true, false, 42, 'task');
    expect(assignment).toContain('Gọi MCP tool team_get_assignment');
    expect(assignment).not.toContain('NHIỆM VỤ:');
    const mention = buildInjectLine(AGENT, 'mention', 7, false, false, 42, 'task');
    expect(mention).toContain('team_read_messages (channel "general", afterCursor 7)');
    expect(mention).not.toContain('NHIỆM VỤ:');
  });

  test('interactive embed is never triggered by an empty taskNote', () => {
    const line = buildInjectLine(AGENT, 'assignment', 0, true, true, 42, '   ');
    expect(line).toContain('team_get_assignment');
    expect(line).not.toContain('NHIỆM VỤ:');
  });

  test('toSafeInteractiveText collapses control bytes to a single physical line', () => {
    const dirty = 'Do A\r\nDo B\tDo C\u0000\u001b[31mDo D\u007f';
    const safe = toSafeInteractiveText(dirty);
    expect(safe).not.toMatch(/[\r\n\t\u0000-\u001f\u007f-\u009f]/);
    expect(safe).toContain('Do A Do B Do C');
    expect(safe).toContain('Do D');
    // ESC byte is stripped; any printable payload after it (e.g. "[31m") stays.
    expect(safe).toContain('[31m');
  });

  test('task content is never pasted into the interactive composer', () => {
    const line = buildInjectLine(AGENT, 'assignment', 0, true, true, 42, 'Viết file\r\nout/result.json\tesc\u001b');
    expect(line).not.toMatch(/[\r\n\t\u001b]/);
    expect(line).not.toContain('out/result.json');
    expect(line).toContain('team_get_assignment');
  });

  test('a huge task still produces a wake line below the Claude 1024-byte paste limit', () => {
    const task = 'ế'.repeat(50_000);
    const line = buildInjectLine(AGENT, 'assignment', 0, true, true, 42, task);
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(INTERACTIVE_INJECT_MAX_BYTES);
    expect(line.length).toBeLessThan(task.length);
    expect(line).toContain('team_turn_complete');
  });
});

describe('workflow hard gate for persistent interactive orchestrated turns (plan §3.2)', () => {
  let dir: string;
  let harness: AgentHarness;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wr-inject-'));
    harness = await createAgentHarness({ dataDir: dir, defaultProjectRoot: dir });
  });

  afterEach(() => {
    harness.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  test('fails the turn and emits no spawnTurn when taskNote is missing', async () => {
    const events: TeamEvent[] = [];
    const unsub = harness.subscribe((e) => events.push(e));
    const r = harness.workflow.requestTurn('codex', 'assignment', undefined, {
      orchestrated: true,
      persistentInteractive: true,
    });
    expect(r.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events.some((e) => e.kind === 'spawnTurn')).toBe(false);
    expect(events.some((e) => e.kind === 'turnSettled' && e.status === 'failed' && e.exitCode === -1)).toBe(true);
    expect(events.some((e) => e.kind === 'agentPaused')).toBe(true);
    expect(harness.store.getTurn(r.turnId!)?.status).toBe('failed');
    unsub();
  });

  test('emits a spawnTurn with a bounded MCP wake line when taskNote is present', async () => {
    const events: TeamEvent[] = [];
    const unsub = harness.subscribe((e) => events.push(e));
    const task = 'Viết file out/result.json trong itemRunDir';
    const r = harness.workflow.requestTurn('codex', 'assignment', undefined, {
      orchestrated: true,
      persistentInteractive: true,
      taskNote: task,
    });
    expect(r.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const spawn = events.find((e) => e.kind === 'spawnTurn');
    expect(spawn && spawn.kind === 'spawnTurn').toBe(true);
    if (spawn?.kind === 'spawnTurn') {
      expect(spawn.interactiveRequired).toBe(true);
      expect(spawn.forceHeadless).toBe(false);
      expect(spawn.injectText).not.toContain(task);
      expect(spawn.injectText).toContain('team_get_assignment');
      expect(spawn.injectText).toContain(`turnId ${r.turnId}`);
      expect(Buffer.byteLength(spawn.injectText, 'utf8')).toBeLessThanOrEqual(INTERACTIVE_INJECT_MAX_BYTES);
    }
    unsub();
  });
});
