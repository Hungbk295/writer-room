/**
 * Agent config store — `agents/team.json` in app data dir.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { AgentConfigFile, AgentDefinition, TeamGuardConfig } from '@writer-room/shared';

export const DEFAULT_GUARDS: TeamGuardConfig = {
  maxTurns: 30,
  maxTurnsPerPair: 8,
  maxDurationMinutes: 60,
  maxWakeRetries: 3,
  maxQueueDepth: 10,
  cooldownSeconds: 15,
};

const KNOWN_EXECUTABLES: Record<string, string[]> = {
  'claude-code': ['claude'],
  codex: ['codex'],
  agy: ['agy'],
  gemini: ['gemini'],
  grok: ['grok'],
};

const ADAPTERS = new Set(['claude-code', 'codex', 'agy', 'gemini', 'grok']);

export function validateAgent(a: AgentDefinition, opts?: { requireProjectRootExists?: boolean }): string[] {
  const errors: string[] = [];
  if (!a.id || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(a.id)) {
    errors.push('id phải là kebab-case (a-z, 0-9, -), tối đa 41 ký tự');
  }
  if (!a.name?.trim()) errors.push('name trống');
  if (!ADAPTERS.has(a.adapter)) errors.push(`adapter không hỗ trợ: ${a.adapter}`);
  if (!a.executable?.trim()) errors.push('executable trống');
  if (a.executable.includes(' ')) errors.push('executable không được chứa khoảng trắng — args để riêng');
  if (!a.projectRoot?.trim()) errors.push('projectRoot trống');
  else if (!isAbsolute(a.projectRoot)) errors.push('projectRoot phải là đường dẫn tuyệt đối');
  else if (opts?.requireProjectRootExists !== false && !existsSync(a.projectRoot)) {
    errors.push(`projectRoot không tồn tại: ${a.projectRoot}`);
  }
  if (!['project', 'isolated-worktree'].includes(a.workingDirectoryMode)) {
    errors.push(`workingDirectoryMode không hợp lệ: ${a.workingDirectoryMode}`);
  }
  return errors;
}

export function agentWarnings(a: AgentDefinition): string[] {
  const warnings: string[] = [];
  const base = a.executable.split(/[\\/]/).pop() ?? a.executable;
  const known = KNOWN_EXECUTABLES[a.adapter] ?? [];
  if (!known.includes(base.replace(/\.exe$/i, ''))) {
    warnings.push(`executable "${base}" không nằm trong danh sách quen thuộc của adapter ${a.adapter}`);
  }
  if (a.workingDirectoryMode === 'project') {
    warnings.push('shared working tree — agent sửa trực tiếp repo, có thể conflict');
  }
  return warnings;
}

export class AgentConfigStore {
  private path: string;
  private file: AgentConfigFile;

  constructor(dataDir: string) {
    this.path = join(dataDir, 'agents', 'team.json');
    this.file = this.load();
  }

  private load(): AgentConfigFile {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as AgentConfigFile;
      if (raw.version !== 1 || !Array.isArray(raw.agents)) throw new Error('bad shape');
      return raw;
    } catch {
      return { version: 1, agents: [], guards: DEFAULT_GUARDS };
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.file, null, 2));
  }

  list(): AgentDefinition[] {
    return this.file.agents;
  }

  get(id: string): AgentDefinition | undefined {
    return this.file.agents.find((a) => a.id === id);
  }

  save(agent: AgentDefinition): AgentDefinition {
    const errors = validateAgent(agent);
    if (errors.length) throw new Error(`agent config không hợp lệ: ${errors.join('; ')}`);
    const i = this.file.agents.findIndex((a) => a.id === agent.id);
    if (i >= 0) this.file.agents[i] = agent;
    else this.file.agents.push(agent);
    this.persist();
    return agent;
  }

  /** Seed helpers may write before projectRoot is verified on first boot. */
  saveSeed(agent: AgentDefinition): AgentDefinition {
    const errors = validateAgent(agent, { requireProjectRootExists: true });
    if (errors.length) throw new Error(`agent config không hợp lệ: ${errors.join('; ')}`);
    const i = this.file.agents.findIndex((a) => a.id === agent.id);
    if (i >= 0) this.file.agents[i] = agent;
    else this.file.agents.push(agent);
    this.persist();
    return agent;
  }

  delete(id: string): boolean {
    const before = this.file.agents.length;
    this.file.agents = this.file.agents.filter((a) => a.id !== id);
    this.persist();
    return this.file.agents.length < before;
  }

  guards(): TeamGuardConfig {
    return { ...DEFAULT_GUARDS, ...(this.file.guards ?? {}) };
  }

  setGuards(patch: Partial<TeamGuardConfig>): TeamGuardConfig {
    this.file.guards = { ...this.guards(), ...patch };
    this.persist();
    return this.file.guards;
  }

  /** True when file existed on disk before this process created defaults. */
  hadPersistedAgents(): boolean {
    return this.file.agents.length > 0;
  }
}
