#!/usr/bin/env bun
/**
 * Spy CLI — channel/video harvest + Source Pack.
 *
 *   bun run spy channel <url> [--depth transcript|metadata] [--top N] [--scan N]
 *   bun run spy video <url> [--depth transcript|metadata]
 *   bun run spy source-pack <spy-run-id> [--limit N] [--out path]
 */

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { SpyService } from './index.ts';
import type { HarvestDepth } from './schema.ts';

function usage(): never {
  console.error(`Usage:
  bun run spy channel <youtube-channel-url> [options]
      --depth transcript|metadata   default: transcript
      --top N                       videos to capture evidence for (default 5)
      --scan N                      videos to list (default 60)
      --pack                        after success, print Source Pack markdown
      --out <path>                  write Source Pack to file (implies --pack)

  bun run spy video <youtube-video-url> [options]
      --depth transcript|metadata   default: transcript
      --pack                        after success, print Source Pack markdown
      --out <path>                  write Source Pack to file (implies --pack)

  bun run spy source-pack <spy-run-id> [--limit N] [--out path]

Env:
  WRITER_ROOM_DATA_DIR     data root (default ./writer-room-data)
  WRITER_ROOM_SPY_ENABLED  set 0 to disable
`);
  process.exit(1);
}

function dataRoot(): string {
  return resolve(process.env.WRITER_ROOM_DATA_DIR || join(import.meta.dir, '../../../writer-room-data'));
}

function parseDepth(value: string | undefined): HarvestDepth {
  if (value === 'metadata' || value === 'transcript') return value;
  return 'transcript';
}

async function waitUntilDone(spy: SpyService, operationId: string) {
  let operation = await spy.wait(operationId, 30_000);
  while (operation.status === 'queued' || operation.status === 'running') {
    console.error(JSON.stringify({
      status: operation.status,
      step: operation.step,
      progress: operation.progress,
      total: operation.total,
    }));
    operation = await spy.wait(operationId, 30_000);
  }
  return operation;
}

async function main(): Promise<void> {
  if (process.env.WRITER_ROOM_SPY_ENABLED === '0') {
    console.error('Spy tắt (WRITER_ROOM_SPY_ENABLED=0).');
    process.exit(2);
  }

  const [, , command, arg1, ...rest] = process.argv;
  if (!command) usage();

  const spy = new SpyService({ dataRoot: join(dataRoot(), 'spy') });
  await spy.init();
  spy.operations.reconcile();

  if (command === 'source-pack') {
    if (!arg1) usage();
    let limit = 5;
    let outPath: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--limit' && rest[i + 1]) limit = Number(rest[++i]);
      else if (rest[i] === '--out' && rest[i + 1]) outPath = rest[++i];
    }
    const pack = spy.exportSourcePack({ spyRunId: arg1, limit });
    if (outPath) {
      await mkdir(dirname(resolve(outPath)), { recursive: true });
      await writeFile(resolve(outPath), pack.markdown, 'utf8');
      console.log(JSON.stringify({
        out: resolve(outPath),
        spyRunId: pack.spyRunId,
        videoIds: pack.videoIds,
        wordCount: pack.wordCount,
        warnings: pack.warnings,
      }, null, 2));
    } else {
      console.log(pack.markdown);
      if (pack.warnings.length) {
        console.error(JSON.stringify({ warnings: pack.warnings }, null, 2));
      }
    }
    return;
  }

  if (!arg1 || (command !== 'channel' && command !== 'video')) usage();
  const url = arg1;

  let topN = 5;
  let scanLimit = 60;
  let depth: HarvestDepth = 'transcript';
  let wantPack = false;
  let outPath: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--top' && rest[i + 1]) topN = Number(rest[++i]);
    else if (rest[i] === '--scan' && rest[i + 1]) scanLimit = Number(rest[++i]);
    else if (rest[i] === '--depth' && rest[i + 1]) depth = parseDepth(rest[++i]);
    else if (rest[i] === '--pack') wantPack = true;
    else if (rest[i] === '--out' && rest[i + 1]) {
      outPath = rest[++i];
      wantPack = true;
    }
  }

  const started = command === 'video'
    ? spy.videoSpy({
      url,
      depth,
      idempotencyKey: `cli-video-${randomUUID()}`,
    })
    : spy.channelSpy({
      url,
      topN,
      scanLimit,
      depth,
      rankBy: 'velocity',
      minDurationSec: 0,
      idempotencyKey: `cli-channel-${randomUUID()}`,
    });
  console.error(JSON.stringify({ started, depth, mode: command }, null, 2));

  const operation = await waitUntilDone(spy, started.operationId);
  if (operation.status !== 'completed') {
    console.error(JSON.stringify({
      status: operation.status,
      errorCode: operation.errorCode,
      errorMessage: operation.errorMessage,
    }, null, 2));
    process.exit(1);
  }

  const result = spy.getResult(started.spyRunId);
  const summary = {
    spyRunId: started.spyRunId,
    status: operation.status,
    kind: command,
    depth,
    videoCount: result.videos.length,
    withTranscript: result.videos.filter((v) => v.transcriptStatus === 'ok').length,
    videos: result.videos.map((v) => ({
      id: v.sourceVideoId,
      title: v.title,
      views: v.viewCount,
      transcript: v.transcriptStatus,
    })),
  };
  console.log(JSON.stringify(summary, null, 2));

  if (wantPack) {
    const pack = spy.exportSourcePack({
      spyRunId: started.spyRunId,
      limit: command === 'video' ? 1 : topN,
    });
    if (outPath) {
      const resolved = resolve(outPath);
      await mkdir(dirname(resolved), { recursive: true });
      await writeFile(resolved, pack.markdown, 'utf8');
      console.error(JSON.stringify({
        sourcePack: resolved,
        videoIds: pack.videoIds,
        wordCount: pack.wordCount,
        warnings: pack.warnings,
      }, null, 2));
    } else {
      console.log('\n----- SOURCE PACK -----\n');
      console.log(pack.markdown);
    }
  }
}

await main();
