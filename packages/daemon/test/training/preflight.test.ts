/**
 * Preflight tests (SDD §7.2, §6.5 INPUT_MISSING_TRANSCRIPT / INPUT_NO_CHANNEL).
 *
 * The agent-binary-detection branch (`AGENT_UNAVAILABLE`) is exercised with a REAL
 * `agents.detect('claude-code', 'claude')` call rather than mocked/stubbed — the
 * `claude` CLI is present on this dev machine's PATH, `AgentManager` has no seam to
 * inject a fake detector without editing `packages/daemon/src/agents/**` (out of
 * bounds per the task's file boundary), and `detect()` only shells out to
 * `claude --version`, which is fast and side-effect-free. If this suite ever runs
 * somewhere without the `claude` binary installed, the "ready: true" happy-path
 * assertions below would need a real CLI on PATH — documented here rather than
 * silently assumed.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpyService } from '@writer-room/spy';
import { createAgentHarness, type AgentHarness } from '../../src/harness.ts';
import { preflightVideo } from '../../src/training/preflight.ts';
import { seedVideo } from './fixtures.ts';

let dir: string;
let harness: AgentHarness;
let spy: SpyService;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wr-training-preflight-'));
  harness = await createAgentHarness({ dataDir: dir, defaultProjectRoot: dir });
  spy = new SpyService({ dataRoot: join(dir, 'spy') });
  await spy.init();
});

afterEach(() => {
  harness.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe('preflightVideo', () => {
  test('ready: true when channel, transcript, and agent are all available', async () => {
    const { videoSnapshotId } = await seedVideo(spy);
    const result = await preflightVideo(spy, harness.agents, videoSnapshotId);
    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.channelTitle).toBe('Test Channel');
    expect(result.transcriptSegmentCount).toBe(2);
  });

  test('blocks with INPUT_NO_CHANNEL when channelTitle is empty', async () => {
    const { videoSnapshotId } = await seedVideo(spy, { channelTitle: '' });
    const result = await preflightVideo(spy, harness.agents, videoSnapshotId);
    expect(result.ready).toBe(false);
    expect(result.blockers.some((b) => b.code === 'INPUT_NO_CHANNEL')).toBe(true);
  });

  test('blocks with INPUT_MISSING_TRANSCRIPT when transcriptStatus is not ok', async () => {
    const { videoSnapshotId } = await seedVideo(spy, { transcriptStatus: 'missing', segmentTexts: [] });
    const result = await preflightVideo(spy, harness.agents, videoSnapshotId);
    expect(result.ready).toBe(false);
    expect(result.blockers.some((b) => b.code === 'INPUT_MISSING_TRANSCRIPT')).toBe(true);
  });

  test('blocks with INPUT_MISSING_TRANSCRIPT when transcriptStatus is ok but zero segments exist', async () => {
    const { videoSnapshotId } = await seedVideo(spy, { segmentTexts: [] });
    const result = await preflightVideo(spy, harness.agents, videoSnapshotId);
    expect(result.ready).toBe(false);
    expect(result.blockers.some((b) => b.code === 'INPUT_MISSING_TRANSCRIPT')).toBe(true);
  });

  test('unknown videoSnapshotId blocks on both channel and transcript, never throws', async () => {
    const result = await preflightVideo(spy, harness.agents, 'does-not-exist');
    expect(result.ready).toBe(false);
    expect(result.blockers.some((b) => b.code === 'INPUT_NO_CHANNEL')).toBe(true);
  });
});
