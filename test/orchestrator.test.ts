import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSettingsStore } from '../src/agents.ts';
import { normalizeConfig, SCHEMA_VERSION, type RunState } from '../src/domain.ts';
import { ArticleLibrary } from '../src/library.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { RunStore } from '../src/store.ts';
import type { TerminalController } from '../src/terminal.ts';

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function waitFor(orchestrator: Orchestrator, id: string, stages: string[]) {
  const end = Date.now() + 5_000;
  while (Date.now() < end) {
    const state = await orchestrator.store.readState(id);
    if (stages.includes(state.stage)) return state;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timeout waiting for ${stages.join(', ')}`);
}

async function fixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), `${name}-`));
  dirs.push(root);
  const guide = join(root, 'guide.txt');
  const criteria = join(root, 'criteria.txt');
  await Promise.all([
    writeFile(guide, 'Write with a human voice.'),
    writeFile(criteria, 'Review truth, logic, emotion and information without forcing a formula.'),
  ]);
  const store = new RunStore(join(root, 'runs'));
  const settings = new AgentSettingsStore(join(root, 'agents.json'));
  const library = new ArticleLibrary(join(root, 'library.sqlite'));
  const orchestrator = new Orchestrator(store, true, settings, undefined, library);
  await orchestrator.init();
  return { root, guide, criteria, store, settings, library, orchestrator };
}

const humanBrief = {
  selectedAngleId: 'outline-a',
  selectedHookId: 'hook-a',
  answers: {
    audience: 'Họ nói muốn fact nhưng thật ra sợ bị bỏ lại.',
    scene: 'Một buổi tối cụ thể.',
  },
};

describe('two-agent Hard Gate workflow', () => {
  test('resumes Claude backbone work and returns to the healthy human gate', async () => {
    const { store, settings, library, guide, criteria } = await fixture('writer-room-recovery');
    const now = new Date().toISOString();
    const state: RunState = {
      schemaVersion: SCHEMA_VERSION,
      id: 'r-recover-123456',
      tmuxSession: 'wr-recover',
      createdAt: now,
      updatedAt: now,
      stage: 'claude_backbone',
      config: normalizeConfig({ title: 'Recover me', guidePath: guide, criteriaPath: criteria }),
      round: 0,
      reviews: [],
      scores: [],
      autoRepairCount: 0,
    };
    await store.create(state);
    const restarted = new Orchestrator(store, true, settings, undefined, library);
    await restarted.init();
    const recovered = await waitFor(restarted, state.id, ['awaiting_backbone_approval']);
    expect(recovered.interrupted).toBe(false);
    expect(await store.readArtifact(state.id, 'backbone.json')).toBeTruthy();
    library.close();
  });

  test('auto-repairs Level 1, waits at Level 2, then obeys the user continue/lock choice', async () => {
    const { orchestrator, library, guide, criteria } = await fixture('writer-room-gate-loop');
    const created = await orchestrator.create({
      title: 'Test title',
      guidePath: guide,
      criteriaPath: criteria,
      maxAutoRepairRounds: 3,
      timeoutMinutes: 1,
    });
    const backboneReady = await waitFor(orchestrator, created.id, ['awaiting_backbone_approval']);
    expect(backboneReady.round).toBe(0);

    await orchestrator.submitHuman(created.id, humanBrief);
    const firstPassing = await waitFor(orchestrator, created.id, ['awaiting_user']);
    expect(firstPassing.round).toBe(2);
    expect(firstPassing.lastPassingRound).toBe(2);
    expect(firstPassing.reviews.map((item) => item.level)).toEqual([1, 2]);
    expect(firstPassing.stage).not.toBe('complete');

    const detailsAtPass = await orchestrator.store.details(created.id);
    expect(detailsAtPass.rounds[1]?.decision?.suggestionDecisions[0]?.decision).toBe('accepted');
    expect(detailsAtPass.rounds[1]?.review && 'hardGates' in detailsAtPass.rounds[1].review).toBe(true);

    await orchestrator.continueRound(created.id, 'Ưu tiên cảm xúc, giữ nguyên hook.');
    const enhanced = await waitFor(orchestrator, created.id, ['awaiting_user']);
    expect(enhanced.round).toBe(3);
    expect(enhanced.lastPassingRound).toBe(3);
    const detailsAfterEnhancement = await orchestrator.store.details(created.id);
    expect(detailsAfterEnhancement.rounds[2]?.decision?.suggestionDecisions[0]?.decision).toBe('adapted');
    expect(detailsAfterEnhancement.rounds[1]?.humanNote?.note).toContain('Ưu tiên cảm xúc');

    const complete = await orchestrator.acceptCurrent(created.id, 'User chose to lock the passing version');
    expect(complete.stage).toBe('complete');
    expect(complete.acceptedRound).toBe(3);
    expect(complete.acceptedBy).toBe('human');
    expect(orchestrator.articles()).toHaveLength(1);
    expect(orchestrator.articles()[0]?.finalGateStatus).toBe('pass');
    library.close();
  });

  test('snapshots exactly two configurable agent profiles', async () => {
    const { orchestrator, settings, library, guide, criteria } = await fixture('writer-room-agent-config');
    settings.save(settings.list().map((profile) => profile.slot === 'agent-1'
      ? { ...profile, model: 'opus', args: ['--verbose'] }
      : { ...profile, model: 'gpt-5.6-sol' }));
    const created = await orchestrator.create({ title: 'Config title', guidePath: guide, criteriaPath: criteria });
    expect(created.config.agentProfiles).toHaveLength(2);
    expect(created.config.agentProfiles[0]).toMatchObject({ role: 'writer', adapter: 'claude', model: 'opus' });
    expect(created.config.agentProfiles[1]).toMatchObject({ role: 'editor', adapter: 'codex', model: 'gpt-5.6-sol' });
    await waitFor(orchestrator, created.id, ['awaiting_backbone_approval']);
    library.close();
  });

  test('stops the terminal before marking a run cancelled and can rerun the snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'writer-room-cancel-'));
    dirs.push(root);
    const guide = join(root, 'guide.txt');
    const criteria = join(root, 'criteria.txt');
    await Promise.all([writeFile(guide, 'Guide'), writeFile(criteria, 'Criteria')]);
    const store = new RunStore(join(root, 'runs'));
    const settings = new AgentSettingsStore(join(root, 'agents.json'));
    let terminalsStopped = false;
    const terminal: TerminalController = {
      async health() { return { ok: true, tools: {}, mock: true, transport: 'mock' }; },
      async ensureSession() {},
      async runJob() {},
      async killSession() {
        await new Promise((resolve) => setTimeout(resolve, 10));
        terminalsStopped = true;
      },
    };
    const orchestrator = new Orchestrator(store, true, settings, terminal, new ArticleLibrary(join(root, 'library.sqlite')));
    await orchestrator.init();
    const created = await orchestrator.create({ title: 'Cancel me', guidePath: guide, criteriaPath: criteria });
    await waitFor(orchestrator, created.id, ['awaiting_backbone_approval']);
    const cancelled = await orchestrator.cancel(created.id);
    expect(terminalsStopped).toBe(true);
    expect(cancelled.stage).toBe('cancelled');
    const rerun = await orchestrator.rerun(created.id);
    const ready = await waitFor(orchestrator, rerun.id, ['awaiting_backbone_approval']);
    expect(ready.config.title).toBe('Cancel me');
    const log = await readFile(store.path(created.id, 'logs', 'process.log'), 'utf8');
    expect(log).toContain('run.rerun.requested');
    orchestrator.library.close();
  });
});
