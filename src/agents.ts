import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { APP_DATA_ROOT } from './store.ts';
import { defaultAgentProfiles, normalizeAgentProfiles, type AgentProfile } from './domain.ts';

interface AgentConfigFile {
  version: 1 | 2;
  agents: unknown;
}

/** Global editable profile set. Runs copy this into RunConfig at creation. */
export class AgentSettingsStore {
  readonly path: string;
  private profiles: AgentProfile[];

  constructor(path = join(APP_DATA_ROOT, 'config', 'agents.json')) {
    this.path = path;
    this.profiles = this.load();
  }

  private load(): AgentProfile[] {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as AgentConfigFile;
      if (raw.version !== 1 && raw.version !== 2) throw new Error('unsupported agent config version');
      const agents = raw.version === 1 && Array.isArray(raw.agents)
        ? raw.agents.filter((item) => item && typeof item === 'object'
          && ((item as Record<string, unknown>).slot === 'agent-1' || (item as Record<string, unknown>).slot === 'agent-2'))
        : raw.agents;
      return normalizeAgentProfiles(agents);
    } catch {
      return defaultAgentProfiles();
    }
  }

  list(): AgentProfile[] {
    return this.profiles.map((profile) => ({ ...profile, args: [...profile.args] }));
  }

  save(raw: unknown): AgentProfile[] {
    const profiles = normalizeAgentProfiles(raw);
    if (profiles.some((profile) => !profile.enabled)) throw new Error('both agents must be enabled for the Writer Room loop');
    const next: AgentConfigFile = { version: 2, agents: profiles };
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx' });
    // Same-filesystem rename is atomic; an incomplete settings write cannot be loaded.
    renameSync(tmp, this.path);
    this.profiles = profiles;
    return this.list();
  }

  exists(): boolean {
    return existsSync(this.path);
  }
}
