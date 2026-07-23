import type { AgentProfile, AgentRole } from './domain.ts';

export interface ToolHealth {
  ok: boolean;
  tools: Record<string, string | null>;
  mock: boolean;
  transport: 'tmux' | 'native' | 'mock';
  agents?: Array<{ slot: AgentProfile['slot']; name: string; adapter: AgentProfile['adapter']; model: string; executable: string; found: boolean }>;
}

export interface TerminalController {
  health(profiles?: AgentProfile[]): Promise<ToolHealth>;
  ensureSession(session: string, cwd: string): Promise<void>;
  runJob(session: string, role: AgentRole, cwd: string, descriptorPath: string): Promise<void>;
  killSession(session: string): Promise<void>;
  isRoleRunning?(session: string, role: AgentRole): Promise<boolean>;
}

