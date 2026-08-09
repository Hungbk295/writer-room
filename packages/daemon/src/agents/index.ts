/**
 * AgentManager — config store + adapters + worktree + MCP wiring.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import type {
  AgentAdapterKind, AgentDefinition, AgentLaunchSpec, CliAvailability, McpServerInfo, TeamMessage, TurnReason,
} from '@writer-room/shared';
import { AUGMENTED_ENV, exec } from '../exec.ts';
import { getAdapter, type LaunchContext } from './adapters.ts';
import { AgentConfigStore } from './config.ts';
import { ensureWorktree, removeWorktree, worktreePath } from './worktree.ts';

export const TEAM_CHANNEL = 'general';

export interface AgentLaunchReadiness {
  agentId: string;
  ready: boolean;
  errors: string[];
  warnings: string[];
}

interface CliProbeResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

function probeCli(executable: string, args: string[], cwd: string, timeoutMs = 10_000): Promise<CliProbeResult> {
  return new Promise((resolveProbe) => {
    const child = spawn(executable, args, {
      cwd,
      env: AUGMENTED_ENV,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* */ }
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolveProbe({ code: null, stdout, stderr, error: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveProbe({
        code,
        stdout,
        stderr,
        ...(timedOut ? { error: `timeout after ${timeoutMs / 1000}s` } : {}),
      });
    });
  });
}

export function parseClaudeAuthLoggedIn(output: string): boolean {
  try {
    const status = JSON.parse(output) as { loggedIn?: unknown };
    return status.loggedIn === true;
  } catch {
    return false;
  }
}

function gitTrustRoot(start: string): string {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

export function claudeProjectTrusted(configText: string, projectRoot: string): boolean {
  try {
    const config = JSON.parse(configText) as { projects?: Record<string, { hasTrustDialogAccepted?: unknown }> };
    return config.projects?.[resolve(projectRoot)]?.hasTrustDialogAccepted === true;
  } catch {
    return false;
  }
}

export class AgentManager {
  constructor(
    private cfg: AgentConfigStore,
    private dataDir: string,
    private teamMcpInfo: () => McpServerInfo | null,
    private appMcpProvision: (agentId: string) => McpServerInfo | null = () => null,
    /** Allowed roots for overrideCwd (workspace dirs under app data). */
    private workspaceRoots: () => string[] = () => [join(this.dataDir, 'workspaces')],
  ) {}

  list(): AgentDefinition[] {
    return this.cfg.list();
  }

  get(id: string): AgentDefinition {
    const a = this.cfg.get(id);
    if (!a) throw new Error(`agent không tồn tại: ${id}`);
    return a;
  }

  save(agent: AgentDefinition): AgentDefinition {
    return this.cfg.save(agent);
  }

  delete(id: string): boolean {
    const agent = this.cfg.get(id);
    if (agent) {
      try { rmSync(this.mcpConfigPath(id), { force: true }); } catch { /* */ }
      if (agent.workingDirectoryMode === 'isolated-worktree') {
        void removeWorktree(agent.projectRoot, this.dataDir, agent.id).catch(() => {});
      } else if (agent.projectRoot) {
        try { rmSync(join(agent.projectRoot, 'AGENTS.override.md'), { force: true }); } catch { /* */ }
        try { rmSync(join(agent.projectRoot, '.gemini', 'system.md'), { force: true }); } catch { /* */ }
      }
    }
    return this.cfg.delete(id);
  }

  async detect(adapter: AgentAdapterKind, executable?: string): Promise<CliAvailability> {
    const ad = getAdapter(adapter);
    const exe = executable?.trim() || ad.defaultExecutable;
    try {
      const { stdout } = await exec(exe, ad.versionArgs, undefined, 10_000);
      return { adapter, executable: exe, found: true, version: stdout.trim().split('\n')[0] };
    } catch (err) {
      return { adapter, executable: exe, found: false, error: (err as Error).message };
    }
  }

  async launchReadiness(agentId: string, cwd?: string): Promise<AgentLaunchReadiness> {
    const agent = this.get(agentId);
    const errors: string[] = [];
    const warnings: string[] = [];
    const executable = agent.executable.trim() || getAdapter(agent.adapter).defaultExecutable;
    const targetCwd = cwd || agent.projectRoot;

    if (agent.adapter === 'claude-code') {
      const auth = await probeCli(executable, ['auth', 'status'], targetCwd);
      const envCredential = Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN);
      if (!envCredential && !parseClaudeAuthLoggedIn(auth.stdout)) {
        errors.push('CLAUDE_AUTH_REQUIRED: Claude Code chưa đăng nhập. Chạy `claude auth login` rồi Retry.');
      }
      if (auth.error) warnings.push(`Không đọc trọn trạng thái Claude auth: ${auth.error}`);

      const trustRoot = gitTrustRoot(targetCwd);
      let trusted = false;
      try {
        trusted = claudeProjectTrusted(readFileSync(join(homedir(), '.claude.json'), 'utf8'), trustRoot);
      } catch { /* untrusted */ }
      if (!trusted) {
        errors.push(`CLAUDE_TRUST_REQUIRED: workspace Git root chưa được trust (${trustRoot}). Chấp nhận Trust trong terminal Claude rồi Retry.`);
      }
    } else if (agent.adapter === 'codex') {
      const auth = await probeCli(executable, ['login', 'status'], targetCwd);
      if (auth.code !== 0 || !/logged in/i.test(`${auth.stdout}\n${auth.stderr}`)) {
        errors.push('CODEX_AUTH_REQUIRED: Codex CLI chưa đăng nhập. Chạy `codex login` rồi Retry.');
      }
      if (auth.error) warnings.push(`Không đọc trọn trạng thái Codex auth: ${auth.error}`);
    }

    return { agentId, ready: errors.length === 0, errors, warnings };
  }

  private mcpConfigPath(agentId: string): string {
    return join(this.dataDir, 'agents', `mcp-${agentId}.json`);
  }

  private mcpConnections(agentId: string, includeApp: boolean): Record<string, McpServerInfo> {
    const team = this.teamMcpInfo();
    const app = includeApp ? this.appMcpProvision(agentId) : null;
    return {
      ...(team ? { team } : {}),
      ...(app ? { writer_room: app } : {}),
    };
  }

  private writeMcpConfig(agentId: string, servers: Record<string, McpServerInfo>): string | undefined {
    if (!Object.keys(servers).length) return undefined;
    const path = this.mcpConfigPath(agentId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify(
        {
          mcpServers: Object.fromEntries(Object.entries(servers).map(([name, info]) => [name, {
            type: 'http',
            url: info.url,
            headers: { Authorization: `Bearer ${info.token}` },
          }])),
        },
        null,
        2,
      ),
    );
    return path;
  }

  private writeAgyMcpConfig(cwd: string, connections: Record<string, McpServerInfo>): void {
    if (!Object.keys(connections).length) return;
    const path = join(cwd, '.agents', 'mcp_config.json');
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } catch { /* */ }
    const servers = (existing['mcpServers'] && typeof existing['mcpServers'] === 'object')
      ? { ...(existing['mcpServers'] as Record<string, unknown>) }
      : {};
    for (const [name, info] of Object.entries(connections)) {
      servers[name] = { serverUrl: info.url, headers: { Authorization: `Bearer ${info.token}` } };
    }
    const next = { ...existing, mcpServers: servers };
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.wr-${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(next, null, 2));
    renameSync(temp, path);
  }

  private writeGeminiSettings(cwd: string, connections: Record<string, McpServerInfo>): void {
    if (!Object.keys(connections).length) return;
    const dir = join(cwd, '.gemini');
    const path = join(dir, 'settings.json');
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } catch { /* */ }
    const servers = (existing['mcpServers'] ?? {}) as Record<string, unknown>;
    for (const [name, info] of Object.entries(connections)) {
      servers[name] = { httpUrl: info.url, headers: { Authorization: `Bearer ${info.token}` }, trust: name === 'team' };
    }
    existing['mcpServers'] = servers;
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(existing, null, 2));
  }

  /**
   * Grok reads project MCP from `<cwd>/.grok/config.toml` (not --mcp-config).
   * Format matches `grok mcp add -t http -s project`:
   *   [mcp_servers.team]
   *   url = "..."
   *   enabled = true
   *   [mcp_servers.team.headers]
   *   Authorization = "Bearer ..."
   *
   * We rewrite only our managed server blocks; other TOML content is preserved
   * best-effort by rewriting the full file when it was only MCP, else appending.
   */
  private writeGrokMcpConfig(cwd: string, connections: Record<string, McpServerInfo>): void {
    if (!Object.keys(connections).length) return;
    const dir = join(cwd, '.grok');
    const path = join(dir, 'config.toml');
    mkdirSync(dir, { recursive: true });

    let existing = '';
    try {
      existing = readFileSync(path, 'utf8');
    } catch { /* new file */ }

    // Strip previous managed blocks for these server names (simple line filter).
    const managedNames = new Set(Object.keys(connections));
    const kept: string[] = [];
    let skip = false;
    let skipName = '';
    for (const line of existing.split('\n')) {
      const table = line.match(/^\[mcp_servers\.([^\].]+)(\.[^\]]+)?\]\s*$/);
      if (table) {
        const name = table[1]!;
        if (managedNames.has(name)) {
          skip = true;
          skipName = name;
          continue;
        }
        skip = false;
        skipName = '';
        kept.push(line);
        continue;
      }
      if (skip) {
        // Stay in skip until next top-level table that is not nested under skipName
        if (line.match(/^\[[^\]]+\]\s*$/) && !line.startsWith(`[mcp_servers.${skipName}`)) {
          skip = false;
          skipName = '';
          // fall through to keep this line
        } else {
          continue;
        }
      }
      kept.push(line);
    }

    const blocks: string[] = [];
    for (const [name, info] of Object.entries(connections)) {
      blocks.push(
        `[mcp_servers.${name}]`,
        `url = ${JSON.stringify(info.url)}`,
        'enabled = true',
        '',
        `[mcp_servers.${name}.headers]`,
        `Authorization = ${JSON.stringify(`Bearer ${info.token}`)}`,
        '',
      );
    }

    const body = `${kept.join('\n').replace(/\n+$/, '')}\n\n${blocks.join('\n')}`.trim() + '\n';
    const temp = `${path}.wr-${process.pid}.tmp`;
    writeFileSync(temp, body);
    renameSync(temp, path);
  }

  private resolveCwd(agent: AgentDefinition): string {
    return agent.workingDirectoryMode === 'isolated-worktree'
      ? worktreePath(this.dataDir, agent.id)
      : agent.projectRoot;
  }

  private ctx(agent: AgentDefinition, mcpConfigPath?: string, mcpServers: Record<string, McpServerInfo> = {}): LaunchContext {
    return {
      cwd: this.resolveCwd(agent),
      mcpConfigPath,
      mcp: mcpServers['team'],
      mcpServers,
      pathEnv: AUGMENTED_ENV.PATH,
    };
  }

  private isAllowedWorkspace(cwd: string): boolean {
    const canonical = (value: string): string => {
      try { return realpathSync(value); } catch { return resolve(value); }
    };
    const target = canonical(cwd);
    for (const root of this.workspaceRoots()) {
      const base = canonical(root);
      const rel = relative(base, target);
      if (rel && !rel.startsWith('..') && !rel.includes(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
        return true;
      }
      if (target === base) return true;
    }
    // Also allow agent's own projectRoot
    return false;
  }

  launchPreview(agentId: string): AgentLaunchSpec {
    const agent = this.get(agentId);
    const connections = this.mcpConnections(agent.id, false);
    const spec = getAdapter(agent.adapter).buildInteractive(agent, {
      ...this.ctx(agent, Object.keys(connections).length ? this.mcpConfigPath(agentId) : undefined, connections),
    });
    if (agent.workingDirectoryMode === 'isolated-worktree') {
      spec.warnings.push(`worktree sẽ được tạo tại ${spec.cwd} (branch writer-room/${agentId})`);
    }
    return spec;
  }

  async prepareLaunch(agentId: string, overrideCwd?: string): Promise<AgentLaunchSpec> {
    const agent = this.get(agentId);
    if (!agent.enabled) throw new Error(`agent ${agentId} đang disabled`);
    if (agent.workingDirectoryMode === 'isolated-worktree') {
      await ensureWorktree(agent.projectRoot, this.dataDir, agent.id);
    }
    const connections = this.mcpConnections(agent.id, true);
    const mcpPath = this.writeMcpConfig(agentId, connections);
    const ctx = this.ctx(agent, mcpPath, connections);
    if (overrideCwd?.trim()) {
      const target = resolve(overrideCwd);
      const allowed = this.isAllowedWorkspace(target)
        || realpathSafe(target) === realpathSafe(agent.projectRoot);
      if (!allowed) {
        throw new Error(`interactive launch cwd phải nằm dưới workspaces/ hoặc projectRoot của agent`);
      }
      ctx.cwd = target;
      ctx.orchestrated = true;
      ctx.allowedTools = ['Read', 'Edit', 'Write', 'mcp__team'];
    }
    if (agent.adapter === 'gemini') this.writeGeminiSettings(ctx.cwd, connections);
    if (agent.adapter === 'agy') this.writeAgyMcpConfig(ctx.cwd, connections);
    if (agent.adapter === 'grok') this.writeGrokMcpConfig(ctx.cwd, connections);
    this.prepareAgentPrompt(agent, ctx.cwd);
    return getAdapter(agent.adapter).buildInteractive(agent, ctx);
  }

  async buildInteractiveTurnSpec(agentId: string, overrideCwd?: string): Promise<AgentLaunchSpec> {
    return this.prepareLaunch(agentId, overrideCwd);
  }

  async buildHeadlessTurnSpec(
    agentId: string,
    opts: {
      reason: TurnReason;
      messageCursor: number;
      resumeSessionRef?: string;
      taskNote?: string;
      recentMessages?: TeamMessage[];
      job?: {
        overrideCwd?: string;
        skipWorktree?: boolean;
        allowedTools?: string[];
        orchestrated?: boolean;
        freshContext?: boolean;
        exclusive?: boolean;
        timeoutMs?: number;
      };
    },
  ): Promise<AgentLaunchSpec> {
    const agent = this.get(agentId);
    if (!agent.enabled) throw new Error(`agent ${agentId} đang disabled`);
    const useWorktree = agent.workingDirectoryMode === 'isolated-worktree' && !opts.job?.skipWorktree;
    if (useWorktree) {
      await ensureWorktree(agent.projectRoot, this.dataDir, agent.id);
    }
    const connections = this.mcpConnections(agent.id, true);
    const mcpPath = this.writeMcpConfig(agentId, connections);
    const turnPrompt = buildTurnPrompt(
      agent,
      opts.reason,
      opts.messageCursor,
      opts.taskNote,
      opts.recentMessages,
      opts.job?.orchestrated === true,
    );
    const ctx = this.ctx(agent, mcpPath, connections);
    if (opts.job?.overrideCwd) ctx.cwd = opts.job.overrideCwd;
    else if (!useWorktree) ctx.cwd = agent.projectRoot;
    if (agent.adapter === 'gemini') this.writeGeminiSettings(ctx.cwd, connections);
    if (agent.adapter === 'agy') this.writeAgyMcpConfig(ctx.cwd, connections);
    if (agent.adapter === 'grok') this.writeGrokMcpConfig(ctx.cwd, connections);
    this.prepareAgentPrompt(agent, ctx.cwd);
    return getAdapter(agent.adapter).buildHeadlessTurn(agent, {
      ...ctx,
      turnPrompt,
      resumeSessionRef: opts.resumeSessionRef,
      allowedTools: opts.job?.allowedTools,
      orchestrated: opts.job?.orchestrated === true,
    });
  }

  private prepareAgentPrompt(agent: AgentDefinition, cwd: string): void {
    if (!agent.prompt.trim()) return;
    if (agent.adapter === 'gemini') {
      const dir = join(cwd, '.gemini');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'system.md'), agent.prompt);
    } else if (agent.adapter === 'codex' || agent.adapter === 'agy' || agent.adapter === 'grok') {
      writeFileSync(join(cwd, 'AGENTS.override.md'), agent.prompt);
    }
  }
}

function realpathSafe(value: string): string {
  try { return realpathSync(value); } catch { return resolve(value); }
}

export function buildInjectLine(
  agent: AgentDefinition,
  reason: TurnReason,
  messageCursor: number,
  hasAssignment: boolean,
  orchestrated = false,
  interactiveTurnId?: number,
): string {
  const completion = interactiveTurnId === undefined
    ? `gọi team_update_status (agentId "${agent.id}", status "idle").`
    : `sau khi ghi artifact, gọi team_turn_complete (agentId "${agent.id}", turnId ${interactiveTurnId}, status "done"); nếu không thể hoàn tất thì status "failed". Không gọi team_update_status để thay thế.`;
  if (hasAssignment) {
    if (orchestrated) {
      return `[writer-room orchestrator · ${reason}] Gọi team_get_assignment (agentId "${agent.id}") và CHỈ làm nhiệm vụ đó. Không đọc chat cũ, không team_send_message, không mention agent khác. Khi xong, ${completion}`;
    }
    return `[writer-room team · ${reason}] Gọi MCP tool team_get_assignment (agentId "${agent.id}") và LÀM THEO nhiệm vụ đó. Xong: team_send_message (channel "${TEAM_CHANNEL}", senderAgentId "${agent.id}") tóm tắt, rồi team_ack_messages, rồi ${completion}`;
  }
  return `[writer-room team · ${reason}] Gọi MCP tool team_read_messages (channel "${TEAM_CHANNEL}", afterCursor ${messageCursor}), xử lý @${agent.id}, trả lời bằng team_send_message, rồi team_ack_messages, rồi ${completion}`;
}

export function buildTurnPrompt(
  agent: AgentDefinition,
  reason: TurnReason,
  messageCursor: number,
  taskNote?: string,
  recentMessages?: TeamMessage[],
  orchestrated = false,
): string {
  const lines = [
    `Bạn là agent "${agent.name}" (id: ${agent.id}) trong team Writer Room. Role: ${agent.role || 'general'}.`,
    `Lượt này được kích hoạt bởi: ${reason}.`,
    '',
  ];
  if (taskNote?.trim()) {
    lines.push('NHIỆM VỤ ĐƯỢC GIAO (assignment — ưu tiên làm việc này):', taskNote.trim(), '');
  }
  if (orchestrated) {
    lines.push(
      'CHẾ ĐỘ ORCHESTRATED — BẮT BUỘC:',
      '- Chỉ thực hiện NHIỆM VỤ ĐƯỢC GIAO ở trên và ghi đúng artifact được yêu cầu.',
      '- Không đọc/diễn giải assignment cũ, không xử lý team chat cũ.',
      '- Không gọi team_send_message, không mention hay phân việc cho agent khác.',
      '- Không tự chuyển phase. Orchestrator sẽ kiểm artifact rồi giao đúng agent tiếp theo.',
      '- Không gọi Bash, Task, Skill hoặc lệnh shell; chỉ dùng Read/Edit/Write trong workspace được giao.',
      '- Khi artifact đã ghi xong, kết thúc turn.',
    );
    return lines.join('\n');
  }
  if (recentMessages?.length) {
    lines.push(`TIN NHẮN CHƯA ĐỌC (channel "${TEAM_CHANNEL}", sau cursor ${messageCursor}):`);
    for (const m of recentMessages.slice(-30)) {
      const men = m.mentions.length ? ` [mentions: ${m.mentions.map((x) => `@${x}`).join(', ')}]` : '';
      lines.push(`- [${m.cursor}] @${m.senderAgentId}${men}: ${m.body}`);
    }
    lines.push('');
  }
  lines.push(
    'Quy trình bắt buộc:',
    `1. Gọi MCP tool team_read_messages với channel "${TEAM_CHANNEL}" và afterCursor ${messageCursor}.`,
    `2. Xử lý các yêu cầu nhắc tới bạn (@${agent.id})${taskNote?.trim() ? ' và NHIỆM VỤ ĐƯỢC GIAO' : ''}.`,
    `3. Trả lời bằng team_send_message (channel "${TEAM_CHANNEL}", senderAgentId "${agent.id}").`,
    `4. team_ack_messages + team_update_status (status "idle").`,
  );
  if (taskNote?.trim()) {
    lines.push('Nếu không truy cập được MCP: BỎ QUA team_* và vẫn hoàn thành NHIỆM VỤ ĐƯỢC GIAO.');
  }
  return lines.join('\n');
}
