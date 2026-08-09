#!/usr/bin/env bun
/**
 * Stub agent adapter (HANDOFF §4 "M0 — Pipeline Core"): a fake agent binary that
 * follows the same file-based Agent I/O Contract a real Claude/Codex turn would
 * (SDD §5.2) — reads `prompt.md`, writes `out/result.json` — but does nothing
 * else, so pipeline tests can exercise every branch of the commit rule without
 * spending a token or spawning a real CLI.
 *
 * Usage (as a subprocess):
 *   bun packages/pipeline-core/src/stub-agent.ts <runDir> <mode>
 *
 * Modes:
 *   ok            (default) valid out/result.json, exit 0
 *   exit-nonzero  valid out/result.json is written, but exit 1 (SDD §5.2: exit
 *                 non-zero is still a failure even with a valid artifact)
 *   no-output     exit 0, no out/result.json written (AGENT_NO_OUTPUT)
 *   bad-schema    out/result.json written but malformed JSON (AGENT_SCHEMA)
 *   write-outside writes a file outside out/ in addition to out/result.json, so a
 *                 later sandbox-violation detector (tree diff) has something to
 *                 catch; this script's job is only to produce that fs state
 *   hang          never resolves — used by tests that spawn this as a real child
 *                 process and exercise a timeout/kill path themselves
 *
 * `runStubAgent` is also exported so fast unit tests can call it in-process for
 * every mode except the ones that need a real process boundary (exit code,
 * killing a hung process).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export type StubAgentMode = 'ok' | 'exit-nonzero' | 'no-output' | 'bad-schema' | 'write-outside' | 'hang';

export interface StubAgentResult {
  exitCode: number;
}

/**
 * Runs the stub agent's logic in-process. Deliberately does NOT touch
 * `process.exitCode`/`process.exit` here — that would leak into whatever process
 * called this in-process (e.g. the test runner). Only the `import.meta.main`
 * script entry point below translates the returned exit code into a real process
 * exit.
 */
export async function runStubAgent(runDir: string, mode: string): Promise<StubAgentResult> {
  const promptPath = join(runDir, 'prompt.md');
  let prompt: string;
  try {
    prompt = (await readFile(promptPath, 'utf8')).trim();
  } catch {
    return { exitCode: 1 };
  }

  const outDir = join(runDir, 'out');

  async function writeValidResult(): Promise<void> {
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, 'result.json'), JSON.stringify({ ok: true, echo: prompt }), 'utf8');
  }

  switch (mode as StubAgentMode) {
    case 'no-output':
      return { exitCode: 0 };

    case 'bad-schema':
      await mkdir(outDir, { recursive: true });
      await writeFile(join(outDir, 'result.json'), '{ this is not valid json', 'utf8');
      return { exitCode: 0 };

    case 'write-outside':
      await writeValidResult();
      await writeFile(resolve(runDir, '..', 'escaped.txt'), 'sandbox violation\n', 'utf8');
      return { exitCode: 0 };

    case 'exit-nonzero':
      await writeValidResult();
      return { exitCode: 1 };

    case 'hang':
      await new Promise<never>(() => {
        // Never resolves — mirrors an agent process that never settles.
      });
      throw new Error('unreachable');

    case 'ok':
    default:
      await writeValidResult();
      return { exitCode: 0 };
  }
}

if (import.meta.main) {
  const [runDir, mode] = process.argv.slice(2);
  if (!runDir) {
    console.error('Usage: bun stub-agent.ts <runDir> <mode>');
    process.exit(1);
  }
  const result = await runStubAgent(runDir, mode ?? 'ok');
  process.exit(result.exitCode);
}
