import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeConfig, SCHEMA_VERSION,
  type DurableJobRecord, type JobDescriptor, type JobResultEnvelope, type RunState,
} from '../src/domain.ts';
import { RunStore } from '../src/store.ts';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

function events(value: string): Array<Record<string, unknown>> {
  return value.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('per-run process log', () => {
  test('records run identity, configured models and meaningful stage changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'writer-room-process-'));
    dirs.push(root);
    const guide = join(root, 'guide.txt');
    const criteria = join(root, 'criteria.txt');
    await Promise.all([writeFile(guide, 'Guide'), writeFile(criteria, 'Criteria')]);
    const config = normalizeConfig({ title: 'Trace this script', guidePath: guide, criteriaPath: criteria });
    config.agentProfiles[0] = { ...config.agentProfiles[0]!, model: 'sonnet' };
    const now = new Date().toISOString();
    const state: RunState = {
      schemaVersion: SCHEMA_VERSION, id: 'r-process-123456', tmuxSession: 'wr-process',
      createdAt: now, updatedAt: now, stage: 'writer_init', config, round: 0, scores: [],
    };
    const store = new RunStore(join(root, 'runs'));
    await store.create(state);
    await store.writeState({ ...await store.readState(state.id), stage: 'awaiting_human' });
    await store.writeState({ ...await store.readState(state.id), stage: 'awaiting_human', error: 'same-stage update' });
    const rows = events(await readFile(store.path(state.id, 'logs', 'process.log'), 'utf8'));
    expect(rows[0]).toMatchObject({ event: 'run.created', runId: state.id, title: 'Trace this script' });
    expect((rows[0]?.agents as Array<Record<string, unknown>>)[0]).toMatchObject({ adapter: 'claude', model: 'sonnet' });
    expect(rows.filter((row) => row.event === 'stage.changed')).toEqual([
      expect.objectContaining({ from: 'writer_init', to: 'awaiting_human' }),
    ]);
  });

  test('backfills failed and successful attempts for a legacy run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'writer-room-process-'));
    dirs.push(root);
    const guide = join(root, 'guide.txt');
    const criteria = join(root, 'criteria.txt');
    await Promise.all([writeFile(guide, 'Guide'), writeFile(criteria, 'Criteria')]);
    const config = normalizeConfig({ title: 'Legacy script', guidePath: guide, criteriaPath: criteria });
    config.agentProfiles[0] = { ...config.agentProfiles[0]!, model: 'sonnet' };
    const now = new Date().toISOString();
    const state: RunState = {
      schemaVersion: SCHEMA_VERSION, id: 'r-legacy-123456', tmuxSession: 'wr-legacy',
      createdAt: now, updatedAt: now, stage: 'awaiting_human', config, round: 0, scores: [],
    };
    const store = new RunStore(join(root, 'runs'));
    await store.create(state);
    const jobKey = 'writer-writer-init-1234567890abcdef';
    const attempts = [];
    for (const attempt of [1, 2]) {
      const id = `legacy-writer-init-a${attempt}`;
      const resultPath = store.path(state.id, 'jobs', `${id}.result.json`);
      const descriptor: JobDescriptor = {
        schemaVersion: SCHEMA_VERSION, id, runId: state.id, kind: 'writer-init', role: 'writer',
        adapter: 'claude', profile: config.agentProfiles[0], cwd: store.runDir(state.id), promptPath: '',
        resultPath, logPath: store.path(state.id, 'logs', `${id}.log`),
        heartbeatPath: store.path(state.id, 'jobs', `${id}.heartbeat.json`),
        jobKey, inputHash: '0'.repeat(64), timeoutMs: 60_000, stallTimeoutMs: 30_000,
      };
      const paths = await store.writeJob(state.id, descriptor, 'Prompt');
      const result: JobResultEnvelope = {
        schemaVersion: SCHEMA_VERSION, id, adapter: 'claude', startedAt: now,
        finishedAt: new Date(Date.parse(now) + attempt * 1000).toISOString(),
        exitCode: 0, timedOut: false, stdout: attempt === 1 ? 'not json' : '{"ok":true}', stderr: '',
      };
      await writeFile(resultPath, JSON.stringify(result));
      attempts.push({
        id, attempt, descriptorPath: paths.descriptorPath, resultPath,
        logPath: descriptor.logPath, heartbeatPath: descriptor.heartbeatPath, startedAt: now,
        ...(attempt === 1 ? { finishedAt: result.finishedAt, retryClass: 'repairable' as const, error: 'invalid JSON' } : {}),
      });
    }
    const record: DurableJobRecord = {
      schemaVersion: SCHEMA_VERSION, jobKey, inputHash: '0'.repeat(64), kind: 'writer-init',
      role: 'writer', status: 'settled', attempts, settledResultHash: '1'.repeat(64), updatedAt: now,
    };
    await store.writeJobRecord(state.id, record);
    await rm(store.path(state.id, 'logs', 'process.log'));
    await store.ensureProcessLog(await store.readState(state.id));
    const rows = events(await readFile(store.path(state.id, 'logs', 'process.log'), 'utf8'));
    expect(rows.find((row) => row.event === 'agent.attempt.failed')).toMatchObject({
      attempt: 1, adapter: 'claude', model: 'sonnet', retryClass: 'repairable', error: 'invalid JSON',
    });
    expect(rows.find((row) => row.event === 'agent.attempt.succeeded')).toMatchObject({
      attempt: 2, adapter: 'claude', model: 'sonnet', exitCode: 0,
    });
  });
});
