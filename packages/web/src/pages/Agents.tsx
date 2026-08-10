/**
 * Agents page — dna-spy parity for config CRUD + Launch into Tauri PTY drawer.
 */
import { useCallback, useEffect, useState } from 'preact/hooks';
import {
  api,
  type AgentDefinition,
  type AgentLaunchSpec,
  type TeamStatus,
} from '../api.ts';
import { isTauri } from '../components/terminal/terminalApi.ts';
import { terminals } from '../components/terminal/terminalStore.ts';
import { TerminalToggleButton } from '../components/terminal/TerminalDrawer.tsx';
import { CustomSelect, Field, Input, Textarea } from '../components/ui/Forms.tsx';

const ADAPTER_DEFAULTS: Record<string, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  agy: 'agy',
  gemini: 'gemini',
  grok: 'grok',
};

const EMPTY_AGENT = (projectRoot: string): AgentDefinition => ({
  id: '',
  name: '',
  color: '#7c5cff',
  role: '',
  prompt: '',
  adapter: 'claude-code',
  executable: 'claude',
  args: [],
  projectRoot,
  workingDirectoryMode: 'project',
  enabled: true,
});

export function parseAgentArgs(value: string): string[] {
  const args: string[] = [];
  const rx = /"((?:\\.|[^"\\])*)"|'([^']*)'|([^\s]+)/g;
  for (const match of value.matchAll(rx)) {
    const doubleQuoted = match[1]?.replace(/\\(["\\])/g, '$1');
    args.push(doubleQuoted ?? match[2] ?? match[3] ?? '');
  }
  return args.filter(Boolean);
}

export function formatAgentArgs(args: string[]): string {
  return args.map((arg) => (/\s|["']/.test(arg) ? JSON.stringify(arg) : arg)).join(' ');
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'agent';
}

export function AgentsPage() {
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [status, setStatus] = useState<TeamStatus | null>(null);
  const [mcpUrl, setMcpUrl] = useState('');
  const [projectRootDefault, setProjectRootDefault] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [editing, setEditing] = useState<AgentDefinition | null>(null);
  const [preview, setPreview] = useState<{ agentId: string; spec: AgentLaunchSpec } | null>(null);
  const [detect, setDetect] = useState<Record<string, { found: boolean; version?: string; error?: string }>>({});
  const inTauri = isTauri();

  const refresh = useCallback(async () => {
    try {
      const [list, st, mcp, settings] = await Promise.all([
        api.listAgents(),
        api.teamStatus().catch(() => null),
        api.teamMcp().catch(() => null),
        api.getSettings().catch(() => null),
      ]);
      setAgents(list.agents);
      setStatus(st);
      setMcpUrl(mcp?.url ?? '');
      if (settings?.dataRoot) {
        const root = settings.dataRoot.replace(/\/writer-room-data\/?$/, '') || settings.dataRoot;
        setProjectRootDefault(root);
      }
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 8000);
    return () => clearInterval(t);
  }, [refresh]);

  const openNew = () => {
    setEditing(EMPTY_AGENT(projectRootDefault));
  };

  const openEdit = (a: AgentDefinition) => {
    setEditing({
      ...a,
      args: [...(a.args ?? [])],
      prompt: a.prompt ?? '',
      role: a.role ?? '',
      projectRoot: a.projectRoot || projectRootDefault,
    });
  };

  const saveAgent = async () => {
    if (!editing) return;
    const name = editing.name.trim();
    if (!name) {
      setError('Tên agent bắt buộc');
      return;
    }
    const agent: AgentDefinition = {
      ...editing,
      name,
      id: (editing.id || slugify(name)).trim(),
      projectRoot: (editing.projectRoot || projectRootDefault).trim(),
      executable: (editing.executable || ADAPTER_DEFAULTS[editing.adapter] || 'claude').trim(),
      args: Array.isArray(editing.args) ? editing.args : [],
      prompt: editing.prompt ?? '',
      role: editing.role ?? '',
      color: editing.color || '#7c5cff',
      workingDirectoryMode: editing.workingDirectoryMode || 'project',
      enabled: editing.enabled !== false,
    };
    if (!agent.projectRoot) {
      setError('projectRoot phải là đường dẫn tuyệt đối (repo agent làm việc)');
      return;
    }
    setBusy('save');
    try {
      const res = await api.saveAgent(agent);
      setEditing(null);
      setNotice(`Đã lưu ${res.agent.name} (${res.agent.id})`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const handleDelete = async (a: AgentDefinition) => {
    if (!confirm(`Xóa agent "${a.name}" (${a.id})?`)) return;
    setBusy(`del-${a.id}`);
    try {
      await api.deleteAgent(a.id);
      setNotice(`Đã xóa ${a.name}`);
      if (editing?.id === a.id) setEditing(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const runDetect = async (a: AgentDefinition) => {
    setBusy(`detect-${a.id}`);
    try {
      const r = await api.detectAgent(a.adapter, a.executable);
      setDetect((d) => ({ ...d, [a.id]: r }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  /** Preview uses prepareLaunch so args/env match what Approve will run (MCP files written). */
  const openPreview = async (a: AgentDefinition) => {
    setBusy(`prev-${a.id}`);
    try {
      // prepareLaunch (not launchPreview) so Grok gets .grok/config.toml and
      // Agy gets .agents/mcp_config.json before the user approves.
      const spec = await api.prepareLaunch(a.id);
      setPreview({ agentId: a.id, spec });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const approveLaunch = async () => {
    if (!preview) return;
    setBusy('launch');
    try {
      // Re-prepare so MCP token/config is fresh (dna-spy: prepareLaunch then launchTab).
      const spec = await api.prepareLaunch(preview.agentId);
      if (spec.args.includes('--mcp-config')) {
        throw new Error(`Launch blocked: adapter still passes --mcp-config (${spec.args.join(' ')}). Restart daemon.`);
      }
      const agent = agents.find((x) => x.id === preview.agentId);
      // dna-spy passes spec.env as-is (PATH only). Terminal layer forces TERM.
      await terminals.launchTab({
        executable: spec.executable,
        args: spec.args,
        cwd: spec.cwd,
        env: spec.env ?? {},
        agentId: preview.agentId,
        title: agent?.name ?? preview.agentId,
        readOnly: false,
      });
      setPreview(null);
      setNotice(`Đã mở terminal · ${preview.agentId} · ${spec.executable} ${spec.args.join(' ')} · ${spec.cwd}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const seedDefaults = async () => {
    setBusy('seed');
    try {
      const res = await api.seedDefaultAgents();
      setNotice(`Defaults: ${res.seeded.join(', ')}`);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  return (
    <section class="page-agents">
      <header class="page-header">
        <div>
          <div class="eyebrow">Harness</div>
          <h1>Agent Team</h1>
          <p class="muted">
            Cấu hình agent (CRUD) + Launch CLI vào terminal drawer — giống dna-spy.
            {!inTauri && (
              <strong style={{ display: 'block', marginTop: '0.35rem', color: 'var(--amber)' }}>
                Đang mở browser — Launch terminal cần app Tauri: <code>bun run app:macos</code>
              </strong>
            )}
          </p>
        </div>
        <div class="row" style={{ gap: '0.6rem', alignItems: 'center' }}>
          <TerminalToggleButton />
          <button type="button" class="btn secondary" onClick={() => void seedDefaults()} disabled={busy === 'seed'}>
            Seed 4 defaults
          </button>
          <button type="button" class="btn teal" onClick={openNew}>＋ Agent mới</button>
          <button type="button" class="btn secondary" onClick={() => void refresh()}>Refresh</button>
        </div>
      </header>

      {error && (
        <div class="banner error">
          <span>{error}</span>
          <button type="button" class="banner-close" onClick={() => setError('')}>✕</button>
        </div>
      )}
      {notice && (
        <div class="banner ok">
          <span>{notice}</span>
          <button type="button" class="banner-close" onClick={() => setNotice('')}>✕</button>
        </div>
      )}

      <div class="team-mcp-card">
        <div class="team-mcp-info">
          <span class="eyebrow">Team MCP</span>
          <code>{mcpUrl || '…'}</code>
        </div>
        {status && (
          <div class="team-mcp-stats">
            <span class={`chip ${status.workflow.stopped ? 'warn' : 'ok'}`}>
              workflow: {status.workflow.stopped ? 'stopped' : 'active'}
            </span>
            <span class="chip">turns: {status.workflow.totalTurns}</span>
            <span class="chip">queue: {status.workflow.queued}</span>
            <span class="chip">running: {status.workflow.running}</span>
          </div>
        )}
      </div>

      {agents.length === 0 && (
        <div class="card" style={{ marginBottom: '1rem' }}>
          <p><strong>Chưa có agent.</strong> Bấm Seed 4 defaults hoặc ＋ Agent mới.</p>
        </div>
      )}

      <div class="agents-list-head">
        <h3 style={{ margin: 0 }}>Agents ({agents.length})</h3>
        <p class="muted small" style={{ margin: '0.25rem 0 0' }}>
          Pane interactive giữ mở = turn gõ thẳng vào terminal. Launch = prepareLaunch (MCP) + PTY.
        </p>
      </div>

      <div class="agent-grid" style={{ marginTop: '0.75rem' }}>
        {agents.map((agent) => {
          const dt = detect[agent.id];
          const st = status?.agents.find((s) => s.agentId === agent.id);
          return (
            <article
              key={agent.id}
              class="agent-card"
            >
              <div class="agent-card-header">
                <div class="agent-card-title-wrap">
                  <span class="agent-color-dot" style={{ background: agent.color }} />
                  <h3>{agent.name}</h3>
                </div>
                <div class="agent-card-badges">
                  <span class="chip">{agent.adapter}</span>
                  <span
                    class={`status-dot ${agent.enabled !== false ? 'live' : ''}`}
                    title={agent.enabled !== false ? 'Enabled' : 'Disabled'}
                  />
                </div>
              </div>

              <div class="agent-card-meta">
                <div class="meta-row">
                  <span class="meta-label">ID:</span> <code>{agent.id}</code>
                  {st && <span class="chip">{st.status}</span>}
                </div>
                <div class="meta-row">
                  <span class="meta-label">Role:</span>
                  <span class="chip">{agent.role || 'no role'}</span>
                  <span class="muted small">{agent.workingDirectoryMode}</span>
                </div>
                <div class="meta-row cmd-row">
                  <code>{agent.executable} {(agent.args ?? []).join(' ')}</code>
                </div>
                {dt && (
                  <div class="meta-row">
                    <span class={`chip ${dt.found ? 'ok' : 'bad'}`}>
                      {dt.found ? `✓ ${dt.version ?? 'CLI ready'}` : `✗ ${dt.error?.slice(0, 60)}`}
                    </span>
                  </div>
                )}
              </div>

              {agent.prompt && (
                <div class="agent-card-prompt" title={agent.prompt}>
                  "{agent.prompt.length > 90 ? agent.prompt.slice(0, 90) + '…' : agent.prompt}"
                </div>
              )}

              <div class="agent-card-actions">
                <button
                  type="button"
                  class="btn teal agent-launch-btn"
                  disabled={busy.startsWith('prev') || busy === 'launch'}
                  onClick={() => void openPreview(agent)}
                >
                  ▶ Launch
                </button>
                <div class="agent-sub-actions">
                  <button
                    type="button"
                    class="btn secondary icon-btn"
                    title="Detect CLI binary"
                    disabled={busy === `detect-${agent.id}`}
                    onClick={() => void runDetect(agent)}
                  >
                    🔍
                  </button>
                  <button
                    type="button"
                    class="btn secondary icon-btn"
                    title="Sửa cấu hình agent"
                    onClick={() => openEdit(agent)}
                  >
                    ✎ Edit
                  </button>
                  <button
                    type="button"
                    class="btn secondary icon-btn danger"
                    title="Xóa agent"
                    disabled={busy === `del-${agent.id}`}
                    onClick={() => void handleDelete(agent)}
                  >
                    🗑
                  </button>
                </div>
              </div>
            </article>
          );
        })}
      </div>

      {status && status.audit.length > 0 && (
        <div class="card" style={{ marginTop: '1.5rem' }}>
          <div class="eyebrow">Audit</div>
          <ul class="audit-list">
            {status.audit.slice(0, 10).map((ev) => (
              <li key={ev.id}>
                <code>{ev.kind}</code>{ev.agentId ? ` · ${ev.agentId}` : ''} — {ev.detail}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ===== Editor modal (dna-spy style) ===== */}
      {editing && (
        <div
          class="modal-backdrop"
          role="presentation"
          onClick={() => setEditing(null)}
          onKeyDown={(e) => { if (e.key === 'Escape') setEditing(null); }}
        >
          <div class="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div class="modal-header">
              <h3>{editing.id ? `Sửa Agent: ${editing.name || editing.id}` : 'Tạo Agent mới'}</h3>
              <button type="button" class="banner-close" onClick={() => setEditing(null)}>✕</button>
            </div>

            <div class="modal-section">
              <div class="modal-section-title">Thông tin chung</div>
              <div class="modal-row-2">
                <Field label="Tên Agent">
                  <Input
                    autoFocus
                    placeholder="vd: Claude Code"
                    value={editing.name}
                    onInput={(e) => setEditing({ ...editing, name: (e.target as HTMLInputElement).value })}
                  />
                </Field>
                <Field label="ID (kebab-case)">
                  <Input
                    value={editing.id}
                    placeholder={slugify(editing.name) || 'claude-agent'}
                    disabled={Boolean(editing.id) && agents.some((a) => a.id === editing.id)}
                    onInput={(e) => setEditing({ ...editing, id: (e.target as HTMLInputElement).value })}
                  />
                </Field>
              </div>

              <Field label="Role / Nhiệm vụ">
                <Input
                  value={editing.role}
                  placeholder="author / editor / analyst / polish"
                  onInput={(e) => setEditing({ ...editing, role: (e.target as HTMLInputElement).value })}
                />
              </Field>

              <Field label="System Prompt">
                <Textarea
                  rows={4}
                  placeholder="Mô tả chỉ dẫn phong cách và nguyên tắc cho agent..."
                  value={editing.prompt}
                  onInput={(e) => setEditing({ ...editing, prompt: (e.target as HTMLTextAreaElement).value })}
                />
              </Field>
            </div>

            <div class="modal-section">
              <div class="modal-section-title">Cấu hình CLI & Adapter</div>
              <div class="modal-row-3">
                <Field label="Adapter">
                  <CustomSelect
                    value={editing.adapter}
                    onChange={(adapter) => {
                      setEditing({
                        ...editing,
                        adapter,
                        executable: ADAPTER_DEFAULTS[adapter] ?? editing.executable,
                        args: [],
                      });
                    }}
                    options={[
                      { value: 'claude-code', label: 'Claude Code' },
                      { value: 'codex', label: 'Codex' },
                      { value: 'agy', label: 'Antigravity (agy)' },
                      { value: 'grok', label: 'Grok' },
                      { value: 'gemini', label: 'Gemini' },
                    ]}
                  />
                </Field>
                <Field label="Executable">
                  <Input
                    value={editing.executable}
                    onInput={(e) => setEditing({ ...editing, executable: (e.target as HTMLInputElement).value })}
                  />
                </Field>
                <Field label="Màu đại diện">
                  <div class="color-input-wrap">
                    <input
                      type="color"
                      value={editing.color}
                      onInput={(e) => setEditing({ ...editing, color: (e.target as HTMLInputElement).value })}
                    />
                    <span class="mono-small">{editing.color}</span>
                  </div>
                </Field>
              </div>

              <Field label="Args bổ sung">
                <Input
                  value={formatAgentArgs(editing.args ?? [])}
                  placeholder='vd: --model "claude-opus-4"'
                  onInput={(e) => setEditing({ ...editing, args: parseAgentArgs((e.target as HTMLInputElement).value) })}
                />
              </Field>

              <Field label="Project root (Absolute Path)">
                <Input
                  value={editing.projectRoot}
                  placeholder={projectRootDefault || '/Users/you/code/repo'}
                  onInput={(e) => setEditing({ ...editing, projectRoot: (e.target as HTMLInputElement).value })}
                />
              </Field>

              <div class="modal-row-2">
                <Field label="Working Directory">
                  <CustomSelect
                    value={editing.workingDirectoryMode}
                    onChange={(workingDirectoryMode) =>
                      setEditing({
                        ...editing,
                        workingDirectoryMode: workingDirectoryMode as AgentDefinition['workingDirectoryMode'],
                      })
                    }
                    options={[
                      { value: 'project', label: 'Shared project tree' },
                      { value: 'isolated-worktree', label: 'Isolated git worktree' },
                    ]}
                  />
                </Field>
                <div class="field-checkbox-wrap">
                  <label class="field-checkbox">
                    <input
                      type="checkbox"
                      checked={editing.enabled !== false}
                      onChange={(e) => setEditing({ ...editing, enabled: (e.target as HTMLInputElement).checked })}
                    />
                    Kích hoạt (Enabled)
                  </label>
                </div>
              </div>
            </div>

            <div class="modal-actions">
              <button type="button" class="btn secondary" onClick={() => setEditing(null)}>Hủy</button>
              <button type="button" class="btn teal" disabled={busy === 'save'} onClick={() => void saveAgent()}>
                {busy === 'save' ? 'Đang lưu…' : 'Lưu Agent'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== Launch preview + Approve (opens PTY) ===== */}
      {preview && (
        <div class="modal-backdrop" role="presentation" onClick={() => setPreview(null)}>
          <div class="modal" role="dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Xác nhận launch — {preview.agentId}</h3>
            <p class="muted small">Command (executable + args rời, không shell):</p>
            <pre class="preview-cmd">{preview.spec.preview}</pre>
            <p class="muted small">cwd: <code>{preview.spec.cwd}</code></p>
            {preview.spec.warnings.length > 0 && (
              <ul class="warnings">
                {preview.spec.warnings.map((w, i) => <li key={i}>⚠ {w}</li>)}
              </ul>
            )}
            {!inTauri && (
              <p class="banner error" style={{ marginTop: '0.75rem' }}>
                Browser không mở được PTY. Chạy <code>bun run app:macos</code> rồi Launch lại.
              </p>
            )}
            <div class="modal-actions">
              <button type="button" class="btn secondary" onClick={() => setPreview(null)}>Hủy</button>
              <button
                type="button"
                class="btn"
                disabled={busy === 'launch' || !inTauri}
                onClick={() => void approveLaunch()}
              >
                Approve & Launch
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
