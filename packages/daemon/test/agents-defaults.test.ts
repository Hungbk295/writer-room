import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentConfigStore } from '../src/agents/config.ts';
import { buildDefaultAgents, ensureDefaultAgents, DEFAULT_AGENT_IDS } from '../src/agents/defaults.ts';
import { getAdapter } from '../src/agents/adapters.ts';
import { createAgentHarness } from '../src/harness.ts';

describe('default agents', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wr-agents-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('buildDefaultAgents returns claude, codex, agy, grok', () => {
    const agents = buildDefaultAgents('/tmp/project');
    expect(agents.map((a) => a.id)).toEqual([...DEFAULT_AGENT_IDS]);
    expect(agents.every((a) => a.enabled)).toBe(true);
    expect(agents.find((a) => a.id === 'claude')?.adapter).toBe('claude-code');
    expect(agents.find((a) => a.id === 'codex')?.adapter).toBe('codex');
    expect(agents.find((a) => a.id === 'agy')?.adapter).toBe('agy');
    expect(agents.find((a) => a.id === 'grok')?.adapter).toBe('grok');
  });

  test('ensureDefaultAgents seeds empty store and does not overwrite edits', () => {
    const cfg = new AgentConfigStore(dir);
    ensureDefaultAgents(cfg, dir);
    expect(cfg.list().map((a) => a.id).sort()).toEqual([...DEFAULT_AGENT_IDS].sort());

    const claude = cfg.get('claude')!;
    claude.name = 'Claude Custom';
    cfg.save(claude);

    ensureDefaultAgents(cfg, dir);
    expect(cfg.get('claude')?.name).toBe('Claude Custom');
    expect(cfg.list()).toHaveLength(4);
  });

  test('grok adapter builds interactive and headless specs without --mcp-config', () => {
    const agent = buildDefaultAgents(dir).find((a) => a.id === 'grok')!;
    const adapter = getAdapter('grok');
    const interactive = adapter.buildInteractive(agent, {
      cwd: dir,
      mcpConfigPath: '/tmp/fake-mcp.json',
      mcp: { url: 'http://127.0.0.1:9/mcp', token: 't' },
    });
    expect(interactive.mode).toBe('interactive');
    expect(interactive.args).not.toContain('--mcp-config');
    expect(interactive.args).not.toContain('--fullscreen');

    const headless = adapter.buildHeadlessTurn(agent, {
      cwd: dir,
      turnPrompt: 'do the thing',
      mcpConfigPath: '/tmp/fake-mcp.json',
    });
    expect(headless.mode).toBe('headless-turn');
    expect(headless.args).not.toContain('--mcp-config');
    expect(headless.args.some((a) => a.includes('do the thing'))).toBe(true);
  });

  test('agy interactive matches dna-spy board profile (no print, has model)', () => {
    const agent = buildDefaultAgents(dir).find((a) => a.id === 'agy')!;
    const adapter = getAdapter('agy');
    const interactive = adapter.buildInteractive(agent, {
      cwd: dir,
      mcp: { url: 'http://127.0.0.1:9/mcp', token: 't' },
      pathEnv: process.env.PATH,
    });
    expect(interactive.executable).toBe('agy');
    expect(interactive.args).not.toContain('--print');
    expect(interactive.args).not.toContain('--mcp-config');
    expect(interactive.args).toContain('--model');
    expect(interactive.args).toContain('--dangerously-skip-permissions');
    expect(interactive.args).toContain('accept-edits');
    // dna-spy baseSpec: env is PATH-only
    expect(Object.keys(interactive.env)).toEqual(['PATH']);
  });

  test('createAgentHarness starts MCP and seeds four agents', async () => {
    const harness = await createAgentHarness({ dataDir: dir, defaultProjectRoot: dir });
    try {
      expect(harness.listAgents()).toHaveLength(4);
      const mcp = harness.teamMcpInfo();
      expect(mcp?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      expect(mcp?.token.length).toBeGreaterThan(10);

      const preview = harness.agents.launchPreview('claude');
      expect(preview.agentId).toBe('claude');
      // Adapter resolves short names to absolute PATH entries when available.
      expect(preview.executable === 'claude' || preview.executable.endsWith('/claude')).toBe(true);
    } finally {
      harness.dispose();
    }
  });
});
