import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JobDescriptor, JobResultEnvelope } from '../src/domain.ts';
import { SCHEMA_VERSION } from '../src/domain.ts';
import { TmuxController } from '../src/tmux.ts';

test('tmux keeps two named agent panes and settles a pane-runner result', async () => {
  const tmux = new TmuxController(false);
  const health = await tmux.health();
  if (!health.tools.tmux) return;
  const root = await mkdtemp(join(tmpdir(), 'writer-room-tmux-'));
  const session = `wr-test-${crypto.randomUUID().slice(0, 8)}`;
  try {
    const promptPath = join(root, 'prompt.md');
    const resultPath = join(root, 'result.json');
    const logPath = join(root, 'job.log');
    const descriptorPath = join(root, 'job.json');
    const descriptor: JobDescriptor = {
      schemaVersion: SCHEMA_VERSION,
      id: 'tmux-smoke',
      runId: 'r-tmux-smoke',
      kind: 'tmux-smoke',
      role: 'writer',
      adapter: 'mock',
      cwd: root,
      promptPath,
      resultPath,
      logPath,
      heartbeatPath: join(root, 'job.heartbeat.json'),
      jobKey: 'writer-init-123456',
      inputHash: '0'.repeat(64),
      timeoutMs: 5_000,
      stallTimeoutMs: 2_000,
    };
    await Promise.all([
      writeFile(promptPath, 'visible tmux pane runner smoke'),
      writeFile(descriptorPath, JSON.stringify(descriptor)),
    ]);
    await tmux.ensureSession(session, root);
    await tmux.runJob(session, 'writer', root, descriptorPath);
    const end = Date.now() + 5_000;
    let result: JobResultEnvelope | null = null;
    while (Date.now() < end) {
      try { result = JSON.parse(await readFile(resultPath, 'utf8')) as JobResultEnvelope; break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
    }
    expect(result?.exitCode).toBe(0);
    expect(JSON.parse(result?.stdout || '{}')).toEqual({ ok: true, promptBytes: 30 });
  } finally {
    await tmux.killSession(session).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
