/** Terminal UI state — process authority stays in Rust. Preact-friendly store. */
import { defaultShell, isTauri, termCreate, termKill } from './terminalApi.ts';

export interface TermTab {
  sessionId: string;
  pid: number;
  cwd: string;
  title: string;
  agentId?: string;
  turnId?: number;
  readOnly: boolean;
  running: boolean;
  exitCode?: number | null;
}

export interface LaunchTabParams {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  agentId?: string;
  readOnly?: boolean;
  title?: string;
  turnId?: number;
}

interface TerminalState {
  open: boolean;
  height: number;
  tabs: TermTab[];
  activeId: string | null;
}

type Listener = () => void;

let state: TerminalState = {
  open: false,
  height: 320,
  tabs: [],
  activeId: null,
};

const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l();
}

function set(partial: Partial<TerminalState> | ((s: TerminalState) => Partial<TerminalState>)) {
  const next = typeof partial === 'function' ? partial(state) : partial;
  state = { ...state, ...next };
  emit();
}

export function getTerminalState(): TerminalState {
  return state;
}

export function subscribeTerminals(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const terminals = {
  getState: getTerminalState,
  subscribe: subscribeTerminals,

  toggle() {
    set({ open: !state.open });
  },

  openDrawer() {
    set({ open: true });
  },

  setHeight(h: number) {
    set({ height: Math.min(Math.max(h, 160), (typeof window !== 'undefined' ? window.innerHeight : 800) - 120) });
  },

  setActive(sessionId: string) {
    set({ activeId: sessionId });
  },

  async newShell(cwd = '') {
    const sh = defaultShell();
    await terminals.launchTab({
      executable: sh.executable,
      args: sh.args,
      cwd,
      env: {},
      title: 'shell',
    });
  },

  async launchTab(p: LaunchTabParams): Promise<string> {
    if (!isTauri()) {
      throw new Error('Mở app bằng `bun run app:macos` để launch terminal (browser thuần không có PTY).');
    }
    // Open drawer first so layout has real width before xterm/PTY size is fixed.
    // Initial cols based on viewport — TUI agents (codex/agy/grok) look blank/narrow
    // if they start life in an 80-col PTY and never get a successful resize.
    const openH = Math.max(state.height, 280);
    set({ open: true, height: openH });
    const charW = 8.5;
    const charH = 17;
    const cols = Math.max(100, Math.min(280, Math.floor(((typeof window !== 'undefined' ? window.innerWidth : 1280) - 24) / charW)));
    const rows = Math.max(18, Math.min(60, Math.floor((openH - 40) / charH)));

    // dna-spy: pass adapter env as-is (usually only PATH). Always set a real
    // TERM for the PTY — never inherit dumb/unknown from a headless parent.
    const env: Record<string, string> = { ...(p.env ?? {}) };
    if (!env['TERM'] || env['TERM'] === 'dumb' || env['TERM'] === 'unknown') {
      env['TERM'] = 'xterm-256color';
    }
    if (!env['COLORTERM']) env['COLORTERM'] = 'truecolor';
    // Prefer user CLI homes over Homebrew when PATH is present (Homebrew
    // ships a different `grok` package that requires GROK_API_KEY).
    if (env['PATH'] && !env['PATH'].includes('/.grok/bin')) {
      env['PATH'] = `${env['PATH']}`;
    }

    const res = await termCreate({
      executable: p.executable,
      args: p.args,
      cwd: p.cwd,
      env,
      cols,
      rows,
      agentId: p.agentId,
      readOnly: p.readOnly ?? false,
      turnId: p.turnId,
    });
    const tab: TermTab = {
      sessionId: res.sessionId,
      pid: res.pid,
      cwd: p.cwd,
      title: p.title ?? p.executable.split(/[\\/]/).pop() ?? p.executable,
      agentId: p.agentId,
      turnId: p.turnId,
      readOnly: p.readOnly ?? false,
      running: true,
    };
    set({
      tabs: [...state.tabs, tab],
      activeId: tab.sessionId,
      open: true,
      height: openH,
    });
    return res.sessionId;
  },

  async closeTab(sessionId: string) {
    try {
      await termKill(sessionId);
    } catch {
      /* already exited */
    }
    const tabs = state.tabs.filter((t) => t.sessionId !== sessionId);
    const activeId = state.activeId === sessionId
      ? (tabs[tabs.length - 1]?.sessionId ?? null)
      : state.activeId;
    set({ tabs, activeId });
  },

  markExit(sessionId: string, exitCode?: number | null) {
    set({
      tabs: state.tabs.map((t) => (t.sessionId === sessionId ? { ...t, running: false, exitCode } : t)),
    });
  },
};
