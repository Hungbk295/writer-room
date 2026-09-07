import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentHarness, type AgentHarness } from '../../src/harness.ts';
import { createWriterPack } from '../../src/writer-packs.ts';
import { createChannelProfile } from '../../src/writer/channel-profile.ts';
import { RESEARCH_MAP_SCHEMA_VERSION } from '../../src/writer/research-map.ts';
import { RESEARCH_SOURCE_STAGE } from '../../src/writer/research-orchestrator.ts';
import { getWriterRunV2, saveWriterRunV2 } from '../../src/writer/run-store-v2.ts';
import {
  continueWriterRunV2,
  createWriterRoomV2,
  registerWriterV2SettleListener,
  runWriterRoomV2,
  STUDY_STAGE,
} from '../../src/writer/writer-run-v2.ts';

let dir: string;
let harness: AgentHarness;

async function waitUntil<T>(fn: () => T | Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (predicate(value)) return value;
    if (Date.now() - started > 5_000) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function researchResult(videoId: string, index: number, quote: string) {
  return {
    schemaVersion: RESEARCH_MAP_SCHEMA_VERSION,
    sourceAudit: [{ videoId, mainClaim: `Main claim ${index}`, angle: `Angle ${index}`, limitations: [] }],
    claims: [{
      id: `claim-${index}`, text: `Grounded claim ${index}`, status: 'ATTESTED',
      evidenceIds: [`evidence-${index}`], caveats: [],
    }],
    evidence: [{
      id: `evidence-${index}`, claimId: `claim-${index}`, videoId, quote, relation: 'SUPPORTS',
    }],
    conflicts: [], openQuestions: [], overusedAngles: [],
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wr-research-fanout-'));
  harness = await createAgentHarness({ dataDir: dir, defaultProjectRoot: dir });
  registerWriterV2SettleListener(harness.pipeline.scheduler, { dataDir: dir });
  await createChannelProfile({ id: 'finance', displayName: 'Finance', topic: 'Money' }, dir);
  mkdirSync(join(dir, 'general-packs'), { recursive: true });
  writeFileSync(join(dir, 'general-packs', 'general.md'), '# General\n<!-- version: 1 -->\n', 'utf8');
});

afterEach(() => {
  harness.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe('Writer v2 per-transcript research fan-out', () => {
  test('runs five isolated one-shot turns, persists ids, then STUDY sees only the compact Topic Pack', async () => {
    const videos = Array.from({ length: 5 }, (_, index) => ({
      id: `video-${index + 1}`,
      quote: `Exact grounded quote number ${index + 1}.`,
      tail: `RAW-TRANSCRIPT-TAIL-${index + 1}`,
    }));
    const markdown = [
      '# Source Pack',
      ...videos.flatMap((video, index) => [
        '', `## Video ${index + 1}`, '', `- videoId: \`${video.id}\``, '',
        '### Transcript', '', `${video.quote} ${video.tail}`,
      ]),
    ].join('\n');
    const pack = await createWriterPack({
      title: 'Five sources',
      markdown,
      videoIds: videos.map((video) => video.id),
      channelTitle: 'Evidence',
    }, dir);
    const room = await createWriterRoomV2(
      { scheduler: harness.pipeline.scheduler, dataDir: dir },
      {
        channelId: 'finance', brief: 'A five-source story', title: 'Five sources',
        packId: pack.id, generalPack: 'general.md', agentId: 'codex', editorAgentId: 'claude',
      },
    );
    room.selectedHook = { id: 'h1', type: 'direct-question', typeLabel: 'Question', text: 'Why?' };
    await saveWriterRunV2(room, dir);

    const started = await runWriterRoomV2(
      { scheduler: harness.pipeline.scheduler, dataDir: dir },
      room.id,
    );
    expect(started.researchSources).toHaveLength(5);
    expect(started.researchSources!.every((source) => source.status === 'RUNNING')).toBe(true);
    expect(new Set(started.researchSources!.flatMap((source) => source.turnIds)).size).toBe(5);
    expect(harness.pipeline.scheduler.listOpenTurns(room.id)).toHaveLength(5);
    expect(harness.pipeline.ledger.all().some((row) => row.batchId === room.id && row.stage === STUDY_STAGE)).toBe(false);

    for (const [index, source] of started.researchSources!.entries()) {
      const sourceFile = join(
        dir, 'workspaces', 'pipeline', room.id, source.itemId, 'attempts', '1',
        RESEARCH_SOURCE_STAGE, 'input', 'source', 'source.md',
      );
      const staged = await Bun.file(sourceFile).text();
      expect(staged).toContain(videos[index]!.tail);
      for (const other of videos.filter((_, otherIndex) => otherIndex !== index)) {
        expect(staged).not.toContain(other.tail);
      }
      const result = {
        schemaVersion: RESEARCH_MAP_SCHEMA_VERSION,
        sourceAudit: [{
          videoId: source.videoId,
          mainClaim: `Main claim ${index + 1}`,
          angle: `Angle ${index + 1}`,
          limitations: [],
        }],
        claims: [{
          id: `claim-${index + 1}`,
          text: `Grounded claim ${index + 1}`,
          status: 'ATTESTED',
          evidenceIds: [`evidence-${index + 1}`],
          caveats: [],
        }],
        evidence: [{
          id: `evidence-${index + 1}`,
          claimId: `claim-${index + 1}`,
          videoId: source.videoId,
          quote: videos[index]!.quote,
          relation: 'SUPPORTS',
        }],
        conflicts: [],
        openQuestions: [],
        overusedAngles: [],
      };
      await Bun.write(join(
        dir, 'workspaces', 'pipeline', room.id, source.itemId, 'attempts', '1',
        RESEARCH_SOURCE_STAGE, 'out', 'result.json',
      ), JSON.stringify(result));
      harness.workflow.turnComplete(source.turnIds[0]!, { exitCode: 0 });
    }

    const researched = await waitUntil(
      () => getWriterRunV2(room.id, dir),
      (run) => Boolean(run?.topicPack && harness.pipeline.scheduler.listOpenTurns(room.id)
        .some((turn) => turn.stage === STUDY_STAGE)),
    );
    expect(researched!.researchSources!.every((source) =>
      source.status === 'COMMITTED'
      && source.turnIds.length === 1
      && Boolean(source.artifactHash)
      && Boolean(source.artifactPath)
    )).toBe(true);
    const open = harness.pipeline.scheduler.listOpenTurns(room.id);
    expect(open).toHaveLength(1);
    expect(open[0]!.stage).toBe(STUDY_STAGE);

    const topicMarkdown = await Bun.file(join(dir, researched!.topicPack!.path)).text();
    for (const video of videos) {
      expect(topicMarkdown).toContain(video.quote);
      expect(topicMarkdown).not.toContain(video.tail);
    }
    const studyDir = open[0]!.itemRunDir;
    const envelope = JSON.parse(await Bun.file(join(studyDir, 'input', 'envelope.json')).text()) as {
      topicPack: { contentFiles: string[] };
    };
    const studyInput = (await Promise.all(envelope.topicPack.contentFiles.map((path) =>
      Bun.file(join(studyDir, path.replace(/^input\//, 'input/'))).text()
    ))).join('');
    expect(studyInput).toBe(topicMarkdown);
    expect(studyInput).not.toContain('RAW-TRANSCRIPT-TAIL');
  });

  test('Continue keeps committed transcripts and retries only the failed worker with a new persisted turn id', async () => {
    const videos = [
      { id: 'resume-1', quote: 'First exact quote.', tail: 'FIRST-TAIL' },
      { id: 'resume-2', quote: 'Second exact quote.', tail: 'SECOND-TAIL' },
    ];
    const pack = await createWriterPack({
      title: 'Resume sources',
      videoIds: videos.map((video) => video.id),
      markdown: videos.map((video, index) => [
        `## Video ${index + 1}`, `- videoId: \`${video.id}\``, '### Transcript', `${video.quote} ${video.tail}`,
      ].join('\n\n')).join('\n\n'),
    }, dir);
    const room = await createWriterRoomV2(
      { scheduler: harness.pipeline.scheduler, dataDir: dir },
      {
        channelId: 'finance', brief: 'Resume', title: 'Resume', packId: pack.id,
        generalPack: 'general.md', agentId: 'codex', editorAgentId: 'claude',
      },
    );
    room.selectedHook = { id: 'h1', type: 'direct-question', typeLabel: 'Question', text: 'Why?' };
    await saveWriterRunV2(room, dir);
    const started = await runWriterRoomV2({ scheduler: harness.pipeline.scheduler, dataDir: dir }, room.id);
    const [failedSource, goodSource] = started.researchSources!;
    harness.workflow.turnComplete(failedSource!.turnIds[0]!, { exitCode: -1 });
    await Bun.write(join(
      dir, 'workspaces', 'pipeline', room.id, goodSource!.itemId, 'attempts', '1',
      RESEARCH_SOURCE_STAGE, 'out', 'result.json',
    ), JSON.stringify(researchResult(goodSource!.videoId, 2, videos[1]!.quote)));
    harness.workflow.turnComplete(goodSource!.turnIds[0]!, { exitCode: 0 });

    const failed = await waitUntil(
      () => getWriterRunV2(room.id, dir),
      (run) => run?.status === 'FAILED'
        && run.researchSources?.[0]?.status === 'FAILED'
        && run.researchSources?.[1]?.status === 'COMMITTED'
        && harness.pipeline.scheduler.listOpenTurns(room.id).length === 0,
    );
    const originalFailedTurnId = failed!.researchSources![0]!.turnIds[0]!;
    const originalGoodTurnId = failed!.researchSources![1]!.turnIds[0]!;

    const resumed = await continueWriterRunV2(
      { scheduler: harness.pipeline.scheduler, dataDir: dir },
      room.id,
    );
    expect(resumed.status).toBe('RUNNING');
    expect(resumed.researchSources![0]!.attempt).toBe(2);
    expect(resumed.researchSources![0]!.turnIds).toHaveLength(2);
    expect(resumed.researchSources![0]!.turnIds[0]).toBe(originalFailedTurnId);
    expect(resumed.researchSources![0]!.turnIds[1]).not.toBe(originalFailedTurnId);
    expect(resumed.researchSources![1]!.status).toBe('COMMITTED');
    expect(resumed.researchSources![1]!.turnIds).toEqual([originalGoodTurnId]);
    expect(harness.pipeline.scheduler.listOpenTurns(room.id)).toHaveLength(1);
  });
});
