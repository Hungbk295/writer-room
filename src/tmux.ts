import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { defaultAgentProfiles, type AgentProfile, type AgentRole } from './domain.ts';
import { APP_ROOT } from './store.ts';
import type { TerminalController, ToolHealth } from './terminal.ts';

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function command(executable: string, args: string[], accept = [0]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      const result = { code: code ?? -1, stdout, stderr };
      if (accept.includes(result.code)) resolve(result);
      else reject(new Error(`${executable} ${args.join(' ')} exited ${result.code}: ${(stderr || stdout).trim()}`));
    });
  });
}

async function which(executable: string): Promise<string | null> {
  try {
    const result = await command('which', [executable]);
    return result.stdout.trim() || null;
  } catch { return null; }
}

async function descendantPids(rootPid: number): Promise<number[]> {
  try {
    const result = await command('ps', ['-axo', 'pid=,ppid=']);
    const childrenMap = new Map<number, number[]>();
    for (const line of result.stdout.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) {
        const pid = parseInt(parts[0]!, 10);
        const ppid = parseInt(parts[1]!, 10);
        if (!isNaN(pid) && !isNaN(ppid)) {
          if (!childrenMap.has(ppid)) childrenMap.set(ppid, []);
          childrenMap.get(ppid)!.push(pid);
        }
      }
    }
    const resultPids: number[] = [];
    function collect(parent: number) {
      const list = childrenMap.get(parent) || [];
      for (const child of list) {
        collect(child);
        resultPids.push(child);
      }
    }
    collect(rootPid);
    return resultPids;
  } catch {
    return [];
  }
}

async function killProcessTree(rootPid: number): Promise<void> {
  const pids = await descendantPids(rootPid);
  pids.push(rootPid);
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* process already exited */ }
  }
}

export class TmuxController implements TerminalController {
  constructor(private readonly mock = process.env.WRITER_ROOM_MOCK === '1') {}

  async health(profiles = defaultAgentProfiles()): Promise<ToolHealth> {
    if (this.mock) {
      return {
        ok: true,
        tools: { bun: process.execPath, tmux: 'mock', ...Object.fromEntries(profiles.map((profile) => [profile.slot, 'mock'])) },
        mock: true,
        transport: 'mock',
        agents: profiles.map((profile) => ({ slot: profile.slot, name: profile.name, adapter: profile.adapter, model: profile.model, executable: profile.executable, found: true })),
      };
    }
    const names = {
      bun: process.env.WRITER_ROOM_BUN_BIN || 'bun',
      tmux: process.env.WRITER_ROOM_TMUX_BIN || 'tmux',
    };
    const values = await Promise.all([
      ...Object.entries(names).map(async ([name, executable]) => [name, await which(executable)] as const),
      ...profiles.map(async (profile) => [profile.slot, await which(profile.executable)] as const),
    ]);
    const tools = Object.fromEntries(values);
    return {
      ok: Object.values(tools).every(Boolean),
      tools,
      mock: false,
      transport: 'tmux',
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
    if (this.mock) return;
    const tmux = process.env.WRITER_ROOM_TMUX_BIN || 'tmux';
    const present = await command(tmux, ['has-session', '-t', session], [0, 1]);
    if (present.code === 0) return;
    await command(tmux, ['new-session', '-d', '-s', session, '-n', 'agent-1', '-c', cwd]);
    await command(tmux, ['new-window', '-d', '-t', session, '-n', 'agent-2', '-c', cwd]);
    await command(tmux, ['set-option', '-t', session, 'remain-on-exit', 'on']);
  }

  async runJob(session: string, role: AgentRole, cwd: string, descriptorPath: string): Promise<void> {
    if (this.mock) return;
    const tmux = process.env.WRITER_ROOM_TMUX_BIN || 'tmux';
    const bun = process.env.WRITER_ROOM_BUN_BIN || process.execPath || 'bun';
    const runner = join(APP_ROOT, 'src', 'pane-runner.ts');
    const shellCommand = `${shellQuote(bun)} ${shellQuote(runner)} ${shellQuote(descriptorPath)}`;
    const slot = role === 'writer' ? 'agent-1' : 'agent-2';
    await command(tmux, ['respawn-pane', '-k', '-t', `${session}:${slot}`, '-c', cwd, shellCommand]);
    await command(tmux, ['select-window', '-t', `${session}:${slot}`]);
  }

  async killSession(session: string): Promise<void> {
    if (this.mock) return;
    const tmux = process.env.WRITER_ROOM_TMUX_BIN || 'tmux';
    try {
      const panesResult = await command(tmux, ['list-panes', '-s', '-t', session, '-F', '#{pane_pid}'], [0, 1]);
      if (panesResult.code === 0 && panesResult.stdout.trim()) {
        const panePids = panesResult.stdout.trim().split('\n').map((line) => parseInt(line.trim(), 10)).filter((pid) => !isNaN(pid));
        for (const pid of panePids) {
          await killProcessTree(pid);
        }
      }
    } catch { /* session may already be dead */ }
    await command(tmux, ['kill-session', '-t', session], [0, 1]);
  }

  async isRoleRunning(session: string, role: AgentRole): Promise<boolean> {
    if (this.mock) return false;
    const tmux = process.env.WRITER_ROOM_TMUX_BIN || 'tmux';
    const slot = role === 'writer' ? 'agent-1' : 'agent-2';
    try {
      const result = await command(tmux, ['display-message', '-p', '-t', `${session}:${slot}`, '#{pane_dead}']);
      return result.stdout.trim() === '0';
    } catch { return false; }
  }
}
