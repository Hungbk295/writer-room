import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import type { AgentAdapter, AgentProfile, JobDescriptor, JobResultEnvelope } from './domain.ts';
import { SCHEMA_VERSION } from './domain.ts';

interface CommandSpec {
  executable: string;
  args: string[];
  promptAsArg?: boolean;
}

function commandFor(adapter: AgentAdapter, profile?: AgentProfile, prompt = ''): CommandSpec {
  const executable = profile?.executable || (adapter === 'claude'
    ? (process.env.WRITER_ROOM_CLAUDE_BIN || 'claude')
    : adapter === 'codex'
      ? (process.env.WRITER_ROOM_CODEX_BIN || 'codex')
      : adapter === 'gemini'
        ? (process.env.WRITER_ROOM_GEMINI_BIN || 'gemini')
        : adapter);
  const model = profile?.model.trim();
  const modelArgs = model ? ['--model', model] : [];
  const extraArgs = profile?.args || [];
  if (adapter === 'claude') {
    return {
      executable,
      args: [
        '-p', '--output-format', 'text',
        '--permission-mode', 'dontAsk',
        '--tools', '',
        '--no-session-persistence',
        '--no-chrome',
        '--safe-mode',
        ...modelArgs,
        ...extraArgs,
      ],
    };
  }
  if (adapter === 'codex') {
    return {
      executable,
      args: ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', ...modelArgs, ...extraArgs, '-'],
    };
  }
  if (adapter === 'gemini') {
    return {
      executable,
      args: ['--approval-mode', 'plan', '--output-format', 'text', ...modelArgs, ...extraArgs, '-p', 'Complete the task supplied on stdin. Return only the requested JSON.'],
    };
  }
  if (adapter === 'agy') {
    return { executable, args: [...modelArgs, ...extraArgs, '--print', prompt], promptAsArg: true };
  }
  if (adapter === 'mock') {
    return {
      executable: process.execPath,
      args: ['-e', 'let s=""; process.stdin.on("data",c=>s+=c); process.stdin.on("end",()=>console.log(JSON.stringify({ok:true,promptBytes:s.length})));'],
    };
  }
  throw new Error(`pane runner cannot execute adapter: ${adapter}`);
}

async function run(job: JobDescriptor): Promise<JobResultEnvelope> {
  const prompt = await readFile(job.promptPath, 'utf8');
  const fullPrompt = job.profile?.systemPrompt?.trim()
    ? `${job.profile.systemPrompt.trim()}\n\n---\n\n${prompt}`
    : prompt;
  const command = commandFor(job.adapter, job.profile, fullPrompt);
  const startedAt = new Date().toISOString();
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let spawnError = '';
  let outputBytes = 0;
  let lastOutputAt = startedAt;
  let childPid: number | undefined;

  const heartbeat = async (status: 'starting' | 'running' | 'complete' | 'failed' | 'timed_out') => {
    if (!job.heartbeatPath) return;
    const value = {
      jobId: job.id,
      status,
      ...(childPid ? { pid: childPid } : {}),
      updatedAt: new Date().toISOString(),
      lastOutputAt,
      outputBytes,
    };
    const tmp = `${job.heartbeatPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
    await rename(tmp, job.heartbeatPath);
  };
  await heartbeat('starting');
  const launchSummary = [
    `# ${job.kind} · ${job.adapter}`,
    `started: ${startedAt}`,
    'status: launching',
    `executable: ${command.executable}`,
    `model: ${job.profile?.model.trim() || 'provider default'}`,
    '',
    'Runner is starting the provider process. Print-mode providers may not emit text until the final response.',
  ].join('\n');
  await writeFile(job.logPath, `${launchSummary}\n`);

  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn(command.executable, command.args, {
      cwd: job.cwd,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    childPid = child.pid;
    const killChild = () => {
      if (child && !child.killed) {
        try { child.kill('SIGKILL'); } catch { /* process already exited */ }
      }
    };
    const cleanSigTerm = () => { killChild(); process.exit(130); };
    const cleanSigHup = () => { killChild(); process.exit(129); };
    const cleanExit = () => { killChild(); };

    process.on('SIGTERM', cleanSigTerm);
    process.on('SIGINT', cleanSigTerm);
    process.on('SIGHUP', cleanSigHup);
    process.on('exit', cleanExit);

    const startedLine = `[writer-room] ${job.kind} started · ${job.adapter} · PID ${childPid ?? 'pending'} · waiting for first model output…\n`;
    process.stdout.write(startedLine);
    appendFileSync(job.logPath, `\n${startedLine}`);
    void heartbeat('running');
    const heartbeatTimer = setInterval(() => { void heartbeat('running'); }, 1_000);
    heartbeatTimer.unref();
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 2_000).unref();
    }, job.timeoutMs);
    timer.unref();
    child.stdout.on('data', (chunk: Buffer) => {
      const value = chunk.toString();
      stdout += value;
      outputBytes += chunk.byteLength;
      lastOutputAt = new Date().toISOString();
      process.stdout.write(value);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const value = chunk.toString();
      stderr += value;
      outputBytes += chunk.byteLength;
      lastOutputAt = new Date().toISOString();
      process.stderr.write(value);
    });
    child.on('error', (error) => {
      process.off('SIGTERM', cleanSigTerm);
      process.off('SIGINT', cleanSigTerm);
      process.off('SIGHUP', cleanSigHup);
      process.off('exit', cleanExit);
      spawnError = error.message;
      clearTimeout(timer);
      clearInterval(heartbeatTimer);
      resolve(-1);
    });
    child.on('close', (code) => {
      process.off('SIGTERM', cleanSigTerm);
      process.off('SIGINT', cleanSigTerm);
      process.off('SIGHUP', cleanSigHup);
      process.off('exit', cleanExit);
      clearTimeout(timer);
      clearInterval(heartbeatTimer);
      resolve(code ?? -1);
    });
    child.stdin.end(command.promptAsArg ? undefined : fullPrompt);
  });

  const envelope: JobResultEnvelope = {
    schemaVersion: SCHEMA_VERSION,
    id: job.id,
    adapter: job.adapter,
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode,
    timedOut,
    stdout,
    stderr,
    ...(spawnError ? { error: spawnError } : {}),
  };
  await heartbeat(timedOut ? 'timed_out' : exitCode === 0 ? 'complete' : 'failed');
  await writeFile(job.logPath, [
    `# ${job.kind} · ${job.adapter}`,
    `started: ${startedAt}`,
    `pid: ${childPid ?? 'unavailable'}`,
    `finished: ${envelope.finishedAt}`,
    `exit: ${exitCode}${timedOut ? ' (timeout)' : ''}`,
    '',
    '## STDOUT',
    stdout,
    '',
    '## STDERR',
    stderr,
    spawnError ? `\n## SPAWN ERROR\n${spawnError}` : '',
  ].join('\n'));
  await writeFile(job.resultPath, `${JSON.stringify(envelope, null, 2)}\n`);
  return envelope;
}

const descriptorPath = process.argv[2];
if (!descriptorPath) {
  console.error('usage: bun src/pane-runner.ts <job.json>');
  process.exit(2);
}

try {
  const job = JSON.parse(await readFile(descriptorPath, 'utf8')) as JobDescriptor;
  const result = await run(job);
  process.exitCode = result.exitCode === 0 ? 0 : 1;
} catch (error) {
  console.error((error as Error).stack || (error as Error).message);
  process.exitCode = 1;
}
