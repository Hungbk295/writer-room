/**
 * `copyOnedevtoolMeta` (external-turn.ts): the 1DevTool `meta.json` of a finished
 * turn is copied next to the run, outside the stage workspace, and a missing
 * source is a silent no-op.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyOnedevtoolMeta, externalMetaCopyPath, onedevtoolRunsDir } from '../../src/writer/external-turn.ts';

let dataDir = '';
let runsDir = '';
let previousEnv: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'wr-ext-meta-data-'));
  runsDir = mkdtempSync(join(tmpdir(), 'wr-ext-meta-runs-'));
  previousEnv = process.env['ONEDEVTOOL_RUNS_DIR'];
  process.env['ONEDEVTOOL_RUNS_DIR'] = runsDir;
});

afterEach(() => {
  if (previousEnv === undefined) delete process.env['ONEDEVTOOL_RUNS_DIR'];
  else process.env['ONEDEVTOOL_RUNS_DIR'] = previousEnv;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(runsDir, { recursive: true, force: true });
});

describe('copyOnedevtoolMeta', () => {
  test('copies meta.json to writer/external-meta/<runId>/<stage>-turn<id>.json', () => {
    expect(onedevtoolRunsDir()).toBe(runsDir);
    mkdirSync(join(runsDir, 'run-1'), { recursive: true });
    const meta = { status: 'done', exitCode: 0, submittedAt: 1, durationSeconds: 12, sessionId: 's' };
    writeFileSync(join(runsDir, 'run-1', 'meta.json'), JSON.stringify(meta), 'utf8');

    const dest = copyOnedevtoolMeta(dataDir, 'writer-run', 'study-v2', 7, 'run-1');

    expect(dest).toBe(externalMetaCopyPath(dataDir, 'writer-run', 'study-v2', 7));
    expect(dest).toContain(join('writer', 'external-meta', 'writer-run', 'study-v2-turn7.json'));
    expect(JSON.parse(require('node:fs').readFileSync(dest!, 'utf8'))).toEqual(meta);
  });

  test('missing source → null, nothing written, no throw', () => {
    const dest = copyOnedevtoolMeta(dataDir, 'writer-run', 'write-v2', 8, 'missing-run');
    expect(dest).toBeNull();
    expect(existsSync(join(dataDir, 'writer', 'external-meta'))).toBe(false);
  });
});
