import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStubAgent } from '../src/stub-agent.ts';

const STUB_AGENT_PATH = join(import.meta.dir, '../src/stub-agent.ts');

let scratchRoot = '';

afterEach(async () => {
  if (scratchRoot) await rm(scratchRoot, { recursive: true, force: true });
  scratchRoot = '';
});

async function setupRunDir(): Promise<string> {
  scratchRoot = await mkdtemp(join(tmpdir(), 'pipeline-core-stub-agent-'));
  const runDir = join(scratchRoot, 'run');
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'prompt.md'), 'Say hello.', 'utf8');
  return runDir;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('runStubAgent (in-process)', () => {
  test('mode=ok writes a valid out/result.json and exits 0', async () => {
    const runDir = await setupRunDir();
    const result = await runStubAgent(runDir, 'ok');
    expect(result.exitCode).toBe(0);

    const raw = await readFile(join(runDir, 'out', 'result.json'), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.ok).toBe(true);
    expect(parsed.echo).toBe('Say hello.');
  });

  test('defaults to mode=ok when no mode is given', async () => {
    const runDir = await setupRunDir();
    const result = await runStubAgent(runDir, 'unknown-mode-falls-back-to-default');
    expect(result.exitCode).toBe(0);
    expect(await exists(join(runDir, 'out', 'result.json'))).toBe(true);
  });

  test('mode=no-output exits 0 without writing out/result.json', async () => {
    const runDir = await setupRunDir();
    const result = await runStubAgent(runDir, 'no-output');
    expect(result.exitCode).toBe(0);
    expect(await exists(join(runDir, 'out', 'result.json'))).toBe(false);
  });

  test('mode=bad-schema writes malformed JSON to out/result.json and exits 0', async () => {
    const runDir = await setupRunDir();
    const result = await runStubAgent(runDir, 'bad-schema');
    expect(result.exitCode).toBe(0);

    const raw = await readFile(join(runDir, 'out', 'result.json'), 'utf8');
    expect(() => JSON.parse(raw)).toThrow();
  });

  test('mode=write-outside writes out/result.json AND a file outside out/, exits 0', async () => {
    const runDir = await setupRunDir();
    const result = await runStubAgent(runDir, 'write-outside');
    expect(result.exitCode).toBe(0);
    expect(await exists(join(runDir, 'out', 'result.json'))).toBe(true);
    // Escapes to the parent of runDir, which is the sandbox violation a later
    // tree-diff detector is meant to catch.
    expect(await exists(join(runDir, '..', 'escaped.txt'))).toBe(true);
  });

  test('mode=exit-nonzero writes a valid artifact but reports a non-zero exit code', async () => {
    const runDir = await setupRunDir();
    const result = await runStubAgent(runDir, 'exit-nonzero');
    expect(result.exitCode).toBe(1);
    expect(await exists(join(runDir, 'out', 'result.json'))).toBe(true);
  });

  test('missing prompt.md is an error regardless of mode', async () => {
    scratchRoot = await mkdtemp(join(tmpdir(), 'pipeline-core-stub-agent-'));
    const runDir = join(scratchRoot, 'run-no-prompt');
    const result = await runStubAgent(runDir, 'ok');
    expect(result.exitCode).toBe(1);
  });

  // mode=hang is intentionally not runtime-tested against a real timeout (that
  // would make the suite slow for no benefit); this only asserts it is wired up
  // and does not resolve within a short window, proving it doesn't accidentally
  // fall through to a mode that settles.
  test('mode=hang does not resolve within a short window', async () => {
    const runDir = await setupRunDir();
    const hungPromise = runStubAgent(runDir, 'hang').then(() => 'resolved' as const);
    const timeoutPromise = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 50));
    const winner = await Promise.race([hungPromise, timeoutPromise]);
    expect(winner).toBe('timeout');
  });
});

describe('stub-agent.ts (real subprocess, for cases that need a real exit code / process boundary)', () => {
  test('mode=exit-nonzero: subprocess exits with code 1 despite writing a valid artifact', async () => {
    const runDir = await setupRunDir();
    const proc = Bun.spawn(['bun', STUB_AGENT_PATH, runDir, 'exit-nonzero'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(1);
    expect(await exists(join(runDir, 'out', 'result.json'))).toBe(true);
  });

  test('mode=ok: subprocess exits 0 and writes out/result.json', async () => {
    const runDir = await setupRunDir();
    const proc = Bun.spawn(['bun', STUB_AGENT_PATH, runDir, 'ok'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(await exists(join(runDir, 'out', 'result.json'))).toBe(true);
  });

  test('missing prompt.md: subprocess exits 1', async () => {
    scratchRoot = await mkdtemp(join(tmpdir(), 'pipeline-core-stub-agent-'));
    const runDir = join(scratchRoot, 'run-no-prompt');
    await mkdir(runDir, { recursive: true });
    const proc = Bun.spawn(['bun', STUB_AGENT_PATH, runDir, 'ok'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(1);
  });
});
