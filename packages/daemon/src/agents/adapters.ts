/**
 * Agent Adapters — structured-first (ADR-4).
 * Each CLI has interactive + headless launch builders.
 */
import { join } from 'node:path';
import type {
  AgentAdapterKind, AgentDefinition, AgentLaunchSpec, McpServerInfo,
} from '@writer-room/shared';
import { agentWarnings } from './config.ts';

export interface LaunchContext {
  cwd: string;
  mcpConfigPath?: string;
  mcp?: McpServerInfo;
  mcpServers?: Record<string, McpServerInfo>;
  pathEnv?: string;
  allowedTools?: string[];
  orchestrated?: boolean;
}

export interface TurnContext extends LaunchContext {
  turnPrompt: string;
  resumeSessionRef?: string;
}

function quote(s: string): string {
  return /[\s"'$]/.test(s) ? `'${s.replace(/'/g, "'\\''")}'` : s;
}

function tomlString(s: string): string {
  return JSON.stringify(s);
}

function preview(executable: string, args: string[], cwd: string): string {
  return `cd ${quote(cwd)} && ${quote(executable)} ${args.map(quote).join(' ')}`;
}

/**
 * Match dna-spy baseSpec exactly: **only PATH** from the sidecar.
 * Do not inject HOME/TERM from the daemon — the PTY inherits the Tauri app env.
 * Rust sets TERM=xterm-256color when the client omits TERM.
 */
function baseSpec(agent: AgentDefinition, ctx: LaunchContext, args: string[], mode: AgentLaunchSpec['mode']): AgentLaunchSpec {
  const env: Record<string, string> = {};
  if (ctx.pathEnv) env['PATH'] = ctx.pathEnv;
  // Keep short names (`agy`, `grok`) like dna-spy — absolute path only if configured.
  const executable = agent.executable.trim() || 'unknown';
  return {
    agentId: agent.id,
    executable,
    args,
    cwd: ctx.cwd,
    env,
    preview: preview(executable, args, ctx.cwd),
    warnings: agentWarnings(agent),
    mode,
  };
}

export interface AgentAdapter {
  kind: AgentAdapterKind;
  defaultExecutable: string;
  versionArgs: string[];
  buildInteractive(agent: AgentDefinition, ctx: LaunchContext): AgentLaunchSpec;
  buildHeadlessTurn(agent: AgentDefinition, ctx: TurnContext): AgentLaunchSpec;
}

const claudeCode: AgentAdapter = {
  kind: 'claude-code',
  defaultExecutable: 'claude',
  versionArgs: ['--version'],
  buildInteractive(agent, ctx) {
    const args: string[] = [];
    if (agent.prompt.trim()) args.push('--append-system-prompt', agent.prompt);
    if (ctx.mcpConfigPath) args.push('--mcp-config', ctx.mcpConfigPath);
    args.push(...agent.args);
    if (ctx.orchestrated) {
      // Writer/Training inputs are staged local files. Chrome can neither read
      // `file://` under automation nor add value here; disabling it also keeps a
      // Claude turn from wasting its limited time trying a browser workaround.
      args.push('--no-chrome');
      const tools = ctx.allowedTools ?? [];
      const builtin = tools.filter((tool) => !tool.startsWith('mcp__'));
      if (builtin.length) args.push('--tools', builtin.join(','));
      if (tools.length) args.push('--allowedTools', tools.join(','));
      args.push('--disallowedTools', 'Bash,Task,Skill');
    }
    return baseSpec(agent, ctx, args, 'interactive');
  },
  buildHeadlessTurn(agent, ctx) {
    const args: string[] = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (ctx.resumeSessionRef) args.push('--resume', ctx.resumeSessionRef);
    if (agent.prompt.trim()) args.push('--append-system-prompt', agent.prompt);
    const tools = ctx.allowedTools ?? (ctx.mcpConfigPath ? ['mcp__team'] : []);
    if (ctx.mcpConfigPath) args.push('--mcp-config', ctx.mcpConfigPath);
    args.push(...agent.args);
    if (ctx.orchestrated) {
      args.push('--setting-sources', 'user', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--no-chrome');
    }
    if (tools.length) args.push('--allowedTools', tools.join(','));
    if (ctx.orchestrated) {
      const builtinTools = tools.filter((tool) => !tool.startsWith('mcp__'));
      if (builtinTools.length) args.push('--tools', builtinTools.join(','));
      args.push('--disallowedTools', 'Bash,Task,Skill');
    }
    args.push('--', ctx.turnPrompt);
    return baseSpec(agent, ctx, args, 'headless-turn');
  },
};

const codex: AgentAdapter = {
  kind: 'codex',
  defaultExecutable: 'codex',
  versionArgs: ['--version'],
  buildInteractive(agent, ctx) {
    const args: string[] = [];
    const servers = ctx.mcpServers ?? (ctx.mcp ? { team: ctx.mcp } : {});
    for (const [name, info] of Object.entries(servers)) {
      const envName = name === 'team'
        ? 'WRITER_ROOM_MCP_TOKEN'
        : `WRITER_ROOM_MCP_TOKEN_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
      args.push(
        '-c', `mcp_servers.${name}.url=${tomlString(info.url)}`,
        '-c', `mcp_servers.${name}.bearer_token_env_var=${tomlString(envName)}`,
      );
    }
    args.push(...agent.args);
    const spec = baseSpec(agent, ctx, args, 'interactive');
    for (const [name, info] of Object.entries(servers)) {
      const envName = name === 'team'
        ? 'WRITER_ROOM_MCP_TOKEN'
        : `WRITER_ROOM_MCP_TOKEN_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
      spec.env[envName] = info.token;
    }
    return spec;
  },
  buildHeadlessTurn(agent, ctx) {
    // `codex exec resume <SESSION_ID> [OPTIONS] [PROMPT]` — verified 2026-08-09 against
    // codex-cli 0.147.0 (`codex exec resume --help`): SESSION_ID/PROMPT are positional,
    // all `exec` options (--model, -c, --dangerously-bypass-approvals-and-sandbox) are
    // also valid under `resume`. A real resumed turn was confirmed to retain prior-turn
    // memory (see docs/plans/agent-harness-architecture.md §5.8) and cost far fewer
    // tokens than a fresh turn — this is the load-bearing fix for SDD §12a's deferred
    // "session continuity for DRAFT" item.
    const args = ctx.resumeSessionRef
      ? ['exec', 'resume', ctx.resumeSessionRef, ...agent.args, ctx.turnPrompt]
      : ['exec', ...agent.args, ctx.turnPrompt];
    const spec = baseSpec(agent, ctx, args, 'headless-turn');
    spec.warnings.push('Codex headless: MCP team tools not auto-wired — prompt embeds assignment/messages');
    return spec;
  },
};

/**
 * Antigravity CLI — match dna-spy board-agy launch profile.
 * Working Board agents use model + accept-edits + skip-permissions; bare `agy`
 * with empty args often sits on a blank / unusable first-run TUI.
 */
export const AGY_DEFAULT_ARGS = [
  '--model',
  'Gemini 3.5 Flash (High)',
  '--mode',
  'accept-edits',
  '--dangerously-skip-permissions',
] as const;

const agy: AgentAdapter = {
  kind: 'agy',
  defaultExecutable: 'agy',
  versionArgs: ['--version'],
  buildInteractive(agent, ctx) {
    // Interactive TUI: no --print (same as dna-spy). MCP via cwd .agents/mcp_config.json.
    const args = agent.args.length > 0 ? [...agent.args] : [...AGY_DEFAULT_ARGS];
    const spec = baseSpec(agent, ctx, args, 'interactive');
    if (ctx.mcp) {
      spec.warnings.push('Agy: MCP team merged into <cwd>/.agents/mcp_config.json (dna-spy format).');
    }
    if (agent.args.length === 0) {
      spec.warnings.push('Agy: using dna-spy default args (--model Gemini 3.5 Flash, accept-edits, skip-permissions).');
    }
    return spec;
  },
  buildHeadlessTurn(agent, ctx) {
    const prompt = agent.prompt.trim()
      ? `${agent.prompt.trim()}\n\n---\n\n${ctx.turnPrompt}`
      : ctx.turnPrompt;
    const baseArgs = agent.args.length > 0 ? [...agent.args] : [...AGY_DEFAULT_ARGS];
    // `--output-format stream-json` + `--conversation <id>` (real session resume,
    // added 2026-08-10, verified by hand against the installed `agy` binary):
    // plain-mode output has no machine-parseable session marker, but non-streaming
    // `--output-format json` buffers EVERYTHING and prints exactly one blob at
    // process exit — a real Training Lab run showed this as a totally blank PTY pane
    // for the turn's whole duration (user: "grok agent mở ra nhưng lại không có UI
    // gì cả", same root cause for agy). `stream-json` instead emits one JSON line per
    // event as the agent works (`init`/`step_update`/`result`), giving live visible
    // progress AND still includes `"conversation_id":"<uuid>"` on every line —
    // confirmed the SAME id is echoed back on every turn and `--conversation <id>`
    // genuinely resumes (verified: a follow-up turn correctly recalled a fact from
    // turn 1, `cache_read_tokens` nonzero on the resumed turn). Captured client-side
    // by `turnBridge`'s `SESSION_ID_PATTERNS` (`conversation_id` pattern).
    const resumeArgs = ctx.resumeSessionRef ? ['--conversation', ctx.resumeSessionRef] : [];
    // Flags first; --print consumes the next argument as the prompt (dna-spy).
    const spec = baseSpec(agent, ctx, [...baseArgs, '--output-format', 'stream-json', ...resumeArgs, '--print', prompt], 'headless-turn');
    if (ctx.mcp) {
      spec.warnings.push('Agy headless: prompt embedded; MCP optional for assignment');
    }
    return spec;
  },
};

const gemini: AgentAdapter = {
  kind: 'gemini',
  defaultExecutable: 'gemini',
  versionArgs: ['--version'],
  buildInteractive(agent, ctx) {
    const spec = baseSpec(agent, ctx, [...agent.args], 'interactive');
    if (ctx.mcp) {
      spec.warnings.push('Gemini: MCP team written to .gemini/settings.json in cwd');
    }
    if (agent.prompt.trim()) {
      spec.env['GEMINI_SYSTEM_MD'] = join(ctx.cwd, '.gemini', 'system.md');
    }
    return spec;
  },
  buildHeadlessTurn(agent, ctx) {
    const args: string[] = [];
    if (ctx.mcp) args.push('--allowed-mcp-server-names', 'team');
    args.push('--yolo', ...agent.args, '-p', ctx.turnPrompt);
    const spec = baseSpec(agent, ctx, args, 'headless-turn');
    if (agent.prompt.trim()) {
      spec.env['GEMINI_SYSTEM_MD'] = join(ctx.cwd, '.gemini', 'system.md');
    }
    return spec;
  },
};

/**
 * Grok Build CLI adapter.
 * Grok does NOT accept `--mcp-config` (that flag is Claude Code).
 * Team MCP is written to project `.grok/config.toml` by AgentManager.writeGrokMcpConfig.
 */
const grok: AgentAdapter = {
  kind: 'grok',
  defaultExecutable: 'grok',
  versionArgs: ['--version'],
  buildInteractive(agent, ctx) {
    // Strip Claude-only flags if they were saved into agent.args earlier.
    // Do NOT force --fullscreen: some grok builds treat it poorly in embedded PTYs.
    const cleaned: string[] = [];
    for (let i = 0; i < agent.args.length; i++) {
      const a = agent.args[i]!;
      if (a === '--mcp-config') {
        i += 1;
        continue;
      }
      cleaned.push(a);
    }
    const spec = baseSpec(agent, ctx, cleaned, 'interactive');
    if (ctx.mcp) {
      spec.warnings.push('Grok: MCP team written to <cwd>/.grok/config.toml (no --mcp-config flag).');
    }
    return spec;
  },
  buildHeadlessTurn(agent, ctx) {
    const prompt = agent.prompt.trim()
      ? `${agent.prompt.trim()}\n\n---\n\n${ctx.turnPrompt}`
      : ctx.turnPrompt;
    const cleaned = agent.args.filter((a, i, arr) => {
      if (a === '--mcp-config') return false;
      if (i > 0 && arr[i - 1] === '--mcp-config') return false;
      return true;
    });
    // Headless MUST use `-p/--single` (real bug found 2026-08-10, verified against
    // grok-cli 1.0.0 by hand): a bare positional PROMPT is documented as "Initial
    // prompt for the INTERACTIVE session" — it launches the TUI seeded with that
    // prompt, not a one-shot run. A real pipeline turn confirmed this: Grok wrote a
    // valid out/result.json, then sat idle at 0% CPU forever instead of exiting,
    // because it was still an open interactive session waiting for more input.
    // `--single`/`-p` is the documented one-shot flag: "Prints the response to
    // stdout and exits". `--permission-mode bypassPermissions` mirrors codex's
    // `--dangerously-bypass-approvals-and-sandbox` — pipeline turns run unattended,
    // no human present to approve tool calls.
    //
    // `--output-format streaming-json` + `-r/--resume <id>` (real session resume,
    // added 2026-08-10, verified by hand against grok-cli 1.0.0): the default `plain`
    // format prints only the model's final text, no machine-parseable session
    // marker. Non-streaming `--output-format json` DOES include a session marker but
    // buffers the ENTIRE response and prints exactly one JSON blob at process exit —
    // a real Training Lab run showed this as a totally blank PTY pane for the turn's
    // whole duration (user: "grok agent mở ra nhưng lại không có UI gì cả").
    // `streaming-json` instead emits one JSON line per event as the agent works
    // (`thought`/`text`/`usage`/`end`), giving live visible progress AND still ends
    // with `{"type":"end", "sessionId":"<uuid>", ...}` — confirmed the SAME id is
    // echoed back every turn, tool calls (file reads/writes) still work under this
    // format, and `--resume <id>` genuinely resumes (verified: a follow-up turn
    // recalled a fact from turn 1; input_tokens dropped from 24445 to 1140 with
    // cache_read_input_tokens 29696 on the resumed turn). Captured client-side by
    // `turnBridge`'s `SESSION_ID_PATTERNS`.
    const resumeArgs = ctx.resumeSessionRef ? ['--resume', ctx.resumeSessionRef] : [];
    const args = [
      ...cleaned, '--permission-mode', 'bypassPermissions', '--output-format', 'streaming-json',
      ...resumeArgs, '--single', prompt,
    ];
    const spec = baseSpec(agent, ctx, args, 'headless-turn');
    spec.warnings.push('Grok headless: assignment/messages embedded in prompt; MCP from .grok/config.toml if present');
    return spec;
  },
};

const ADAPTERS: Record<AgentAdapterKind, AgentAdapter> = {
  'claude-code': claudeCode,
  codex,
  agy,
  gemini,
  grok,
};

export function getAdapter(kind: AgentAdapterKind): AgentAdapter {
  const a = ADAPTERS[kind];
  if (!a) throw new Error(`adapter không hỗ trợ: ${kind}`);
  return a;
}
