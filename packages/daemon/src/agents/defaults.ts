/**
 * Default 4 agents for Writer Room harness.
 * Seeded once into data/agents/team.json when empty.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentDefinition } from '@writer-room/shared';
import { AgentConfigStore } from './config.ts';

export const DEFAULT_AGENT_IDS = ['claude', 'codex', 'agy', 'grok'] as const;
export type DefaultAgentId = (typeof DEFAULT_AGENT_IDS)[number];

export function buildDefaultAgents(projectRoot: string): AgentDefinition[] {
  const root = projectRoot;
  return [
    {
      id: 'claude',
      name: 'Claude',
      color: '#d97706',
      role: 'author',
      prompt: 'You are Claude in Writer Room. Prefer clear structure, evidence-backed claims, and Vietnamese when the project content is Vietnamese.',
      adapter: 'claude-code',
      executable: 'claude',
      args: [],
      projectRoot: root,
      workingDirectoryMode: 'project',
      enabled: true,
    },
    {
      id: 'codex',
      name: 'Codex',
      color: '#2563eb',
      role: 'editor',
      prompt: 'You are Codex in Writer Room. Focus on hard-gate review, factual risk, and precise repair notes.',
      adapter: 'codex',
      executable: 'codex',
      args: [],
      projectRoot: root,
      workingDirectoryMode: 'project',
      enabled: true,
    },
    {
      id: 'agy',
      name: 'Antigravity',
      color: '#7c3aed',
      role: 'polish',
      prompt: 'You are Antigravity (agy) in Writer Room. Polish presentation, tighten pacing, keep the authorial voice.',
      adapter: 'agy',
      executable: 'agy',
      // Same launch profile as dna-spy board-agy (empty args → blank/unusable TUI).
      args: [
        '--model',
        'Gemini 3.5 Flash (High)',
        '--mode',
        'accept-edits',
        '--dangerously-skip-permissions',
      ],
      projectRoot: root,
      workingDirectoryMode: 'project',
      enabled: true,
    },
    {
      id: 'grok',
      name: 'Grok',
      color: '#111827',
      role: 'analyst',
      prompt: 'You are Grok in Writer Room. Analyze contract/brief, surface tension and audience promise, challenge weak premises.',
      adapter: 'grok',
      executable: 'grok',
      args: [],
      projectRoot: root,
      workingDirectoryMode: 'project',
      enabled: true,
    },
  ];
}

/**
 * Ensure the four default agents exist.
 * - Empty config → write all four.
 * - Partial config → only insert missing default ids (never overwrite user edits),
 *   except a one-time repair for the broken empty-args Agy seed (dna-spy parity).
 */
export function ensureDefaultAgents(cfg: AgentConfigStore, projectRoot: string): AgentDefinition[] {
  mkdirSync(join(projectRoot), { recursive: true });
  const existing = new Set(cfg.list().map((a) => a.id));
  for (const agent of buildDefaultAgents(projectRoot)) {
    if (!existing.has(agent.id)) {
      cfg.save(agent);
    }
  }
  // Repair: first WR seed used args:[]. dna-spy board-agy always sets model + mode.
  const agy = cfg.get('agy');
  if (agy && agy.adapter === 'agy' && (!agy.args || agy.args.length === 0)) {
    const fixed = buildDefaultAgents(projectRoot).find((a) => a.id === 'agy')!;
    cfg.save({
      ...agy,
      args: [...fixed.args],
      executable: agy.executable || 'agy',
    });
  }
  return cfg.list();
}
