import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orchestrator } from '../src/orchestrator.ts';
import { RunStore } from '../src/store.ts';
import { AgentSettingsStore } from '../src/agents.ts';
import { normalizeConfig, SCHEMA_VERSION, type RunState } from '../src/domain.ts';

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

describe('mock Writer Room flow', () => {
  test('resumes an interrupted active stage instead of forcing it to failed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'writer-room-recovery-'));
    dirs.push(root);
    const guide = join(root, 'guide.txt');
    const criteria = join(root, 'criteria.txt');
    await Promise.all([writeFile(guide, 'Guide'), writeFile(criteria, 'Criteria')]);
    const store = new RunStore(join(root, 'runs'));
    const now = new Date().toISOString();
    const state: RunState = {
      schemaVersion: SCHEMA_VERSION, id: 'r-recover-123456', tmuxSession: 'wr-recover', createdAt: now, updatedAt: now,
      stage: 'writer_init', config: normalizeConfig({ title: 'Recover me', guidePath: guide, criteriaPath: criteria }), round: 0, scores: [],
    };
    await store.init();
    await store.create(state);
    const orchestrator = new Orchestrator(store, true, new AgentSettingsStore(join(root, 'agents.json')));
    await orchestrator.init();
    const recovered = await waitFor(orchestrator, state.id, ['awaiting_human']);
    expect(recovered.stage).toBe('awaiting_human');
    expect(recovered.interrupted).toBe(false);
    orchestrator.library.close();
  });

  test('pauses after init, preserves all rounds, gates score, then runs SEO', async () => {
    const root = await mkdtemp(join(tmpdir(), 'writer-room-test-'));
    dirs.push(root);
    const guide = join(root, 'guide.txt');
    const criteria = join(root, 'criteria.txt');
    await Promise.all([writeFile(guide, 'Write with a human voice.'), writeFile(criteria, 'Score hook and insight.')]);
    const store = new RunStore(join(root, 'runs'));
    const settings = new AgentSettingsStore(join(root, 'agents.json'));
    const orchestrator = new Orchestrator(store, true, settings);
    await orchestrator.init();
    const created = await orchestrator.create({
      title: 'Test title', guidePath: guide, criteriaPath: criteria,
      targetScore: 9, maxRounds: 3, humanGate: 'init_only', timeoutMinutes: 1,
    });
    const paused = await waitFor(orchestrator, created.id, ['awaiting_human']);
    expect(paused.round).toBe(0);
    const detailsAtPause = await orchestrator.store.details(created.id);
    expect(detailsAtPause.initial?.outlineOptions).toHaveLength(3);
    expect(detailsAtPause.rounds).toHaveLength(0);

    await orchestrator.submitHuman(created.id, {
      selectedOutlineId: 'outline-a', selectedHookId: 'hook-a',
      answers: { audience: 'Họ nói muốn fact nhưng thật ra sợ bị bỏ lại.', scene: 'Một buổi tối cụ thể.' },
    });
    const completed = await waitFor(orchestrator, created.id, ['complete']);
    expect(completed.acceptedRound).toBe(2);
    expect(completed.acceptedBy).toBe('target');
    expect(completed.scores.map((item) => item.score)).toEqual([8, 9.25]);
    const details = await orchestrator.store.details(created.id);
    expect(details.rounds).toHaveLength(2);
    expect(details.seo?.verdict).toBe('strong');
    expect(orchestrator.articles()).toHaveLength(1);
    orchestrator.library.close();
    const restarted = new Orchestrator(store, true, settings);
    await restarted.init();
    expect(restarted.articles()).toHaveLength(1);
    expect((await restarted.store.details(created.id)).state.stage).toBe('complete');
    restarted.library.close();
  });

  test('every-round mode pauses and records the human note', async () => {
    const root = await mkdtemp(join(tmpdir(), 'writer-room-test-'));
    dirs.push(root);
    const guide = join(root, 'guide.txt');
    const criteria = join(root, 'criteria.txt');
    await Promise.all([writeFile(guide, 'Guide'), writeFile(criteria, 'Criteria')]);
    const orchestrator = new Orchestrator(new RunStore(join(root, 'runs')), true);
    await orchestrator.init();
    const created = await orchestrator.create({ title: 'Gate test', guidePath: guide, criteriaPath: criteria, humanGate: 'every_round' });
    await waitFor(orchestrator, created.id, ['awaiting_human']);
    await orchestrator.submitHuman(created.id, {
      selectedOutlineId: 'outline-a', selectedHookId: 'hook-a', answers: { voice: 'Nói thẳng, không giáo trình.' },
    });
    await waitFor(orchestrator, created.id, ['awaiting_round_human']);
    await orchestrator.continueRound(created.id, 'Giữ nguyên câu mở đầu của tôi.');
    await waitFor(orchestrator, created.id, ['complete']);
    const details = await orchestrator.store.details(created.id);
    expect(details.rounds[0]?.humanNote?.note).toContain('Giữ nguyên');
    orchestrator.library.close();
  });

  test('snapshots custom Agent 1 provider/model into a new run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'writer-room-agent-config-'));
    dirs.push(root);
    const guide = join(root, 'guide.txt');
    const criteria = join(root, 'criteria.txt');
    await Promise.all([writeFile(guide, 'Guide'), writeFile(criteria, 'Criteria')]);
    const settings = new AgentSettingsStore(join(root, 'agents.json'));
    const profiles = settings.list();
    settings.save(profiles.map((profile) => profile.slot === 'agent-1'
      ? { ...profile, adapter: 'codex', model: 'gpt-5-codex', args: ['--reasoning-effort', 'high'] }
      : profile));
    const orchestrator = new Orchestrator(new RunStore(join(root, 'runs')), true, settings);
    await orchestrator.init();
    const created = await orchestrator.create({ title: 'Config title', guidePath: guide, criteriaPath: criteria });
    expect(created.config.agentProfiles[0]).toMatchObject({ adapter: 'codex', model: 'gpt-5-codex' });
    expect(created.config.agentProfiles[0]?.args).toEqual(['--reasoning-effort', 'high']);
    await waitFor(orchestrator, created.id, ['awaiting_human']);
    orchestrator.library.close();
  });

  test('replaces only the failed role with the current agent and audits recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'writer-room-agent-recovery-'));
    dirs.push(root);
    const guide = join(root, 'guide.txt');
    const criteria = join(root, 'criteria.txt');
    await Promise.all([writeFile(guide, 'Guide'), writeFile(criteria, 'Criteria')]);
    const store = new RunStore(join(root, 'runs'));
    const settings = new AgentSettingsStore(join(root, 'agents.json'));
    const now = new Date().toISOString();
    const config = normalizeConfig({ title: 'Recover SEO', guidePath: guide, criteriaPath: criteria });
    config.agentProfiles[2] = {
      ...config.agentProfiles[2]!,
      adapter: 'gemini',
      executable: 'gemini',
      model: 'flash',
    };
    const failed: RunState = {
      schemaVersion: SCHEMA_VERSION,
      id: 'r-retry-agent-123456',
      tmuxSession: 'wr-retry-agent',
      createdAt: now,
      updatedAt: now,
      stage: 'failed',
      failedStage: 'seo',
      config,
      round: 1,
      acceptedRound: 1,
      acceptedBy: 'target',
      scores: [{
        round: 1,
        score: 9.2,
        passed: true,
        reviewArtifact: 'artifacts/editor-r1.json',
        draftArtifact: 'artifacts/draft-r1.json',
      }],
      revision: 0,
      recoveryStatus: 'action_required',
      error: 'legacy Gemini failed',
    };
    await store.init();
    await store.create(failed);
    await store.writeArtifact(failed.id, 'draft-r1.json', {
      draftMarkdown: '# Final draft',
      changeLog: [],
      appliedHumanInsights: [],
      preservedHumanSignals: [],
    });
    const orchestrator = new Orchestrator(store, true, settings);
    await orchestrator.init();
    // The compatibility Retry action must upgrade stale run snapshots too.
    await orchestrator.retry(failed.id);
    const completed = await waitFor(orchestrator, failed.id, ['complete']);
    expect(completed.config.agentProfiles[2]).toMatchObject({
      adapter: 'agy',
      executable: 'agy',
      model: 'Gemini 3.5 Flash (High)',
    });
    expect(completed.config.agentProfiles[0]?.adapter).toBe(config.agentProfiles[0]?.adapter);
    const processLog = await readFile(store.path(failed.id, 'logs', 'process.log'), 'utf8');
    expect(processLog).toContain('"event":"agent.profile.replaced"');
    expect(processLog).toContain('"adapter":"gemini"');
    expect(processLog).toContain('"adapter":"agy"');
    orchestrator.library.close();
  });

  test('exports draft turn to txt file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'writer-room-export-'));
    dirs.push(root);
    const guide = join(root, 'guide.txt');
    const criteria = join(root, 'criteria.txt');
    await Promise.all([writeFile(guide, 'Guide'), writeFile(criteria, 'Criteria')]);
    const store = new RunStore(join(root, 'runs'));
    const orchestrator = new Orchestrator(store, true);
    await orchestrator.init();

    const created = await orchestrator.create({ title: 'Export Draft Test', guidePath: guide, criteriaPath: criteria });
    await waitFor(orchestrator, created.id, ['awaiting_human']);

    const initResult = await orchestrator.exportDraft(created.id, 'init');
    expect(initResult.filename).toContain('Export-Draft-Test-draft-init.txt');
    expect(await readFile(initResult.path, 'utf8')).toContain('Bản init');

    await orchestrator.submitHuman(created.id, { selectedOutlineId: 'outline-a', selectedHookId: 'hook-a', answers: {} });
    await waitFor(orchestrator, created.id, ['complete']);

    const r1Result = await orchestrator.exportDraft(created.id, 1);
    expect(r1Result.filename).toContain('Export-Draft-Test-draft-r1.txt');
    expect(await readFile(r1Result.path, 'utf8')).toBeTruthy();
    orchestrator.library.close();
  });
});
