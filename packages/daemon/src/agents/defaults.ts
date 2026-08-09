/**
 * Default 4 agents for Writer Room harness.
 * Seeded once into data/agents/team.json when empty.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentDefinition } from '@writer-room/shared';
import { AgentConfigStore } from './config.ts';

export const DEFAULT_AGENT_IDS = ['claude', 'codex', 'agy', 'grok'] as const;
export type DefaultAgentId = (typeof DEFAULT_AGENT_IDS)[number];

/** Claude Code alias for latest Sonnet. */
export const CLAUDE_DEFAULT_ARGS = [
  '--model',
  'sonnet',
] as const;

/**
 * Codex: gpt-5.6-terra + high reasoning effort.
 * Same shape as dna-spy board-claude codex profile
 * (`--model gpt-5.6-terra high`).
 */
export const CODEX_DEFAULT_ARGS = [
  '--model',
  'gpt-5.6-terra',
  'high',
  '--dangerously-bypass-approvals-and-sandbox',
] as const;

/** Real xAI Grok Build (not Homebrew @vibe-kit/grok-cli which needs GROK_API_KEY). */
export function resolveGrokExecutable(): string {
  const home = process.env.HOME || homedir();
  for (const candidate of [
    join(home, '.grok', 'bin', 'grok'),
    join(home, '.local', 'bin', 'grok'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return 'grok';
}

/** Prefer ~/.local/bin/agy when present (same as interactive shell). */
export function resolveAgyExecutable(): string {
  const home = process.env.HOME || homedir();
  for (const candidate of [
    join(home, '.local', 'bin', 'agy'),
    join(home, '.antigravity', 'antigravity', 'bin', 'agy'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return 'agy';
}

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
      args: [...CLAUDE_DEFAULT_ARGS],
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
      args: [...CODEX_DEFAULT_ARGS],
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
      executable: resolveAgyExecutable(),
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
      // Absolute path avoids Homebrew shadowing with @vibe-kit/grok-cli.
      executable: resolveGrokExecutable(),
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
  // Repair known broken first-seed defaults (empty args / wrong binary).
  // Do not overwrite if the user already customized args beyond the old empty seed.
  const defaults = buildDefaultAgents(projectRoot);
  const byId = (id: string) => defaults.find((a) => a.id === id)!;

  const claude = cfg.get('claude');
  if (claude && claude.adapter === 'claude-code' && (!claude.args || claude.args.length === 0)) {
    cfg.save({ ...claude, args: [...byId('claude').args] });
  }

  const codex = cfg.get('codex');
  if (codex && codex.adapter === 'codex' && (!codex.args || codex.args.length === 0
    || (codex.args.length === 1 && codex.args[0] === '--dangerously-bypass-approvals-and-sandbox'))) {
    cfg.save({ ...codex, args: [...byId('codex').args] });
  }

  const agy = cfg.get('agy');
  if (agy && agy.adapter === 'agy' && (!agy.args || agy.args.length === 0)) {
    const fixed = byId('agy');
    cfg.save({
      ...agy,
      args: [...fixed.args],
      executable: agy.executable === 'agy' ? fixed.executable : agy.executable,
    });
  }

  const grok = cfg.get('grok');
  if (grok && grok.adapter === 'grok') {
    const preferred = resolveGrokExecutable();
    // Homebrew @vibe-kit/grok-cli is a different product (needs GROK_API_KEY).
    const isHomebrewVibekit = grok.executable.includes('/opt/homebrew/')
      || grok.executable.includes('/usr/local/Cellar/')
      || (grok.executable === 'grok' && preferred !== 'grok');
    if (isHomebrewVibekit && preferred !== 'grok') {
      cfg.save({ ...grok, executable: preferred });
    }
  }
  return cfg.list();
}
