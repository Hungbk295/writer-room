/** Terminal drawer — tabs + panes (dna-spy layout). */
import { useEffect, useRef, useState } from 'preact/hooks';
import { getTerminalState, subscribeTerminals, terminals } from './terminalStore.ts';
import { isTauri, onTermExit } from './terminalApi.ts';
import { TerminalPane } from './TerminalPane.tsx';

export function TerminalDrawer() {
  const [, tick] = useState(0);
  const t = getTerminalState();
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  useEffect(() => subscribeTerminals(() => tick((n) => n + 1)), []);

  useEffect(() => {
    if (!isTauri()) return;
    let un: (() => void) | undefined;
    void onTermExit((e) => terminals.markExit(e.sessionId, e.exitCode)).then((u) => { un = u; });
    return () => un?.();
  }, []);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      terminals.setHeight(d.startH + (d.startY - e.clientY));
    };
    const up = () => { dragRef.current = null; };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, []);

  // Keep mounted structure when closed? dna-spy unmounts. Content uses --term-height=0.
  if (!t.open) return null;

  return (
    <div class="term-drawer" style={{ height: t.height }}>
      <div
        class="term-drag-handle"
        title="Kéo để đổi chiều cao terminal"
        onMouseDown={(e) => {
          dragRef.current = { startY: e.clientY, startH: t.height };
          e.preventDefault();
        }}
      />
      <div class="term-tabs">
        {t.tabs.map((tab) => (
          <div
            key={tab.sessionId}
            class={tab.sessionId === t.activeId ? 'term-tab active' : 'term-tab'}
            onClick={() => terminals.setActive(tab.sessionId)}
          >
            <span class="term-tab-title">
              {tab.agentId ? '🤖 ' : ''}{tab.title}
              {` · PID ${tab.pid}${tab.running ? ' · running' : ''}`}
              {tab.readOnly ? ' 👁' : ''}
              {!tab.running && ` (exit ${tab.exitCode ?? '?'})`}
            </span>
            <button
              type="button"
              class="term-tab-close"
              title="Đóng tab"
              onClick={(e) => {
                e.stopPropagation();
                void terminals.closeTab(tab.sessionId);
              }}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          class="term-new"
          title="Shell mới"
          onClick={() => void terminals.newShell()}
        >
          ＋
        </button>
        <div class="term-tabs-spacer" />
        <button
          type="button"
          class="term-hide"
          title="Ẩn terminal (nút Terminal trên nav để hiện lại)"
          onClick={() => terminals.toggle()}
        >
          ▾ Hide
        </button>
      </div>
      <div class="term-body">
        {t.tabs.map((tab) => (
          <div
            key={tab.sessionId}
            class="term-pane-holder"
            style={{ display: tab.sessionId === t.activeId ? 'block' : 'none' }}
          >
            <TerminalPane
              sessionId={tab.sessionId}
              readOnly={tab.readOnly}
              active={tab.sessionId === t.activeId}
            />
          </div>
        ))}
        {t.tabs.length === 0 && (
          <div class="term-empty">
            Chưa có terminal —{' '}
            <button type="button" onClick={() => void terminals.newShell()}>mở shell</button>
            {' · '}
            <button type="button" onClick={() => terminals.toggle()}>ẩn drawer</button>
          </div>
        )}
      </div>
    </div>
  );
}

export function TerminalToggleButton() {
  const [, tick] = useState(0);
  useEffect(() => subscribeTerminals(() => tick((n) => n + 1)), []);
  const t = getTerminalState();
  const count = t.tabs.length;
  return (
    <button
      type="button"
      class={t.open ? 'nav-term active term-toggle-btn' : 'nav-term term-toggle-btn'}
      onClick={() => terminals.toggle()}
      title={t.open ? 'Ẩn terminal drawer' : 'Hiện terminal drawer'}
    >
      🖥 Terminal{count ? ` (${count})` : ''}{t.open ? ' ▾' : ' ▴'}
    </button>
  );
}
