import { appendFile, mkdir, readFile, readdir, rename, writeFile, access, copyFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import type { RunDetails, RunState, WriterInitArtifact, HumanBrief, WriterDraftArtifact, EditorArtifact, HumanRoundNote, SeoArtifact, JobDescriptor, DurableJobRecord } from './domain.ts';
import { safeRunId } from './domain.ts';

export const APP_ROOT = resolve(import.meta.dir, '..');
export const APP_DATA_ROOT = resolve(process.env.WRITER_ROOM_DATA_DIR || APP_ROOT);

export type RunStateListener = (state: RunState) => void;
export type ProcessEvent = Record<string, unknown> & { event: string };

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

export class RunStore {
  readonly root: string;

  constructor(
    root = process.env.WRITER_ROOM_RUNS_DIR || join(APP_DATA_ROOT, 'runs'),
    private readonly onState?: RunStateListener,
  ) {
    this.root = resolve(root);
  }

  runDir(id: string): string {
    if (!safeRunId(id)) throw new Error('invalid run id');
    return join(this.root, id);
  }

  path(id: string, ...parts: string[]): string {
    return join(this.runDir(id), ...parts);
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async create(state: RunState): Promise<void> {
    const dir = this.runDir(state.id);
    if (await exists(dir)) throw new Error(`run already exists: ${state.id}`);
    await Promise.all([
      mkdir(join(dir, 'input'), { recursive: true }),
      mkdir(join(dir, 'artifacts'), { recursive: true }),
      mkdir(join(dir, 'jobs'), { recursive: true }),
      mkdir(join(dir, 'logs'), { recursive: true }),
    ]);
    await Promise.all([
      copyFile(state.config.guidePath, join(dir, 'input', 'writer-guide.txt')),
      copyFile(state.config.criteriaPath, join(dir, 'input', 'editor-criteria.txt')),
      writeFile(join(dir, 'input', 'source-pack.txt'), state.config.sourcePack || ''),
      writeFile(join(dir, 'input', 'request.json'), `${JSON.stringify(state.config, null, 2)}\n`, { flag: 'wx' }),
      writeFile(join(dir, 'logs', 'process.log'), `${JSON.stringify({
        at: state.createdAt,
        event: 'run.created',
        runId: state.id,
        title: state.config.title,
        stage: state.stage,
        targetScore: state.config.targetScore,
        maxRounds: state.config.maxRounds,
        agents: state.config.agentProfiles.map((profile) => ({
          slot: profile.slot,
          role: profile.role,
          adapter: profile.adapter,
          executable: profile.executable,
          model: profile.model || 'provider-default',
        })),
      })}\n`, { flag: 'wx' }),
    ]);
    await this.writeState(state);
  }

  async writeState(state: RunState): Promise<void> {
    const path = this.path(state.id, 'state.json');
    let previous: RunState | null = null;
    try { previous = JSON.parse(await readFile(path, 'utf8')) as RunState; } catch { /* first state */ }
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    const next = { ...state, revision: (state.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
    await rename(tmp, path);
    this.onState?.(next);
    if (previous && previous.stage !== next.stage) {
      await this.appendProcessEvent(state.id, {
        event: 'stage.changed',
        from: previous.stage,
        to: next.stage,
        round: next.round,
        score: next.scores.at(-1)?.score ?? null,
        ...(next.error ? { error: next.error } : {}),
      }).catch(() => {});
    }
  }

  async appendProcessEvent(id: string, value: ProcessEvent & { at?: string }): Promise<void> {
    const { at, ...event } = value;
    await appendFile(this.path(id, 'logs', 'process.log'), `${JSON.stringify({
      at: at || new Date().toISOString(),
      runId: id,
      ...event,
    })}\n`);
  }

  private logicalPath(id: string, path: string): string {
    const value = relative(this.runDir(id), path);
    return value.startsWith('..') ? basename(path) : value;
  }

  /** Creates a useful process trace for legacy runs without mutating their evidence. */
  async ensureProcessLog(state: RunState): Promise<void> {
    const path = this.path(state.id, 'logs', 'process.log');
    if (await exists(path)) return;
    const events: Array<Record<string, unknown> & { at: string; event: string }> = [{
      at: state.createdAt,
      event: 'run.created',
      runId: state.id,
      title: state.config.title,
      stage: 'writer_init',
      backfilled: true,
      agents: state.config.agentProfiles.map((profile) => ({
        slot: profile.slot,
        role: profile.role,
        adapter: profile.adapter,
        executable: profile.executable,
        model: profile.model || 'provider-default',
      })),
    }];
    const jobDir = this.path(state.id, 'jobs');
    const names = (await readdir(jobDir).catch(() => [] as string[])).filter((name) => name.endsWith('.state.json'));
    for (const name of names) {
      let record: DurableJobRecord;
      try { record = JSON.parse(await readFile(join(jobDir, name), 'utf8')) as DurableJobRecord; } catch { continue; }
      for (const attempt of record.attempts) {
        let descriptor: JobDescriptor | null = null;
        try { descriptor = JSON.parse(await readFile(attempt.descriptorPath, 'utf8')) as JobDescriptor; } catch { /* legacy gap */ }
        const profile = descriptor?.profile;
        const common = {
          runId: state.id,
          jobId: attempt.id,
          jobKey: record.jobKey,
          attempt: attempt.attempt,
          role: record.role,
          kind: record.kind,
          adapter: descriptor?.adapter ?? profile?.adapter ?? 'unknown',
          executable: profile?.executable ?? 'unknown',
          model: profile?.model || 'provider-default',
          prompt: descriptor ? this.logicalPath(state.id, descriptor.promptPath) : null,
          result: this.logicalPath(state.id, attempt.resultPath),
          log: this.logicalPath(state.id, attempt.logPath),
          backfilled: true,
        };
        events.push({ at: attempt.startedAt, event: 'agent.attempt.started', ...common });
        const result = await this.readResult(attempt.resultPath);
        if (attempt.error || attempt.retryClass) {
          events.push({
            at: attempt.finishedAt || result?.finishedAt || record.updatedAt,
            event: 'agent.attempt.failed',
            ...common,
            retryClass: attempt.retryClass || 'unknown',
            error: attempt.error || result?.error || result?.stderr || 'unknown failure',
            exitCode: result?.exitCode ?? null,
            timedOut: result?.timedOut ?? false,
          });
        } else if (result && result.exitCode === 0 && !result.timedOut) {
          events.push({
            at: result.finishedAt,
            event: 'agent.attempt.succeeded',
            ...common,
            exitCode: result.exitCode,
            outputBytes: Buffer.byteLength(result.stdout),
          });
        }
      }
    }
    events.push({
      at: state.updatedAt,
      event: 'run.snapshot',
      runId: state.id,
      stage: state.stage,
      round: state.round,
      score: state.scores.at(-1)?.score ?? null,
      backfilled: true,
    });
    events.sort((left, right) => left.at.localeCompare(right.at));
    await writeFile(path, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, { flag: 'wx' }).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
  }

  async readState(id: string): Promise<RunState> {
    return JSON.parse(await readFile(this.path(id, 'state.json'), 'utf8')) as RunState;
  }

  async listStates(): Promise<RunState[]> {
    await this.init();
    const ids = await readdir(this.root, { withFileTypes: true });
    const rows: RunState[] = [];
    for (const entry of ids) {
      if (!entry.isDirectory() || !safeRunId(entry.name)) continue;
      try { rows.push(await this.readState(entry.name)); } catch { /* incomplete workspace */ }
    }
    return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async readInput(id: string, name: 'writer-guide.txt' | 'editor-criteria.txt' | 'source-pack.txt'): Promise<string> {
    return readFile(this.path(id, 'input', name), 'utf8');
  }

  async writeArtifact(id: string, name: string, value: unknown): Promise<string> {
    if (!/^[a-z0-9][a-z0-9-]*\.json$/.test(name)) throw new Error('invalid artifact name');
    const relative = join('artifacts', name);
    const path = this.path(id, relative);
    const content = `${JSON.stringify(value, null, 2)}\n`;
    try {
      await writeFile(path, content, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await readFile(path, 'utf8');
      if (existing !== content) throw new Error(`artifact conflict: ${name} already exists with different content`);
    }
    return relative;
  }

  async readArtifact<T>(id: string, name: string): Promise<T | null> {
    try { return JSON.parse(await readFile(this.path(id, 'artifacts', name), 'utf8')) as T; }
    catch { return null; }
  }

  async writeJob(id: string, job: JobDescriptor, prompt: string): Promise<{ descriptorPath: string; resultPath: string }> {
    const promptPath = this.path(id, 'jobs', `${job.id}.prompt.md`);
    const descriptorPath = this.path(id, 'jobs', `${job.id}.job.json`);
    await writeFile(promptPath, prompt, { flag: 'wx' });
    const descriptor = { ...job, promptPath };
    await writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, { flag: 'wx' });
    return { descriptorPath, resultPath: descriptor.resultPath };
  }

  async readJobRecord(id: string, jobKey: string): Promise<DurableJobRecord | null> {
    if (!/^[a-z0-9][a-z0-9-]{5,180}$/.test(jobKey)) throw new Error('invalid job key');
    try {
      return JSON.parse(await readFile(this.path(id, 'jobs', `${jobKey}.state.json`), 'utf8')) as DurableJobRecord;
    } catch { return null; }
  }

  async writeJobRecord(id: string, record: DurableJobRecord): Promise<void> {
    if (!/^[a-z0-9][a-z0-9-]{5,180}$/.test(record.jobKey)) throw new Error('invalid job key');
    const path = this.path(id, 'jobs', `${record.jobKey}.state.json`);
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    const next = { ...record, updatedAt: new Date().toISOString() };
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
    await rename(tmp, path);
  }

  async readResult(path: string): Promise<import('./domain.ts').JobResultEnvelope | null> {
    try { return JSON.parse(await readFile(path, 'utf8')) as import('./domain.ts').JobResultEnvelope; }
    catch { return null; }
  }

  async recentLogs(id: string): Promise<Array<{ name: string; content: string }>> {
    const dir = this.path(id, 'logs');
    const names = (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith('.log')).sort().slice(-12);
    return Promise.all(names.map(async (name) => {
      const content = await readFile(join(dir, name), 'utf8');
      return { name, content: content.slice(-200_000) };
    }));
  }

  async details(id: string): Promise<RunDetails> {
    const state = await this.readState(id);
    const initial = await this.readArtifact<WriterInitArtifact>(id, 'writer-init.json');
    const humanBrief = await this.readArtifact<HumanBrief>(id, 'human-brief.json');
    const rounds = [];
    for (let round = 1; round <= Math.max(state.round, state.config.maxRounds); round++) {
      const draft = await this.readArtifact<WriterDraftArtifact>(id, `draft-r${round}.json`);
      const review = await this.readArtifact<EditorArtifact>(id, `review-r${round}.json`);
      const humanNote = await this.readArtifact<HumanRoundNote>(id, `human-note-r${round}.json`);
      const score = state.scores.find((item) => item.round === round)?.score ?? null;
      if (draft || review || humanNote || score !== null) rounds.push({ round, draft, review, score, humanNote });
    }
    const seo = await this.readArtifact<SeoArtifact>(id, 'seo.json');
    return { state, initial, humanBrief, rounds, seo };
  }
}
