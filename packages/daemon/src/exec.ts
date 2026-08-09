/** Process helpers for agent adapters (PATH-augmented for macOS GUI apps). */

import { spawn } from 'node:child_process';

export interface ExecResult {
  stdout: string;
  stderr: string;
}

const EXTRA_PATH = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', `${process.env.HOME ?? ''}/.bun/bin`].filter(Boolean).join(':');
export const AUGMENTED_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: `${EXTRA_PATH}:${process.env.PATH ?? ''}`,
};

export function exec(
  bin: string,
  args: string[],
  signal?: AbortSignal,
  timeoutMs = 120_000,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: AUGMENTED_ENV,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        try { proc.kill('SIGKILL'); } catch { /* */ }
      }
    }, timeoutMs);
    const onAbort = () => {
      try { proc.kill('SIGTERM'); } catch { /* */ }
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`spawn ${bin} failed: ${err.message}`));
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new Error('aborted'));
      if (code !== 0) {
        return reject(new Error(`${bin} exited ${code}: ${stderr.slice(0, 400)}`));
      }
      resolve({ stdout, stderr });
    });
  });
}
