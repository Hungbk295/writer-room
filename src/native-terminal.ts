import type { AgentProfile, AgentRole } from './domain.ts';
import { defaultAgentProfiles } from './domain.ts';
import type { TerminalController, ToolHealth } from './terminal.ts';

export type NativeEventSink = (event: string, payload: unknown) => void;

async function findExecutable(executable: string): Promise<string | null> {
  if (executable === 'mock') return 'mock';
  try { return Bun.which(executable) || null; }
  catch { return null; }
}

/** Terminal adapter used by the compiled bridge. Rust owns PTY/ConPTY. */
export class NativeTerminalController implements TerminalController {
  constructor(private readonly emit: NativeEventSink, private readonly mock = process.env.WRITER_ROOM_MOCK === '1') {}

  async health(profiles = defaultAgentProfiles()): Promise<ToolHealth> {
    const values = await Promise.all(profiles.map(async (profile) => [profile.slot, this.mock ? 'mock' : await findExecutable(profile.executable)] as const));
    const tools = Object.fromEntries([['runtime', process.execPath], ['terminal', this.mock ? 'mock' : 'native-pty'], ...values]);
    return {
      ok: values.every(([, path]) => Boolean(path)),
      tools,
      mock: this.mock,
      transport: this.mock ? 'mock' : 'native',
      agents: profiles.map((profile) => ({
        slot: profile.slot,
        name: profile.name,
        adapter: profile.adapter,
        model: profile.model,
        executable: profile.executable,
        found: Boolean(tools[profile.slot]),
      })),
    };
  }

  async ensureSession(session: string, cwd: string): Promise<void> {
    this.emit('terminal.ensure', { session, cwd, roles: ['agent-1', 'agent-2'] });
  }

  async runJob(session: string, role: AgentRole, cwd: string, descriptorPath: string): Promise<void> {
    this.emit('terminal.run', { session, role, cwd, descriptorPath });
  }

  async killSession(session: string): Promise<void> {
    this.emit('terminal.kill', { session });
  }

  async isRoleRunning(): Promise<boolean> {
    return false;
  }
}
