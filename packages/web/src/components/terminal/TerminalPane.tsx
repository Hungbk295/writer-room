/** xterm.js pane — full-size fit inside drawer (dna-spy parity). */
import { useEffect, useRef } from 'preact/hooks';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { TerminalOutputChunk } from './terminalApi.ts';
import { b64ToBytes, termAttach, termResize, termWrite } from './terminalApi.ts';

interface Props {
  sessionId: string;
  readOnly: boolean;
  active: boolean;
}

export function TerminalPane({ sessionId, readOnly, active }: Props) {
  const holderRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    const holder = holderRef.current;
    if (!holder) return;

    const term = new Terminal({
      scrollback: 5000,
      fontSize: 13,
      fontFamily: '"SF Mono", Menlo, Consolas, monospace',
      cursorBlink: !readOnly,
      disableStdin: readOnly,
      allowProposedApi: true,
      theme: { background: '#0d1117', foreground: '#e6edf3', cursor: '#e6edf3' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(holder);
    // Defer first fit until layout has non-zero size (drawer may just open).
    const firstFit = () => {
      try {
        if (!holder || holder.clientWidth < 100 || holder.clientHeight < 50) return;
        fit.fit();
        if (term.cols >= 40 && term.rows >= 10) {
          void termResize(sessionId, term.cols, term.rows).catch(() => {});
        }
      } catch {
        /* holder may still be 0×0 */
      }
    };
    requestAnimationFrame(() => requestAnimationFrame(firstFit));
    termRef.current = term;
    fitRef.current = fit;

    let disposed = false;
    let lastSeq = 0;
    let snapApplied = false;
    const pending: TerminalOutputChunk[] = [];
    const apply = (c: TerminalOutputChunk) => {
      if (c.sequence <= lastSeq) return;
      lastSeq = c.sequence;
      term.write(b64ToBytes(c.data));
    };

    void termAttach(sessionId, (c) => {
      if (disposed) return;
      if (!snapApplied) {
        pending.push(c);
        return;
      }
      apply(c);
    }).then((snap) => {
      if (disposed) return;
      if (snap.data) term.write(b64ToBytes(snap.data));
      lastSeq = snap.sequence;
      snapApplied = true;
      pending.sort((a, b) => a.sequence - b.sequence).forEach(apply);
      pending.length = 0;
      firstFit();
    }).catch(() => {
      if (!disposed) term.write('\r\n[session không còn tồn tại]\r\n');
    });

    const dataSub = term.onData((data) => {
      if (!readOnly) void termWrite(sessionId, data).catch(() => {});
    });

    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (disposed) return;
        firstFit();
      }, 40);
    });
    ro.observe(holder);
    // Also observe parent so drawer height drag refits cols/rows.
    if (holder.parentElement) ro.observe(holder.parentElement);

    return () => {
      disposed = true;
      clearTimeout(resizeTimer);
      ro.disconnect();
      dataSub.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId, readOnly]);

  useEffect(() => {
    if (!active) return;
    const run = () => {
      try {
        const holder = holderRef.current;
        if (!holder || holder.clientWidth < 100 || holder.clientHeight < 50) return;
        fitRef.current?.fit();
        termRef.current?.focus();
        const t = termRef.current;
        if (t && t.cols >= 40 && t.rows >= 10) {
          void termResize(sessionId, t.cols, t.rows).catch(() => {});
        }
      } catch {
        /* ignore */
      }
    };
    requestAnimationFrame(() => requestAnimationFrame(run));
  }, [active, sessionId]);

  // Dedicated class — never reuse legacy `.term-pane { width: max-content }` from page styles.
  return <div ref={holderRef} class="term-drawer-xterm" />;
}
