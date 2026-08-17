/**
 * Interactive inject-line tests (plan inject-real-message-interactive).
 *
 * Unit tests: buildInjectLine embeds a PTY-safe real task for persistent
 * interactive orchestrated turns, keeps the legacy MCP wake lines untouched for
 * headless/team turns, and honors the 8 KiB task / 12 KiB total caps.
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
  TASK_INJECT_MAX_BYTES,
  INJECT_TEXT_MAX_BYTES,
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
  test('embeds the real task for persistent interactive orchestrated turns', () => {
    const line = buildInjectLine(AGENT, 'assignment', 0, true, true, 42, 'Viết file out/result.json');
    expect(line).toContain('NHIỆM VỤ: Viết file out/result.json');
    expect(line).toContain('team_turn_complete (agentId "codex", turnId 42, status "done")');
    expect(line).not.toContain('team_get_assignment');
    expect(line).not.toContain('team_read_messages');
    expect(line).not.toContain('team_send_message (channel');
    expect(line).toContain('Chỉ làm nhiệm vụ trên; không đọc chat cũ, không team_send_message');
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

  test('PTY-safety is applied inside the interactive embed', () => {
    const line = buildInjectLine(AGENT, 'assignment', 0, true, true, 42, 'Viết file\r\nout/result.json\tesc\u001b');
    expect(line).not.toMatch(/[\r\n\t\u001b]/);
    expect(line).toContain('NHIỆM VỤ: Viết file out/result.json esc');
  });

  test('a task over the 8 KiB cap is truncated on a UTF-8 boundary with a marker', () => {
    const task = 't'.repeat(TASK_INJECT_MAX_BYTES + 2048);
    const line = buildInjectLine(AGENT, 'assignment', 0, true, true, 42, task);
    expect(line).toContain('… [task truncated; call team_get_assignment for the full assignment]');
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(INJECT_TEXT_MAX_BYTES);
  });

  test('a multi-byte char is never split mid-code-point at the cap', () => {
    const base = 'abc';
    const task = base + 'ế'.repeat(INJECT_TEXT_MAX_BYTES);
    const line = buildInjectLine(AGENT, 'assignment', 0, true, true, 42, task);
    const withoutMarker = line.replace('… [task truncated; call team_get_assignment for the full assignment]', '');
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(INJECT_TEXT_MAX_BYTES);
    expect(withoutMarker).not.toMatch(/\uFFFD/); // no replacement char
    expect(withoutMarker).not.toMatch(/[\uD800-\uDFFF]/); // no lone surrogate
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

  test('emits a spawnTurn with the embedded task when taskNote is present', async () => {
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
      expect(spawn.injectText).toContain('NHIỆM VỤ:');
      expect(spawn.injectText).toContain(task);
      expect(spawn.injectText).not.toContain('team_get_assignment');
    }
    unsub();
  });
});