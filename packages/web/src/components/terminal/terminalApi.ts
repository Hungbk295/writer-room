/** Client ↔ Rust PTY (dna-spy ADR-2). Works only inside Tauri webview. */
import { Channel, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { submitPtyLine } from './terminalInput.ts';
import { schedulePtyEnterRecovery } from './terminalAutoRetry.ts';

export interface TerminalCreateRequest {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  agentId?: string;
  readOnly?: boolean;
  turnId?: number;
}

export interface TerminalCreateResult {
  sessionId: string;
  pid: number;
}

export interface TerminalOutputChunk {
  sequence: number;
  data: string;
}

export interface TerminalSnapshot {
  sequence: number;
  data: string;
}

export interface TerminalSessionSummary {
  sessionId: string;
  pid: number;
  executable: string;
  agentId?: string | null;
  readOnly: boolean;
  running: boolean;
}

export interface TerminalExitEvent {
  sessionId: string;
  exitCode?: number | null;
  turnId?: number | null;
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && (
    '__TAURI_INTERNALS__' in window
    || '__TAURI__' in window
    || Boolean((window as { isTauri?: boolean }).isTauri)
  );
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function termCreate(request: TerminalCreateRequest): Promise<TerminalCreateResult> {
  if (!isTauri()) {
    return Promise.reject(new Error('Terminal PTY chỉ chạy trong app Tauri (bun run app:macos), không phải browser thuần.'));
  }
  const onOutput = new Channel<TerminalOutputChunk>();
  return invoke<TerminalCreateResult>('terminal_create', { request, onOutput });
}

export function termAttach(
  sessionId: string,
  onChunk: (chunk: TerminalOutputChunk) => void,
): Promise<TerminalSnapshot> {
  const onOutput = new Channel<TerminalOutputChunk>();
  onOutput.onmessage = onChunk;
  return invoke<TerminalSnapshot>('terminal_attach', { sessionId, onOutput });
}

export const termWrite = (sessionId: string, data: string) =>
  invoke<void>('terminal_write', { sessionId, data });

/** Type a prompt, let the TUI finish repainting, then send a distinct Enter key. */
export const termSubmitLine = (sessionId: string, text: string) =>
  submitPtyLine({
    write: (data) => termWrite(sessionId, data),
    text,
    readSequence: async () => (await termSnapshot(sessionId)).sequence,
  });

/**
 * Send a TUI assignment, then watch whether the agent actually starts working
 * and re-send Enter if it did not. The returned function cancels that watch
 * when the owning turn settles or its PTY is replaced.
 */
export async function termSubmitLineWithAutoRetry(
  sessionId: string,
  text: string,
  opts: {
    isActive?: () => boolean;
    onAutoRetry?: () => void;
    onRetryError?: (error: unknown) => void;
  } = {},
): Promise<() => void> {
  await termSubmitLine(sessionId, text);

  return schedulePtyEnterRecovery({
    readSequence: async () => (await termSnapshot(sessionId)).sequence,
    write: (data) => termWrite(sessionId, data),
    isActive: opts.isActive,
    onRetry: opts.onAutoRetry,
    onError: opts.onRetryError,
  });
}

export const termResize = (sessionId: string, cols: number, rows: number) =>
  invoke<void>('terminal_resize', { sessionId, cols, rows });

export const termKill = (sessionId: string) => invoke<void>('terminal_kill', { sessionId });

export const termList = () => invoke<TerminalSessionSummary[]>('terminal_list');

export const termSnapshot = (sessionId: string) =>
  invoke<TerminalSnapshot>('terminal_snapshot', { sessionId });

export function onTermExit(cb: (e: TerminalExitEvent) => void): Promise<() => void> {
  return listen<TerminalExitEvent>('terminal://exit', (ev) => cb(ev.payload));
}

export function defaultShell(): { executable: string; args: string[] } {
  const plat = navigator.platform.toLowerCase();
  if (plat.includes('win')) return { executable: 'powershell.exe', args: [] };
  if (plat.includes('mac')) return { executable: '/bin/zsh', args: ['-l'] };
  return { executable: '/bin/bash', args: ['-l'] };
}

export async function defaultCwd(): Promise<string> {
  // Agent launch always passes projectRoot; empty → Rust uses home dir.
  return '';
}
