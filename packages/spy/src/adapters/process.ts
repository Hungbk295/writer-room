import { spawn } from 'node:child_process';
import { AppError } from '../errors.ts';

export interface ProcessResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
}

export async function runProcess(
  binary: string,
  args: readonly string[],
  options: {
    signal?: AbortSignal | undefined;
    timeoutMs?: number;
    cwd?: string | undefined;
    env?: NodeJS.ProcessEnv | undefined;
    maximumStdoutBytes?: number | undefined;
    maximumStderrBytes?: number | undefined;
  } = {},
): Promise<ProcessResult> {
  if (options.signal?.aborted) throw new AppError('cancelled', 'Operation đã bị huỷ');
  const maximumStdout = options.maximumStdoutBytes ?? 32 * 1024 * 1024;
  const maximumStderr = options.maximumStderrBytes ?? 2 * 1024 * 1024;
  return new Promise<ProcessResult>((resolveResult, rejectResult) => {
    const child = spawn(binary, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    let settled = false;
    const finishError = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectResult(error);
    };
    const terminate = (): void => {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 1500).unref();
    };
    const onAbort = (): void => {
      terminate();
      finishError(new AppError('cancelled', 'Operation đã bị huỷ'));
    };
    const timeout = options.timeoutMs
      ? setTimeout(() => {
        terminate();
        finishError(new AppError('provider_error', `${binary} timeout`, { retryable: true }));
      }, options.timeoutMs)
      : null;
    timeout?.unref();
    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maximumStdout) {
        terminate();
        finishError(new AppError('quota_exceeded', `${binary} stdout vượt giới hạn`));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maximumStderr) stderr.push(chunk);
    });
    child.once('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'capability_missing' : 'provider_error';
      finishError(new AppError(code, `Không chạy được ${binary}`, { cause: error }));
    });
    child.once('close', (exitCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveResult({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode: exitCode ?? -1,
      });
    });
  });
}

export async function requireSuccessfulProcess(
  binary: string,
  args: readonly string[],
  options: Parameters<typeof runProcess>[2] = {},
): Promise<ProcessResult> {
  const result = await runProcess(binary, args, options);
  if (result.exitCode !== 0) {
    const redacted = result.stderr
      .replace(/https?:\/\/\S+/g, '[url]')
      .replace(/(?:token|key|password|proxy)=\S+/gi, '$1=[redacted]')
      .slice(0, 800);
    throw new AppError('provider_error', `${binary} thất bại (${result.exitCode}): ${redacted}`, {
      retryable: /429|timeout|temporar|network/i.test(result.stderr),
    });
  }
  return result;
}
