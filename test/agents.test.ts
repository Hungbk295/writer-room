import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSettingsStore } from '../src/agents.ts';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('two-agent settings migration', () => {
  test('preserves Claude and Codex overrides from a legacy three-slot config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'writer-room-agents-'));
    dirs.push(root);
    const path = join(root, 'agents.json');
    await writeFile(path, JSON.stringify({
      version: 1,
      agents: [
        { slot: 'agent-1', name: 'Claude custom', role: 'writer', adapter: 'claude', executable: 'claude', model: 'opus', args: ['--verbose'], systemPrompt: 'voice', enabled: true },
        { slot: 'agent-2', name: 'Codex custom', role: 'editor', adapter: 'codex', executable: 'codex', model: 'gpt-custom', args: [], systemPrompt: 'review', enabled: true },
        { slot: 'agent-3', name: 'Legacy SEO', role: 'seo', adapter: 'agy', executable: 'agy', model: 'legacy', args: [], systemPrompt: '', enabled: true },
      ],
    }));
    const profiles = new AgentSettingsStore(path).list();
    expect(profiles).toHaveLength(2);
    expect(profiles[0]).toMatchObject({ slot: 'agent-1', model: 'opus', systemPrompt: 'voice' });
    expect(profiles[1]).toMatchObject({ slot: 'agent-2', model: 'gpt-custom', systemPrompt: 'review' });
  });
});
